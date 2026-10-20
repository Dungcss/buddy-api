// Usage page. The server owns windowing, filtering, aggregation and paging, so
// the totals always describe exactly the rows the table can show.
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

  const state = { from: null, to: null, account: '', model: '', all: false, page: 1 };
  let labels = {};
  let pages = 1;
  let detailCount = 0;
  let currentPage = 1;

  const narrow = () => document.documentElement.clientWidth < 560;
  const pageSizeFor = () => {
    const w = document.documentElement.clientWidth;
    return w < 560 ? 25 : w < 960 ? 50 : 100;
  };
  const shortModel = model => {
    const text = model ?? '';
    return !text || text === '—' ? '—' : (text.length > 18 ? text.slice(0, 17) + '…' : text);
  };
  const shortAccount = account => {
    const text = account ?? '';
    return !text || text === '—' ? '—' : (text.length > 14 ? text.slice(0, 13) + '…' : text);
  };

  async function loadLabels() {
    try {
      const res = await fetch(base + '/api/account-labels', { cache: 'no-store' });
      if (!res.ok) return;
      labels = (await res.json()).labels || {};
    } catch {}
  }

  // The address is what a person recognises, so it is the visible label. The
  // internal snapshot code stays in the tooltip and in the CSV, never as a
  // second line that competes with the mail for width.
  const accountCell = key => {
    if (!key) return '<td>—</td>';
    const label = labels[key];
    return '<td title="' + esc(key) + '">' + esc(label || shortAccount(key)) + '</td>';
  };

  function fillSelect(target, values, labelOf = value => value) {
    const select = el(target);
    const current = select.value;
    select.innerHTML = ['<option value="">Tất cả</option>']
      .concat(values.map(value => '<option value="' + esc(value) + '">' + esc(labelOf(value)) + '</option>'))
      .join('');
    if (values.includes(current)) select.value = current;
  }

  function renderGroup(rows, firstLabel) {
    if (!rows.length) return '<tr data-always="1"><td colspan="7" class="empty">Không có dữ liệu trong khoảng đã chọn</td></tr>';
    return rows.map(row => '<tr>' +
      (firstLabel === 'account' ? accountCell(row.key) : '<td>' + esc(row.key) + '</td>') +
      '<td class="right num">' + (fmtCount(row.requests) ?? '0') + '</td>' +
      '<td class="right num">' + (fmtCount(row.usage_requests) ?? '0') + '</td>' +
      cell(row.input_tokens) + cell(row.output_tokens) +
      cell(row.cache_write_tokens) + cell(row.cache_read_tokens) + '</tr>').join('');
  }

  function paintDetail() {
    const rows = window.currentRows || [];
    el('usageEmpty').hidden = rows.length > 0;
    el('usageRows').innerHTML = rows.map(row => {
      const retries = typeof row.upstream_retries === 'number' ? String(row.upstream_retries) : MISSING;
      const http = typeof row.status === 'number'
        ? '<td class="right"><span class="status-pill ' + (row.status >= 400 ? 'bad' : '') + '">' + row.status + '</span></td>'
        : '<td class="right missing">' + MISSING + '</td>';
      const time = narrow() ? (row.at_local || row.at || '—').slice(5, 16) : (row.at_local || row.at || '—');
      return '<tr>' +
        '<td class="num">' + esc(time) + '</td>' +
        accountCell(row.account) +
        '<td title="' + esc(row.model || '') + '">' + esc(narrow() ? shortModel(row.model) : (row.model || '—')) + '</td>' +
        http +
        '<td class="right num">' + retries + '</td>' +
        (row.usage_present
          ? cell(row.input_tokens) + cell(row.output_tokens) + cell(row.cache_write_tokens) + cell(row.cache_read_tokens)
          : cell(null) + cell(null) + cell(null) + cell(null)) +
        '</tr>';
    }).join('');

    const pager = el('usagePager');
    if (detailCount > pageSizeFor()) {
      const size = pageSizeFor();
      pager.hidden = false;
      pager.innerHTML =
        '<span class="position">Trang ' + currentPage + ' / ' + pages + ' · ' +
        Math.min((currentPage - 1) * size + 1, detailCount) + '–' +
        Math.min((currentPage - 1) * size + rows.length, detailCount) + ' trong ' + detailCount + ' request</span>' +
        '<span class="jump">Đến trang <input id="usageJump" type="number" min="1" max="' + pages + '" value="' + currentPage + '" inputmode="numeric" aria-label="Đến trang"> <button type="button" class="secondary small" id="usageGo">Đi</button></span>' +
        '<button type="button" class="secondary small" id="usagePrev"' + (currentPage > 1 ? '' : ' disabled') + '>Trước</button>' +
        '<button type="button" class="secondary small" id="usageNext"' + (currentPage < pages ? '' : ' disabled') + '>Sau</button>';
      el('usagePrev')?.addEventListener('click', () => { state.page = currentPage - 1; void loadUsage(); });
      el('usageNext')?.addEventListener('click', () => { state.page = currentPage + 1; void loadUsage(); });
      const jump = el('usageJump');
      const go = () => {
        const want = Number.parseInt(jump?.value, 10);
        if (!Number.isFinite(want)) return;
        state.page = Math.min(Math.max(1, want), pages);
        void loadUsage();
      };
      el('usageGo')?.addEventListener('click', go);
      jump?.addEventListener('keydown', event => { if (event.key === 'Enter') { event.preventDefault(); go(); } });
    } else {
      pager.hidden = true;
      pager.innerHTML = '';
    }
  }

  function renderUsage(data) {
    const t = data.totals || {};
    const covered = key => (t.coverage && t.coverage[key]) || 0;
    const setFigure = (target, sub, value, text) => {
      const node = el(target);
      const shown = fmtCount(value);
      node.textContent = shown === null ? MISSING : shown;
      node.classList.toggle('missing', shown === null);
      el(sub).textContent = text;
    };
    setFigure('uInput', 'uInputSub', t.input_tokens,
      covered('input_tokens') + '/' + (t.usage_requests || 0) + ' request có số · đã gồm cache read');
    setFigure('uOutput', 'uOutputSub', t.output_tokens,
      covered('output_tokens') + '/' + (t.usage_requests || 0) + ' request có số');
    setFigure('uCacheWrite', 'uCacheWriteSub', t.cache_write_tokens,
      covered('cache_write_tokens') + '/' + (t.usage_requests || 0) + ' request có số · chỉ khi upstream trả');
    setFigure('uCacheRead', 'uCacheReadSub', t.cache_read_tokens,
      covered('cache_read_tokens') + '/' + (t.usage_requests || 0) + ' request có số');

    const range = data.range || {};
    el('usageUpdated').textContent = 'Cập nhật ' + localLabel(data.generatedAt_local);
    el('usageTz').textContent = data.timezone + ' (UTC' + data.timezone_offset + ')';
    el('usageRequests').textContent = (t.requests || 0) + ' request';
    el('usageMissing').textContent = (t.missing_usage || 0) + ' không có usage';

    const chips = [
      '<span class="chip">Từ <b>' + esc(localLabel(range.from_local)) + '</b></span>',
      '<span class="chip">Đến <b>' + esc(localLabel(range.to_local)) + '</b></span>',
      '<span class="chip">Tài khoản <b>' + esc(data.filters?.account || 'tất cả') + '</b></span>',
      '<span class="chip">Model <b>' + esc(data.filters?.model || 'tất cả') + '</b></span>',
      '<span class="chip">' + (data.filters?.include_non_chat ? 'mọi endpoint' : 'chỉ request chat') + '</span>',
      '<span class="chip">' + (data.detail_truncated ? 'chi tiết giới hạn 5.000 dòng gần nhất' : 'chi tiết đầy đủ') + '</span>',
    ];
    el('usageAppliedChips').innerHTML = chips.join('');

    el('usageTotals').textContent =
      'Tổng token (total_tokens do upstream trả): ' +
      (fmtCount(t.total_tokens) === null ? MISSING : fmtCount(t.total_tokens)) +
      ' · chỉ cộng khi upstream trả trường này; không tự tính input + output khi thiếu. ' +
      'Tổng hợp này tính trên đúng tập request ở bảng bên dưới.';

    // The single question a reader has about cache read is whether it is already
    // inside input. The upstream schema answers it per request; the aggregate
    // reports how many rows proved it rather than asserting a rule.
    const inside = t.cache_read_in_input || { true: 0, false: 0, unknown: 0 };
    const total = (inside.true || 0) + (inside.false || 0) + (inside.unknown || 0);
    const semantics = el('usageSemantics');
    if (!total) {
      semantics.innerHTML = '';
    } else {
      const share = (inside.true || 0) + '/' + total;
      const tone = inside.false ? 'dup' : inside.true === total ? '' : 'lookalike';
      const sentence = inside.false
        ? 'Có ' + inside.false + ' request mà upstream chứng minh cache read KHÔNG nằm trong input (cache read lớn hơn prompt_tokens).'
        : 'Upstream chứng minh input đã bao gồm cache read ở ' + share + ' request (prompt_cache_hit + prompt_cache_miss = prompt_tokens), nên cache read không bị cộng trùng.';
      semantics.innerHTML = '<p class="warn ' + tone + '">' + esc(sentence) +
        (inside.unknown ? ' ' + inside.unknown + ' request thiếu trường hit/miss nên không kết luận được.' : '') +
        '</p>';
    }

    el('usageByAccount').innerHTML = renderGroup(data.byAccount || [], 'account');
    el('usageByModel').innerHTML = renderGroup(data.byModel || []);

    window.currentRows = data.details || [];
    detailCount = data.detail_count || 0;
    pages = data.detail_pages || 1;
    currentPage = data.detail_page || 1;
    state.page = currentPage;
    el('usageDetailCount').textContent = detailCount + ' request';
    paintDetail();

    el('usageNotes').innerHTML = (data.notes || []).map(note => '<li>' + esc(note) + '</li>').join('');
    const fields = data.fields || {};
    const fieldNames = {
      input_tokens: 'Input', output_tokens: 'Output', cache_write_tokens: 'Cache write',
      cache_read_tokens: 'Cache read', total_tokens: 'Tổng',
    };
    el('usageFields').innerHTML = Object.entries(fields).map(([key, value]) =>
      '<tr><td>' + esc(fieldNames[key] || key) + '</td><td class="mono">' + esc(value) + '</td></tr>').join('');

    fillSelect('usageAccount', (data.byAccount || []).map(row => row.key).filter(key => key !== '(không rõ)'),
      key => labels[key] ? labels[key] + ' · ' + key : key);
    fillSelect('usageModel', (data.byModel || []).map(row => row.key).filter(key => key !== '(không rõ)'));
  }

  async function loadUsage() {
    await loadLabels();
    const params = new URLSearchParams();
    if (state.from) params.set('from', state.from);
    if (state.to) params.set('to', state.to);
    if (state.account) params.set('account', state.account);
    if (state.model) params.set('model', state.model);
    if (state.all) params.set('all', '1');
    params.set('page', String(state.page || 1));
    params.set('page_size', String(pageSizeFor()));
    try {
      const res = await fetch(base + '/api/usage?' + params, { cache: 'no-store' });
      if (res.status === 401) { location.reload(); return; }
      if (!res.ok) throw new Error();
      renderUsage(await res.json());
    } catch {
      el('usageUpdated').textContent = 'Chưa đọc được dữ liệu sử dụng';
    }
  }

  function setRange(days) {
    const now = Date.now();
    const start = days === 'today'
      ? Date.parse(new Date(now + 7 * 3600000).toISOString().slice(0, 10) + 'T00:00:00+07:00')
      : now - Number(days) * 86400000;
    state.from = localInput(start);
    state.to = localInput(now);
    el('usageFrom').value = state.from;
    el('usageTo').value = state.to;
    state.page = 1;
  }

  el('usageFilter').addEventListener('submit', event => {
    event.preventDefault();
    state.from = el('usageFrom').value || null;
    state.to = el('usageTo').value || null;
    state.account = el('usageAccount').value;
    state.model = el('usageModel').value;
    state.all = el('usageAll').checked;
    state.page = 1;
    void loadUsage();
  });
  el('usageToday').addEventListener('click', () => { setRange('today'); void loadUsage(); });
  el('usage7d').addEventListener('click', () => { setRange(7); void loadUsage(); });
  el('usage30d').addEventListener('click', () => { setRange(30); void loadUsage(); });

  setRange('today');
  void loadUsage();
  setInterval(() => { if (!document.hidden) void loadUsage(); }, 60000);
})();
