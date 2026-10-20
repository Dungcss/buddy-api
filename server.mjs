import http from 'node:http';
import { createHash, randomUUID, timingSafeEqual } from 'node:crypto';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { appendFile, readFile, writeFile, readdir, rename, open } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { parseChatChunks, collectParsedCompletion } from './protocol-common.mjs';
import { messagesToChat, messageFromCompletion, streamMessages } from './messages.mjs';
import { responsesToChat, responseFromCompletion, streamResponses } from './responses.mjs';
import { combineUsage } from './usage.mjs';
import { createKeyDirectory } from './apikeys.mjs';

const fail = (status, code) => Object.assign(new Error(code), { status, code });
const hash = value => createHash('sha256').update(value).digest();
export function rateLimitWaitMs(result, attempt = 0, now = Date.now()) {
  const raw = result?.retryAfter;
  const parsed = typeof raw === 'string' && /^\d+(?:\.\d+)?$/.test(raw.trim())
    ? Number(raw) * 1000 : typeof raw === 'string' ? Date.parse(raw) - now : NaN;
  return Number.isFinite(parsed) && parsed > 0 && parsed < 8.64e15 - now
    ? parsed : Math.min(900000, 60000 * 2 ** Math.min(attempt, 4));
}

// Retry only before any response bytes/tool results have reached the caller.
// Five retries means at most six upstream calls, all on the request's adapter.
export async function retryUpstream(call, { retries, deadlineAt, signal, lease,
  now = Date.now, sleep = delay, onAttempt = () => {}, onResult = () => {} } = {}) {
  for (let attempt = 0; ; attempt++) {
    signal?.throwIfAborted();
    onAttempt(attempt);
    const result = await call();
    // Every upstream attempt is reported once, including failed ones, so the
    // dashboard can sum usage actually received rather than scaling the last
    // response by the retry count.
    try { onResult(result, attempt); } catch {}
    if (result?.ok) return result;
    await lease?.failure(result);
    if (!lease && result?.status === 429) result.retryAfterSeconds = Math.max(1, Math.ceil(rateLimitWaitMs(result, attempt, now()) / 1000));
    if (result?.status !== 429 || result.dailyQuota || result.kind === 'hard_credit' || attempt >= retries) return result;
    if (lease) {
      if (!await lease.prepareRetry({ signal, deadlineAt, sleep })) return result;
    } else {
      const waitMs = rateLimitWaitMs(result, attempt, now());
      result.retryAfterSeconds = Math.max(1, Math.ceil(waitMs / 1000));
      if (now() + waitMs + 1000 >= deadlineAt) return result;
      await sleep(waitMs, signal);
    }
  }
}
function delay(ms, signal) {
  return new Promise((resolveDelay, reject) => {
    if (signal?.aborted) { reject(signal.reason || fail(504, 'timeout')); return; }
    const onAbort = () => { clearTimeout(timer); reject(signal.reason || fail(504, 'timeout')); };
    const timer = setTimeout(() => { signal?.removeEventListener('abort', onAbort); resolveDelay(); }, ms);
    timer.unref?.();
    signal?.addEventListener('abort', onAbort, { once: true });
  });
}
// Keeps a re-encoded SSE stream alive while the upstream is silent. Only the
// messages/responses protocols are re-encoded; chat forwards upstream bytes,
// which already carry the upstream heartbeat comments.
async function* withHeartbeat(source, intervalMs) {
  const iterator = source[Symbol.asyncIterator]();
  let pending = iterator.next();
  try {
    while (true) {
      let timer;
      const tick = new Promise(resolveTick => { timer = setTimeout(() => resolveTick(true), intervalMs); timer.unref?.(); });
      let outcome;
      try { outcome = await Promise.race([pending, tick]); } finally { clearTimeout(timer); }
      if (outcome === true) { yield ': ping\n\n'; continue; }
      if (outcome.done) return;
      yield outcome.value;
      pending = iterator.next();
    }
  } finally { await iterator.return?.().catch(() => {}); }
}
function withSignal(promise, signal) {
  return new Promise((resolveResult, reject) => {
    const aborted = () => reject(signal.reason || fail(504, 'timeout'));
    if (signal.aborted) { Promise.resolve(promise).catch(() => {}); aborted(); return; }
    signal.addEventListener('abort', aborted, { once: true });
    Promise.resolve(promise).then(resolveResult, reject).finally(() => signal.removeEventListener('abort', aborted));
  });
}
const SAFE_CODES = new Set(['unauthorized', 'not_found', 'method_not_allowed', 'host_not_allowed', 'unsupported_media_type', 'unsupported_feature', 'invalid_json', 'body_too_large', 'context_too_large', 'invalid_request', 'model_not_free', 'model_not_found', 'model_not_allowed', 'catalog_unavailable', 'not_signed_in', 'credential_unavailable', 'upstream_unavailable', 'upstream_rate_limited', 'upstream_error', 'upstream_invalid_stream', 'upstream_response_too_large', 'upstream_incomplete', 'rate_limit', 'busy', 'timeout', 'internal_error', 'accounts_cooling_down']);

// Wall-clock instant before which no new upstream chat call is attempted.
// Set whenever an account reports a rate limit, so bursts are spread out.
let upstreamGateUntil = 0;
function sendJson(res, status, body, extra = {}) {
  if (res.destroyed || res.writableEnded) return;
  const data = JSON.stringify(body);
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Content-Length': Buffer.byteLength(data), 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff', ...extra });
  res.end(data);
}
function errorInfo(error) {
  const adapterErrors = {
    workbuddy_auth_unavailable: [503, 'credential_unavailable'],
    workbuddy_catalog_unavailable: [503, 'catalog_unavailable'],
    workbuddy_account_changed: [503, 'credential_unavailable'],
    workbuddy_upstream_unavailable: [502, 'upstream_unavailable'],
    adapter_dependency_unavailable: [503, 'upstream_unavailable'],
    adapter_dependency_changed: [503, 'upstream_unavailable'],
    adapter_dependency_incompatible: [503, 'upstream_unavailable'],
    model_not_found: [404, 'model_not_found'],
    model_not_allowed: [403, 'model_not_allowed'],
  };
  if (Object.hasOwn(adapterErrors, error?.code || '')) {
    const [status, code] = adapterErrors[error.code];
    error = fail(status, code);
  }
  const code = SAFE_CODES.has(error?.code) ? error.code : 'internal_error';
  const status = Number.isInteger(error?.status) && error.status >= 400 && error.status <= 599 ? error.status : 500;
  return {status,code,message:code.replaceAll('_',' ')};
}
function errorBody(info, protocol, requestId) {
  const {status,code,message}=info;
  const request=requestId?{request_id:requestId}:{};
  // These two limits are actionable: the caller can start a new conversation or
  // send less text. Saying only "body too large" leaves them guessing.
  const hint = code === 'body_too_large' ? 'request body exceeds the gateway limit; send less text or start a new conversation'
    : code === 'context_too_large' ? 'the conversation no longer fits the model context; start a new conversation or shorten the history'
    : null;
  if(hint) {
    if(protocol==='messages') return {type:'error',error:{type:status<500?'invalid_request_error':'api_error',message,code},...request,hint};
    return {error:{message,type:code,code},...request,hint};
  }
  if(protocol==='messages') {
    const type=status===401?'authentication_error':status===403?'permission_error':status===404?'not_found_error':status===429?'rate_limit_error':status<500?'invalid_request_error':'api_error';
    return {type:'error',error:{type,message,code},...request};
  }
  return {error:{message,type:code,code},...request};
}
function sendError(res,error,protocol='chat',requestId) {
  const info=errorInfo(error);
  if(res.headersSent){res.destroy();return info;}
  sendJson(res,info.status,errorBody(info,protocol,requestId),info.status===429?{'Retry-After':String(Math.max(1,Math.ceil(error?.retryAfterSeconds || 5)))}:{});
  return info;
}
// One JSON line per request: routing and outcome metadata only. Prompt text,
// response bodies and credential material are never written.
//
// Writes are batched per day file and flushed on a timer instead of opening and
// closing the same file once per request, which put two filesystem syscalls on
// the critical path of every completed request. The handle is kept for the
// current day only, so a day rollover reopens the new file. Entries are never
// dropped: a flush awaiting appends preserves ordering and retries once.
function createAccessLog(directory, { flushMs = 50 } = {}) {
  if (!directory) return () => {};
  let currentDay = null, handle = null, queue = Promise.resolve();
  let pending = [], timer = null, lastError = 0;

  const close = async () => {
    const open = handle;
    handle = null; currentDay = null;
    if (open) await open.close().catch(() => {});
  };

  async function flush() {
    timer = null;
    if (!pending.length) return;
    const lines = pending.join('');
    pending = [];
    try { await handle.write(lines, null, 'utf8'); }
    catch {
      // Reopen once and retry the batch: losing an audit line is worse than a
      // transient retry, but a permanently broken handle must not wedge the pipe.
      const day = currentDay;
      await close();
      if (Date.now() - lastError < 60000) return;
      lastError = Date.now();
      currentDay = day;
      try { handle = await open(join(directory, `access-${day}.jsonl`), 'a'); await handle.write(lines, null, 'utf8'); }
      catch {}
    }
  }

  return entry => {
    const line = `${JSON.stringify(entry)}\n`;
    const day = entry.at.slice(0, 10).replaceAll('-', '');
    pending.push(line);
    queue = queue.then(async () => {
      if (day !== currentDay || !handle) {
        await close();
        try { handle = await open(join(directory, `access-${day}.jsonl`), 'a'); currentDay = day; }
        catch { pending = []; return; }
      }
    }).then(async () => {
      if (!timer && pending.length) {
        // Coalesce whatever arrives within the window into a single append.
        timer = setTimeout(flush, flushMs);
        timer.unref?.();
      }
    }).catch(() => {});
    return queue;
  };
}
async function* encodeProtocolEvents(events,protocol) {
  try {
    for await(const item of events)yield `event: ${item.event}\ndata: ${JSON.stringify(item.data)}\n\n`;
  }catch(error){
    const info=errorInfo(error);
    const body=protocol==='messages'?errorBody(info,protocol):{type:'error',code:info.code,message:info.message,param:null};
    yield `event: error\ndata: ${JSON.stringify(body)}\n\n`;
  }
}
async function readBody(req, limit, signal) {
  const stated = req.headers['content-length'];
  if (stated !== undefined && (!/^\d+$/.test(stated) || Number(stated) > limit)) { req.resume(); throw fail(413, 'body_too_large'); }
  const raw = await new Promise((resolveBody, reject) => {
    const chunks = []; let size = 0, settled = false;
    const finish = (error) => {
      if (settled) return; settled = true;
      req.off('data', onData); req.off('end', onEnd); req.off('error', onError); req.off('aborted', onAborted);
      signal?.removeEventListener('abort', onSignal);
      if (error) { req.resume(); reject(error); } else resolveBody(Buffer.concat(chunks));
    };
    const onData = chunk => { size += chunk.length; if (size > limit) finish(fail(413, 'body_too_large')); else chunks.push(chunk); };
    const onEnd = () => finish();
    const onError = error => finish(error);
    const onAborted = () => finish(fail(400, 'invalid_request'));
    const onSignal = () => finish(signal.reason || fail(504, 'timeout'));
    req.on('data', onData); req.once('end', onEnd); req.once('error', onError); req.once('aborted', onAborted);
    signal?.addEventListener('abort', onSignal, { once: true });
    if (signal?.aborted) onSignal();
  });
  let value;
  try { value = JSON.parse(raw.toString('utf8')); } catch { throw fail(400, 'invalid_json'); }
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw fail(400, 'invalid_request');
  return value;
}
function validateChat(body) {
  if (typeof body.model !== 'string' || !body.model || body.model.length > 128 || !Array.isArray(body.messages) || !body.messages.length || body.messages.length > 2000) throw fail(400, 'invalid_request');
  if (body.stream !== undefined && typeof body.stream !== 'boolean') throw fail(400, 'invalid_request');
  if (body.n !== undefined && body.n !== 1) throw fail(400, 'invalid_request');
  for (const item of body.messages) {
    if (!item || !['system', 'developer', 'user', 'assistant', 'tool'].includes(item.role)) throw fail(400, 'invalid_request');
  }
  for (const field of ['max_tokens', 'max_completion_tokens']) if (body[field] !== undefined && (!Number.isInteger(body[field]) || body[field] < 1)) throw fail(400, 'invalid_request');
}

// Forwards raw Uint8Array bytes, without JSON parsing or UTF-8 re-encoding.
// Recognizes LF/CRLF across chunk boundaries, with constant parser state.
// A bare CR is resolved on the following byte or EOF; an open stream ending
// with a bare CR alone remains bounded by the existing request deadline.
export async function* streamCompletion(body, { signal, onUsage } = {}) {
  if (!body) throw Object.assign(new Error('upstream_invalid_stream'),
    { status: 502, code: 'upstream_invalid_stream' });
  const reader = body.getReader();
  const marker = [91, 68, 79, 78, 69, 93]; // [DONE]
  const field = [100, 97, 116, 97]; // data
  let fieldLength = 0, fieldMatches = true, phase = 0, firstValue = false;
  let lineNonempty = false, previousCR = false, hasData = false;
  let matched = 0, invalid = false, eof = false, cancelled = false;
  // Usage is read from the forwarded bytes without changing them. Only lines
  // that start with "data:" are buffered, and only up to a fixed bound.
  const usagePrefix = [100, 97, 116, 97, 58]; // "data:"
  let usagePrefixIndex = 0, usageLine = null, usageOverflow = false;
  const USAGE_LINE_MAX = 2 * 1024 * 1024;
  function usageByte(byte) {
    if (usagePrefixIndex < usagePrefix.length) {
      if (usagePrefix[usagePrefixIndex] !== byte) { usagePrefixIndex = -1; return; }
      usagePrefixIndex++;
      if (usagePrefixIndex === usagePrefix.length) usageLine = [];
      return;
    }
    if (usagePrefixIndex === -1) return;
    if (usageOverflow) return;
    if (usageLine.length >= USAGE_LINE_MAX) { usageOverflow = true; usageLine = null; return; }
    usageLine.push(byte);
  }
  function usageLineEnd() {
    const line = usageLine;
    usagePrefixIndex = 0; usageLine = null; usageOverflow = false;
    if (!line || !line.length || typeof onUsage !== 'function') return;
    // Cheap pre-check before decoding: "usage" must appear in the line.
    let hit = false;
    for (let i = 0; i + 4 < line.length && !hit; i++) {
      if (line[i] === 117 && line[i + 1] === 115 && line[i + 2] === 97 &&
          line[i + 3] === 103 && line[i + 4] === 101) hit = true;
    }
    if (!hit) return;
    let event;
    try { event = JSON.parse(Buffer.from(line).toString('utf8')); } catch { return; }
    if (event && typeof event === 'object' && event.usage && typeof event.usage === 'object')
      try { onUsage(event.usage); } catch {}
  }
  // Optional leading UTF-8 BOM is ignored by the parser, preserved on the wire.
  let bomIndex = 0;
  const bom = [239, 187, 191];

  const cancel = reason => {
    if (cancelled || eof) return;
    cancelled = true;
    // Fetch cancellation is initiated immediately. A transport's slow/rejected
    // cancel promise must not retain a logically completed admission slot.
    try { Promise.resolve(reader.cancel(reason)).catch(() => {}); } catch {}
  };
  const abort = () => cancel(signal.reason);
  signal?.addEventListener('abort', abort, { once: true });

  function dataByte(byte) {
    if (invalid) return;
    const whitespace = byte === 9 || byte === 10 || byte === 11 ||
      byte === 12 || byte === 13 || byte === 32;
    if ((matched === 0 || matched === marker.length) && whitespace) return;
    if (matched < marker.length && marker[matched] === byte) matched++;
    else invalid = true;
  }
  function byteInLine(byte) {
    lineNonempty = true;
    if (phase === 0) {
      if (byte === 58) { // colon
        phase = fieldMatches && fieldLength === field.length ? 1 : 2;
        firstValue = true;
      } else {
        if (fieldLength >= field.length || field[fieldLength] !== byte)
          fieldMatches = false;
        fieldLength = Math.min(fieldLength + 1, field.length + 1);
      }
    } else if (phase === 1) {
      if (!(firstValue && byte === 32)) dataByte(byte);
      firstValue = false;
    }
  }
  function finishLine() {
    let terminal = false;
    if (!lineNonempty) {
      terminal = hasData && !invalid && matched === marker.length;
      hasData = false; matched = 0; invalid = false;
    } else if (phase === 1 ||
      (phase === 0 && fieldMatches && fieldLength === field.length)) {
      hasData = true;
      dataByte(10); // SSE joins successive data fields with a newline.
    }
    fieldLength = 0; fieldMatches = true; phase = 0; firstValue = false;
    lineNonempty = false;
    return terminal;
  }

  try {
    while (true) {
      signal?.throwIfAborted();
      const part = await reader.read();
      signal?.throwIfAborted();
      if (part.done) { eof = true; if (previousCR) finishLine(); return; }
      const chunk = part.value;
      let terminalEnd = -1;
      for (let i = 0; i < chunk.byteLength; i++) {
        const byte = chunk[i];
        if (bomIndex < bom.length) {
          if (byte === bom[bomIndex]) { bomIndex++; continue; }
          // A partial/malformed BOM cannot be part of a data field.
          if (bomIndex) byteInLine(255);
          bomIndex = bom.length;
        }
        if (previousCR) {
          previousCR = false;
          usageLineEnd();
          if (finishLine()) { terminalEnd = i + (byte === 10 ? 1 : 0); break; }
          if (byte === 10) continue;
        }
        if (byte === 13) { previousCR = true; }
        else if (byte === 10) {
          usageLineEnd();
          if (finishLine()) { terminalEnd = i + 1; break; }
        } else { usageByte(byte); byteInLine(byte); }
      }
      if (terminalEnd >= 0) {
        cancel();
        if (terminalEnd) yield chunk.subarray(0, terminalEnd);
        return;
      }
      if (chunk.byteLength) yield chunk;
    }
  } finally {
    if (previousCR) usageLineEnd();
    signal?.removeEventListener('abort', abort);
    cancel(signal?.aborted ? signal.reason : undefined);
    reader.releaseLock();
  }
}

// Aggregate actual upstream deltas; never execute model-generated tool calls.
export async function collectCompletion(response, model, { maxBytes = 16 * 1024 * 1024, signal, onUsage } = {}) {
  if (!response.body) throw fail(502, 'upstream_invalid_stream');
  const result = { id: `chatcmpl-${randomUUID()}`, object: 'chat.completion', created: Math.floor(Date.now() / 1000), model, choices: [] };
  const choices = new Map(); let pending = '', bytes = 0, done = false, finished = false;
  const decoder = new TextDecoder();
  function frame(text) {
    if (done) return;
    const data = text.split('\n').filter(line => line.startsWith('data:')).map(line => line.slice(5).trimStart()).join('\n');
    if (!data || data.trim() === '') return;
    if (data.trim() === '[DONE]') { done = true; return; }
    let event; try { event = JSON.parse(data); } catch { throw fail(502, 'upstream_invalid_stream'); }
    if (!event || typeof event !== 'object' || Array.isArray(event) || (event.choices !== undefined && !Array.isArray(event.choices))) throw fail(502, 'upstream_invalid_stream');
    if (event.error) throw fail(502, 'upstream_error');
    if (typeof event.id === 'string') result.id = event.id;
    if (Number.isInteger(event.created)) result.created = event.created;
    if (event.usage && typeof event.usage === 'object') {
      result.usage = event.usage;
      // Report usage as soon as it arrives so a later error frame does not
      // erase what upstream already billed.
      try { onUsage?.(event.usage); } catch {}
    }
    for (const change of event.choices || []) {
      if (!change || typeof change !== 'object' || (change.delta !== undefined && (!change.delta || typeof change.delta !== 'object' || Array.isArray(change.delta)))) throw fail(502, 'upstream_invalid_stream');
      const index = change.index ?? 0;
      if (!Number.isInteger(index) || index < 0 || index > 10) throw fail(502, 'upstream_invalid_stream');
      if (!choices.has(index)) choices.set(index, { index, message: { role: 'assistant', content: '' }, finish_reason: null, tools: new Map() });
      const choice = choices.get(index), delta = change.delta || {};
      if (delta.tool_calls !== undefined && !Array.isArray(delta.tool_calls)) throw fail(502, 'upstream_invalid_stream');
      for (const field of ['content', 'reasoning_content', 'refusal']) if (typeof delta[field] === 'string') choice.message[field] = (choice.message[field] || '') + delta[field];
      for (const tool of delta.tool_calls || []) {
        if (!tool || typeof tool !== 'object') throw fail(502, 'upstream_invalid_stream');
        const i = tool.index ?? 0;
        if (!Number.isInteger(i) || i < 0 || i > 100) throw fail(502, 'upstream_invalid_stream');
        if (!choice.tools.has(i)) choice.tools.set(i, { id: '', type: 'function', function: { name: '', arguments: '' } });
        const current = choice.tools.get(i);
        if (typeof tool.id === 'string') current.id = tool.id;
        if (typeof tool.function?.name === 'string') current.function.name += tool.function.name;
        if (typeof tool.function?.arguments === 'string') current.function.arguments += tool.function.arguments;
      }
      if (change.finish_reason != null) { choice.finish_reason = change.finish_reason; finished = true; }
    }
  }
  const reader = response.body.getReader();
  const abortRead = () => { reader.cancel(signal.reason).catch(() => {}); };
  signal?.addEventListener('abort', abortRead, { once: true });
  try {
    while (true) {
      signal?.throwIfAborted();
      const part = await reader.read();
      signal?.throwIfAborted();
      if (part.done) break;
      bytes += part.value.byteLength;
      if (bytes > maxBytes) throw fail(502, 'upstream_response_too_large');
      pending += decoder.decode(part.value, { stream: true });
      pending = pending.replaceAll('\r\n', '\n');
      let boundary;
      while ((boundary = pending.indexOf('\n\n')) >= 0) { frame(pending.slice(0, boundary)); pending = pending.slice(boundary + 2); }
      if (done) { reader.cancel().catch(() => {}); break; }
    }
    pending += decoder.decode();
    if (pending.trim()) frame(pending);
  } catch (error) { reader.cancel().catch(() => {}); throw error; }
  finally { signal?.removeEventListener('abort', abortRead); reader.releaseLock(); }
  if (!choices.size || (!done && !finished)) throw fail(502, 'upstream_incomplete');
  result.choices = [...choices.values()].sort((a, b) => a.index - b.index).map(({ tools, ...choice }) => {
    if (tools.size) { choice.message.tool_calls = [...tools.entries()].sort((a, b) => a[0] - b[0]).map(([, t]) => t); if (!choice.message.content) choice.message.content = null; }
    return choice;
  });
  return result;
}

// Request leases bind routing, health and access logging to one identity.
export function createAccountPool(entries, activeId, stateFile, registerAccount, options = {}) {
  if (!entries.length) throw new Error('No accounts configured');
  let selected = entries.find(e => e.id === activeId)?.id || entries[0].id;
  let mode = options.mode === 'manual' ? 'manual' : 'round-robin';
  const now = options.now || Date.now;
  let cursor = 0, chain = Promise.resolve();
  const health = new Map(Object.entries(options.health || {}));
  const state = key => {
    if (!health.has(key)) health.set(key, { failures: 0, until: 0, disabled: false, epoch: 0, at: now() });
    return health.get(key);
  };
  function persist() {
    if (!stateFile) return Promise.resolve();
    const data = JSON.stringify({ active: selected, mode, health: Object.fromEntries([...health].map(([key,h]) => [key, { failures:h.failures, until:h.until, disabled:h.disabled, epoch:h.epoch, reason:h.reason, at:h.at }])), at: new Date(now()).toISOString() }, null, 2)+'\n';
    chain = chain.catch(() => {}).then(async () => {
      await writeFile(stateFile+'.tmp', data, { mode: 0o600 });
      await rename(stateFile+'.tmp', stateFile);
    });
    return chain;
  }
  // Identity lookup is local only. Never advance selection until every lookup completes.
  async function groups() {
    const rows = await Promise.all(entries.map(async e => {
      let identity;
      try { identity = await e.adapter.accountIdentity?.(); } catch {}
      return { ...e, identity: identity || e.id };
    }));
    const grouped = new Map();
    for (const row of rows) {
      const prior = grouped.get(row.identity);
      if (!prior || row.id === selected || (prior.id === 'live' && row.id !== 'live')) grouped.set(row.identity,row);
    }
    // Health entries for identities that no longer exist are dropped: a stale
    // "needs_login" left over from a removed account reads as a live verdict
    // otherwise, which is exactly how a working account got reported as broken.
    const known = new Set(rows.map(row => row.identity));
    for (const key of [...health.keys()]) if (!known.has(key)) health.delete(key);
    return { rows, unique: [...grouped.values()] };
  }
  async function rotationStatus() {
    const {rows,unique} = await groups();
    return { mode, entries: rows.map(row => {
      const h=state(row.identity), representative=unique.find(e=>e.identity===row.identity).id;
      return { id:row.id, aliasOf:row.id === representative ? null : representative,
        state:h.disabled?'needs_login':h.until>now()?'cooldown':h.probing?'probing':h.until?'probe_ready':'ready',
        retryAt:h.until ? new Date(h.until).toISOString():null, reason:h.reason || null };
    }) };
  }
  async function lease() {
    const {unique} = await groups();
    const candidates = mode==='manual' ? unique.filter(e=>e.id===selected) : unique;
    let entry;
    for(let n=0;n<candidates.length;n++) {
      const i=(cursor+n)%candidates.length, row=candidates[i], h=state(row.identity);
      if(!h.disabled && !h.probing && !h.retryOwner && h.until<=now()) { entry=row; cursor=(i+1)%candidates.length; break; }
    }
    if(!entry) {
      const times=candidates.map(e=>state(e.identity)).filter(h=>!h.disabled).map(h=>Math.max(1000,h.until-now()));
      if(!times.length) throw fail(503,'credential_unavailable');
      throw Object.assign(fail(429,'accounts_cooling_down'),{retryAfterSeconds:Math.max(1,Math.ceil(Math.min(...times)/1000))});
    }
    const h=state(entry.identity), owner=Symbol('request-retry');
    let epoch=h.epoch, probe=Boolean(h.until);
    if(probe) h.probing=true;
    let reported=false;
    return {
      accountId:entry.id, adapter:entry.adapter,
      async success() {
        reported=true;
        if(h.epoch!==epoch) return;
        h.failures=0; h.until=0; h.disabled=false; h.reason=null; h.at=now();
        await persist();
      },
      async failure(result) {
        if(reported) return;
        reported=true;
        if(result?.code==='workbuddy_auth_unavailable' || [401,403].includes(result?.status) && result?.kind) {
          h.disabled=true; h.reason='needs_login'; h.epoch++;
        } else if(result?.status===429 || result?.dailyQuota || result?.kind==='hard_credit') {
          h.failures++; h.epoch++;
          const raw=result.retryAfter;
          const retryMs=typeof raw==='string' && /^\d+(?:\.\d+)?$/.test(raw.trim()) ? Number(raw)*1000 : typeof raw==='string' ? Date.parse(raw)-now() : NaN;
          if(result.dailyQuota || result.kind==='hard_credit') {
            // No provider reset metadata: conservatively retry after 24h; no assumed timezone.
            h.until=result.resetAt>now()?result.resetAt:Number.isFinite(retryMs)&&retryMs>0?now()+retryMs:now()+86400000;
            h.reason=result.dailyQuota?'daily_quota':'quota';
          } else {
            h.until=now()+rateLimitWaitMs(result,h.failures-1,now());
            h.reason='rate_limit';
          }
          result.retryAfterSeconds=Math.max(1,Math.ceil((h.until-now())/1000));
        }
        await persist();
      },
      async prepareRetry({signal,deadlineAt,sleep=delay}) {
        if(h.disabled || h.reason!=='rate_limit' || h.retryOwner && h.retryOwner!==owner) return false;
        h.retryOwner=owner;
        if(probe) h.probing=false;
        let claimed=false;
        try {
          for (;;) {
            signal?.throwIfAborted();
            if(h.disabled || h.reason!=='rate_limit') return false;
            const waitMs=Math.max(0,h.until-now());
            // Leave room for a useful attempt; return 429 instead of timing out
            // silently behind the public proxy while still waiting for cooldown.
            if(now()+waitMs+1000>=deadlineAt) return false;
            if(waitMs>0) { await sleep(waitMs,signal); continue; }
            h.probing=true; probe=true; epoch=h.epoch; reported=false;
            claimed=true; return true;
          }
        } finally { if(!claimed && h.retryOwner===owner) h.retryOwner=null; }
      },
      release() { if(probe) h.probing=false; if(h.retryOwner===owner) h.retryOwner=null; },
    };
  }
  return {
    get accountId() { return selected; },
    get accounts() { return entries.map(e=>e.id); },
    lease, rotationStatus,
    async setRotation(value) {
      if(!['manual','round-robin'].includes(value)) throw fail(400,'invalid_request');
      mode=value; await persist(); return rotationStatus();
    },
    async setActive(id) {
      if(!entries.some(e=>e.id===id)) throw fail(404,'account_not_found');
      selected=id; mode='manual'; await persist(); return id;
    },
    async add(id) {
      if(typeof registerAccount!=='function') throw fail(501,'accounts_not_configured');
      const replacement=await registerAccount(id), index=entries.findIndex(e=>e.id===id);
      if(index<0) entries.push(replacement); else entries[index]=replacement;
      let key; try { key=await replacement.adapter.accountIdentity?.(); } catch {}
      if(key) { const h=state(key); h.disabled=false; h.until=0; h.failures=0; h.epoch++; h.reason=null; }
      await persist(); return {added:index<0,active:selected};
    },
    listModels: options => entries.find(e=>e.id===selected).adapter.listModels(options),
    chatStream: (body,options) => entries.find(e=>e.id===selected).adapter.chatStream(body,options),
    status: () => entries.find(e=>e.id===selected).adapter.status(),
  };
}

export function createGateway({ adapter, apiKey, apiKeys = [], limits = {}, accessLogDir, keyDirectory = null, allowedHosts = [], publicBase = null } = {}) {
  // Host header allow-list: a request for an unexpected name is refused before
  // any work is done. Loopback is always allowed so local tooling keeps working;
  // the public hostname comes from configuration, never from the source.
  const hostAllow = new Set(['127.0.0.1', 'localhost', '[::1]', '::1']);
  for (const entry of Array.isArray(allowedHosts) ? allowedHosts : []) {
    const name = String(entry || '').trim().toLowerCase();
    if (name) hostAllow.add(name);
  }
  const accepted = [{ id: 'primary', key: apiKey }];
  for (const entry of Array.isArray(apiKeys) ? apiKeys : []) {
    if (!entry || typeof entry.key !== 'string') throw new Error('API key must be at least 32 characters');
    accepted.push({ id: typeof entry.id === 'string' && entry.id ? entry.id : 'secondary', key: entry.key });
  }
  for (const entry of accepted) if (entry.key.length < 32) throw new Error('API key must be at least 32 characters');
  const expected = accepted.map(entry => ({ id: entry.id, digest: hash(entry.key) }));
  // Every configured credential is compared; no early exit on the first match.
  // Returns the matching credential id, or null when the candidate matches none.
  // Keys created in the dashboard live in a separate directory that is re-read
  // when its file changes, so a new key works without restarting the gateway.
  let credentialModels = null;
  function matchedKey(candidate) {
    if (!candidate) return null;
    const digest = hash(candidate);
    let match = null;
    for (const entry of expected) if (timingSafeEqual(digest, entry.digest)) match = entry.id;
    if (!match && keyDirectory) {
      for (const entry of keyDirectory.list()) {
        if (timingSafeEqual(digest, entry.digest)) {
          match = entry.id;
          // null means unrestricted; an array is the key's allow-list.
          credentialModels = Array.isArray(entry.models) ? entry.models : null;
        }
      }
    }
    return match;
  }
  // A restricted key sees only its own models, in both discovery and inference.
  // The check is applied after the catalog lookup so a model that no longer
  // exists still reports model_not_found rather than a misleading permission
  // error.
  const modelAllowed = modelId => credentialModels === null || credentialModels.includes(modelId);
  const config = { bodyBytes: 8 * 1024 * 1024, concurrency: 2, queueSize: 8, queueWaitMs: 15000, requestsPerMinute: 60, deadlineMs: 600000, nonStreamDeadlineMs: 120000, heartbeatMs: 20000, upstreamRetries: 5, ...limits };
  if (!Number.isInteger(config.concurrency) || config.concurrency < 1 || !Number.isInteger(config.queueSize) || config.queueSize < 0 || !Number.isFinite(config.queueWaitMs) || config.queueWaitMs <= 0) throw new Error('Invalid admission limits');
  for (const field of ['deadlineMs', 'nonStreamDeadlineMs', 'heartbeatMs']) if (!Number.isInteger(config[field]) || config[field] < 100) throw new Error('Invalid request deadlines');
  if (!Number.isInteger(config.upstreamRetries) || config.upstreamRetries < 0 || config.upstreamRetries > 5) throw new Error('Invalid upstream retry budget');
  let active = 0;
  const recent = [];
  const writeAccess = createAccessLog(accessLogDir);
  const startedAt = Date.now();
  const counters = { total: 0, byCredential: Object.fromEntries(expected.map(entry => [entry.id, 0])) };
  const pending = [];
  function lease() {
    active++;
    let released = false;
    return () => {
      if (released) return;
      released = true;
      active--;
      pending.shift()?.grant();
    };
  }
  function acquire(signal) {
    if (signal.aborted) return Promise.reject(signal.reason || fail(504, 'timeout'));
    if (active < config.concurrency) return Promise.resolve(lease());
    if (pending.length >= config.queueSize) return Promise.reject(fail(429, 'busy'));
    return new Promise((resolveLease, reject) => {
      let waitTimer;
      const cleanup = () => { clearTimeout(waitTimer); signal.removeEventListener('abort', onAbort); };
      const entry = { grant() { cleanup(); resolveLease(lease()); } };
      const cancel = error => {
        const index = pending.indexOf(entry);
        if (index < 0) return;
        pending.splice(index, 1);
        cleanup();
        reject(error);
      };
      const onAbort = () => cancel(signal.reason || fail(504, 'timeout'));
      waitTimer = setTimeout(() => cancel(fail(429, 'busy')), config.queueWaitMs);
      waitTimer.unref();
      pending.push(entry);
      signal.addEventListener('abort', onAbort, { once: true });
      if (signal.aborted) onAbort();
    });
  }
  const server = http.createServer(async (req, res) => {
    let release, timer, accountLease, requestAdapter=adapter, pinnedAccount=null;
    let protocol='chat';
    const controller = new AbortController();
    req.once('aborted', () => controller.abort());
    res.once('close', () => { if (!res.writableEnded) controller.abort(); });
    const receivedAt = Date.now();
    // Client-supplied correlation ids are echoed only when they are plain tokens.
    const suppliedId = req.headers['x-request-id'];
    const requestId = typeof suppliedId === 'string' && /^[A-Za-z0-9._-]{1,64}$/.test(suppliedId) ? suppliedId : randomUUID();
    let credentialId = null, requestedModel = null, streamed = false, outcome = 'ok', upstreamAttempts = 0;
    // Usage observed on each upstream attempt. Empty means upstream sent none,
    // which the dashboard shows as "no data", never as zero.
    const usageAttempts = [];
    let attemptUsage = null, attemptRecorded = false;
    const recordAttemptUsage = () => {
      if (attemptRecorded || !attemptUsage) return;
      attemptRecorded = true;
      usageAttempts.push(attemptUsage);
    };
    res.setHeader('X-Request-Id', requestId);
    try {
      const host = (req.headers.host || '').toLowerCase().replace(/:\d+$/, '');
      if (!hostAllow.has(host)) throw fail(403, 'host_not_allowed');
      const url = new URL(req.url || '/', 'http://localhost');
      const pathname=['/models','/messages','/responses','/chat/completions'].includes(url.pathname)?'/v1'+url.pathname:url.pathname;
      protocol=pathname==='/v1/messages'?'messages':pathname==='/v1/responses'?'responses':'chat';
      if (url.search) throw fail(400, 'invalid_request');
      if (req.method === 'GET' && url.pathname === '/healthz') { sendJson(res, 200, { status: 'ok' }); return; }
      let authHeaderCount = 0, keyHeaderCount=0;
      for (let i = 0; i < req.rawHeaders.length; i += 2) { if (req.rawHeaders[i].toLowerCase() === 'authorization') authHeaderCount++;if(req.rawHeaders[i].toLowerCase()==='x-api-key')keyHeaderCount++; }
      if(authHeaderCount>1||keyHeaderCount>1)throw fail(401,'unauthorized');
      const token = /^Bearer ([^\s]+)$/i.exec(req.headers.authorization || '')?.[1] || '';
      const apiToken=typeof req.headers['x-api-key']==='string'?req.headers['x-api-key']:'';
      // Discovery and inference share the same credentials across protocol clients.
      // Every supplied credential must independently match; no fallback over a bad header.
      if(!authHeaderCount&&!keyHeaderCount)throw fail(401,'unauthorized');
      const bearerKey = authHeaderCount ? matchedKey(token) : null;
      const headerKey = keyHeaderCount ? matchedKey(apiToken) : null;
      if (authHeaderCount && !bearerKey) throw fail(401,'unauthorized');
      if (keyHeaderCount && !headerKey) throw fail(401,'unauthorized');
      // When both headers are sent they must carry the same credential; two
      // different but individually valid keys are still rejected.
      if (authHeaderCount && keyHeaderCount && bearerKey !== headerKey) throw fail(401,'unauthorized');
      credentialId = bearerKey || headerKey;
      // Records "last used" for dashboard-created keys only; bootstrap keys have
      // no row to update and are skipped inside the directory.
      keyDirectory?.markUsed(credentialId);
      // Permissions are re-read from the directory on every request: revoking or
      // narrowing a key must take effect without a restart. A bootstrap key has
      // no directory row, so it stays unrestricted.
      credentialModels = keyDirectory?.find(credentialId)?.models ?? null;
      // Sliding window: at most requestsPerMinute within any trailing 60 s window.
      const admittedAt = Date.now();
      while (recent.length && admittedAt - recent[0] >= 60000) recent.shift();
      if (recent.length >= config.requestsPerMinute) throw fail(429, 'rate_limit');
      recent.push(admittedAt);
      counters.total++;
      counters.byCredential[credentialId] = (counters.byCredential[credentialId] || 0) + 1;
      timer = setTimeout(() => controller.abort(fail(504, 'timeout')), config.deadlineMs); timer.unref();
      if (req.method === 'GET' && url.pathname === '/') {
        // base_url is derived from the request so a clone reports its own origin.
        const origin = String(publicBase || ('http://' + (req.headers.host || '127.0.0.1'))).replace(/\/+$/, '');
        sendJson(res, 200, {
          service: 'Buddy API',
          base_url: origin + '/v1',
          authentication: 'Bearer API key or x-api-key; matching credentials required when both are present',
          endpoints: ['/v1/models', '/v1/status', '/v1/account', '/v1/chat/completions', '/v1/messages', '/v1/responses'],
          policy: 'Every catalog model is callable, including paid ones; per-key model grants are enforced. Stateless protocol translation; no stored responses or hosted tools.',
        });
        return;
      }
      if (pathname === '/v1/account/rotation' && ['GET','POST'].includes(req.method)) {
        const rotation = req.method === 'POST' ? await adapter.setRotation((await readBody(req,4096,controller.signal)).mode) : await adapter.rotationStatus();
        sendJson(res,200,rotation); return;
      }
      // The dashboard calls this after creating or revoking a key so the change
      // is live on the very next request instead of waiting for the file watcher.
      // It only re-reads the key file; it cannot add, revoke or widen anything.
      if (pathname === '/v1/keys/reload' && req.method === 'POST') {
        if (!keyDirectory) throw fail(501, 'keys_not_configured');
        await keyDirectory.reload();
        sendJson(res, 200, { ok: true, keys: keyDirectory.list().length });
        return;
      }
      if (pathname === '/v1/account/register' && req.method === 'POST') {
        const payload = await readBody(req, 4096, controller.signal);
        const id = typeof payload.id === 'string' ? payload.id.trim().toLowerCase() : '';
        if (!/^[a-z0-9-]{1,24}$/.test(id)) throw fail(400, 'invalid_id');
        if (typeof adapter.add !== 'function') throw fail(501, 'accounts_not_configured');
        const result = await adapter.add(id);
        sendJson(res, 200, { ...result, accounts: adapter.accounts });
        return;
      }
      if (pathname === '/v1/account' && req.method === 'POST') {
        const payload = await readBody(req, 4096, controller.signal);
        const requested = typeof payload.id === 'string' ? payload.id.trim().toLowerCase() : '';
        if (!requested) throw fail(400, 'invalid_request');
        if (typeof adapter.setActive !== 'function') throw fail(501, 'accounts_not_configured');
        const active = await adapter.setActive(requested);
        sendJson(res, 200, { active, accounts: adapter.accounts });
        return;
      }
      if (pathname === '/v1/status' && req.method === 'GET') {
        // Local admission counters plus the adapter's safe summary; no credentials,
        // account identifiers or prompt content are exposed.
        let upstream = null;
        if (typeof adapter.status === 'function') {
          try { upstream = await withSignal(Promise.resolve().then(() => adapter.status()), controller.signal); } catch { upstream = null; }
        }
        sendJson(res, 200, {
          status: 'ok',
          request_id: requestId,
          uptime_seconds: Math.round((Date.now() - startedAt) / 1000),
          admission: { active, queued: pending.length, concurrency: config.concurrency, queue_size: config.queueSize },
          requests: { total: counters.total, last_minute: recent.length, by_credential: { ...counters.byCredential } },
          limits: { requests_per_minute: config.requestsPerMinute, body_bytes: config.bodyBytes, deadline_ms: config.deadlineMs, non_stream_deadline_ms: config.nonStreamDeadlineMs, heartbeat_ms: config.heartbeatMs, upstream_retries: config.upstreamRetries },
          accounts: { active: adapter.accountId ?? null, entries: adapter.accounts ?? [], rotation: await adapter.rotationStatus?.() },
          // freeModelCount only reflects a warm catalog; this flag keeps a cold
          // gateway from looking like "no free models" to a monitor.
          catalog_warm: Boolean(upstream && upstream.catalogSource && upstream.catalogSource !== 'none'),
          upstream,
        });
        return;
      }
      if (pathname === '/v1/models' && req.method === 'GET') {
        // Discovery uses the selected account without consuming rotation turns.
        pinnedAccount=adapter.accountId ?? null;
        const models = await withSignal(adapter.listModels({ signal: controller.signal }), controller.signal);
        // A restricted key is not told about models it cannot call: discovery is
        // part of the permission boundary, not just inference.
        const visible = models.filter(m => modelAllowed(m.id));
        // Every catalog model the adapter allows (GPT is excluded there). Billing
        // is reported per row so a client can tell free from paid.
        sendJson(res, 200, { object: 'list', data: visible.map(m => ({
          id: m.id, object: 'model', created: 0, owned_by: 'workbuddy-ai',
          ...(m.name ? { name: m.name } : {}),
          ...(m.billing ? { billing: { free: m.billing.free === true, ...(m.billing.credits ? { credits: m.billing.credits } : {}) } } : {}),
          ...(m.contextWindow ? { context_window: m.contextWindow } : {}),
          ...(m.defaultContextWindow ? { default_context_window: m.defaultContextWindow } : {}),
          ...(m.maxContextWindow ? { max_context_window: m.maxContextWindow } : {}),
          ...(Array.isArray(m.supportedContextWindows) ? { supported_context_windows: m.supportedContextWindows } : {}),
          ...(m.maxInputTokens ? { max_input_tokens: m.maxInputTokens } : {}),
          ...(m.maxTokens ? { max_output_tokens: m.maxTokens } : {}),
          ...(typeof m.supportsImages === 'boolean' ? { supports_images: m.supportsImages } : {}),
          ...(m.reasoning ? { reasoning: {
            ...(typeof m.reasoning.supports === 'boolean' ? { supports: m.reasoning.supports } : {}),
            ...(typeof m.reasoning.onlyReasoning === 'boolean' ? { only_reasoning: m.reasoning.onlyReasoning } : {}),
            ...(typeof m.reasoning.canDisableThinking === 'boolean' ? { can_disable_thinking: m.reasoning.canDisableThinking } : {}),
            ...(Array.isArray(m.reasoning.supportedEfforts) ? { supported_efforts: m.reasoning.supportedEfforts } : {}),
            ...(m.reasoning.defaultEffort ? { default_effort: m.reasoning.defaultEffort } : {}),
          } } : {}),
        })) }); return;
      }
      if (!['/v1/chat/completions','/v1/messages','/v1/responses'].includes(pathname)) throw fail(404, 'not_found');
      if (req.method !== 'POST') throw fail(405, 'method_not_allowed');
      if (!/^application\/json(?:\s*;|$)/i.test(req.headers['content-type'] || '')) throw fail(415, 'unsupported_media_type');
      release = await acquire(controller.signal);
      const requestBody = await readBody(req, config.bodyBytes, controller.signal);
      const body=protocol==='messages'?messagesToChat(requestBody):protocol==='responses'?responsesToChat(requestBody):requestBody;
      validateChat(body);
      if (adapter.lease) {
        try {
          accountLease = await adapter.lease();
        } catch (error) {
          // Every account is cooling but one frees up shortly: wait for it rather
          // than answering 429 to a client that would just retry anyway.
          const wait = Number(error?.retryAfterSeconds || 0);
          if (error?.code !== 'accounts_cooling_down' || !(wait > 0) || wait > 10) throw error;
          await delay(wait * 1000, controller.signal);
          if (controller.signal.aborted) throw controller.signal.reason || fail(504, 'timeout');
          accountLease = await adapter.lease();
        }
        requestAdapter = accountLease.adapter; pinnedAccount = accountLease.accountId;
      } else pinnedAccount = adapter.accountId ?? null;
      requestedModel = body.model;
      streamed = body.stream === true;
      {
        // Both modes are silent before upstream headers arrive. Bound that wait
        // below the proxy timeout; streaming gets its full budget once opened.
        clearTimeout(timer);
        const remaining = receivedAt + Math.min(config.nonStreamDeadlineMs,config.deadlineMs) - Date.now();
        if(remaining<=0) throw fail(504,'timeout');
        timer = setTimeout(() => controller.abort(fail(504, 'timeout')), remaining);
        timer.unref();
      }
      // Reuses the adapter catalog cache (10 s); the adapter rejects a model that
      // stopped being free before opening the upstream stream.
      const models = await withSignal(requestAdapter.listModels({ signal: controller.signal }), controller.signal);
      // Any catalog model is callable, including paid ones. Only an id that is
      // absent from the live catalog is refused, so a typo cannot reach upstream.
      if (!models.some(m => m.id === body.model)) throw fail(404, 'model_not_found');
      // The key's allow-list is checked after the catalog so a granted model that
      // vanished reports "not found" and a real model the key lacks reports 403.
      if (!modelAllowed(body.model)) throw fail(403, 'model_not_allowed');
      // Pacing applies before the first attempt; per-account Retry-After governs
      // retries. The adapter and logged account stay pinned to this request.
      const gateWait = upstreamGateUntil - Date.now();
      if (gateWait > 0) await delay(Math.min(gateWait, 10000), controller.signal);
      const result = await retryUpstream(async () => {
        attemptUsage = null;
        attemptRecorded = false;
        const result = await withSignal(requestAdapter.chatStream({ ...body, stream: true }, { signal: controller.signal }), controller.signal);
        if(result?.status===429) upstreamGateUntil=Math.max(upstreamGateUntil,Date.now()+5000);
        return result;
      }, {
        retries:config.upstreamRetries, signal:controller.signal, lease:accountLease,
        // Even a streaming request has sent no bytes yet: stay below the public
        // proxy's first-byte timeout as well as the caller's existing deadline.
        deadlineAt:receivedAt+Math.min(config.deadlineMs,config.nonStreamDeadlineMs),
        onAttempt:()=>{upstreamAttempts++;},
        // A failed attempt may still carry usage (for example an aborted stream
        // with a terminal usage frame); record what upstream actually sent.
        onResult:recordAttemptUsage,
      });
      if (!result?.ok) {
        await accountLease?.failure(result);
        // A 400 from upstream means the request itself was rejected (most often
        // a conversation that no longer fits the model's context). Reporting it
        // as "upstream unavailable" hides the one thing the caller can act on,
        // so it maps to 400 with its own code.
        if (result?.status === 400) throw fail(400, 'context_too_large');
        throw Object.assign(fail(result?.status===429 ? 429 : [401,403].includes(result?.status)?503:502, result?.status===429?'upstream_rate_limited':'upstream_unavailable'), {retryAfterSeconds:result?.retryAfterSeconds});
      }
      if (!result.response.ok || !result.response.body || !/text\/event-stream/i.test(result.response.headers.get('content-type') || '')) { result.response.body?.cancel().catch(() => {}); throw fail(502, 'upstream_invalid_stream'); }
      if (body.stream === true) {
        clearTimeout(timer);
        const remaining=receivedAt+config.deadlineMs-Date.now();
        if(remaining<=0) throw fail(504,'timeout');
        timer=setTimeout(()=>controller.abort(fail(504,'timeout')),remaining);timer.unref();
        res.writeHead(200, { 'Content-Type': 'text/event-stream; charset=utf-8', 'Cache-Control': 'no-store', 'X-Accel-Buffering': 'no', 'X-Content-Type-Options': 'nosniff' });
        res.flushHeaders();
        // Chat forwards raw upstream bytes, so usage is captured inline while the
        // bytes stream through unchanged.
        const chunks=protocol==='chat'
          ? streamCompletion(result.response.body,{signal:controller.signal,onUsage:usage=>{attemptUsage=usage;}})
          : parseChatChunks(result.response.body,{signal:controller.signal});
        const encoded=protocol==='chat'?chunks:encodeProtocolEvents(protocol==='messages'?streamMessages(chunks,requestBody):streamResponses(chunks,requestBody),protocol);
        const output=protocol==='chat'?encoded:withHeartbeat(encoded,config.heartbeatMs);
        try { await pipeline(Readable.from(output,{objectMode:false}),res,{signal:controller.signal}); }
        finally { recordAttemptUsage(); }
      } else {
        const completion=protocol==='chat'
          ? await collectCompletion(result.response,body.model,{signal:controller.signal,onUsage:usage=>{attemptUsage=usage;}})
          : await collectParsedCompletion(parseChatChunks(result.response.body,{signal:controller.signal}),body.model);
        if (completion?.usage && typeof completion.usage === 'object') attemptUsage = completion.usage;
        recordAttemptUsage();
        sendJson(res,200,protocol==='messages'?messageFromCompletion(completion,requestBody):protocol==='responses'?responseFromCompletion(completion,requestBody):completion);
      }
      await accountLease?.success();
    } catch (error) {
      // Even a failed attempt keeps whatever usage upstream already reported.
      recordAttemptUsage?.();
      await accountLease?.failure(error).catch(() => {});
      const finalError = controller.signal.reason?.code === 'timeout' ? controller.signal.reason : error?.status ? error : controller.signal.aborted ? fail(504, 'timeout') : error;
      outcome = errorInfo(finalError).code;
      sendError(res, finalError, protocol, requestId);
    }
    finally {
      clearTimeout(timer); accountLease?.release(); release?.();
      writeAccess({ at: new Date(receivedAt).toISOString(), request_id: requestId, key: credentialId, account: pinnedAccount, method: req.method, path: (req.url || '/').split('?')[0], protocol, model: requestedModel, stream: streamed, status: res.statusCode, code: outcome, upstream_attempts:upstreamAttempts, upstream_retries:Math.max(0,upstreamAttempts-1), usage: combineUsage(usageAttempts), usage_source: usageAttempts.length ? 'upstream' : 'missing', ms: Date.now() - receivedAt });
    }
  });
  server.headersTimeout = 15000; server.requestTimeout = 30000; server.keepAliveTimeout = 5000;
  return server;
}

async function main() {
  const root = dirname(fileURLToPath(import.meta.url));
  const config = JSON.parse(await readFile(resolve(root, 'config.json'), 'utf8'));
  const apiKey = (await readFile(resolve(root, config.apiKeyFile), 'utf8')).trim();
  const apiKeys = [];
  if (typeof config.qaApiKeyFile === 'string' && config.qaApiKeyFile) {
    let qaKey = '';
    try { qaKey = (await readFile(resolve(root, config.qaApiKeyFile), 'utf8')).trim(); } catch {}
    // A missing or empty QA key file simply leaves the primary credential only.
    if (qaKey) apiKeys.push({ id: 'qa', key: qaKey });
  }
  const { createAdapter } = await import('./adapter.mjs');
  const configured = Array.isArray(config.accounts?.entries) && config.accounts.entries.length
    ? config.accounts.entries
    : [{ id: 'live', desktopAuthFile: null }];
  const entries = [];
  for (const entry of configured) {
    if (!entry || typeof entry.id !== 'string' || !/^[a-z0-9-]{1,24}$/.test(entry.id)) throw new Error('Invalid account entry');
    entries.push({
      id: entry.id,
      adapter: await createAdapter({
        dataDir: resolve(root, 'data', 'runtime', entry.id),
        desktopAuthFile: entry.desktopAuthFile ? resolve(root, entry.desktopAuthFile) : undefined,
      }),
    });
  }
  const stateFile = resolve(root, 'data', 'accounts-state.json');
  // Snapshots already on disk are picked up on start, so capturing an account is
  // enough to make it available after the next launch.
  try {
    for (const name of await readdir(resolve(root, 'data', 'accounts'))) {
      if (!/^[a-z0-9-]{1,24}$/.test(name) || entries.some(entry => entry.id === name)) continue;
      const snapshot = resolve(root, 'data', 'accounts', name, 'desktop-auth.info');
      try { await readFile(snapshot); } catch { continue; }
      entries.push({ id: name, adapter: await createAdapter({ dataDir: resolve(root, 'data', 'runtime', name), desktopAuthFile: snapshot }) });
    }
  } catch {}
  const registerAccount = async id => {
    if (!/^[a-z0-9-]{1,24}$/.test(id)) throw fail(400, 'invalid_id');
    const snapshot = resolve(root, 'data', 'accounts', id, 'desktop-auth.info');
    try { await readFile(snapshot); } catch { throw fail(404, 'snapshot_not_found'); }
    return { id, adapter: await createAdapter({ dataDir: resolve(root, 'data', 'runtime', id), desktopAuthFile: snapshot }) };
  };
  let persisted = null;
  try { persisted = JSON.parse(await readFile(stateFile, 'utf8')); } catch {}
  const adapter = createAccountPool(entries, persisted?.active || config.accounts?.active, stateFile, registerAccount, { mode: persisted?.mode || config.accounts?.rotation || 'round-robin', health: persisted?.health });
  // Dashboard-created keys are watched, not loaded once: creating a key must
  // work on the next request without a restart of the running service.
  const keyDirectory = createKeyDirectory(root);
  await keyDirectory.ready();
  const server = createGateway({
    adapter, apiKey, apiKeys,
    limits: config.limits,
    accessLogDir: resolve(root, 'logs'),
    keyDirectory,
    // Both come from configuration so the same source runs on any domain.
    allowedHosts: Array.isArray(config.allowedHosts) ? config.allowedHosts : [],
    publicBase: typeof config.publicBaseUrl === 'string' ? config.publicBaseUrl : null,
  });
  await new Promise((resolveReady, reject) => { server.once('error', reject); server.listen(config.port, '127.0.0.1', resolveReady); });
  console.log(JSON.stringify({ event: 'listening', host: '127.0.0.1', port: config.port, at: new Date().toISOString() }));
  for (const event of ['SIGINT', 'SIGTERM']) process.once(event, () => { server.close(); server.closeIdleConnections(); });
}
if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) main().catch(error => {
  // Name the failing stage and the safe code, never the contents of a secret.
  // Without this, a misconfigured checkout only printed "startup failed".
  console.error(JSON.stringify({
    event: 'startup_failed',
    code: typeof error?.code === 'string' ? error.code : 'startup_error',
    name: String(error?.name || 'Error'),
    message: typeof error?.message === 'string' ? error.message.slice(0, 200) : 'no message',
  }));
  process.exitCode = 1;
});
