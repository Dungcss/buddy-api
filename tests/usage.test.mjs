import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { normalizeUsage, combineUsage, aggregateRows, groupTotals } from '../usage.mjs';
import { createGateway, createAccountPool, streamCompletion, collectCompletion } from '../server.mjs';

const UPSTREAM = {
  prompt_tokens: 1000,
  completion_tokens: 40,
  total_tokens: 1040,
  prompt_cache_hit_tokens: 800,
  prompt_cache_miss_tokens: 200,
  prompt_cache_write_tokens: 0,
  cache_creation_input_tokens: 0,
  cache_read_input_tokens: 0,
  prompt_tokens_details: { cached_tokens: 800 },
  completion_thinking_tokens: 7,
  credit: 0,
};

test('non-streaming usage maps input/output/cache read without double counting', () => {
  const usage = normalizeUsage(UPSTREAM);
  assert.equal(usage.input_tokens, 1000);
  assert.equal(usage.output_tokens, 40);
  assert.equal(usage.cache_read_tokens, 800);
  assert.equal(usage.cache_write_tokens, 0);
  // 800 + 200 === 1000, so the cache read is already inside prompt_tokens.
  assert.equal(usage.input_includes_cache_read, true);
  assert.equal(usage.total_tokens, 1040);
  // Sanity: input + output equals the upstream total, proving no addition.
  assert.equal(usage.input_tokens + usage.output_tokens, usage.total_tokens);
});

test('cache write comes only from an explicit upstream field', () => {
  const withWrite = normalizeUsage({ prompt_tokens: 500, completion_tokens: 5, prompt_cache_write_tokens: 320 });
  assert.equal(withWrite.cache_write_tokens, 320);
  assert.equal(withWrite.cache_read_tokens, null);

  const without = normalizeUsage({ prompt_tokens: 500, completion_tokens: 5 });
  assert.equal(without.cache_write_tokens, null, 'must not be derived from input');
  assert.equal(without.cache_read_tokens, null, 'absent cache read is null, not 0');
  assert.equal(without.input_includes_cache_read, null, 'unprovable stays null');
});

test('missing usage is null and distinct from zero', () => {
  assert.equal(normalizeUsage(undefined), null);
  assert.equal(normalizeUsage(null), null);
  assert.equal(normalizeUsage({}), null);
  assert.equal(normalizeUsage({ unrelated: 1 }), null);
  const zeros = normalizeUsage({ prompt_tokens: 0, completion_tokens: 0, prompt_cache_hit_tokens: 0, prompt_cache_write_tokens: 0 });
  assert.equal(zeros.input_tokens, 0);
  assert.equal(zeros.cache_read_tokens, 0);
  assert.equal(zeros.cache_write_tokens, 0);
});

// The aggregate has to report what the upstream schema proved, not assert a rule
// for every row: one request with cache read larger than input is evidence that
// input does NOT contain the cached part for that row.
test('aggregate reports whether input contains cache read, and stays honest when mixed', () => {
  const contained = aggregateRows([
    { usage_present: true, input_tokens: 1000, cache_read_tokens: 800, input_includes_cache_read: true },
    { usage_present: true, input_tokens: 500, cache_read_tokens: 100, input_includes_cache_read: true },
  ]);
  assert.equal(contained.input_includes_cache_read, 'yes');
  assert.deepEqual(contained.cache_read_in_input, { true: 2, false: 0, unknown: 0 });

  const excluded = aggregateRows([
    { usage_present: true, input_tokens: 100, cache_read_tokens: 800, input_includes_cache_read: false },
  ]);
  assert.equal(excluded.input_includes_cache_read, 'no');

  const mixed = aggregateRows([
    { usage_present: true, input_tokens: 1000, cache_read_tokens: 800, input_includes_cache_read: true },
    { usage_present: true, input_tokens: 100, cache_read_tokens: 800, input_includes_cache_read: false },
    { usage_present: true, input_tokens: 10, output_tokens: 1, input_includes_cache_read: null },
    { usage_present: false },
  ]);
  assert.equal(mixed.input_includes_cache_read, 'mixed');
  assert.deepEqual(mixed.cache_read_in_input, { true: 1, false: 1, unknown: 1 });
  assert.equal(mixed.missing_usage, 1);
  // Missing rows never contribute a token count.
  assert.equal(mixed.input_tokens, 1110);
});

test('a row with cache read but no input field keeps input missing', () => {
  const totals = aggregateRows([
    { usage_present: true, input_tokens: null, output_tokens: 5, cache_read_tokens: 900 },
  ]);
  assert.equal(totals.input_tokens, null);
  assert.equal(totals.output_tokens, 5);
  assert.equal(totals.coverage.input_tokens, 0);
  assert.equal(totals.coverage.cache_read_tokens, 1);
});

test('aggregateRows accepts flat detail rows as produced by the dashboard API', async () => {
  const rows = [
    { request_id: 'x1', at_local: '2026-10-20 00:00:00', account: 'a', model: 'free', status: 200,
      input_tokens: 10, output_tokens: 2, cache_write_tokens: null, cache_read_tokens: 4, total_tokens: 12, usage_present: true },
    { request_id: 'x2', at_local: '2026-10-20 00:00:01', account: 'a', model: 'free', status: 500,
      input_tokens: null, output_tokens: null, cache_write_tokens: null, cache_read_tokens: null, total_tokens: null, usage_present: false },
  ];
  const totals = aggregateRows(rows);
  assert.equal(totals.requests, 2);
  assert.equal(totals.usage_requests, 1);
  assert.equal(totals.missing_usage, 1);
  assert.equal(totals.input_tokens, 10);
  assert.equal(totals.output_tokens, 2);
  assert.equal(totals.cache_read_tokens, 4);
  assert.equal(totals.cache_write_tokens, null, 'a null field never becomes 0');
  // By-account grouping must sum the same way.
  const grouped = groupTotals(rows, row => row.account).find(group => group.key === 'a');
  assert.equal(grouped.input_tokens, 10);
  assert.equal(grouped.cache_read_tokens, 4);
  assert.equal(grouped.missing_usage, 1);
});

test('summary equals the sum of detail rows for the same filter set', () => {
  const rows = [
    { request_id: 'a', at: '2026-10-19T18:00:00Z', at_local: '2026-10-20 01:00:00', account: 'a', model: 'm1',
      input_tokens: 100, output_tokens: 10, cache_write_tokens: 0, cache_read_tokens: 90, total_tokens: 110 },
    { request_id: 'b', at: '2026-10-19T18:05:00Z', at_local: '2026-10-20 01:05:00', account: 'b', model: 'm1',
      input_tokens: 50, output_tokens: 5, cache_write_tokens: null, cache_read_tokens: 30, total_tokens: 55 },
    { request_id: 'c', at: '2026-10-19T18:06:00Z', at_local: '2026-10-20 01:06:00', account: 'b', model: 'm2',
      input_tokens: null, output_tokens: null, cache_write_tokens: null, cache_read_tokens: null, total_tokens: null },
  ];
  const totals = aggregateRows(rows);
  assert.equal(totals.requests, 3);
  const byAccount = groupTotals(rows, row => row.account);
  assert.equal(byAccount.reduce((sum, group) => sum + group.requests, 0), totals.requests);
  assert.equal(byAccount.reduce((sum, group) => sum + (group.input_tokens || 0), 0), totals.input_tokens);
  assert.equal(byAccount.reduce((sum, group) => sum + (group.output_tokens || 0), 0), totals.output_tokens);
  assert.equal(byAccount.reduce((sum, group) => sum + (group.cache_read_tokens || 0), 0), totals.cache_read_tokens);
  assert.equal(byAccount.reduce((sum, group) => sum + group.missing_usage, 0), totals.missing_usage);
});

test('retry sums usage actually received instead of multiplying the last response', () => {
  const first = { prompt_tokens: 100, completion_tokens: 0, prompt_cache_write_tokens: 0 };
  const second = { prompt_tokens: 120, completion_tokens: 30, prompt_cache_read_tokens: 0, prompt_cache_hit_tokens: 50, prompt_cache_miss_tokens: 70 };
  const combined = combineUsage([first, second]);
  assert.equal(combined.usage_attempts, 2);
  assert.equal(combined.input_tokens, 220);
  assert.equal(combined.output_tokens, 30);
  assert.equal(combined.cache_write_tokens, 0);
  assert.equal(combined.cache_read_tokens, 50);
  // Only one attempt had usage, so the aggregate is that attempt once.
  const single = combineUsage([null, second]);
  assert.equal(single.usage_attempts, 1);
  assert.equal(single.input_tokens, 120);
  assert.equal(combineUsage([]), null);
  assert.equal(combineUsage([null, null]), null);
});

test('aggregates equal the sum of detail rows and keep missing separate', () => {
  const rows = [
    { usage: normalizeUsage({ prompt_tokens: 10, completion_tokens: 2, prompt_cache_hit_tokens: 4, prompt_cache_miss_tokens: 6 }) },
    { usage: normalizeUsage({ prompt_tokens: 20, completion_tokens: 3 }) },
    { usage: null },
    { usage: null },
  ];
  const totals = aggregateRows(rows);
  assert.equal(totals.requests, 4);
  assert.equal(totals.usage_requests, 2);
  assert.equal(totals.missing_usage, 2);
  assert.equal(totals.input_tokens, 30);
  assert.equal(totals.output_tokens, 5);
  assert.equal(totals.cache_read_tokens, 4);
  assert.equal(totals.cache_write_tokens, null, 'no row reported a write counter');
  assert.equal(totals.coverage.input_tokens, 2);
  assert.equal(totals.coverage.cache_write_tokens, 0);
  const groups = groupTotals(rows, row => (row.usage ? 'a' : 'b'));
  assert.equal(groups.reduce((sum, group) => sum + group.requests, 0), totals.requests);
  assert.equal(groups.reduce((sum, group) => sum + (group.input_tokens || 0), 0), totals.input_tokens);
});

test('stream parser captures the terminal usage frame without altering bytes', async () => {
  const frames = [
    { id: 'x', choices: [{ index: 0, delta: { content: 'ok' }, finish_reason: '' }], usage: null },
    { id: 'x', choices: [{ index: 0, delta: {}, finish_reason: 'stop' }], usage: UPSTREAM },
  ];
  const body = frames.map(frame => 'data: ' + JSON.stringify(frame) + '\n\n').join('') + 'data: [DONE]\n\n';
  const source = new Response(body, { headers: { 'content-type': 'text/event-stream' } }).body;
  const seen = [];
  const chunks = [];
  for await (const chunk of streamCompletion(source, { onUsage: usage => seen.push(usage) })) chunks.push(chunk);
  const forwarded = Buffer.concat(chunks.map(chunk => Buffer.from(chunk))).toString('utf8');
  assert.equal(forwarded, body, 'forwarded bytes must be identical');
  assert.equal(seen.length, 1);
  assert.equal(seen[0].prompt_tokens, 1000);
  assert.equal(normalizeUsage(seen[0]).cache_read_tokens, 800);
});

test('stream parser tolerates CRLF, chunk splits and absent usage', async () => {
  const frame = JSON.stringify({ choices: [{ index: 0, delta: { content: 'hi' }, finish_reason: 'stop' }], usage: { prompt_tokens: 5, completion_tokens: 1 } });
  const body = 'data: ' + frame + '\r\n\r\ndata: [DONE]\r\n\r\n';
  const bytes = Buffer.from(body);
  // Split inside the usage JSON to prove the accumulator crosses chunk bounds.
  const split = Math.floor(bytes.length / 2);
  const source = new Response(new Blob([bytes.subarray(0, split), bytes.subarray(split)]).stream()).body;
  const seen = [];
  for await (const _ of streamCompletion(source, { onUsage: usage => seen.push(usage) })) { /* drain */ }
  assert.equal(seen.length, 1);
  assert.equal(seen[0].prompt_tokens, 5);

  const noUsage = new Response('data: ' + JSON.stringify({ choices: [{ index: 0, delta: { content: 'x' }, finish_reason: 'stop' }] }) + '\n\ndata: [DONE]\n\n', { headers: { 'content-type': 'text/event-stream' } }).body;
  const seenNone = [];
  for await (const _ of streamCompletion(noUsage, { onUsage: usage => seenNone.push(usage) })) { /* drain */ }
  assert.deepEqual(seenNone, []);
});

test('non-streaming collector keeps upstream usage intact', async () => {
  const body = 'data: ' + JSON.stringify({ choices: [{ index: 0, delta: { content: 'ok' }, finish_reason: 'stop' }], usage: UPSTREAM }) + '\n\ndata: [DONE]\n\n';
  const completion = await collectCompletion(new Response(body, { headers: { 'content-type': 'text/event-stream' } }), 'free');
  assert.deepEqual(completion.usage, UPSTREAM);
  assert.equal(normalizeUsage(completion.usage).cache_read_tokens, 800);
});

function upstream(usage) {
  const frames = [{ choices: [{ index: 0, delta: { content: 'OK' }, finish_reason: '' }], usage: null }];
  if (usage !== undefined) frames.push({ choices: [{ index: 0, delta: {}, finish_reason: 'stop' }], usage });
  else frames.push({ choices: [{ index: 0, delta: {}, finish_reason: 'stop' }] });
  return new Response(frames.map(frame => 'data: ' + JSON.stringify(frame) + '\n\n').join('') + 'data: [DONE]\n\n',
    { headers: { 'content-type': 'text/event-stream' } });
}

async function readLog(dir) {
  const name = 'access-' + new Date().toISOString().slice(0, 10).replaceAll('-', '') + '.jsonl';
  await new Promise(resolve => setTimeout(resolve, 120));
  return (await readFile(join(dir, name), 'utf8')).trim().split('\n').map(line => JSON.parse(line));
}

test('HTTP streaming and non-streaming requests persist upstream usage', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'buddy-usage-'));
  const adapter = {
    accountIdentity: async () => 'a', accountId: 'a', accounts: ['a'],
    lease: async () => ({ accountId: 'a', adapter, success: async () => {}, failure: async () => {}, release: () => {}, prepareRetry: async () => false }),
    listModels: async () => [{ id: 'free', billing: { free: true } }],
    chatStream: async () => ({ ok: true, response: upstream(UPSTREAM) }),
  };
  const key = 'u'.repeat(40);
  const server = createGateway({ adapter, apiKey: key, limits: { upstreamRetries: 5 }, accessLogDir: dir });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  try {
    const url = 'http://127.0.0.1:' + server.address().port + '/v1/chat/completions';
    const post = (id, stream) => fetch(url, {
      method: 'POST',
      headers: { 'x-api-key': key, 'content-type': 'application/json', 'x-request-id': id },
      body: JSON.stringify({ model: 'free', stream, messages: [{ role: 'user', content: 'x' }] }),
    });
    const plain = await post('usage-plain', false);
    assert.equal(plain.status, 200);
    assert.equal((await plain.json()).usage.prompt_tokens, 1000);
    const streamed = await post('usage-stream', true);
    assert.equal(streamed.status, 200);
    await streamed.text();

    const rows = await readLog(dir);
    for (const id of ['usage-plain', 'usage-stream']) {
      const row = rows.find(entry => entry.request_id === id);
      assert.ok(row, 'row ' + id);
      assert.equal(row.usage_source, 'upstream');
      assert.equal(row.usage.input_tokens, 1000);
      assert.equal(row.usage.output_tokens, 40);
      assert.equal(row.usage.cache_read_tokens, 800);
      assert.equal(row.usage.cache_write_tokens, 0);
      assert.equal(row.usage.usage_attempts, 1);
    }
  } finally { await new Promise(resolve => server.close(resolve)); await rm(dir, { recursive: true, force: true }); }
});

test('HTTP request without upstream usage logs null usage, not zeros', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'buddy-usage-none-'));
  const adapter = {
    accountIdentity: async () => 'a', accountId: 'a', accounts: ['a'],
    lease: async () => ({ accountId: 'a', adapter, success: async () => {}, failure: async () => {}, release: () => {}, prepareRetry: async () => false }),
    listModels: async () => [{ id: 'free', billing: { free: true } }],
    chatStream: async () => ({ ok: true, response: upstream(undefined) }),
  };
  const key = 'n'.repeat(40);
  const server = createGateway({ adapter, apiKey: key, accessLogDir: dir });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  try {
    const res = await fetch('http://127.0.0.1:' + server.address().port + '/v1/chat/completions', {
      method: 'POST', headers: { 'x-api-key': key, 'content-type': 'application/json', 'x-request-id': 'usage-missing' },
      body: JSON.stringify({ model: 'free', messages: [{ role: 'user', content: 'x' }] }),
    });
    assert.equal(res.status, 200);
    await res.json();
    const row = (await readLog(dir)).find(entry => entry.request_id === 'usage-missing');
    assert.equal(row.usage, null);
    assert.equal(row.usage_source, 'missing');
    const totals = aggregateRows([row]);
    assert.equal(totals.missing_usage, 1);
    assert.equal(totals.input_tokens, null);
  } finally { await new Promise(resolve => server.close(resolve)); await rm(dir, { recursive: true, force: true }); }
});

test('usage observed on a failed attempt is logged once, not scaled', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'buddy-usage-retry-'));
  const adapter = {
    accountIdentity: async () => 'a', accountId: 'a', accounts: ['a'],
    lease: async () => ({
      accountId: 'a', adapter,
      success: async () => {}, release: () => {},
      prepareRetry: async () => false,
      failure: async () => {},
    }),
    listModels: async () => [{ id: 'free', billing: { free: true } }],
    // The stream carries usage and then an upstream error frame, so the request
    // fails after usage was already received.
    chatStream: async () => ({
      ok: true,
      response: new Response(
        'data: ' + JSON.stringify({ choices: [{ index: 0, delta: { content: 'a' } }], usage: { prompt_tokens: 100, completion_tokens: 0 } }) + '\n\n' +
        'data: ' + JSON.stringify({ error: { message: 'upstream failed' } }) + '\n\n',
        { headers: { 'content-type': 'text/event-stream' } }),
    }),
  };
  const key = 'r'.repeat(40);
  const server = createGateway({ adapter, apiKey: key, accessLogDir: dir });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  try {
    const res = await fetch('http://127.0.0.1:' + server.address().port + '/v1/chat/completions', {
      method: 'POST', headers: { 'x-api-key': key, 'content-type': 'application/json', 'x-request-id': 'usage-retry-partial' },
      body: JSON.stringify({ model: 'free', messages: [{ role: 'user', content: 'x' }] }),
    });
    assert.equal(res.status, 502);
    await res.text();
    const row = (await readLog(dir)).find(entry => entry.request_id === 'usage-retry-partial');
    assert.equal(row.usage.usage_attempts, 1);
    assert.equal(row.usage.input_tokens, 100);
    assert.equal(row.usage.output_tokens, 0);
    assert.equal(row.upstream_attempts, 1);
  } finally { await new Promise(resolve => server.close(resolve)); await rm(dir, { recursive: true, force: true }); }
});

test('429 retry logs usage from the successful attempt only, without multiplying', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'buddy-usage-429-'));
  let calls = 0;
  const adapter = {
    accountIdentity: async () => 'a', accountId: 'a', accounts: ['a'],
    lease: async () => ({
      accountId: 'a', adapter,
      success: async () => {}, release: () => {},
      prepareRetry: async () => true,
      failure: async () => {},
    }),
    listModels: async () => [{ id: 'free', billing: { free: true } }],
    chatStream: async () => {
      calls += 1;
      return calls === 1 ? { ok: false, status: 429, retryAfter: '0.01' } : { ok: true, response: upstream(UPSTREAM) };
    },
  };
  const key = 'q'.repeat(40);
  const server = createGateway({ adapter, apiKey: key, accessLogDir: dir });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  try {
    const res = await fetch('http://127.0.0.1:' + server.address().port + '/v1/chat/completions', {
      method: 'POST', headers: { 'x-api-key': key, 'content-type': 'application/json', 'x-request-id': 'usage-429-retry' },
      body: JSON.stringify({ model: 'free', messages: [{ role: 'user', content: 'x' }] }),
    });
    assert.equal(res.status, 200);
    await res.json();
    const row = (await readLog(dir)).find(entry => entry.request_id === 'usage-429-retry');
    assert.equal(row.upstream_attempts, 2);
    assert.equal(row.upstream_retries, 1);
    assert.equal(row.usage.usage_attempts, 1);
    // Exactly one upstream response carried usage, so it is counted once.
    assert.equal(row.usage.input_tokens, 1000);
    assert.equal(row.usage.cache_read_tokens, 800);
  } finally { await new Promise(resolve => server.close(resolve)); await rm(dir, { recursive: true, force: true }); }
});
