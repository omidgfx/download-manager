import axios from "axios";
import fs from "fs";
import path from "path";
import EventEmitter from "events";
import { query, queryOne, generateId, DownloadRecord, ChunkRecord } from "./db";
import { ensureUniqueFilename } from "./pathSanitizer";

export class DownloadService {
  public static activeDownloads = new Map<
    string,
    {
      abortController: AbortController;
      filePath: string;
      finalPath: string;
      chunks: Array<{
        id: string;
        start: number;
        end: number | undefined;
        downloaded: number;
      }>;
    }
  >();

  public static eventEmitter = new EventEmitter();
  public static progressCache = new Map<
    string,
    {
      chunks: Array<{ id: string; downloaded: number }>;
      totalSize: number | null;
    }
  >();

  private static isCancelError(err: any): boolean {
    return axios.isCancel(err) || (err && err.code === "ERR_CANCELED");
  }

  public static async startDownload(downloadId: string, downloadDir: string): Promise<void> {
    let download = await queryOne("SELECT * FROM downloads WHERE id = $1", [downloadId]) as DownloadRecord | null;
    if (!download) throw new Error("Download task not found");
    if (download.status === "COMPLETED") return;
    if (download.status === "PAUSED") return;

    const totalSize = download.totalSize ? Number(download.totalSize) : null;
    const chunkCount = download.chunkCount || 1;

    const baseDir = path.resolve(downloadDir, download.directory);
    await fs.promises.mkdir(baseDir, { recursive: true });
    const finalPath = path.join(baseDir, download.filename);
    const tempPath = finalPath + ".part";

    let chunks = await query("SELECT * FROM chunks WHERE download_id = $1 ORDER BY index ASC", [downloadId]) as ChunkRecord[];

    const isFresh = chunks.length === 0 && Number(download.downloadedSize) === 0;
    if (download.status === "PENDING" && isFresh) {
      const { finalName } = await ensureUniqueFilename(baseDir, download.filename);
      if (finalName !== download.filename) {
        await query("UPDATE downloads SET filename = $1 WHERE id = $2", [finalName, downloadId]);
        download = await queryOne("SELECT * FROM downloads WHERE id = $1", [downloadId]) as DownloadRecord | null;
        if (!download) throw new Error("Download task lost during verification");
      }
    }

    if (chunks.length === 0) {
      chunks = await this.createChunks(downloadId, chunkCount, totalSize);
    }

    // Set up partial write file
    if (totalSize) {
      try {
        const fd = fs.openSync(tempPath, "w");
        fs.ftruncateSync(fd, totalSize);
        fs.closeSync(fd);
      } catch (err: any) {
        console.warn("Could not preallocate download disk space:", err.message);
      }
    } else {
      try {
        await fs.promises.writeFile(tempPath, "");
      } catch (err: any) {
        console.warn("Temp part creation failed:", err.message);
      }
    }

    const abortController = new AbortController();
    await query("UPDATE downloads SET status = $1 WHERE id = $2", ["DOWNLOADING", downloadId]);

    this.eventEmitter.emit("downloadStarted", downloadId);

    this.progressCache.set(downloadId, {
      chunks: chunks.map((c) => ({ id: c.id, downloaded: Number(c.downloadedBytes) })),
      totalSize,
    });

    this.activeDownloads.set(downloadId, {
      abortController,
      filePath: tempPath,
      finalPath,
      chunks: chunks.map((c) => ({
        id: c.id,
        start: Number(c.startByte),
        end: c.endByte ? Number(c.endByte) : undefined,
        downloaded: Number(c.downloadedBytes),
      })),
    });

    const tasks = chunks.map((_, i) => () => this.downloadChunk(downloadId, i, abortController.signal));
    const concurrency = Math.min(chunkCount, 4);
    let error: any = null;

    try {
      await this.runWithConcurrency(tasks, concurrency);
    } catch (err: any) {
      error = err;
      if (this.isCancelError(err)) {
        await this.flushProgress(downloadId);
        await query("UPDATE downloads SET status = $1 WHERE id = $2", ["PAUSED", downloadId]);
        this.activeDownloads.delete(downloadId);
        this.progressCache.delete(downloadId);
        this.eventEmitter.emit("downloadPaused", downloadId);
        return;
      }
    }

    try {
      await this.flushProgress(downloadId);
    } catch (flushErr) {
      console.error(`Flush progress failed for ${downloadId}:`, flushErr);
    }

    let allDone = false;
    for (let attempt = 0; attempt < 3; attempt++) {
      const rows = await query("SELECT status FROM chunks WHERE download_id = $1", [downloadId]);
      allDone = rows.every((r) => r.status === "DONE");
      if (allDone) break;
      if (attempt < 2) await new Promise((r) => setTimeout(r, 500));
    }

    if (!error && allDone) {
      await this.markComplete(downloadId);
      this.eventEmitter.emit("downloadComplete", downloadId);
    } else {
      const stat = await fs.promises.stat(tempPath).catch(() => null);
      if (stat && totalSize && stat.size === totalSize) {
        console.log(`Download ${downloadId} completed, mismatch override handled.`);
        await this.markComplete(downloadId);
        this.eventEmitter.emit("downloadComplete", downloadId);
      } else {
        await this.markError(downloadId);
        this.eventEmitter.emit("downloadError", downloadId);
      }
    }

    this.activeDownloads.delete(downloadId);
    this.progressCache.delete(downloadId);
  }

  private static async createChunks(downloadId: string, chunkCount: number, totalSize: number | null): Promise<ChunkRecord[]> {
    const list: Array<Omit<ChunkRecord, "id">> = [];
    if (!totalSize) {
      list.push({ downloadId, index: 0, startByte: 0, endByte: null, downloadedBytes: 0, status: "PENDING" });
    } else {
      const chunkSize = Math.ceil(totalSize / chunkCount);
      for (let i = 0; i < chunkCount; i++) {
        const start = i * chunkSize;
        const end = i === chunkCount - 1 ? totalSize - 1 : start + chunkSize - 1;
        list.push({ downloadId, index: i, startByte: start, endByte: end, downloadedBytes: 0, status: "PENDING" });
      }
    }

    for (const ch of list) {
      const id = generateId();
      await query(
        `INSERT INTO chunks (id, download_id, index, start_byte, end_byte, downloaded_bytes, status)
         VALUES ($1, $2, $3, $4, $5, $6, $7)`,
        [id, ch.downloadId, ch.index, ch.startByte, ch.endByte, ch.downloadedBytes, ch.status]
      );
    }
    return (await query("SELECT * FROM chunks WHERE download_id = $1 ORDER BY index ASC", [downloadId])) as ChunkRecord[];
  }

  private static async downloadChunk(downloadId: string, chunkIndex: number, signal: AbortSignal): Promise<void> {
    const chunk = (await queryOne("SELECT * FROM chunks WHERE download_id = $1 AND index = $2", [downloadId, chunkIndex])) as ChunkRecord | null;
    if (!chunk) throw new Error(`Chunk with index ${chunkIndex} not found`);
    if (chunk.status === "DONE") return;

    const startByte = Number(chunk.startByte);
    const endByte = chunk.endByte ? Number(chunk.endByte) : undefined;
    const alreadyDownloaded = Number(chunk.downloadedBytes);
    const startFrom = startByte + alreadyDownloaded;

    if (endByte !== undefined && alreadyDownloaded >= endByte - startByte + 1) {
      await this.markChunkDone(chunk.id, alreadyDownloaded);
      const cache = this.progressCache.get(downloadId);
      if (cache) {
        const total = cache.chunks.reduce((sum, c) => sum + c.downloaded, 0);
        this.eventEmitter.emit("progress", downloadId, {
          chunkId: chunk.id,
          chunkDownloadedBytes: alreadyDownloaded,
          downloadedBytes: total,
          total,
        });
      }
      return;
    }

    const download = (await queryOne("SELECT * FROM downloads WHERE id = $1", [downloadId])) as DownloadRecord | null;
    if (!download) throw new Error("Download metadata not found inside chunk handler");

    const url = download.url;
    const headers: Record<string, string> = {};
    if (endByte !== undefined) {
      headers["Range"] = `bytes=${startFrom}-${endByte}`;
    } else {
      headers["Range"] = `bytes=${startFrom}-`;
    }

    const active = this.activeDownloads.get(downloadId);
    if (!active) throw new Error("Download activity is not currently active");
    const filePath = active.filePath;

    const chunkMem = active.chunks.find((c) => c.id === chunk.id);
    if (!chunkMem) throw new Error("Chunk tracking was not found in active state list");

    let downloadedBytes = alreadyDownloaded;
    let lastDbUpdate = alreadyDownloaded;
    const dbUpdateThreshold = 512 * 1024; // Limit excessive database access cycles (512 KB)

    const response = await axios({
      method: "GET",
      url,
      headers,
      responseType: "stream",
      timeout: 30000,
      signal,
      onDownloadProgress: (progressEvent) => {
        const current = alreadyDownloaded + progressEvent.loaded;
        downloadedBytes = current;
        chunkMem.downloaded = current;

        const cache = this.progressCache.get(downloadId);
        if (cache) {
          const chunkCache = cache.chunks.find((c) => c.id === chunk.id);
          if (chunkCache) chunkCache.downloaded = current;
          const total = cache.chunks.reduce((sum, c) => sum + c.downloaded, 0);
          this.eventEmitter.emit("progress", downloadId, {
            chunkId: chunk.id,
            chunkDownloadedBytes: current,
            downloadedBytes: total,
            total,
          });
        }

        if (current - lastDbUpdate >= dbUpdateThreshold) {
          lastDbUpdate = current;
          this.updateProgress(downloadId, chunk.id, current).catch(() => {});
        }
      },
    });

    const writeStream = fs.createWriteStream(filePath, { flags: "r+", start: startFrom });
    await new Promise<void>((resolve, reject) => {
      response.data.pipe(writeStream);
      writeStream.on("finish", () => {
        writeStream.close();
        resolve();
      });
      writeStream.on("error", (err: any) => reject(err));
      response.data.on("error", (err: any) => reject(err));
    });

    await this.updateProgress(downloadId, chunk.id, downloadedBytes).catch(() => {});
    await this.markChunkDone(chunk.id, downloadedBytes);

    const cache = this.progressCache.get(downloadId);
    if (cache) {
      const chunkCache = cache.chunks.find((c) => c.id === chunk.id);
      if (chunkCache) chunkCache.downloaded = downloadedBytes;
      const total = cache.chunks.reduce((sum, c) => sum + c.downloaded, 0);
      this.eventEmitter.emit("progress", downloadId, {
        chunkId: chunk.id,
        chunkDownloadedBytes: downloadedBytes,
        downloadedBytes: total,
        total,
      });
    }
  }

  private static async markChunkDone(chunkId: string, downloadedBytes: number): Promise<void> {
    let lastErr;
    for (let attempt = 0; attempt < 3; attempt++) {
      try {
        await query("UPDATE chunks SET status = $1, downloaded_bytes = $2 WHERE id = $3", ["DONE", downloadedBytes, chunkId]);
        return;
      } catch (err) {
        lastErr = err;
        if (attempt < 2) await new Promise((r) => setTimeout(r, 200));
      }
    }
    throw lastErr;
  }

  private static async updateProgress(downloadId: string, chunkId: string, downloadedBytes: number): Promise<void> {
    let lastErr;
    for (let attempt = 0; attempt < 3; attempt++) {
      try {
        await query("UPDATE chunks SET downloaded_bytes = $1, status = $2 WHERE id = $3", [downloadedBytes, "ACTIVE", chunkId]);
        const rows = await query("SELECT downloaded_bytes FROM chunks WHERE download_id = $1", [downloadId]);
        const total = rows.reduce((acc, r) => acc + Number(r.downloadedBytes), 0);
        await query("UPDATE downloads SET downloaded_size = $1 WHERE id = $2", [total, downloadId]);
        return;
      } catch (err) {
        lastErr = err;
        if (attempt < 2) await new Promise((r) => setTimeout(r, 200));
      }
    }
    throw lastErr;
  }

  private static async flushProgress(downloadId: string): Promise<void> {
    const active = this.activeDownloads.get(downloadId);
    if (!active) return;
    for (const chunkMem of active.chunks) {
      await query("UPDATE chunks SET downloaded_bytes = $1, status = $2 WHERE id = $3", [chunkMem.downloaded, "ACTIVE", chunkMem.id]);
    }
    const rows = await query("SELECT downloaded_bytes FROM chunks WHERE download_id = $1", [downloadId]);
    const total = rows.reduce((acc, r) => acc + Number(r.downloadedBytes), 0);
    await query("UPDATE downloads SET downloaded_size = $1 WHERE id = $2", [total, downloadId]);
  }

  private static async runWithConcurrency(tasks: Array<() => Promise<any>>, concurrency: number): Promise<void> {
    const executing: Array<Promise<any>> = [];
    const results: Array<Promise<any>> = [];

    for (const task of tasks) {
      const p: Promise<any> = task()
        .then((result) => {
          const idx = executing.indexOf(p);
          if (idx !== -1) executing.splice(idx, 1);
          return result;
        })
        .catch((err) => {
          const idx = executing.indexOf(p);
          if (idx !== -1) executing.splice(idx, 1);
          throw err;
        });
      results.push(p);
      executing.push(p);

      if (executing.length >= concurrency) {
        await Promise.race(executing);
      }
    }
    await Promise.all(results);
  }

  private static async markComplete(downloadId: string): Promise<void> {
    const download = (await queryOne("SELECT * FROM downloads WHERE id = $1", [downloadId])) as DownloadRecord | null;
    if (!download) return;

    // Use default if there's no custom directory
    const finalDir = path.resolve("./downloads", download.directory);
    const finalPath = path.join(finalDir, download.filename);
    const tempPath = finalPath + ".part";

    try {
      await fs.promises.access(tempPath);
      await fs.promises.rename(tempPath, finalPath);
    } catch (err: any) {
      if (err.code !== "ENOENT") {
        console.error(`Rename complete file failed: ${err.message}`);
      }
    }

    await query("UPDATE downloads SET status = $1 WHERE id = $2", ["COMPLETED", downloadId]);
    this.activeDownloads.delete(downloadId);
    this.progressCache.delete(downloadId);
  }

  private static async markError(downloadId: string): Promise<void> {
    await query("UPDATE downloads SET status = $1 WHERE id = $2", ["ERROR", downloadId]);
    this.activeDownloads.delete(downloadId);
    this.progressCache.delete(downloadId);
  }

  public static async pauseDownload(downloadId: string): Promise<void> {
    const active = this.activeDownloads.get(downloadId);
    if (active) {
      active.abortController.abort();
    }
    await query("UPDATE downloads SET status = $1 WHERE id = $2", ["PAUSED", downloadId]);
    this.progressCache.delete(downloadId);
  }

  public static async resumeDownload(downloadId: string, downloadDir: string): Promise<void> {
    const download = (await queryOne("SELECT * FROM downloads WHERE id = $1", [downloadId])) as DownloadRecord | null;
    if (!download) throw new Error("Download metadata not found for resume target");
    if (download.status !== "PAUSED" && download.status !== "ERROR") {
      throw new Error("Only suspended/failed downloads can be resumed directly");
    }
    await query("UPDATE downloads SET status = $1 WHERE id = $2", ["PENDING", downloadId]);
    this.eventEmitter.emit("downloadResumed", downloadId);
    // Offload starts asynchronously
    this.startDownload(downloadId, downloadDir).catch(err => {
      console.error(`Async resuming download failed for task [${downloadId}]`, err);
    });
  }

  public static async stopDownload(downloadId: string): Promise<void> {
    const active = this.activeDownloads.get(downloadId);
    if (active) {
      active.abortController.abort();
      this.activeDownloads.delete(downloadId);
      this.progressCache.delete(downloadId);
    }
    await query("UPDATE downloads SET status = $1 WHERE id = $2", ["ERROR", downloadId]);
  }
}
