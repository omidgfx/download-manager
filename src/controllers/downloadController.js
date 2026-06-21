const { PrismaClient } = require('@prisma/client');
const DownloadService = require('../services/downloader');
const { enqueueDownload } = require('../services/taskQueue');
const { scheduleDownload, cancelScheduledJob } = require('../services/scheduler');
const { sanitizeDirectory, ensureUniqueFilename } = require('../utils/pathSanitizer');
const path = require('path');
const config = require('../config');
const fs = require('fs').promises;
const axios = require('axios');

const prisma = new PrismaClient();

exports.getDownloads = async (req, res) => {
    const downloads = await prisma.download.findMany({
        include: { chunks: true },
        orderBy: { createdAt: 'desc' },
    });
    res.json(downloads);
};

exports.getDownload = async (req, res) => {
    const { id } = req.params;
    const download = await prisma.download.findUnique({
        where: { id },
        include: { chunks: true },
    });
    if (!download) return res.status(404).json({ error: 'Not found' });
    res.json(download);
};

exports.createDownload = async (req, res) => {
    const { url, filename, directory, chunkCount, scheduledAt } = req.body;
    if (!url) return res.status(400).json({ error: 'URL required' });

    // Validate scheduledAt
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

    // HEAD request to detect file size and range support
    let totalSize = null;
    let supportsRange = false;
    try {
        const headRes = await axios.head(url, { timeout: 5000 });
        totalSize = parseInt(headRes.headers['content-length'], 10) || null;
        supportsRange = headRes.headers['accept-ranges'] === 'bytes';
    } catch (err) {
        console.warn('HEAD request failed, assuming no range support', err.message);
    }

    // Validate and clamp chunkCount
    let effectiveChunkCount = parseInt(chunkCount, 10) || 4;
    effectiveChunkCount = Math.max(1, Math.min(16, effectiveChunkCount));
    if (!supportsRange || !totalSize) {
        effectiveChunkCount = 1;
    }

    const download = await prisma.download.create({
        data: {
            url,
            filename: uniqueName,
            directory: relativeDir,
            totalSize: totalSize ? BigInt(totalSize) : null,
            downloadedSize: 0n,
            chunkCount: effectiveChunkCount,
            status: scheduleDate ? 'SCHEDULED' : 'PENDING',
            scheduledAt: scheduleDate,
        },
    });

    if (scheduleDate) {
        // Schedule the job for the future
        scheduleDownload(download.id, scheduleDate);
    } else {
        enqueueDownload(download.id);
    }

    res.status(201).json(download);
};

exports.updateDownload = async (req, res) => {
    const { id } = req.params;
    const { url, filename, chunkCount, scheduledAt } = req.body;

    const download = await prisma.download.findUnique({ where: { id } });
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
        const existingChunks = await prisma.chunk.count({ where: { downloadId: id } });
        if (existingChunks > 0 && download.chunkCount !== chunkCount) {
            return res.status(400).json({ error: 'Cannot change chunk count after download started' });
        }
        // Validate and clamp
        let newCount = parseInt(chunkCount, 10);
        if (isNaN(newCount) || newCount < 1) newCount = 1;
        if (newCount > 16) newCount = 16;
        updateData.chunkCount = newCount;
    }

    // Handle scheduledAt
    let scheduleDate = null;
    if (scheduledAt !== undefined) {
        if (scheduledAt === null || scheduledAt === '') {
            // Remove scheduling
            cancelScheduledJob(id);
            updateData.scheduledAt = null;
            updateData.status = 'PENDING';
        } else {
            scheduleDate = new Date(scheduledAt);
            if (isNaN(scheduleDate.getTime())) {
                return res.status(400).json({ error: 'Invalid scheduledAt date' });
            }
            updateData.scheduledAt = scheduleDate;
            updateData.status = 'SCHEDULED';
            // Cancel any old job and schedule new one
            cancelScheduledJob(id);
            scheduleDownload(id, scheduleDate);
        }
    }

    const updated = await prisma.download.update({
        where: { id },
        data: updateData,
    });

    res.json(updated);
};

exports.deleteDownload = async (req, res) => {
    const { id } = req.params;
    const download = await prisma.download.findUnique({ where: { id } });
    if (!download) return res.status(404).json({ error: 'Not found' });

    if (download.status === 'DOWNLOADING') {
        await DownloadService.stopDownload(id);
    }
    // Cancel any scheduled job
    cancelScheduledJob(id);

    const basePath = path.resolve(config.downloadDir, download.directory);
    const finalPath = path.join(basePath, download.filename);
    const tempPath = finalPath + '.part';

    try { await fs.unlink(finalPath); } catch (err) { /* ignore */ }
    try { await fs.unlink(tempPath); } catch (err) { /* ignore */ }

    await prisma.download.delete({ where: { id } });
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
    const download = await prisma.download.findUnique({ where: { id } });
    if (!download) return res.status(404).json({ error: 'Not found' });
    if (download.status !== 'ERROR') {
        return res.status(400).json({ error: 'Only can retry error tasks' });
    }
    await prisma.chunk.updateMany({
        where: { downloadId: id },
        data: { downloadedBytes: 0n, status: 'PENDING' },
    });
    await prisma.download.update({
        where: { id },
        data: { downloadedSize: 0n, status: 'PENDING' },
    });
    enqueueDownload(id);
    res.json({ message: 'Retry queued' });
};