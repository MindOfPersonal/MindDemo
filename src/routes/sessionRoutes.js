const express = require('express');
const sessionController = require('../controllers/sessionController');

const router = express.Router();

router.post('/heartbeat', sessionController.heartbeat);
router.post('/end', sessionController.endSession);
router.get('/:session_token', sessionController.getSession);
router.get('/:session_token/container-logs', sessionController.getContainerLogs);
router.get('/:session_token/logs', sessionController.getSessionLogs);
router.get('/:session_token/health', sessionController.checkSessionHealth);

module.exports = router;
