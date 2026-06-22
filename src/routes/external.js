const express = require('express');
const router = express.Router();
const { sanitizeDirectory, ensureUniqueFilename } = require('../utils/pathSanitizer');
const { getSetting } = require('../services/settings');
const config = require('../config');
const path = require('path');
const fs = require('fs').promises;
const { enqueueDownload } = require('../services/taskQueue');
const axios = require('axios');
const { query, generateId } = require('../db');

router.get('/', async (req, res, next) => {
    const { url, dir, name } = req.query;

    // If no 'url' parameter, pass control to the next handler (static files, catch‑all)
    if (!url) {
        return next();
    }

    // --- Process the external download request ---
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

    // HEAD request: get total size and range support
    let totalSize = null;
    let supportsRange = false;
    try {
        const headRes = await axios.head(decodedUrl, { timeout: 5000 });
        totalSize = parseInt(headRes.headers['content-length'], 10) || null;
        supportsRange = headRes.headers['accept-ranges'] === 'bytes';
    } catch (err) {
        console.warn('HEAD request failed, assuming no range support', err.message);
    }

    const maxChunks = await getSetting('defaultChunkCount') || 4;
    // Only use multipart if we know the total size AND the server supports ranges
    const effectiveChunkCount = (supportsRange && totalSize) ? maxChunks : 1;

    const id = generateId();
    const result = await query(
        `INSERT INTO downloads (id, url, filename, directory, total_size, downloaded_size, chunk_count, status)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
             RETURNING *`,
        [id, decodedUrl, uniqueName, relativeDir, totalSize, 0, effectiveChunkCount, 'PENDING']
    );
    const download = result[0];

    enqueueDownload(download.id);

    // Return JSON response (or redirect to UI if desired)
    res.json({ success: true, taskId: download.id, filename: uniqueName });
});

module.exports = router;