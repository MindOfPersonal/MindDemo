const express = require('express');
const { apiLimiter } = require('../middleware/rateLimit');
const demoController = require('../controllers/demoController');

const router = express.Router({ mergeParams: true });

router.get('/:slug', demoController.getLanding);
router.post('/:slug/start', apiLimiter(), demoController.publicStartDemo);
router.post('/:slug/stop', apiLimiter(), demoController.publicStopDemo);
router.post('/:slug/reset', apiLimiter(), demoController.publicResetDemo);

module.exports = router;
