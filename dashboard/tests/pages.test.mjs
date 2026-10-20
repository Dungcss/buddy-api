// Page shell, model catalog and request-log contract. Boots the real dashboard
// on a spare port with the release gate bypassed, so the assertions describe the
// same code the scheduled task runs.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)));
// Resolve the service root from this file's location so the suite runs from any
// checkout instead of only the original machine.
// ROOT is the dashboard directory; the service root is its parent.
const API_ROOT = process.env.BUDDY_ROOT || dirname(ROOT);
const PORT = 3298;
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
  for (let i = 0; i < 80; i++) {
    try { if ((await fetch(BASE + '/')).ok) return; } catch {}
    await new Promise(resolve => setTimeout(resolve, 100));
  }
  throw new Error('dashboard did not start');
});

after(async () => {
  child?.kill();
  await new Promise(resolve => setTimeout(resolve, 200));
});

const headers = () => ({ authorization: 'Bearer ' + key });

test('every navigation entry serves its own page with the shared rail', async () => {
  const routes = ['/', '/models', '/accounts', '/keys', '/usage', '/logs'];
  for (const route of routes) {
    const res = await fetch(BASE + route, { headers: headers() });
    assert.equal(res.status, 200, route);
    const html = await res.text();
    assert.match(html, /class="rail"/, route + ' rail');
    assert.match(html, /id="themeToggle"/, route + ' theme switch');
    // Exactly one entry is current, and it is the page being served.
    const current = html.match(/class="nav-item current" href="([^"]+)"/g) || [];
    assert.equal(current.length, 1, route + ' active nav');
    assert.ok(current[0].includes('href="/dashboard' + route + '"'), route + ' active href');
  }
});

test('the rail search data is present and unique per entry', async () => {
  const html = await (await fetch(BASE + '/', { headers: headers() })).text();
  const entries = html.match(/data-search="([^"]+)"/g) || [];
  assert.equal(entries.length, 6);
  assert.equal(new Set(entries).size, 6);
});

test('model catalog splits free and paid and keeps the maximum context', async () => {
  const res = await fetch(BASE + '/api/models', { headers: headers() });
  // With no gateway running the dashboard reports 503 instead of inventing a
  // catalog; the contract below applies when the gateway is reachable.
  if (res.status === 503) {
    // Any unreachable-gateway reason is acceptable here; what matters is that
    // the dashboard refuses rather than inventing a catalog.
    const body = await res.json();
    assert.ok(typeof body.error === 'string' && body.error.length > 0);
    assert.ok(!Array.isArray(body.free));
    return;
  }
  assert.equal(res.status, 200);
  const data = await res.json();
  assert.ok(data.free.length >= 3, 'three free models');
  assert.ok(data.paid.length >= 10, 'paid models present');
  assert.equal(data.free.filter(model => model.id === 'deepseek-v4.1-flash').length, 1);
  const deepseek = data.free.find(model => model.id === 'deepseek-v4.1-flash');
  const step = data.free.find(model => model.id === 'step-5-preview');
  assert.equal(deepseek.maxContextWindow, 1000000);
  assert.equal(step.maxContextWindow, 1000000);
  assert.ok(!data.paid.some(model => /gpt/i.test(model.id)), 'no GPT model');
  for (const model of [...data.free, ...data.paid]) {
    assert.equal(typeof model.free, 'boolean');
    assert.ok(Number.isFinite(model.maxContextWindow));
  }
});

test('request log exposes the three outcome classes and pages on the server', async () => {
  const res = await fetch(BASE + '/api/logs?page_size=5', { headers: headers() });
  assert.equal(res.status, 200);
  const data = await res.json();
  assert.ok(data.counts.all >= data.rows.length);
  assert.equal(data.counts.all, data.counts.ok + data.counts.saturated + data.counts.failed);
  assert.ok(data.rows.length <= 5);
  for (const row of data.rows) {
    assert.ok(['ok', 'saturated', 'failed'].includes(row.outcome));
    assert.equal(typeof row.at_local, 'string');
    assert.ok(row.at_local.length === 19, 'local timestamp is second precision');
  }
});

test('the log export is CSV with no credential column', async () => {
  const res = await fetch(BASE + '/api/logs/export?outcome=failed', { headers: headers() });
  assert.equal(res.status, 200);
  assert.match(res.headers.get('content-type'), /text\/csv/);
  assert.match(res.headers.get('content-disposition'), /attachment/);
  const text = await res.text();
  const header = text.replace(/^\ufeff/, '').split('\n')[0];
  assert.equal(header, 'at_utc,at_local,request_id,key,account,model,path,protocol,stream,status,code,upstream_attempts,upstream_retries,ms,input_tokens,output_tokens,cache_write_tokens,cache_read_tokens,total_tokens,usage_source');
  assert.ok(!/cookie|authorization|api_key|apikey/i.test(header));
});

test('usage summary equals the sum of the paged detail rows', async () => {
  const from = new Date(Date.now() - 6 * 3600000).toISOString();
  const query = '?from=' + encodeURIComponent(from) + '&page_size=500';
  const first = await (await fetch(BASE + '/api/usage' + query, { headers: headers() })).json();
  const rows = [...first.details];
  for (let page = 2; page <= first.detail_pages; page++) {
    const next = await (await fetch(BASE + '/api/usage' + query + '&page=' + page, { headers: headers() })).json();
    rows.push(...next.details);
  }
  assert.equal(rows.length, first.detail_count, 'every detail row is reachable by paging');
  for (const field of ['input_tokens', 'output_tokens', 'cache_write_tokens', 'cache_read_tokens', 'total_tokens']) {
    const sum = rows.reduce((acc, row) => typeof row[field] === 'number' ? (acc ?? 0) + row[field] : acc, null);
    assert.equal(first.totals[field], sum, field);
  }
  assert.equal(first.byAccount.reduce((acc, row) => acc + row.requests, 0), first.totals.requests);
  assert.equal(first.byModel.reduce((acc, row) => acc + row.requests, 0), first.totals.requests);
});

test('a missing usage field stays null, never zero', async () => {
  const res = await fetch(BASE + '/api/usage?page_size=500&all=1', { headers: headers() });
  const data = await res.json();
  const withoutUsage = data.details.filter(row => row.usage_present === false);
  for (const row of withoutUsage) {
    assert.equal(row.input_tokens, null);
    assert.equal(row.output_tokens, null);
    assert.equal(row.cache_write_tokens, null);
    assert.equal(row.cache_read_tokens, null);
  }
  assert.ok(data.totals.missing_usage >= withoutUsage.length);
});

test('the key page exists and its API never returns a stored token', async () => {
  const page = await fetch(BASE + '/keys', { headers: headers() });
  assert.equal(page.status, 200);
  const html = await page.text();
  assert.match(html, /id="keyForm"/);
  assert.match(html, /id="keyRows"/);

  const list = await fetch(BASE + '/api/keys', { headers: headers() });
  assert.equal(list.status, 200);
  const data = await list.json();
  assert.ok(Array.isArray(data.keys));
  assert.ok(Array.isArray(data.bootstrap));
  // A list response carries only hints; a full key would be 50+ characters.
  for (const key of data.keys) {
    assert.ok(!/^buddy_sk_[a-f0-9]{40,}$/.test(key.hint || ''));
    assert.ok(!('token' in key));
    assert.ok(!('sha256' in key));
  }
});

test('creating a key requires a same-origin write and returns the token once', async () => {
  const crossOrigin = await fetch(BASE + '/api/keys', {
    method: 'POST',
    headers: { ...headers(), 'content-type': 'application/json', origin: 'https://evil.example' },
    body: JSON.stringify({ label: 'x' }),
  });
  assert.equal(crossOrigin.status, 403);

  const created = await fetch(BASE + '/api/keys', {
    method: 'POST',
    headers: { ...headers(), 'content-type': 'application/json', origin: 'http://127.0.0.1:3298' },
    body: JSON.stringify({ label: 'test-' + Date.now() }),
  });
  assert.equal(created.status, 201);
  const body = await created.json();
  assert.match(body.token, /^buddy_sk_[a-f0-9]+$/);
  assert.ok(!JSON.stringify(body.key).includes(body.token));

  const revoked = await fetch(BASE + '/api/keys/' + body.key.id, {
    method: 'DELETE',
    headers: { ...headers(), origin: 'http://127.0.0.1:3298' },
  });
  assert.equal(revoked.status, 200);
  const after = await (await fetch(BASE + '/api/keys', { headers: headers() })).json();
  const entry = after.keys.find(key => key.id === body.key.id);
  assert.ok(entry.revokedAt);
});

test('the key API refuses an anonymous caller', async () => {
  assert.equal((await fetch(BASE + '/api/keys')).status, 401);
  assert.equal((await fetch(BASE + '/api/keys', { method: 'POST', body: '{}' })).status, 401);
  assert.equal((await fetch(BASE + '/api/keys/k-12345678', { method: 'DELETE' })).status, 401);
});

test('the key page carries the base URL, a guide and a permission column', async () => {
  const html = await (await fetch(BASE + '/keys', { headers: headers() })).text();
  assert.match(html, /id="baseUrl"/);
  assert.match(html, /id="endpointChat"/);
  assert.match(html, /id="endpointMessages"/);
  assert.match(html, /id="guideCode"/);
  assert.match(html, /id="permDialog"/);
  assert.match(html, /data-tab="python"/);
  assert.match(html, /data-tab="claude"/);
});

test('the key API reports the base URL and the catalog for the permission picker', async () => {
  const data = await (await fetch(BASE + '/api/keys', { headers: headers() })).json();
  // The base URL points at the gateway, never at the dashboard's own port. When
  // config.json names a public origin that is used verbatim; otherwise the rule
  // in public-origin.mjs rewrites the dashboard port to the gateway port.
  const config = JSON.parse(await readFile(join(API_ROOT, 'config.json'), 'utf8'));
  const expected = config.publicBaseUrl
    ? String(config.publicBaseUrl).replace(/\/+$/, '') + '/v1'
    // Otherwise the dashboard port is rewritten to the gateway port it was
    // started with (BUDDY_GATEWAY_PORT), which differs between deployments.
    : 'http://127.0.0.1:' + (process.env.BUDDY_GATEWAY_PORT || 3190) + '/v1';
  assert.equal(data.baseUrl, expected);
  assert.ok(!data.baseUrl.includes(':' + PORT + '/'), 'base URL must not use the dashboard port');
  // The catalog comes from the live gateway. With no gateway running (a
  // unit-only checkout) the list is empty on purpose: the dashboard must not
  // invent models it cannot verify.
  assert.ok(Array.isArray(data.catalog));
  if (data.catalog.length) {
    assert.ok(data.catalog.length >= 10);
    assert.ok(data.catalog.some(model => model.free));
    assert.ok(data.catalog.some(model => !model.free));
  }
  for (const model of data.catalog) {
    assert.equal(typeof model.id, 'string');
    assert.equal(typeof model.free, 'boolean');
  }
  // The bootstrap rows state their (unrestricted) reach, not a made-up limit.
  // The QA row only exists when that key file is present.
  assert.ok(data.bootstrap.length >= 1);
  for (const item of data.bootstrap) {
    assert.equal(typeof item.id, 'string');
    // With a live catalog the count is its size; without one it is zero, which
    // is the honest answer rather than a guess.
    assert.equal(item.modelCount, data.catalog.length);
  }
});

test('a grant can be set at creation and changed later, and is validated', async () => {
  const origin = 'http://127.0.0.1:3298';
  // A grant is validated against the live catalog. When the gateway is not
  // running (a unit-only run), the API must fail closed rather than create an
  // unrestricted key; that is asserted here and the grant flow is skipped.
  const probe = await (await fetch(BASE + '/api/keys', { headers: headers() })).json();
  if (!probe.catalog.length) {
    const blocked = await fetch(BASE + '/api/keys', {
      method: 'POST',
      headers: { ...headers(), 'content-type': 'application/json', origin },
      body: JSON.stringify({ label: 'no-catalog-' + Date.now(), models: ['hy3'] }),
    });
    assert.equal(blocked.status, 503);
    assert.equal((await blocked.json()).error, 'catalog_unavailable');
    const after = await (await fetch(BASE + '/api/keys', { headers: headers() })).json();
    assert.ok(!after.keys.some(key => String(key.label).startsWith('no-catalog-')), 'no half-created key');
    return;
  }
  const created = await fetch(BASE + '/api/keys', {
    method: 'POST',
    headers: { ...headers(), 'content-type': 'application/json', origin },
    body: JSON.stringify({ label: 'grant-test-' + Date.now(), models: ['hy3'] }),
  });
  assert.equal(created.status, 201);
  const body = await created.json();
  assert.deepEqual(body.key.models, ['hy3']);

  const list = await (await fetch(BASE + '/api/keys', { headers: headers() })).json();
  const row = list.keys.find(key => key.id === body.key.id);
  assert.equal(row.modelRestricted, true);
  assert.equal(row.modelCount, 1);
  assert.deepEqual(row.missingModels, []);

  // A stale id that is not in the catalog is dropped, never stored.
  const patched = await fetch(BASE + '/api/keys/' + body.key.id, {
    method: 'PATCH',
    headers: { ...headers(), 'content-type': 'application/json', origin },
    body: JSON.stringify({ models: ['hy3', 'no-such-model'] }),
  });
  assert.equal(patched.status, 200);
  assert.deepEqual((await patched.json()).key.models, ['hy3']);

  // Granting the whole catalog is stored as unrestricted.
  const all = await fetch(BASE + '/api/keys/' + body.key.id, {
    method: 'PATCH',
    headers: { ...headers(), 'content-type': 'application/json', origin },
    body: JSON.stringify({ models: list.catalog.map(model => model.id) }),
  });
  assert.equal(all.status, 200);
  assert.equal((await all.json()).key.models, null);

  // An empty grant is a real state: the key may call nothing.
  const none = await fetch(BASE + '/api/keys/' + body.key.id, {
    method: 'PATCH',
    headers: { ...headers(), 'content-type': 'application/json', origin },
    body: JSON.stringify({ models: [] }),
  });
  assert.equal(none.status, 200);
  assert.deepEqual((await none.json()).key.models, []);

  await fetch(BASE + '/api/keys/' + body.key.id, { method: 'DELETE', headers: { ...headers(), origin } });
});

test('a permission change requires a same-origin write', async () => {
  const res = await fetch(BASE + '/api/keys/k-12345678', {
    method: 'PATCH',
    headers: { ...headers(), 'content-type': 'application/json', origin: 'https://evil.example' },
    body: JSON.stringify({ models: [] }),
  });
  assert.equal(res.status, 403);
});
