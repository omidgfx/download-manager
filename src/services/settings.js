const { PrismaClient } = require('@prisma/client');
const prisma = new PrismaClient();

async function getSetting(key) {
    const setting = await prisma.setting.findUnique({ where: { key } });
    return setting ? setting.value : null;
}

async function setSetting(key, value) {
    await prisma.setting.upsert({
        where: { key },
        update: { value },
        create: { key, value },
    });
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