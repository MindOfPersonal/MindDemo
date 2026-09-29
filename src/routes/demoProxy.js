const express = require('express');
const http = require('http');
const httpProxy = require('http-proxy');
const { v4: uuidv4 } = require('uuid');
const Demo = require('../models/Demo');
const DemoSession = require('../models/DemoSession');
const { createSession } = require('../controllers/sessionController');
const dockerService = require('../services/dockerService');
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
  const prefix = `/demo/${slug}/live`;

  // Server-rendered demos (MindFolio) sturen `Location: /admin/...` bij
  // redirects. Zonder herschrijven verlaat de browser de demo-iframe en komt
  // hij op de host-root uit. Prefix root-relatieve redirects met het demo-pad.
  const location = proxyRes.headers['location'];
  if (
    slug &&
    typeof location === 'string' &&
    location.startsWith('/') &&
    !location.startsWith('//') &&
    location !== prefix &&
    !location.startsWith(`${prefix}/`)
  ) {
    proxyRes.headers['location'] = `${prefix}${location}`;
  }

  // The proxy sets its own cookies (demo_session_<slug>, visitor_token) via
  // res.cookie() before proxying. The upstream app may also send Set-Cookie
  // (e.g. MindFolio's `mindfolio.sid` / `csrf`). Node's res.writeHead, when given
  // a `set-cookie` header, overwrites whatever res.cookie() queued — which would
  // drop the session cookie and force a new container on every request. Merge both
  // so upstream and proxy cookies survive together.
  const upstreamCookies = proxyRes.headers['set-cookie'];
  const ownCookies = res.getHeader('Set-Cookie');
  if (upstreamCookies || ownCookies) {
    const merged = [];
    const up = Array.isArray(upstreamCookies) ? upstreamCookies : (upstreamCookies ? [upstreamCookies] : []);
    for (const c of up) if (!merged.includes(c)) merged.push(c);
    const mine = Array.isArray(ownCookies) ? ownCookies : (ownCookies ? [ownCookies] : []);
    for (const c of mine) if (!merged.includes(c)) merged.push(c);
    proxyRes.headers['set-cookie'] = merged;
  }

  if (!isHtml) {
    res.writeHead(proxyRes.statusCode, proxyRes.headers);
    proxyRes.pipe(res);
    return;
  }

  const chunks = [];
  proxyRes.on('data', (c) => chunks.push(c));
  proxyRes.on('end', () => {
    try {
      const original = Buffer.concat(chunks);
      let body = original.toString('utf8');
      // Ook `data-src` (o.a. de MindFolio-lightbox) en `poster` verwijzen
      // root-relatief; herschrijf die mee.
      body = body.replace(/(href|src|action|data-src|poster)=(["'])\/(?!\/)/g, (m, attr, q) => `${attr}=${q}${prefix}/`);
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

    // Per-demo session cookie so each `/demo/<slug>` keeps its own container.
    // A shared `demo_session` cookie would reuse whichever demo's session was
    // created first and serve that same container for every slug (the symptom of
    // "first running demo shown everywhere").
    const cookieName = `demo_session_${slug}`;
    let sessionToken = req.cookies?.[cookieName];
    let session = null;

    if (sessionToken) {
      session = await DemoSession.findByToken(sessionToken);
      if (
        !session ||
        session.demo_id !== demo.id ||
        session.status === 'stopped'
      ) {
        session = null;
      } else if (!session.container_id) {
        let waited = 0;
        while (waited < 30000) {
          await new Promise(r => setTimeout(r, 1000));
          waited += 1000;
          session = await DemoSession.findByToken(sessionToken);
          if (session && session.container_id && await dockerService.isContainerRunning(session.container_id)) {
            await DemoSession.updateActivity(session.id);
            break;
          }
          if (!session || session.status === 'stopped') {
            session = null;
            break;
          }
        }
        if (!session || !session.container_id || !(await dockerService.isContainerRunning(session.container_id))) {
          if (session) await DemoSession.end(session.id);
          session = null;
        }
      } else if (await dockerService.isContainerRunning(session.container_id)) {
        await DemoSession.updateActivity(session.id);
      } else {
        // The container is gone (crashed / stopped / idle-reaped) but the
        // session row still says "active". Invalidate it so the next branch
        // spins up a fresh container instead of reusing a dead target.
        logger.info(`Recreating dead session ${session.session_token} for demo ${demo.slug}`);
        await DemoSession.end(session.id);
        session = null;
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

    res.cookie(cookieName, session.session_token, {
      maxAge: 24 * 60 * 60 * 1000,
      httpOnly: true
    });

    const containerPort = session.container_port;
    const target = `http://127.0.0.1:${containerPort}`;

    // Ruime marge: een koude container (Docker start + app-boot + eventuele
    // demo-baseline-reset) kan op een drukke host 10-20s duren. De oude 8s
    // gaf een 502 vóórdat de app überhaupt luisterde.
    const ready = await waitForHealth(target, 30000);
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
    if (/Maximum number of concurrent sessions/i.test(err.message || '')) {
      return res.status(503).render('error', {
        message: 'This demo is at capacity. Please try again in a few minutes.',
        title: 'Demo Busy',
        error_code: 503
      });
    }
    res.status(502).render('error', {
      message: 'Could not connect to demo environment',
      title: 'Demo Error',
      error_code: 502
    });
  }
});

module.exports = router;