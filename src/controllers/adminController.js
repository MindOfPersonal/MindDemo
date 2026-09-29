const Demo = require('../models/Demo');
const DemoLog = require('../models/DemoLog');
const DemoSession = require('../models/DemoSession');
const logger = require('../utils/logger');

async function getDashboard(req, res) {
  try {
    const demos = await Demo.findAll();
    const allLogs = await DemoLog.getAll(100);
    const totalSessions = await DemoSession.countActive();

    const totalDemos = demos.length;
    const activeDemos = demos.filter(d => d.status === 'running').length;

    let totalSize = 0;
    for (const demo of demos) {
      for (const p of [demo.project_path, demo.baseline_path]) {
        if (p && require('fs').existsSync(p)) {
          totalSize += getDirSize(p);
        }
      }
    }

    res.render('admin/dashboard', {
      title: 'Dashboard',
      username: req.session.username,
      stats: {
        totalDemos,
        runningDemos: activeDemos,
        stoppedDemos: totalDemos - activeDemos,
        totalSessions,
        storageUsed: formatBytes(totalSize)
      },
      recentDemos: demos.slice(0, 10),
      recentLogs: allLogs,
      csrfToken: res.locals.csrfToken
    });
  } catch (err) {
    logger.error('Dashboard error:', err);
    res.status(500).render('error', { title: 'Error', message: 'Failed to load dashboard' });
  }
}

function getDirSize(dirPath) {
  let size = 0;
  try {
    const fs = require('fs');
    if (fs.existsSync(dirPath)) {
      const files = fs.readdirSync(dirPath);
      for (const file of files) {
        const filePath = require('path').join(dirPath, file);
        // lstat so symlinks are never followed (prevents recursion loops).
        const stat = fs.lstatSync(filePath);
        if (stat.isSymbolicLink()) {
          continue;
        } else if (stat.isDirectory()) {
          size += getDirSize(filePath);
        } else {
          size += stat.size;
        }
      }
    }
  } catch {
  }
  return size;
}

function formatBytes(bytes) {
  if (bytes === 0) return '0 B';
  const k = 1024;
  const sizes = ['B', 'KB', 'MB', 'GB', 'TB'];
  const i = Math.floor(Math.log(bytes) / Math.log(k));
  return parseFloat((bytes / Math.pow(k, i)).toFixed(2)) + ' ' + sizes[i];
}

module.exports = { getDashboard };