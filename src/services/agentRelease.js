const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { execFile } = require('child_process');
const { promisify } = require('util');
const config = require('../config');
const logger = require('../utils/logger');

const execFileAsync = promisify(execFile);

// ---------------------------------------------------------------------------
// Agent release distribution.
// ---------------------------------------------------------------------------
// The MindDemo-agent repository is private, which makes it awkward to install
// on external servers. This service packages the agent source that lives on
// the MindDemo host into a deterministic tarball and exposes a release feed
// plus a bootstrap installer, all served by MindDemo itself.
// ---------------------------------------------------------------------------

// Never ship these into the release artifact. node_modules is rebuilt on the
// target by the installer (npm install --omit=dev), which keeps the archive
// small and portable across architectures.
const EXCLUDES = ['node_modules', '.git', 'data', 'storage', 'test', 'coverage', '.env'];
const MAX_ARCHIVE_BYTES = 200 * 1024 * 1024;

function sourceDir(dir) {
  return dir || config.AGENT.SOURCE_DIR;
}

function packagePath(dir) {
  return path.join(sourceDir(dir), 'package.json');
}

function sourceMissing(dir) {
  const err = new Error(`Agent source not found at ${sourceDir(dir)} (set AGENT_SOURCE_DIR)`);
  err.code = 'AGENT_SOURCE_MISSING';
  return err;
}

function readPackage(dir) {
  const pkgPath = packagePath(dir);
  if (!fs.existsSync(pkgPath)) throw sourceMissing(dir);
  try {
    return JSON.parse(fs.readFileSync(pkgPath, 'utf8'));
  } catch (err) {
    const parseErr = new Error(`Invalid agent package.json at ${pkgPath}: ${err.message}`);
    parseErr.code = 'AGENT_SOURCE_INVALID';
    throw parseErr;
  }
}

function getVersion(dir) {
  return readPackage(dir).version || '0.0.0';
}

function getReleasedAt(dir) {
  try {
    return fs.statSync(packagePath(dir)).mtime.toISOString();
  } catch {
    return null;
  }
}

function archiveName(version) {
  return `mindagent-${version}.tar.gz`;
}

// A short-lived per-directory cache. The TTL (rather than caching until the
// version changes) keeps the served build fresh while the source is edited
// without bumping package.json, and keeps install.sh + tarball consistent
// within a single install run.
const CACHE_TTL_MS = 15000;
const cache = new Map(); // dir -> { version, buffer, sha256, builtAt }
const building = new Map(); // dir -> Promise (dedupe concurrent builds)

async function buildArchive({ dir, force = false } = {}) {
  const root = sourceDir(dir);
  const version = getVersion(root);
  const cached = cache.get(root);
  if (!force && cached && cached.version === version && (Date.now() - cached.builtAt) < CACHE_TTL_MS) {
    return cached;
  }
  if (building.has(root)) return building.get(root);

  const pending = (async () => {
    const args = ['-czf', '-', '-C', root];
    for (const entry of EXCLUDES) args.push(`--exclude=./${entry}`);
    args.push('.');
    const { stdout } = await execFileAsync('tar', args, {
      encoding: 'buffer',
      maxBuffer: MAX_ARCHIVE_BYTES
    });
    const buffer = Buffer.from(stdout);
    const result = {
      version,
      buffer,
      sha256: crypto.createHash('sha256').update(buffer).digest('hex'),
      builtAt: Date.now()
    };
    cache.set(root, result);
    logger.info(`agentRelease.archive_built version=${version} bytes=${buffer.length}`);
    return result;
  })();

  building.set(root, pending);
  try {
    return await pending;
  } finally {
    building.delete(root);
  }
}

function releaseInfo(baseUrl, { version, sha256, releasedAt } = {}) {
  return {
    version,
    channel: 'stable',
    released_at: releasedAt || null,
    url: `${baseUrl}/agent/${archiveName(version)}`,
    sha256: sha256 || null,
    signature: null,
    notes: null
  };
}

function releaseFeed(baseUrl, release) {
  return {
    schema: 1,
    generated_at: new Date().toISOString(),
    channels: {
      stable: release,
      beta: release,
      nightly: release
    }
  };
}

// The public bootstrap installer. It resolves the (currently built) release at
// generation time, verifies the SHA256, extracts the archive and delegates to
// the bundled install.sh, forwarding any flags (--control, --token, ...).
function installScript(baseUrl, { version, sha256, channel = 'stable' } = {}) {
  return `#!/usr/bin/env bash
# ---------------------------------------------------------------------------
# MindAgent bootstrap installer (served by MindDemo).
#
#   curl -fsSL ${baseUrl}/agent/install.sh -o install.sh
#   less install.sh
#   sudo bash install.sh --control wss://<minddemo-host>/agent/ws --token <TOKEN> --yes
# ---------------------------------------------------------------------------
set -euo pipefail

BASE_URL="\${MINDAGENT_BASE_URL:-${baseUrl}}"
VERSION="\${MINDAGENT_VERSION:-${version}}"
CHANNEL="\${MINDAGENT_CHANNEL:-${channel}}"
TARBALL_URL="\${BASE_URL}/agent/mindagent-\${VERSION}.tar.gz"
EXPECTED_SHA256="${sha256 || ''}"

log()  { printf '  %s\\n' "$*"; }
fail() { printf 'error: %s\\n' "$*" >&2; exit 1; }

[ "$(id -u)" -eq 0 ] || fail "run as root (sudo)"

WORKDIR="$(mktemp -d /tmp/mindagent.XXXXXX)"
cleanup() { rm -rf "$WORKDIR"; }
trap cleanup EXIT

log "Downloading MindAgent \${VERSION} (\${CHANNEL}) from \${BASE_URL}"
if command -v curl >/dev/null 2>&1; then
  curl -fsSL "$TARBALL_URL" -o "$WORKDIR/agent.tar.gz"
elif command -v wget >/dev/null 2>&1; then
  wget -qO "$WORKDIR/agent.tar.gz" "$TARBALL_URL"
else
  fail "curl or wget is required"
fi

if [ -n "$EXPECTED_SHA256" ] && command -v sha256sum >/dev/null 2>&1; then
  ACTUAL_SHA256="$(sha256sum "$WORKDIR/agent.tar.gz" | awk '{print $1}')"
  [ "$ACTUAL_SHA256" = "$EXPECTED_SHA256" ] || fail "checksum mismatch (got $ACTUAL_SHA256)"
  log "Checksum verified."
fi

tar -xzf "$WORKDIR/agent.tar.gz" -C "$WORKDIR"
[ -f "$WORKDIR/install.sh" ] || fail "install.sh not found in the release archive"

log "Running the MindAgent installer..."
bash "$WORKDIR/install.sh" "$@"
`;
}

module.exports = {
  getVersion,
  getReleasedAt,
  buildArchive,
  releaseInfo,
  releaseFeed,
  installScript,
  archiveName,
  sourceDir,
  EXCLUDES
};
