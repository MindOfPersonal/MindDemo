const DemoSession = require('../models/DemoSession');
const DemoLog = require('../models/DemoLog');
const dockerService = require('./dockerService');
const logger = require('../utils/logger');

let workerInterval = null;

async function cleanupCycle() {
  try {
    logger.debug('Running cleanup cycle');

    const expiredSessions = await DemoSession.findExpiredSessions();

    for (const session of expiredSessions) {
      try {
        await DemoSession.updateStatus(session.id, 'inactive');
        
        await DemoLog.add({
          demo_id: session.demo_id,
          level: 'info',
          message: `Session ${session.session_token} expired and is being cleaned up`
        });

        if (session.container_id) {
          await dockerService.removeContainer(session.container_id);
        }

        await DemoSession.delete(session.id);
        
        logger.info(`Cleaned up expired session: ${session.session_token}`);
      } catch (err) {
        logger.error(`Error cleaning up session ${session.id}:`, err.message);
      }
    }

    if (expiredSessions.length > 0) {
      logger.info(`Cleaned up ${expiredSessions.length} expired sessions`);
    }
  } catch (err) {
    logger.error('Cleanup cycle error:', err.message);
  }
}

function startWorker(intervalMs = 30000) {
  if (workerInterval) {
    clearInterval(workerInterval);
  }
  
  workerInterval = setInterval(cleanupCycle, intervalMs);
  logger.info(`Cleanup worker started (interval: ${intervalMs / 1000}s)`);
  
  process.on('SIGTERM', () => {
    if (workerInterval) {
      clearInterval(workerInterval);
      logger.info('Cleanup worker stopped');
    }
  });
}

function stopWorker() {
  if (workerInterval) {
    clearInterval(workerInterval);
    workerInterval = null;
    logger.info('Cleanup worker stopped');
  }
}

module.exports = {
  cleanupCycle,
  startWorker,
  stopWorker
};