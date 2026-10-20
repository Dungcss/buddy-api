/**
 * Standalone WorkBuddy AI adapter. No DSH entrypoint or browser interaction.
 * Uses the installed dsh-workbuddy-connect 0.7.6 shared helper under MIT:
 * Copyright (c) 2026 Corrine Hu.
 * Original license: the dsh-workbuddy-connect package's own LICENSE file, found
 * beside the helper this adapter resolves at runtime. No upstream implementation
 * is copied here.
 */
import { createHash } from 'node:crypto';
import { createRequire } from 'node:module';
import { readFile, realpath, mkdir } from 'node:fs/promises';
import { existsSync, readdirSync } from 'node:fs';
import { homedir } from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const ADAPTER_DIR = path.dirname(fileURLToPath(import.meta.url));

// The shared helper is resolved from the installed package, not vendored: it is
// third-party MIT code with its own licence. BUDDY_WORKBUDDY_HELPER points at the
// file in a checkout where the package lives elsewhere; the default is the
// profile path used by the vendor installer on this machine.
const HELPER_PATH = process.env.BUDDY_WORKBUDDY_HELPER
  || path.join(homedir(), '.dsh', 'profiles', 'web', 'node_modules', 'dsh-workbuddy-connect', 'lib', 'host-heartbeat-vU86u9aU.js');

export const SOURCE_PIN = Object.freeze({
  package: 'dsh-workbuddy-connect',
  version: '0.7.6',
  path: HELPER_PATH,
  sha256: process.env.BUDDY_WORKBUDDY_HELPER_SHA256
    || 'ad366c3b645fb6786cb8bd10aca589b845f4ee22ec54a81d02c2b51cc0ee26e4',
});

// Read from the installed WorkBuddyAI.exe FileVersion, 2026-10-18.
const APP_VERSION = '5.8.4';
// Pricing is re-validated at most this often instead of on every request. The
// window is deliberately short: a model that stops being free can still be used
// for at most this long, which bounds cost exposure but removes one upstream
// round trip from the critical path of every chat request.
const CATALOG_TTL_MS = 120_000;
// Two peers the helper imports by bare specifier. A standalone Node process has
// no DSH loader to resolve them, so their installed files are located explicitly
// and hash-checked before use.
//
// Resolution order, first existing file wins:
//   1. BUDDY_DSH_NODE_MODULES — an explicit node_modules directory.
//   2. Normal Node resolution from the helper's own location.
//   3. Walking up from the helper, looking for a node_modules that has the peer.
//   4. Each profile under ~/.dsh/profiles/*/node_modules.
// A wrong version still fails the hash check below; this only locates the file.
const DSH_MODULES = process.env.BUDDY_DSH_NODE_MODULES || null;
function peerCandidates(packageName, entry) {
  const parts = packageName.split('/');
  const list = [];
  if (DSH_MODULES) list.push(path.join(DSH_MODULES, ...parts, 'lib', entry));
  list.push(path.join(ADAPTER_DIR, 'node_modules', ...parts, 'lib', entry));
  list.push(path.join(ADAPTER_DIR, '..', 'DeepSeek-Harness', 'app', 'node_modules', ...parts, 'lib', entry));
  try {
    const resolved = createRequire(pathToFileURL(HELPER_PATH)).resolve(packageName);
    list.push(path.join(path.dirname(resolved), entry));
  } catch {}
  let cursor = path.dirname(HELPER_PATH);
  for (let depth = 0; depth < 8; depth++) {
    list.push(path.join(cursor, 'node_modules', ...parts, 'lib', entry));
    const parent = path.dirname(cursor);
    if (parent === cursor) break;
    cursor = parent;
  }
  try {
    const profiles = path.join(homedir(), '.dsh', 'profiles');
    for (const name of readdirSync(profiles)) {
      list.push(path.join(profiles, name, 'node_modules', ...parts, 'lib', entry));
    }
  } catch {}
  return list;
}
function peerPath(packageName, entry) {
  const candidates = peerCandidates(packageName, entry);
  for (const candidate of candidates) if (existsSync(candidate)) return candidate;
  return candidates[0];
}
const PEER_PINS = Object.freeze([
  {
    specifier: '@deepseek-ai/dsh-atomic-write',
    path: peerPath('@deepseek-ai/dsh-atomic-write', 'index.js'),
    sha256: process.env.BUDDY_DSH_ATOMIC_WRITE_SHA256
      || '5f07978ef594a2711b2da301d5cb73a835cf1a48c1f8920ab5c6625137e12029',
  },
  {
    specifier: '@deepseek-ai/dsh-home-paths',
    path: peerPath('@deepseek-ai/dsh-home-paths', 'index.js'),
    sha256: process.env.BUDDY_DSH_HOME_PATHS_SHA256
      || '97c1c10b299a4f2aec5f34bac5370cad3834391cd75c91a76b1e7b8a643584f5',
  },
]);
let sharedPromise;

export class AdapterError extends Error {
  constructor(status, code, message) {
    super(message);
    this.name = 'AdapterError';
    this.status = status;
    this.code = code;
  }
}

const fail = (status, code, message) => { throw new AdapterError(status, code, message); };
const accountOf = credential => `${credential.domain}\0${credential.uid}\0${credential.enterpriseId ?? ''}`;
const isObject = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const aborted = signal => {
  if (signal?.aborted) fail(499, 'request_aborted', 'Request cancelled.');
};

async function loadShared() {
  sharedPromise ??= (async () => {
    let source;
    try { source = await readFile(SOURCE_PIN.path); }
    catch { fail(503, 'adapter_dependency_unavailable', 'WorkBuddy adapter dependency is unavailable.'); }
    if (createHash('sha256').update(source).digest('hex') !== SOURCE_PIN.sha256)
      fail(503, 'adapter_dependency_changed', 'WorkBuddy adapter dependency changed; review is required.');
    // The DSH loader normally resolves these peers. Standalone Node needs
    // explicit installed paths; change only those two verified import literals.
    let prepared = source.toString('utf8');
    const failureMarker = 'kind: classifyUpstreamError(response.status, text),';
    if (prepared.split(failureMarker).length !== 2)
      fail(503, 'adapter_dependency_incompatible', 'WorkBuddy adapter dependency is incompatible.');
    prepared = prepared.replace(failureMarker, `${failureMarker}\n retryAfter: response.headers.get('retry-after'),\n resetAt: response.headers.get('x-ratelimit-reset'),`);
    for (const peer of PEER_PINS) {
      let bytes;
      try { bytes = await readFile(peer.path); }
      catch { fail(503, 'adapter_dependency_unavailable', 'WorkBuddy adapter dependency is unavailable.'); }
      if (createHash('sha256').update(bytes).digest('hex') !== peer.sha256)
        fail(503, 'adapter_dependency_changed', 'WorkBuddy adapter dependency changed; review is required.');
      const literal = JSON.stringify(peer.specifier);
      if (prepared.split(literal).length !== 2)
        fail(503, 'adapter_dependency_incompatible', 'WorkBuddy adapter dependency is incompatible.');
      prepared = prepared.replace(literal, JSON.stringify(pathToFileURL(peer.path).href));
    }
    let shared;
    try { shared = await import(`data:text/javascript;base64,${Buffer.from(prepared).toString('base64')}`); }
    catch { fail(503, 'adapter_dependency_unavailable', 'WorkBuddy adapter dependency is unavailable.'); }
    if (typeof shared.m !== 'function' || typeof shared.O !== 'function' || typeof shared.b !== 'function' ||
        typeof shared.j !== 'function' || shared.x?.id !== 'workbuddy-ai')
      fail(503, 'adapter_dependency_incompatible', 'WorkBuddy adapter dependency is incompatible.');
    return shared;
  })();
  return sharedPromise;
}

// Resolve an absent leaf through its existing ancestor before creating it.
async function canonicalTarget(target) {
  let cursor = path.resolve(target);
  const suffix = [];
  for (;;) {
    try { return path.join(await realpath(cursor), ...suffix.reverse()); }
    catch (error) {
      if (error.code !== 'ENOENT') throw error;
      const parent = path.dirname(cursor);
      if (parent === cursor) throw error;
      suffix.push(path.basename(cursor));
      cursor = parent;
    }
  }
}

function inside(root, target) {
  const relative = path.relative(root, target);
  return relative === '' || (!relative.startsWith(`..${path.sep}`) && relative !== '..' && !path.isAbsolute(relative));
}

async function gatewayDataDir(dataDir) {
  if (typeof dataDir !== 'string' || !path.isAbsolute(dataDir))
    fail(500, 'invalid_data_directory', 'A dedicated absolute gateway data directory is required.');
  let directory;
  try {
    directory = await canonicalTarget(dataDir);
    const protectedDirectories = [
      path.join(homedir(), '.dsh'),
      path.join(homedir(), '.workbuddy'),
      path.join(homedir(), '.workbuddy-ai'),
      path.join(homedir(), 'AppData', 'Local', 'CodeBuddyExtension'),
      path.join(homedir(), 'AppData', 'Roaming', 'CodeBuddyExtension'),
    ];
    for (const target of protectedDirectories) {
      const protectedDirectory = await canonicalTarget(target);
      if (inside(protectedDirectory, directory))
        fail(500, 'invalid_data_directory', 'Gateway data must be separate from desktop and DSH data.');
    }
    await mkdir(directory, { recursive: true, mode: 0o700 });
    if (await realpath(directory) !== directory)
      fail(500, 'invalid_data_directory', 'Gateway data directory changed during initialization.');
  } catch (error) {
    if (error instanceof AdapterError) throw error;
    fail(500, 'invalid_data_directory', 'Gateway data directory is unavailable.');
  }
  return directory;
}

// GPT models stay hidden and unreachable at the operator's request. Matching is
// case-insensitive on the id prefix so a new gpt-* release is excluded without
// another edit.
const GPT_PATTERN = /^gpt[-_]/i;
export const isGptModel = id => typeof id === 'string' && GPT_PATTERN.test(id);

/** Return detached, public capability metadata for one catalog model. */
export function modelRow(model) {
  // Billing comes from the catalog itself. A free model reports free:true; a
  // paid one keeps free:false and its credit string, so callers can tell them
  // apart instead of every row claiming to be free.
  const billing = isObject(model.billing)
    ? { free: model.billing.free === true, ...(typeof model.billing.credits === 'string' ? { credits: model.billing.credits } : {}) }
    : { free: false };
  const row = {
    id: model.id,
    name: typeof model.name === 'string' ? model.name : model.id,
    billing,
  };
  for (const field of ['contextWindow', 'defaultContextWindow', 'maxTokens', 'maxInputTokens'])
    if (Number.isSafeInteger(model[field]) && model[field] > 0) row[field] = model[field];
  if (row.defaultContextWindow === undefined && row.contextWindow !== undefined)
    row.defaultContextWindow = row.contextWindow;
  if (Array.isArray(model.supportedContextWindows))
    row.supportedContextWindows = [...new Set(model.supportedContextWindows
      .filter(value => Number.isSafeInteger(value) && value > 0))].sort((a, b) => a - b);
  // The dashboard shows the largest window a model accepts, not the default one:
  // contextWindow is the default (300k for DeepSeek) while the model actually
  // takes up to 1M. maxContextWindow is that upper bound, derived from the
  // catalog's own numbers rather than assumed.
  const windows = [
    Number.isSafeInteger(model.contextWindow) ? model.contextWindow : 0,
    Number.isSafeInteger(model.defaultContextWindow) ? model.defaultContextWindow : 0,
    Number.isSafeInteger(model.maxInputTokens) ? model.maxInputTokens : 0,
    ...(Array.isArray(model.supportedContextWindows) ? model.supportedContextWindows : []),
  ].filter(value => Number.isSafeInteger(value) && value > 0);
  if (windows.length) row.maxContextWindow = Math.max(...windows);
  if (typeof model.supportsImages === 'boolean') row.supportsImages = model.supportsImages;
  if (isObject(model.reasoning)) {
    const reasoning = {};
    for (const field of ['supports', 'onlyReasoning', 'canDisableThinking'])
      if (typeof model.reasoning[field] === 'boolean') reasoning[field] = model.reasoning[field];
    const validEffort = value => typeof value === 'string' && /^[a-z][a-z0-9_-]{0,31}$/.test(value);
    if (Array.isArray(model.reasoning.supportedEfforts))
      reasoning.supportedEfforts = [...new Set(model.reasoning.supportedEfforts.filter(validEffort))];
    if (validEffort(model.reasoning.defaultEffort)) reasoning.defaultEffort = model.reasoning.defaultEffort;
    if (Object.keys(reasoning).length) row.reasoning = reasoning;
  }
  return row;
}

/**
 * listModels({signal,forceRefresh?}) => effective free-only metadata rows.
 * chatStream(body,{signal}) => upstream {ok,response}|{ok:false,status,kind,message}.
 * status() => safe local summary; no billing query, account IDs or credentials.
 */
export async function createAdapter({ dataDir, desktopAuthFile } = {}) {
  const shared = await loadShared();
  const directory = await gatewayDataDir(dataDir);
  const client = new shared.O({
    resolveAppVersion: async () => ({ version: APP_VERSION, source: 'configured' }),
    resolveChatIdentity: async () => ({ clientVersion: APP_VERSION }),
  });
  const store = new shared.m({
    variant: shared.x,
    ownPath: path.join(directory, 'workbuddy-ai-auth.json'),
    keyProvider: shared.b(shared.x),
    refresh: credential => client.refreshToken(credential),
    // When a snapshot path is supplied the adapter reads that document instead of
    // the live desktop file, which is what lets several accounts coexist.
    ...(desktopAuthFile ? { desktopPath: path.resolve(desktopAuthFile) } : {}),
  });
  return createAdapterRuntime({ shared, client, store });
}

/** Construct adapter behavior with resolved dependencies; does not load modules or credentials. */
export function createAdapterRuntime({ shared, client, store }) {
  let cache;
  let forcedCredential, refreshing;
  const authFailure = error => /\(http (401|403)\)/.test(error?.message || '');
  async function refreshOnce(credential) {
    if (forcedCredential && forcedCredential.accessToken !== credential.accessToken && accountOf(forcedCredential) === accountOf(credential)) return forcedCredential;
    refreshing ??= (async () => {
      try {
        const result = await client.refreshToken(credential);
        if (!result?.accessToken) throw new Error('refresh_failed');
        const refreshed = { ...credential, ...result,
          expiresAtMs: Number.isFinite(result.expiresInSec) ? Date.now() + result.expiresInSec * 1000 : credential.expiresAtMs };
        await store.saveOwn(refreshed);
        forcedCredential = refreshed; cache = undefined;
        return refreshed;
      } catch { fail(401, 'workbuddy_auth_unavailable', 'Sign in again to WorkBuddy AI.'); }
      finally { refreshing = undefined; }
    })();
    return refreshing;
  }
  let serial = 0;
  const pendingCatalogs = new Map();

  // Share only identical accounts and credential generations. Each caller owns
  // its cancellation; the upstream request ends only after the last waiter leaves.
  function fetchSharedCatalog(credential, signal) {
    aborted(signal);
    const generation = createHash('sha256').update(credential.accessToken).digest('hex');
    const key = `${accountOf(credential)}\0${generation}`;
    let pending = pendingCatalogs.get(key);
    if (!pending || pending.controller.signal.aborted) {
      const controller = new AbortController();
      pending = { controller, waiters: 0, settled: false, serial: ++serial };
      const created = pending;
      pending.promise = Promise.resolve().then(() => {
        aborted(controller.signal);
        return client.fetchModels(credential, controller.signal);
      }).finally(() => {
        created.settled = true;
        if (pendingCatalogs.get(key) === created) pendingCatalogs.delete(key);
      });
      pendingCatalogs.set(key, pending);
    }
    const current = pending;
    current.waiters++;
    return { serial: current.serial, promise: new Promise((resolve, reject) => {
      let finished = false;
      const finish = (error, models) => {
        if (finished) return;
        finished = true;
        signal?.removeEventListener('abort', cancel);
        current.waiters--;
        if (!current.settled && current.waiters === 0) current.controller.abort();
        if (error) reject(error); else resolve(models);
      };
      const cancel = () => {
        try { aborted(signal); } catch (error) { finish(error); }
      };
      signal?.addEventListener('abort', cancel, { once: true });
      current.promise.then(models => finish(undefined, models), error => finish(error));
      if (signal?.aborted) cancel();
    }) };
  }

  async function credentialFor(signal) {
    aborted(signal);
    let credential;
    try { credential = await store.resolve(); }
    catch { fail(401, 'workbuddy_auth_unavailable', 'Sign in to WorkBuddy AI on the gateway host.'); }
    aborted(signal);
    if (!credential || shared.L(credential.domain) !== 'global')
      fail(401, 'workbuddy_auth_unavailable', 'Sign in to WorkBuddy AI on the gateway host.');
    if (forcedCredential && accountOf(forcedCredential) === accountOf(credential) && forcedCredential.expiresAtMs > Date.now() + 30000) credential = forcedCredential;
    return credential;
  }

  async function sameAccount(credential, signal) {
    aborted(signal);
    let current;
    try { current = await store.current(); }
    catch { fail(401, 'workbuddy_auth_unavailable', 'WorkBuddy AI authentication is unavailable.'); }
    if (!current || accountOf(current) !== accountOf(credential))
      fail(409, 'workbuddy_account_changed', 'WorkBuddy AI account changed; retry the request.');
    aborted(signal);
  }

  // Every catalog model except GPT. Pricing is preserved per row: `billing.free`
  // says whether a call spends credits. `rateUnknown` rows are kept because the
  // operator asked for the full list; they simply report no known price.
  function availableRows(models) {
    return models.map(model => shared.j(model, Date.now()))
      .filter(model => typeof model.id === 'string' && model.id.length > 0 && !isGptModel(model.id))
      .map(modelRow);
  }

  // Counted from the same list the gateway serves, so the status figure cannot
  // disagree with /v1/models.
  const freeRows = models => availableRows(models).filter(row => row.billing.free === true);

  async function catalogFor(credential, { signal, forceRefresh = false } = {}) {
    aborted(signal);
    const account = accountOf(credential);
    if (!forceRefresh && cache?.account === account && Date.now() - cache.fetchedAt < CATALOG_TTL_MS)
      return { models: cache.models, rows: availableRows(cache.models) };
    const operation = fetchSharedCatalog(credential, signal);
    const request = operation.serial;
    let models;
    try { models = await operation.promise; }
    catch (error) {
      if (request === serial && !signal?.aborted) cache = undefined;
      aborted(signal);
      if (authFailure(error)) fail(401, 'workbuddy_auth_rejected', 'WorkBuddy AI authentication was rejected.');
      fail(503, 'workbuddy_catalog_unavailable', 'Live WorkBuddy AI pricing is unavailable; requests are blocked.');
    }
    await sameAccount(credential, signal);
    if (!Array.isArray(models))
      fail(503, 'workbuddy_catalog_unavailable', 'Live WorkBuddy AI pricing is unavailable; requests are blocked.');
    if (request === serial) cache = { account, models, fetchedAt: Date.now() };
    return { models, rows: availableRows(models) };
  }

  async function listModels(options = {}) {
    let credential = await credentialFor(options.signal);
    try { return (await catalogFor(credential, options)).rows; }
    catch (error) {
      if (error.code !== 'workbuddy_auth_rejected') throw error;
      credential = await refreshOnce(credential);
      try { return (await catalogFor(credential, { ...options, forceRefresh: true })).rows; }
      catch (retry) { if (retry.code === 'workbuddy_auth_rejected') fail(401, 'workbuddy_auth_unavailable', 'Sign in again to WorkBuddy AI.'); throw retry; }
    }
  }

  async function chatStream(body, { signal } = {}) {
    if (!isObject(body) || typeof body.model !== 'string' || body.model.trim() === '' ||
        !Array.isArray(body.messages))
      fail(400, 'invalid_request', 'A model and messages array are required.');
    // Copy the requested model before any await; never silently substitute one.
    const model = body.model;
    let bodyJson;
    try { bodyJson = JSON.stringify({ ...body, model, stream: true }); }
    catch { fail(400, 'invalid_request', 'The chat request must be valid JSON.'); }
    let credential = await credentialFor(signal);
    let catalog;
    let refreshedForCatalog = false;
    try { catalog = await catalogFor(credential, { signal }); }
    catch (error) {
      if (error.code !== 'workbuddy_auth_rejected') throw error;
      credential = await refreshOnce(credential); refreshedForCatalog = true;
      try { catalog = await catalogFor(credential, { signal, forceRefresh: true }); }
      catch (retry) { if (retry.code === 'workbuddy_auth_rejected') fail(401, 'workbuddy_auth_unavailable', 'Sign in again to WorkBuddy AI.'); throw retry; }
    }
    // Paid models are callable at the operator's explicit request; GPT models are
    // excluded, and an unknown id is still refused so a typo cannot silently
    // reach upstream.
    if (isGptModel(model))
      fail(403, 'model_not_allowed', 'GPT models are disabled on this gateway.');
    if (!catalog.rows.some(row => row.id === model))
      fail(404, 'model_not_found', 'The requested model is not in the live catalog.');
    await sameAccount(credential, signal);
    // Use this request's raw catalog, independent of concurrent cache refreshes.
    // No await is inserted between this time-window check and opening the stream.
    const rawModel = catalog.models.find(row => row.id === model);
    const effective = rawModel && shared.j(rawModel, Date.now());
    if (!effective)
      fail(404, 'model_not_found', 'The requested model is not in the live catalog.');
    if (isGptModel(effective.id))
      fail(403, 'model_not_allowed', 'GPT models are disabled on this gateway.');
    let result;
    try { result = await client.chatStream(credential, bodyJson, signal); }
    catch {
      aborted(signal);
      fail(502, 'workbuddy_upstream_unavailable', 'WorkBuddy AI is unavailable.');
    }
    if (!result.ok && [401, 403].includes(result.status) && !refreshedForCatalog) {
      credential = await refreshOnce(credential);
      aborted(signal);
      await sameAccount(credential, signal);
      try { result = await client.chatStream(credential, bodyJson, signal); }
      catch { aborted(signal); fail(502, 'workbuddy_upstream_unavailable', 'WorkBuddy AI is unavailable.'); }
    }
    if (result.ok) return result;
    // Only classification and timing escape this boundary; upstream text may contain secrets.
    const dailyQuota = /daily.{0,40}(quota|limit)|(?:quota|limit).{0,40}daily|每日.{0,20}(额度|限额)|今日.{0,20}(额度|限额)/i.test(result.message || '');
    return {
      ok: false,
      status: result.status,
      kind: result.kind,
      retryAfter: typeof result.retryAfter === 'string' && result.retryAfter.length <= 128 ? result.retryAfter : null,
      resetAt: /^\d{10,13}$/.test(result.resetAt || '') ? Number(result.resetAt) * (String(result.resetAt).length === 10 ? 1000 : 1) : null,
      dailyQuota,
      message: 'WorkBuddy AI rejected the request.',
    };
  }

  async function status() {
    let credential;
    try { credential = await store.current(); } catch {}
    const current = credential && cache?.account === accountOf(credential) ? cache : undefined;
    return {
      provider: 'workbuddy-ai',
      signedIn: Boolean(credential),
      catalogSource: current ? 'live' : 'none',
      catalogAgeMs: current ? Math.max(0, Date.now() - current.fetchedAt) : null,
      freeModelCount: current ? freeRows(current.models).length : 0,
      modelCount: current ? availableRows(current.models).length : 0,
      dependencyVersion: SOURCE_PIN.version,
    };
  }

  async function accountIdentity() {
    const credential = await store.current();
    return credential ? createHash('sha256').update(accountOf(credential)).digest('hex') : null;
  }
  return Object.freeze({ listModels, chatStream, status, accountIdentity });
}
