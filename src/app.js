require('dotenv').config();
const path = require('path');
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
const discordService = require('./services/discordService');
const discordEvents = require('./services/discordEvents');
const { hub } = require('./services/agentHub');
const Demo = require('./models/Demo');
const DemoLog = require('./models/DemoLog');
const { startWorker, stopWorker } = require('./services/cleanupWorker');
const { csrfProtection, generateCSRFToken } = require('./middleware/csrf');
const { authRequired, guestOnly } = require('./middleware/auth');
const { apiLimiter, sessionLimiter } = require('./middleware/rateLimit');
const adminController = require('./controllers/adminController');

const app = express();

app.set('trust proxy', 1);
app.set('views', path.join(__dirname, 'views'));
app.set('view engine', 'ejs');

// JSON.stringify for embedding server values safely inside inline <script>
// blocks. Escaping `<` prevents `</script>` and HTML-comment breakouts.
app.locals.safeJson = (value) => JSON.stringify(value).replace(/</g, '\\u003c');

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
app.use(cookieParser());

// Demo-proxy MOET vóór de body-parsers staan. express.json()/urlencoded()
// lezen de request-stream volledig in, waardoor http-proxy geen body meer kan
// doorsturen: POST/PATCH-verzoeken naar de demo (login, berichten, ...) blijven
// dan hangen. Door de proxy hier te mounten blijft de stream intact.
// cookieParser staat er bewust vóór, want de proxy leest req.cookies.
app.use('/demo/:slug/live', require('./routes/demoProxy'));

app.use(express.json({ limit: '50mb' }));
app.use(express.urlencoded({ extended: true, limit: '50mb' }));
app.use('/css', express.static(path.join(__dirname, '..', 'public', 'css')));
app.use('/js', express.static(path.join(__dirname, '..', 'public', 'js')));
app.use('/img', express.static(path.join(__dirname, '..', 'public', 'img')));

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
const publicDemo = require('./routes/publicDemo');

// Catch-all audit for failed/blocked admin API calls (401/403/429/5xx). The
// successful actions emit richer, action-specific events from the controllers.
app.use('/api/admin', discordService.auditMiddleware(null, { onlyFailed: true }));
app.use('/api/admin', csrfProtection);
app.use('/api/admin', adminAuthRoutes);
app.use('/api/admin/demos', apiLimiter(), authRequired, demoRoutes);
app.use('/api/admin/servers', authRequired, require('./routes/serverRoutes'));
app.use('/api/session', sessionLimiter(), sessionRoutes);

// Agent-facing endpoints use a bearer token, not a browser session or CSRF.
app.use('/api/agent', require('./routes/agentApi'));

app.post('/api/admin/discord/test', authRequired, (req, res) => {
  if (!discordService.isEnabled()) {
    return res.status(400).json({ error: 'Discord webhook is not configured or disabled' });
  }
  discordEvents.test(req);
  res.json({ message: 'Test notification queued' });
});

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
    const DemoSession = require('./models/DemoSession');
    const demos = await Demo.findAll();
    let sessionCount = 0;
    const sessionCounts = {};
    for (const d of demos) {
      const sessions = await DemoSession.findActiveByDemoId(d.id);
      sessionCounts[d.id] = sessions.length;
      sessionCount += sessions.length;
    }
    res.render('admin/demos', { 
      title: 'Demos', 
      demos, 
      username: req.session.username,
      csrfToken: req.session.csrfToken,
      sessionCount,
      sessionCounts
    });
  } catch (err) {
    logger.error('Get demos page error:', err);
    res.status(500).send('Server error');
  }
});

app.get('/admin/demos/create', authRequired, (req, res) => {
  res.render('admin/demos/create', {
    title: 'Create Demo',
    csrfToken: req.session.csrfToken,
    username: req.session.username
  });
});

app.get('/admin/demos/:id', authRequired, (req, res) => {
  res.render('admin/demos/view', { 
    title: 'View Demo', 
    csrfToken: req.session.csrfToken,
    username: req.session.username
  });
});

app.get('/admin/demos/:id/edit', authRequired, async (req, res) => {
  try {
    const Demo = require('./models/Demo');
    const DemoEnvironment = require('./models/DemoEnvironment');
    const demo = await Demo.findById(req.params.id);
    if (!demo) {
      return res.redirect('/admin/demos');
    }
    const envVars = await DemoEnvironment.getByDemoId(demo.id);
    res.render('admin/demos/edit', {
      title: 'Edit Demo',
      csrfToken: req.session.csrfToken,
      demo,
      envVars,
      username: req.session.username
    });
  } catch (err) {
    logger.error('Edit demo load error:', err);
    res.redirect('/admin/demos');
  }
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
    username: req.session.username,
    settings: {
      NODE_ENV: config.NODE_ENV,
      PORT: config.PORT,
      APP_URL: config.APP_URL,
      DB_HOST: config.DB.HOST,
      DB_NAME: config.DB.NAME,
      DB_USER: config.DB.USER,
      DEMO_DEFAULT_TIMEOUT: config.DEMO_DEFAULT_TIMEOUT,
      DEMO_MAX_UPLOAD_SIZE: config.DEMO_MAX_UPLOAD_SIZE,
      DEMO_MAX_SESSIONS: config.DEMO_MAX_SESSIONS,
      DEMO_SESSION_GRACE_SECONDS: config.DEMO_SESSION_GRACE_SECONDS,
      DOCKER_SOCKET: config.DOCKER_SOCKET,
      DISCORD_ENABLED: config.DISCORD.ENABLED,
      DISCORD_WEBHOOK_SET: !!config.DISCORD.WEBHOOK_URL,
      DISCORD_WEBHOOK_USERNAME: config.DISCORD.USERNAME,
      DISCORD_EVENTS: config.DISCORD.EVENTS,
      DISCORD_MENTION_SET: !!config.DISCORD.MENTION
    }
  });
});

app.get('/admin/servers', authRequired, (req, res) => {
  res.render('admin/servers', {
    title: 'Servers',
    csrfToken: req.session.csrfToken,
    username: req.session.username
  });
});

app.get('/admin/servers/new', authRequired, (req, res) => {
  res.render('admin/servers/new', {
    title: 'Add Server',
    csrfToken: req.session.csrfToken,
    username: req.session.username,
    controlUrl: config.APP_URL.replace(/^http/, 'ws') + '/agent/ws'
  });
});

app.get('/admin/servers/:id', authRequired, (req, res) => {
  res.render('admin/servers/view', {
    title: 'Server',
    csrfToken: req.session.csrfToken,
    username: req.session.username,
    serverId: req.params.id
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

app.use((err, req, res, next) => {
  logger.error('Unhandled error:', err);

  const isApi = req.path.startsWith('/api/');
  const isUploadError = err && (
    err.name === 'MulterError' ||
    err.code === 'LIMIT_FILE_SIZE' ||
    /Only ZIP files are allowed/i.test(err.message || '')
  );

  if (isUploadError) {
    const message = err.code === 'LIMIT_FILE_SIZE'
      ? `File too large (max ${config.DEMO_MAX_UPLOAD_SIZE}MB)`
      : (err.message || 'Upload failed');
    if (isApi) return res.status(400).json({ error: message });
    return res.status(400).render('error', {
      title: 'Upload Error',
      message,
      error_code: 400
    });
  }

  discordEvents.unhandledError(req, err);

  if (isApi) {
    return res.status(500).json({ error: 'Internal server error' });
  }

  res.status(500).render('error', {
    title: 'Error',
    message: 'An internal error occurred',
    error_code: 500
  });
});

// React to events agents send us: reflect demo status and surface notable
// events in the logs and on Discord.
function handleAgentEvent(server, message) {
  const event = message.event || message.type;
  try {
    if (event === 'agent.registered') {
      discordEvents.serverStatus(server, 'online');
    } else if (event === 'agent.disconnected') {
      discordEvents.serverStatus(server, 'offline');
    } else if (event === 'demo.started' && message.demo_id) {
      Demo.updateStatus(message.demo_id, 'running').catch(() => {});
      DemoLog.add({ demo_id: message.demo_id, level: 'info', message: `Demo started on server ${server.name}` }).catch(() => {});
    } else if (event === 'demo.stopped' && message.demo_id) {
      Demo.updateStatus(message.demo_id, 'stopped').catch(() => {});
      DemoLog.add({ demo_id: message.demo_id, level: 'info', message: `Demo stopped on server ${server.name}` }).catch(() => {});
    } else if (event === 'demo.failed') {
      DemoLog.add({ demo_id: message.demo_id || null, level: 'error', message: `Agent error: ${message.message || event}` }).catch(() => {});
      discordEvents.agentEvent(server, 'demo.failed', message.message);
    } else if (event && event.startsWith('demo.')) {
      DemoLog.add({ demo_id: message.demo_id || null, level: 'info', message: `Agent: ${event}` }).catch(() => {});
    }
  } catch (err) {
    logger.debug('Agent event handler error:', err.message);
  }
}

let server;
let isShuttingDown = false;

async function startServer() {
  try {
    await database.pool.getConnection();
    logger.info('Database connected');

    await dbInit.initialize();
    await dbInit.createDefaultAdmin();

    await dockerService.initDocker();
    startWorker(30000);

    const port = config.PORT;
    server = app.listen(port, () => {
      logger.info(`MindDemo server running on port ${port}`);
      console.log(`MindDemo server running on http://localhost:${port}`);
      discordEvents.serverStart(port);
    });

    if (config.AGENT.ENABLED) {
      hub.onEvent = handleAgentEvent;
      hub.attach(server);
      hub.startMonitor(15000);
      logger.info('Agent control plane listening on /agent/ws');
    }

    process.on('SIGTERM', gracefulShutdown);
    process.on('SIGINT', gracefulShutdown);

    process.on('unhandledRejection', (reason) => {
      logger.error('Unhandled rejection:', reason);
      discordEvents.unhandledError(null, reason instanceof Error ? reason : new Error(String(reason)));
    });

    process.on('uncaughtException', (err) => {
      logger.error('Uncaught exception:', err);
      discordEvents.unhandledError(null, err);
    });

  } catch (err) {
    logger.error('Failed to start server:', err);
    process.exit(1);
  }
}

function gracefulShutdown() {
  if (isShuttingDown) return;
  isShuttingDown = true;
  
  logger.info('Graceful shutdown started');
  discordEvents.serverStop('graceful shutdown');
  hub.stopMonitor();
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