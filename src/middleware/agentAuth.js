const Server = require('../models/Server');
const logger = require('../utils/logger');

// ---------------------------------------------------------------------------
// Agent authentication.
// ---------------------------------------------------------------------------
// Agents are not browsers: they authenticate with a bearer token, never with
// a session or CSRF token. This middleware must stay outside the admin
// middleware chain.
// ---------------------------------------------------------------------------

function extractToken(req) {
  const headers = req.headers || {};
  const header = (req.get && req.get('authorization')) || headers.authorization;
  if (header) {
    const match = String(header).match(/^Bearer\s+(.+)$/i);
    if (match) return match[1].trim();
  }
  const xAgent = (req.get && req.get('x-agent-token')) || headers['x-agent-token'];
  if (xAgent) return String(xAgent);
  if (req.query && req.query.token) return req.query.token;
  // Raw upgrade requests (WebSocket) have no req.query; parse the URL.
  try {
    const url = new URL(req.url, 'http://localhost');
    const token = url.searchParams.get('token');
    if (token) return token;
  } catch { /* ignore */ }
  return null;
}

async function agentAuth(req, res, next) {
  try {
    const token = extractToken(req);
    if (!token) {
      return res.status(401).json({ error: 'Agent token required' });
    }
    const server = await Server.findByTokenHash(Server.hashToken(token));
    if (!server) {
      logger.warn(`agent.register_failed remote=${req.ip} token=…${String(token).slice(-4)} action=connection_rejected`);
      return res.status(401).json({ error: 'Invalid agent token' });
    }
    req.agentServer = server;
    next();
  } catch (err) {
    logger.error('Agent auth error:', err);
    res.status(500).json({ error: 'Internal server error' });
  }
}

module.exports = { agentAuth, extractToken };
