// Gateway enforcement of a key's model allow-list. This is the part that has to
// hold even if the dashboard is wrong: discovery and inference both refuse a
// model the key was not granted.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createGateway } from '../server.mjs';
import { emptyKeyDoc, createEntry, saveKeyDoc, createKeyDirectory } from '../apikeys.mjs';

const frame = (usage) => new Response(
  'data: ' + JSON.stringify({ choices: [{ index: 0, delta: { content: 'OK' }, finish_reason: 'stop' }], usage }) + '\n\ndata: [DONE]\n\n',
  { headers: { 'content-type': 'text/event-stream' } });

function makeAdapter(calls) {
  const adapter = {
    accountIdentity: async () => 'a', accountId: 'a', accounts: ['a'],
    lease: async () => ({ accountId: 'a', adapter, success: async () => {}, failure: async () => {}, release: () => {}, prepareRetry: async () => false }),
    listModels: async () => [
      { id: 'hy3', billing: { free: true } },
      { id: 'step-5-preview', billing: { free: true } },
      { id: 'deepseek-v4.1-flash', billing: { free: true } },
      { id: 'grok-4.7', billing: { free: false, credits: 'x1.90' } },
    ],
    chatStream: async body => {
      calls.push(body.model);
      return { ok: true, response: frame({ prompt_tokens: 10, completion_tokens: 2, total_tokens: 12 }) };
    },
  };
  return adapter;
}

const call = (port, key, model) => fetch('http://127.0.0.1:' + port + '/v1/chat/completions', {
  method: 'POST',
  headers: { 'x-api-key': key, 'content-type': 'application/json' },
  body: JSON.stringify({ model, messages: [{ role: 'user', content: 'x' }] }),
});

test('a restricted key sees and calls only its granted models', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'buddy-perm-'));
  const logDir = await mkdtemp(join(tmpdir(), 'buddy-perm-log-'));
  const doc = emptyKeyDoc();
  const restricted = createEntry(doc, { label: 'restricted' });
  restricted.entry.models = ['hy3', 'step-5-preview'];
  const open = createEntry(doc, { label: 'open' });
  await saveKeyDoc(dir, doc);

  const calls = [];
  const directory = createKeyDirectory(dir, { intervalMs: 40 });
  await directory.ready();
  const server = createGateway({
    adapter: makeAdapter(calls),
    apiKey: 'p'.repeat(40),
    accessLogDir: logDir,
    keyDirectory: directory,
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const port = server.address().port;
  try {
    // Discovery is filtered: the restricted key is not told about grok-4.7.
    const listed = await (await fetch('http://127.0.0.1:' + port + '/v1/models', {
      headers: { 'x-api-key': restricted.token },
    })).json();
    assert.deepEqual(listed.data.map(model => model.id).sort(), ['hy3', 'step-5-preview']);

    // An unrestricted key still sees the whole catalog, including paid models.
    const all = await (await fetch('http://127.0.0.1:' + port + '/v1/models', {
      headers: { 'x-api-key': open.token },
    })).json();
    assert.equal(all.data.length, 4);

    // A granted model works.
    const allowed = await call(port, restricted.token, 'hy3');
    assert.equal(allowed.status, 200);
    await allowed.text();

    // A real catalog model outside the grant is a permission error, not a 404.
    const denied = await call(port, restricted.token, 'grok-4.7');
    assert.equal(denied.status, 403);
    const deniedBody = await denied.json();
    // OpenAI-shaped error envelope: { error: { message, type, code } }.
    assert.equal(deniedBody.error.code, 'model_not_allowed');
    assert.equal(deniedBody.error.type, 'model_not_allowed');

    // A model that does not exist at all is still "not found".
    const missing = await call(port, restricted.token, 'not-a-model');
    assert.equal(missing.status, 404);
    const missingBody = await missing.json();
    assert.equal(missingBody.error.code, 'model_not_found');

    // The denied and missing calls never reached upstream.
    assert.deepEqual(calls, ['hy3']);

    // The open key can call a paid model.
    const paid = await call(port, open.token, 'grok-4.7');
    assert.equal(paid.status, 200);
    await paid.text();
    assert.deepEqual(calls, ['hy3', 'grok-4.7']);

    // Access log records the key id, so per-key usage is attributable.
    const name = 'access-' + new Date().toISOString().slice(0, 10).replaceAll('-', '') + '.jsonl';
    await new Promise(resolve => setTimeout(resolve, 150));
    const rows = (await readFile(join(logDir, name), 'utf8')).trim().split('\n').map(JSON.parse);
    assert.ok(rows.some(row => row.key === restricted.entry.id && row.status === 403));
    assert.ok(rows.some(row => row.key === open.entry.id && row.model === 'grok-4.7'));
  } finally {
    await new Promise(resolve => server.close(resolve));
    await directory.close();
    await rm(dir, { recursive: true, force: true });
    await rm(logDir, { recursive: true, force: true });
  }
});

test('a key with an empty grant can call nothing and sees no models', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'buddy-perm-empty-'));
  const logDir = await mkdtemp(join(tmpdir(), 'buddy-perm-empty-log-'));
  const doc = emptyKeyDoc();
  const blocked = createEntry(doc, { label: 'blocked' });
  blocked.entry.models = [];
  await saveKeyDoc(dir, doc);

  const calls = [];
  const directory = createKeyDirectory(dir, { intervalMs: 40 });
  await directory.ready();
  const server = createGateway({ adapter: makeAdapter(calls), apiKey: 'q'.repeat(40), accessLogDir: logDir, keyDirectory: directory });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const port = server.address().port;
  try {
    const listed = await (await fetch('http://127.0.0.1:' + port + '/v1/models', { headers: { 'x-api-key': blocked.token } })).json();
    assert.deepEqual(listed.data, []);
    const denied = await call(port, blocked.token, 'hy3');
    assert.equal(denied.status, 403);
    assert.deepEqual(calls, []);
  } finally {
    await new Promise(resolve => server.close(resolve));
    await directory.close();
    await rm(dir, { recursive: true, force: true });
    await rm(logDir, { recursive: true, force: true });
  }
});

test('bootstrap keys stay unrestricted and unknown keys stay rejected', async () => {
  const logDir = await mkdtemp(join(tmpdir(), 'buddy-perm-boot-'));
  const calls = [];
  const server = createGateway({ adapter: makeAdapter(calls), apiKey: 'b'.repeat(40), accessLogDir: logDir });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const port = server.address().port;
  try {
    const listed = await (await fetch('http://127.0.0.1:' + port + '/v1/models', { headers: { 'x-api-key': 'b'.repeat(40) } })).json();
    assert.equal(listed.data.length, 4);
    const unknown = await fetch('http://127.0.0.1:' + port + '/v1/models', { headers: { 'x-api-key': 'z'.repeat(40) } });
    assert.equal(unknown.status, 401);
  } finally {
    await new Promise(resolve => server.close(resolve));
    await rm(logDir, { recursive: true, force: true });
  }
});
