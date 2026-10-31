const DemoLog = require('../models/DemoLog');
const logger = require('../utils/logger');

async function addLog(demoId, message, level = 'info', sessionId = null) {
  try {
    await DemoLog.add({ demo_id: demoId, session_id: sessionId, level, message });
  } catch (err) {
    logger.error('Failed to add log entry:', err.message);
  }
}

async function getLogs(demoId, limit = 1000) {
  try {
    return await DemoLog.getByDemoId(demoId, limit);
  } catch (err) {
    logger.error('Failed to fetch logs:', err.message);
    return [];
  }
}

async function clearLogs(demoId) {
  try {
    await DemoLog.clear(demoId);
    logger.info(`Logs cleared for demo ${demoId}`);
  } catch (err) {
    logger.error('Failed to clear logs:', err.message);
    throw err;
  }
}

async function downloadLogs(demoId) {
  try {
    const logs = await DemoLog.getByDemoId(demoId, 10000);
    return logs.map(l => `${l.created_at} [${l.level}]: ${l.message}`).join('\n');
  } catch (err) {
    logger.error('Failed to download logs:', err.message);
    throw err;
  }
}

module.exports = {
  addLog,
  getLogs,
  clearLogs,
  downloadLogs
};