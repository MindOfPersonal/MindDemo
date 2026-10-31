const crypto = require('crypto');
const discordEvents = require('../services/discordEvents');

function safeEqual(a, b) {
  const bufA = Buffer.from(String(a));
  const bufB = Buffer.from(String(b));
  if (bufA.length !== bufB.length) return false;
  return crypto.timingSafeEqual(bufA, bufB);
}

// Session-based CSRF protection for authenticated (admin) state-changing routes.
// The token is issued once per session and must be echoed back via the `_csrf`
// body field or the `X-CSRF-Token` header.
function csrfProtection(req, res, next) {
  if (req.method === 'GET' || req.method === 'HEAD' || req.method === 'OPTIONS') {
    return next();
  }

  const token = req.body?._csrf || req.get('x-csrf-token');

  if (!token || !req.session) {
    discordEvents.csrfRejected(req);
    return res.status(403).json({ error: 'CSRF token missing' });
  }

  if (!req.session.csrfToken || !safeEqual(token, req.session.csrfToken)) {
    discordEvents.csrfRejected(req);
    return res.status(403).json({ error: 'Invalid CSRF token' });
  }

  next();
}

// Origin/Referer based guard for unauthenticated public POST endpoints. These
// have no session to tie a token to, so cross-site requests are rejected by
// comparing the Origin host with the request host.
function originGuard(req, res, next) {
  const origin = req.get('origin');
  const referer = req.get('referer');
  const host = req.get('host');
  const source = origin || referer;

  if (source && host) {
    try {
      const sourceHost = new URL(source).host;
      if (sourceHost !== host) {
        discordEvents.csrfRejected(req);
        return res.status(403).json({ error: 'Cross-site request blocked' });
      }
    } catch {
      discordEvents.csrfRejected(req);
      return res.status(403).json({ error: 'Invalid request origin' });
    }
  }

  next();
}

function generateCSRFToken(req, res, next) {
  if (!req.session) {
    req.session = {};
  }
  if (!req.session.csrfToken) {
    req.session.csrfToken = crypto.randomBytes(32).toString('hex');
  }
  res.locals.csrfToken = req.session.csrfToken;
  next();
}

function newCSRFToken(session) {
  const token = crypto.randomBytes(32).toString('hex');
  if (session) session.csrfToken = token;
  return token;
}

module.exports = { csrfProtection, originGuard, generateCSRFToken, newCSRFToken };
