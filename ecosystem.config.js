module.exports = {
    apps: [{
        name: 'download-manager',
        script: 'src/server.js',
        env: {
            NODE_ENV: 'production',
        },
        instances: 1,
        exec_mode: 'fork',
        watch: false,
        max_memory_restart: '500M',
    }]
};