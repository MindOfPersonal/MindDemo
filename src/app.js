require('dotenv').config();
const path = require('path');
const fs = require('fs');
const express = require('express');
const session = require('express-session');
const cors = require('cors');
const helmet = require('helmet');
const cookieParser = require('cookie-parser');
const compression = require('compression');
const config = require('./config');
const database = require('./config/database');
const dbInit = require('../database/schema');
const logger = require('./utils/logger');
const dockerService = require('./services/dockerService');
const { startWorker, stopWorker } = require('./services/cleanupWorker');
const { csrfProtection, generateCSRFToken } = require('./middleware/csrf');
const { authRequired, guestOnly } = require('./middleware/auth');
const { loginLimiter, apiLimiter } = require('./middleware/rateLimit');
const adminController = require('./controllers/adminController');

const app = express();

app.set('views', path.join(__dirname, 'views'));
app.set('view engine', 'ejs');

app.use(helmet({
  contentSecurityPolicy: {
    directives: {
      defaultSrc: ["'self'"],
      styleSrc: ["'self'", "'unsafe-inline'", 'https://fonts.googleapis.com'],
      fontSrc: ["'self'", 'https://fonts.gstatic.com'],
      scriptSrc: ["'self'", "'unsafe-inline'"],
      scriptSrcAttr: ["'unsafe-inline'"],
      imgSrc: ["'self'", 'data:'],
      connectSrc: ["'self'"]
    }
  }
}));
app.use(compression());
app.use(cors({
  origin: config.APP_URL,
  credentials: true
}));
app.use(express.json({ limit: '50mb' }));
app.use(express.urlencoded({ extended: true, limit: '50mb' }));
app.use(cookieParser());
app.use('/css', express.static(path.join(__dirname, '..', 'public', 'css')));
app.use('/js', express.static(path.join(__dirname, '..', 'public', 'js')));
app.use('/img', express.static(path.join(__dirname, '..', 'public', 'img')));

app.set('trust proxy', 1);

app.use(session({
  name: 'minddemo_session',
  secret: config.SESSION_SECRET,
  resave: false,
  saveUninitialized: false,
  cookie: {
    httpOnly: true,
    secure: 'auto',
    maxAge: 24 * 60 * 60 * 1000,
    sameSite: 'lax'
  }
}));

app.use(generateCSRFToken);

const adminAuthRoutes = require('./routes/adminAuth');
const demoRoutes = require('./routes/demoRoutes');
const sessionRoutes = require('./routes/sessionRoutes');
const demoProxy = require('./routes/demoProxy');
const publicDemo = require('./routes/publicDemo');

app.use('/api/admin', adminAuthRoutes);
app.use('/api/admin/demos', apiLimiter(), authRequired, demoRoutes);
app.use('/api/session', sessionRoutes);

app.get('/', (req, res) => {
  res.render('landing');
});

app.get('/admin/login', guestOnly, (req, res) => {
  res.render('admin/login', { 
    title: 'Admin Login', 
    error: null,
    csrfToken: req.session.csrfToken
  });
});

app.get('/admin/dashboard', authRequired, async (req, res) => {
  const result = await adminController.getDashboard(req, res);
});

app.get('/admin/demos', authRequired, async (req, res) => {
  try {
    const Demo = require('./models/Demo');
    const demos = await Demo.findAll();
    let sessionCount = 0;
    for (const d of demos) {
      const DemoSession = require('./models/DemoSession');
      const sessions = await DemoSession.findActiveByDemoId(d.id);
      sessionCount += sessions.length;
    }
    res.render('admin/demos', { 
      title: 'Demos', 
      demos, 
      username: req.session.username,
      csrfToken: req.session.csrfToken,
      sessionCount
    });
  } catch (err) {
    logger.error('Get demos page error:', err);
    res.status(500).send('Server error');
  }
});

app.get('/admin/demos/create', authRequired, (req, res) => {
  res.render('admin/demos/create', { 
    title: 'Create Demo', 
    csrfToken: req.session.csrfToken 
  });
});

app.get('/admin/demos/:id', authRequired, (req, res) => {
  res.render('admin/demos/view', { 
    title: 'View Demo', 
    csrfToken: req.session.csrfToken 
  });
});

app.get('/admin/demos/:id/edit', authRequired, (req, res) => {
  res.render('admin/demos/edit', { 
    title: 'Edit Demo', 
    csrfToken: req.session.csrfToken 
  });
});

app.get('/admin/logs', authRequired, (req, res) => {
  res.render('admin/logs', { 
    title: 'Logs', 
    csrfToken: req.session.csrfToken,
    username: req.session.username
  });
});

app.get('/admin/settings', authRequired, (req, res) => {
  res.render('admin/settings', { 
    title: 'Settings', 
    csrfToken: req.session.csrfToken,
    username: req.session.username
  });
});

app.get('/admin/system', authRequired, (req, res) => {
  res.render('admin/dashboard', { 
    title: 'System',
    csrfToken: req.session.csrfToken,
    username: req.session.username,
    stats: {},
    recentDemos: [],
    recentLogs: []
  });
});

app.use('/demo', publicDemo);
app.use('/demo/:slug/live', demoProxy);

app.use((err, req, res, next) => {
  logger.error('Unhandled error:', err);
  res.status(500).render('error', {
    title: 'Error',
    message: 'An internal error occurred',
    error_code: 500
  });
});

let server;
let isShuttingDown = false;

async function startServer() {
  try {
    await database.pool.getConnection();
    logger.info('Database connected');

    await dbInit.initialize();
    await dbInit.createDefaultAdmin();

    dockerService.initDocker();
    startWorker(30000);

    const port = config.PORT;
    server = app.listen(port, () => {
      logger.info(`MindDemo server running on port ${port}`);
      console.log(`MindDemo server running on http://localhost:${port}`);
    });

    process.on('SIGTERM', gracefulShutdown);
    process.on('SIGINT', gracefulShutdown);

  } catch (err) {
    logger.error('Failed to start server:', err);
    process.exit(1);
  }
}

function gracefulShutdown() {
  if (isShuttingDown) return;
  isShuttingDown = true;
  
  logger.info('Graceful shutdown started');
  stopWorker();
  
  if (server) {
    server.close(() => {
      logger.info('Server closed');
      process.exit(0);
    });
    
    setTimeout(() => {
      logger.warn('Force shutdown');
      process.exit(1);
    }, 10000);
  }
}

if (require.main === module) {
  startServer();
}

module.exports = app;
module.exports.startServer = startServer;
module.exports.app = app;