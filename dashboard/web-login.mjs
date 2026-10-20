// Device-state login. Credentials remain in this process and the private account store.
import { randomUUID } from 'node:crypto';
import { setTimeout as delay } from 'node:timers/promises';

export const AUTH_ORIGIN = 'https://www.workbuddy.ai';
export const AUTH_PREFIX = '/v2/plugin';
const NO_AUTH = { 'X-No-Authorization': 'true', 'X-No-User-Id': 'true', 'X-No-Enterprise-Id': 'true', 'X-No-Department-Info': 'true' };

export function createWebLogin({ saveAccount, registerAccount, fetchImpl = fetch, ttlMs = 300000, intervalMs = 1000 }) {
  const jobs = new Map();
  async function request(path, options, signal) {
    const response = await fetchImpl(AUTH_ORIGIN + AUTH_PREFIX + path, {
      ...options, redirect: 'error', signal: AbortSignal.any([signal, AbortSignal.timeout(8000)]),
    });
    const envelope = await response.json().catch(() => ({}));
    return { status: response.status, ok: response.ok, envelope };
  }
  function view(job) {
    return { id: job.id, accountId: job.accountId, status: job.status, expiresAt: new Date(job.expires).toISOString(),
      ...(job.status === 'pending' ? { loginUrl: job.loginUrl } : {}),
      ...(job.error ? { error: job.error } : {}) };
  }
  function finish(job, status, error) {
    if (['complete', 'failed', 'expired', 'cancelled'].includes(job.status)) return;
    job.status = status;
    job.error = error;
    delete job.state;
    delete job.loginUrl;
    job.controller.abort();
    clearTimeout(job.timeout);
    job.cleanup = setTimeout(() => jobs.delete(job.id), 600000);
    job.cleanup.unref?.();
  }
  async function poll(job) {
    const signal = job.controller.signal;
    try {
      while (!signal.aborted) {
        await delay(intervalMs, undefined, { signal });
        const result = await request('/auth/token?state=' + encodeURIComponent(job.state), { headers: NO_AUTH }, signal);
        if (signal.aborted) return;
        const auth = result.envelope.data;
        if (result.ok && result.envelope.code === 0 && typeof auth?.accessToken === 'string' && auth.accessToken) {
          job.status = 'saving';
          const headers = { Authorization: 'Bearer ' + auth.accessToken, 'X-Domain': auth.domain || 'www.workbuddy.ai' };
          const accounts = await request('/accounts', { headers }, signal);
          const rows = accounts.envelope.data?.accounts;
          if (!accounts.ok || !Array.isArray(rows) || !rows.length) throw new Error('account_unavailable');
          const account = rows.find(row => row.lastLogin) || rows[0];
          if (signal.aborted) return;
          const saved = await saveAccount(job.accountId, { auth, account }, signal);
          if (signal.aborted) return;
          if (!saved.ok) throw new Error('snapshot_failed');
          const registered = await registerAccount(job.accountId);
          if (signal.aborted) return;
          if (!registered) throw new Error('registration_failed');
          finish(job, 'complete');
          return;
        }
        // 11217 is the app's documented pending-token response. Never expose upstream messages.
        if (result.envelope.code === 11217 || (result.ok && result.envelope.code === 0 && !auth)) continue;
        throw new Error('login_rejected');
      }
    } catch {
      if (!signal.aborted) finish(job, 'failed', 'login_failed');
    }
  }
  return {
    async start(owner) {
      // One live state per dashboard session, with a global bound on pending work.
      if ([...jobs.values()].some(j => j.owner === owner && j.status === 'saving')) return { error: 'login_busy' };
      for (const job of jobs.values()) if (job.owner === owner && ['starting', 'pending'].includes(job.status)) finish(job, 'cancelled');
      if ([...jobs.values()].filter(j => ['pending', 'saving', 'starting'].includes(j.status)).length >= 12) return { error: 'login_busy' };
      const job = { id: randomUUID(), accountId: 'web-' + randomUUID().replaceAll('-', '').slice(0, 12), owner,
        status: 'starting', expires: Date.now() + ttlMs, controller: new AbortController() };
      jobs.set(job.id, job);
      job.timeout = setTimeout(() => finish(job, 'expired', 'login_expired'), ttlMs);
      job.timeout.unref?.();
      try {
        const result = await request('/auth/state?platform=workbuddy-ai', {
          method: 'POST', headers: { ...NO_AUTH, 'content-type': 'application/json' }, body: '{}',
        }, job.controller.signal);
        const data = result.envelope.data;
        if (!result.ok || result.envelope.code !== 0 || typeof data?.state !== 'string' || !data.state || typeof data.authUrl !== 'string') throw new Error();
        const suppliedUrl = new URL(data.authUrl);
        if (suppliedUrl.origin !== AUTH_ORIGIN || suppliedUrl.pathname !== '/login') throw new Error();
        const url = new URL('/login', AUTH_ORIGIN);
        url.searchParams.set('platform', 'workbuddy-ai');
        url.searchParams.set('state', data.state);
        url.searchParams.set('version', '5.8.4');
        if (job.controller.signal.aborted) return { error: 'login_expired' };
        job.state = data.state;
        job.loginUrl = url.href;
        job.status = 'pending';
        void poll(job);
        return view(job);
      } catch {
        finish(job, 'failed', 'auth_unavailable');
        return { error: 'auth_unavailable' };
      }
    },
    status(owner, id) { const job = jobs.get(id); return job?.owner === owner ? view(job) : null; },
    cancel(owner, id) {
      const job = jobs.get(id);
      if (!job || job.owner !== owner) return null;
      if (['pending', 'starting'].includes(job.status)) finish(job, 'cancelled');
      return view(job);
    },
    close() { for (const job of jobs.values()) { job.controller.abort(); clearTimeout(job.timeout); clearTimeout(job.cleanup); } jobs.clear(); },
  };
}
