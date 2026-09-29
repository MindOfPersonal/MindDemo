const express = require('express');
const { agentAuth } = require('../middleware/agentAuth');
const agentController = require('../controllers/agentController');

// ---------------------------------------------------------------------------
// Agent-facing endpoints. These deliberately sit OUTSIDE the admin/CSRF chain:
// agents authenticate with a bearer token, not a browser session.
// ---------------------------------------------------------------------------

const router = express.Router();

router.use(agentAuth);
router.post('/register', agentController.register);
router.post('/heartbeat', agentController.heartbeat);
router.post('/events', agentController.events);
router.post('/logs', agentController.logs);
router.post('/image/status', agentController.imageStatus);

module.exports = router;
