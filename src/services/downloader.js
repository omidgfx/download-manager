const axios = require('axios');
const fs = require('fs');
const path = require('path');
const EventEmitter = require('events');
const config = require('../config');
const { ensureUniqueFilename } = require('../utils/pathSanitizer');
const { query, queryOne, generateId } = require('../db');

class DownloadService {
    static activeDownloads = new Map();
    static eventEmitter = new EventEmitter();
    static progressCache = new Map();

    static isCancelError(err) {
        return axios.isCancel(err) || (err && err.code === 'ERR_CANCELED');
    }

    static async startDownload(downloadId) {
        let download = await queryOne('SELECT * FROM downloads WHERE id = $1', [downloadId]);
        if (!download) throw new Error('Download not found');
        if (download.status === 'COMPLETED') return;
        if (download.status === 'PAUSED') return;

        const totalSize = download.totalSize ? Number(download.totalSize) : null;
        let chunkCount = download.chunkCount;

        // If totalSize is still unknown, we cannot split – keep existing chunkCount (should be 1)
        // No forced override here; chunkCount was set correctly at creation.

        const baseDir = path.resolve(config.downloadDir, download.directory);
        await fs.promises.mkdir(baseDir, { recursive: true });
        const finalPath = path.join(baseDir, download.filename);
        const tempPath = finalPath + '.part';

        let chunks = await query('SELECT * FROM chunks WHERE download_id = $1 ORDER BY index ASC', [downloadId]);

        const isFresh = chunks.length === 0 && download.downloadedSize === 0;
        if (download.status === 'PENDING' && isFresh) {
            const { finalName } = await ensureUniqueFilename(baseDir, download.filename);
            if (finalName !== download.filename) {
                await query('UPDATE downloads SET filename = $1 WHERE id = $2', [finalName, downloadId]);
                download = await queryOne('SELECT * FROM downloads WHERE id = $1', [downloadId]);
            }
        }

        if (chunks.length === 0) {
            chunks = await this.createChunks(downloadId, chunkCount, totalSize);
        }

        if (totalSize) {
            try {
                const fd = fs.openSync(tempPath, 'w');
                fs.ftruncateSync(fd, totalSize);
                fs.closeSync(fd);
            } catch (err) { /* ignore */ }
        } else {
            try {
                await fs.promises.writeFile(tempPath, '');
            } catch (err) { /* ignore */ }
        }

        const abortController = new AbortController();
        await query('UPDATE downloads SET status = $1 WHERE id = $2', ['DOWNLOADING', downloadId]);

        DownloadService.eventEmitter.emit('downloadStarted', downloadId);

        DownloadService.progressCache.set(downloadId, {
            chunks: chunks.map(c => ({ id: c.id, downloaded: Number(c.downloadedBytes) })),
            totalSize: totalSize,
        });

        DownloadService.activeDownloads.set(downloadId, {
            abortController,
            filePath: tempPath,
            finalPath: finalPath,
            chunks: chunks.map(c => ({
                id: c.id,
                start: Number(c.startByte),
                end: c.endByte ? Number(c.endByte) : undefined,
                downloaded: Number(c.downloadedBytes),
            })),
        });

        const tasks = chunks.map((_, i) => () => this.downloadChunk(downloadId, i, abortController.signal));
        const concurrency = Math.min(chunkCount, 4);
        let error = null;
        try {
            await this.runWithConcurrency(tasks, concurrency);
        } catch (err) {
            error = err;
            if (this.isCancelError(err)) {
                await this.flushProgress(downloadId);
                await query('UPDATE downloads SET status = $1 WHERE id = $2', ['PAUSED', downloadId]);
                DownloadService.activeDownloads.delete(downloadId);
                DownloadService.progressCache.delete(downloadId);
                return;
            }
        }

        try {
            await this.flushProgress(downloadId);
        } catch (flushErr) {
            console.error(`Flush failed for ${downloadId}:`, flushErr);
        }

        let allDone = false;
        for (let attempt = 0; attempt < 3; attempt++) {
            const rows = await query('SELECT status FROM chunks WHERE download_id = $1', [downloadId]);
            allDone = rows.every(r => r.status === 'DONE');
            if (allDone) break;
            if (attempt < 2) await new Promise(r => setTimeout(r, 500));
        }

        if (!error && allDone) {
            await this.markComplete(downloadId);
            DownloadService.eventEmitter.emit('downloadComplete', downloadId);
        } else {
            const stat = await fs.promises.stat(tempPath).catch(() => null);
            if (stat && totalSize && stat.size === totalSize) {
                console.log(`Download ${downloadId} file complete, forcing COMPLETED.`);
                await this.markComplete(downloadId);
                DownloadService.eventEmitter.emit('downloadComplete', downloadId);
            } else {
                await this.markError(downloadId);
                DownloadService.eventEmitter.emit('downloadError', downloadId);
            }
        }

        DownloadService.activeDownloads.delete(downloadId);
        DownloadService.progressCache.delete(downloadId);
    }

    static async createChunks(downloadId, chunkCount, totalSize) {
        const chunks = [];
        if (!totalSize) {
            chunks.push({ downloadId, index: 0, startByte: 0, endByte: null, downloadedBytes: 0, status: 'PENDING' });
        } else {
            const chunkSize = Math.ceil(totalSize / chunkCount);
            for (let i = 0; i < chunkCount; i++) {
                const start = i * chunkSize;
                const end = (i === chunkCount - 1) ? totalSize - 1 : (start + chunkSize - 1);
                chunks.push({ downloadId, index: i, startByte: start, endByte: end, downloadedBytes: 0, status: 'PENDING' });
            }
        }
        for (const ch of chunks) {
            const id = generateId();
            await query(
                `INSERT INTO chunks (id, download_id, index, start_byte, end_byte, downloaded_bytes, status)
                 VALUES ($1, $2, $3, $4, $5, $6, $7)`,
                [id, ch.downloadId, ch.index, ch.startByte, ch.endByte, ch.downloadedBytes, ch.status]
            );
        }
        return query('SELECT * FROM chunks WHERE download_id = $1 ORDER BY index ASC', [downloadId]);
    }

    static async downloadChunk(downloadId, chunkIndex, signal) {
        const chunk = await queryOne('SELECT * FROM chunks WHERE download_id = $1 AND index = $2', [downloadId, chunkIndex]);
        if (!chunk) throw new Error(`Chunk ${chunkIndex} not found`);
        if (chunk.status === 'DONE') return;

        const startByte = Number(chunk.startByte);
        const endByte = chunk.endByte ? Number(chunk.endByte) : undefined;
        const alreadyDownloaded = Number(chunk.downloadedBytes);
        const startFrom = startByte + alreadyDownloaded;

        if (endByte !== undefined && alreadyDownloaded >= (endByte - startByte + 1)) {
            await this.markChunkDone(chunk.id, alreadyDownloaded);
            const cache = DownloadService.progressCache.get(downloadId);
            if (cache) {
                const total = cache.chunks.reduce((sum, c) => sum + c.downloaded, 0);
                DownloadService.eventEmitter.emit('progress', downloadId, {
                    chunkId: chunk.id,
                    downloadedBytes: total,
                    total: total,
                });
            }
            return;
        }

        const download = await queryOne('SELECT * FROM downloads WHERE id = $1', [downloadId]);
        const url = download.url;
        const headers = {};
        if (endByte !== undefined) {
            headers['Range'] = `bytes=${startFrom}-${endByte}`;
        } else {
            headers['Range'] = `bytes=${startFrom}-`;
        }

        const active = DownloadService.activeDownloads.get(downloadId);
        if (!active) throw new Error('Download not active');
        const filePath = active.filePath;

        const chunkMem = active.chunks.find(c => c.id === chunk.id);
        if (!chunkMem) throw new Error('Chunk not in memory');

        let downloadedBytes = alreadyDownloaded;
        let lastDbUpdate = alreadyDownloaded;
        const dbUpdateThreshold = 512 * 1024;

        const response = await axios({
            method: 'GET',
            url,
            headers,
            responseType: 'stream',
            timeout: 30000,
            signal,
            onDownloadProgress: (progressEvent) => {
                const current = alreadyDownloaded + progressEvent.loaded;
                downloadedBytes = current;
                chunkMem.downloaded = current;

                const cache = DownloadService.progressCache.get(downloadId);
                if (cache) {
                    const chunkCache = cache.chunks.find(c => c.id === chunk.id);
                    if (chunkCache) chunkCache.downloaded = current;
                    const total = cache.chunks.reduce((sum, c) => sum + c.downloaded, 0);
                    DownloadService.eventEmitter.emit('progress', downloadId, {
                        chunkId: chunk.id,
                        downloadedBytes: total,
                        total: total,
                    });
                }

                if (current - lastDbUpdate >= dbUpdateThreshold) {
                    lastDbUpdate = current;
                    this.updateProgress(downloadId, chunk.id, current).catch(() => {});
                }
            }
        });

        const writeStream = fs.createWriteStream(filePath, { flags: 'r+', start: startFrom });
        await new Promise((resolve, reject) => {
            response.data.pipe(writeStream);
            writeStream.on('finish', resolve);
            writeStream.on('error', reject);
            response.data.on('error', reject);
        });

        await this.updateProgress(downloadId, chunk.id, downloadedBytes).catch(() => {});
        await this.markChunkDone(chunk.id, downloadedBytes);

        const cache = DownloadService.progressCache.get(downloadId);
        if (cache) {
            const chunkCache = cache.chunks.find(c => c.id === chunk.id);
            if (chunkCache) chunkCache.downloaded = downloadedBytes;
            const total = cache.chunks.reduce((sum, c) => sum + c.downloaded, 0);
            DownloadService.eventEmitter.emit('progress', downloadId, {
                chunkId: chunk.id,
                downloadedBytes: total,
                total: total,
            });
        }
    }

    static async markChunkDone(chunkId, downloadedBytes) {
        let lastErr;
        for (let attempt = 0; attempt < 3; attempt++) {
            try {
                await query('UPDATE chunks SET status = $1, downloaded_bytes = $2 WHERE id = $3', ['DONE', downloadedBytes, chunkId]);
                return;
            } catch (err) {
                lastErr = err;
                if (attempt < 2) await new Promise(r => setTimeout(r, 300));
            }
        }
        throw lastErr;
    }

    static async updateProgress(downloadId, chunkId, downloadedBytes) {
        let lastErr;
        for (let attempt = 0; attempt < 3; attempt++) {
            try {
                await query('UPDATE chunks SET downloaded_bytes = $1, status = $2 WHERE id = $3', [downloadedBytes, 'ACTIVE', chunkId]);
                const rows = await query('SELECT downloaded_bytes FROM chunks WHERE download_id = $1', [downloadId]);
                const total = rows.reduce((acc, r) => acc + Number(r.downloadedBytes), 0);
                await query('UPDATE downloads SET downloaded_size = $1 WHERE id = $2', [total, downloadId]);
                return;
            } catch (err) {
                lastErr = err;
                if (attempt < 2) await new Promise(r => setTimeout(r, 300));
            }
        }
        throw lastErr;
    }

    static async flushProgress(downloadId) {
        const active = DownloadService.activeDownloads.get(downloadId);
        if (!active) return;
        for (const chunkMem of active.chunks) {
            await query('UPDATE chunks SET downloaded_bytes = $1, status = $2 WHERE id = $3', [chunkMem.downloaded, 'ACTIVE', chunkMem.id]);
        }
        const rows = await query('SELECT downloaded_bytes FROM chunks WHERE download_id = $1', [downloadId]);
        const total = rows.reduce((acc, r) => acc + Number(r.downloadedBytes), 0);
        await query('UPDATE downloads SET downloaded_size = $1 WHERE id = $2', [total, downloadId]);
    }

    static async runWithConcurrency(tasks, concurrency) {
        const executing = [];
        const results = [];
        for (const task of tasks) {
            const p = task()
                .then(result => {
                    const idx = executing.indexOf(p);
                    if (idx !== -1) executing.splice(idx, 1);
                    return result;
                })
                .catch(err => {
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

    static async markComplete(downloadId) {
        const download = await queryOne('SELECT * FROM downloads WHERE id = $1', [downloadId]);
        if (!download) return;

        const baseDir = path.resolve(config.downloadDir, download.directory);
        const finalPath = path.join(baseDir, download.filename);
        const tempPath = finalPath + '.part';

        try {
            await fs.promises.access(tempPath);
            await fs.promises.rename(tempPath, finalPath);
        } catch (err) {
            if (err.code !== 'ENOENT') console.error(`Rename failed: ${err.message}`);
        }

        await query('UPDATE downloads SET status = $1 WHERE id = $2', ['COMPLETED', downloadId]);
        DownloadService.activeDownloads.delete(downloadId);
        DownloadService.progressCache.delete(downloadId);
    }

    static async markError(downloadId) {
        await query('UPDATE downloads SET status = $1 WHERE id = $2', ['ERROR', downloadId]);
        DownloadService.activeDownloads.delete(downloadId);
        DownloadService.progressCache.delete(downloadId);
    }

    static async pauseDownload(downloadId) {
        const active = DownloadService.activeDownloads.get(downloadId);
        if (active) {
            active.abortController.abort();
        }
        await query('UPDATE downloads SET status = $1 WHERE id = $2', ['PAUSED', downloadId]);
        DownloadService.progressCache.delete(downloadId);
    }

    static async resumeDownload(downloadId) {
        const download = await queryOne('SELECT * FROM downloads WHERE id = $1', [downloadId]);
        if (!download) throw new Error('Download not found');
        if (download.status !== 'PAUSED') throw new Error('Can only resume paused');
        await query('UPDATE downloads SET status = $1 WHERE id = $2', ['PENDING', downloadId]);
        DownloadService.eventEmitter.emit('downloadResumed', downloadId);
        return this.startDownload(downloadId);
    }

    static async stopDownload(downloadId) {
        const active = DownloadService.activeDownloads.get(downloadId);
        if (active) {
            active.abortController.abort();
            DownloadService.activeDownloads.delete(downloadId);
            DownloadService.progressCache.delete(downloadId);
        }
        await query('UPDATE downloads SET status = $1 WHERE id = $2', ['ERROR', downloadId]);
    }
}

module.exports = DownloadService;