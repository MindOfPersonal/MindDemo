const path = require('path');
const fs = require('fs');
const multer = require('multer');
const { extractZip, validateZip } = require('../utils/zipHandler');
const { generateUniqueSlug, generateSlug } = require('../utils/helpers');
const Demo = require('../models/Demo');
const DemoLog = require('../models/DemoLog');
const DemoSession = require('../models/DemoSession');
const DemoEnvironment = require('../models/DemoEnvironment');
const dockerService = require('../services/dockerService');
const runtime = require('../services/runtime');
const discordEvents = require('../services/discordEvents');
const Server = require('../models/Server');
const { prepareSession } = require('../controllers/sessionController');
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

function isSensitiveEnvKey(key) {
  const lower = key.toLowerCase();
  return ['password', 'secret', 'token', 'apikey', 'api_key', 'credential', 'private_key'].some(p => lower.includes(p));
}

// Normalize the optional server selection from a form. Empty means "run
// locally" (null). A non-empty value must reference an existing agent server.
async function resolveServerId(raw) {
  if (raw === undefined || raw === null) return undefined;
  const value = String(raw).trim();
  if (value === '' || value === '0' || value === 'local') return null;
  const id = Number(value);
  if (!Number.isInteger(id) || id <= 0) {
    const err = new Error('Invalid server selected');
    err.status = 400;
    throw err;
  }
  const server = await Server.findById(id);
  if (!server) {
    const err = new Error('Selected server does not exist');
    err.status = 400;
    throw err;
  }
  return id;
}

// A session that is still being created (no container yet) may be reused, but
// only briefly: if it is older than 2 minutes it is stuck and must not be
// handed out again (otherwise the console polls it forever).
function isReusableInProgressSession(session) {
  if (session.container_id) return false;
  const started = session.started_at ? new Date(session.started_at).getTime() : 0;
  return Date.now() - started < 120000;
}

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
            show_credentials, banner_enabled, landing_page, server_id } = req.body;

    let projectPath = '';
    let baselinePath = '';

    if (!req.file) {
      return res.status(400).json({ error: 'ZIP file is required' });
    }

    const serverId = await resolveServerId(server_id);

    const requestedSlug = slug && String(slug).trim() ? generateSlug(String(slug)) : '';
    const slugValue = requestedSlug || generateUniqueSlug(name);

    const projectDir = path.join(config.PROJECTS_PATH, slugValue);
    const baselineDir = path.join(config.BASELINES_PATH, slugValue);

    await validateZip(req.file.path);
    await extractZip(req.file.path, projectDir, logger);
    await extractZip(req.file.path, baselineDir, logger);

    projectPath = projectDir;
    baselinePath = baselineDir;

    fs.unlinkSync(req.file.path);

    const demo = await Demo.create({
      name,
      slug: slugValue,
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
      landing_page,
      server_id: serverId
    });

    if (env_vars) {
      // env_vars can arrive as an object OR as a textarea string
      // ("KEY=value\nKEY2=value2") from the admin create form / import script.
      // Parse it either way and persist each var to demo_environment so the
      // container actually receives them (getEnvVarsForContainer reads this
      // table, not the demos.env_vars JSON column).
      const envText = typeof env_vars === 'string'
        ? env_vars
        : (typeof env_vars === 'object' && env_vars !== null
            ? Object.entries(env_vars).map(([k, v]) => `${k}=${v}`).join('\n')
            : '');
      for (const rawLine of envText.split('\n')) {
        const line = rawLine.trim();
        if (!line || line.startsWith('#')) continue;
        const match = line.match(/^([A-Za-z_][A-Za-z0-9_]*)\s*[=:]\s*(.*)$/);
        if (!match) continue;
        let value = match[2].trim();
        if ((value.startsWith('"') && value.endsWith('"')) ||
            (value.startsWith("'") && value.endsWith("'"))) {
          value = value.slice(1, -1);
        }
        const isSecret = isSensitiveEnvKey(match[1]);
        await DemoEnvironment.set(demo.id, match[1], value, isSecret);
      }
    }

    // Pre-build the image so the first visitor does not have to wait for
    // npm install/build. Best-effort: creation still succeeds without Docker.
    try {
      await dockerService.buildImage({
        demoId: demo.id,
        projectPath,
        installCommand: install_command,
        buildCommand: build_command
      });
    } catch (buildErr) {
      logger.warn(`Initial image build failed for demo ${demo.id}: ${buildErr.message}`);
      await DemoLog.add({
        demo_id: demo.id,
        level: 'warn',
        message: `Initial image build failed: ${buildErr.message}`
      });
    }

    discordEvents.demoCreated(req, demo);

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
    res.status(err.status || 500).json({ error: err.message || 'Failed to create demo' });
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
            show_credentials, banner_enabled, landing_page, server_id } = req.body;

    const nextServerId = await resolveServerId(server_id);
    const serverChanged = nextServerId !== undefined &&
      String(nextServerId || '') !== String(demo.server_id || '');

    // Moving a demo between hosts invalidates its running containers/sessions:
    // stop them on the old host before switching.
    if (serverChanged) {
      try {
        await runtime.stopAllForDemo(demo);
      } catch (stopErr) {
        logger.warn(`Failed to stop demo ${demo.id} on old server: ${stopErr.message}`);
      }
      await DemoSession.endAllForDemo(demo.id);
    }

    await Demo.update(demo.id, {
      name, slug, description, start_command, install_command, build_command,
      timeout_minutes, demo_username, demo_email, demo_password,
      show_credentials, banner_enabled: banner_enabled ? 1 : 0, 
      landing_page: landing_page ? 1 : 0,
      server_id: nextServerId
    });

    // Replace the demo's environment variables. They may arrive as an array of
    // { key, value, is_secret } (from the edit form), as an object, or as a
    // "KEY=value" string. We normalize, wipe the old set, then upsert the new.
    let envList = [];
    if (Array.isArray(env_vars)) {
      envList = env_vars;
    } else if (env_vars && typeof env_vars === 'object') {
      envList = Object.entries(env_vars).map(([k, v]) => ({ key: k, value: v, is_secret: isSensitiveEnvKey(k) }));
    } else if (typeof env_vars === 'string') {
      for (const line of env_vars.split('\n')) {
        const trimmed = line.trim();
        if (!trimmed || trimmed.startsWith('#')) continue;
        const match = trimmed.match(/^([A-Za-z_][A-Za-z0-9_]*)\s*[=:]\s*(.*)$/);
        if (!match) continue;
        let value = match[2].trim();
        if ((value.startsWith('"') && value.endsWith('"')) ||
            (value.startsWith("'") && value.endsWith("'"))) {
          value = value.slice(1, -1);
        }
        envList.push({ key: match[1], value, is_secret: isSensitiveEnvKey(match[1]) });
      }
    }

    await DemoEnvironment.clear(demo.id);
    for (const v of envList) {
      if (v.key) await DemoEnvironment.set(demo.id, v.key, v.value || '', v.is_secret);
    }

    // A change to the install/build commands invalidates the existing image.
    // Rebuild it and destroy running containers so they pick up the new one.
    const commandsChanged =
      (install_command || '') !== (demo.install_command || '') ||
      (build_command || '') !== (demo.build_command || '');

    if (commandsChanged) {
      await dockerService.stopAllDemoContainers(demo.id);
      await DemoSession.endAllForDemo(demo.id);
      try {
        await dockerService.buildImage({
          demoId: demo.id,
          projectPath: demo.project_path,
          installCommand: install_command,
          buildCommand: build_command
        });
      } catch (buildErr) {
        logger.warn(`Image rebuild failed for demo ${demo.id}: ${buildErr.message}`);
      }
    }

    const changed = [];
    if (name !== undefined && name !== demo.name) changed.push('naam');
    if (description !== undefined && description !== demo.description) changed.push('beschrijving');
    if (start_command !== undefined && start_command !== demo.start_command) changed.push('start commando');
    if (install_command !== undefined && install_command !== demo.install_command) changed.push('install commando');
    if (build_command !== undefined && build_command !== demo.build_command) changed.push('build commando');
    if (timeout_minutes !== undefined && String(timeout_minutes) !== String(demo.timeout_minutes)) changed.push('timeout');
    if (envList.length) changed.push(`${envList.length} env var(s)`);
    if (commandsChanged) changed.push('image herbouwd');
    if (serverChanged) changed.push('server');
    const details = changed.length ? changed.join(', ') : 'geen veldwijzigingen';

    discordEvents.demoUpdated(req, demo, details);

    res.json({ message: 'Demo updated successfully' });
  } catch (err) {
    logger.error('Update demo error:', err);
    if (err.status) {
      return res.status(err.status).json({ error: err.message });
    }
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
    await dockerService.removeImage(demo.id);
    
    const projectPath = demo.project_path;
    const baselinePath = demo.baseline_path;

    if (fs.existsSync(projectPath)) {
      fs.rmSync(projectPath, { recursive: true, force: true });
    }
    if (fs.existsSync(baselinePath)) {
      fs.rmSync(baselinePath, { recursive: true, force: true });
    }

    await Demo.delete(demo.id);

    discordEvents.demoDeleted(req, demo);

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

    let sessionToken = null;
    let startError = null;

    const existingSessions = await DemoSession.findActiveByDemoId(demo.id);
    let reuseSession = null;
    for (const s of existingSessions) {
      if (s.container_id && await dockerService.isContainerRunning(s.container_id)) {
        reuseSession = s;
        break;
      }
    }
    if (!reuseSession) {
      reuseSession = existingSessions.find(isReusableInProgressSession) || null;
    }

    if (reuseSession) {
      sessionToken = reuseSession.session_token;
      await DemoLog.add({ demo_id: demo.id, session_id: reuseSession.id, level: 'info', message: 'Reusing existing demo session' });
    } else {
      try {
        const result = await prepareSession(demo.id);
        sessionToken = result.sessionToken;
      } catch (sessionErr) {
        logger.error('Failed to prepare session on start:', sessionErr.message);
        startError = sessionErr.message;
        await DemoLog.add({ demo_id: demo.id, level: 'error', message: `Failed to start demo container: ${sessionErr.message}` });
      }
    }

    if (sessionToken) {
      const cookieName = `demo_session_${demo.slug}`;
      res.cookie(cookieName, sessionToken, {
        maxAge: 24 * 60 * 60 * 1000,
        httpOnly: true
      });
    }

    discordEvents.demoAction(req, demo, 'start', { sessionToken, error: startError });

    res.json({
      message: sessionToken ? 'Demo started' : 'Demo status updated, container creation failed',
      status: 'running',
      sessionToken
    });
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
    await DemoSession.endAllForDemo(demo.id);
    await Demo.updateStatus(demo.id, 'stopped');
    await DemoLog.add({ demo_id: demo.id, level: 'info', message: 'Demo stopped by admin' });

    discordEvents.demoAction(req, demo, 'stop');

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
    await DemoSession.endAllForDemo(demo.id);
    await Demo.updateStatus(demo.id, 'running');
    await DemoLog.add({ demo_id: demo.id, level: 'info', message: 'Demo restarted by admin' });

    let sessionToken = null;
    let restartError = null;
    try {
      const result = await prepareSession(demo.id);
      sessionToken = result.sessionToken;
    } catch (sessionErr) {
      logger.error('Failed to prepare session on restart:', sessionErr.message);
      restartError = sessionErr.message;
      await DemoLog.add({ demo_id: demo.id, level: 'error', message: `Failed to start demo container: ${sessionErr.message}` });
    }

    if (sessionToken) {
      const cookieName = `demo_session_${demo.slug}`;
      res.cookie(cookieName, sessionToken, {
        maxAge: 24 * 60 * 60 * 1000,
        httpOnly: true
      });
    }

    discordEvents.demoAction(req, demo, 'restart', { sessionToken, error: restartError });

    res.json({ message: 'Demo restarted', status: 'running', sessionToken });
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
    await DemoSession.endAllForDemo(demo.id);
    await DemoLog.add({ demo_id: demo.id, level: 'info', message: 'Demo reset by admin - all sessions destroyed' });

    discordEvents.demoAction(req, demo, 'reset');

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

async function getDemoStats(req, res) {
  try {
    const demo = await Demo.findById(req.params.id);
    if (!demo) {
      return res.status(404).json({ error: 'Demo not found' });
    }

    const sessions = await DemoSession.findActiveByDemoId(demo.id);
    const result = [];
    for (const s of sessions) {
      let running = false;
      let stats = null;
      if (s.container_id) {
        running = await dockerService.isContainerRunning(s.container_id);
        if (running) {
          stats = await dockerService.getContainerStats(s.container_id);
        }
      }
      result.push({
        id: s.id,
        session_token: s.session_token,
        container_id: s.container_id,
        container_port: s.container_port,
        started_at: s.started_at,
        last_activity: s.last_activity,
        running,
        stats
      });
    }

    res.json({ demo_id: demo.id, sessions: result });
  } catch (err) {
    logger.error('Get demo stats error:', err);
    res.status(500).json({ error: 'Failed to fetch stats' });
  }
}

async function endDemoSession(req, res) {
  try {
    const demo = await Demo.findById(req.params.id);
    if (!demo) {
      return res.status(404).json({ error: 'Demo not found' });
    }

    const session = await DemoSession.findById(req.params.sessionId);
    if (!session || String(session.demo_id) !== String(demo.id)) {
      return res.status(404).json({ error: 'Session not found' });
    }

    await DemoSession.end(session.id);
    if (session.container_id) {
      await dockerService.removeContainer(session.container_id);
    }

    const remaining = await DemoSession.findActiveByDemoId(demo.id);
    if (remaining.length === 0) {
      await Demo.updateStatus(demo.id, 'stopped');
    }

    await DemoLog.add({
      demo_id: demo.id,
      session_id: session.id,
      level: 'info',
      message: 'Session ended by admin'
    });
    discordEvents.sessionEnded(demo, session, 'beëindigd door admin');

    res.json({ message: 'Session ended' });
  } catch (err) {
    logger.error('End demo session error:', err);
    res.status(500).json({ error: 'Failed to end session' });
  }
}

async function duplicateDemo(req, res) {
  let projectDir = '';
  let baselineDir = '';
  try {
    const demo = await Demo.findById(req.params.id);
    if (!demo) {
      return res.status(404).json({ error: 'Demo not found' });
    }

    const requested = req.body && req.body.name ? String(req.body.name).trim() : '';
    const newName = requested || `${demo.name} (copy)`;
    const newSlug = generateUniqueSlug(newName);

    projectDir = path.join(config.PROJECTS_PATH, newSlug);
    baselineDir = path.join(config.BASELINES_PATH, newSlug);

    if (demo.project_path && fs.existsSync(demo.project_path)) {
      fs.cpSync(demo.project_path, projectDir, { recursive: true });
    }
    if (demo.baseline_path && fs.existsSync(demo.baseline_path)) {
      fs.cpSync(demo.baseline_path, baselineDir, { recursive: true });
    }

    const created = await Demo.create({
      name: newName,
      slug: newSlug,
      description: demo.description,
      project_path: projectDir,
      baseline_path: baselineDir,
      start_command: demo.start_command,
      install_command: demo.install_command,
      build_command: demo.build_command,
      internal_port: demo.internal_port,
      timeout_minutes: demo.timeout_minutes,
      env_vars: demo.env_vars,
      demo_username: demo.demo_username,
      demo_email: demo.demo_email,
      demo_password: demo.demo_password,
      show_credentials: demo.show_credentials,
      banner_enabled: demo.banner_enabled,
      landing_page: demo.landing_page,
      server_id: demo.server_id
    });

    const envRows = await DemoEnvironment.getByDemoId(demo.id);
    for (const row of envRows) {
      await DemoEnvironment.set(created.id, row.key, row.value, row.is_secret);
    }

    // Best-effort pre-build so the first visitor does not wait.
    try {
      await dockerService.buildImage({
        demoId: created.id,
        projectPath: projectDir,
        installCommand: demo.install_command,
        buildCommand: demo.build_command
      });
    } catch (buildErr) {
      logger.warn(`Initial image build failed for duplicated demo ${created.id}: ${buildErr.message}`);
    }

    discordEvents.demoCreated(req, created);

    res.json({ message: 'Demo duplicated', demo: created });
  } catch (err) {
    logger.error('Duplicate demo error:', err);
    if (projectDir && fs.existsSync(projectDir)) {
      fs.rmSync(projectDir, { recursive: true, force: true });
    }
    if (baselineDir && fs.existsSync(baselineDir)) {
      fs.rmSync(baselineDir, { recursive: true, force: true });
    }
    res.status(500).json({ error: err.message || 'Failed to duplicate demo' });
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

    let sessionToken = null;
    let publicError = null;

    const existingSessions = await DemoSession.findActiveByDemoId(demo.id);
    let reuseSession = null;
    for (const s of existingSessions) {
      if (s.container_id && await dockerService.isContainerRunning(s.container_id)) {
        reuseSession = s;
        break;
      }
    }
    if (!reuseSession) {
      reuseSession = existingSessions.find(isReusableInProgressSession) || null;
    }

    if (reuseSession) {
      sessionToken = reuseSession.session_token;
      await DemoLog.add({ demo_id: demo.id, session_id: reuseSession.id, level: 'info', message: 'Reusing existing demo session' });
    } else {
      try {
        const result = await prepareSession(demo.id);
        sessionToken = result.sessionToken;
      } catch (sessionErr) {
        logger.error('Failed to prepare session on public start:', sessionErr.message);
        publicError = sessionErr.message;
        await DemoLog.add({ demo_id: demo.id, level: 'error', message: `Failed to start demo container: ${sessionErr.message}` });
      }
    }

    if (sessionToken) {
      const cookieName = `demo_session_${demo.slug}`;
      res.cookie(cookieName, sessionToken, {
        maxAge: 24 * 60 * 60 * 1000,
        httpOnly: true
      });
    }

    discordEvents.publicDemoAction(demo, 'start', req, { sessionToken, error: publicError });

    res.json({
      message: 'Demo started',
      status: 'running',
      sessionToken
    });
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
    await DemoSession.endAllForDemo(demo.id);
    await Demo.updateStatus(demo.id, 'stopped');
    await DemoLog.add({ demo_id: demo.id, level: 'info', message: 'Demo stopped by visitor' });

    discordEvents.publicDemoAction(demo, 'stop', req);

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
    await DemoSession.endAllForDemo(demo.id);
    await DemoLog.add({ demo_id: demo.id, level: 'info', message: 'Demo reset by visitor - active session destroyed' });

    discordEvents.publicDemoAction(demo, 'reset', req);

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
  getDemoStats,
  endDemoSession,
  duplicateDemo,
  getLanding,
  publicStartDemo,
  publicStopDemo,
  publicResetDemo,
  upload
};
