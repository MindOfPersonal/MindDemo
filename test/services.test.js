const test = require('node:test');
const assert = require('node:assert');
const path = require('path');

const { parseCommand } = require('../src/services/dockerService');
const { validateZip } = require('../src/utils/zipHandler');
const discord = require('../src/services/discordService');
const config = require('../src/config');

test('parseCommand splits on whitespace', () => {
  assert.deepStrictEqual(parseCommand('npm start'), ['npm', 'start']);
});

test('parseCommand respects quoted arguments', () => {
  assert.deepStrictEqual(
    parseCommand('node "my server.js" --port 3000'),
    ['node', 'my server.js', '--port', '3000']
  );
  assert.deepStrictEqual(
    parseCommand("node 'a b' -x"),
    ['node', 'a b', '-x']
  );
});

test('validateZip rejects a missing file', async () => {
  await assert.rejects(
    () => validateZip(path.join(__dirname, 'does-not-exist.zip')),
    /does not exist/
  );
});

test('discord event allow-list supports categories and wildcard', () => {
  const original = config.DISCORD.EVENTS;
  try {
    config.DISCORD.EVENTS = 'demo,admin.login';
    assert.strictEqual(discord.isEventAllowed('demo.create'), true);
    assert.strictEqual(discord.isEventAllowed('admin.login'), true);
    assert.strictEqual(discord.isEventAllowed('session.create'), false);

    config.DISCORD.EVENTS = '*';
    assert.strictEqual(discord.isEventAllowed('anything.at.all'), true);
  } finally {
    config.DISCORD.EVENTS = original;
  }
});

test('discord event is a no-op when disabled', () => {
  const original = config.DISCORD.ENABLED;
  const before = discord._queue.length;
  try {
    config.DISCORD.ENABLED = false;
    discord.event('test', { title: 'x' });
    assert.strictEqual(discord._queue.length, before);
  } finally {
    config.DISCORD.ENABLED = original;
  }
});

test('discord buildEmbed truncates oversized values', () => {
  const embed = discord.buildEmbed({
    title: 't'.repeat(500),
    fields: [{ name: 'n'.repeat(500), value: 'v'.repeat(2000) }]
  });
  assert.ok(embed.title.length <= 256);
  assert.ok(embed.fields[0].name.length <= 256);
  assert.ok(embed.fields[0].value.length <= 1024);
  assert.ok(embed.color > 0);
});
