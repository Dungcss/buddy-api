import {randomUUID} from 'node:crypto';
export const isObject = value => value !== null && typeof value === 'object' && !Array.isArray(value);
export const id = prefix => prefix + randomUUID().replaceAll('-', '');
export function invalid(code = 'invalid_request') { throw Object.assign(new Error(code), {status:400,code}); }
export function upstreamError(code = 'upstream_invalid_stream') { throw Object.assign(new Error(code), {status:502,code}); }
export function onlyKeys(value, keys) {
  if (!isObject(value)) invalid();
  for (const key of Object.keys(value)) if (!keys.includes(key)) invalid('unsupported_feature');
}
export function string(value, {empty = false} = {}) {
  if (typeof value !== 'string' || (!empty && !value.length)) invalid();
  return value;
}
export function modelAndStream(request) {
  string(request.model);
  if (request.model.length > 128 || (request.stream !== undefined && typeof request.stream !== 'boolean')) invalid();
  return {model:request.model, stream:request.stream === true};
}
export function sampling(request, chat) {
  for (const name of ['temperature','top_p']) if (request[name] !== undefined) {
    if (!Number.isFinite(request[name]) || request[name] < 0 || request[name] > (name === 'temperature' ? 2 : 1)) invalid();
    chat[name] = request[name];
  }
}
export function positiveTokens(value) { if (!Number.isInteger(value) || value < 1) invalid(); return value; }
export function imagePart(url, detail) {
  string(url);
  if (!/^https?:\/\//i.test(url) && !/^data:image\/(png|jpeg|webp|gif);base64,[a-z0-9+/=\s]+$/i.test(url)) invalid();
  if (detail !== undefined && !['auto','low','high','original'].includes(detail)) invalid();
  return {type:'image_url',image_url:{url,...(detail ? {detail}: {})}};
}
export function functionTool(tool) {
  string(tool.name);
  if (!/^[a-zA-Z0-9_-]{1,64}$/.test(tool.name) || !isObject(tool.parameters)) invalid();
  if (tool.description !== undefined && typeof tool.description !== 'string') invalid();
  if (tool.strict !== undefined && typeof tool.strict !== 'boolean') invalid();
  return {type:'function',function:{name:tool.name,parameters:tool.parameters,...(tool.description !== undefined ? {description:tool.description}:{}),...(tool.strict !== undefined ? {strict:tool.strict}:{})}};
}
export function mapUsage(usage = {}) {
  const n = value => Number.isFinite(value) && value >= 0 ? value : 0;
  return {input_tokens:n(usage.prompt_tokens), output_tokens:n(usage.completion_tokens), total_tokens:n(usage.total_tokens ?? (n(usage.prompt_tokens)+n(usage.completion_tokens)))};
}
export const event = (type, data = {}) => ({event:type,data:{type,...data}});
export function toolArguments(value) {
  let result; try { result = JSON.parse(value || '{}'); } catch { upstreamError(); }
  if (!isObject(result)) upstreamError();
  return result;
}

// Stateless translation: bounded per-request parsing, never persistent history.
export async function* parseChatChunks(body, {signal, maxBytes = 16*1024*1024} = {}) {
  if (!body) upstreamError();
  const reader = body.getReader(), decoder = new TextDecoder('utf-8', {fatal:true});
  let line = '', data = [], afterCR = false, bytes = 0, done = false, finished = false, sawChoice = false;
  const consumeLine = () => {
    if (line === '') {
      const payload = data.join('\n'); data = [];
      if (!payload.trim()) return null;
      if (payload.trim() === '[DONE]') { done = true; return null; }
      let chunk; try { chunk = JSON.parse(payload); } catch { upstreamError(); }
      if (!isObject(chunk) || (chunk.choices !== undefined && !Array.isArray(chunk.choices))) upstreamError();
      if (chunk.error) upstreamError('upstream_error');
      for (const choice of chunk.choices || []) {
        if (!isObject(choice) || (choice.index ?? 0) !== 0 || (choice.delta !== undefined && !isObject(choice.delta))) upstreamError();
        const delta = choice.delta || {};
        for (const key of ['content','refusal','reasoning_content']) if (delta[key] != null && typeof delta[key] !== 'string') upstreamError();
        if (delta.tool_calls !== undefined && !Array.isArray(delta.tool_calls)) upstreamError();
        for (const tool of delta.tool_calls || []) {
          if (!isObject(tool) || !Number.isInteger(tool.index) || tool.index < 0 || tool.index > 100 || (tool.type !== undefined && tool.type !== 'function') || (tool.function !== undefined && !isObject(tool.function))) upstreamError();
          for (const val of [tool.id,tool.function?.name,tool.function?.arguments]) if (val !== undefined && typeof val !== 'string') upstreamError();
        }
        if (finished && (delta.content || delta.refusal || delta.tool_calls?.length)) upstreamError();
        if (choice.finish_reason != null && choice.finish_reason !== '') {
          if (!['stop','length','tool_calls','content_filter','function_call'].includes(choice.finish_reason)) upstreamError();
          finished = true;
        }
        sawChoice = true;
      }
      return chunk;
    }
    if (line.startsWith('data:')) data.push(line.slice(5).replace(/^ /,''));
    line = '';
    return null;
  };
  const cancel = () => { reader.cancel(signal?.reason).catch(()=>{}); };
  signal?.addEventListener('abort',cancel,{once:true});
  try {
    while (!done) {
      signal?.throwIfAborted();
      const part = await reader.read();
      signal?.throwIfAborted();
      if (part.done) break;
      bytes += part.value.byteLength;
      if (bytes > maxBytes) upstreamError('upstream_response_too_large');
      let decoded; try { decoded = decoder.decode(part.value,{stream:true}); } catch { upstreamError(); }
      for (const char of decoded) {
        if (afterCR) { afterCR = false; if (char === '\n') continue; }
        if (char === '\r' || char === '\n') {
          const chunk = consumeLine(); afterCR = char === '\r';
          if (chunk) yield chunk;
          if (done) break;
        } else line += char;
      }
    }
    if (!done) { try { if (decoder.decode()) upstreamError('upstream_incomplete'); } catch { upstreamError('upstream_incomplete'); } }
    // A final event without its terminating blank line is incomplete SSE.
    if (!done && (line.length || data.length)) upstreamError('upstream_incomplete');
    if (!sawChoice || !finished) upstreamError('upstream_incomplete');
  } finally {
    signal?.removeEventListener('abort',cancel);
    cancel();
    reader.releaseLock();
  }
}

// Shared accumulator validates tool identity while exposing incremental deltas.
export function accumulator(model) {
  const state = {model,content:'',refusal:'',tools:new Map(),finish:null,usage:{}};
  const identities=new Map();
  function push(chunk) {
    if (isObject(chunk.usage)) state.usage = chunk.usage;
    const choice = chunk.choices?.[0];
    const delta = choice?.delta || {};
    state.content += delta.content || ''; state.refusal += delta.refusal || '';
    const tools = [];
    for (const part of delta.tool_calls || []) {
      let tool = state.tools.get(part.index);
      if (!tool) { tool = {index:part.index,id:'',name:'',arguments:''};state.tools.set(part.index,tool); }
      if (part.id) {
        if ((tool.id && tool.id !== part.id) || (identities.has(part.id) && identities.get(part.id)!==part.index)) upstreamError();
        tool.id = part.id;identities.set(part.id,part.index);
      }
      if (part.function?.name) { if (tool.started && tool.name !== part.function.name) upstreamError(); if (!tool.started) tool.name += part.function.name; }
      const argumentsDelta = part.function?.arguments || '';
      tool.arguments += argumentsDelta;
      tools.push({tool,argumentsDelta});
    }
    if (choice?.finish_reason != null && choice.finish_reason !== '') state.finish = choice.finish_reason;
    return {text:delta.content || '',refusal:delta.refusal || '',tools};
  }
  function validate() {
    if (!state.finish) upstreamError('upstream_incomplete');
    for (const tool of state.tools.values()) if (!tool.id || !tool.name) upstreamError();
  }
  return {state,push,validate};
}

export async function collectParsedCompletion(chunks, model) {
  const acc=accumulator(model);
  for await (const chunk of chunks) acc.push(chunk);
  acc.validate();
  const message={role:'assistant',content:acc.state.content||null};
  if(acc.state.refusal)message.refusal=acc.state.refusal;
  if(acc.state.tools.size)message.tool_calls=[...acc.state.tools.values()].map(tool=>({id:tool.id,type:'function',function:{name:tool.name,arguments:tool.arguments}}));
  return {model,choices:[{index:0,message,finish_reason:acc.state.finish}],usage:acc.state.usage};
}
