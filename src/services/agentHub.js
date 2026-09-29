const crypto = require('crypto');
const { WebSocketServer } = require('ws');
const Server = require('../models/Server');
const AgentCommand = require('../models/AgentCommand');
const ServerMetric = require('../models/ServerMetric');
const { extractToken } = require('../middleware/agentAuth');
const logger = require('../utils/logger');

// ---------------------------------------------------------------------------
// AgentHub: the control-plane side of the agent connection.
// ---------------------------------------------------------------------------
// Agents connect outbound to /agent/ws with a bearer token. The hub tracks
// connections, records heartbeats/metrics, and sends commands with a
// command_id so every command is idempotent and traceable.
// ---------------------------------------------------------------------------

class AgentHub {
  constructor({ onEvent } = {}) {
    this.connections = new Map(); // serverId -> ws
    this.pushTokens = new Map();  // serverId -> ephemeral image-push token
    this.pending = new Map();     // commandId -> { resolve, reject, timer, serverId }
    this.wss = null;
    this.monitor = null;
    this.onEvent = onEvent || (() => {});
  }

  attach(server) {
    this.wss = new WebSocketServer({ noServer: true });
    server.on('upgrade', (req, socket, head) => {
      this.handleUpgrade(req, socket, head).catch(() => {
        try { socket.destroy(); } catch { /* ignore */ }
      });
    });
    return this.wss;
  }

  async handleUpgrade(req, socket, head) {
    let pathname = '';
    try {
      pathname = new URL(req.url, 'http://localhost').pathname;
    } catch {
      pathname = '';
    }
    if (pathname !== '/agent/ws') {
      socket.destroy();
      return;
    }

    const token = extractToken(req);
    const server = token ? await Server.findByTokenHash(Server.hashToken(token)) : null;
    if (!server) {
      socket.write('HTTP/1.1 401 Unauthorized\r\n\r\n');
      socket.destroy();
      return;
    }

    this.wss.handleUpgrade(req, socket, head, (ws) => this.registerConnection(server, ws));
  }

  registerConnection(server, ws) {
    const previous = this.connections.get(server.id);
    if (previous && previous !== ws) {
      try { previous.close(); } catch { /* ignore */ }
    }
    this.connections.set(server.id, ws);
    ws.isAlive = true;

    ws.on('pong', () => { ws.isAlive = true; });
    ws.on('message', (data) => this.handleMessage(server, data));
    ws.on('close', () => {
      if (this.connections.get(server.id) === ws) {
        this.connections.delete(server.id);
        this.pushTokens.delete(server.id);
        Server.updateStatus(server.id, 'offline').catch(() => {});
        this.onEvent(server, { type: 'agent.event', event: 'agent.disconnected' });
      }
    });
    ws.on('error', (err) => logger.debug(`Agent socket error (server ${server.id}): ${err.message}`));

    // Issue a fresh, in-memory image-push token over the authenticated socket.
    // Only its value lives in RAM here; the persistent token stays hashed.
    const pushToken = `push_${crypto.randomBytes(24).toString('hex')}`;
    this.pushTokens.set(server.id, pushToken);
    try {
      ws.send(JSON.stringify({ type: 'agent.config', push_token: pushToken }));
    } catch { /* ignore */ }

    Server.updateStatus(server.id, 'online').catch(() => {});
    logger.info(`Agent connected: server ${server.id} (${server.name})`);
  }

  getPushToken(serverId) {
    return this.pushTokens.get(Number(serverId)) || null;
  }

  async handleMessage(server, data) {
    let message;
    try {
      message = JSON.parse(data.toString());
    } catch {
      logger.warn(`Agent sent invalid JSON (server ${server.id})`);
      return;
    }

    try {
      switch (message.type) {
        case 'agent.register': await this.onRegister(server, message); break;
        case 'agent.heartbeat': await this.onHeartbeat(server, message); break;
        case 'agent.metrics': await this.onMetrics(server, message); break;
        case 'agent.event': await this.onAgentEvent(server, message); break;
        case 'agent.log': this.onLog(server, message); break;
        case 'agent.update_status': await this.onUpdateStatus(server, message); break;
        case 'agent.pong': break;
        default: logger.debug(`Unknown agent message type: ${message.type}`);
      }
    } catch (err) {
      logger.error(`Error handling agent message (server ${server.id}):`, err.message);
    }
  }

  async onRegister(server, message) {
    const dockerVersion = message.docker && message.docker.version;
    await Server.updateAgentInfo(server.id, {
      status: 'online',
      agent_version: message.agent_version,
      docker_version: dockerVersion
    });
    this.onEvent(server, { ...message, event: 'agent.registered' });
  }

  async onHeartbeat(server, message) {
    const docker = message.docker || {};
    await Server.updateAgentInfo(server.id, {
      status: message.status || 'online',
      agent_version: message.agent_version,
      docker_version: docker.version
    });
    if (message.resources) {
      await ServerMetric.record(server.id, {
        ...message.resources,
        running_demos: message.demos && message.demos.running,
        free_slots: message.demos && message.demos.free_slots
      });
    }
  }

  async onMetrics(server, message) {
    if (message.resources) await ServerMetric.record(server.id, message.resources);
  }

  async onUpdateStatus(server, message) {
    await Server.updateStatus(server.id, message.status === 'applying' ? 'updating' : 'online');
    this.onEvent(server, { ...message, event: 'agent.update_status' });
  }

  onLog(server, message) {
    logger.info(`agent[${server.id}] ${message.message || message.line || ''}`);
  }

  async onAgentEvent(server, message) {
    const commandId = message.command_id;
    if (commandId) {
      const pending = this.pending.get(commandId);
      if (pending) {
        clearTimeout(pending.timer);
        this.pending.delete(commandId);
        if (message.event === 'demo.failed' || message.code) {
          await AgentCommand.markFailed(commandId, message.code, message.message, message).catch(() => {});
          pending.reject(Object.assign(new Error(message.message || 'Command failed'), {
            code: message.code || 'AGENT_ERROR',
            detail: message.detail
          }));
        } else {
          await AgentCommand.markDone(commandId, message).catch(() => {});
          pending.resolve(message);
        }
      }
    }
    this.onEvent(server, message);
  }

  isConnected(serverId) {
    const ws = this.connections.get(Number(serverId));
    return !!(ws && ws.readyState === 1);
  }

  async sendCommand(serverId, type, payload, { timeoutMs = 60000, createdBy = null } = {}) {
    const id = Number(serverId);
    const ws = this.connections.get(id);
    const commandId = `cmd_${crypto.randomBytes(6).toString('hex')}`;

    await AgentCommand.create({ server_id: id, command_id: commandId, type, payload, created_by: createdBy });

    if (!ws || ws.readyState !== 1) {
      await AgentCommand.markFailed(commandId, 'AGENT_OFFLINE', 'Agent is not connected').catch(() => {});
      throw Object.assign(new Error('Agent is not connected'), { code: 'AGENT_OFFLINE' });
    }

    const promise = new Promise((resolve, reject) => {
      const timer = setTimeout(async () => {
        this.pending.delete(commandId);
        await AgentCommand.markTimeout(commandId).catch(() => {});
        reject(Object.assign(new Error('Agent command timed out'), { code: 'TIMEOUT' }));
      }, timeoutMs);
      this.pending.set(commandId, { resolve, reject, timer, serverId: id });
    });

    ws.send(JSON.stringify({ type: 'agent.command', command: type, command_id: commandId, payload }));
    await AgentCommand.markSent(commandId).catch(() => {});

    return promise;
  }

  startMonitor(intervalMs = 15000) {
    if (this.monitor) clearInterval(this.monitor);
    this.monitor = setInterval(async () => {
      try {
        await Server.markStaleOffline(45);
      } catch { /* ignore */ }
      for (const [id, ws] of this.connections) {
        if (ws.readyState !== 1) { this.connections.delete(id); continue; }
        if (ws.isAlive === false) {
          try { ws.terminate(); } catch { /* ignore */ }
          continue;
        }
        ws.isAlive = false;
        try { ws.ping(); } catch { /* ignore */ }
      }
    }, intervalMs);
    if (this.monitor.unref) this.monitor.unref();
  }

  stopMonitor() {
    if (this.monitor) {
      clearInterval(this.monitor);
      this.monitor = null;
    }
  }
}

// Singleton used by controllers; app.js configures its onEvent handler and
// attaches it to the HTTP server.
const hub = new AgentHub();

module.exports = { AgentHub, hub };
