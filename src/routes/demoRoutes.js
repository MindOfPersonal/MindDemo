const express = require('express');
const { authRequired } = require('../middleware/auth');
const demoController = require('../controllers/demoController');

const router = express.Router();

router.get('/', authRequired, demoController.getDemos);
router.get('/logs', authRequired, demoController.getSystemLogs);
router.get('/:id', authRequired, demoController.getDemo);
router.post('/', authRequired, demoController.upload.single('project'), demoController.createDemo);
router.put('/:id', authRequired, demoController.updateDemo);
router.delete('/:id', authRequired, demoController.deleteDemo);
router.post('/:id/delete', authRequired, demoController.deleteDemo);

router.post('/:id/start', authRequired, demoController.startDemo);
router.post('/:id/stop', authRequired, demoController.stopDemo);
router.post('/:id/restart', authRequired, demoController.restartDemo);
router.post('/:id/reset', authRequired, demoController.resetDemo);

router.get('/:id/logs', authRequired, demoController.getLogs);
router.delete('/:id/logs', authRequired, demoController.clearLogs);
router.get('/:id/sessions', authRequired, demoController.getSessions);
router.get('/:id/stats', authRequired, demoController.getDemoStats);
router.post('/:id/sessions/:sessionId/end', authRequired, demoController.endDemoSession);
router.post('/:id/duplicate', authRequired, demoController.duplicateDemo);

module.exports = router;
