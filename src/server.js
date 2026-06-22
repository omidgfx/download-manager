const {app, init} = require('./app');
const {initSocket} = require('./sockets');
const config = require('./config');
const http = require('http');

const server = http.createServer(app);
initSocket(server);

init().then(() => {
    server.listen(config.port, '0.0.0.0', () => {
        console.log(`Download Manager running on port ${config.port}`);
    });
}).catch(err => {
    console.error('Failed to initialize:', err);
    process.exit(1);
});