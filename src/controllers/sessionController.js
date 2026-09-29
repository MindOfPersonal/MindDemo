const http = require('http');
const crypto = require('crypto');
const Demo = require('../models/Demo');
const DemoSession = require('../models/DemoSession');
const DemoEnvironment = require('../models/DemoEnvironment');
const DemoLog = require('../models/DemoLog');
const dockerService = require('../services/dockerService');
const runtime = require('../services/runtime');
const discordEvents = require('../services/discordEvents');
const logger = require('../utils/logger');
const config = require('../config');

const httpTimeout = (url, ms = 2000) => new Promise((resolve) => {
  const req = http.get(url, (res) => { res.resume(); resolve(true); });
  req.on('error', () => resolve(false));
  req.setTimeout(ms, () => { try { req.destroy(); } catch (e) {} resolve(false); });
});

async function logStep(demoId, sessionId, message, level = 'info') {
  try {
    await DemoLog.add({ demo_id: demoId, session_id: sessionId, level, message });
  } catch (err) {
    logger.debug('Failed to log step:', err.message);
  }
}

// Admin console polling must not count as visitor activity, otherwise an admin
// viewing a demo would keep the inactivity timer alive indefinitely. Only
// unauthenticated (visitor) requests extend the session.
function isAdminRequest(req) {
  return !!(req.session && req.session.adminId);
}

async function setupContainer(sessionId, demo) {
  await logStep(demo.id, sessionId, 'Demo session created');
  await logStep(demo.id, sessionId, 'Setting up demo environment...');
  await logStep(demo.id, sessionId, 'Loading environment variables...');

  const envVars = await DemoEnvironment.getEnvVarsForContainer(demo.id);
  await logStep(demo.id, sessionId, 'Environment variables loaded');

  // Remote demo: build locally, push the image, and let the agent create the
  // container. The agent owns the container/port mapping for this session.
  if (demo.server_id) {
    await logStep(demo.id, sessionId, 'Building demo image (install/build)...');
    await runtime.ensureImage(demo);
    await logStep(demo.id, sessionId, 'Demo image ready');
    await logStep(demo.id, sessionId, 'Starting container on remote agent...');
    const started = await runtime.startContainer({ demo, envVars, createdBy: 'session' });
    await DemoSession.updateContainerInfo(sessionId, {
      container_id: started.containerId,
      container_port: started.containerPort
    });
    await logStep(demo.id, sessionId, `Container started on agent (ID: ${String(started.containerId).substring(0, 12)}, port: ${started.containerPort})`);
    discordEvents.sessionCreated(demo, { id: sessionId }, { containerId: started.containerId, containerPort: started.containerPort });
    return { containerId: started.containerId, containerPort: started.containerPort };
  }

  // Build (or reuse) the Docker image once per demo. This runs the project's
  // install/build commands, which previously were written into an unused
  // Dockerfile and never executed.
  await logStep(demo.id, sessionId, 'Building demo image (install/build)...');
  const image = await dockerService.ensureImage(demo);
  await logStep(demo.id, sessionId, 'Demo image ready');

  let lastErr;
  let container;
  let containerPort;
  for (let attempt = 0; attempt < 5; attempt++) {
    containerPort = await dockerService.getFreePort();
    try {
      await logStep(demo.id, sessionId, `Allocating port ${containerPort} (attempt ${attempt + 1}/5)`);
      await logStep(demo.id, sessionId, 'Creating Docker container...');
      container = await dockerService.createContainer({
        demoId: demo.id,
        port: containerPort,
        startCommand: demo.start_command,
        image,
        envVars: {
          ...envVars,
          PORT: String(containerPort),
          DEMO_MODE: 'true'
        },
        memoryLimit: demo.memory_limit,
        cpuLimit: demo.cpu_limit
      });
      break;
    } catch (e) {
      lastErr = e;
      await logStep(demo.id, sessionId, `Container creation attempt ${attempt + 1}/5 failed: ${e.message}`, 'warn');
      logger.warn(`createContainer attempt ${attempt + 1}/5 on port ${containerPort} failed: ${e.message}`);
      if (container && container.id) {
        try { await dockerService.removeContainer(container.id); } catch (_) {}
      }
      container = undefined;
      await new Promise(r => setTimeout(r, 300));
    }
  }
  if (!container) throw lastErr || new Error('Failed to start container after retries');

  await DemoSession.updateContainerInfo(sessionId, {
    container_id: container.id,
    container_port: containerPort
  });
  await logStep(demo.id, sessionId, `Container started (ID: ${container.id.substring(0, 12)}, port: ${containerPort})`);
  await logStep(demo.id, sessionId, 'Waiting for application to be ready...');

  discordEvents.sessionCreated(demo, { id: sessionId }, { containerId: container.id, containerPort });

  return { containerId: container.id, containerPort };
}

// Serialize session creation per demo so concurrent requests cannot spin up
// more containers than the demo's max_sessions allows.
const demoLocks = new Map();
async function withDemoLock(demoId, fn) {
  while (demoLocks.has(demoId)) {
    await new Promise((r) => setTimeout(r, 50));
  }
  demoLocks.set(demoId, true);
  try {
    return await fn();
  } finally {
    demoLocks.delete(demoId);
  }
}

async function assertSessionCapacity(demo) {
  const active = await DemoSession.findActiveByDemoId(demo.id);
  const max = demo.max_sessions || config.DEMO_MAX_SESSIONS;
  if (active.length >= max) {
    throw new Error(`Maximum number of concurrent sessions (${max}) reached`);
  }
}

async function doCreateSession(demoId, visitorToken) {
  let sessionId = null;

  try {
    const demo = await Demo.findById(demoId);
    if (!demo) {
      throw new Error('Demo not found');
    }

    await assertSessionCapacity(demo);

    const sessionToken = crypto.randomBytes(16).toString('hex');

    sessionId = await DemoSession.create({
      demo_id: demo.id,
      session_token: sessionToken,
      container_id: null,
      container_port: null,
      server_id: demo.server_id || null
    });

    const { containerId, containerPort } = await setupContainer(sessionId, demo);

    logger.info(`Session created: ${sessionToken} for demo ${demo.slug}`);

    return {
      sessionId,
      sessionToken,
      containerId,
      containerPort,
      demo
    };
  } catch (err) {
    if (sessionId) {
      await DemoSession.end(sessionId);
    }
    await logStep(null, null, `Failed to create demo session: ${err.message}`, 'error');
    logger.error('Create session error:', err);
    discordEvents.sessionFailed(null, err);
    throw err;
  }
}

function createSession(demoId, visitorToken) {
  return withDemoLock(demoId, () => doCreateSession(demoId, visitorToken));
}

async function prepareSession(demoId) {
  return withDemoLock(demoId, async () => {
    const demo = await Demo.findById(demoId);
    if (!demo) {
      throw new Error('Demo not found');
    }

    await assertSessionCapacity(demo);

    const sessionToken = crypto.randomBytes(16).toString('hex');
    const sessionId = await DemoSession.create({
      demo_id: demo.id,
      session_token: sessionToken,
      container_id: null,
      container_port: null,
      server_id: demo.server_id || null
    });

    void (async () => {
      try {
        await logStep(demo.id, sessionId, 'Setting up demo environment...');
        await setupContainer(sessionId, demo);
      } catch (err) {
        await logStep(demo.id, sessionId, `Failed to start container: ${err.message}`, 'error');
        logger.error('Background container setup failed:', err.message);
        discordEvents.sessionFailed(demo, err);
        // Mark the failed session as stopped so it is not reused by a later
        // start attempt (which would otherwise poll a session that never gets
        // a container and spin forever).
        try { await DemoSession.end(sessionId); } catch (_) {}
      }
    })();

    logger.info(`Session prepared (async): ${sessionToken} for demo ${demo.slug}`);

    return { sessionId, sessionToken, demo };
  });
}

async function heartbeat(req, res) {
  try {
    const { session_token } = req.body;
    
    if (!session_token) {
      return res.status(400).json({ error: 'Session token required' });
    }

    const session = await DemoSession.findByToken(session_token);
    
    if (!session) {
      return res.status(404).json({ error: 'Session not found' });
    }

    if (session.status === 'stopped') {
      return res.json({ message: 'Session ended', ended: true });
    }

    if (!isAdminRequest(req)) {
      await DemoSession.updateActivity(session.id);
    }
    
    res.json({ 
      message: 'Heartbeat received', 
      status: session.status,
      container_port: session.container_port
    });
  } catch (err) {
    logger.error('Heartbeat error:', err);
    res.status(500).json({ error: 'Internal server error' });
  }
}

async function endSession(req, res) {
  try {
    const { session_token } = req.body;
    
    if (!session_token) {
      return res.status(400).json({ error: 'Session token required' });
    }

    const session = await DemoSession.findByToken(session_token);
    
    if (!session) {
      return res.status(404).json({ error: 'Session not found' });
    }

    await DemoSession.end(session.id);
    await runtime.removeContainer(session);

    // Clear the demo cookie and, when this was the last active session, mark
    // the demo as stopped so the landing/admin UI offer "Start" again.
    const demo = await Demo.findById(session.demo_id);
    if (demo) {
      res.clearCookie(`demo_session_${demo.slug}`);
      const remaining = await DemoSession.findActiveByDemoId(demo.id);
      if (remaining.length === 0) {
        await Demo.updateStatus(demo.id, 'stopped');
      }
    }

    logger.info(`Session ended: ${session_token}`);
    if (demo) {
      discordEvents.sessionEnded(demo, session, isAdminRequest(req) ? 'beëindigd door admin' : 'beëindigd door bezoeker');
    }
    
    res.json({ message: 'Session ended' });
  } catch (err) {
    logger.error('End session error:', err);
    res.status(500).json({ error: 'Internal server error' });
  }
}

async function getSession(req, res) {
  try {
    const { session_token } = req.params;
    
    const session = await DemoSession.findByToken(session_token);
    
    if (!session) {
      return res.status(404).json({ error: 'Session not found' });
    }

    const demo = await Demo.findById(session.demo_id);
    
    res.json({
      session,
      demo: {
        name: demo.name,
        slug: demo.slug,
        description: demo.description,
        timeout_minutes: demo.timeout_minutes,
        container_port: session.container_port
      }
    });
  } catch (err) {
    logger.error('Get session error:', err);
    res.status(500).json({ error: 'Internal server error' });
  }
}

async function getContainerLogs(req, res) {
  try {
    const session = await DemoSession.findByToken(req.params.session_token);
    if (!session) {
      return res.status(404).json({ error: 'Session not found' });
    }

    if (session.status !== 'stopped' && !isAdminRequest(req)) {
      await DemoSession.updateActivity(session.id);
    }

    if (!session.container_id) {
      return res.json({ logs: '', ready: false });
    }

    const isRunning = await runtime.isContainerRunning(session);
    if (!isRunning) {
      return res.json({ logs: '', ready: false, containerStopped: true });
    }

    const logs = await runtime.getContainerLogs(session);
    res.json({ logs, ready: true });
  } catch (err) {
    logger.error('Get container logs error:', err);
    res.status(500).json({ error: 'Internal server error' });
  }
}

async function getSessionLogs(req, res) {
  try {
    const session = await DemoSession.findByToken(req.params.session_token);
    if (!session) {
      return res.status(404).json({ error: 'Session not found' });
    }

    if (session.status !== 'stopped' && !isAdminRequest(req)) {
      await DemoSession.updateActivity(session.id);
    }

    const logs = await DemoLog.getBySessionId(session.id, 500);
    res.json(logs);
  } catch (err) {
    logger.error('Get session logs error:', err);
    res.status(500).json({ error: 'Internal server error' });
  }
}

async function checkSessionHealth(req, res) {
  try {
    const session = await DemoSession.findByToken(req.params.session_token);
    if (!session) {
      return res.status(404).json({ error: 'Session not found' });
    }

    // Polling from an open visitor landing page keeps the session alive; when
    // the page is closed the polls stop and the cleanup worker reaps it
    // shortly. Admin console polling is excluded from the inactivity timer.
    if (session.status !== 'stopped' && !isAdminRequest(req)) {
      await DemoSession.updateActivity(session.id);
    }

    if (!session.container_id || !session.container_port) {
      return res.json({ healthy: false, ready: false, status: session.status });
    }

    const isRunning = await runtime.isContainerRunning(session);
    if (!isRunning) {
      return res.json({ healthy: false, ready: false, status: session.status, containerStopped: true });
    }

    // Remote containers are considered healthy once the agent confirms the
    // mapping; a direct HTTP probe would add an extra network hop.
    const healthy = session.server_id
      ? true
      : await httpTimeout(`http://127.0.0.1:${session.container_port}`, 3000);

    if (healthy) {
      const recentLogs = await DemoLog.getBySessionId(session.id, 20);
      const alreadyReady = recentLogs.some(l => l.message.includes('Application is ready'));
      if (!alreadyReady) {
        await DemoLog.add({
          demo_id: session.demo_id,
          session_id: session.id,
          level: 'info',
          message: 'Application is ready!'
        });
      }
    }

    res.json({ healthy, ready: healthy, status: session.status });
  } catch (err) {
    logger.error('Health check error:', err);
    res.status(500).json({ error: 'Internal server error', healthy: false });
  }
}

module.exports = {
  createSession,
  prepareSession,
  setupContainer,
  heartbeat,
  endSession,
  getSession,
  getContainerLogs,
  getSessionLogs,
  checkSessionHealth
};
