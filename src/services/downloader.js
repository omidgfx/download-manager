const { PrismaClient } = require('@prisma/client');
const axios = require('axios');
const fs = require('fs');
const path = require('path');
const EventEmitter = require('events');
const config = require('../config');
const { ensureUniqueFilename } = require('../utils/pathSanitizer');

const prisma = new PrismaClient();

class DownloadService {
    static activeDownloads = new Map();
    static eventEmitter = new EventEmitter();
    static progressCache = new Map();

    static isCancelError(err) {
        return axios.isCancel(err) || (err && err.code === 'ERR_CANCELED');
    }

    static async startDownload(downloadId) {
        let download = await prisma.download.findUnique({
            where: { id: downloadId },
            include: { chunks: true },
        });
        if (!download) throw new Error('Download not found');
        if (download.status === 'COMPLETED') return;
        if (download.status === 'PAUSED') return;

        const totalSize = download.totalSize ? Number(download.totalSize) : null;
        let chunkCount = download.chunkCount;
        if (!totalSize || totalSize === 0) {
            chunkCount = 1;
            await prisma.download.update({
                where: { id: downloadId },
                data: { chunkCount: 1 },
            });
            download = await prisma.download.findUnique({
                where: { id: downloadId },
                include: { chunks: true },
            });
        }

        const baseDir = path.resolve(config.downloadDir, download.directory);
        await fs.promises.mkdir(baseDir, { recursive: true });
        const finalPath = path.join(baseDir, download.filename);
        const tempPath = finalPath + '.part';

        const isFresh = download.chunks.length === 0 && download.downloadedSize === 0n;
        if (download.status === 'PENDING' && isFresh) {
            const { finalName } = await ensureUniqueFilename(baseDir, download.filename);
            if (finalName !== download.filename) {
                await prisma.download.update({
                    where: { id: downloadId },
                    data: { filename: finalName },
                });
                download = await prisma.download.findUnique({
                    where: { id: downloadId },
                    include: { chunks: true },
                });
            }
        }

        let chunks = download.chunks;
        if (chunks.length === 0) {
            chunks = await this.createChunks(downloadId, chunkCount, totalSize);
        }

        // Pre-allocate temp file
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
        await prisma.download.update({
            where: { id: downloadId },
            data: { status: 'DOWNLOADING' },
        });

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

        const tasks = chunks.map((_, i) => () =>
            this.downloadChunk(downloadId, i, abortController.signal)
        );

        const concurrency = Math.min(chunkCount, 4);
        let error = null;
        try {
            await this.runWithConcurrency(tasks, concurrency);
        } catch (err) {
            error = err;
            if (this.isCancelError(err)) {
                await this.flushProgress(downloadId);
                await prisma.download.update({
                    where: { id: downloadId },
                    data: { status: 'PAUSED' },
                });
                DownloadService.activeDownloads.delete(downloadId);
                DownloadService.progressCache.delete(downloadId);
                return;
            }
        }

        // Final flush – retry a few times if it fails
        try {
            await this.flushProgress(downloadId);
        } catch (flushErr) {
            console.error(`Flush failed for ${downloadId}, but continuing:`, flushErr);
        }

        // Check if all chunks are DONE (with retries)
        let allDone = false;
        for (let attempt = 0; attempt < 3; attempt++) {
            const updatedChunks = await prisma.chunk.findMany({
                where: { downloadId },
                select: { status: true },
            });
            allDone = updatedChunks.every(c => c.status === 'DONE');
            if (allDone) break;
            if (attempt < 2) await new Promise(r => setTimeout(r, 500));
        }

        if (!error && allDone) {
            await this.markComplete(downloadId);
            DownloadService.eventEmitter.emit('downloadComplete', downloadId);
        } else {
            // If allDone is false but the file is complete (maybe DB glitch), we can force complete
            // by checking file size or existence.
            const stat = await fs.promises.stat(tempPath).catch(() => null);
            if (stat && totalSize && stat.size === totalSize) {
                // File is complete, so force COMPLETED
                console.log(`Download ${downloadId} file is complete but DB said not all done. Forcing COMPLETED.`);
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
            chunks.push({
                downloadId,
                index: 0,
                startByte: 0n,
                endByte: null,
                downloadedBytes: 0n,
                status: 'PENDING',
            });
        } else {
            const chunkSize = Math.ceil(totalSize / chunkCount);
            for (let i = 0; i < chunkCount; i++) {
                const start = i * chunkSize;
                const end = (i === chunkCount - 1) ? totalSize - 1 : (start + chunkSize - 1);
                chunks.push({
                    downloadId,
                    index: i,
                    startByte: BigInt(start),
                    endByte: BigInt(end),
                    downloadedBytes: 0n,
                    status: 'PENDING',
                });
            }
        }
        await prisma.chunk.createMany({ data: chunks });
        return prisma.chunk.findMany({ where: { downloadId } });
    }

    static async downloadChunk(downloadId, chunkIndex, signal) {
        const chunk = await prisma.chunk.findFirst({
            where: { downloadId, index: chunkIndex },
        });
        if (!chunk) throw new Error(`Chunk ${chunkIndex} not found`);
        if (chunk.status === 'DONE') return;

        const startByte = Number(chunk.startByte);
        const endByte = chunk.endByte ? Number(chunk.endByte) : undefined;
        const alreadyDownloaded = Number(chunk.downloadedBytes);
        const startFrom = startByte + alreadyDownloaded;

        if (endByte !== undefined && alreadyDownloaded >= (endByte - startByte + 1)) {
            // Already done, mark DONE
            await this.markChunkDone(chunk.id, alreadyDownloaded);
            return;
        }

        const download = await prisma.download.findUnique({ where: { id: downloadId } });
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
        const dbUpdateThreshold = 512 * 1024; // 512 KB

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
                    // Fire-and-forget with retry
                    this.updateProgress(downloadId, chunk.id, current)
                        .catch(err => console.error('Progress update error:', err));
                }
            }
        });

        const writeStream = fs.createWriteStream(filePath, {
            flags: 'r+',
            start: startFrom,
        });

        await new Promise((resolve, reject) => {
            response.data.pipe(writeStream);
            writeStream.on('finish', resolve);
            writeStream.on('error', reject);
            response.data.on('error', reject);
        });

        // Update progress one last time (with retries)
        await this.updateProgress(downloadId, chunk.id, downloadedBytes)
            .catch(err => console.error('Final progress update error:', err));

        // Mark chunk as DONE (with retries)
        await this.markChunkDone(chunk.id, downloadedBytes);

        // Emit final progress
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
        // Retry up to 3 times
        let lastErr;
        for (let attempt = 0; attempt < 3; attempt++) {
            try {
                await prisma.chunk.update({
                    where: { id: chunkId },
                    data: {
                        status: 'DONE',
                        downloadedBytes: BigInt(downloadedBytes),
                    },
                });
                return;
            } catch (err) {
                lastErr = err;
                if (attempt < 2) await new Promise(r => setTimeout(r, 300));
            }
        }
        throw lastErr;
    }

    static async updateProgress(downloadId, chunkId, downloadedBytes) {
        // Retry up to 3 times
        let lastErr;
        for (let attempt = 0; attempt < 3; attempt++) {
            try {
                await prisma.chunk.update({
                    where: { id: chunkId },
                    data: { downloadedBytes: BigInt(downloadedBytes), status: 'ACTIVE' },
                });
                const chunks = await prisma.chunk.findMany({
                    where: { downloadId },
                    select: { downloadedBytes: true },
                });
                const total = chunks.reduce((acc, c) => acc + c.downloadedBytes, 0n);
                await prisma.download.update({
                    where: { id: downloadId },
                    data: { downloadedSize: total },
                });
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
            await prisma.chunk.update({
                where: { id: chunkMem.id },
                data: { downloadedBytes: BigInt(chunkMem.downloaded), status: 'ACTIVE' },
            });
        }
        const chunks = await prisma.chunk.findMany({
            where: { downloadId },
            select: { downloadedBytes: true },
        });
        const total = chunks.reduce((acc, c) => acc + c.downloadedBytes, 0n);
        await prisma.download.update({
            where: { id: downloadId },
            data: { downloadedSize: total },
        });
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
        const download = await prisma.download.findUnique({ where: { id: downloadId } });
        if (!download) return;

        const baseDir = path.resolve(config.downloadDir, download.directory);
        const finalPath = path.join(baseDir, download.filename);
        const tempPath = finalPath + '.part';

        try {
            await fs.promises.rename(tempPath, finalPath);
        } catch (err) {
            console.error(`Rename failed for ${downloadId}:`, err);
        }

        await prisma.download.update({
            where: { id: downloadId },
            data: { status: 'COMPLETED' },
        });
        DownloadService.activeDownloads.delete(downloadId);
        DownloadService.progressCache.delete(downloadId);
    }

    static async markError(downloadId) {
        await prisma.download.update({
            where: { id: downloadId },
            data: { status: 'ERROR' },
        });
        DownloadService.activeDownloads.delete(downloadId);
        DownloadService.progressCache.delete(downloadId);
    }

    static async pauseDownload(downloadId) {
        const active = DownloadService.activeDownloads.get(downloadId);
        if (active) {
            active.abortController.abort();
        }
        await prisma.download.update({
            where: { id: downloadId },
            data: { status: 'PAUSED' },
        });
        DownloadService.progressCache.delete(downloadId);
    }

    static async resumeDownload(downloadId) {
        const download = await prisma.download.findUnique({
            where: { id: downloadId },
            include: { chunks: true },
        });
        if (!download) throw new Error('Download not found');
        if (download.status !== 'PAUSED') throw new Error('Can only resume paused');
        await prisma.download.update({
            where: { id: downloadId },
            data: { status: 'PENDING' },
        });
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
        await prisma.download.update({
            where: { id: downloadId },
            data: { status: 'ERROR' },
        });
    }
}

module.exports = DownloadService;