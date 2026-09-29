const Server = require('../models/Server');
const ServerMetric = require('../models/ServerMetric');
const AgentCommand = require('../models/AgentCommand');
const logger = require('../utils/logger');

// ---------------------------------------------------------------------------
// HTTP fallback endpoints for agents (used when the WebSocket is unavailable).
// Authentication is done by the agentAuth middleware (bearer token).
// ---------------------------------------------------------------------------

async function register(req, res) {
  const server = req.agentServer;
  const body = req.body || {};
  await Server.updateAgentInfo(server.id, {
    status: 'online',
    agent_version: body.agent_version,
    docker_version: body.docker && body.docker.version
  });
  res.json({ ok: true, server_id: server.id });
}

async function heartbeat(req, res) {
  const server = req.agentServer;
  const body = req.body || {};
  await Server.updateAgentInfo(server.id, {
    status: body.status || 'online',
    agent_version: body.agent_version,
    docker_version: body.docker && body.docker.version
  });
  if (body.resources) {
    await ServerMetric.record(server.id, {
      ...body.resources,
      running_demos: body.demos && body.demos.running,
      free_slots: body.demos && body.demos.free_slots
    });
  }
  res.json({ ok: true });
}

async function events(req, res) {
  const body = req.body || {};
  if (body.command_id) {
    if (body.event === 'demo.failed' || body.code) {
      await AgentCommand.markFailed(body.command_id, body.code, body.message, body).catch(() => {});
    } else {
      await AgentCommand.markDone(body.command_id, body).catch(() => {});
    }
  }
  logger.debug(`Agent event from server ${req.agentServer.id}: ${body.event || body.type}`);
  res.json({ ok: true });
}

async function logs(req, res) {
  const body = req.body || {};
  logger.info(`agent[${req.agentServer.id}] ${body.message || body.line || ''}`);
  res.json({ ok: true });
}

async function imageStatus(req, res) {
  res.json({ ok: true });
}

module.exports = { register, heartbeat, events, logs, imageStatus };
