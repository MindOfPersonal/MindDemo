const express = require('express');
const config = require('../config');
const release = require('../services/agentRelease');
const logger = require('../utils/logger');

// ---------------------------------------------------------------------------
// Public agent release distribution.
// ---------------------------------------------------------------------------
// These endpoints are intentionally unauthenticated: target servers and the
// agents themselves fetch from them. They expose only the agent program (no
// secrets), which is exactly the artifact we want to distribute without
// requiring access to the private Git repository.
// ---------------------------------------------------------------------------

const router = express.Router();

function baseUrl(req) {
  if (config.APP_URL && /^https?:\/\//.test(config.APP_URL)) {
    return config.APP_URL.replace(/\/$/, '');
  }
  return `${req.protocol}://${req.get('host')}`;
}

function handleMissing(res, err) {
  logger.error('Agent release error:', err.message);
  res.status(503).type('text/plain').send(`Agent release unavailable: ${err.message}\n`);
}

router.get('/version', (req, res) => {
  try {
    res.type('text/plain').send(`${release.getVersion()}\n`);
  } catch (err) {
    handleMissing(res, err);
  }
});

router.get('/releases.json', async (req, res) => {
  try {
    const { version, sha256 } = await release.buildArchive();
    const info = release.releaseInfo(baseUrl(req), {
      version,
      sha256,
      releasedAt: release.getReleasedAt()
    });
    res.set('Cache-Control', 'public, max-age=60');
    res.json(release.releaseFeed(baseUrl(req), info));
  } catch (err) {
    handleMissing(res, err);
  }
});

router.get('/install.sh', async (req, res) => {
  try {
    const { version, sha256 } = await release.buildArchive();
    const script = release.installScript(baseUrl(req), { version, sha256 });
    res.type('text/x-shellscript').send(script);
  } catch (err) {
    handleMissing(res, err);
  }
});

router.get('/agent.tar.gz', sendArchive);
router.get('/mindagent-:version.tar.gz', sendArchive);

async function sendArchive(req, res) {
  try {
    const archive = await release.buildArchive();
    const name = release.archiveName(archive.version);
    res.set({
      'Content-Type': 'application/gzip',
      'Content-Disposition': `attachment; filename="${name}"`,
      'Content-Length': String(archive.buffer.length),
      'X-Checksum-Sha256': archive.sha256,
      'Cache-Control': 'public, max-age=300'
    });
    res.send(archive.buffer);
  } catch (err) {
    handleMissing(res, err);
  }
}

module.exports = router;
