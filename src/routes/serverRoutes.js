const express = require('express');
const { authRequired } = require('../middleware/auth');
const serverController = require('../controllers/serverController');

const router = express.Router();

router.use(authRequired);
router.get('/', serverController.list);
router.post('/', serverController.create);
router.get('/:id', serverController.get);
router.put('/:id', serverController.update);
router.delete('/:id', serverController.remove);
router.post('/:id/test', serverController.test);
router.get('/:id/metrics', serverController.metrics);
router.get('/:id/logs', serverController.logs);
router.get('/:id/install-script', serverController.installScript);

module.exports = router;
