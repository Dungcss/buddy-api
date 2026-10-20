// Account store for the dashboard: snapshots of the WorkBuddy desktop auth
// document, one directory per account. Tokens never leave this module; the API
// only ever exposes identifiers, timestamps and a boolean health flag.
import { readFile, writeFile, mkdir, readdir, rm, stat, copyFile, chmod } from 'node:fs/promises';
import { join } from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { createAdapter } from '../adapter.mjs';

// Capture-from-desktop paths. They are configurable because a clone runs on a
// different machine and a different user profile; the defaults match the vendor
// installer on Windows and are simply absent elsewhere.
const DESKTOP = process.env.WORKBUDDY_AI_AUTH_FILE
  || join(process.env.LOCALAPPDATA || '', 'CodeBuddyExtension', 'Data', 'Public', 'auth', 'workbuddy-desktop-ai.info');
const ELECTRON = process.env.WORKBUDDY_AI_ELECTRON_BIN
  || join(process.env.LOCALAPPDATA || '', 'Programs', 'WorkBuddyAI', 'WorkBuddyAI.exe');
const ID_PATTERN = /^[a-z0-9-]{1,24}$/;

export const accountsRoot = root => join(root, 'data', 'accounts');
export const validId = id => typeof id === 'string' && ID_PATTERN.test(id);

const runFile = promisify(execFile);
async function privatePath(target, directory = false) {
  await chmod(target, directory ? 0o700 : 0o600);
  if (process.platform === 'win32') {
    const { stdout } = await runFile('whoami.exe', ['/user', '/fo', 'csv', '/nh'], { windowsHide: true });
    const sid = stdout.match(/S-1-[0-9-]+/)?.[0];
    if (!sid) throw new Error('private_acl_unavailable');
    await runFile('icacls.exe', [target, '/inheritance:r', '/grant:r', '*' + sid + (directory ? ':(OI)(CI)F' : ':F')], { windowsHide: true });
  }
}

// Upstream puts the sign-in identity in "nickname". For these accounts it is an
// email address, which is what a person recognises. Only an email-shaped value
// is accepted, so a display name can never be mistaken for a contact address.
const EMAIL_PATTERN = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
export const emailOf = record => {
  const raw = record && typeof record.nickname === 'string' ? record.nickname.trim().toLowerCase() : '';
  return EMAIL_PATTERN.test(raw) ? raw : null;
};
// The dashboard belongs to one operator on one host and lists their own sign-in
// accounts, so the full address is shown: several stored accounts differ only in
// the local part, and a masked value cannot tell them apart.
export const maskedEmail = email => (typeof email === 'string' && email ? email : null);

export async function saveWebAccount(root, id, session, signal) {
  if (!validId(id)) return { ok: false };
  const directory = join(accountsRoot(root), id);
  // Exclusive mkdir prevents replacing an existing snapshot, including production a.
  await mkdir(directory, { mode: 0o700 });
  try {
    await privatePath(directory, true);
    signal?.throwIfAborted();
    const source = session.auth;
    const expiry = (absolute, seconds) => Number.isFinite(absolute) ? (absolute < 1e12 ? absolute * 1000 : absolute)
      : Number.isFinite(seconds) && seconds > 0 ? Date.now() + seconds * 1000 : undefined;
    const auth = {
      accessToken: source.accessToken, refreshToken: typeof source.refreshToken === 'string' ? source.refreshToken : '',
      domain: source.domain || 'www.workbuddy.ai',
      expiresAt: expiry(source.expiresAt, source.expiresIn),
      refreshExpiresAt: expiry(source.refreshExpiresAt, source.refreshExpiresIn),
    };
    if (!['www.workbuddy.ai', 'www.codebuddy.ai'].includes(auth.domain)) throw new Error('unsupported_domain');
    const account = Object.fromEntries(['uid', 'uin', 'enterpriseId', 'nickname'].filter(k => ['string', 'number'].includes(typeof session.account[k])).map(k => [k, session.account[k]]));
    if (!account.uid) throw new Error('account_missing');
    const target = join(directory, 'desktop-auth.info');
    await writeFile(target, JSON.stringify({ auth, account }) + '\n', { mode: 0o600, flag: 'wx' });
    await privatePath(target);
    const verification = await verifySnapshot(directory);
    signal?.throwIfAborted();
    if (!verification.healthy) throw new Error('verification_failed');
    const now = new Date().toISOString();
    await writeFile(join(directory, 'account.json'), JSON.stringify({ id, uid: account.uid, uin: account.uin ?? null,
      email: emailOf(session.account),
      domain: auth.domain, accessTokenExpiresAt: auth.expiresAt ? new Date(auth.expiresAt).toISOString() : null,
      capturedAt: now, verifiedAt: now, healthy: true, models: verification.models, source: 'web-login' }) + '\n', { mode: 0o600 });
    return { ok: true };
  } catch {
    await rm(directory, { recursive: true, force: true });
    return { ok: false };
  }
}

// Decryption is serialised: the adapter reads its source path from the process
// environment, so two concurrent verifications would otherwise cross streams.
let queue = Promise.resolve();
const serialise = task => {
  const run = queue.then(task, task);
  queue = run.catch(() => {});
  return run;
};

async function verifySnapshot(directory) {
  return serialise(async () => {
    const previousAuth = process.env.WORKBUDDY_AI_AUTH_FILE;
    const previousBin = process.env.WORKBUDDY_AI_ELECTRON_BIN;
    process.env.WORKBUDDY_AI_AUTH_FILE = join(directory, 'desktop-auth.info');
    process.env.WORKBUDDY_AI_ELECTRON_BIN = ELECTRON;
    try {
      const adapter = await createAdapter({ dataDir: join(directory, 'verify-data') });
      const models = await adapter.listModels({ forceRefresh: true });
      let account = null;
      try {
        const snapshot = JSON.parse(await readFile(join(directory, 'desktop-auth.info'), 'utf8'));
        account = snapshot?.account && typeof snapshot.account === 'object' ? snapshot.account : null;
      } catch {}
      return { healthy: true, models: models.map(model => model.id), account };
    } catch (error) {
      return { healthy: false, reason: error?.code || error?.message || 'unknown' };
    } finally {
      if (previousAuth === undefined) delete process.env.WORKBUDDY_AI_AUTH_FILE; else process.env.WORKBUDDY_AI_AUTH_FILE = previousAuth;
      if (previousBin === undefined) delete process.env.WORKBUDDY_AI_ELECTRON_BIN; else process.env.WORKBUDDY_AI_ELECTRON_BIN = previousBin;
      // The adapter only writes here when it refreshes; drop the scratch directory
      // so the account store holds nothing but the snapshot and its record.
      await rm(join(directory, 'verify-data'), { recursive: true, force: true }).catch(() => {});
    }
  });
}

const maskUid = uid => (typeof uid === 'string' && uid.length > 10 ? uid.slice(0, 8) + '…' : uid || null);

async function readRecord(directory, id) {
  try {
    const record = JSON.parse(await readFile(join(directory, 'account.json'), 'utf8'));
    const info = await stat(join(directory, 'desktop-auth.info'));
    return { ...record, id, bytes: info.size, snapshot: undefined };
  } catch {
    return null;
  }
}

export async function listAccounts(root) {
  const base = accountsRoot(root);
  let names = [];
  try { names = (await readdir(base)).filter(validId); } catch { return []; }
  const rows = [];
  for (const id of names) {
    const record = await readRecord(join(base, id), id);
    if (record) rows.push({
      id: record.id,
      uid: maskUid(record.uid),
      // The label a person recognises, masked like the uid. When the upstream
      // record has no email-shaped nickname it stays null and the UI falls back
      // to the account id.
      // A stored record carries the label under `email`; only an email-shaped
      // value is ever stored, so this is already safe to show as-is.
      email: maskedEmail(record.email),
      uin: record.uin ?? null,
      expiresAt: record.accessTokenExpiresAt ?? null,
      capturedAt: record.capturedAt ?? null,
      verifiedAt: record.verifiedAt ?? null,
      healthy: record.healthy ?? null,
      models: Array.isArray(record.models) ? record.models : [],
      bytes: record.bytes,
    });
  }
  return rows.sort((a, b) => String(a.capturedAt).localeCompare(String(b.capturedAt)));
}

export async function captureAccount(root, id) {
  if (!validId(id)) return { ok: false, error: 'invalid_id' };
  const directory = join(accountsRoot(root), id);
  await mkdir(directory, { recursive: true });
  let raw;
  try { raw = await readFile(DESKTOP); }
  catch { return { ok: false, error: 'desktop_auth_missing', hint: 'Đăng nhập WorkBuddy trong app trên máy này trước.' }; }

  let doc;
  try { doc = JSON.parse(raw.toString('utf8')); }
  catch { return { ok: false, error: 'desktop_auth_unreadable' }; }
  if (!doc?.auth?.accessToken) return { ok: false, error: 'desktop_auth_empty', hint: 'App chưa đăng nhập tài khoản nào.' };

  await writeFile(join(directory, 'desktop-auth.info'), raw);
  const verification = await verifySnapshot(directory);
  const record = {
    id,
    uid: doc.account?.uid ?? null,
    uin: doc.account?.uin ?? null,
    domain: doc.auth?.domain ?? null,
    accessTokenExpiresAt: doc.auth?.expiresAt ? new Date(doc.auth.expiresAt).toISOString() : null,
    refreshTokenExpiresAt: doc.auth?.refreshExpiresAt ? new Date(doc.auth.refreshExpiresAt).toISOString() : null,
    capturedAt: new Date().toISOString(),
    verifiedAt: new Date().toISOString(),
    healthy: verification.healthy,
    models: verification.models || [],
    ...(verification.reason ? { reason: verification.reason } : {}),
  };
  await writeFile(join(directory, 'account.json'), JSON.stringify(record, null, 2) + '\n', 'utf8');
  return { ok: true, account: { id, uid: maskUid(record.uid), uin: record.uin, expiresAt: record.accessTokenExpiresAt, healthy: record.healthy, models: record.models } };
}

export async function verifyAccount(root, id) {
  if (!validId(id)) return { ok: false, error: 'invalid_id' };
  const directory = join(accountsRoot(root), id);
  const record = await readRecord(directory, id);
  if (!record) return { ok: false, error: 'not_found' };
  const verification = await verifySnapshot(directory);
  const label = emailOf(verification.account || {});
  // Keep the previous label when the upstream record has none this time rather
  // than clearing a value we already know.
  const updated = { ...record, verifiedAt: new Date().toISOString(), healthy: verification.healthy,
    models: verification.models || [], ...(label ? { email: label } : {}), snapshot: undefined };
  delete updated.account;
  if (verification.reason) updated.reason = verification.reason; else delete updated.reason;
  delete updated.bytes;
  await writeFile(join(directory, 'account.json'), JSON.stringify(updated, null, 2) + '\n', 'utf8');
  return { ok: true, account: { id, healthy: updated.healthy, models: updated.models, reason: updated.reason || null } };
}

export async function removeAccount(root, id) {
  if (!validId(id)) return { ok: false, error: 'invalid_id' };
  const directory = join(accountsRoot(root), id);
  try { await stat(directory); } catch { return { ok: false, error: 'not_found' }; }
  await rm(directory, { recursive: true, force: true });
  return { ok: true, id };
}
