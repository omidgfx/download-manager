const path = require('path');
const fs = require('fs').promises;
const config = require('../config');

function sanitizeDirectory(userDir) {
    const base = path.resolve(config.downloadDir);
    const target = path.resolve(base, userDir);
    if (!target.startsWith(base)) {
        throw new Error('Directory traversal not allowed');
    }
    return target;
}

async function ensureUniqueFilename(dirPath, baseName) {
    const ext = path.extname(baseName);
    const name = path.basename(baseName, ext);
    let counter = 0;
    let finalName = baseName;
    let finalPath = path.join(dirPath, finalName);
    while (true) {
        try {
            await fs.access(finalPath);
            counter++;
            finalName = `${name} (${counter})${ext}`;
            finalPath = path.join(dirPath, finalName);
        } catch {
            break;
        }
    }
    return { finalPath, finalName };
}

module.exports = { sanitizeDirectory, ensureUniqueFilename };