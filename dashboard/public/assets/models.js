// Model catalog. Everything shown comes from /dashboard/api/models, which in
// turn reads the gateway's live /v1/models. Nothing here infers a price, a
// context window or a capability.
(() => {
  const base = document.body.dataset.base || '';
  const el = id => document.getElementById(id);
  const esc = value => String(value ?? '').replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
  const fmtTokens = value => {
    if (typeof value !== 'number' || !Number.isFinite(value)) return '—';
    return value >= 1000000 ? (value / 1000000).toFixed(value % 1000000 ? 1 : 0) + 'M'
      : value >= 1000 ? Math.round(value / 1000) + 'K' : String(value);
  };
  const localLabel = iso => {
    const ms = Date.parse(iso);
    return Number.isFinite(ms) ? new Date(ms + 7 * 3600000).toISOString().slice(0, 19).replace('T', ' ') : '—';
  };

  let catalog = { free: [], paid: [], notes: [] };
  const columns = { context: true, output: true, price: true, caps: true };
  const state = { query: '', type: '', context: 0 };

  function capsOf(model) {
    const caps = [];
    if (model.supportsImages) caps.push('Ảnh');
    if (model.reasoning?.supports) caps.push('Suy luận');
    if (model.reasoning?.only_reasoning) caps.push('Chỉ suy luận');
    if (model.reasoning?.can_disable_thinking) caps.push('Tắt thinking');
    if (model.supportsTools) caps.push('Tool');
    return caps;
  }

  function matches(model, free) {
    if (state.type === 'free' && !free) return false;
    if (state.type === 'paid' && free) return false;
    if (state.context && (model.maxContextWindow || 0) < state.context) return false;
    if (!state.query) return true;
    const haystack = [model.id, model.name, model.credits, ...capsOf(model)].join(' ').toLowerCase();
    return haystack.includes(state.query);
  }

  function row(model, free) {
    const caps = capsOf(model);
    return '<tr>' +
      '<td><b>' + esc(model.name) + '</b><br><span class="model-id">' + esc(model.id) + '</span></td>' +
      '<td class="' + (free ? 'ok-text' : 'muted') + '">' + (free ? 'miễn phí' : 'trả phí') + '</td>' +
      '<td class="right num" data-col="context">' + fmtTokens(model.maxContextWindow) + '</td>' +
      '<td class="right num" data-col="output">' + fmtTokens(model.maxOutputTokens) + '</td>' +
      '<td class="right" data-col="price">' + (free ? 'x0.00' : esc(model.credits || 'không rõ')) + '</td>' +
      '<td data-col="caps"><span class="cap">' + (caps.length ? caps.map(cap => '<span>' + esc(cap) + '</span>').join('') : '<span>—</span>') + '</span></td>' +
      '</tr>';
  }

  function paint() {
    const free = catalog.free.filter(model => matches(model, true));
    const paid = catalog.paid.filter(model => matches(model, false));
    // Two groups inside one table: the heading row keeps the free/paid split the
    // operator asked for, while the columns stay wide enough to read on a phone.
    const group = (label, count, tone) =>
      '<tr class="group-row" data-always="1"><td colspan="6"><span class="chip ' + tone + '">' +
      esc(label) + ' · ' + count + '</span></td></tr>';
    const rows = [];
    if (free.length) rows.push(group('Miễn phí', free.length, 'ok'), ...free.map(model => row(model, true)));
    if (paid.length) rows.push(group('Trả phí', paid.length, 'warn'), ...paid.map(model => row(model, false)));
    el('modelRows').innerHTML = rows.length ? rows.join('')
      : '<tr data-always="1"><td colspan="6" class="empty">Không có model nào khớp bộ lọc.</td></tr>';
    el('modelShown').textContent = (free.length + paid.length) + ' / ' + (catalog.free.length + catalog.paid.length) + ' model';

    // Column visibility is a class on the tables, not inline styles, so the
    // header and body cells cannot get out of sync.
    for (const table of document.querySelectorAll('.model-table')) {
      for (const key of Object.keys(columns)) table.classList.toggle('hide-' + key, !columns[key]);
    }
  }

  async function load() {
    el('modelsRefresh').disabled = true;
    try {
      const res = await fetch(base + '/api/models', { cache: 'no-store' });
      if (res.status === 401) { location.reload(); return; }
      if (!res.ok) throw new Error();
      catalog = await res.json();
      const total = (catalog.free?.length || 0) + (catalog.paid?.length || 0);
      el('modelTotal').textContent = total + ' model · đọc lúc ' + localLabel(catalog.generatedAt);
      el('modelFreeChip').textContent = (catalog.free?.length || 0) + ' miễn phí';
      el('modelPaidChip').textContent = (catalog.paid?.length || 0) + ' trả phí';
      el('modelNotes').innerHTML = (catalog.notes || []).map(note => '<li>' + esc(note) + '</li>').join('');
      paint();
    } catch {
      el('modelTotal').textContent = 'Chưa đọc được catalog. Kiểm tra cổng rồi bấm Làm mới.';
    } finally {
      el('modelsRefresh').disabled = false;
    }
  }

  el('modelsRefresh').addEventListener('click', load);
  el('modelSearch').addEventListener('input', event => { state.query = event.target.value.trim().toLowerCase(); paint(); });
  el('modelType').addEventListener('change', event => { state.type = event.target.value; paint(); });
  el('modelContext').addEventListener('change', event => { state.context = Number(event.target.value) || 0; paint(); });

  document.getElementById('modelColumns').addEventListener('click', event => {
    const button = event.target.closest('button[data-col]');
    if (!button) return;
    const key = button.dataset.col;
    columns[key] = !columns[key];
    button.setAttribute('aria-pressed', columns[key] ? 'true' : 'false');
    button.classList.toggle('ok', columns[key]);
    paint();
  });

  load();
})();
