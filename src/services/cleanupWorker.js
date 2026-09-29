const Demo = require('../models/Demo');
const DemoSession = require('../models/DemoSession');
const DemoLog = require('../models/DemoLog');
const dockerService = require('./dockerService');
const discordEvents = require('./discordEvents');
const logger = require('../utils/logger');
const config = require('../config');

let workerInterval = null;

async function reapSession(session, reason) {
  try {
    await DemoLog.add({
      demo_id: session.demo_id,
      session_id: session.id,
      level: 'info',
      message: `Session ${session.session_token} ${reason}`
    });

    if (session.container_id) {
      await dockerService.removeContainer(session.container_id);
    }

    // Mark as stopped and keep the row for history instead of deleting it,
    // which previously destroyed the audit trail.
    await DemoSession.end(session.id);

    logger.info(`Cleaned up session: ${session.session_token} (${reason})`);
    discordEvents.sessionReaped(session, reason);
    return true;
  } catch (err) {
    logger.error(`Error cleaning up session ${session.id}:`, err.message);
    return false;
  }
}

async function cleanupCycle() {
  try {
    logger.debug('Running cleanup cycle');

    const timeoutSessions = await DemoSession.findExpiredSessions();
    const staleSessions = await DemoSession.findStaleSessions(config.DEMO_SESSION_GRACE_SECONDS);

    // Deduplicate by id (a session can match both criteria).
    const toReap = new Map();
    for (const s of timeoutSessions) toReap.set(s.id, { session: s, reason: 'expired and is being cleaned up' });
    for (const s of staleSessions) {
      if (!toReap.has(s.id)) toReap.set(s.id, { session: s, reason: 'stopped heartbeating and is being cleaned up' });
    }

    const affectedDemos = new Set();

    for (const { session, reason } of toReap.values()) {
      const ok = await reapSession(session, reason);
      if (ok) affectedDemos.add(session.demo_id);
    }

    // If a demo no longer has any active session, reflect that in its status so
    // the landing/admin UI show "Start" again instead of a stale "running".
    for (const demoId of affectedDemos) {
      const remaining = await DemoSession.findActiveByDemoId(demoId);
      if (remaining.length === 0) {
        await Demo.updateStatus(demoId, 'stopped');
      }
    }

    if (toReap.size > 0) {
      logger.info(`Cleaned up ${toReap.size} session(s)`);
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
