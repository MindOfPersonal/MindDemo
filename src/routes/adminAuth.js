const express = require('express');
const bcrypt = require('bcrypt');
const Admin = require('../models/Admin');
const logger = require('../utils/logger');
const { loginLimiter } = require('../middleware/rateLimit');

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
      return res.status(401).json({ error: 'Invalid credentials' });
    }

    req.session.adminId = admin.id;
    req.session.username = admin.username;

    await Admin.updateLastLogin(admin.id);

    logger.info(`Admin logged in: ${admin.username}`);

    res.json({ 
      message: 'Login successful', 
      csrfToken: req.session.csrfToken,
      redirect: '/admin/dashboard'
    });
  } catch (err) {
    logger.error('Login error:', err);
    res.status(500).json({ error: 'Internal server error' });
  }
});

router.post('/logout', (req, res) => {
  req.session.destroy(err => {
    if (err) {
      return res.status(500).json({ error: 'Logout failed' });
    }
    res.clearCookie('minddemo_session');
    res.json({ message: 'Logged out', redirect: '/admin/login' });
  });
});

router.get('/logout', (req, res) => {
  req.session.destroy(err => {
    if (err) {
      return res.redirect('/admin/login');
    }
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
