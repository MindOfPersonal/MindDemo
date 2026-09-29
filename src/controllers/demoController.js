const path = require('path');
const fs = require('fs');
const multer = require('multer');
const { extractZip } = require('../utils/zipHandler');
const { generateUniqueSlug } = require('../utils/helpers');
const Demo = require('../models/Demo');
const DemoLog = require('../models/DemoLog');
const DemoEnvironment = require('../models/DemoEnvironment');
const dockerService = require('../services/dockerService');
const logger = require('../utils/logger');
const config = require('../config');

const upload = multer({
  dest: config.UPLOAD_PATH,
  limits: {
    fileSize: config.DEMO_MAX_UPLOAD_SIZE * 1024 * 1024
  },
  fileFilter: (req, file, cb) => {
    if (path.extname(file.originalname).toLowerCase() === '.zip') {
      cb(null, true);
    } else {
      cb(new Error('Only ZIP files are allowed'), false);
    }
  }
});

async function getDemos(req, res) {
  try {
    const demos = await Demo.findAll();
    res.json(demos);
  } catch (err) {
    logger.error('Get demos error:', err);
    res.status(500).json({ error: 'Failed to fetch demos' });
  }
}

async function getSystemLogs(req, res) {
  try {
    const logs = await DemoLog.getAll(100);
    res.json(logs);
  } catch (err) {
    logger.error('Get system logs error:', err);
    res.status(500).json({ error: 'Failed to fetch logs' });
  }
}

async function getDemo(req, res) {
  try {
    const demo = await Demo.findById(req.params.id);
    if (!demo) {
      return res.status(404).json({ error: 'Demo not found' });
    }
    const envVars = await DemoEnvironment.getByDemoId(demo.id);
    res.json({ ...demo, env_vars: envVars });
  } catch (err) {
    logger.error('Get demo error:', err);
    res.status(500).json({ error: 'Failed to fetch demo' });
  }
}

async function createDemo(req, res) {
  try {
    const { name, slug, description, start_command, install_command, build_command, 
            timeout_minutes, env_vars, demo_username, demo_email, demo_password,
            show_credentials, banner_enabled, landing_page } = req.body;

    let projectPath = '';
    let baselinePath = '';

    if (!req.file) {
      return res.status(400).json({ error: 'ZIP file is required' });
    }

    const projectDir = path.join(config.PROJECTS_PATH, generateUniqueSlug(name));
    const baselineDir = path.join(config.BASELINES_PATH, generateUniqueSlug(name));

    await extractZip(req.file.path, projectDir, logger);
    await extractZip(req.file.path, baselineDir, logger);

    projectPath = projectDir;
    baselinePath = baselineDir;

    fs.unlinkSync(req.file.path);

    const demo = await Demo.create({
      name,
      slug,
      description,
      project_path: projectPath,
      baseline_path: baselinePath,
      start_command: start_command || 'npm start',
      install_command,
      build_command,
      timeout_minutes: timeout_minutes || config.DEMO_DEFAULT_TIMEOUT,
      env_vars,
      demo_username,
      demo_email,
      demo_password,
      show_credentials,
      banner_enabled,
      landing_page
    });

    if (env_vars && typeof env_vars === 'object') {
      for (const [key, value] of Object.entries(env_vars)) {
        const isSecret = key.toLowerCase().includes('password') || 
                         key.toLowerCase().includes('secret') || 
                         key.toLowerCase().includes('key') ||
                         key.toLowerCase().includes('token');
        await DemoEnvironment.set(demo.id, key, value, isSecret);
      }
    }

    res.json({
      message: 'Demo created successfully',
      demo
    });
  } catch (err) {
    logger.error('Create demo error:', err);
    if (projectPath && fs.existsSync(projectPath)) {
      fs.rmSync(projectPath, { recursive: true, force: true });
    }
    if (baselinePath && fs.existsSync(baselinePath)) {
      fs.rmSync(baselinePath, { recursive: true, force: true });
    }
    try { fs.unlinkSync(req.file.path); } catch { /* already removed */ }
    res.status(500).json({ error: err.message || 'Failed to create demo' });
  }
}

async function updateDemo(req, res) {
  try {
    const demo = await Demo.findById(req.params.id);
    if (!demo) {
      return res.status(404).json({ error: 'Demo not found' });
    }

    const { name, slug, description, start_command, install_command, build_command,
            timeout_minutes, env_vars, demo_username, demo_email, demo_password,
            show_credentials, banner_enabled, landing_page } = req.body;

    await Demo.update(demo.id, {
      name, slug, description, start_command, install_command, build_command,
      timeout_minutes, demo_username, demo_email, demo_password,
      show_credentials, banner_enabled: banner_enabled ? 1 : 0, 
      landing_page: landing_page ? 1 : 0
    });

    res.json({ message: 'Demo updated successfully' });
  } catch (err) {
    logger.error('Update demo error:', err);
    res.status(500).json({ error: 'Failed to update demo' });
  }
}

async function deleteDemo(req, res) {
  try {
    const demo = await Demo.findById(req.params.id);
    if (!demo) {
      return res.status(404).json({ error: 'Demo not found' });
    }

    await dockerService.stopAllDemoContainers(demo.id);
    
    const projectPath = demo.project_path;
    const baselinePath = demo.baseline_path;

    if (fs.existsSync(projectPath)) {
      fs.rmSync(projectPath, { recursive: true, force: true });
    }
    if (fs.existsSync(baselinePath)) {
      fs.rmSync(baselinePath, { recursive: true, force: true });
    }

    await Demo.delete(demo.id);

    res.json({ message: 'Demo deleted successfully' });
  } catch (err) {
    logger.error('Delete demo error:', err);
    res.status(500).json({ error: 'Failed to delete demo' });
  }
}

async function startDemo(req, res) {
  try {
    const demo = await Demo.findById(req.params.id);
    if (!demo) {
      return res.status(404).json({ error: 'Demo not found' });
    }

    await Demo.updateStatus(demo.id, 'running');
    await DemoLog.add({ demo_id: demo.id, level: 'info', message: 'Demo started by admin' });

    res.json({ message: 'Demo started', status: 'running' });
  } catch (err) {
    logger.error('Start demo error:', err);
    res.status(500).json({ error: 'Failed to start demo' });
  }
}

async function stopDemo(req, res) {
  try {
    const demo = await Demo.findById(req.params.id);
    if (!demo) {
      return res.status(404).json({ error: 'Demo not found' });
    }

    await dockerService.stopAllDemoContainers(demo.id);
    await Demo.updateStatus(demo.id, 'stopped');
    await DemoLog.add({ demo_id: demo.id, level: 'info', message: 'Demo stopped by admin' });

    res.json({ message: 'Demo stopped', status: 'stopped' });
  } catch (err) {
    logger.error('Stop demo error:', err);
    res.status(500).json({ error: 'Failed to stop demo' });
  }
}

async function restartDemo(req, res) {
  try {
    const demo = await Demo.findById(req.params.id);
    if (!demo) {
      return res.status(404).json({ error: 'Demo not found' });
    }

    await dockerService.stopAllDemoContainers(demo.id);
    await Demo.updateStatus(demo.id, 'running');
    await DemoLog.add({ demo_id: demo.id, level: 'info', message: 'Demo restarted by admin' });

    res.json({ message: 'Demo restarted', status: 'running' });
  } catch (err) {
    logger.error('Restart demo error:', err);
    res.status(500).json({ error: 'Failed to restart demo' });
  }
}

async function resetDemo(req, res) {
  try {
    const demo = await Demo.findById(req.params.id);
    if (!demo) {
      return res.status(404).json({ error: 'Demo not found' });
    }

    await dockerService.stopAllDemoContainers(demo.id);
    await DemoLog.add({ demo_id: demo.id, level: 'info', message: 'Demo reset by admin - all sessions destroyed' });

    res.json({ message: 'Demo reset successfully' });
  } catch (err) {
    logger.error('Reset demo error:', err);
    res.status(500).json({ error: 'Failed to reset demo' });
  }
}

async function getLogs(req, res) {
  try {
    const logs = await DemoLog.getByDemoId(req.params.id, 1000);
    res.json(logs);
  } catch (err) {
    logger.error('Get logs error:', err);
    res.status(500).json({ error: 'Failed to fetch logs' });
  }
}

async function clearLogs(req, res) {
  try {
    await DemoLog.clear(req.params.id);
    res.json({ message: 'Logs cleared' });
  } catch (err) {
    logger.error('Clear logs error:', err);
    res.status(500).json({ error: 'Failed to clear logs' });
  }
}

async function getSessions(req, res) {
  try {
    const DemoSession = require('../models/DemoSession');
    const sessions = await DemoSession.findActiveByDemoId(req.params.id);
    res.json(sessions);
  } catch (err) {
    logger.error('Get sessions error:', err);
    res.status(500).json({ error: 'Failed to fetch sessions' });
  }
}

async function getLanding(req, res) {
  try {
    const demo = await Demo.findBySlug(req.params.slug);
    if (!demo) {
      return res.status(404).render('error', {
        title: 'Demo Not Found',
        message: 'This demo does not exist.',
        error_code: 404
      });
    }

    res.render('demo/landing', {
      title: `${demo.name} - MindDemo`,
      demo,
      csrfToken: req.session && req.session.csrfToken
    });
  } catch (err) {
    logger.error('Get landing error:', err);
    res.status(500).render('error', {
      title: 'Error',
      message: 'Internal server error',
      error_code: 500
    });
  }
}

async function publicStartDemo(req, res) {
  try {
    const demo = await Demo.findBySlug(req.params.slug);
    if (!demo) {
      return res.status(404).json({ error: 'Demo not found' });
    }

    if (demo.status !== 'running') {
      await Demo.updateStatus(demo.id, 'running');
      await DemoLog.add({ demo_id: demo.id, level: 'info', message: 'Demo started by visitor' });
    }

    res.json({ message: 'Demo started', status: 'running' });
  } catch (err) {
    logger.error('Public start error:', err);
    res.status(500).json({ error: 'Failed to start demo' });
  }
}

async function publicStopDemo(req, res) {
  try {
    const demo = await Demo.findBySlug(req.params.slug);
    if (!demo) {
      return res.status(404).json({ error: 'Demo not found' });
    }

    await dockerService.stopAllDemoContainers(demo.id);
    await Demo.updateStatus(demo.id, 'stopped');
    await DemoLog.add({ demo_id: demo.id, level: 'info', message: 'Demo stopped by visitor' });

    res.json({ message: 'Demo stopped', status: 'stopped' });
  } catch (err) {
    logger.error('Public stop error:', err);
    res.status(500).json({ error: 'Failed to stop demo' });
  }
}

async function publicResetDemo(req, res) {
  try {
    const demo = await Demo.findBySlug(req.params.slug);
    if (!demo) {
      return res.status(404).json({ error: 'Demo not found' });
    }

    await dockerService.stopAllDemoContainers(demo.id);
    await DemoLog.add({ demo_id: demo.id, level: 'info', message: 'Demo reset by visitor - active session destroyed' });

    res.json({ message: 'Demo reset', status: 'running' });
  } catch (err) {
    logger.error('Public reset error:', err);
    res.status(500).json({ error: 'Failed to reset demo' });
  }
}

module.exports = {
  getDemos,
  getSystemLogs,
  getDemo,
  createDemo,
  updateDemo,
  deleteDemo,
  startDemo,
  stopDemo,
  restartDemo,
  resetDemo,
  getLogs,
  clearLogs,
  getSessions,
  getLanding,
  publicStartDemo,
  publicStopDemo,
  publicResetDemo,
  upload
};
