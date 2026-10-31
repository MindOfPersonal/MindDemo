const dockerService = require('./dockerService');
const agentClient = require('./agentClient');
const Server = require('../models/Server');
const Demo = require('../models/Demo');
const { hub } = require('./agentHub');
const logger = require('../utils/logger');

// ---------------------------------------------------------------------------
// Runtime dispatch.
// ---------------------------------------------------------------------------
// A demo with server_id set runs on an agent; otherwise it runs locally. This
// module is the single place that decides between the two, so the rest of the
// code does not need to know where a demo lives. Local remains the default and
// behaves exactly as before.
// ---------------------------------------------------------------------------

function isRemote(entity) {
  return !!(entity && entity.server_id);
}

async function loadServer(serverId) {
  const server = await Server.findById(serverId);
  if (!server) throw new Error('Agent server not found');
  return server;
}

async function ensureImage(demo) {
  if (isRemote(demo)) {
    const server = await loadServer(demo.server_id);
    // Build locally first (cached by dockerService when the image exists).
    const tag = await dockerService.ensureImage(demo);

    // Skip the transfer when the agent already holds this exact build. The
    // image id is content-addressed, so a rebuilt project still gets pushed.
    const imageId = await dockerService.getImageId(tag);
    let present = false;
    try {
      present = await agentClient.imagePresent(server, demo, imageId);
    } catch (err) {
      logger.debug(`Image presence check on ${server.name} failed: ${err.message}`);
    }
    if (present) {
      logger.info(`Image ${tag} already present on ${server.name}; skipping push`);
      return agentClient.imageTagFor(demo.id);
    }

    await agentClient.pushImage(server, demo);
    return agentClient.imageTagFor(demo.id);
  }
  return dockerService.ensureImage(demo);
}

// Start a container for a demo. Local keeps the existing dockerService path;
// remote sends a demo.start command to the agent and returns its mapping.
async function startContainer({ demo, envVars, createdBy, sessionId }) {
  if (isRemote(demo)) {
    const server = await loadServer(demo.server_id);
    const result = await agentClient.startDemo(server, demo, { envVars, createdBy, sessionId });
    return {
      remote: true,
      containerId: result.container_id,
      containerPort: result.port,
      url: result.url
    };
  }
  return { remote: false };
}

async function isContainerRunning(session) {
  if (!session) return false;
  if (session.server_id) {
    if (!hub.isConnected(session.server_id)) return false;
    const known = hub.hasDemo(session.server_id, session.demo_id);
    // Until the agent has reported its running set (first heartbeat after
    // connect), trust the container id recorded when the command completed.
    if (known === null) return !!session.container_id;
    return known;
  }
  return dockerService.isContainerRunning(session.container_id);
}

// Proxy target for visitor traffic. Local points at the host port; remote
// points at the agent's own proxy so only one agent port is needed.
async function proxyTarget(session, demo) {
  if (session && session.server_id) {
    const server = await loadServer(session.server_id);
    if (!server.server_url) {
      throw new Error('Agent server has no Server URL configured. Open the server page and set the URL where the agent is reachable (e.g. http://<server-ip>:3060).');
    }
    return `${server.server_url.replace(/\/$/, '')}/demo/${demo.slug}/live`;
  }
  return `http://127.0.0.1:${session.container_port}`;
}

async function removeContainer(session) {
  if (!session) return null;
  if (session.server_id) {
    const server = await loadServer(session.server_id);
    const demo = await Demo.findById(session.demo_id);
    if (server && demo) return agentClient.stopDemo(server, demo);
    return null;
  }
  return dockerService.removeContainer(session.container_id);
}

async function stopAllForDemo(demo) {
  if (isRemote(demo)) {
    const server = await loadServer(demo.server_id);
    return agentClient.stopDemo(server, demo);
  }
  return dockerService.stopAllDemoContainers(demo.id);
}

async function getContainerLogs(session) {
  if (session && session.server_id) {
    try {
      const server = await loadServer(session.server_id);
      const demo = await Demo.findById(session.demo_id);
      const result = await agentClient.demoLogs(server, demo);
      return result.logs || '';
    } catch (err) {
      // A stopped/reaped remote demo has no mapping; treat that as "no logs"
      // rather than surfacing an error on every console poll.
      logger.debug(`Remote container logs unavailable: ${err.message}`);
      return '';
    }
  }
  return dockerService.getContainerLogs(session.container_id);
}

async function getContainerStats(session) {
  // Remote container stats are reported through heartbeats; not available here.
  if (session && session.server_id) return null;
  return dockerService.getContainerStats(session.container_id);
}

module.exports = {
  isRemote,
  ensureImage,
  startContainer,
  isContainerRunning,
  proxyTarget,
  removeContainer,
  stopAllForDemo,
  getContainerLogs,
  getContainerStats
};
