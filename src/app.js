const express = require('express');
const cors = require('cors');
const helmet = require('helmet');
const path = require('path');
const { initSocket } = require('./sockets');
const apiRoutes = require('./routes/api');
const externalRoutes = require('./routes/external');
const { initSettings } = require('./services/settings');
const { initScheduler } = require('./services/scheduler');

const app = express();

// Custom JSON replacer to handle BigInt as string
app.set('json replacer', (key, value) => {
    if (typeof value === 'bigint') {
        return value.toString();
    }
    return value;
});

// CSP: allow inline scripts and CDN, dynamic connect sources
const wsOrigin = process.env.WS_URL || 'ws://localhost:3000';
const httpOrigin = process.env.HTTP_URL || 'http://localhost:3000';
app.use(helmet({
    contentSecurityPolicy: {
        directives: {
            defaultSrc: ["'self'"],
            scriptSrc: [
                "'self'",
                "'unsafe-inline'",
                "https://cdn.tailwindcss.com",
                "https://cdn.jsdelivr.net"
            ],
            scriptSrcAttr: ["'unsafe-inline'"],
            styleSrc: [
                "'self'",
                "'unsafe-inline'",
                "https://cdn.jsdelivr.net",
                "https://cdn.tailwindcss.com"
            ],
            connectSrc: ["'self'", wsOrigin, httpOrigin],
            imgSrc: ["'self'", "data:"],
        },
    },
}));

app.use(cors());
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

app.use(express.static(path.join(__dirname, '../public')));

app.use('/api', apiRoutes);
app.use('/dl.hamvarz.ir', externalRoutes);

app.get('*', (req, res) => {
    res.sendFile(path.join(__dirname, '../public/index.html'));
});

app.use((err, req, res, next) => {
    console.error(err.stack);
    res.status(500).json({ error: 'Something went wrong!' });
});

async function init() {
    await initSettings();
    await initScheduler();
}

module.exports = { app, init };