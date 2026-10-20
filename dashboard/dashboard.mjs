// Buddy operations dashboard: static front end plus a small read-only API.
// Release gate: every served asset must match release.json, otherwise the
// process refuses to start instead of serving an unreviewed build.
import http from 'node:http';
import { createHash, randomUUID, timingSafeEqual } from 'node:crypto';
import { gzipSync } from 'node:zlib';
import { readFile, readdir, writeFile, mkdir, chmod, stat, open } from 'node:fs/promises';
import { join, dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { listAccounts, captureAccount, verifyAccount, removeAccount, saveWebAccount } from './accounts.mjs';
import { createWebLogin } from './web-login.mjs';
import { aggregateRows, groupTotals, USAGE_FIELDS } from '../usage.mjs';
import { PAGE_META } from './nav.mjs';
import { loadKeyDoc, saveKeyDoc, createEntry, revokeEntry, publicEntry, normalizeModels } from '../apikeys.mjs';
import { resolvePublicOrigin } from './public-origin.mjs';
import { mergeSessionFile } from './sessions.mjs';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
const runFile = promisify(execFile);

// A scheduled task can outlive its console; a write to a closed pipe must never
// take the process down or wedge it.
process.stdout.on('error', () => {});
process.stderr.on('error', () => {});

const ROOT = dirname(fileURLToPath(import.meta.url));
// The service root is the parent of dashboard/. BUDDY_ROOT overrides it for a
// checkout that keeps the data elsewhere (containers, CI, a second instance).
const API_ROOT = process.env.BUDDY_ROOT ? resolve(process.env.BUDDY_ROOT) : dirname(ROOT);
const GATEWAY = process.env.BUDDY_GATEWAY_URL || 'http://127.0.0.1:3190';
const PORT = Number(process.env.BUDDY_DASHBOARD_PORT || 3191);
const KEY_FILE = join(API_ROOT, 'secrets', 'dashboard-key.txt');
const SESSION_MS = 12 * 60 * 60 * 1000;

const ASSETS = {
  '/assets/app.css': { path: join(ROOT, 'public', 'assets', 'app.css'), type: 'text/css; charset=utf-8' },
  '/assets/app.js': { path: join(ROOT, 'public', 'assets', 'app.js'), type: 'text/javascript; charset=utf-8' },
  '/assets/accounts.js': { path: join(ROOT, 'public', 'assets', 'accounts.js'), type: 'text/javascript; charset=utf-8' },
  '/assets/shell.js': { path: join(ROOT, 'public', 'assets', 'shell.js'), type: 'text/javascript; charset=utf-8' },
  '/assets/usage.js': { path: join(ROOT, 'public', 'assets', 'usage.js'), type: 'text/javascript; charset=utf-8' },
  '/assets/models.js': { path: join(ROOT, 'public', 'assets', 'models.js'), type: 'text/javascript; charset=utf-8' },
  '/assets/logs.js': { path: join(ROOT, 'public', 'assets', 'logs.js'), type: 'text/javascript; charset=utf-8' },
  '/assets/keys.js': { path: join(ROOT, 'public', 'assets', 'keys.js'), type: 'text/javascript; charset=utf-8' },
};
// Every page is a template with __BASE__ / __VERSION__ placeholders. They are
// all hashed by build-release.mjs, so an edited page cannot be served until the
// release manifest is rebuilt.
const PAGES = Object.fromEntries(Object.entries(PAGE_META).map(([route, meta]) => [route, join(ROOT, 'public', meta.file)]));
const INDEX = PAGES['/'];
const ACCOUNTS_PAGE = PAGES['/accounts'];
const releaseTarget = name => {
  if (name.startsWith('assets/')) return ASSETS['/' + name]?.path;
  return PAGES['/' + name.replace(/\.html$/, '')] || (name === 'index.html' ? INDEX : null);
};

const sha = buffer => createHash('sha256').update(buffer).digest('hex');

async function loadRelease() {
  const release = JSON.parse(await readFile(join(ROOT, 'release.json'), 'utf8'));
  const problems = [];
  for (const [name, expected] of Object.entries(release.files || {})) {
    const target = releaseTarget(name);
    if (!target) { problems.push(name + ': not served'); continue; }
    if (sha(await readFile(target)) !== expected) problems.push(name + ': sha mismatch');
  }
  return { release, problems };
}

const { release, problems } = await loadRelease();
if (problems.length && process.env.BUDDY_DASHBOARD_ALLOW_UNVERIFIED !== '1') {
  console.error(JSON.stringify({ event: 'release_gate_failed', problems }));
  process.exit(1);
}
if (problems.length) console.error(JSON.stringify({ event: 'release_gate_bypassed', problems, reason: 'BUDDY_DASHBOARD_ALLOW_UNVERIFIED=1' }));
const VERSION = release.version || 'dev';
const assetCache = new Map();
for (const [route, asset] of Object.entries(ASSETS)) {
  const bytes = await readFile(asset.path);
  // Pre-compressed once at startup: the CSS and each script are sent on every
  // cold visit, and gzip cuts them to roughly a quarter of their size.
  assetCache.set(route, {
    bytes,
    gzip: gzipSync(bytes, { level: 9 }),
    type: asset.type,
    etag: '"' + sha(bytes).slice(0, 16) + '"',
  });
}
const pageTemplates = new Map();
for (const [route, path] of Object.entries(PAGES)) pageTemplates.set(route, await readFile(path, 'utf8'));

function renderPage(route, base) {
  return pageTemplates.get(route)
    .replaceAll('__BASE__', base)
    .replaceAll('__VERSION__', VERSION);
}

async function loadKey() {
  try {
    const value = (await readFile(KEY_FILE, 'utf8')).trim();
    if (value.length >= 24) return value;
  } catch {}
  await mkdir(join(API_ROOT, 'secrets'), { recursive: true });
  const generated = 'dash_' + randomUUID().replaceAll('-', '') + randomUUID().replaceAll('-', '');
  await writeFile(KEY_FILE, generated + '\n', { encoding: 'utf8', mode: 0o600 });
  console.log(JSON.stringify({ event: 'dashboard_key_created', file: KEY_FILE }));
  return generated;
}
const KEY = await loadKey();
const KEY_DIGEST = createHash('sha256').update(KEY).digest();
const keyMatches = candidate => typeof candidate === 'string' && candidate.length > 0 &&
  timingSafeEqual(createHash('sha256').update(candidate).digest(), KEY_DIGEST);

const sessions = new Map();
const LOGIN_WINDOW_MS = 10 * 60 * 1000;
const LOGIN_MAX_FAILURES = 5;
const LOGIN_BLOCK_MS = 5 * 60 * 1000;
const loginFailures = new Map();
const clientIp = req => (req.headers['cf-connecting-ip'] || req.socket.remoteAddress || 'unknown').toString();

// Sessions survive a dashboard restart. Only the SHA-256 of each session id is
// stored, so the file is useless as a credential even if it leaks.
const SESSION_FILE = join(API_ROOT, 'data', 'dashboard-sessions.json');
let sessionChain = Promise.resolve();
async function loadSessions() {
  try {
    const doc = JSON.parse(await readFile(SESSION_FILE, 'utf8'));
    const now = Date.now();
    for (const entry of Array.isArray(doc.sessions) ? doc.sessions : []) {
      if (!entry || typeof entry.id !== 'string' || !/^[a-f0-9]{64}$/.test(entry.id)) continue;
      if (!Number.isFinite(entry.expires) || entry.expires <= now) continue;
      sessions.set(entry.id, entry.expires);
    }
  } catch {}
}
// Ids this process logged out. A merge must not resurrect them from the file.
const revokedThisProcess = new Set();
// Two dashboard processes can share one data directory (a test run beside the
// service, or a staging copy). Writing only this process's map would erase the
// other's sessions, so the file is merged; see sessions.mjs for the rule.
function persistSessions() {
  sessionChain = sessionChain.catch(() => {}).then(async () => {
    await mergeSessionFile(SESSION_FILE, sessions, revokedThisProcess);
    await restrictToServiceUser(SESSION_FILE);
  }).catch(() => {});
  return sessionChain;
}
// The file holds activation material for every live session. On Windows the
// inherited ACL grants broad user groups, so it is stripped to the service
// user exactly like a credential snapshot.
async function restrictToServiceUser(target) {
  try { await chmod(target, 0o600); } catch {}
  if (process.platform !== 'win32') return;
  try {
    const { stdout } = await runFile('whoami.exe', ['/user', '/fo', 'csv', '/nh'], { windowsHide: true });
    const sid = stdout.match(/S-1-[0-9-]+/)?.[0];
    if (!sid) return;
    await runFile('icacls.exe', [target, '/inheritance:r', '/grant:r', '*' + sid + ':F'], { windowsHide: true });
  } catch {}
}
await restrictToServiceUser(SESSION_FILE);
await loadSessions();
const sessionDigest = sid => createHash('sha256').update(sid).digest('hex');
// Expired entries are dropped opportunistically; the map stays small because a
// single person uses this dashboard.
function pruneSessions() {
  const now = Date.now();
  let changed = false;
  for (const [id, expires] of sessions) if (expires <= now) { sessions.delete(id); changed = true; }
  if (changed) persistSessions();
}
setInterval(pruneSessions, 10 * 60 * 1000).unref();

function loginBlocked(ip) {
  const entry = loginFailures.get(ip);
  if (!entry) return 0;
  if (entry.until && entry.until > Date.now()) return Math.ceil((entry.until - Date.now()) / 1000);
  if (Date.now() - entry.first > LOGIN_WINDOW_MS) { loginFailures.delete(ip); return 0; }
  return 0;
}
function noteFailure(ip) {
  const now = Date.now();
  const entry = loginFailures.get(ip);
  if (!entry || now - entry.first > LOGIN_WINDOW_MS) { loginFailures.set(ip, { first: now, count: 1, until: 0 }); return; }
  entry.count += 1;
  if (entry.count >= LOGIN_MAX_FAILURES) entry.until = now + LOGIN_BLOCK_MS;
}

function sessionOf(req) {
  const match = /(?:^|;\s*)buddy_dash=([A-Za-z0-9-]{36})/.exec(req.headers.cookie || '');
  if (!match) return null;
  // New sessions are stored under their digest; the id itself never touches disk.
  const digest = sessionDigest(match[1]);
  const expires = sessions.get(digest) ?? sessions.get(match[1]);
  if (!expires) return null;
  if (expires < Date.now()) { sessions.delete(digest); sessions.delete(match[1]); return null; }
  return digest;
}
const authorized = req => {
  const bearer = /^Bearer ([^\s]+)$/i.exec(req.headers.authorization || '')?.[1];
  return Boolean(bearer && keyMatches(bearer)) || Boolean(sessionOf(req));
};

// The dashboard is a normal site behind the tunnel. SameSite=Lax keeps the
// session for top-level navigations (bookmarks, links from other sites, the
// WorkBuddy tab) while still refusing cross-site POSTs. Strict was why a fresh
// visit from another origin looked like a second login.
const sessionCookie = (sid, maxAgeSeconds, secure) =>
  `buddy_dash=${sid}; HttpOnly; SameSite=Lax; Path=/; Max-Age=${maxAgeSeconds}` + (secure ? '; Secure' : '');
const isSecure = req => String(req.headers['x-forwarded-proto'] || '').toLowerCase() === 'https';

// State-changing requests must come from this origin. Bearer-key clients (the
// QA scripts) send no Origin header and are already authenticated by key.
function sameOrigin(req) {
  if (!req.headers.origin) return true;
  const expected = (req.headers['x-forwarded-proto'] || 'http') + '://' + req.headers.host;
  return req.headers.origin === expected;
}
// Only allow redirect targets that stay inside the dashboard.
// Public origin of the *gateway*, as a client should call it. The rule lives in
// public-origin.mjs with its own tests; the config file supplies the explicit
// override so a deployment behind one domain prints that domain.
const GATEWAY_PORT = Number(process.env.BUDDY_GATEWAY_PORT || 3190);
let configuredOrigin = process.env.BUDDY_PUBLIC_ORIGIN || '';
if (!configuredOrigin) {
  try {
    const config = JSON.parse(await readFile(join(API_ROOT, 'config.json'), 'utf8'));
    if (typeof config.publicBaseUrl === 'string' && config.publicBaseUrl.trim()) configuredOrigin = config.publicBaseUrl.trim();
  } catch {}
}
const publicOrigin = req => resolvePublicOrigin({
  configured: configuredOrigin,
  proto: req.headers['x-forwarded-proto'] || (isSecure(req) ? 'https' : 'http'),
  host: req.headers['x-forwarded-host'] || req.headers.host || '127.0.0.1',
  gatewayPort: GATEWAY_PORT,
});

const safeNext = (base, value) => {
  if (typeof value !== 'string' || !value.startsWith('/')) return base + '/';
  if (value.startsWith('//') || value.includes('\\')) return base + '/';
  if (value === base || value.startsWith(base + '/')) return value;
  return base + '/';
};

// The dashboard authenticates to the gateway with the QA credential when one is
// configured, and with the primary key otherwise. A clone that only created
// secrets/api-key.txt must still work.
async function gatewayKey() {
  for (const name of ['qa-api-key.txt', 'api-key.txt']) {
    try {
      const value = (await readFile(join(API_ROOT, 'secrets', name), 'utf8')).trim();
      if (value) return value;
    } catch {}
  }
  return '';
}

async function callGateway(path) {
  try {
    const key = await gatewayKey();
    const res = await fetch(GATEWAY + path, { headers: { 'x-api-key': key }, signal: AbortSignal.timeout(8000) });
    if (!res.ok) return { error: 'http_' + res.status };
    return await res.json();
  } catch (error) { return { error: String(error?.name || 'unreachable') }; }
}

async function callGatewayPost(path, payload) {
  try {
    const key = await gatewayKey();
    const res = await fetch(GATEWAY + path, {
      method: 'POST',
      headers: { 'x-api-key': key, 'content-type': 'application/json' },
      body: JSON.stringify(payload || {}),
      signal: AbortSignal.timeout(15000),
    });
    return { status: res.status, body: await res.json().catch(() => ({})) };
  } catch (error) { return { status: 0, body: { error: String(error?.name || 'unreachable') } }; }
}

let gatewayCache = { at: 0, status: null, models: null, health: null };
const webLogin = createWebLogin({
  saveAccount: (id, session, signal) => saveWebAccount(API_ROOT, id, session, signal),
  registerAccount: async id => {
    const result = await callGatewayPost('/v1/account/register', { id });
    gatewayCache = { at: 0, status: null, models: null, health: null };
    return result.status === 200;
  },
});
async function gatewaySnapshot() {
  if (gatewayCache.status && Date.now() - gatewayCache.at < 30000) return gatewayCache;
  const [status, models, health] = await Promise.all([
    callGateway('/v1/status'), callGateway('/v1/models'), callGateway('/healthz'),
  ]);
  gatewayCache = { at: Date.now(), status, models, health };
  return gatewayCache;
}

const logDir = join(API_ROOT, 'logs');
async function logFiles() {
  try { return (await readdir(logDir)).filter(n => /^access-\d{8}\.jsonl$/.test(n)).sort(); }
  catch { return []; }
}

// Access logs are append-only. This cache keeps rows already parsed per file and
// reads only the bytes appended since the last read, so a dashboard refresh no
// longer re-parses the whole history every time. A file that shrank (rotation)
// or whose stored offset is ahead of the file is read whole again. Rows, once
// parsed, are never revisited.
const logCache = new Map();

function parseLines(text, rows) {
  for (const line of text.split('\n')) {
    if (!line.trim()) continue;
    try { rows.push(JSON.parse(line)); } catch {}
  }
  return rows;
}

async function readRows(names) {
  const rows = [];
  for (const name of names) {
    const path = join(logDir, name);
    let size = null;
    try { size = (await stat(path)).size; } catch { logCache.delete(name); continue; }
    const cached = logCache.get(name);
    if (cached && cached.size <= size) {
      // Only the appended bytes are decoded again; a partial trailing line on a
      // live file fails JSON.parse and is simply retried on the next read.
      const tail = await readTail(path, cached.size);
      if (tail) {
        const fresh = [];
        parseLines(tail, fresh);
        logCache.set(name, { size, rows: cached.rows.concat(fresh) });
        rows.push(...cached.rows, ...fresh);
      } else {
        rows.push(...cached.rows);
      }
      continue;
    }
    let text = null;
    try { text = await readFile(path, 'utf8'); } catch { logCache.delete(name); continue; }
    const fresh = [];
    parseLines(text, fresh);
    logCache.set(name, { size, rows: fresh });
    rows.push(...fresh);
  }
  // The log directory is small and bounded by day; keep the map from growing.
  if (logCache.size > 32) for (const key of [...logCache.keys()].slice(0, logCache.size - 32)) logCache.delete(key);
  return rows;
}

async function readTail(path, from) {
  try {
    const handle = await open(path, 'r');
    try {
      const chunks = [];
      // position must be passed to every read: a null position seeks the fd back
      // to the beginning of the file, which would duplicate the whole history.
      let position = from;
      for (;;) {
        const block = Buffer.alloc(1 << 20);
        const { bytesRead } = await handle.read(block, 0, block.length, position);
        if (!bytesRead) break;
        chunks.push(Buffer.from(block.subarray(0, bytesRead)));
        position += bytesRead;
      }
      return Buffer.concat(chunks).toString('utf8');
    } finally { await handle.close(); }
  } catch { return ''; }
}
const percentile = (values, p) => {
  if (!values.length) return null;
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.min(sorted.length - 1, Math.floor((p / 100) * sorted.length))];
};
const dayKey = date => date.toISOString().slice(0, 10);

// All timestamps are stored as UTC ISO strings. The operator works in
// Asia/Saigon, which has a fixed +07:00 offset and no daylight saving, so a
// constant offset is exact and avoids locale surprises in the aggregates.
const TZ_NAME = 'Asia/Saigon';
const TZ_OFFSET_MINUTES = 7 * 60;
const TZ_OFFSET = '+07:00';
const localStamp = iso => {
  if (typeof iso !== 'string') return null;
  const ms = Date.parse(iso);
  if (!Number.isFinite(ms)) return null;
  return new Date(ms + TZ_OFFSET_MINUTES * 60000).toISOString().slice(0, 19).replace('T', ' ');
};
// Accepts either a local wall-clock time ("2026-10-20T08:00") interpreted in
// Asia/Saigon, or an explicit ISO instant with Z/offset.
function parseBoundary(value, fallback) {
  if (typeof value !== 'string' || !value.trim()) return fallback;
  const text = value.trim();
  const ms = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(?::\d{2}(?:\.\d+)?)?$/.test(text)
    ? Date.parse(text + TZ_OFFSET)
    : Date.parse(text);
  return Number.isFinite(ms) ? ms : fallback;
}
const MAX_RANGE_MS = 31 * 86400000;
// The detail list is paged, so it does not need a small cap: a cap made the
// summary describe 6.448 requests while the table could only ever show 5.000 of
// them, which is exactly the mismatch the ledger must not have. The bound here
// only exists to keep a pathological window from exhausting memory.
const MAX_DETAIL_ROWS = 200000;

async function readRowsForRange(fromMs, toMs) {
  const names = await logFiles();
  const first = dayKey(new Date(fromMs - 86400000)).replaceAll('-', '');
  const last = dayKey(new Date(toMs)).replaceAll('-', '');
  const wanted = names.filter(name => {
    const day = name.slice(7, 15);
    return day >= first && day <= last;
  });
  return readRows(wanted);
}

// Rows outside the requested window are dropped while reading, so the dashboard
// never builds objects it would immediately discard.
async function readRowsInWindow(fromMs, toMs, predicate) {
  const rows = await readRowsForRange(fromMs, toMs);
  // Access-log timestamps are fixed-format UTC ISO strings, so a lexicographic
  // comparison is chronological and far cheaper than Date.parse on every row.
  const fromIso = new Date(fromMs).toISOString();
  const toIso = new Date(toMs).toISOString();
  const kept = [];
  for (const row of rows) {
    if (typeof row.at !== 'string' || row.at < fromIso || row.at > toIso) continue;
    if (predicate && !predicate(row)) continue;
    kept.push(row);
  }
  return kept;
}

const usageOf = row => (row && row.usage && typeof row.usage === 'object' ? row.usage : null);
const numeric = value => (typeof value === 'number' && Number.isFinite(value) ? value : null);

function usageDetail(row) {
  const usage = usageOf(row);
  const at = typeof row.at === 'string' ? row.at : null;
  return {
    request_id: row.request_id || null,
    at,
    at_local: localStamp(at),
    account: row.account ?? null,
    model: row.model ?? null,
    path: row.path ?? null,
    protocol: row.protocol ?? null,
    stream: row.stream === true,
    status: numeric(row.status),
    code: row.code ?? null,
    upstream_attempts: numeric(row.upstream_attempts),
    upstream_retries: numeric(row.upstream_retries),
    ms: numeric(row.ms),
    input_tokens: usage ? numeric(usage.input_tokens) : null,
    output_tokens: usage ? numeric(usage.output_tokens) : null,
    cache_write_tokens: usage ? numeric(usage.cache_write_tokens) : null,
    cache_read_tokens: usage ? numeric(usage.cache_read_tokens) : null,
    total_tokens: usage ? numeric(usage.total_tokens) : null,
    usage_present: Boolean(usage),
    usage_attempts: usage ? numeric(usage.usage_attempts) : null,
    input_includes_cache_read: usage ? usage.input_includes_cache_read ?? null : null,
  };
}

// Three disjoint outcome classes, applied identically everywhere on the overview:
//   "ok"          request succeeded
//   "saturated"   the gateway did not get to answer: own admission queue full,
//                 every account cooling, or upstream rate-limited
//   "failed"      a genuine failure, including a client's bad request or
//                 missing credential
// A page that mixes these reads as if a burst of throttling were an outage.
const SATURATED_CODES = new Set(['busy', 'accounts_cooling_down', 'upstream_rate_limited']);
const outcomeOf = row => {
  if (row.status < 400) return 'ok';
  return SATURATED_CODES.has(row.code) ? 'saturated' : 'failed';
};

async function snapshot() {
  const files = await logFiles();
  const { status, models, health } = await gatewaySnapshot();
  const rows = await readRows(files.slice(-14));
  const now = Date.now();
  const today = dayKey(new Date());
  const todays = rows.filter(row => typeof row.at === 'string' && row.at.slice(0, 10) === today);
  const durations = todays.filter(row => Number.isFinite(row.ms)).map(row => row.ms);
  const saturated = todays.filter(row => outcomeOf(row) === 'saturated');
  const failures = todays.filter(row => outcomeOf(row) === 'failed');
  const count = list => list.reduce((acc, key) => { acc[key] = (acc[key] || 0) + 1; return acc; }, {});
  const perMinute = [];
  for (let i = 59; i >= 0; i--) {
    const from = now - (i + 1) * 60000, to = now - i * 60000;
    perMinute.push(todays.filter(row => { const t = Date.parse(row.at); return t > from && t <= to; }).length);
  }
  const daily = [];
  for (let i = 13; i >= 0; i--) {
    const day = dayKey(new Date(now - i * 86400000));
    const list = rows.filter(row => typeof row.at === 'string' && row.at.slice(0, 10) === day);
    daily.push({ day: day.slice(5), requests: list.length,
      failures: list.filter(row => outcomeOf(row) === 'failed').length,
      saturated: list.filter(row => outcomeOf(row) === 'saturated').length });
  }
  return {
    generatedAt: new Date().toISOString(),
    version: VERSION,
    gateway: { health: health?.status === 'ok' ? 'ok' : (health?.error || 'down'), status },
    models: (models?.data || []).map(model => ({ id: model.id, context: model.context_window || null })),
    today: {
      requests: todays.length,
      failures: failures.length,
      saturated: saturated.length,
      // "Tỷ lệ lỗi" now means real failures only; the throttled share is named
      // separately so a 429 storm cannot masquerade as a failure rate.
      errorRate: todays.length ? Math.round((failures.length / todays.length) * 1000) / 10 : 0,
      saturatedRate: todays.length ? Math.round((saturated.length / todays.length) * 1000) / 10 : 0,
      p50: percentile(durations, 50), p95: percentile(durations, 95),
      byCode: count(todays.map(row => row.code || 'ok')),
      byKey: count(todays.map(row => row.key || 'none')),
      perMinute,
    },
    daily,
    recent: todays.slice(-30).reverse().map(row => ({
      at: row.at, key: row.key, path: row.path, model: row.model,
      status: row.status, code: row.code, ms: row.ms, id: row.request_id,
    })),
  };
}

const loginPage = (base, message = '', retry = 0, next = '') => `<!doctype html>
<html lang="vi"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>Buddy — đăng nhập</title>
<style>
:root{--bg:#f9f9fb;--surface:#fff;--border:#00000014;--text:#1a1a2e;--muted:#71717a;
--primary:#e54d5e;--accent:#6366f1;--bad:#dc2626;
--sans:-apple-system,"SF Pro Text","Segoe UI",system-ui,sans-serif}
*{box-sizing:border-box}
body{margin:0;min-height:100vh;display:grid;place-items:center;padding:24px;
background-color:var(--bg);
background-image:linear-gradient(to right,var(--border) 1px,transparent 1px),linear-gradient(to bottom,var(--border) 1px,transparent 1px);
background-size:32px 32px;color:var(--text);font:14px/1.55 var(--sans);-webkit-font-smoothing:antialiased}
.card{width:min(400px,100%);padding:30px 28px;background:var(--surface);border:1px solid var(--border);border-radius:14px;
box-shadow:0 1px 2px #0000000a,0 8px 24px -18px #00000030}
.brand{display:flex;align-items:center;gap:10px;margin-bottom:20px}
.logo{width:34px;height:34px;display:grid;place-items:center;border-radius:9px;
background:linear-gradient(135deg,#e54d5e,#a855f7);color:#fff;font-weight:700}
b.name{font-size:15px}
h1{font-size:20px;font-weight:600;letter-spacing:-.01em;margin:0 0 6px}
p{margin:0 0 20px;color:var(--muted);font-size:13px}
label{display:block;font-size:12px;color:var(--muted);margin-bottom:6px}
input{width:100%;padding:10px 12px;font:inherit;font-size:14px;background:var(--bg);color:var(--text);
border:1px solid #00000024;border-radius:9px}
input:focus{outline:none;border-color:var(--accent);box-shadow:0 0 0 3px #eef0ff}
button{margin-top:16px;width:100%;padding:10px;font:inherit;font-size:14px;font-weight:600;
background:var(--text);color:#fff;border:0;border-radius:9px;cursor:pointer}
button:hover{background:var(--primary)}
.err{color:var(--bad);font-size:13px;margin:14px 0 0}
:focus-visible{outline:2px solid var(--accent);outline-offset:2px}
</style></head><body>
<form class="card" method="post" action="${base}/login">
  <div class="brand"><span class="logo">B</span><b class="name">Buddy</b></div>
  <h1>Đăng nhập dashboard</h1>
  <p>Một lần đăng nhập cho mọi trang vận hành. Phiên giữ 12 giờ.</p>
  <label for="token">Khóa dashboard</label>
  <input id="token" type="password" name="token" autocomplete="current-password" autofocus>
  <input type="hidden" name="next" value="${String(next).replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]))}">
  <button type="submit">Vào dashboard</button>
  ${message ? `<p class="err">${message}${retry ? ' Thử lại sau ' + retry + ' giây.' : ''}</p>` : ''}
</form></body></html>`;

function sendJson(res, status, body) {
  const data = JSON.stringify(body);
  const raw = Buffer.from(data, 'utf8');
  const headers = { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store', vary: 'Accept-Encoding' };
  // Large aggregates (usage, logs) shrink several times over; small replies are
  // left alone because the gzip header costs more than it saves.
  if (raw.length > 1400 && /\bgzip\b/.test(res.req?.headers['accept-encoding'] || '')) {
    const packed = gzipSync(raw, { level: 6 });
    headers['content-encoding'] = 'gzip';
    headers['content-length'] = packed.length;
    res.writeHead(status, headers);
    res.end(packed);
    return;
  }
  headers['content-length'] = raw.length;
  res.writeHead(status, headers);
  res.end(raw);
}
function sendHtml(res, status, body, extra = {}) {
  res.writeHead(status, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store', ...extra });
  res.end(body);
}

async function readForm(req) {
  let body = '';
  for await (const chunk of req) { body += chunk; if (body.length > 4096) break; }
  return new URLSearchParams(body);
}
async function readJson(req) {
  let body = '';
  for await (const chunk of req) { body += chunk; if (body.length > 65536) break; }
  try { return JSON.parse(body || '{}'); } catch { return {}; }
}

const server = http.createServer(async (req, res) => {
  try {
    const url = new URL(req.url || '/', 'http://127.0.0.1');
    const prefixed = url.pathname === '/dashboard' || url.pathname.startsWith('/dashboard/');
    const base = prefixed ? '/dashboard' : '';
    const pathname = prefixed ? (url.pathname.slice(base.length) || '/') : url.pathname;

    if (req.method === 'POST' && pathname === '/login') {
      const ip = clientIp(req);
      const wait = loginBlocked(ip);
      if (wait) { sendHtml(res, 429, loginPage(base, 'Quá nhiều lần thử.', wait), { 'retry-after': String(wait) }); return; }
      const form = await readForm(req);
      if (!keyMatches(form.get('token'))) {
        noteFailure(ip);
        sendHtml(res, 401, loginPage(base, 'Khóa không đúng.', 0, form.get('next')));
        return;
      }
      loginFailures.delete(ip);
      const sid = randomUUID();
      sessions.set(sessionDigest(sid), Date.now() + SESSION_MS);
      void persistSessions();
      // Return to the page the visitor asked for, so a bookmark to /accounts
      // does not bounce through the overview and then look like a re-login.
      res.writeHead(303, { 'set-cookie': sessionCookie(sid, SESSION_MS / 1000, isSecure(req)), location: safeNext(base, form.get('next')) });
      res.end();
      return;
    }

    if (req.method === 'GET' && pathname === '/logout') {
      const sid = sessionOf(req);
      if (sid) {
        sessions.delete(sid);
        // Recorded so a concurrent process's merge cannot bring the session back.
        revokedThisProcess.add(sid);
        void persistSessions();
      }
      res.writeHead(303, { 'set-cookie': 'buddy_dash=; HttpOnly; SameSite=Lax; Path=/; Max-Age=0', location: base + '/' });
      res.end();
      return;
    }

    if (req.method === 'GET' && ASSETS[pathname]) {
      const asset = assetCache.get(pathname);
      if (req.headers['if-none-match'] === asset.etag) { res.writeHead(304, { etag: asset.etag }); res.end(); return; }
      const headers = { 'content-type': asset.type, 'cache-control': 'public, max-age=300', etag: asset.etag, vary: 'Accept-Encoding' };
      if (/\bgzip\b/.test(req.headers['accept-encoding'] || '')) {
        headers['content-encoding'] = 'gzip';
        headers['content-length'] = asset.gzip.length;
        res.writeHead(200, headers);
        res.end(asset.gzip);
      } else {
        headers['content-length'] = asset.bytes.length;
        res.writeHead(200, headers);
        res.end(asset.bytes);
      }
      return;
    }

    // Browsers request /favicon.ico on the login page too. Serving one keeps the
    // console free of a 404 that looks like a broken asset.
    if (req.method === 'GET' && (pathname === '/favicon.ico' || pathname === '/favicon.svg')) {
      const icon = '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 32 32"><rect width="32" height="32" rx="9" fill="#e54d5e"/><text x="16" y="22" font-family="system-ui" font-size="18" font-weight="700" fill="white" text-anchor="middle">B</text></svg>';
      res.writeHead(200, { 'content-type': 'image/svg+xml', 'cache-control': 'public, max-age=86400' });
      res.end(icon);
      return;
    }

    if (pathname === '/' || pathname === '/index.html') {
      // Staging-only shortcut so a headless browser can capture the real app
      // without scripting a form POST. Never active in the released process.
      if (process.env.BUDDY_DASHBOARD_QA === '1' && url.searchParams.get('qa') && keyMatches(url.searchParams.get('qa'))) {
        const qaSid = randomUUID();
        sessions.set(sessionDigest(qaSid), Date.now() + 10 * 60 * 1000);
        // Land on the page the operator asked to capture, not always the root.
        const qaNext = safeNext(base, url.searchParams.get('next') || '/');
        res.writeHead(303, { 'set-cookie': sessionCookie(qaSid, 600, isSecure(req)), location: qaNext });
        res.end();
        return;
      }
      if (!authorized(req)) { sendHtml(res, 200, loginPage(base, '', 0, url.pathname)); return; }
      sendHtml(res, 200, renderPage('/', base));
      return;
    }

    if (req.method === 'GET' && pageTemplates.has(pathname)) {
      if (!authorized(req)) { sendHtml(res, 200, loginPage(base, '', 0, url.pathname)); return; }
      sendHtml(res, 200, renderPage(pathname, base));
      return;
    }

    if (pathname === '/api/data' || pathname === '/api/request') {
      if (!authorized(req)) { sendJson(res, 401, { error: 'unauthorized' }); return; }
      if (pathname === '/api/data') { sendJson(res, 200, await snapshot()); return; }
      const id = url.searchParams.get('id') || '';
      const row = (await readRows((await logFiles()).slice(-2))).find(entry => entry.request_id === id);
      sendJson(res, row ? 200 : 404, row || { error: 'not_found' });
      return;
    }

    // Cheap liveness probe for the sidebar dot. It does not read the access log,
    // so every page can poll it without paying for an aggregate.
    if (pathname === '/api/ping') {
      if (!authorized(req)) { sendJson(res, 401, { error: 'unauthorized' }); return; }
      const health = await callGateway('/healthz');
      sendJson(res, 200, {
        gateway: health?.status === 'ok' ? 'ok' : (health?.error || 'down'),
        at: new Date().toISOString(),
      });
      return;
    }

    if (pathname === '/api/account-labels') {
      if (!authorized(req)) { sendJson(res, 401, { error: 'unauthorized' }); return; }
      // Read-only: the masked upstream label per account code. The full address
      // is never sent to the browser.
      const rows = await listAccounts(API_ROOT);
      sendJson(res, 200, { labels: Object.fromEntries(rows.map(row => [row.id, row.email || null])) });
      return;
    }

    // API keys. The plaintext token is returned exactly once, by the create
    // call, and never again: the list only carries a hint (prefix + last four).
    if (pathname === '/api/keys' || pathname.startsWith('/api/keys/')) {
      if (!authorized(req)) { sendJson(res, 401, { error: 'unauthorized' }); return; }
      if (req.method !== 'GET' && !sameOrigin(req)) { sendJson(res, 403, { error: 'invalid_origin' }); return; }

      if (pathname === '/api/keys' && req.method === 'GET') {
        const doc = await loadKeyDoc(API_ROOT);
        // Usage per key comes from the same access log the other pages read, so
        // the number beside a key is the number of requests it actually served.
        const from = Date.now() - 30 * 86400000;
        const rows = await readRowsInWindow(from, Date.now(), row => Boolean(row.key));
        const usage = new Map();
        for (const row of rows) {
          const current = usage.get(row.key) || { requests: 0, lastAt: null, accounts: new Set(), models: new Set() };
          current.requests += 1;
          if (row.account) current.accounts.add(row.account);
          if (row.model) current.models.add(row.model);
          if (!current.lastAt || row.at > current.lastAt) current.lastAt = row.at;
          usage.set(row.key, current);
        }
        // The catalog is what the permission picker offers. It is the same list
        // the gateway serves, so a key can never be granted an id that does not
        // exist, and the count shown beside each key matches reality.
        const models = await callGateway('/v1/models');
        const catalog = (models?.data || []).map(model => ({
          id: model.id,
          name: model.name || model.id,
          free: model.billing?.free === true,
          credits: model.billing?.credits || null,
        })).sort((a, b) => Number(b.free) - Number(a.free) || a.id.localeCompare(b.id));
        const catalogIds = catalog.map(model => model.id);
        const shape = entry => {
          const seen = usage.get(entry.id);
          // A stored id that left the catalog is reported, not hidden: the key
          // still cannot call it, and the operator should see why the count is
          // lower than the list they picked.
          const granted = Array.isArray(entry.models) ? entry.models : null;
          const missing = granted ? granted.filter(id => !catalogIds.includes(id)) : [];
          return {
            ...publicEntry(entry),
            modelCount: granted === null ? catalogIds.length : granted.length,
            modelRestricted: granted !== null,
            missingModels: missing,
            requests30d: seen?.requests || 0,
            lastRequestAt: seen?.lastAt || null,
            accounts: seen ? seen.accounts.size : 0,
            // Distinct from `models` (the grant): this is how many model ids the
            // key actually used, which is what the table's usage column shows.
            modelsUsed: seen ? seen.models.size : 0,
          };
        };
        sendJson(res, 200, {
          generatedAt: new Date().toISOString(),
          generatedAt_local: localStamp(new Date().toISOString()),
          // Base URL and a copy-ready guide, so the page is self-contained. The
          // origin is derived from the request (or BUDDY_PUBLIC_ORIGIN), never
          // fixed in the source: a clone on another domain must show its own.
          baseUrl: publicOrigin(req) + '/v1',
          host: new URL(publicOrigin(req)).host,
          catalog,
          // Bootstrap credentials are not managed here; they are named so the
          // operator knows why some log rows carry an id with no row below.
          bootstrap: [
            { id: 'primary', label: 'Khóa gốc (secrets/api-key.txt)', managed: false, modelCount: catalogIds.length },
            // Only shown when the deployment actually has a separate QA key.
            ...(await (async () => {
              try { return (await readFile(join(API_ROOT, 'secrets', 'qa-api-key.txt'), 'utf8')).trim() ? [{ id: 'qa', label: 'Khóa kiểm thử (secrets/qa-api-key.txt)', managed: false, modelCount: catalogIds.length }] : []; }
              catch { return []; }
            })()),
          ],
          keys: doc.keys.map(shape),
          notes: [
            'Khóa chỉ hiển thị một lần khi tạo; sau đó chỉ còn phần đầu và 4 ký tự cuối.',
            'Thu hồi có hiệu lực ngay ở request kế tiếp, không cần khởi động lại cổng.',
            'Số request là 30 ngày gần nhất, đọc từ access log theo id khóa.',
            'Khóa gốc và khóa kiểm thử nằm trong secrets/ và không quản lý ở đây.',
            'Phân quyền model áp dụng cho cả /v1/models và lời gọi: khóa bị giới hạn chỉ thấy và chỉ gọi được model đã cấp.',
            'Chọn đủ toàn bộ catalog tương đương "không giới hạn" và được lưu ở dạng gọn hơn.',
          ],
        });
        return;
      }

      if (pathname === '/api/keys' && req.method === 'POST') {
        const body = await readJson(req);
        const doc = await loadKeyDoc(API_ROOT);
        // A hard cap keeps a runaway script from filling the file.
        if (doc.keys.filter(entry => !entry.revokedAt).length >= 25) {
          sendJson(res, 409, { error: 'key_limit_reached', hint: 'Thu hồi bớt khóa không dùng trước khi tạo thêm.' });
          return;
        }
        const { token, entry } = createEntry(doc, { label: body.label, createdBy: sessionOf(req) ? 'dashboard-session' : 'dashboard-key' });
        if (body.models !== undefined) {
          // A grant sent with creation is validated against the live catalog the
          // same way PATCH does, so the key never starts with an id that does not
          // exist.
          const models = await callGateway('/v1/models');
          const catalogIds = (models?.data || []).map(model => model.id);
          // Fail closed: if the catalog cannot be read, a grant cannot be
          // validated, and creating the key unrestricted would silently hand out
          // more access than the operator asked for.
          if (!catalogIds.length) {
            doc.keys.pop();
            sendJson(res, 503, { error: 'catalog_unavailable', hint: 'Chưa đọc được catalog model nên chưa thể kiểm tra quyền. Thử lại sau.' });
            return;
          }
          entry.models = normalizeModels(body.models, catalogIds);
        }
        await saveKeyDoc(API_ROOT, doc);
        // Push the change into the running gateway immediately; the file watcher
        // would otherwise leave a freshly created key unusable for up to 2s.
        await callGatewayPost('/v1/keys/reload', {});
        // The token is in this response only. It is not logged and not stored.
        sendJson(res, 201, { ok: true, token, key: publicEntry(entry) });
        return;
      }

      if (req.method === 'DELETE' && pathname.startsWith('/api/keys/')) {
        const id = decodeURIComponent(pathname.slice('/api/keys/'.length));
        const doc = await loadKeyDoc(API_ROOT);
        const entry = revokeEntry(doc, id);
        if (!entry) { sendJson(res, 404, { error: 'not_found' }); return; }
        await saveKeyDoc(API_ROOT, doc);
        // A revoked key must stop working now, not after the watcher's next tick.
        await callGatewayPost('/v1/keys/reload', {});
        sendJson(res, 200, { ok: true, key: publicEntry(entry) });
        return;
      }

      // PATCH changes a key's label and/or its model grant. It is the only way a
      // permission set changes, and it never touches the token itself.
      if (req.method === 'PATCH' && pathname.startsWith('/api/keys/')) {
        const id = decodeURIComponent(pathname.slice('/api/keys/'.length));
        const body = await readJson(req);
        const doc = await loadKeyDoc(API_ROOT);
        const entry = doc.keys.find(item => item.id === id && !item.revokedAt);
        if (!entry) { sendJson(res, 404, { error: 'not_found' }); return; }
        if (typeof body.label === 'string' && body.label.trim()) entry.label = body.label.trim().slice(0, 60);
        if (body.models !== undefined) {
          // Validate against the live catalog so a stale browser tab cannot grant
          // an id that has since been removed.
          const models = await callGateway('/v1/models');
          const catalogIds = (models?.data || []).map(model => model.id);
          if (!catalogIds.length) { sendJson(res, 503, { error: 'catalog_unavailable' }); return; }
          entry.models = normalizeModels(body.models, catalogIds);
        }
        await saveKeyDoc(API_ROOT, doc);
        // A narrowed grant applies to the next request.
        await callGatewayPost('/v1/keys/reload', {});
        sendJson(res, 200, {
          ok: true,
          key: {
            ...publicEntry(entry),
            modelCount: Array.isArray(entry.models) ? entry.models.length : null,
            modelRestricted: Array.isArray(entry.models),
          },
        });
        return;
      }

      sendJson(res, 405, { error: 'method_not_allowed' });
      return;
    }

    if (pathname === '/api/models') {
      if (!authorized(req)) { sendJson(res, 401, { error: 'unauthorized' }); return; }
      // The gateway's live catalog, grouped the way the operator asked: free and
      // paid. Prices come from upstream billing, never inferred.
      const models = await callGateway('/v1/models');
      if (models?.error) { sendJson(res, 503, { error: models.error }); return; }
      const rows = (models?.data || []).map(model => ({
        id: model.id,
        name: model.name || model.id,
        free: model.billing?.free === true,
        credits: model.billing?.credits || null,
        maxContextWindow: model.max_context_window || model.context_window || null,
        defaultContextWindow: model.default_context_window || null,
        maxOutputTokens: model.max_output_tokens || null,
        supportsImages: model.supports_images === true,
        supportsTools: model.supports_tools === true,
        reasoning: model.reasoning && typeof model.reasoning === 'object' ? {
          supports: model.reasoning.supports === true,
          only_reasoning: model.reasoning.only_reasoning === true,
          can_disable_thinking: model.reasoning.can_disable_thinking === true,
        } : null,
      }));
      sendJson(res, 200, {
        generatedAt: new Date().toISOString(),
        free: rows.filter(row => row.free),
        paid: rows.filter(row => !row.free),
        notes: [
          'Miễn phí nghĩa là upstream báo billing.free = true (x0.00 credit).',
          'Trả phí nghĩa là upstream báo billing.free = false; mỗi lần gọi trừ credit của tài khoản WorkBuddy đang dùng.',
          'Ngữ cảnh hiển thị là mức tối đa model nhận (max_context_window), không phải mức mặc định.',
          'Model GPT đã bị loại khỏi gateway theo yêu cầu.',
        ],
      });
      return;
    }

    if (pathname === '/api/usage') {
      if (!authorized(req)) { sendJson(res, 401, { error: 'unauthorized' }); return; }
      const now = Date.now();
      // Default window: today in Asia/Saigon, not UTC. The local midnight is
      // computed from the fixed +07:00 offset.
      const localNow = new Date(now + TZ_OFFSET_MINUTES * 60000);
      const localMidnight = Date.parse(localNow.toISOString().slice(0, 10) + 'T00:00:00' + TZ_OFFSET);
      let from = parseBoundary(url.searchParams.get('from'), localMidnight);
      let to = parseBoundary(url.searchParams.get('to'), now);
      if (to < from) [from, to] = [to, from];
      if (to - from > MAX_RANGE_MS) from = to - MAX_RANGE_MS;
      const account = (url.searchParams.get('account') || '').trim() || null;
      const model = (url.searchParams.get('model') || '').trim() || null;
      const includeNonChat = url.searchParams.get('all') === '1';
      // The detail table is paged on the server so a wide range transfers and
      // renders only the rows the operator is looking at.
      const requestedPage = Number(url.searchParams.get('page'));
      const detailPage = Number.isInteger(requestedPage) && requestedPage > 0 ? requestedPage : 1;
      const pageSize = Math.min(500, Math.max(1, Number(url.searchParams.get('page_size')) || 100));
      const chatPaths = new Set(['/v1/chat/completions', '/v1/messages', '/v1/responses']);
      const rows = await readRowsInWindow(from, to, row => {
        if (!includeNonChat && !chatPaths.has(row.path)) return false;
        if (account && row.account !== account) return false;
        if (model && row.model !== model) return false;
        return true;
      });
      rows.sort((a, b) => Date.parse(a.at) - Date.parse(b.at) || String(a.request_id).localeCompare(String(b.request_id)));
      const details = rows.map(usageDetail);
      const totals = aggregateRows(details);
      const byAccount = groupTotals(details, row => row.account || '(không rõ)');
      const byModel = groupTotals(details, row => row.model || '(không rõ)');
      const byDay = groupTotals(details, row => (row.at_local || '').slice(0, 10) || '(không rõ)');
      // Buckets let the chart show usage over time with the same filter set.
      // One pass assigns each row to its bucket by arithmetic instead of
      // re-scanning the whole list per bucket (O(n) instead of O(n*buckets)).
      const span = Math.max(1, to - from);
      const bucketCount = Math.max(1, Math.min(48, Math.ceil(span / 3600000)));
      const bucketMs = span / bucketCount;
      const bucketLists = Array.from({ length: bucketCount }, () => []);
      for (const row of details) {
        const at = Date.parse(row.at);
        if (!Number.isFinite(at)) continue;
        const index = Math.max(0, Math.min(bucketCount - 1, Math.floor((at - from) / bucketMs)));
        bucketLists[index].push(row);
      }
      const buckets = bucketLists.map((list, i) => {
        const start = from + i * bucketMs;
        return { from: new Date(start).toISOString(), from_local: localStamp(new Date(start).toISOString()), ...aggregateRows(list) };
      });
      // Details are newest-first for the table and paged from this same list, so
      // the summary and the table always describe an identical set of rows.
      const reversedDetails = details.slice().reverse().slice(0, MAX_DETAIL_ROWS);
      sendJson(res, 200, {
        generatedAt: new Date(now).toISOString(),
        generatedAt_local: localStamp(new Date(now).toISOString()),
        timezone: TZ_NAME,
        timezone_offset: TZ_OFFSET,
        range: {
          from: new Date(from).toISOString(), to: new Date(to).toISOString(),
          from_local: localStamp(new Date(from).toISOString()), to_local: localStamp(new Date(to).toISOString()),
        },
        filters: { account, model, include_non_chat: includeNonChat },
        totals,
        byAccount, byModel, byDay, buckets,
        // Newest first, matching the table. Only this page is transferred.
        details: reversedDetails.slice((detailPage - 1) * pageSize, detailPage * pageSize),
        detail_count: reversedDetails.length,
        detail_page: detailPage,
        detail_page_size: pageSize,
        detail_pages: Math.max(1, Math.ceil(reversedDetails.length / pageSize)),
        detail_truncated: details.length > MAX_DETAIL_ROWS,
        // Field names are the upstream ones; a null value means upstream did
        // not send that counter (shown as "no data", never 0).
        fields: {
          input_tokens: 'prompt_tokens (includes cached prompt tokens)',
          output_tokens: 'completion_tokens',
          cache_write_tokens: 'prompt_cache_write_tokens / cache_creation_input_tokens',
          cache_read_tokens: 'prompt_cache_hit_tokens / prompt_tokens_details.cached_tokens',
          total_tokens: 'total_tokens',
        },
        notes: [
          'Số liệu chỉ lấy từ usage do upstream trả về cho từng request; request không có usage hiển thị "Không có dữ liệu".',
          'input_tokens là prompt_tokens của upstream và đã bao gồm phần cache read; không cộng cache read thêm lần nữa.',
          'cache write chỉ hiển thị khi upstream trả trường tương ứng; không suy ra từ input.',
          'Với retry, mỗi lần gọi upstream được cộng usage thực nhận; không nhân usage của phản hồi cuối với số lần thử.',
        ],
      });
      return;
    }

    // Request log. Unlike /api/usage this keeps failed and non-chat requests:
    // an operator debugging a 413 or a 429 needs the row that produced it, not
    // only the rows that carry token counts.
    if (pathname === '/api/logs' || pathname === '/api/logs/export') {
      if (!authorized(req)) { sendJson(res, 401, { error: 'unauthorized' }); return; }
      const now = Date.now();
      const from = parseBoundary(url.searchParams.get('from'), now - 24 * 3600000);
      const to = parseBoundary(url.searchParams.get('to'), now);
      const outcome = url.searchParams.get('outcome') || 'all';
      const account = (url.searchParams.get('account') || '').trim() || null;
      const model = (url.searchParams.get('model') || '').trim() || null;
      const query = (url.searchParams.get('q') || '').trim().toLowerCase();
      const protocol = (url.searchParams.get('protocol') || '').trim() || null;
      const rows = await readRowsInWindow(Math.min(from, to), Math.max(from, to), row => {
        if (account && row.account !== account) return false;
        if (model && row.model !== model) return false;
        if (protocol && row.protocol !== protocol) return false;
        if (outcome !== 'all' && outcomeOf(row) !== outcome) return false;
        if (query) {
          const haystack = [row.request_id, row.path, row.code, row.key, row.model, row.account].join(' ').toLowerCase();
          if (!haystack.includes(query)) return false;
        }
        return true;
      });
      rows.sort((a, b) => (a.at < b.at ? 1 : a.at > b.at ? -1 : 0));
      if (pathname === '/api/logs/export') {
        // CSV is generated from the same filtered rows; the request id is kept
        // so a line can be traced back, and no credential is ever included.
        const header = ['at_utc', 'at_local', 'request_id', 'key', 'account', 'model', 'path', 'protocol',
          'stream', 'status', 'code', 'upstream_attempts', 'upstream_retries', 'ms',
          'input_tokens', 'output_tokens', 'cache_write_tokens', 'cache_read_tokens', 'total_tokens', 'usage_source'];
        const quote = value => {
          if (value === null || value === undefined) return '';
          const text = String(value);
          return /[",\n]/.test(text) ? '"' + text.replaceAll('"', '""') + '"' : text;
        };
        const lines = [header.join(',')];
        for (const row of rows.slice(0, 50000)) {
          const usage = row.usage && typeof row.usage === 'object' ? row.usage : {};
          lines.push([
            row.at, localStamp(row.at), row.request_id, row.key, row.account, row.model, row.path, row.protocol,
            row.stream === true, row.status, row.code, row.upstream_attempts, row.upstream_retries, row.ms,
            usage.input_tokens, usage.output_tokens, usage.cache_write_tokens, usage.cache_read_tokens,
            usage.total_tokens, row.usage_source,
          ].map(quote).join(','));
        }
        const body = '\ufeff' + lines.join('\n') + '\n';
        res.writeHead(200, {
          'content-type': 'text/csv; charset=utf-8',
          'content-disposition': 'attachment; filename="buddy-logs-' + new Date(now).toISOString().slice(0, 10) + '.csv"',
          'cache-control': 'no-store',
        });
        res.end(body);
        return;
      }
      const requestedPage = Number(url.searchParams.get('page'));
      const page = Number.isInteger(requestedPage) && requestedPage > 0 ? requestedPage : 1;
      const pageSize = Math.min(500, Math.max(1, Number(url.searchParams.get('page_size')) || 50));
      const shaped = rows.map(row => ({
        at: row.at,
        at_local: localStamp(row.at),
        request_id: row.request_id || null,
        key: row.key || null,
        account: row.account || null,
        model: row.model || null,
        path: row.path || null,
        protocol: row.protocol || null,
        stream: row.stream === true,
        status: numeric(row.status),
        code: row.code || null,
        outcome: outcomeOf(row),
        upstream_attempts: numeric(row.upstream_attempts),
        upstream_retries: numeric(row.upstream_retries),
        ms: numeric(row.ms),
        input_tokens: usageOf(row) ? numeric(usageOf(row).input_tokens) : null,
        output_tokens: usageOf(row) ? numeric(usageOf(row).output_tokens) : null,
        cache_write_tokens: usageOf(row) ? numeric(usageOf(row).cache_write_tokens) : null,
        cache_read_tokens: usageOf(row) ? numeric(usageOf(row).cache_read_tokens) : null,
        usage_present: Boolean(usageOf(row)),
      }));
      const counts = { all: shaped.length, ok: 0, saturated: 0, failed: 0 };
      for (const row of shaped) counts[row.outcome] = (counts[row.outcome] || 0) + 1;
      sendJson(res, 200, {
        generatedAt: new Date(now).toISOString(),
        generatedAt_local: localStamp(new Date(now).toISOString()),
        timezone: TZ_NAME,
        timezone_offset: TZ_OFFSET,
        range: {
          from: new Date(Math.min(from, to)).toISOString(), to: new Date(Math.max(from, to)).toISOString(),
          from_local: localStamp(new Date(Math.min(from, to)).toISOString()),
          to_local: localStamp(new Date(Math.max(from, to)).toISOString()),
        },
        filters: { outcome, account, model, protocol, q: query || null },
        counts,
        accounts: [...new Set(rows.map(row => row.account).filter(Boolean))].sort(),
        models: [...new Set(rows.map(row => row.model).filter(Boolean))].sort(),
        rows: shaped.slice((page - 1) * pageSize, page * pageSize),
        total: shaped.length,
        page,
        page_size: pageSize,
        pages: Math.max(1, Math.ceil(shaped.length / pageSize)),
      });
      return;
    }

    if (pathname === '/api/account-rotation') {
      if (!authorized(req)) { sendJson(res, 401, { error: 'unauthorized' }); return; }
      if (req.method === 'POST') {
        if (!sameOrigin(req)) { sendJson(res,403,{error:'invalid_origin'}); return; }
        const {mode} = await readJson(req);
        const result = await callGatewayPost('/v1/account/rotation', {mode});
        sendJson(res,result.status || 502,result.body); return;
      }
    }
    if (pathname === '/api/active-account') {
      if (!authorized(req)) { sendJson(res, 401, { error: 'unauthorized' }); return; }
      if (req.method === 'GET') {
        const status = await callGateway('/v1/status');
        const accounts = status?.accounts || { active: null, entries: [] };
        sendJson(res, 200, accounts);
        return;
      }
      if (req.method === 'POST') {
        if (!sameOrigin(req)) { sendJson(res,403,{error:'invalid_origin'}); return; }
        const body = await readJson(req);
        const id = typeof body.id === 'string' ? body.id.trim().toLowerCase() : '';
        const result = await callGatewayPost('/v1/account', { id });
        gatewayCache = { at: 0, status: null, models: null, health: null };
        sendJson(res, result.status || 502, result.body);
        return;
      }
    }

    if (pathname === '/api/web-login' || pathname.startsWith('/api/web-login/')) {
      if (!authorized(req)) { sendJson(res, 401, { error: 'unauthorized' }); return; }
      // Cookie-authenticated writes must originate on this dashboard.
      if (req.method !== 'GET' && !sameOrigin(req)) { sendJson(res, 403, { error: 'invalid_origin' }); return; }
      const owner = sessionOf(req) || 'dashboard-key';
      if (pathname === '/api/web-login' && req.method === 'POST') {
        const result = await webLogin.start(owner);
        sendJson(res, result.error ? 503 : 201, result); return;
      }
      const id = pathname.slice('/api/web-login/'.length);
      const result = req.method === 'GET' ? webLogin.status(owner, id)
        : req.method === 'DELETE' ? webLogin.cancel(owner, id) : null;
      sendJson(res, result ? 200 : 404, result || { error: 'not_found' }); return;
    }

    if (pathname === '/api/accounts' || pathname.startsWith('/api/accounts/')) {
      if (!authorized(req)) { sendJson(res, 401, { error: 'unauthorized' }); return; }
      if (req.method === 'GET' && pathname === '/api/accounts') {
        const all = await listAccounts(API_ROOT);
        // The operator asked which snapshots are really the same upstream
        // account. Two signals, both honest:
        //   - same masked uid  -> certainly the same account
        //   - same full email  -> the same sign-in identity
        // The gateway already deduplicates by account identity at request time,
        // so a duplicate costs nothing except confusion; it is reported, not
        // acted upon.
        const accounts = all;
        const duplicates = [];
        const seenByUid = new Map();
        const seenByEmail = new Map();
        for (const account of all) {
          if (account.uid) {
            const prior = seenByUid.get(account.uid);
            if (prior) duplicates.push({ kind: 'uid', ids: [prior.id, account.id], uid: account.uid, email: prior.email || account.email || null });
            else seenByUid.set(account.uid, account);
          }
          if (account.email) {
            const prior = seenByEmail.get(account.email);
            if (prior) duplicates.push({ kind: 'email', ids: [prior.id, account.id], uid: prior.uid || account.uid || null, email: account.email });
            else seenByEmail.set(account.email, account);
          }
        }
        // Addresses that differ but look alike are the real trap here: the local
        // parts are one character apart, so pointing them out prevents picking
        // the wrong account when switching.
        const similar = [];
        // Every snapshot, including the hidden web-* ones: a look-alike route
        // through one of those is just as easy to mis-pick.
        const shown = all.filter(account => account.email);
        for (let i = 0; i < shown.length; i++) {
          for (let j = i + 1; j < shown.length; j++) {
            const a = shown[i], b = shown[j];
            // Compare the local part and the domain separately: same domain and
            // a short edit distance in the local part reads as a near-duplicate.
            const [aLocal, aDomain] = String(a.email).split('@');
            const [bLocal, bDomain] = String(b.email).split('@');
            if (aDomain !== bDomain) continue;
            if (aLocal === bLocal) continue;
            // Same domain, and a shared prefix long enough that the tail is what
            // distinguishes them. Five characters is the base name at minimum.
            let shared = 0;
            while (shared < aLocal.length && shared < bLocal.length && aLocal[shared] === bLocal[shared]) shared++;
            const differing = Math.max(aLocal.length, bLocal.length) - shared;
            if (shared >= 5 && differing <= 6) {
              similar.push({ ids: [a.id, b.id], emails: [a.email, b.email], sharedPrefix: aLocal.slice(0, shared) });
            }
          }
        }
        sendJson(res, 200, { accounts, duplicates, similar });
        return;
      }

// Small edit distance so two stored addresses that differ by one or two typed
// characters can be called out. Levenshtein over short strings is cheap here.
function editDistance(a, b) {
  if (a === b) return 0;
  const rows = a.length + 1, columns = b.length + 1;
  let previous = Array.from({ length: columns }, (_, i) => i);
  for (let row = 1; row < rows; row++) {
    const current = [row];
    for (let column = 1; column < columns; column++) {
      const substitution = previous[column - 1] + (a[row - 1] === b[column - 1] ? 0 : 1);
      current[column] = Math.min(substitution, previous[column] + 1, current[column - 1] + 1);
    }
    previous = current;
  }
  return previous[columns - 1];
}
      if (req.method === 'POST') {
        if (!sameOrigin(req)) { sendJson(res, 403, { error: 'invalid_origin' }); return; }
        const body = await readJson(req);
        const id = typeof body.id === 'string' ? body.id.trim().toLowerCase() : '';
        const action = pathname.slice('/api/accounts/'.length);
        if (action === 'capture') {
          const out = await captureAccount(API_ROOT, id);
          if (out.ok) {
            // Hand the fresh snapshot to the gateway so it is usable without a restart.
            const registered = await callGatewayPost('/v1/account/register', { id });
            out.registered = registered.status === 200;
            out.gatewayError = out.registered ? null : (registered.body?.error || 'register_failed');
            gatewayCache = { at: 0, status: null, models: null, health: null };
          }
          sendJson(res, out.ok ? 200 : 400, out);
          return;
        }
        if (action === 'verify') { const out = await verifyAccount(API_ROOT, id); sendJson(res, out.ok ? 200 : 400, out); return; }
        if (action === 'delete') { const out = await removeAccount(API_ROOT, id); sendJson(res, out.ok ? 200 : 400, out); return; }
      }
      sendJson(res, 404, { error: 'not_found' });
      return;
    }

    res.writeHead(404, { 'content-type': 'text/plain; charset=utf-8' });
    res.end('not found');
  } catch (error) {
    console.error(JSON.stringify({ event: 'dashboard_handler_error', name: String(error?.name || 'error') }));
    if (!res.headersSent) { res.writeHead(500, { 'content-type': 'application/json' }); res.end('{"error":"handler_failed"}'); }
  }
});

server.listen(PORT, '127.0.0.1', () => console.log(JSON.stringify({ event: 'dashboard_listening', url: `http://127.0.0.1:${PORT}`, version: VERSION, at: new Date().toISOString() })));
