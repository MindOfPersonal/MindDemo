const config = require('../config');
const logger = require('../utils/logger');

// ---------------------------------------------------------------------------
// Discord webhook logging
// ---------------------------------------------------------------------------
// Central place where every notable admin action, demo/session lifecycle event,
// security signal and unhandled error is reported to a Discord channel.
//
// Design goals:
//   * never crash or block the request path (fire-and-forget, queue based);
//   * never exceed Discord's webhook rate limit (~30 requests / minute);
//   * respect Discord embed size limits by truncating oversized values;
//   * be configurable through env vars (URL, allow-list, mention, ...).
// ---------------------------------------------------------------------------

const COLORS = {
  info: 0x3498db,      // blue
  success: 0x2ecc71,   // green
  warning: 0xf1c40f,   // yellow
  error: 0xe74c3c,     // red
  security: 0xe67e22,  // orange
  admin: 0x9b59b6,     // purple
  session: 0x1abc9c,   // teal
  docker: 0x34495e,    // dark slate
  muted: 0x95a5a6      // grey
};

const LIMITS = {
  title: 256,
  description: 4096,
  fieldName: 256,
  fieldValue: 1024,
  footer: 2048,
  fields: 25,
  content: 2000,
  totalEmbed: 6000
};

const HIGH_SEVERITY = new Set(['error', 'security']);

function truncate(value, max) {
  if (value === null || value === undefined) return '';
  const str = String(value);
  if (str.length <= max) return str;
  return `${str.slice(0, max - 3)}...`;
}

function isEnabled() {
  return !!(config.DISCORD && config.DISCORD.ENABLED && config.DISCORD.WEBHOOK_URL);
}

function isEventAllowed(eventKey) {
  const allow = (config.DISCORD && config.DISCORD.EVENTS) || '*';
  if (!allow || allow.trim() === '*') return true;
  const list = allow.split(',').map((s) => s.trim()).filter(Boolean);
  if (list.includes('*')) return true;
  if (list.includes(eventKey)) return true;
  // Allow whole categories, e.g. "demo" enables demo.create/start/...
  const category = String(eventKey).split('.')[0];
  return list.includes(category);
}

// ---------------------------------------------------------------------------
// Queue / rate limiting
// ---------------------------------------------------------------------------

const queue = [];
let processing = false;
let lastSentAt = 0;

function enqueue(payload) {
  if (queue.length >= config.DISCORD.MAX_QUEUE) {
    // Drop the oldest message instead of growing without bound.
    queue.shift();
    logger.warn('Discord queue full, dropping oldest notification');
  }
  queue.push(payload);
  void processQueue();
}

async function processQueue() {
  if (processing) return;
  processing = true;

  while (queue.length > 0) {
    const payload = queue.shift();
    const wait = Math.max(0, config.DISCORD.MIN_INTERVAL_MS - (Date.now() - lastSentAt));
    if (wait > 0) {
      await new Promise((r) => setTimeout(r, wait));
    }
    try {
      await deliver(payload);
    } catch (err) {
      logger.debug(`Discord delivery failed: ${err.message}`);
    }
    lastSentAt = Date.now();
  }

  processing = false;
}

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

async function deliver(payload, attempt = 0) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 10000);

  try {
    const res = await fetch(config.DISCORD.WEBHOOK_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
      signal: controller.signal
    });

    if (res.status === 429 && attempt < 3) {
      let retryAfter = 1;
      try {
        const body = await res.json();
        retryAfter = body.retry_after || 1;
      } catch { /* ignore */ }
      logger.debug(`Discord rate limited, retrying in ${retryAfter}s`);
      await sleep(Math.ceil(retryAfter * 1000));
      return deliver(payload, attempt + 1);
    }

    if (res.status >= 500 && attempt < 2) {
      await sleep(1000 * (attempt + 1));
      return deliver(payload, attempt + 1);
    }

    if (!res.ok && res.status !== 204) {
      const text = await res.text().catch(() => '');
      logger.warn(`Discord webhook returned ${res.status}: ${truncate(text, 300)}`);
    }
  } catch (err) {
    if (attempt < 2) {
      await sleep(1000 * (attempt + 1));
      return deliver(payload, attempt + 1);
    }
    throw err;
  } finally {
    clearTimeout(timeout);
  }
}

// ---------------------------------------------------------------------------
// Embed building
// ---------------------------------------------------------------------------

function normalizeFields(fields = []) {
  return fields
    .filter(Boolean)
    .slice(0, LIMITS.fields)
    .map((f) => ({
      name: truncate(f.name, LIMITS.fieldName) || '-',
      value: truncate(f.value === undefined || f.value === '' ? '-' : f.value, LIMITS.fieldValue),
      inline: !!f.inline
    }));
}

function buildEmbed({ title, description, color, fields, footer, url, timestamp }) {
  const embed = {};

  if (title) embed.title = truncate(title, LIMITS.title);
  if (description) embed.description = truncate(description, LIMITS.description);
  embed.color = typeof color === 'number' ? color : (COLORS[color] || COLORS.info);
  if (url) embed.url = String(url);
  if (timestamp !== false) embed.timestamp = new Date().toISOString();
  embed.footer = { text: truncate(footer || 'MindDemo', LIMITS.footer) };
  if (config.APP_URL && /^https?:\/\//.test(config.APP_URL)) {
    embed.thumbnail = { url: `${config.APP_URL.replace(/\/$/, '')}/img/logo.jpg` };
  }

  const normalized = normalizeFields(fields);
  if (normalized.length) embed.fields = normalized;

  // Keep the total embed under Discord's 6000 char limit.
  let total = (embed.title || '').length + (embed.description || '').length +
    (embed.footer.text || '').length;
  for (const f of (embed.fields || [])) total += f.name.length + f.value.length;
  if (total > LIMITS.totalEmbed && embed.description) {
    embed.description = truncate(embed.description, LIMITS.totalEmbed / 2);
  }

  return embed;
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Low-level: send a raw payload to the webhook (queued).
 */
function send(payload) {
  if (!isEnabled()) return;
  enqueue(payload);
}

/**
 * Send a formatted embed event.
 *
 * @param {string} eventKey  e.g. 'admin.login'
 * @param {object} opts      { title, description, color, fields, footer, url, mention }
 */
function event(eventKey, opts = {}) {
  if (!isEnabled() || !isEventAllowed(eventKey)) return;

  const severity = opts.color || 'info';
  const embed = buildEmbed(opts);
  const payload = {
    username: config.DISCORD.USERNAME,
    embeds: [embed]
  };

  if (config.DISCORD.AVATAR_URL) payload.avatar_url = config.DISCORD.AVATAR_URL;

  const shouldMention = opts.mention !== undefined
    ? opts.mention
    : (HIGH_SEVERITY.has(severity) && config.DISCORD.MENTION);

  if (shouldMention && config.DISCORD.MENTION) {
    payload.content = truncate(config.DISCORD.MENTION, LIMITS.content);
    payload.allowed_mentions = { parse: ['roles', 'users'] };
  }

  send(payload);
}

// ---------------------------------------------------------------------------
// Request / audit helpers
// ---------------------------------------------------------------------------

function clientIp(req) {
  if (!req) return 'unknown';
  const fwd = req.headers && req.headers['x-forwarded-for'];
  if (fwd) return String(fwd).split(',')[0].trim();
  return (req.ip || (req.socket && req.socket.remoteAddress) || 'unknown');
}

function userAgent(req) {
  return (req && req.headers && req.headers['user-agent']) || 'unknown';
}

/**
 * Audit a mutating admin request. Designed to be called from the response
 * `finish` handler so the real HTTP status code is included.
 */
function audit(req, action, extra = {}) {
  const status = extra.status || (req && req.res && req.res.statusCode) || 0;
  const method = req ? req.method : '?';
  const path = req ? (req.originalUrl || req.url) : '?';

  const fields = [
    { name: 'Admin', value: (req && req.session && req.session.username) || extra.username || 'anonymous', inline: true },
    { name: 'Method', value: method, inline: true },
    { name: 'Status', value: status ? String(status) : 'unknown', inline: true },
    { name: 'Route', value: `\`${truncate(path, 1000)}\``, inline: false }
  ];

  if (extra.target) fields.push({ name: 'Target', value: extra.target, inline: true });
  if (extra.details) fields.push({ name: 'Details', value: extra.details, inline: false });

  event('audit', {
    title: `Admin actie: ${action}`,
    description: extra.description || null,
    color: status >= 400 ? 'warning' : 'admin',
    fields,
    footer: `MindDemo audit | ${clientIp(req)} | ${truncate(userAgent(req), 80)}`
  });
}

/**
 * Express middleware that automatically audits every non-GET request under the
 * admin API, regardless of whether the controller emits its own event. This
 * guarantees a complete trail (including failed/blocked actions).
 */
function auditMiddleware(actionFor, options = {}) {
  const onlyFailed = !!options.onlyFailed;
  return function discordAudit(req, res, next) {
    if (!isEnabled()) return next();
    if (req.method === 'GET' || req.method === 'HEAD' || req.method === 'OPTIONS') {
      return next();
    }
    res.on('finish', () => {
      if (onlyFailed && res.statusCode < 400) return;
      let action;
      try {
        action = typeof actionFor === 'function'
          ? actionFor(req)
          : `${req.method} ${req.baseUrl || ''}${req.path}`;
      } catch {
        action = `${req.method} ${req.path}`;
      }
      audit(req, action);
    });
    next();
  };
}

module.exports = {
  COLORS,
  isEnabled,
  isEventAllowed,
  send,
  event,
  audit,
  auditMiddleware,
  clientIp,
  userAgent,
  buildEmbed,
  truncate,
  _queue: queue
};
