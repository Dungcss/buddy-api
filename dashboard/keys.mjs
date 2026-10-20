// Dashboard key store: one credential per person, each revocable on its own.
// Only SHA-256 digests are stored; plaintext keys are shown once at creation.
import { createHash, randomUUID, timingSafeEqual } from 'node:crypto';
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { join } from 'node:path';

const digest = value => createHash('sha256').update(value).digest();

export const keysPath = root => join(root, 'secrets', 'dashboard-keys.json');

export async function loadKeys(root, legacyPath) {
  try {
    const doc = JSON.parse(await readFile(keysPath(root), 'utf8'));
    if (Array.isArray(doc.keys)) return doc;
  } catch {}
  // One-time migration from the single shared key, kept so existing sessions
  // and scripts do not break.
  let legacy = '';
  try { legacy = (await readFile(legacyPath, 'utf8')).trim(); } catch {}
  const doc = {
    version: 1,
    keys: legacy.length >= 24
      ? [{ id: 'legacy', label: 'Khóa chung ban đầu', sha256: digest(legacy).toString('hex'), createdAt: new Date().toISOString(), revokedAt: null }]
      : [],
  };
  await saveKeys(root, doc);
  return doc;
}

export async function saveKeys(root, doc) {
  await mkdir(join(root, 'secrets'), { recursive: true });
  await writeFile(keysPath(root), JSON.stringify(doc, null, 2) + '\n', { encoding: 'utf8', mode: 0o600 });
}

export function createKey(doc, { id, label }) {
  const token = 'dash_' + randomUUID().replaceAll('-', '') + randomUUID().replaceAll('-', '');
  doc.keys.push({
    id: id || randomUUID().slice(0, 8),
    label: label || id || 'không tên',
    sha256: digest(token).toString('hex'),
    createdAt: new Date().toISOString(),
    revokedAt: null,
  });
  return token;
}

export function revokeKey(doc, id) {
  const entry = doc.keys.find(key => key.id === id && !key.revokedAt);
  if (!entry) return false;
  entry.revokedAt = new Date().toISOString();
  return true;
}

// Constant work per request: every active key is compared, no early exit.
export function identify(doc, candidate) {
  if (typeof candidate !== 'string' || candidate.length < 16) return null;
  const incoming = digest(candidate);
  let found = null;
  for (const entry of doc.keys) {
    if (entry.revokedAt) continue;
    const stored = Buffer.from(entry.sha256, 'hex');
    if (stored.length === incoming.length && timingSafeEqual(stored, incoming)) found = entry;
  }
  return found;
}
