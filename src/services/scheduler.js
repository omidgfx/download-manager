const schedule = require('node-schedule');
const { query, queryOne } = require('../db');
const { enqueueDownload } = require('./taskQueue');

const scheduledJobs = new Map();

async function initScheduler() {
    const now = new Date().toISOString();

    const due = await query(
        `SELECT id, status, scheduled_at FROM downloads
     WHERE status IN ('PENDING', 'SCHEDULED')
       AND scheduled_at <= $1`,
        [now]
    );
    for (const d of due) {
        enqueueDownload(d.id);
        if (d.status === 'SCHEDULED') {
            await query('UPDATE downloads SET status = $1 WHERE id = $2', ['PENDING', d.id]);
        }
    }

    const future = await query(
        `SELECT id, scheduled_at FROM downloads
     WHERE status = 'SCHEDULED' AND scheduled_at > $1`,
        [now]
    );
    for (const d of future) {
        scheduleDownload(d.id, new Date(d.scheduledAt));
    }
}

function scheduleDownload(downloadId, date) {
    if (scheduledJobs.has(downloadId)) {
        scheduledJobs.get(downloadId).cancel();
        scheduledJobs.delete(downloadId);
    }
    const job = schedule.scheduleJob(date, async () => {
        try {
            await query('UPDATE downloads SET status = $1, scheduled_at = NULL WHERE id = $2', ['PENDING', downloadId]);
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