// API keys page: endpoints, one-time reveal, per-key model permissions, guide.
// The plaintext token exists only in the create response and the reveal box; it
// is never written to localStorage, the URL or a log line.
(() => {
  const base = document.body.dataset.base || '';
  const el = id => document.getElementById(id);
  const esc = value => String(value ?? '').replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
  const localLabel = iso => {
    const ms = Date.parse(iso);
    return Number.isFinite(ms) ? new Date(ms + 7 * 3600000).toISOString().slice(0, 16).replace('T', ' ') : '—';
  };
  const rel = iso => {
    const ms = Date.parse(iso);
    if (!Number.isFinite(ms)) return 'chưa dùng';
    const minutes = Math.round((Date.now() - ms) / 60000);
    if (minutes < 1) return 'vừa xong';
    if (minutes < 60) return minutes + ' phút trước';
    const hours = Math.round(minutes / 60);
    if (hours < 48) return hours + ' giờ trước';
    return Math.round(hours / 24) + ' ngày trước';
  };

  let data = { keys: [], bootstrap: [], catalog: [], notes: [], baseUrl: '' };
  let revealTimer = null;
  // Draft grants for the create form and the edit dialog, kept separate so
  // cancelling the dialog cannot change what the create form would submit.
  let newKeyModels = null; // null = all models
  let editState = null;
  const filters = { query: '', status: 'all' };

  const byId = id => (data.catalog || []).find(model => model.id === id);
  const modelLabel = id => byId(id)?.name || id;
  const freeIds = () => (data.catalog || []).filter(model => model.free).map(model => model.id);

  // The server supplies the base URL; the fallback is the page's own origin, so
  // a clone never prints another deployment's domain.
  const fallbackBase = () => location.origin + '/v1';

  function endpoints() {
    const baseUrl = data.baseUrl || fallbackBase();
    el('baseUrl').textContent = baseUrl;
    el('endpointChat').textContent = baseUrl + '/chat/completions';
    el('endpointMessages').textContent = baseUrl + '/messages';
    el('endpointModels').textContent = baseUrl + '/models';
    el('guideBase').textContent = baseUrl;
  }

  // One guide block per client. Every example carries a placeholder key, never a
  // real one, and reads the model list from the catalog so the sample is callable.
  function guideCode(tab) {
    const baseUrl = data.baseUrl || fallbackBase();
    const free = (data.catalog || []).find(model => model.free)?.id || 'deepseek-v4.1-flash';
    const pick = (data.catalog || [])[0]?.id || free;
    if (tab === 'python') {
      return `from openai import OpenAI

client = OpenAI(
    base_url="${baseUrl}",
    api_key="buddy_sk_…",   # khóa vừa tạo
)

reply = client.chat.completions.create(
    model="${pick}",
    messages=[{"role": "user", "content": "Xin chào"}],
)
print(reply.choices[0].message.content)
print(reply.usage)`;
    }
    if (tab === 'node') {
      return `import OpenAI from "openai";

const client = new OpenAI({
  baseURL: "${baseUrl}",
  apiKey: process.env.BUDDY_API_KEY, // đặt biến môi trường, đừng ghi vào mã
});

const reply = await client.chat.completions.create({
  model: "${pick}",
  messages: [{ role: "user", content: "Xin chào" }],
});

console.log(reply.choices[0].message.content, reply.usage);`;
    }
    if (tab === 'claude') {
      return `curl ${baseUrl}/messages \\
  -H "x-api-key: buddy_sk_…" \\
  -H "content-type: application/json" \\
  -d '{
    "model": "${pick}",
    "max_tokens": 256,
    "messages": [{"role": "user", "content": "Xin chào"}]
  }'`;
    }
    return `# 1. Xem model khóa này được phép gọi
curl ${baseUrl}/models \\
  -H "x-api-key: buddy_sk_…"

# 2. Gọi chat
curl ${baseUrl}/chat/completions \\
  -H "x-api-key: buddy_sk_…" \\
  -H "content-type: application/json" \\
  -d '{
    "model": "${pick}",
    "messages": [{"role": "user", "content": "Xin chào"}],
    "stream": false
  }'`;
  }

  function paintGuide(tab) {
    el('guideCode').textContent = guideCode(tab);
    for (const button of document.querySelectorAll('[data-tab]')) {
      button.setAttribute('aria-pressed', button.dataset.tab === tab ? 'true' : 'false');
      button.classList.toggle('ok', button.dataset.tab === tab);
    }
  }

  // A checkbox list of the catalog. Free models are grouped first so a "free
  // only" key is quick to build by hand as well as by the shortcut button.
  function modelListHtml(selected, { disabled = false } = {}) {
    const chosen = selected === null ? null : new Set(selected);
    const groups = [
      ['Miễn phí', (data.catalog || []).filter(model => model.free)],
      ['Trả phí', (data.catalog || []).filter(model => !model.free)],
    ];
    return groups.filter(([, list]) => list.length).map(([title, list]) =>
      '<p class="perm-group">' + esc(title) + ' · ' + list.length + '</p>' +
      list.map(model => {
        const checked = chosen === null || chosen.has(model.id);
        return '<label class="perm-item">' +
          '<input type="checkbox" value="' + esc(model.id) + '"' + (checked ? ' checked' : '') +
          (disabled ? ' disabled' : '') + '>' +
          '<span><b>' + esc(model.name) + '</b><small>' + esc(model.id) +
          (model.free ? '' : ' · ' + esc(model.credits || 'trả phí')) + '</small></span>' +
          '</label>';
      }).join('')).join('');
  }

  function countLabel(list) {
    if (list === null) return (data.catalog || []).length + ' model · tất cả';
    if (!list.length) return 'không model nào';
    return list.length + ' / ' + (data.catalog || []).length + ' model';
  }

  function paintNewKey() {
    const list = el('newKeyList');
    list.hidden = newKeyModels === null;
    if (newKeyModels !== null) list.innerHTML = modelListHtml(newKeyModels);
    el('newKeyCount').textContent = countLabel(newKeyModels);
    for (const button of document.querySelectorAll('#newKeyModes [data-mode]')) {
      const mode = button.dataset.mode;
      const active = mode === 'all' ? newKeyModels === null
        : mode === 'free' ? newKeyModels !== null && newKeyModels.length > 0 && newKeyModels.every(id => freeIds().includes(id))
        : newKeyModels !== null;
      button.setAttribute('aria-pressed', active ? 'true' : 'false');
      button.classList.toggle('ok', active);
    }
  }

  function readNewKeyList() {
    const list = el('newKeyList');
    if (newKeyModels === null) return null;
    return [...list.querySelectorAll('input[type=checkbox]')].filter(input => input.checked).map(input => input.value);
  }

  function render() {
    const active = data.keys.filter(key => !key.revokedAt);
    el('keyCount').textContent = active.length + ' / ' + data.keys.length + ' khóa';
    el('keysActive').textContent = active.length + ' đang dùng';
    el('keysUpdated').textContent = 'Cập nhật ' + localLabel(data.generatedAt);

    const query = filters.query.toLowerCase();
    const rows = data.keys
      .filter(key => {
        if (filters.status === 'active' && key.revokedAt) return false;
        if (filters.status === 'revoked' && !key.revokedAt) return false;
        if (!query) return true;
        return (key.label + ' ' + key.hint).toLowerCase().includes(query);
      })
      .sort((a, b) => String(b.createdAt).localeCompare(String(a.createdAt)));

    el('keyEmpty').hidden = rows.length > 0;
    el('keyRows').innerHTML = rows.map(key => {
      const revoked = Boolean(key.revokedAt);
      const used = key.lastRequestAt || key.lastUsedAt;
      // Permission is shown as a count plus the first ids, the way a person
      // scans it; the dialog holds the full list.
      const granted = Array.isArray(key.models) ? key.models : null;
      const permText = granted === null
        ? '<span class="chip ok">' + (key.modelCount || (data.catalog || []).length) + ' model</span>'
        : granted.length
          ? '<span class="chip warn">' + granted.length + ' model</span><br><small class="muted">' +
            esc(granted.slice(0, 2).map(modelLabel).join(', ')) +
            (granted.length > 2 ? ' +' + (granted.length - 2) : '') + '</small>'
          : '<span class="chip bad">không model</span>';
      return '<tr' + (revoked ? ' class="revoked"' : '') + '>' +
        '<td><b>' + esc(key.label) + '</b><br><small class="muted">' +
        esc(used ? rel(used) : 'chưa dùng') + '</small>' +
        // On a phone the status, the request count and the created date have no
        // room of their own, so they are repeated here in one muted line while
        // their columns are hidden.
        '<span class="keys-meta-mobile">' +
        (revoked ? 'đã thu hồi' : 'hoạt động') + ' · ' + (key.requests30d || 0) + ' request · ' +
        esc(localLabel(key.createdAt)) + '</span></td>' +
        '<td class="mono">' + esc(key.hint) + '</td>' +
        '<td>' + permText + '</td>' +
        '<td class="right num">' + (key.requests30d || 0) + '</td>' +
        '<td class="num">' + esc(localLabel(key.createdAt)) + '</td>' +
        '<td>' + (revoked
          ? '<span class="status-pill mute">đã thu hồi</span>'
          : '<span class="status-pill">hoạt động</span>') +
        // The phone layout drops the actions column, so the two controls are
        // repeated here, inside the status cell, where they stay reachable.
        '<div class="row-actions-mobile">' +
        (revoked ? '' :
          '<button type="button" class="small secondary" data-perm="' + esc(key.id) + '">Quyền</button>' +
          '<button type="button" class="small danger" data-revoke="' + esc(key.id) + '">Thu hồi</button>') +
        '</div></td>' +
        '<td><div class="row-actions">' +
        (revoked ? '' :
          '<button type="button" class="small secondary" data-perm="' + esc(key.id) + '">Quyền</button>' +
          '<button type="button" class="small danger" data-revoke="' + esc(key.id) + '">Thu hồi</button>') +
        '</div></td></tr>';
    }).join('');

    el('keyBootstrap').innerHTML = (data.bootstrap || []).map(item =>
      '<tr><td class="mono">' + esc(item.id) + '</td><td>' + esc(item.label) + '</td>' +
      '<td><span class="chip ok">' + (item.modelCount || (data.catalog || []).length) + ' model · không giới hạn</span></td></tr>').join('');
    el('keyNotes').innerHTML = (data.notes || []).map(note => '<li>' + esc(note) + '</li>').join('');
    endpoints();
    paintNewKey();
  }

  async function load() {
    try {
      const res = await fetch(base + '/api/keys', { cache: 'no-store' });
      if (res.status === 401) { location.reload(); return; }
      if (!res.ok) throw new Error();
      data = await res.json();
      render();
    } catch {
      el('keysUpdated').textContent = 'Chưa đọc được danh sách khóa';
    }
  }

  function hideReveal() {
    clearTimeout(revealTimer);
    el('keyReveal').hidden = true;
    el('keyToken').textContent = '';
  }

  // ---- create -------------------------------------------------------------
  el('newKeyModes').addEventListener('click', event => {
    const button = event.target.closest('button[data-mode]');
    if (!button) return;
    const mode = button.dataset.mode;
    if (mode === 'all') newKeyModels = null;
    if (mode === 'free') newKeyModels = freeIds();
    if (mode === 'pick') {
      const current = readNewKeyList();
      newKeyModels = current === null ? [] : current;
    }
    paintNewKey();
  });
  el('newKeyList').addEventListener('change', () => {
    newKeyModels = readNewKeyList();
    el('newKeyCount').textContent = countLabel(newKeyModels);
  });

  el('keyForm').addEventListener('submit', async event => {
    event.preventDefault();
    el('keyCreate').disabled = true;
    el('keyNote').textContent = 'Đang tạo khóa…';
    try {
      const res = await fetch(base + '/api/keys', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ label: el('keyLabel').value.trim(), models: newKeyModels }),
      });
      const body = await res.json().catch(() => ({}));
      if (res.status === 409) {
        el('keyNote').textContent = body.hint || 'Đã đạt giới hạn 25 khóa đang hoạt động.';
        return;
      }
      if (res.status !== 201 || !body.token) throw new Error();
      el('keyToken').textContent = body.token;
      el('keyReveal').hidden = false;
      el('keyNote').textContent = 'Đã tạo “' + body.key.label + '”. Sao chép khóa rồi bấm “Đã lưu”.';
      el('keyLabel').value = '';
      // A grant picked for one key should not silently apply to the next one.
      newKeyModels = null;
      revealTimer = setTimeout(hideReveal, 5 * 60 * 1000);
      await load();
    } catch {
      el('keyNote').textContent = 'Không tạo được khóa. Kiểm tra kết nối rồi thử lại.';
    } finally {
      el('keyCreate').disabled = false;
    }
  });

  el('keyCopy').addEventListener('click', async () => {
    const token = el('keyToken').textContent;
    if (!token) return;
    try {
      await navigator.clipboard.writeText(token);
      el('keyCopy').textContent = 'Đã sao chép';
      setTimeout(() => { el('keyCopy').textContent = 'Sao chép'; }, 2000);
    } catch {
      const range = document.createRange();
      range.selectNodeContents(el('keyToken'));
      const selection = window.getSelection();
      selection.removeAllRanges();
      selection.addRange(range);
      el('keyCopy').textContent = 'Đã chọn, bấm Ctrl+C';
    }
  });
  el('keyDismiss').addEventListener('click', hideReveal);

  // ---- copy buttons -------------------------------------------------------
  document.addEventListener('click', async event => {
    const button = event.target.closest('[data-copy]');
    if (!button) return;
    const target = el(button.dataset.copy);
    const text = target?.textContent || '';
    if (!text || text === 'đang đọc…') return;
    try {
      await navigator.clipboard.writeText(text);
      const prior = button.textContent;
      button.textContent = 'Đã sao chép';
      setTimeout(() => { button.textContent = prior; }, 1800);
    } catch {
      const range = document.createRange();
      range.selectNodeContents(target);
      const selection = window.getSelection();
      selection.removeAllRanges();
      selection.addRange(range);
    }
  });

  // ---- guide tabs ---------------------------------------------------------
  document.addEventListener('click', event => {
    const button = event.target.closest('[data-tab]');
    if (!button) return;
    paintGuide(button.dataset.tab);
  });

  // ---- list filters -------------------------------------------------------
  el('keySearch').addEventListener('input', event => { filters.query = event.target.value.trim(); render(); });
  el('keyFilter').addEventListener('change', event => { filters.status = event.target.value; render(); });

  // ---- permission dialog --------------------------------------------------
  function openPerm(id) {
    const key = data.keys.find(item => item.id === id);
    if (!key) return;
    editState = { id, label: key.label, models: Array.isArray(key.models) ? key.models.slice() : null };
    el('permTitle').textContent = 'Quyền model · ' + key.label;
    el('permHint').textContent = 'Khóa chỉ gọi được các model được chọn. Bỏ chọn hết nghĩa là khóa không gọi được model nào.';
    el('permList').innerHTML = modelListHtml(editState.models);
    paintPerm();
    el('permDialog').showModal();
  }

  function paintPerm() {
    const selected = editState.models;
    el('permCount').textContent = countLabel(selected);
    for (const button of document.querySelectorAll('#permModes [data-perm]')) {
      const mode = button.dataset.perm;
      const active = mode === 'all' ? selected === null
        : mode === 'free' ? selected !== null && selected.length > 0 && selected.every(id => freeIds().includes(id))
        : selected !== null && selected.length === 0;
      button.setAttribute('aria-pressed', active ? 'true' : 'false');
      button.classList.toggle('ok', active);
    }
    // When the grant is "all", every box is shown checked; unchecking one turns
    // the grant into an explicit list that excludes it.
    const inputs = [...el('permList').querySelectorAll('input[type=checkbox]')];
    for (const input of inputs) input.checked = selected === null || selected.includes(input.value);
  }

  el('permModes').addEventListener('click', event => {
    const button = event.target.closest('button[data-perm]');
    if (!button || !editState) return;
    const mode = button.dataset.perm;
    if (mode === 'all') editState.models = null;
    if (mode === 'free') editState.models = freeIds();
    if (mode === 'none') editState.models = [];
    el('permList').innerHTML = modelListHtml(editState.models);
    paintPerm();
  });

  el('permList').addEventListener('change', () => {
    if (!editState) return;
    editState.models = [...el('permList').querySelectorAll('input[type=checkbox]')]
      .filter(input => input.checked).map(input => input.value);
    el('permCount').textContent = countLabel(editState.models);
    for (const button of document.querySelectorAll('#permModes [data-perm]')) button.classList.remove('ok');
  });

  el('permCancel').addEventListener('click', () => { editState = null; el('permDialog').close(); });
  el('permSave').addEventListener('click', async () => {
    if (!editState) return;
    el('permSave').disabled = true;
    try {
      const res = await fetch(base + '/api/keys/' + encodeURIComponent(editState.id), {
        method: 'PATCH',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ models: editState.models }),
      });
      if (!res.ok) throw new Error();
      el('permDialog').close();
      editState = null;
      await load();
    } catch {
      el('permCount').textContent = 'Chưa lưu được. Kiểm tra kết nối rồi thử lại.';
    } finally {
      el('permSave').disabled = false;
    }
  });

  // ---- revoke -------------------------------------------------------------
  document.addEventListener('click', async event => {
    const permButton = event.target.closest('button[data-perm]');
    if (permButton) { openPerm(permButton.dataset.perm); return; }
    const button = event.target.closest('button[data-revoke]');
    if (!button) return;
    const id = button.dataset.revoke;
    if (!confirm('Thu hồi khóa này? Ứng dụng đang dùng nó sẽ nhận 401 ở request kế tiếp.')) return;
    button.disabled = true;
    try {
      const res = await fetch(base + '/api/keys/' + encodeURIComponent(id), { method: 'DELETE' });
      if (!res.ok) throw new Error();
      await load();
    } catch {
      button.disabled = false;
      el('keysUpdated').textContent = 'Chưa thu hồi được khóa';
    }
  });

  paintGuide('curl');
  load();
})();
