const express = require('express');
const { apiLimiter } = require('../middleware/rateLimit');
const { originGuard } = require('../middleware/csrf');
const demoController = require('../controllers/demoController');

const router = express.Router({ mergeParams: true });

router.get('/:slug', demoController.getLanding);
router.post('/:slug/start', apiLimiter(), originGuard, demoController.publicStartDemo);
router.post('/:slug/stop', apiLimiter(), originGuard, demoController.publicStopDemo);
router.post('/:slug/reset', apiLimiter(), originGuard, demoController.publicResetDemo);

module.exports = router;
