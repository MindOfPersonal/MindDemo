const express = require('express');
const http = require('http');
const httpProxy = require('http-proxy');
const { v4: uuidv4 } = require('uuid');
const Demo = require('../models/Demo');
const DemoSession = require('../models/DemoSession');
const { createSession } = require('../controllers/sessionController');
const logger = require('../utils/logger');

const router = express.Router({ mergeParams: true });

// A TCP port being open does not mean the app inside the container is ready
// to serve HTTP. Poll with a real HTTP GET and resolve on the first response
// (any status), so proxy.web only fires against a truly healthy target.
function waitForHealth(targetUrl, timeoutMs) {
  const start = Date.now();
  return new Promise((resolve) => {
    function attempt() {
      if (Date.now() - start >= timeoutMs) return resolve(false);
      const req = http.get(targetUrl, (res) => {
        res.resume();
        resolve(true);
      });
      req.on('error', () => { setTimeout(attempt, 200); });
      req.setTimeout(1500, () => { try { req.destroy(); } catch (e) {} });
    }
    attempt();
  });
}

const proxy = httpProxy.createProxy({
  changeOrigin: true,
  xfwd: true,
  selfHandleResponse: true
});

// http-proxy 1.18.1 only wires the `onError` option as a no-op; the default
// listener re-throws when it is the sole 'error' listener (length === 1),
// which crashes the process on any target connection error. Registering our
// own listener makes length > 1, so errors are handled here instead of thrown.
proxy.on('error', (err, req, res, target) => {
  logger.error('Proxy error:', err.message);
  if (!res.headersSent) {
    res.status(502).render('error', {
      message: 'Could not connect to demo environment',
      title: 'Gateway Error',
      error_code: 502
    });
  }
});

// Demos are mounted under `/demo/<slug>/` but their links/assets often use
// root-relative URLs (href="/posts", src="/css/app.js"). Rewrite those to be
// prefix-qualified so navigation stays inside the demo scope instead of
// escaping to the host root.
proxy.on('proxyRes', (proxyRes, req, res) => {
  const slug = req.params && req.params.slug;
  const ct = proxyRes.headers['content-type'] || '';
  const encoding = proxyRes.headers['content-encoding'];
  const isHtml = slug && /text\/html/.test(ct) && !encoding;

  if (!isHtml) {
    res.writeHead(proxyRes.statusCode, proxyRes.headers);
    proxyRes.pipe(res);
    return;
  }

  const prefix = `/demo/${slug}/live`;
  const chunks = [];
  proxyRes.on('data', (c) => chunks.push(c));
  proxyRes.on('end', () => {
    try {
      const original = Buffer.concat(chunks);
      let body = original.toString('utf8');
      body = body.replace(/(href|src|action)=(["'])\/(?!\/)/g, (m, attr, q) => `${attr}=${q}${prefix}/`);
      const buf = Buffer.from(body, 'utf8');

      delete proxyRes.headers['content-encoding'];
      proxyRes.headers['content-length'] = buf.length;
      res.writeHead(proxyRes.statusCode, proxyRes.headers);
      res.end(buf);
    } catch (e) {
      logger.error('HTML rewrite error:', e.message);
      res.writeHead(proxyRes.statusCode, proxyRes.headers);
      res.end(Buffer.concat(chunks));
    }
  });
});

router.use(async (req, res, next) => {
  const slug = req.params.slug;

  try {
    const demo = await Demo.findBySlug(slug);
    req.demo = demo;
    if (!demo) {
      return res.status(404).render('error', {
        message: 'Demo not found',
        title: 'Demo Not Found',
        error_code: 404
      });
    }

    if (demo.status !== 'running') {
      return res.status(503).render('error', {
        message: 'Demo is not running. Please try again later.',
        title: 'Demo Not Available',
        error_code: 503
      });
    }

    next();
  } catch (err) {
    logger.error('Demo lookup error:', err);
    next(err);
  }
});

router.all('/*', async (req, res) => {
  try {
    const slug = req.params.slug;
    const demo = req.demo;

    let sessionToken = req.cookies?.demo_session;
    let session = null;

    if (sessionToken) {
      session = await DemoSession.findByToken(sessionToken);
      if (!session || session.status === 'stopped' || !session.container_id) {
        session = null;
      } else {
        await DemoSession.updateActivity(session.id);
      }
    }

    if (!session) {
      const result = await createSession(demo.id);
      session = await DemoSession.findByToken(result.sessionToken);
    }

    let visitorToken = req.cookies?.visitor_token;
    if (!visitorToken) {
      visitorToken = uuidv4();
    }
    res.cookie('visitor_token', visitorToken, {
      maxAge: 30 * 24 * 60 * 60 * 1000,
      httpOnly: false
    });

    res.cookie('demo_session', session.session_token, {
      maxAge: 24 * 60 * 60 * 1000,
      httpOnly: true
    });

    const containerPort = session.container_port;
    const target = `http://127.0.0.1:${containerPort}`;

    const ready = await waitForHealth(target, 8000);
    if (!ready) {
      logger.error(`Demo target ${target} not healthy for demo ${demo.slug}`);
      return res.status(502).render('error', {
        message: 'Demo environment is taking too long to start. Please try again.',
        title: 'Demo Not Ready',
        error_code: 502
      });
    }

    proxy.web(req, res, { target });
  } catch (err) {
    logger.error('Demo proxy error:', err);
    res.status(502).render('error', {
      message: 'Could not connect to demo environment',
      title: 'Demo Error',
      error_code: 502
    });
  }
});

module.exports = router;