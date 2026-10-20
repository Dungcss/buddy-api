// Session-file merge, kept separate from the server so the rule can be tested
// without booting it.
//
// Why a merge: two dashboard processes can point at one data directory (the
// scheduled service plus a test run, or a staging copy). Writing only the local
// map erased the other process's sessions; a login in one process then looked
// like a logout in the other.
import { readFile, writeFile, mkdir, rename } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { dirname } from 'node:path';

/**
 * Merge this process's sessions into the file and write it atomically.
 *
 * @param {string} file                 path to dashboard-sessions.json
 * @param {Map<string, number>} local   digest -> expiry (ms)
 * @param {Set<string>} revoked         digests logged out by this process
 * @returns {Promise<number>} number of live sessions written
 */
export async function mergeSessionFile(file, local, revoked = new Set()) {
  const now = Date.now();
  const merged = new Map();

  try {
    const doc = JSON.parse(await readFile(file, 'utf8'));
    for (const entry of Array.isArray(doc.sessions) ? doc.sessions : []) {
      if (!entry || typeof entry.id !== 'string' || !/^[a-f0-9]{64}$/.test(entry.id)) continue;
      if (!Number.isFinite(entry.expires) || entry.expires <= now) continue;
      merged.set(entry.id, entry.expires);
    }
  } catch {}

  // This process's view wins for the ids it knows about, including removals.
  for (const [id, expires] of local) {
    if (Number.isFinite(expires) && expires > now) merged.set(id, expires);
    else merged.delete(id);
  }
  for (const id of revoked) merged.delete(id);

  const body = JSON.stringify({
    sessions: [...merged.entries()].map(([id, expires]) => ({ id, expires })),
    updatedAt: new Date(now).toISOString(),
  }) + '\n';

  await mkdir(dirname(file), { recursive: true });
  const temp = file + '.' + randomUUID().slice(0, 8) + '.tmp';
  await writeFile(temp, body, { encoding: 'utf8', mode: 0o600 });
  await rename(temp, file);
  return merged.size;
}
