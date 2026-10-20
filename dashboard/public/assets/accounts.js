// Accounts page: sign-in flow, snapshot table, duplicate warnings. The usage
// ledger moved to /dashboard/usage so this page stays about identity and health.
(() => {
  const base = document.body.dataset.base || '';
  const el = id => document.getElementById(id);
  const esc = value => String(value ?? '').replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
  const when = value => {
    const ms = Date.parse(value);
    if (!Number.isFinite(ms)) return '—';
    return new Date(ms + 7 * 3600000).toISOString().slice(0, 16).replace('T', ' ');
  };
  // The phone row has ~90px for the expiry, which holds "19/10 08:44" and not a
  // full date. The full value stays on the desktop column.
  const whenShort = value => {
    const ms = Date.parse(value);
    if (!Number.isFinite(ms)) return '—';
    const iso = new Date(ms + 7 * 3600000).toISOString();
    return iso.slice(8, 10) + '/' + iso.slice(5, 7) + ' ' + iso.slice(11, 16);
  };

  function say(message, tone) {
    const status = el('status');
    if (!status) return;
    status.className = 'status ' + (tone || '');
    status.querySelector('span').textContent = message;
  }

  let activeId = null;
  let gatewayEntries = [];
  let rotation = { mode: 'manual', entries: [] };

  function render(rows) {
    const body = el('rows');
    el('empty').hidden = rows.length > 0;
    el('accountCount').textContent = rows.length + ' tài khoản';
    body.innerHTML = rows.map(row => {
      const healthy = row.healthy === true;
      const unknown = row.healthy === null || row.healthy === undefined;
      const runtime = rotation.entries.find(item => item.id === row.id);
      const runtimeLabel = runtime?.aliasOf ? 'trùng tài khoản ' + runtime.aliasOf
        : runtime?.state === 'cooldown' ? 'tạm nghỉ · thử lại ' + when(runtime.retryAt)
        : runtime?.state === 'needs_login' ? 'cần đăng nhập lại'
        : runtime?.state === 'probing' ? 'đang thử lại'
        : runtime?.state === 'probe_ready' ? 'chờ request thử lại' : null;
      const label = runtimeLabel || (unknown ? 'chưa kiểm tra' : healthy ? 'dùng được' : 'cần kiểm tra');
      const isActive = row.id === activeId && rotation.mode === 'manual';
      const available = gatewayEntries.includes(row.id);
      const action = isActive
        ? '<span class="badge">đang dùng</span>'
        : available && healthy
          ? '<button type="button" class="small" data-act="use" data-id="' + esc(row.id) + '">Dùng</button>'
          : '<span class="chip mute">cần khởi động lại cổng</span>';
      const tone = healthy ? 'ok-text' : unknown ? 'muted' : 'bad-text';
      return '<tr>' +
        // The address is the row's identity. The snapshot code is an internal
        // handle nobody recognises, so it is kept in the tooltip instead of a
        // second line — except when there is no address, where it is the only
        // thing that identifies the snapshot.
        '<td class="identity" title="' + esc(row.id) + '">' +
        (row.email
          ? '<span class="mail">' + esc(row.email) + '</span>'
          : '<span class="mail muted">(chưa có mail)</span><code class="code">' + esc(row.id) + '</code>') +
        '</td>' +
        '<td class="mono">' + esc(row.uid || '—') + '</td>' +
        '<td class="mono">' + esc(row.uin || '—') + '</td>' +
        '<td class="num">' + esc(when(row.expiresAt)) + '</td>' +
        // The expiry repeats under the status on a phone, where its own column
        // would cost 84px and push the actions out of the frame.
        '<td class="' + tone + '">' + esc(label) +
        '<span class="when-mobile">hạn ' + esc(whenShort(row.expiresAt)) + '</span></td>' +
        // A dozen model ids in one cell made the row taller than the viewport and
        // pushed the actions out of the table. Two ids plus a count, with the
        // full list on hover and on the model page.
        '<td class="models-cell" title="' + esc((row.models || []).join(', ') || '—') + '">' +
        (row.models && row.models.length
          ? esc(row.models.slice(0, 2).join(', ')) +
            (row.models.length > 2 ? ' <span class="muted">+' + (row.models.length - 2) + '</span>' : '')
          : '—') + '</td>' +
        '<td><div class="row-actions">' + action +
          '<button type="button" class="small secondary" data-act="verify" data-id="' + esc(row.id) + '">Kiểm tra</button>' +
          '<button type="button" class="small danger" data-act="delete" data-id="' + esc(row.id) + '">Xóa</button>' +
        '</div></td></tr>';
    }).join('');
  }

  // A true duplicate (same upstream account stored twice) is reported, never
  // silently merged. A look-alike pair is the case that actually causes a wrong
  // pick when switching, so it gets its own wording.
  function renderWarnings(data) {
    const box = el('accountWarnings');
    const list = el('warningList');
    const parts = [];
    // Name a snapshot by its address when one exists; the web-* code is only a
    // fallback for a snapshot whose nickname never carried a mail.
    const nameOf = id => (data.accounts || []).find(row => row.id === id)?.email || id;
    for (const item of data.duplicates || []) {
      const where = item.ids.map(id => '<code>' + esc(nameOf(id)) + '</code>').join(' và ');
      parts.push('<p class="warn dup">Trùng tài khoản: ' + where +
        ' là cùng một tài khoản upstream' + (item.email ? ' (' + esc(item.email) + ')' : '') +
        '. Cổng chỉ dùng một trong hai; bạn có thể xóa bản còn lại.</p>');
    }
    for (const item of data.similar || []) {
      parts.push('<p class="warn lookalike">Hai địa chỉ cùng đầu <code>' + esc(item.sharedPrefix || '') +
        '…</code>: ' + item.emails.map(e => '<code>' + esc(e) + '</code>').join(' và ') +
        '. Cùng tên, chỉ khác phần đuôi — kiểm tra kỹ trước khi chọn tài khoản.</p>');
    }
    box.hidden = parts.length === 0;
    list.innerHTML = parts.join('');
    el('warningCount').textContent = parts.length + ' mục';
  }

  async function loadActive() {
    try {
      const res = await fetch(base + '/api/active-account', { cache: 'no-store' });
      const data = await res.json();
      activeId = data.active || null;
      gatewayEntries = Array.isArray(data.entries) ? data.entries : [];
      rotation = data.rotation || { mode: 'manual', entries: [] };
      el('toggleRotation').disabled = false;
      el('toggleRotation').textContent = rotation.mode === 'round-robin' ? 'Tắt xoay vòng' : 'Bật xoay vòng';
      el('rotationNote').textContent = rotation.mode === 'round-robin'
        ? 'Đang xoay vòng mỗi request · tự bỏ qua tài khoản tạm nghỉ.'
        : 'Đang dùng một tài khoản: ' + (activeId || '—');
      el('activeNote').textContent = activeId
        ? 'Tài khoản đã chọn: "' + activeId + '" · tài khoản cổng biết: ' + gatewayEntries.join(', ')
        : 'Chưa đọc được tài khoản đang dùng của cổng.';
    } catch {
      el('activeNote').textContent = 'Chưa đọc được tài khoản đang dùng của cổng.';
    }
  }

  async function load() {
    const res = await fetch(base + '/api/accounts', { cache: 'no-store' });
    if (res.status === 401) { location.reload(); return; }
    const data = await res.json();
    await loadActive();
    render(data.accounts || []);
    renderWarnings(data);
    say('sẵn sàng', 'ok');
  }

  async function post(path, payload) {
    const res = await fetch(base + path, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(payload || {}),
    });
    return { status: res.status, body: await res.json().catch(() => ({})) };
  }

  el('toggleRotation').addEventListener('click', async () => {
    el('toggleRotation').disabled = true;
    try {
      const { status } = await post('/api/account-rotation', { mode: rotation.mode === 'round-robin' ? 'manual' : 'round-robin' });
      if (status !== 200) throw new Error();
      await load();
    } catch { say('Chưa đổi được chế độ. Bấm thử lại.', 'bad'); }
    finally { el('toggleRotation').disabled = false; }
  });

  setInterval(() => {
    if (document.hidden) return;
    loadActive().then(() => fetch(base + '/api/accounts', { cache: 'no-store' }))
      .then(res => res.ok ? res.json() : null)
      .then(data => { if (data) { render(data.accounts || []); renderWarnings(data); } })
      .catch(() => {});
  }, 15000);

  let loginJob = null;
  let loginTimer = null;
  let loginWindow = null;
  const loginKey = 'buddy-web-login';
  function resetLogin(message) {
    clearTimeout(loginTimer);
    loginJob = null;
    sessionStorage.removeItem(loginKey);
    el('startLogin').disabled = false;
    el('openLogin').hidden = true;
    el('openLogin').removeAttribute('href');
    el('cancelLogin').hidden = true;
    el('loginNote').textContent = message;
  }
  async function watchLogin() {
    const id = loginJob;
    if (!id) return;
    try {
      const res = await fetch(base + '/api/web-login/' + encodeURIComponent(id), { cache: 'no-store' });
      if (loginJob !== id) return;
      if (res.status === 401) { resetLogin('Phiên dashboard đã hết hạn. Tải lại trang để đăng nhập.'); return; }
      if (!res.ok) { resetLogin('Phiên đăng nhập không còn tồn tại. Bấm đăng nhập để thử lại.'); return; }
      const data = await res.json();
      if (loginJob !== id) return;
      if (data.status === 'complete') {
        resetLogin('Đã thêm ' + data.accountId + ' · dùng được. Bấm “Dùng” ở dòng tài khoản để chọn.');
        await load(); return;
      }
      if (['failed', 'expired', 'cancelled'].includes(data.status)) {
        resetLogin(data.status === 'expired' ? 'Đã hết 5 phút chờ. Bấm đăng nhập để tạo phiên mới.'
          : data.status === 'cancelled' ? 'Đã hủy đăng nhập.' : 'Chưa thêm được tài khoản. Bấm đăng nhập để thử lại.'); return;
      }
      if (data.loginUrl) {
        el('openLogin').href = data.loginUrl;
        el('openLogin').hidden = false;
      }
      el('cancelLogin').hidden = false;
      el('cancelLogin').disabled = data.status === 'saving';
      if (data.status === 'saving') el('openLogin').hidden = true;
      const seconds = Math.max(0, Math.ceil((Date.parse(data.expiresAt) - Date.now()) / 1000));
      el('loginNote').textContent = data.status === 'saving' ? 'Đã đăng nhập, đang kiểm tra tài khoản…'
        : 'Đang chờ bạn đăng nhập trong tab mới · còn ' + Math.floor(seconds / 60) + ':' + String(seconds % 60).padStart(2, '0') + '.';
    } catch {
      if (loginJob === id) el('loginNote').textContent = 'Mất kết nối tạm thời, đang thử lại…';
    }
    if (loginJob === id) loginTimer = setTimeout(watchLogin, 1500);
  }

  el('startLogin').addEventListener('click', async () => {
    el('startLogin').disabled = true;
    el('loginNote').textContent = 'Đang tạo phiên đăng nhập…';
    // Opened during the user gesture so the browser does not block the tab.
    loginWindow = window.open('about:blank', '_blank');
    if (loginWindow) loginWindow.opener = null;
    try {
      const { status, body } = await post('/api/web-login');
      if (status !== 201 || !body.id || !body.loginUrl) throw new Error();
      loginJob = body.id;
      sessionStorage.setItem(loginKey, loginJob);
      el('openLogin').href = body.loginUrl;
      el('openLogin').hidden = false;
      el('cancelLogin').hidden = false;
      if (loginWindow) loginWindow.location.replace(body.loginUrl);
      await watchLogin();
    } catch {
      loginWindow?.close();
      resetLogin('Không tạo được phiên đăng nhập. Kiểm tra kết nối rồi bấm thử lại.');
    }
  });

  el('cancelLogin').addEventListener('click', async () => {
    const id = loginJob;
    if (!id) return;
    el('cancelLogin').disabled = true;
    try {
      const res = await fetch(base + '/api/web-login/' + encodeURIComponent(id), { method: 'DELETE' });
      if (!res.ok) throw new Error();
      if (loginJob === id) resetLogin('Đã hủy đăng nhập. Bạn có thể đóng tab WorkBuddy.');
    } catch { el('loginNote').textContent = 'Chưa hủy được. Kiểm tra kết nối rồi bấm Hủy lại.'; }
    finally { el('cancelLogin').disabled = false; }
  });

  if (sessionStorage.getItem(loginKey)) {
    loginJob = sessionStorage.getItem(loginKey);
    el('startLogin').disabled = true;
    void watchLogin();
  }

  el('captureForm').addEventListener('submit', async event => {
    event.preventDefault();
    const id = el('accountId').value.trim().toLowerCase();
    el('captureNote').textContent = 'Đang chụp và kiểm tra…';
    say('đang chụp', '');
    const { status, body } = await post('/api/accounts/capture', { id });
    if (status !== 200 || !body.ok) {
      el('captureNote').textContent = 'Không chụp được: ' + (body.error || status) + (body.hint ? ' — ' + body.hint : '');
      say('chụp thất bại', 'bad');
      return;
    }
    const account = body.account;
    el('captureNote').textContent = account.healthy
      ? 'Đã chụp ' + account.id + ' · ' + account.models.length + ' model.'
      : 'Đã chụp ' + account.id + ' nhưng không giải mã được.';
    say(account.healthy ? 'đã chụp' : 'cần kiểm tra', account.healthy ? 'ok' : 'bad');
    el('accountId').value = '';
    await load();
  });

  document.addEventListener('click', async event => {
    const button = event.target.closest('button[data-act]');
    if (!button) return;
    const id = button.dataset.id;
    if (button.dataset.act === 'use') {
      say('đang chuyển sang ' + id, '');
      const { body } = await post('/api/active-account', { id });
      say(body.active ? 'cổng đang dùng ' + body.active : 'chuyển thất bại', body.active ? 'ok' : 'bad');
      await load();
      return;
    }
    if (button.dataset.act === 'verify') {
      say('đang kiểm tra ' + id, '');
      const { body } = await post('/api/accounts/verify', { id });
      if (body.ok) say(body.account.healthy ? id + ' dùng được' : id + ' không giải mã được', body.account.healthy ? 'ok' : 'bad');
      else say('kiểm tra thất bại', 'bad');
      await load();
      return;
    }
    if (button.dataset.act === 'delete') {
      if (!confirm('Xóa bản chụp "' + id + '"? Không ảnh hưởng tới đăng nhập trong app.')) return;
      const { body } = await post('/api/accounts/delete', { id });
      say(body.ok ? 'đã xóa ' + id : 'xóa thất bại', body.ok ? 'ok' : 'bad');
      await load();
    }
  });

  load().catch(() => say('mất kết nối', 'bad'));
})();
