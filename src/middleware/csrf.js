const crypto = require('crypto');

function csrfProtection(req, res, next) {
  if (req.method === 'GET' || req.method === 'HEAD' || req.method === 'OPTIONS') {
    return next();
  }

  const token = req.body?._csrf || req.headers['x-csrf-token'] || req.headers['x-csrf-token'];

  if (!token || !req.session) {
    return res.status(403).json({ error: 'CSRF token missing' });
  }

  if (!req.session.csrfToken || !crypto.timingSafeEqual(Buffer.from(token), Buffer.from(req.session.csrfToken))) {
    return res.status(403).json({ error: 'Invalid CSRF token' });
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

module.exports = { csrfProtection, generateCSRFToken };
