// Two dashboard processes can share one data directory (the service plus a test
// run, or a staging copy). A logout in one must not erase the other's sessions,
// and a merge must not resurrect a session that was just logged out.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, writeFile, mkdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { mergeSessionFile } from '../dashboard/sessions.mjs';

const withDir = async run => {
  const dir = await mkdtemp(join(tmpdir(), 'buddy-sessions-'));
  try { return await run(dir); } catch (error) { throw error; } finally { await rm(dir, { recursive: true, force: true }); }
};

test('a merge keeps sessions written by another process', async () => {
  await withDir(async dir => {
    const file = join(dir, 'dashboard-sessions.json');
    const now = Date.now();
    await mkdir(dir, { recursive: true });
    await writeFile(file, JSON.stringify({
      sessions: [{ id: 'a'.repeat(64), expires: now + 60000 }],
    }), 'utf8');

    const result = await mergeSessionFile(file, new Map([['b'.repeat(64), now + 60000]]), new Set());
    const doc = JSON.parse(await readFile(file, 'utf8'));
    const ids = doc.sessions.map(entry => entry.id).sort();
    assert.deepEqual(ids, ['a'.repeat(64), 'b'.repeat(64)]);
    assert.equal(result, 2);
  });
});

test('expired entries are dropped and revoked ids never come back', async () => {
  await withDir(async dir => {
    const file = join(dir, 'dashboard-sessions.json');
    const now = Date.now();
    await writeFile(file, JSON.stringify({
      sessions: [
        { id: 'a'.repeat(64), expires: now + 60000 },
        { id: 'b'.repeat(64), expires: now - 1000 },
      ],
    }), 'utf8');

    await mergeSessionFile(file, new Map([['c'.repeat(64), now + 60000]]), new Set(['a'.repeat(64)]));
    const doc = JSON.parse(await readFile(file, 'utf8'));
    const ids = doc.sessions.map(entry => entry.id);
    assert.deepEqual(ids, ['c'.repeat(64)]);
  });
});

test('a corrupt file is replaced instead of failing the dashboard', async () => {
  await withDir(async dir => {
    const file = join(dir, 'dashboard-sessions.json');
    await writeFile(file, '{ not json', 'utf8');
    await mergeSessionFile(file, new Map([['d'.repeat(64), Date.now() + 60000]]), new Set());
    const doc = JSON.parse(await readFile(file, 'utf8'));
    assert.equal(doc.sessions.length, 1);
  });
});
