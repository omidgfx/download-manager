const PQueue = require('p-queue').default || require('p-queue');
const config = require('../config');
const DownloadService = require('./downloader');

const queue = new PQueue({ concurrency: config.maxConcurrentTasks });

const startDownloadJob = async (downloadId) => {
    try {
        await DownloadService.startDownload(downloadId);
    } catch (err) {
        console.error(`Failed to start download ${downloadId}:`, err);
        await DownloadService.markError(downloadId);
    }
};

function enqueueDownload(downloadId) {
    queue.add(() => startDownloadJob(downloadId));
}

module.exports = { enqueueDownload, queue };