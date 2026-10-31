const rateLimit = require('express-rate-limit');
const discordEvents = require('../services/discordEvents');

function loginLimiter() {
  return rateLimit({
    windowMs: 15 * 60 * 1000,
    max: 20,
    message: 'Too many login attempts. Please try again later.',
    standardHeaders: true,
    legacyHeaders: false,
    handler: (req, res) => {
      discordEvents.rateLimited(req, 'login');
      res.status(429).json({ error: 'Too many login attempts. Please try again later.' });
    }
  });
}

function apiLimiter() {
  return rateLimit({
    windowMs: 15 * 60 * 1000,
    max: 100,
    message: 'Too many requests. Please try again later.',
    standardHeaders: true,
    legacyHeaders: false,
    handler: (req, res) => {
      discordEvents.rateLimited(req, 'api');
      res.status(429).json({ error: 'Too many requests. Please try again later.' });
    }
  });
}

// Session endpoints are polled frequently by the live console (health every
// 2s, logs every 3s), so they need a much higher ceiling than apiLimiter while
// still being bounded.
function sessionLimiter() {
  return rateLimit({
    windowMs: 15 * 60 * 1000,
    max: 3000,
    message: 'Too many requests. Please try again later.',
    standardHeaders: true,
    legacyHeaders: false,
    handler: (req, res) => {
      discordEvents.rateLimited(req, 'session');
      res.status(429).json({ error: 'Too many requests. Please try again later.' });
    }
  });
}

module.exports = {
  loginLimiter,
  apiLimiter,
  sessionLimiter
};
