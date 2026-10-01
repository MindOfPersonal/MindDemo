const http = require('http');
const https = require('https');
const zlib = require('zlib');
const { URL } = require('url');
const { hub } = require('./agentHub');
const DemoEnvironment = require('../models/DemoEnvironment');
const dockerService = require('./dockerService');
const logger = require('../utils/logger');

// ---------------------------------------------------------------------------
// MindDemo -> Agent helpers (control plane side).
// ---------------------------------------------------------------------------

function parseMemoryMb(mem) {
  if (typeof mem === 'number') return mem;
  if (typeof mem === 'string') {
    const match = mem.match(/(\d+(?:\.\d+)?)\s*([kmg]?)/i);
    if (match) {
      const num = parseFloat(match[1]);
      const unit = match[2].toLowerCase();
      if (unit === 'g') return Math.round(num * 1024);
      if (unit === 'k') return Math.round(num / 1024);
      return Math.round(num);
    }
  }
  return 512;
}

function parseCpu(cpu) {
  if (typeof cpu === 'number') return cpu;
  if (typeof cpu === 'string') {
    const match = cpu.match(/(\d+(?:\.\d+)?)/);
    if (match) return parseFloat(match[1]);
  }
  return 1;
}

function imageTagFor(demoId) {
  return `minddemo-demo-${demoId}:latest`;
}

async function buildDemoPayload(demo, { envVars } = {}) {
  const env = envVars || await DemoEnvironment.getEnvVarsForContainer(demo.id);
  return {
    demo_id: demo.id,
    slug: demo.slug,
    image: imageTagFor(demo.id),
    image_source: 'push',
    start_command: demo.start_command,
    env,
    limits: {
      memory_mb: parseMemoryMb(demo.memory_limit),
      cpu_cores: parseCpu(demo.cpu_limit),
      pids: 100
    }
  };
}

// Stream `docker save` through gzip to the agent's image push endpoint.
function pushImage(server, demo) {
  return new Promise(async (resolve, reject) => {
    const pushToken = hub.getPushToken(server.id);
    if (!pushToken) {
      return reject(Object.assign(new Error('No push token for agent'), { code: 'AGENT_OFFLINE' }));
    }
    if (!server.server_url) {
      return reject(new Error('Agent server has no Server URL configured. Open the server page and set the URL where the agent is reachable (e.g. http://<server-ip>:3060).'));
    }

    let imageStream;
    try {
      await dockerService.ensureImage(demo);
      imageStream = await dockerService.getImageStream(imageTagFor(demo.id));
    } catch (err) {
      return reject(Object.assign(new Error(`Could not read local image: ${err.message}`), { code: 'IMAGE_PUSH_FAILED' }));
    }

    const url = new URL(`${server.server_url.replace(/\/$/, '')}/internal/image/push`);
    const transport = url.protocol === 'https:' ? https : http;
    const req = transport.request({
      method: 'POST',
      hostname: url.hostname,
      port: url.port || (url.protocol === 'https:' ? 443 : 80),
      path: url.pathname,
      headers: {
        'Content-Type': 'application/gzip',
        Authorization: `Bearer ${pushToken}`,
        'X-Demo-Id': String(demo.id),
        'X-Image-Tag': imageTagFor(demo.id)
      }
    }, (res) => {
      let body = '';
      res.on('data', (c) => { body += c; });
      res.on('end', () => {
        if (res.statusCode >= 200 && res.statusCode < 300) {
          resolve({ ok: true });
        } else {
          reject(Object.assign(new Error(`Agent rejected image push (HTTP ${res.statusCode})`), { code: 'IMAGE_PUSH_FAILED' }));
        }
      });
    });

    req.on('error', (err) => reject(Object.assign(new Error(err.message), { code: 'IMAGE_PUSH_FAILED' })));

    const gzip = zlib.createGzip();
    imageStream.on('error', (err) => req.destroy(err));
    gzip.on('error', (err) => req.destroy(err));
    imageStream.pipe(gzip).pipe(req);
    logger.info(`Pushing image ${imageTagFor(demo.id)} to server ${server.name}`);
  });
}

async function startDemo(server, demo, opts = {}) {
  const payload = {
    demo: await buildDemoPayload(demo, opts),
    session_id: opts.sessionId || null
  };
  return hub.sendCommand(server.id, 'demo.start', payload, { timeoutMs: 150000, createdBy: opts.createdBy });
}

// Ask the agent whether it already holds the exact image we built. Returns
// false on any failure (e.g. an older agent without the command), so the
// caller falls back to pushing the image.
async function imagePresent(server, demo, imageId) {
  const result = await hub.sendCommand(server.id, 'image.exists', {
    image: imageTagFor(demo.id),
    image_id: imageId || null
  }, { timeoutMs: 20000 });
  return !!(result && result.present);
}

async function stopDemo(server, demo, opts = {}) {
  return hub.sendCommand(server.id, 'demo.stop', { demo: { demo_id: demo.id, slug: demo.slug } }, { timeoutMs: 30000, createdBy: opts.createdBy });
}

async function restartDemo(server, demo, opts = {}) {
  const payload = { demo: await buildDemoPayload(demo, opts) };
  return hub.sendCommand(server.id, 'demo.restart', payload, { timeoutMs: 150000, createdBy: opts.createdBy });
}

async function deleteDemo(server, demo, opts = {}) {
  return hub.sendCommand(server.id, 'demo.delete', { demo: { demo_id: demo.id, slug: demo.slug } }, { timeoutMs: 30000, createdBy: opts.createdBy });
}

async function demoLogs(server, demo, tail = 500) {
  return hub.sendCommand(server.id, 'demo.logs', { demo: { demo_id: demo.id, slug: demo.slug }, tail }, { timeoutMs: 20000 });
}

module.exports = { buildDemoPayload, pushImage, startDemo, imagePresent, stopDemo, restartDemo, deleteDemo, demoLogs, imageTagFor, parseMemoryMb, parseCpu };
