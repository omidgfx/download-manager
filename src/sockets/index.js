const { Server } = require('socket.io');
const DownloadService = require('../services/downloader');
const { PrismaClient } = require('@prisma/client');
const prisma = new PrismaClient();

let io;

function initSocket(server) {
    io = new Server(server, {
        cors: {
            origin: '*',
        },
    });

    DownloadService.eventEmitter.on('progress', async (downloadId, progress) => {
        // Fetch totalSize and this chunk's downloadedBytes
        const [download, chunk] = await Promise.all([
            prisma.download.findUnique({
                where: { id: downloadId },
                select: { totalSize: true },
            }),
            prisma.chunk.findUnique({
                where: { id: progress.chunkId },
                select: { downloadedBytes: true },
            })
        ]);
        const totalSize = download?.totalSize ? Number(download.totalSize) : null;
        const chunkDownloadedBytes = chunk ? Number(chunk.downloadedBytes) : 0;
        io.emit('downloadProgress', {
            downloadId,
            chunkId: progress.chunkId,
            chunkDownloadedBytes,        // per-chunk progress
            downloadedBytes: progress.downloadedBytes, // total downloaded (all chunks)
            total: progress.total,
            totalSize,
        });
    });

    DownloadService.eventEmitter.on('downloadComplete', (downloadId) => {
        io.emit('downloadComplete', downloadId);
    });

    DownloadService.eventEmitter.on('downloadError', (downloadId) => {
        io.emit('downloadError', downloadId);
    });

    DownloadService.eventEmitter.on('downloadStarted', (downloadId) => {
        io.emit('downloadStarted', downloadId);
    });

    DownloadService.eventEmitter.on('downloadResumed', (downloadId) => {
        io.emit('downloadResumed', downloadId);
    });

    io.on('connection', (socket) => {
        console.log('Client connected');
        socket.on('disconnect', () => {
            console.log('Client disconnected');
        });
    });
}

function getIO() {
    return io;
}

module.exports = { initSocket, getIO };