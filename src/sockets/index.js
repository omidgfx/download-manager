const { Server } = require('socket.io');
const DownloadService = require('../services/downloader');
const { queryOne } = require('../db');

let io;

function initSocket(server) {
    io = new Server(server, {
        cors: {
            origin: '*',
        },
    });

    DownloadService.eventEmitter.on('progress', async (downloadId, progress) => {
        const [download, chunk] = await Promise.all([
            queryOne('SELECT total_size FROM downloads WHERE id = $1', [downloadId]),
            queryOne('SELECT downloaded_bytes FROM chunks WHERE id = $1', [progress.chunkId])
        ]);
        const totalSize = download?.totalSize ? Number(download.totalSize) : null;
        const chunkDownloadedBytes = chunk ? Number(chunk.downloadedBytes) : 0;
        io.emit('downloadProgress', {
            downloadId,
            chunkId: progress.chunkId,
            chunkDownloadedBytes,
            downloadedBytes: progress.downloadedBytes,
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