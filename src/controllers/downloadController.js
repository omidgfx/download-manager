const DownloadService = require('../services/downloader');
const { enqueueDownload } = require('../services/taskQueue');
const { scheduleDownload, cancelScheduledJob } = require('../services/scheduler');
const { sanitizeDirectory, ensureUniqueFilename } = require('../utils/pathSanitizer');
const path = require('path');
const config = require('../config');
const fs = require('fs').promises;
const axios = require('axios');
const { query, queryOne, generateId } = require('../db');

exports.getDownloads = async (req, res) => {
    const downloads = await query(
        `SELECT d.*, json_agg(c.*) as chunks
         FROM downloads d
         LEFT JOIN chunks c ON d.id = c.download_id
         GROUP BY d.id
         ORDER BY d.created_at DESC`
    );
    res.json(downloads);
};

exports.getDownload = async (req, res) => {
    const { id } = req.params;
    const download = await queryOne(
        `SELECT d.*, json_agg(c.*) as chunks
         FROM downloads d
         LEFT JOIN chunks c ON d.id = c.download_id
         WHERE d.id = $1
         GROUP BY d.id`,
        [id]
    );
    if (!download) return res.status(404).json({ error: 'Not found' });
    res.json(download);
};

exports.createDownload = async (req, res) => {
    const { url, filename, directory, chunkCount, scheduledAt } = req.body;
    if (!url) return res.status(400).json({ error: 'URL required' });

    let scheduleDate = null;
    if (scheduledAt) {
        scheduleDate = new Date(scheduledAt);
        if (isNaN(scheduleDate.getTime())) {
            return res.status(400).json({ error: 'Invalid scheduledAt date' });
        }
    }

    const safeDir = directory ? sanitizeDirectory(directory) : '';
    const relativeDir = safeDir ? path.relative(config.downloadDir, safeDir) : '';

    let finalName = filename;
    if (!finalName) {
        const urlObj = new URL(url);
        const base = path.basename(urlObj.pathname);
        finalName = base || 'download.bin';
    }

    const basePath = path.resolve(config.downloadDir, relativeDir);
    await fs.mkdir(basePath, { recursive: true });
    const { finalName: uniqueName } = await ensureUniqueFilename(basePath, finalName);

    let totalSize = null;
    let supportsRange = false;
    try {
        const headRes = await axios.head(url, { timeout: 5000 });
        totalSize = parseInt(headRes.headers['content-length'], 10) || null;
        supportsRange = headRes.headers['accept-ranges'] === 'bytes';
    } catch (err) {
        console.warn('HEAD request failed, assuming no range support', err.message);
    }

    let effectiveChunkCount = parseInt(chunkCount, 10) || 4;
    effectiveChunkCount = Math.max(1, Math.min(16, effectiveChunkCount));
    if (!supportsRange || !totalSize) {
        effectiveChunkCount = 1;
    }

    const id = generateId();
    const result = await query(
        `INSERT INTO downloads (id, url, filename, directory, total_size, downloaded_size, chunk_count, status, scheduled_at)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
         RETURNING *`,
        [id, url, uniqueName, relativeDir, totalSize, 0, effectiveChunkCount, scheduleDate ? 'SCHEDULED' : 'PENDING', scheduleDate]
    );
    const download = result[0];

    if (scheduleDate) {
        scheduleDownload(download.id, scheduleDate);
    } else {
        enqueueDownload(download.id);
    }

    res.status(201).json(download);
};

exports.updateDownload = async (req, res) => {
    const { id } = req.params;
    const { url, filename, chunkCount, scheduledAt } = req.body;

    const download = await queryOne('SELECT * FROM downloads WHERE id = $1', [id]);
    if (!download) return res.status(404).json({ error: 'Not found' });

    if (!['PENDING', 'PAUSED', 'SCHEDULED'].includes(download.status)) {
        return res.status(400).json({ error: 'Cannot edit active or completed task' });
    }

    const updateData = {};
    if (url) updateData.url = url;
    if (filename) {
        const basePath = path.resolve(config.downloadDir, download.directory);
        const { finalName } = await ensureUniqueFilename(basePath, filename);
        updateData.filename = finalName;
    }
    if (chunkCount) {
        const existingChunks = await query('SELECT * FROM chunks WHERE download_id = $1', [id]);
        if (existingChunks.length > 0 && download.chunkCount !== chunkCount) {
            return res.status(400).json({ error: 'Cannot change chunk count after download started' });
        }
        let newCount = parseInt(chunkCount, 10);
        if (isNaN(newCount) || newCount < 1) newCount = 1;
        if (newCount > 16) newCount = 16;
        updateData.chunkCount = newCount;
    }

    if (scheduledAt !== undefined) {
        if (scheduledAt === null || scheduledAt === '') {
            cancelScheduledJob(id);
            updateData.scheduledAt = null;
            updateData.status = 'PENDING';
        } else {
            const date = new Date(scheduledAt);
            if (isNaN(date.getTime())) {
                return res.status(400).json({ error: 'Invalid scheduledAt date' });
            }
            updateData.scheduledAt = date;
            updateData.status = 'SCHEDULED';
            cancelScheduledJob(id);
            scheduleDownload(id, date);
        }
    }

    const setClause = Object.keys(updateData).map((k, i) => `${k} = $${i + 2}`).join(', ');
    const values = [id, ...Object.values(updateData)];
    const result = await query(
        `UPDATE downloads SET ${setClause} WHERE id = $1 RETURNING *`,
        values
    );
    const updated = result[0];
    res.json(updated);
};

exports.deleteDownload = async (req, res) => {
    const { id } = req.params;
    const download = await queryOne('SELECT * FROM downloads WHERE id = $1', [id]);
    if (!download) return res.status(404).json({ error: 'Not found' });

    if (download.status === 'DOWNLOADING') {
        await DownloadService.stopDownload(id);
    }
    cancelScheduledJob(id);

    const basePath = path.resolve(config.downloadDir, download.directory);
    const finalPath = path.join(basePath, download.filename);
    const tempPath = finalPath + '.part';
    try { await fs.unlink(finalPath); } catch (err) { /* ignore */ }
    try { await fs.unlink(tempPath); } catch (err) { /* ignore */ }

    await query('DELETE FROM downloads WHERE id = $1', [id]);
    res.status(204).send();
};

exports.pauseDownload = async (req, res) => {
    const { id } = req.params;
    await DownloadService.pauseDownload(id);
    res.json({ message: 'Paused' });
};

exports.resumeDownload = async (req, res) => {
    const { id } = req.params;
    await DownloadService.resumeDownload(id);
    res.json({ message: 'Resumed' });
};

exports.retryDownload = async (req, res) => {
    const { id } = req.params;
    const download = await queryOne('SELECT * FROM downloads WHERE id = $1', [id]);
    if (!download) return res.status(404).json({ error: 'Not found' });
    if (download.status !== 'ERROR') {
        return res.status(400).json({ error: 'Only can retry error tasks' });
    }
    await query('UPDATE chunks SET downloaded_bytes = 0, status = $1 WHERE download_id = $2', ['PENDING', id]);
    await query('UPDATE downloads SET downloaded_size = 0, status = $1 WHERE id = $2', ['PENDING', id]);
    enqueueDownload(id);
    res.json({ message: 'Retry queued' });
};