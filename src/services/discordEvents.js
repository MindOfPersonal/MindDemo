const discord = require('./discordService');
const config = require('../config');

// ---------------------------------------------------------------------------
// Semantic Discord event helpers
// ---------------------------------------------------------------------------
// Thin wrappers around discordService.event() so controllers stay readable and
// every event uses consistent embeds/fields. All calls are safe to make even
// when the webhook is disabled (they simply no-op).
// ---------------------------------------------------------------------------

function demoField(demo) {
  if (!demo) return '-';
  const name = demo.name || demo.slug || `#${demo.id}`;
  return `${name} (\`${demo.slug || demo.id}\`)`;
}

function reqFields(req) {
  return [
    { name: 'IP', value: discord.clientIp(req), inline: true },
    { name: 'User-Agent', value: truncateUA(discord.userAgent(req)), inline: false }
  ];
}

function truncateUA(ua) {
  return String(ua || 'unknown').slice(0, 200);
}

const events = {
  // ---- Admin auth --------------------------------------------------------
  adminLogin(req, admin) {
    discord.event('admin.login', {
      title: 'Admin ingelogd',
      color: 'success',
      description: `**${admin.username}** is ingelogd.`,
      fields: [
        { name: 'Admin', value: admin.username, inline: true },
        { name: 'Admin ID', value: String(admin.id), inline: true },
        ...reqFields(req)
      ]
    });
  },

  adminLoginFailed(req, username, reason = 'Ongeldige inloggegevens') {
    discord.event('admin.login_failed', {
      title: 'Mislukte admin login',
      color: 'security',
      description: reason,
      fields: [
        { name: 'Gebruikersnaam', value: username || '-', inline: true },
        { name: 'Pogingen limiet', value: '20 per 15 min', inline: true },
        ...reqFields(req)
      ]
    });
  },

  adminLogout(req, username) {
    discord.event('admin.logout', {
      title: 'Admin uitgelogd',
      color: 'muted',
      fields: [
        { name: 'Admin', value: username || (req.session && req.session.username) || '-', inline: true },
        ...reqFields(req)
      ]
    });
  },

  // ---- Demo lifecycle (admin) -------------------------------------------
  demoCreated(req, demo) {
    discord.event('demo.create', {
      title: 'Demo aangemaakt',
      color: 'success',
      fields: [
        { name: 'Demo', value: demoField(demo), inline: true },
        { name: 'Slug', value: demo.slug || '-', inline: true },
        { name: 'Start commando', value: `\`${demo.start_command || '-'}\``, inline: false },
        { name: 'Door', value: (req.session && req.session.username) || 'admin', inline: true }
      ]
    });
  },

  demoUpdated(req, demo, details) {
    discord.event('demo.update', {
      title: 'Demo bijgewerkt',
      color: 'admin',
      fields: [
        { name: 'Demo', value: demoField(demo), inline: true },
        { name: 'Door', value: (req.session && req.session.username) || 'admin', inline: true },
        details ? { name: 'Wijzigingen', value: details, inline: false } : null
      ].filter(Boolean)
    });
  },

  demoDeleted(req, demo) {
    discord.event('demo.delete', {
      title: 'Demo verwijderd',
      color: 'error',
      fields: [
        { name: 'Demo', value: demoField(demo), inline: true },
        { name: 'Door', value: (req.session && req.session.username) || 'admin', inline: true }
      ]
    });
  },

  demoAction(req, demo, action, extra = {}) {
    const labels = {
      start: 'Demo gestart',
      stop: 'Demo gestopt',
      restart: 'Demo herstart',
      reset: 'Demo gereset'
    };
    const colors = {
      start: 'success',
      stop: 'warning',
      restart: 'info',
      reset: 'warning'
    };
    const fields = [
      { name: 'Demo', value: demoField(demo), inline: true },
      { name: 'Door', value: (req.session && req.session.username) || 'admin', inline: true }
    ];
    if (extra.sessionToken) {
      fields.push({ name: 'Sessie', value: `\`${String(extra.sessionToken).slice(0, 16)}...\``, inline: false });
    }
    if (extra.error) {
      fields.push({ name: 'Fout', value: extra.error, inline: false });
    }
    discord.event(`demo.${action}`, {
      title: labels[action] || `Demo ${action}`,
      color: extra.error ? 'error' : (colors[action] || 'info'),
      fields
    });
  },

  // ---- Demo lifecycle (public/visitor) ----------------------------------
  publicDemoAction(demo, action, req, extra = {}) {
    const labels = {
      start: 'Demo gestart door bezoeker',
      stop: 'Demo gestopt door bezoeker',
      reset: 'Demo gereset door bezoeker'
    };
    const colors = { start: 'session', stop: 'warning', reset: 'warning' };
    const fields = [
      { name: 'Demo', value: demoField(demo), inline: true },
      ...reqFields(req)
    ];
    if (extra.sessionToken) {
      fields.push({ name: 'Sessie', value: `\`${String(extra.sessionToken).slice(0, 16)}...\``, inline: false });
    }
    if (extra.error) {
      fields.push({ name: 'Fout', value: extra.error, inline: false });
    }
    discord.event(`demo.public_${action}`, {
      title: labels[action] || `Demo ${action}`,
      color: extra.error ? 'error' : (colors[action] || 'info'),
      fields
    });
  },

  // ---- Sessions ----------------------------------------------------------
  sessionCreated(demo, session, extra = {}) {
    const sessionRef = session.sessionToken || session.session_token || `#${session.id}`;
    const fields = [
      { name: 'Demo', value: demoField(demo), inline: true },
      { name: 'Sessie', value: `\`${String(sessionRef).slice(0, 16)}\``, inline: true }
    ];
    if (extra.containerId) {
      fields.push({ name: 'Container', value: `\`${String(extra.containerId).slice(0, 12)}\``, inline: true });
    }
    if (extra.containerPort) {
      fields.push({ name: 'Poort', value: String(extra.containerPort), inline: true });
    }
    discord.event('session.create', {
      title: 'Demo sessie gestart',
      color: 'session',
      fields
    });
  },

  sessionEnded(demo, session, trigger = 'handmatig') {
    discord.event('session.end', {
      title: 'Demo sessie beeindigd',
      color: 'muted',
      fields: [
        { name: 'Demo', value: demoField(demo), inline: true },
        { name: 'Sessie', value: `\`${String(session.session_token || '').slice(0, 16)}...\``, inline: true },
        { name: 'Reden', value: trigger, inline: false }
      ]
    });
  },

  sessionFailed(demo, err) {
    discord.event('session.failed', {
      title: 'Demo sessie mislukt',
      color: 'error',
      description: err && err.message ? err.message : String(err),
      fields: [
        { name: 'Demo', value: demoField(demo), inline: true }
      ]
    });
  },

  sessionReaped(session, reason) {
    discord.event('session.expired', {
      title: 'Sessie opgeruimd',
      color: 'warning',
      fields: [
        { name: 'Sessie', value: `\`${String(session.session_token || session.id).slice(0, 16)}\``, inline: true },
        { name: 'Demo ID', value: String(session.demo_id), inline: true },
        { name: 'Reden', value: reason, inline: false }
      ]
    });
  },

  // ---- Docker ------------------------------------------------------------
  imageBuilt(demo, tag) {
    discord.event('docker.image_build', {
      title: 'Docker image gebouwd',
      color: 'docker',
      fields: [
        { name: 'Demo', value: demoField(demo), inline: true },
        { name: 'Image', value: `\`${tag}\``, inline: true }
      ]
    });
  },

  containerCreated(demo, container, port) {
    discord.event('docker.container_create', {
      title: 'Docker container gestart',
      color: 'docker',
      fields: [
        { name: 'Demo', value: demoField(demo), inline: true },
        { name: 'Container', value: `\`${String(container.id || container).slice(0, 12)}\``, inline: true },
        port ? { name: 'Poort', value: String(port), inline: true } : null
      ].filter(Boolean)
    });
  },

  containerRemoved(containerId, demo) {
    discord.event('docker.container_remove', {
      title: 'Docker container verwijderd',
      color: 'muted',
      fields: [
        { name: 'Container', value: `\`${String(containerId).slice(0, 12)}\``, inline: true },
        demo ? { name: 'Demo', value: demoField(demo), inline: true } : null
      ].filter(Boolean)
    });
  },

  // ---- Security ----------------------------------------------------------
  rateLimited(req, limiter) {
    discord.event('security.rate_limit', {
      title: 'Rate limit bereikt',
      color: 'security',
      fields: [
        { name: 'Limiter', value: limiter || 'onbekend', inline: true },
        { name: 'Route', value: `\`${req.originalUrl || req.url}\``, inline: false },
        ...reqFields(req)
      ]
    });
  },

  csrfRejected(req) {
    discord.event('security.csrf', {
      title: 'CSRF-verzoek geweigerd',
      color: 'security',
      fields: [
        { name: 'Route', value: `\`${req.originalUrl || req.url}\``, inline: false },
        ...reqFields(req)
      ]
    });
  },

  // ---- Errors / lifecycle ------------------------------------------------
  unhandledError(req, err) {
    discord.event('error.unhandled', {
      title: 'Onbehandelde serverfout',
      color: 'error',
      description: `**${err && err.message ? err.message : String(err)}**`,
      fields: [
        { name: 'Route', value: `\`${req ? (req.method + ' ' + (req.originalUrl || req.url)) : '-'}\``, inline: false },
        { name: 'Stack', value: `\`\`\`${String((err && err.stack) || '').slice(0, 900)}\`\`\``, inline: false },
        ...(req ? reqFields(req) : [])
      ]
    });
  },

  serverStart(port) {
    discord.event('server.start', {
      title: 'MindDemo server gestart',
      color: 'success',
      fields: [
        { name: 'Poort', value: String(port), inline: true },
        { name: 'Omgeving', value: config.NODE_ENV, inline: true },
        { name: 'URL', value: config.APP_URL, inline: false }
      ]
    });
  },

  serverStop(reason = 'SIGTERM') {
    discord.event('server.stop', {
      title: 'MindDemo server gestopt',
      color: 'warning',
      fields: [{ name: 'Reden', value: reason, inline: true }]
    });
  },

  // ---- Agent servers -----------------------------------------------------
  serverAdded(req, server) {
    discord.event('server.add', {
      title: 'Server toegevoegd',
      color: 'success',
      fields: [
        { name: 'Server', value: server.name, inline: true },
        { name: 'Control URL', value: server.control_url || '-', inline: false },
        { name: 'Door', value: (req && req.session && req.session.username) || 'admin', inline: true }
      ]
    });
  },

  serverRemoved(req, server) {
    discord.event('server.remove', {
      title: 'Server verwijderd',
      color: 'error',
      fields: [
        { name: 'Server', value: server.name, inline: true },
        { name: 'Door', value: (req && req.session && req.session.username) || 'admin', inline: true }
      ]
    });
  },

  serverStatus(server, status) {
    discord.event(`server.${status}`, {
      title: `Server ${status}`,
      color: status === 'online' ? 'success' : (status === 'degraded' ? 'warning' : 'muted'),
      fields: [{ name: 'Server', value: server.name || server.id, inline: true }]
    });
  },

  agentEvent(server, event, detail) {
    discord.event('agent.' + event, {
      title: `Agent event: ${event}`,
      color: /fail|error/i.test(event) ? 'error' : 'info',
      fields: [
        { name: 'Server', value: server.name || server.id, inline: true },
        detail ? { name: 'Detail', value: detail, inline: false } : null
      ].filter(Boolean)
    });
  },

  test(req) {
    discord.event('test', {
      title: 'Discord webhook test',
      color: 'success',
      description: 'De MindDemo webhook is correct geconfigureerd.',
      fields: [
        { name: 'Door', value: (req && req.session && req.session.username) || 'systeem', inline: true },
        { name: 'Omgeving', value: config.NODE_ENV, inline: true },
        ...(req ? reqFields(req) : [])
      ]
    });
  }
};

module.exports = events;
