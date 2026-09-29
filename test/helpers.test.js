const test = require('node:test');
const assert = require('node:assert');

const {
  generateSlug,
  generateUniqueSlug,
  generateSessionToken,
  generateVisitorToken
} = require('../src/utils/helpers');

test('generateSlug normalizes to lowercase kebab-case', () => {
  assert.strictEqual(generateSlug('Hello World!'), 'hello-world');
  assert.strictEqual(generateSlug('  Multiple   Spaces  '), 'multiple-spaces');
});

test('generateSlug falls back to "demo" for empty input', () => {
  assert.strictEqual(generateSlug('!!!'), 'demo');
  assert.strictEqual(generateSlug(''), 'demo');
});

test('generateUniqueSlug appends a random hex suffix', () => {
  const a = generateUniqueSlug('My App');
  const b = generateUniqueSlug('My App');
  assert.match(a, /^my-app-[0-9a-f]{6}$/);
  assert.notStrictEqual(a, b);
});

test('generateSessionToken is a 12-char hex string', () => {
  assert.match(generateSessionToken(), /^[0-9a-f]{12}$/);
});

test('generateVisitorToken is a uuid', () => {
  assert.match(generateVisitorToken(), /^[0-9a-f-]{36}$/);
});
