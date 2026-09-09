// Deterministic web-fetch security guards (no network).
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const guard = require('../electron/webguard.cjs');

export async function runWebSecurityTests() {
  // Private/local classification
  for (const host of ['localhost', '127.0.0.1', '127.8.9.10', '10.1.2.3', '172.16.0.1', '172.31.255.255', '192.168.1.1', '169.254.1.1', '0.0.0.0', '::1']) {
    assert.equal(guard.isPrivateHost(host), true, host + ' is private/local');
  }
  for (const host of ['example.com', '8.8.8.8', '172.32.0.1', '11.0.0.1']) {
    assert.equal(guard.isPrivateHost(host), false, host + ' is public');
  }
  // Redirect policy
  const pub = new URL('https://example.com/a');
  const toLocal = new URL('http://127.0.0.1/x');
  const toPrivate = new URL('http://192.168.0.5/x');
  const toPublic = new URL('https://other.example/b');
  const local = new URL('http://127.0.0.1/start');
  assert.equal(guard.validateRedirectTarget(pub, toLocal).ok, false, 'public -> localhost blocked');
  assert.equal(guard.validateRedirectTarget(pub, toPrivate).ok, false, 'public -> private blocked');
  assert.equal(guard.validateRedirectTarget(pub, toPublic).ok, true, 'public -> public allowed');
  assert.equal(guard.validateRedirectTarget(local, toLocal).ok, true, 'localhost -> localhost allowed');
  assert.equal(guard.validateRedirectTarget(pub, new URL('file:///etc/passwd')).ok, false, 'non-http scheme blocked');
  assert.equal(guard.validateRedirectTarget(pub, new URL('https://user:pw@example.com/x')).ok, false, 'credential URL blocked');
  assert.equal(guard.hasUserinfo(new URL('https://user:pass@example.com/')), true, 'userinfo detected');
  assert.equal(guard.hasUserinfo(new URL('https://example.com/')), false, 'no userinfo');
  console.log('Web security guard tests passed.');
}