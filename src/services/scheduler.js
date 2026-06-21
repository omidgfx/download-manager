const schedule = require('node-schedule');
const { PrismaClient } = require('@prisma/client');
const { enqueueDownload } = require('./taskQueue');

const prisma = new PrismaClient();
const scheduledJobs = new Map();

async function initScheduler() {
    const now = new Date();
    // Process due tasks
    const due = await prisma.download.findMany({
        where: {
            OR: [
                { status: 'PENDING' },
                { status: 'SCHEDULED' },
            ],
            scheduledAt: { lte: now },
        },
    });
    for (const d of due) {
        enqueueDownload(d.id);
        if (d.status === 'SCHEDULED') {
            await prisma.download.update({
                where: { id: d.id },
                data: { status: 'PENDING' },
            });
        }
    }

    // Schedule future tasks
    const future = await prisma.download.findMany({
        where: {
            status: 'SCHEDULED',
            scheduledAt: { gt: now },
        },
    });
    for (const d of future) {
        scheduleDownload(d.id, d.scheduledAt);
    }
}

function scheduleDownload(downloadId, date) {
    // Cancel any existing job for this download
    if (scheduledJobs.has(downloadId)) {
        scheduledJobs.get(downloadId).cancel();
        scheduledJobs.delete(downloadId);
    }
    const job = schedule.scheduleJob(date, async () => {
        try {
            // When job fires, enqueue the download and update status to PENDING
            await prisma.download.update({
                where: { id: downloadId },
                data: { status: 'PENDING', scheduledAt: null },
            });
            enqueueDownload(downloadId);
        } catch (err) {
            console.error(`Failed to start scheduled download ${downloadId}:`, err);
        } finally {
            scheduledJobs.delete(downloadId);
        }
    });
    scheduledJobs.set(downloadId, job);
}

function cancelScheduledJob(downloadId) {
    if (scheduledJobs.has(downloadId)) {
        scheduledJobs.get(downloadId).cancel();
        scheduledJobs.delete(downloadId);
    }
}

module.exports = { initScheduler, scheduleDownload, cancelScheduledJob };