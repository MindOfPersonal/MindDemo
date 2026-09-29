const express = require('express');
const sessionController = require('../controllers/sessionController');

const router = express.Router();

router.post('/heartbeat', sessionController.heartbeat);
router.post('/end', sessionController.endSession);
router.get('/:session_token', sessionController.getSession);

module.exports = router;
