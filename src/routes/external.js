const express = require('express');
const router = express.Router();
const { PrismaClient } = require('@prisma/client');
const { sanitizeDirectory, ensureUniqueFilename } = require('../utils/pathSanitizer');
const { getSetting } = require('../services/settings');
const config = require('../config');
const path = require('path');
const fs = require('fs').promises;
const { enqueueDownload } = require('../services/taskQueue');
const axios = require('axios');

const prisma = new PrismaClient();

router.get('/', async (req, res) => {
    const { url, dir, name } = req.query;
    if (!url) {
        return res.status(400).json({ error: 'Missing url parameter' });
    }

    const decodedUrl = decodeURIComponent(url);
    try {
        new URL(decodedUrl);
    } catch {
        return res.status(400).json({ error: 'Invalid URL' });
    }

    let relativeDir = '';
    if (dir) {
        const safeDir = sanitizeDirectory(dir);
        relativeDir = path.relative(config.downloadDir, safeDir);
    }

    let finalName = name;
    if (!finalName) {
        const urlObj = new URL(decodedUrl);
        const base = path.basename(urlObj.pathname);
        finalName = base || 'download.bin';
    }

    const basePath = path.resolve(config.downloadDir, relativeDir);
    await fs.mkdir(basePath, { recursive: true });
    const { finalName: uniqueName } = await ensureUniqueFilename(basePath, finalName);

    // Detect range support
    let supportsRange = false;
    try {
        const headRes = await axios.head(decodedUrl, { timeout: 5000 });
        supportsRange = headRes.headers['accept-ranges'] === 'bytes';
    } catch (err) {
        console.warn('HEAD request failed, assuming no range support', err.message);
    }

    const maxChunks = await getSetting('defaultChunkCount') || 4;
    const effectiveChunkCount = supportsRange ? maxChunks : 1;

    const download = await prisma.download.create({
        data: {
            url: decodedUrl,
            filename: uniqueName,
            directory: relativeDir,
            totalSize: null,
            downloadedSize: 0n,
            chunkCount: effectiveChunkCount,
            status: 'PENDING',
        },
    });

    enqueueDownload(download.id);
    res.json({ success: true, taskId: download.id, filename: uniqueName });
});

module.exports = router;