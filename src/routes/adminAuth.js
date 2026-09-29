const express = require('express');
const Admin = require('../models/Admin');
const logger = require('../utils/logger');
const discordEvents = require('../services/discordEvents');
const { loginLimiter } = require('../middleware/rateLimit');
const { newCSRFToken } = require('../middleware/csrf');

const router = express.Router();

router.post('/login', loginLimiter(), async (req, res) => {
  try {
    const { username, password } = req.body;

    if (!username || !password) {
      return res.status(400).json({ error: 'Username and password required' });
    }

    const admin = await Admin.authenticate(username, password);

    if (!admin) {
      logger.warn(`Failed login attempt for username: ${username}`);
      discordEvents.adminLoginFailed(req, username);
      return res.status(401).json({ error: 'Invalid credentials' });
    }

    // Regenerate the session id on login to prevent session fixation, then
    // issue a fresh CSRF token bound to the new session.
    req.session.regenerate((regenErr) => {
      if (regenErr) {
        logger.error('Session regenerate error:', regenErr);
        return res.status(500).json({ error: 'Internal server error' });
      }

      req.session.adminId = admin.id;
      req.session.username = admin.username;
      newCSRFToken(req.session);

      req.session.save(async (saveErr) => {
        if (saveErr) {
          logger.error('Session save error:', saveErr);
          return res.status(500).json({ error: 'Internal server error' });
        }
        try {
          await Admin.updateLastLogin(admin.id);
        } catch (err) {
          logger.error('updateLastLogin error:', err);
        }
        logger.info(`Admin logged in: ${admin.username}`);
        discordEvents.adminLogin(req, admin);
        res.json({
          message: 'Login successful',
          csrfToken: req.session.csrfToken,
          redirect: '/admin/dashboard'
        });
      });
    });
  } catch (err) {
    logger.error('Login error:', err);
    res.status(500).json({ error: 'Internal server error' });
  }
});

router.post('/logout', (req, res) => {
  const username = req.session && req.session.username;
  req.session.destroy(err => {
    if (err) {
      return res.status(500).json({ error: 'Logout failed' });
    }
    discordEvents.adminLogout(req, username);
    res.clearCookie('minddemo_session');
    res.json({ message: 'Logged out', redirect: '/admin/login' });
  });
});

router.get('/logout', (req, res) => {
  const username = req.session && req.session.username;
  req.session.destroy(err => {
    if (err) {
      return res.redirect('/admin/login');
    }
    discordEvents.adminLogout(req, username);
    res.clearCookie('minddemo_session');
    res.redirect('/admin/login');
  });
});

router.get('/status', (req, res) => {
  if (req.session && req.session.adminId) {
    return res.json({ 
      authenticated: true, 
      username: req.session.username,
      csrfToken: req.session.csrfToken
    });
  }
  res.json({ authenticated: false });
});

module.exports = router;
