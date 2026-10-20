// API-key store: generation shape, digest-only persistence, live directory
// reload, revocation, and the guarantee that a plaintext key never reaches disk.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  KEY_PREFIX, generateKey, looksLikeKey, emptyKeyDoc, loadKeyDoc, saveKeyDoc,
  createEntry, revokeEntry, identify, publicEntry, createKeyDirectory,
  allowsModel, normalizeModels,
} from '../apikeys.mjs';

const withRoot = async run => {
  const dir = await mkdtemp(join(tmpdir(), 'buddy-keys-'));
  try { return await run(dir); } finally { await rm(dir, { recursive: true, force: true }); }
};

test('generated keys carry the recognisable prefix and enough entropy', () => {
  const key = generateKey();
  assert.ok(key.startsWith(KEY_PREFIX));
  assert.ok(key.length >= 48, 'length ' + key.length);
  assert.match(key, /^buddy_sk_[a-f0-9]+$/);
  assert.ok(looksLikeKey(key));
  assert.equal(looksLikeKey('short'), false);
  assert.equal(looksLikeKey(null), false);
  assert.notEqual(generateKey(), generateKey());
});

test('only the digest and a short hint are written, never the token', async () => {
  await withRoot(async root => {
    const doc = emptyKeyDoc();
    const { token, entry } = createEntry(doc, { label: 'app nội bộ' });
    await saveKeyDoc(root, doc);
    const raw = await readFile(join(root, 'data', 'api-keys.json'), 'utf8');
    assert.ok(!raw.includes(token), 'plaintext token must not be on disk');
    assert.ok(raw.includes(entry.sha256));
    assert.ok(raw.includes('buddy_sk_'), 'hint keeps the prefix');
    assert.ok(!raw.includes(token.slice(KEY_PREFIX.length)), 'hint must not contain the secret body');
    // The hint is short enough to be useless as a credential.
    assert.ok(entry.hint.length < 24);
  });
});

test('identify matches the right key and refuses revoked, malformed and foreign ones', async () => {
  await withRoot(async root => {
    const doc = emptyKeyDoc();
    const first = createEntry(doc, { label: 'one' });
    const second = createEntry(doc, { label: 'two' });
    await saveKeyDoc(root, doc);
    const loaded = await loadKeyDoc(root);

    assert.equal(identify(loaded, first.token)?.id, first.entry.id);
    assert.equal(identify(loaded, second.token)?.id, second.entry.id);
    assert.equal(identify(loaded, 'buddy_sk_' + 'x'.repeat(40)), null);
    assert.equal(identify(loaded, first.token.slice(0, -1)), null);
    assert.equal(identify(loaded, 'not-a-key'), null);

    revokeEntry(loaded, first.entry.id);
    await saveKeyDoc(root, loaded);
    const afterRevoke = await loadKeyDoc(root);
    assert.equal(identify(afterRevoke, first.token), null, 'revoked key is refused');
    assert.equal(identify(afterRevoke, second.token)?.id, second.entry.id, 'other keys keep working');
  });
});

test('a revoked entry is kept for the audit trail and cannot be revoked twice', async () => {
  await withRoot(async root => {
    const doc = emptyKeyDoc();
    const { entry } = createEntry(doc, { label: 'once' });
    await saveKeyDoc(root, doc);
    const loaded = await loadKeyDoc(root);
    const revoked = revokeEntry(loaded, entry.id);
    assert.ok(revoked.revokedAt);
    await saveKeyDoc(root, loaded);
    const again = revokeEntry(await loadKeyDoc(root), entry.id);
    assert.equal(again, null);
    const doc2 = await loadKeyDoc(root);
    assert.equal(doc2.keys.length, 1, 'history is preserved');
    assert.ok(publicEntry(doc2.keys[0]).revokedAt);
  });
});

test('the directory picks up a key written after start without a restart', async () => {
  await withRoot(async root => {
    await saveKeyDoc(root, emptyKeyDoc());
    const directory = createKeyDirectory(root, { intervalMs: 40 });
    try {
      await directory.ready();
      assert.equal(directory.list().length, 0);

      const doc = await loadKeyDoc(root);
      const { entry, token } = createEntry(doc, { label: 'live' });
      await saveKeyDoc(root, doc);
      // The watcher polls; give it a couple of cycles.
      for (let i = 0; i < 40 && directory.list().length === 0; i++) {
        await new Promise(resolve => setTimeout(resolve, 25));
      }
      assert.equal(directory.list().length, 1);
      assert.equal(directory.list()[0].id, entry.id);

      const revoked = await loadKeyDoc(root);
      revokeEntry(revoked, entry.id);
      await saveKeyDoc(root, revoked);
      for (let i = 0; i < 40 && directory.list().length > 0; i++) {
        await new Promise(resolve => setTimeout(resolve, 25));
      }
      assert.equal(directory.list().length, 0, 'revocation reaches the directory');
      assert.equal(identify(await loadKeyDoc(root), token), null);
    } finally {
      await directory.close();
    }
  });
});

test('last-used is recorded for directory keys and flushed to disk', async () => {
  await withRoot(async root => {
    const doc = emptyKeyDoc();
    const { entry } = createEntry(doc, { label: 'used' });
    await saveKeyDoc(root, doc);
    const directory = createKeyDirectory(root, { intervalMs: 30 });
    try {
      await directory.ready();
      directory.markUsed(entry.id);
      // Bootstrap ids are not directory entries and must be ignored.
      directory.markUsed('primary');
      await directory.close();
      const reloaded = await loadKeyDoc(root);
      assert.ok(reloaded.keys[0].lastUsedAt, 'flush wrote the timestamp');
    } finally {
      await directory.close();
    }
  });
});

test('a hand-edited or corrupt key file degrades instead of breaking the gateway', async () => {
  await withRoot(async root => {
    const path = join(root, 'data', 'api-keys.json');
    await saveKeyDoc(root, emptyKeyDoc());
    await writeFile(path, '{ not json', 'utf8');
    assert.deepEqual((await loadKeyDoc(root)).keys, []);

    await writeFile(path, JSON.stringify({
      keys: [
        { id: 'k-12345678', sha256: 'a'.repeat(64), label: 'good', revokedAt: null },
        { id: 'bad id', sha256: 'b'.repeat(64), label: 'bad id' },
        { id: 'k-abcdef12', sha256: 'not-a-digest', label: 'bad digest' },
        null,
      ],
    }), 'utf8');
    const doc = await loadKeyDoc(root);
    assert.equal(doc.keys.length, 1);
    assert.equal(doc.keys[0].label, 'good');
  });
});

test('the file is created with owner-only permissions', async () => {
  await withRoot(async root => {
    const doc = emptyKeyDoc();
    createEntry(doc, { label: 'perm' });
    const path = await saveKeyDoc(root, doc);
    const info = await stat(path);
    if (process.platform !== 'win32') assert.equal(info.mode & 0o777, 0o600);
    else assert.ok(info.size > 0);
  });
});

test('an unrestricted key allows every model; an explicit list allows only its ids', () => {
  const open = { id: 'k-11111111', models: null };
  assert.equal(allowsModel(open, 'deepseek-v4.1-flash'), true);
  assert.equal(allowsModel(open, 'anything'), true);

  const restricted = { id: 'k-22222222', models: ['hy3', 'step-5-preview'] };
  assert.equal(allowsModel(restricted, 'hy3'), true);
  assert.equal(allowsModel(restricted, 'step-5-preview'), true);
  assert.equal(allowsModel(restricted, 'deepseek-v4.1-flash'), false);
  // A key with no grant can call nothing; this is deliberate, not "unlimited".
  assert.equal(allowsModel({ id: 'k-33333333', models: [] }, 'hy3'), false);
  assert.equal(allowsModel(null, 'hy3'), false);
});

test('a grant is normalised against the catalog and collapses to unrestricted', () => {
  const catalog = ['hy3', 'step-5-preview', 'deepseek-v4.1-flash', 'grok-4.7'];
  assert.equal(normalizeModels(null, catalog), null);
  assert.deepEqual(normalizeModels(['hy3'], catalog), ['hy3']);
  // Duplicates and unknown ids are dropped: a stale browser tab cannot grant a
  // model that is no longer served.
  assert.deepEqual(normalizeModels(['hy3', 'hy3', 'gone-model'], catalog), ['hy3']);
  // Selecting the whole catalog is the same permission as "all".
  assert.equal(normalizeModels([...catalog], catalog), null);
  // An empty selection stays empty rather than becoming unrestricted.
  assert.deepEqual(normalizeModels([], catalog), []);
  // An unknown-only selection also collapses to empty, not to "all".
  assert.deepEqual(normalizeModels(['gone-model'], catalog), []);
});

test('permissions survive the round trip through the file and the directory', async () => {
  await withRoot(async root => {
    const doc = emptyKeyDoc();
    const open = createEntry(doc, { label: 'open' });
    const narrow = createEntry(doc, { label: 'narrow' });
    narrow.entry.models = ['hy3'];
    await saveKeyDoc(root, doc);

    const loaded = await loadKeyDoc(root);
    const stored = loaded.keys.find(entry => entry.id === narrow.entry.id);
    assert.deepEqual(stored.models, ['hy3']);
    assert.equal(loaded.keys.find(entry => entry.id === open.entry.id).models, null);
    assert.deepEqual(publicEntry(stored).models, ['hy3']);

    const directory = createKeyDirectory(root, { intervalMs: 30 });
    try {
      await directory.ready();
      assert.deepEqual(directory.find(narrow.entry.id)?.models, ['hy3']);
      assert.equal(directory.find(open.entry.id)?.models, null);
      assert.equal(directory.find('primary'), null);
    } finally {
      await directory.close();
    }
  });
});
