const dotenv = require('dotenv');
dotenv.config();

module.exports = {
    port: process.env.PORT || 3000,
    databaseUrl: process.env.DATABASE_URL,
    downloadDir: process.env.DOWNLOAD_DIR || './downloads',
    maxConcurrentTasks: parseInt(process.env.MAX_CONCURRENT_TASKS, 10) || 3,
};