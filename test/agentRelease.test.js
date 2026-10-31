const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const zlib = require('zlib');

const release = require('../src/services/agentRelease');

function makeSource() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mindagent-src-'));
  fs.writeFileSync(path.join(dir, 'package.json'), JSON.stringify({ name: 'minddemo-agent', version: '9.9.9' }));
  fs.writeFileSync(path.join(dir, 'install.sh'), '#!/usr/bin/env bash\necho install\n');
  fs.mkdirSync(path.join(dir, 'bin'));
  fs.writeFileSync(path.join(dir, 'bin', 'mindagent'), '#!/usr/bin/env node\n');
  fs.mkdirSync(path.join(dir, 'node_modules'));
  fs.writeFileSync(path.join(dir, 'node_modules', 'dep.js'), 'module.exports = 1;\n');
  fs.mkdirSync(path.join(dir, '.git'));
  fs.writeFileSync(path.join(dir, '.git', 'HEAD'), 'ref: refs/heads/master\n');
  return dir;
}

test('getVersion reads the agent package version', () => {
  const dir = makeSource();
  assert.strictEqual(release.getVersion(dir), '9.9.9');
});

test('getVersion throws a typed error when the source is missing', () => {
  assert.throws(
    () => release.getVersion('/nonexistent/mindagent-source'),
    (err) => err.code === 'AGENT_SOURCE_MISSING'
  );
});

test('buildArchive produces a gzip tarball with install.sh at the root and no node_modules/.git', async () => {
  const dir = makeSource();
  const archive = await release.buildArchive({ dir, force: true });

  assert.strictEqual(archive.version, '9.9.9');
  assert.ok(archive.buffer.length > 0);
  assert.match(archive.sha256, /^[0-9a-f]{64}$/);

  const listing = zlib.gunzipSync(archive.buffer).toString('latin1');
  assert.ok(listing.includes('./install.sh'));
  assert.ok(listing.includes('./bin/mindagent'));
  assert.ok(!listing.includes('node_modules'));
  assert.ok(!listing.includes('.git'));
});

test('releaseFeed exposes the built version under the stable channel', async () => {
  const dir = makeSource();
  const archive = await release.buildArchive({ dir, force: true });
  const info = release.releaseInfo('https://demo.example', {
    version: archive.version,
    sha256: archive.sha256
  });
  const feed = release.releaseFeed('https://demo.example', info);

  assert.strictEqual(feed.channels.stable.version, '9.9.9');
  assert.strictEqual(feed.channels.stable.url, 'https://demo.example/agent/mindagent-9.9.9.tar.gz');
  assert.strictEqual(feed.channels.stable.sha256, archive.sha256);
});

test('installScript pins the version and checksum and forwards arguments', () => {
  const script = release.installScript('https://demo.example', { version: '9.9.9', sha256: 'abc123' });
  assert.ok(script.includes('https://demo.example'));
  assert.ok(script.includes('9.9.9'));
  assert.ok(script.includes('abc123'));
  assert.ok(script.includes('sha256sum'));
  assert.ok(script.includes('install.sh'));
  assert.ok(script.includes('"$@"'));
});
