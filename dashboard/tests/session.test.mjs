// The dashboard is a single file with a top-level server; this test boots it on
// a spare port with the release gate bypassed and exercises the real login path.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)));
// ROOT is the dashboard directory; the service root is its parent.
const API_ROOT = process.env.BUDDY_ROOT || dirname(ROOT);
const PORT = 3299;
const BASE = 'http://127.0.0.1:' + PORT + '/dashboard';
let child;
let key;

before(async () => {
  key = (await readFile(join(API_ROOT, 'secrets', 'dashboard-key.txt'), 'utf8')).trim();
  child = spawn(process.execPath, [join(ROOT, 'dashboard.mjs')], {
    cwd: ROOT,
    env: { ...process.env, BUDDY_DASHBOARD_PORT: String(PORT), BUDDY_DASHBOARD_ALLOW_UNVERIFIED: '1' },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  for (let i = 0; i < 60; i++) {
    try { if ((await fetch(BASE + '/')).ok) return; } catch {}
    await new Promise(resolve => setTimeout(resolve, 100));
  }
  throw new Error('dashboard did not start');
});

after(async () => {
  child?.kill();
  await new Promise(resolve => setTimeout(resolve, 200));
});

const cookieOf = response => {
  const raw = response.headers.get('set-cookie') || '';
  const match = /buddy_dash=([A-Za-z0-9-]{36})/.exec(raw);
  return match ? { id: match[1], raw } : null;
};

async function login(next = '') {
  const response = await fetch(BASE + '/login', {
    method: 'POST',
    redirect: 'manual',
    headers: { 'content-type': 'application/x-www-form-urlencoded', 'x-forwarded-proto': 'https' },
    body: new URLSearchParams({ token: key, next }),
  });
  return { response, cookie: cookieOf(response) };
}

test('unauthenticated visitors are still blocked', async () => {
  for (const path of ['/', '/accounts', '/api/data', '/api/usage', '/api/accounts', '/api/active-account']) {
    const response = await fetch(BASE + path, { redirect: 'manual' });
    assert.equal(response.status, path.startsWith('/api/') ? 401 : 200, path);
    if (!path.startsWith('/api/')) assert.match(await response.text(), /name="token"/);
  }
  const write = await fetch(BASE + '/api/active-account', {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: '{"id":"a"}',
  });
  assert.equal(write.status, 401);
});

test('one login yields a Lax, HttpOnly, Secure cookie and keeps working on every page', async () => {
  const { response, cookie } = await login();
  assert.equal(response.status, 303);
  assert.ok(cookie, 'session cookie issued');
  assert.match(cookie.raw, /HttpOnly/);
  assert.match(cookie.raw, /SameSite=Lax/, 'Lax so a top-level visit from another origin keeps the session');
  assert.match(cookie.raw, /Secure/, 'Secure because the public request is https');
  const headers = { cookie: 'buddy_dash=' + cookie.id };
  for (const path of ['/', '/accounts', '/api/data', '/api/usage', '/api/accounts', '/api/active-account']) {
    const res = await fetch(BASE + path, { headers, redirect: 'manual' });
    assert.equal(res.status, 200, path);
    if (!path.startsWith('/api/')) assert.doesNotMatch(await res.text(), /name="token"/, path);
  }
});

test('login returns to the requested page instead of bouncing to the overview', async () => {
  const { response } = await login('/dashboard/accounts');
  assert.equal(response.headers.get('location'), '/dashboard/accounts');
  const foreign = await login('https://evil.example/steal');
  assert.equal(foreign.response.headers.get('location'), '/dashboard/');
  const protocolRelative = await login('//evil.example');
  assert.equal(protocolRelative.response.headers.get('location'), '/dashboard/');
});

test('a management action does not ask for a password again', async () => {
  const { cookie } = await login();
  const headers = { cookie: 'buddy_dash=' + cookie.id, 'content-type': 'application/json', origin: 'http://127.0.0.1:' + PORT };
  const res = await fetch(BASE + '/api/accounts/verify', {
    method: 'POST', headers, body: JSON.stringify({ id: 'a' }),
  });
  // The point of this test is that the action runs without a second password.
  // Whether the snapshot exists is a property of the data directory, not of
  // authentication: a fresh checkout has no account 'a' and answers 400.
  assert.notEqual(res.status, 401, 'session must authorise the write');
  const body = await res.json();
  if (res.status === 200) assert.equal(body.ok, true);
  else assert.equal(body.error, 'not_found', 'only a missing snapshot may fail here');
  // The session is untouched: the next page render still authorises.
  const page = await fetch(BASE + '/accounts', { headers: { cookie: 'buddy_dash=' + cookie.id } });
  assert.equal(page.status, 200);
  assert.doesNotMatch(await page.text(), /name="token"/);
});

test('cross-origin writes are rejected and bearer-key clients still work', async () => {
  const { cookie } = await login();
  const bad = await fetch(BASE + '/api/active-account', {
    method: 'POST',
    headers: { cookie: 'buddy_dash=' + cookie.id, 'content-type': 'application/json', origin: 'https://evil.example' },
    body: '{"id":"a"}',
  });
  assert.equal(bad.status, 403);
  const bearer = await fetch(BASE + '/api/accounts', { headers: { authorization: 'Bearer ' + key } });
  assert.equal(bearer.status, 200);
});

test('sessions are persisted as digests, never as the cookie value', async () => {
  const { cookie } = await login();
  await new Promise(resolve => setTimeout(resolve, 300));
  const raw = await readFile(join(API_ROOT, 'data', 'dashboard-sessions.json'), 'utf8');
  assert.ok(!raw.includes(cookie.id), 'raw session id must not be on disk');
  const doc = JSON.parse(raw);
  const digest = createHash('sha256').update(cookie.id).digest('hex');
  assert.ok(doc.sessions.some(entry => entry.id === digest));
});

test('bad key and logout still behave', async () => {
  const wrong = await fetch(BASE + '/login', {
    method: 'POST', redirect: 'manual',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ token: 'x'.repeat(64) }),
  });
  assert.equal(wrong.status, 401);
  const { cookie } = await login();
  const out = await fetch(BASE + '/logout', { redirect: 'manual', headers: { cookie: 'buddy_dash=' + cookie.id } });
  assert.equal(out.status, 303);
  const after = await fetch(BASE + '/api/accounts', { headers: { cookie: 'buddy_dash=' + cookie.id } });
  assert.equal(after.status, 401);
});
