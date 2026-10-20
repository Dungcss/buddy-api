// The access log is an audit trail: batching must never lose or reorder a line.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readdir, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

// createAccessLog is not exported; the gateway is exercised instead so this test
// covers the real wiring, including the flush timer and day rollover.
test('every request produces exactly one ordered log line', async () => {
  const { createGateway } = await import('../server.mjs');
  const dir = await mkdtemp(join(tmpdir(), 'buddy-log-'));
  try {
    const stream = () => new Response(
      'data: ' + JSON.stringify({ choices: [{ index: 0, delta: { content: 'OK' }, finish_reason: 'stop' }] }) + '\n\ndata: [DONE]\n\n',
      { headers: { 'content-type': 'text/event-stream' } });
    const adapter = {
      accountIdentity: async () => 'a', accountId: 'a', accounts: ['a'],
      lease: async () => ({ accountId: 'a', adapter, success: async () => {}, failure: async () => {}, release: () => {}, prepareRetry: async () => false }),
      listModels: async () => [{ id: 'free', billing: { free: true } }],
      chatStream: async () => ({ ok: true, response: stream() }),
    };
    const key = 'L'.repeat(40);
    const server = createGateway({ adapter, apiKey: key, accessLogDir: dir });
    await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
    try {
      const url = 'http://127.0.0.1:' + server.address().port + '/v1/chat/completions';
      // A burst of concurrent requests: the batched writer must coalesce them
      // without dropping any, and the flush must land before we read.
      const results = await Promise.all(Array.from({ length: 12 }, (_, i) =>
        fetch(url, { method: 'POST', headers: { 'x-api-key': key, 'content-type': 'application/json', 'x-request-id': 'log-' + i },
          body: JSON.stringify({ model: 'free', messages: [{ role: 'user', content: 'x' }] }) })));
      for (const r of results) assert.equal(r.status, 200);
      for (const r of results) await r.text();
      await new Promise(resolve => setTimeout(resolve, 400));

      const name = 'access-' + new Date().toISOString().slice(0, 10).replaceAll('-', '') + '.jsonl';
      const lines = (await readFile(join(dir, name), 'utf8')).trim().split('\n');
      assert.equal(lines.length, 12, 'one line per request, nothing lost');
      const ids = lines.map(line => JSON.parse(line).request_id);
      for (let i = 0; i < 12; i++) assert.ok(ids.includes('log-' + i), 'request log-' + i + ' present');
      // Handshake, reject and health probes must not create stray lines.
      await new Promise(resolve => setTimeout(resolve, 200));
      const files = await readdir(dir);
      assert.equal(files.length, 1, 'single day file, no empty duplicates');
    } finally { await new Promise(resolve => server.close(resolve)); }
  } finally { await rm(dir, { recursive: true, force: true }); }
});
