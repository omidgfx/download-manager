const { query, queryOne } = require('../db');

async function getSetting(key) {
    const row = await queryOne('SELECT value FROM settings WHERE key = $1', [key]);
    return row ? row.value : null;
}

async function setSetting(key, value) {
    // Convert value to valid JSON
    const jsonValue = JSON.stringify(value);
    await query(
        `INSERT INTO settings (key, value) VALUES ($1, $2::jsonb)
            ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value`,
        [key, jsonValue]
    );
}

async function initSettings() {
    const defaults = {
        downloadDirectory: './downloads',
        maxConcurrentTasks: 3,
        defaultChunkCount: 4,
    };
    for (const [key, val] of Object.entries(defaults)) {
        const existing = await getSetting(key);
        if (existing === null) {
            await setSetting(key, val);
        }
    }
}

module.exports = { getSetting, setSetting, initSettings };