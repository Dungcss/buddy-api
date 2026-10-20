// API-key store shared by the gateway and the dashboard.
//
// The gateway accepts every active key; the dashboard creates and revokes them.
// Only the SHA-256 digest is written to disk, so the file is useless as a
// credential even if it leaks. The plaintext exists exactly once: in the HTTP
// response to the create call, which the operator copies and then dismisses.
// Nothing here ever logs a key.
import { createHash, randomUUID, timingSafeEqual } from 'node:crypto';
import { readFile, writeFile, mkdir, chmod, rename, stat } from 'node:fs/promises';
import { join } from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const runFile = promisify(execFile);

const digestOf = value => createHash('sha256').update(value).digest();

export const keysPath = root => join(root, 'data', 'api-keys.json');

// A key is `buddy_sk_` + 40 hex characters: long enough that guessing is not a
// concern, and the prefix makes a stray key recognisable in a config file.
export const KEY_PREFIX = 'buddy_sk_';
const KEY_BODY_BYTES = 20;

export function looksLikeKey(value) {
  return typeof value === 'string' && value.startsWith(KEY_PREFIX) && value.length >= 40;
}

export function generateKey() {
  return KEY_PREFIX + randomUUID().replaceAll('-', '') + randomUUID().replaceAll('-', '').slice(0, 8);
}

// The id is what the access log records, so it must be short, stable and
// distinct from the secret itself.
const newId = () => 'k-' + randomUUID().replaceAll('-', '').slice(0, 8);

export function emptyKeyDoc() {
  return { version: 1, keys: [] };
}

export async function loadKeyDoc(root) {
  try {
    const doc = JSON.parse(await readFile(keysPath(root), 'utf8'));
    if (doc && Array.isArray(doc.keys)) {
      // Tolerate a hand-edited file: drop entries that cannot be used instead of
      // failing the whole gateway at startup.
      doc.keys = doc.keys.filter(entry =>
        entry && typeof entry.id === 'string' && /^k-[a-f0-9]{6,16}$/.test(entry.id) &&
        typeof entry.sha256 === 'string' && /^[a-f0-9]{64}$/.test(entry.sha256));
      return doc;
    }
  } catch {}
  return emptyKeyDoc();
}

// Write-then-rename keeps a reader from seeing a half-written file. The mode is
// 600 and, on Windows, the inherited ACL is stripped by the caller.
export async function saveKeyDoc(root, doc) {
  await mkdir(join(root, 'data'), { recursive: true });
  const target = keysPath(root);
  const temp = target + '.' + randomUUID().slice(0, 8) + '.tmp';
  const body = JSON.stringify({ version: 1, updatedAt: new Date().toISOString(), keys: doc.keys }, null, 2) + '\n';
  await writeFile(temp, body, { encoding: 'utf8', mode: 0o600 });
  await rename(temp, target);
  // Every write path — create, revoke, and the gateway's last-used flush — goes
  // through here. A rename installs a fresh file with inherited ACLs, so the
  // restriction has to be reapplied after each one, not only at creation.
  await restrictToServiceUser(target);
  return target;
}

// The file holds digests, not keys, but it still maps ids to identities; strip
// the inherited groups so only the service account can read it.
export async function restrictToServiceUser(target) {
  try { await chmod(target, 0o600); } catch {}
  if (process.platform !== 'win32') return;
  try {
    const { stdout } = await runFile('whoami.exe', ['/user', '/fo', 'csv', '/nh'], { windowsHide: true });
    const sid = stdout.match(/S-1-[0-9-]+/)?.[0];
    if (!sid) return;
    await runFile('icacls.exe', [target, '/inheritance:r', '/grant:r', '*' + sid + ':F'], { windowsHide: true });
  } catch {}
}

export function createEntry(doc, { label, createdBy }) {
  const token = generateKey();
  const entry = {
    id: newId(),
    label: typeof label === 'string' && label.trim() ? label.trim().slice(0, 60) : 'không tên',
    // Enough to recognise the key in a list, never enough to use it.
    hint: token.slice(0, KEY_PREFIX.length + 6) + '…' + token.slice(-4),
    sha256: digestOf(token).toString('hex'),
    createdAt: new Date().toISOString(),
    createdBy: createdBy || 'dashboard',
    revokedAt: null,
    lastUsedAt: null,
    // null means "every model the gateway serves". An array is an explicit
    // allow-list; an empty array is a key that may call nothing, which is a
    // useful state while a permission set is being prepared.
    models: null,
  };
  doc.keys.push(entry);
  return { token, entry };
}

// A key with no restriction accepts anything in the catalog. A restricted key
// accepts only the exact ids it was granted; a model that later disappears from
// the catalog is refused by the catalog check first.
export function allowsModel(entry, modelId) {
  if (!entry) return false;
  if (entry.models === null || entry.models === undefined) return true;
  if (!Array.isArray(entry.models)) return true;
  return entry.models.includes(modelId);
}

// Keeps a permission set stable and readable: known ids only, no duplicates,
// and an explicit "all" is stored as null rather than a huge list that would go
// stale the next time the catalog gains a model.
export function normalizeModels(models, catalogIds) {
  if (models === null || models === undefined) return null;
  if (!Array.isArray(models)) return null;
  const known = catalogIds ? new Set(catalogIds) : null;
  const unique = [...new Set(models.filter(id => typeof id === 'string' && id))];
  const kept = known ? unique.filter(id => known.has(id)) : unique;
  // Selecting every model is the same as no restriction; store the simpler form.
  if (known && kept.length === known.size && known.size > 0) return null;
  return kept;
}

export function revokeEntry(doc, id) {
  const entry = doc.keys.find(item => item.id === id && !item.revokedAt);
  if (!entry) return null;
  entry.revokedAt = new Date().toISOString();
  return entry;
}

// Constant work per candidate: every active key is compared, no early exit, so
// the response time does not reveal how close a guess was.
export function identify(doc, candidate) {
  if (!looksLikeKey(candidate)) return null;
  const incoming = digestOf(candidate);
  let found = null;
  for (const entry of doc.keys) {
    if (entry.revokedAt) continue;
    const stored = Buffer.from(entry.sha256, 'hex');
    if (stored.length === incoming.length && timingSafeEqual(stored, incoming)) found = entry;
  }
  return found;
}

export function publicEntry(entry) {
  return {
    id: entry.id,
    label: entry.label,
    hint: entry.hint,
    createdAt: entry.createdAt,
    createdBy: entry.createdBy,
    revokedAt: entry.revokedAt,
    lastUsedAt: entry.lastUsedAt,
    models: Array.isArray(entry.models) ? entry.models : null,
  };
}

// The gateway needs a live view: a key created in the dashboard must work on the
// next request, without a restart. The watcher re-reads the file when its mtime
// or size changes and swaps the digest list atomically.
export function createKeyDirectory(root, { intervalMs = 2000 } = {}) {
  let entries = [];
  let signature = '';
  let loading = null;
  let closed = false;
  // Last-use timestamps are collected in memory and flushed at most once a
  // minute: writing the file on every request would put disk I/O on the hot path
  // for no benefit.
  const used = new Map();
  let flushTimer = null;

  async function refresh() {
    if (loading) return loading;
    loading = (async () => {
      try {
        const info = await stat(keysPath(root));
        const next = info.mtimeMs + ':' + info.size;
        if (next === signature) return;
        const doc = await loadKeyDoc(root);
        entries = doc.keys
          .filter(entry => !entry.revokedAt)
          .map(entry => ({
            id: entry.id,
            digest: Buffer.from(entry.sha256, 'hex'),
            // null = unrestricted; an array is the allow-list the request path
            // checks after the catalog lookup.
            models: Array.isArray(entry.models) ? entry.models.slice() : null,
          }));
        signature = next;
      } catch {
        entries = [];
        signature = '';
      }
    })().finally(() => { loading = null; });
    return loading;
  }

  const timer = setInterval(() => { void refresh(); }, intervalMs);
  timer.unref?.();

  async function flushUsage() {
    if (!used.size) return;
    const pending = [...used.entries()];
    used.clear();
    try {
      const doc = await loadKeyDoc(root);
      let changed = false;
      for (const [id, at] of pending) {
        const entry = doc.keys.find(item => item.id === id);
        if (!entry) continue;
        // Keep the newest timestamp even if two flushes raced.
        if (!entry.lastUsedAt || Date.parse(entry.lastUsedAt) < Date.parse(at)) { entry.lastUsedAt = at; changed = true; }
      }
      if (changed) await saveKeyDoc(root, doc);
    } catch {}
  }
  function scheduleFlush() {
    if (flushTimer || closed) return;
    flushTimer = setTimeout(() => {
      flushTimer = null;
      void flushUsage().then(() => { if (used.size) scheduleFlush(); });
    }, 60000);
    flushTimer.unref?.();
  }

  return {
    async ready() { await refresh(); },
    // Synchronous snapshot for the request path: the list is swapped as a whole,
    // so a request never sees a partially updated set.
    list() { return entries; },
    find(id) { return entries.find(entry => entry.id === id) || null; },
    // Only dashboard keys are tracked; the bootstrap keys live in their own
    // files and have no row to update.
    markUsed(id) {
      if (!entries.some(entry => entry.id === id)) return;
      used.set(id, new Date().toISOString());
      scheduleFlush();
    },
    async reload() { signature = ''; await refresh(); },
    async close() { closed = true; clearInterval(timer); if (flushTimer) clearTimeout(flushTimer); await flushUsage(); },
    get closed() { return closed; },
  };
}
