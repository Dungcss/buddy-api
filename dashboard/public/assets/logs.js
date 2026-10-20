// Request log. The three outcome classes are computed on the server from the
// same predicate the overview uses, so "28 lỗi" here and "28 lỗi" there mean the
// same rows.
(() => {
  const base = document.body.dataset.base || '';
  const el = id => document.getElementById(id);
  const esc = value => String(value ?? '').replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
  const MISSING = 'Không có dữ liệu';
  const fmtCount = value => typeof value === 'number' && Number.isFinite(value) ? value.toLocaleString('vi-VN') : null;
  const cell = value => {
    const text = fmtCount(value);
    return text === null ? '<td class="right missing">' + MISSING + '</td>' : '<td class="right num">' + text + '</td>';
  };
  const localInput = ms => new Date(ms + 7 * 3600000).toISOString().slice(0, 16);
  const localLabel = iso => iso ? iso.replace('T', ' ').slice(0, 19) : '—';
  const narrow = () => document.documentElement.clientWidth < 560;

  const state = { from: null, to: null, outcome: 'all', account: '', model: '', protocol: '', q: '', page: 1 };
  let labels = {};
  let lastData = null;

  const accountCell = key => {
    if (!key) return '<td>—</td>';
    const label = labels[key];
    // The address is the label a person recognises; the snapshot code stays in
    // the tooltip so the column does not wrap to two lines on a phone.
    return '<td title="' + esc(key) + '">' + esc(label || key) + '</td>';
  };

  async function loadLabels() {
    try {
      const res = await fetch(base + '/api/account-labels', { cache: 'no-store' });
      if (!res.ok) return;
      labels = (await res.json()).labels || {};
    } catch {}
  }

  function fillSelect(target, values, labelOf = value => value) {
    const select = el(target);
    const current = select.value;
    select.innerHTML = ['<option value="">Tất cả</option>']
      .concat(values.map(value => '<option value="' + esc(value) + '">' + esc(labelOf(value)) + '</option>'))
      .join('');
    if (values.includes(current)) select.value = current;
  }

  function paint(data) {
    lastData = data;
    const rows = data.rows || [];
    el('logsEmpty').hidden = rows.length > 0;
    el('logsRows').innerHTML = rows.map(row => {
      const tone = row.outcome === 'failed' ? 'bad' : row.outcome === 'saturated' ? 'warn' : '';
      const status = typeof row.status === 'number'
        ? '<span class="status-pill ' + tone + '">' + row.status + '</span>'
        : '<span class="status-pill mute">—</span>';
      const retries = typeof row.upstream_retries === 'number' ? String(row.upstream_retries) : MISSING;
      const time = narrow() ? (row.at_local || '').slice(5, 16) : (row.at_local || '—');
      return '<tr tabindex="0" data-id="' + esc(row.request_id || '') + '">' +
        '<td class="num">' + esc(time) + '</td>' +
        '<td>' + status + '<br><span class="mono muted">' + esc(row.code || '') + '</span></td>' +
        '<td>' + esc(narrow() && row.model && row.model.length > 16 ? row.model.slice(0, 15) + '…' : (row.model || '—')) + '</td>' +
        accountCell(row.account) +
        '<td class="mono">' + esc(row.protocol || '—') + (row.stream ? ' · SSE' : '') + '</td>' +
        '<td class="mono">' + esc(row.path || '—') + '</td>' +
        '<td class="right num">' + retries + '</td>' +
        (row.usage_present
          ? cell(row.input_tokens) + cell(row.output_tokens) + cell(row.cache_write_tokens) + cell(row.cache_read_tokens)
          : cell(null) + cell(null) + cell(null) + cell(null)) +
        '<td class="right num">' + (fmtCount(row.ms) ?? '—') + '</td>' +
        '<td class="mono">' + esc((row.request_id || '').slice(0, 8)) + '</td></tr>';
    }).join('');

    const counts = data.counts || {};
    el('logsUpdated').textContent = 'Cập nhật ' + localLabel(data.generatedAt_local);
    el('logsChips').innerHTML = [
      '<span class="chip"><b>' + (counts.all || 0) + '</b> tổng</span>',
      '<span class="chip ok"><b>' + (counts.ok || 0) + '</b> thành công</span>',
      '<span class="chip warn"><b>' + (counts.saturated || 0) + '</b> nghẽn</span>',
      '<span class="chip bad"><b>' + (counts.failed || 0) + '</b> lỗi thật</span>',
      '<span class="chip">' + esc(localLabel(data.range?.from_local)) + ' → ' + esc(localLabel(data.range?.to_local)) + '</span>',
    ].join('');

    fillSelect('logsAccount', data.accounts || [], key => labels[key] ? labels[key] + ' · ' + key : key);
    fillSelect('logsModel', data.models || []);

    const pager = el('logsPager');
    if (data.pages > 1) {
      pager.hidden = false;
      pager.innerHTML =
        '<span class="position">Trang ' + data.page + ' / ' + data.pages + ' · ' + data.total + ' request</span>' +
        '<span class="jump">Đến trang <input id="logsJump" type="number" min="1" max="' + data.pages + '" value="' + data.page + '" aria-label="Đến trang"> <button type="button" class="secondary small" id="logsGo">Đi</button></span>' +
        '<button type="button" class="secondary small" id="logsPrev"' + (data.page > 1 ? '' : ' disabled') + '>Trước</button>' +
        '<button type="button" class="secondary small" id="logsNext"' + (data.page < data.pages ? '' : ' disabled') + '>Sau</button>';
      el('logsPrev')?.addEventListener('click', () => { state.page = data.page - 1; void load(); });
      el('logsNext')?.addEventListener('click', () => { state.page = data.page + 1; void load(); });
      const jump = el('logsJump');
      const go = () => {
        const want = Number.parseInt(jump?.value, 10);
        if (!Number.isFinite(want)) return;
        state.page = Math.min(Math.max(1, want), data.pages);
        void load();
      };
      el('logsGo')?.addEventListener('click', go);
      jump?.addEventListener('keydown', event => { if (event.key === 'Enter') { event.preventDefault(); go(); } });
    } else {
      pager.hidden = true;
      pager.innerHTML = '';
    }
  }

  function params(exporting) {
    const query = new URLSearchParams();
    if (state.from) query.set('from', state.from);
    if (state.to) query.set('to', state.to);
    if (state.outcome && state.outcome !== 'all') query.set('outcome', state.outcome);
    if (state.account) query.set('account', state.account);
    if (state.model) query.set('model', state.model);
    if (state.protocol) query.set('protocol', state.protocol);
    if (state.q) query.set('q', state.q);
    if (!exporting) {
      query.set('page', String(state.page || 1));
      query.set('page_size', String(document.documentElement.clientWidth < 560 ? 25 : 50));
    }
    return query;
  }

  async function load() {
    await loadLabels();
    try {
      const res = await fetch(base + '/api/logs?' + params(), { cache: 'no-store' });
      if (res.status === 401) { location.reload(); return; }
      if (!res.ok) throw new Error();
      paint(await res.json());
    } catch {
      el('logsUpdated').textContent = 'Chưa đọc được nhật ký';
    }
  }

  function setRange(hours) {
    const now = Date.now();
    state.from = localInput(now - hours * 3600000);
    state.to = localInput(now);
    el('logsFrom').value = state.from;
    el('logsTo').value = state.to;
    state.page = 1;
  }

  el('logsFilter').addEventListener('submit', event => {
    event.preventDefault();
    state.from = el('logsFrom').value || null;
    state.to = el('logsTo').value || null;
    state.outcome = el('logsOutcome').value;
    state.account = el('logsAccount').value;
    state.model = el('logsModel').value;
    state.protocol = el('logsProtocol').value;
    state.q = el('logsQuery').value.trim();
    state.page = 1;
    void load();
  });
  el('logsToday').addEventListener('click', () => {
    const now = Date.now();
    state.from = localInput(Date.parse(new Date(now + 7 * 3600000).toISOString().slice(0, 10) + 'T00:00:00+07:00'));
    state.to = localInput(now);
    el('logsFrom').value = state.from;
    el('logsTo').value = state.to;
    state.page = 1;
    void load();
  });
  el('logs24h').addEventListener('click', () => { setRange(24); void load(); });
  el('logsExport').addEventListener('click', () => {
    // The CSV carries exactly the rows the current filter selects, not the page.
    window.location.href = base + '/api/logs/export?' + params(true);
  });

  // The full record opens in place: the log page already holds the filter the
  // operator used, and a navigation would throw it away.
  async function openSheet(id) {
    const sheet = el('sheet');
    try {
      const res = await fetch(base + '/api/request?id=' + encodeURIComponent(id), { cache: 'no-store' });
      const data = await res.json();
      el('sheetContent').textContent = JSON.stringify(data, null, 2);
    } catch {
      el('sheetContent').textContent = 'Không đọc được bản ghi này.';
    }
    sheet.classList.add('open');
    sheet.setAttribute('aria-hidden', 'false');
    el('sheetClose')?.focus();
  }
  function closeSheet() {
    el('sheet')?.classList.remove('open');
    el('sheet')?.setAttribute('aria-hidden', 'true');
  }
  document.addEventListener('click', event => {
    if (event.target.closest('#sheetClose')) { closeSheet(); return; }
    const row = event.target.closest('tr[data-id]');
    if (row && row.dataset.id) void openSheet(row.dataset.id);
  });
  document.addEventListener('keydown', event => {
    if (event.key === 'Escape') closeSheet();
    const row = event.target.closest && event.target.closest('tr[data-id]');
    if (row && row.dataset.id && (event.key === 'Enter' || event.key === ' ')) {
      event.preventDefault();
      void openSheet(row.dataset.id);
    }
  });

  setRange(24);
  void load();
})();
