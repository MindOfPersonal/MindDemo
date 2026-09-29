const Server = require('../models/Server');
const ServerMetric = require('../models/ServerMetric');
const AgentCommand = require('../models/AgentCommand');
const Demo = require('../models/Demo');
const { hub } = require('../services/agentHub');
const discordEvents = require('../services/discordEvents');
const logger = require('../utils/logger');

// ---------------------------------------------------------------------------
// Admin API for managing agent servers.
// ---------------------------------------------------------------------------

async function list(req, res) {
  try {
    const servers = await Server.findAll();
    const demos = await Demo.findAll();
    const counts = {};
    for (const d of demos) {
      if (d.server_id) counts[d.server_id] = (counts[d.server_id] || 0) + 1;
    }
    res.json(servers.map((s) => ({ ...s, demo_count: counts[s.id] || 0, connected: hub.isConnected(s.id) })));
  } catch (err) {
    logger.error('List servers error:', err);
    res.status(500).json({ error: 'Failed to list servers' });
  }
}

async function get(req, res) {
  try {
    const server = await Server.findById(req.params.id);
    if (!server) return res.status(404).json({ error: 'Server not found' });
    const [metrics, commands, demos] = await Promise.all([
      ServerMetric.getRecent(server.id, 50),
      AgentCommand.findRecentByServer(server.id, 30),
      Demo.findAll()
    ]);
    res.json({
      server: { ...server, connected: hub.isConnected(server.id) },
      metrics,
      commands,
      demos: demos.filter((d) => String(d.server_id) === String(server.id))
    });
  } catch (err) {
    logger.error('Get server error:', err);
    res.status(500).json({ error: 'Failed to fetch server' });
  }
}

async function create(req, res) {
  try {
    const { name, server_url, control_url, notes, is_pinned, allow_failover } = req.body || {};
    if (!name || !String(name).trim()) {
      return res.status(400).json({ error: 'Name is required' });
    }
    const token = Server.generateToken();
    const id = await Server.create({
      name: String(name).trim(),
      server_url,
      control_url,
      token,
      notes,
      is_pinned,
      allow_failover
    });
    const server = await Server.findById(id);
    discordEvents.serverAdded(req, server);
    // The token is returned exactly once; MindDemo stores only its hash.
    res.json({ message: 'Server created', server, token });
  } catch (err) {
    logger.error('Create server error:', err);
    res.status(500).json({ error: 'Failed to create server' });
  }
}

async function update(req, res) {
  try {
    const server = await Server.findById(req.params.id);
    if (!server) return res.status(404).json({ error: 'Server not found' });
    const { name, server_url, control_url, notes, is_pinned, allow_failover } = req.body || {};
    await Server.update(server.id, {
      name, server_url, control_url, notes,
      is_pinned: is_pinned === undefined ? undefined : (is_pinned ? 1 : 0),
      allow_failover: allow_failover === undefined ? undefined : (allow_failover ? 1 : 0)
    });
    res.json({ message: 'Server updated' });
  } catch (err) {
    logger.error('Update server error:', err);
    res.status(500).json({ error: 'Failed to update server' });
  }
}

async function remove(req, res) {
  try {
    const server = await Server.findById(req.params.id);
    if (!server) return res.status(404).json({ error: 'Server not found' });
    await Server.delete(server.id);
    discordEvents.serverRemoved(req, server);
    res.json({ message: 'Server removed' });
  } catch (err) {
    logger.error('Remove server error:', err);
    res.status(500).json({ error: 'Failed to remove server' });
  }
}

async function test(req, res) {
  try {
    const server = await Server.findById(req.params.id);
    if (!server) return res.status(404).json({ error: 'Server not found' });
    if (!hub.isConnected(server.id)) {
      return res.status(409).json({ error: 'Agent is not connected' });
    }
    const result = await hub.sendCommand(server.id, 'demo.list', {}, { timeoutMs: 10000, createdBy: req.session && req.session.username });
    res.json({ ok: true, result });
  } catch (err) {
    res.status(500).json({ error: err.message, code: err.code });
  }
}

async function metrics(req, res) {
  try {
    const metrics = await ServerMetric.getRecent(req.params.id, 200);
    res.json(metrics);
  } catch (err) {
    logger.error('Server metrics error:', err);
    res.status(500).json({ error: 'Failed to fetch metrics' });
  }
}

async function logs(req, res) {
  try {
    const commands = await AgentCommand.findRecentByServer(req.params.id, 100);
    res.json(commands);
  } catch (err) {
    logger.error('Server logs error:', err);
    res.status(500).json({ error: 'Failed to fetch logs' });
  }
}

async function installScript(req, res) {
  try {
    const server = await Server.findById(req.params.id);
    if (!server) return res.status(404).json({ error: 'Server not found' });
    const token = (req.body && req.body.token) || '<AGENT_TOKEN>';
    const controlUrl = (req.body && req.body.control_url) || `${require('../config').APP_URL.replace(/^http/, 'ws')}/agent/ws`;
    const script = [
      '# Run these commands as root on the target server.',
      '# 1) Get the agent code onto the server (pick one):',
      '#    git clone https://github.com/MindOfPersonal/MindDemo-agent.git /tmp/minddemo-agent',
      '#    # or copy the folder from the MindDemo host:',
      '#    scp -r /root/projecten/Dev/MindDemo-agent root@<server>:/tmp/minddemo-agent',
      '',
      '# 2) Run the installer (it installs Node and Docker if missing):',
      'cd /tmp/minddemo-agent',
      `sudo bash install.sh --control ${controlUrl} --token ${token} --yes`
    ].join('\n');
    res.type('text/plain').send(script);
  } catch (err) {
    logger.error('Install script error:', err);
    res.status(500).json({ error: 'Failed to build install script' });
  }
}

module.exports = { list, get, create, update, remove, test, metrics, logs, installScript };
