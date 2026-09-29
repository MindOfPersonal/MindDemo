const test = require('node:test');
const assert = require('node:assert');

const { csrfProtection, originGuard, newCSRFToken } = require('../src/middleware/csrf');

function mockRes() {
  return {
    statusCode: 200,
    body: null,
    status(code) { this.statusCode = code; return this; },
    json(payload) { this.body = payload; return this; }
  };
}

test('csrfProtection allows safe methods', () => {
  let called = false;
  const req = { method: 'GET' };
  csrfProtection(req, mockRes(), () => { called = true; });
  assert.strictEqual(called, true);
});

test('csrfProtection rejects a missing token', () => {
  const res = mockRes();
  const req = { method: 'POST', body: {}, session: { csrfToken: 'abc' }, get: () => undefined };
  csrfProtection(req, res, () => { throw new Error('should not pass'); });
  assert.strictEqual(res.statusCode, 403);
});

test('csrfProtection rejects a token of a different length without throwing', () => {
  const res = mockRes();
  const req = { method: 'POST', body: { _csrf: 'short' }, session: { csrfToken: 'a'.repeat(64) }, get: () => undefined };
  assert.doesNotThrow(() => csrfProtection(req, res, () => { throw new Error('should not pass'); }));
  assert.strictEqual(res.statusCode, 403);
});

test('csrfProtection accepts a matching token', () => {
  let called = false;
  const token = newCSRFToken({});
  const req = { method: 'POST', body: { _csrf: token }, session: { csrfToken: token }, get: () => undefined };
  csrfProtection(req, mockRes(), () => { called = true; });
  assert.strictEqual(called, true);
});

test('originGuard blocks a mismatching origin', () => {
  const res = mockRes();
  const req = {
    get(name) {
      if (name === 'origin') return 'https://evil.example';
      if (name === 'host') return 'demo.example';
      return undefined;
    }
  };
  originGuard(req, res, () => { throw new Error('should not pass'); });
  assert.strictEqual(res.statusCode, 403);
});

test('originGuard allows a matching origin', () => {
  let called = false;
  const req = {
    get(name) {
      if (name === 'origin') return 'https://demo.example';
      if (name === 'host') return 'demo.example';
      return undefined;
    }
  };
  originGuard(req, mockRes(), () => { called = true; });
  assert.strictEqual(called, true);
});

test('originGuard allows requests without an origin (non-browser clients)', () => {
  let called = false;
  const req = { get: () => undefined };
  originGuard(req, mockRes(), () => { called = true; });
  assert.strictEqual(called, true);
});
