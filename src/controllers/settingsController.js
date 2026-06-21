const { getSetting, setSetting } = require('../services/settings');
const config = require('../config');
const path = require('path');

exports.getSettings = async (req, res) => {
    const keys = ['downloadDirectory', 'maxConcurrentTasks'];
    const settings = {};
    for (const k of keys) {
        settings[k] = await getSetting(k);
    }
    res.json(settings);
};

exports.updateSettings = async (req, res) => {
    const { downloadDirectory, maxConcurrentTasks } = req.body;
    if (downloadDirectory) {
        const resolved = path.resolve(downloadDirectory);
        await setSetting('downloadDirectory', resolved);
        config.downloadDir = resolved;
    }
    if (maxConcurrentTasks !== undefined) {
        const num = parseInt(maxConcurrentTasks, 10);
        if (num > 0) {
            await setSetting('maxConcurrentTasks', num);
            config.maxConcurrentTasks = num;
            const { queue } = require('../services/taskQueue');
            queue.concurrency = num;
        }
    }
    res.json({ message: 'Settings updated' });
};