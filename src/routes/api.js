const express = require('express');
const router = express.Router();
const downloadController = require('../controllers/downloadController');
const settingsController = require('../controllers/settingsController');

router.get('/downloads', downloadController.getDownloads);
router.get('/downloads/:id', downloadController.getDownload);
router.post('/downloads', downloadController.createDownload);
router.put('/downloads/:id', downloadController.updateDownload);
router.delete('/downloads/:id', downloadController.deleteDownload);
router.post('/downloads/:id/pause', downloadController.pauseDownload);
router.post('/downloads/:id/resume', downloadController.resumeDownload);
router.post('/downloads/:id/retry', downloadController.retryDownload);

router.get('/settings', settingsController.getSettings);
router.put('/settings', settingsController.updateSettings);

module.exports = router;