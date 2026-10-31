const express = require('express');
const config = require('../config');
const release = require('../services/agentRelease');
const logger = require('../utils/logger');

// ---------------------------------------------------------------------------
// Admin endpoints for the agent release: what version is available, a direct
// download (behind the admin session) and the exact install command.
// ---------------------------------------------------------------------------

const router = express.Router();

function baseUrl() {
  return (config.APP_URL || '').replace(/\/$/, '');
}

function controlUrl() {
  return `${(config.APP_URL || '').replace(/^http/, 'ws').replace(/\/$/, '')}/agent/ws`;
}

function installCommand({ token = '<AGENT_TOKEN>', control = controlUrl() } = {}) {
  const base = baseUrl();
  return [
    `curl -fsSL ${base}/agent/install.sh -o /tmp/mindagent-install.sh`,
    `sudo bash /tmp/mindagent-install.sh --control ${control} --token ${token} --yes`
  ].join('\n');
}

router.get('/release', async (req, res) => {
  try {
    const { version, sha256 } = await release.buildArchive();
    res.json({
      version,
      sha256,
      released_at: release.getReleasedAt(),
      download_url: `${baseUrl()}/agent/agent.tar.gz`,
      install_script_url: `${baseUrl()}/agent/install.sh`,
      feed_url: `${baseUrl()}/agent/releases.json`,
      control_url: controlUrl(),
      install_command: installCommand()
    });
  } catch (err) {
    logger.error('Agent release info error:', err.message);
    res.status(err.code === 'AGENT_SOURCE_MISSING' ? 503 : 500).json({
      error: err.message,
      code: err.code || 'AGENT_RELEASE_ERROR'
    });
  }
});

router.get('/download', async (req, res) => {
  try {
    const archive = await release.buildArchive();
    const name = release.archiveName(archive.version);
    res.set({
      'Content-Type': 'application/gzip',
      'Content-Disposition': `attachment; filename="${name}"`,
      'Content-Length': String(archive.buffer.length),
      'X-Checksum-Sha256': archive.sha256
    });
    res.send(archive.buffer);
  } catch (err) {
    logger.error('Agent download error:', err.message);
    res.status(503).json({ error: err.message, code: err.code || 'AGENT_RELEASE_ERROR' });
  }
});

module.exports = { router, installCommand, controlUrl, baseUrl };
