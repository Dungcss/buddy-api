// Overview page. Every figure comes from the gateway's own access log; the
// three outcome classes (ok / saturated / failed) are computed on the server so
// this file never re-derives them differently.
(() => {
  const base = document.body.dataset.base || '';
  const el = id => document.getElementById(id);
  const fmt = value => value === null || value === undefined ? '–' : Number(value).toLocaleString('vi-VN');
  const ms = value => value === null || value === undefined ? '–' : String(Math.round(Number(value)));
  const text = value => String(value ?? '').replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
  const localTime = iso => {
    if (!iso) return '–';
    const t = Date.parse(iso);
    if (!Number.isFinite(t)) return '–';
    // Fixed +07:00: Asia/Saigon has no DST, so no Intl lookup is needed.
    return new Date(t + 7 * 3600000).toISOString().slice(11, 19);
  };

  let minutes = [];
  let chartMax = 1;

  function drawChart(values) {
    minutes = values;
    const svg = el('chartSvg');
    if (!svg) return;
    const W = 720, H = 180, pad = 10;
    chartMax = Math.max(1, ...values);
    const step = (W - pad * 2) / Math.max(1, values.length - 1);
    const points = values.map((v, i) => [pad + i * step, H - pad - (v / chartMax) * (H - pad * 2)]);
    const line = points.map((p, i) => (i ? 'L' : 'M') + p[0].toFixed(1) + ' ' + p[1].toFixed(1)).join(' ');
    const area = line + ' L ' + (W - pad) + ' ' + (H - pad) + ' L ' + pad + ' ' + (H - pad) + ' Z';
    svg.innerHTML =
      '<defs><linearGradient id="fill" x1="0" y1="0" x2="0" y2="1">' +
      '<stop offset="0%" stop-color="#6366f1" stop-opacity=".26"/>' +
      '<stop offset="100%" stop-color="#6366f1" stop-opacity="0"/></linearGradient></defs>' +
      '<path d="' + area + '" fill="url(#fill)"></path>' +
      '<path d="' + line + '" fill="none" stroke="#6366f1" stroke-width="2" stroke-linejoin="round"></path>' +
      '<line id="cursor" x1="0" y1="0" x2="0" y2="' + H + '" stroke="#e54d5e" stroke-width="1" opacity="0"></line>' +
      '<circle id="dot" r="3.5" fill="#e54d5e" opacity="0"></circle>';
    if (el('chartPeak')) el('chartPeak').textContent = 'cao nhất ' + chartMax + ' request/phút';
  }

  function hoverChart(event) {
    const svg = el('chartSvg');
    const cursor = el('cursor');
    const dot = el('dot');
    if (!cursor || !dot || !minutes.length) return;
    const box = svg.getBoundingClientRect();
    const ratio = Math.min(1, Math.max(0, (event.clientX - box.left) / box.width));
    const index = Math.round(ratio * (minutes.length - 1));
    const x = 10 + index * ((720 - 20) / Math.max(1, minutes.length - 1));
    const y = 180 - 10 - (minutes[index] / chartMax) * (180 - 20);
    cursor.setAttribute('x1', x); cursor.setAttribute('x2', x); cursor.setAttribute('opacity', '0.5');
    dot.setAttribute('cx', x); dot.setAttribute('cy', y); dot.setAttribute('opacity', '1');
    const when = new Date(Date.now() - (minutes.length - 1 - index) * 60000);
    el('chartNote').textContent = when.toLocaleTimeString('vi-VN', { hour: '2-digit', minute: '2-digit' }) +
      ' · ' + minutes[index] + ' request';
  }

  function clearChart() {
    el('cursor')?.setAttribute('opacity', '0');
    el('dot')?.setAttribute('opacity', '0');
    const note = el('chartNote');
    if (note) note.textContent = '60 phút gần nhất · cao nhất ' + chartMax + ' request/phút';
  }

  function renderDays(allDays) {
    const days = allDays.filter(day => day.requests > 0);
    const list = el('days');
    if (!days.length) {
      list.innerHTML = '<li class="empty" data-always="1">Chưa có ngày nào có request.</li>';
      return;
    }
    const peak = Math.max(1, ...days.map(d => d.requests));
    list.innerHTML = days.map(day => {
      const width = Math.round((day.requests / peak) * 100);
      const errors = day.requests ? Math.round((day.failures / day.requests) * width) : 0;
      const saturated = day.saturated || 0;
      return '<li><span class="day">' + text(day.day) + '</span>' +
        '<span class="track"><span style="width:' + width + '%"><i style="width:' + errors + '%"></i></span></span>' +
        '<span class="n">' + fmt(day.requests) + '</span>' +
        '<span class="soft">' +
        (day.failures ? fmt(day.failures) + ' lỗi' : '—') +
        (saturated ? ' · ' + fmt(saturated) + ' nghẽn' : '') +
        '</span></li>';
    }).join('');
  }

  function renderList(target, entries) {
    const rows = Object.entries(entries).sort((a, b) => b[1] - a[1]);
    target.innerHTML = rows.length
      ? rows.map(([key, value]) => '<dt><code>' + text(key) + '</code></dt><dd>' + fmt(value) + '</dd>').join('')
      : '<dt class="empty">chưa có dữ liệu</dt><dd></dd>';
  }

  function renderRecent(rows) {
    const body = el('recent');
    if (!rows.length) {
      body.innerHTML = '<tr data-always="1"><td colspan="7" class="empty">Hôm nay chưa có request nào.</td></tr>';
      return;
    }
    body.innerHTML = rows.map(row =>
      '<tr tabindex="0" data-id="' + text(row.id) + '">' +
      '<td class="num">' + localTime(row.at) + '</td>' +
      '<td>' + text(row.key || '—') + '</td>' +
      '<td class="mono">' + text(row.path) + '</td>' +
      '<td>' + text(row.model || '—') + '</td>' +
      '<td class="right"><span class="status-pill ' + (row.status >= 400 ? 'bad' : '') + '">' + row.status + '</span></td>' +
      '<td class="right num">' + ms(row.ms) + '</td>' +
      '<td class="mono">' + text((row.id || '').slice(0, 8)) + '</td></tr>').join('');
  }

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
    const sheet = el('sheet');
    sheet.classList.remove('open');
    sheet.setAttribute('aria-hidden', 'true');
  }

  async function tick() {
    try {
      const res = await fetch(base + '/api/data', { cache: 'no-store' });
      if (res.status === 401) { location.reload(); return; }
      const data = await res.json();
      const today = data.today;
      el('requests').textContent = fmt(today.requests);
      el('errorRate').textContent = today.errorRate + '%';
      el('saturatedRate').textContent = (today.saturatedRate ?? 0) + '%';
      el('p50').textContent = ms(today.p50);
      el('p95').textContent = ms(today.p95);
      const admission = (data.gateway.status || {}).admission;
      el('active').textContent = admission ? admission.active + '/' + admission.concurrency : '–';
      el('errorSub').textContent = fmt(today.failures) + ' lỗi thật hôm nay';
      el('saturatedSub').textContent = fmt(today.saturated) + ' request bị nghẽn';
      el('overviewUpdated').textContent = 'Cập nhật ' + localTime(data.generatedAt) + ' · giờ Việt Nam';

      drawChart(today.perMinute);
      clearChart();
      renderDays(data.daily);
      const ok = data.daily.reduce((sum, day) => sum + (day.requests - day.failures - day.saturated), 0);
      const bad = data.daily.reduce((sum, day) => sum + day.failures, 0);
      el('daysOk').textContent = '14 ngày: ' + fmt(ok) + ' thành công';
      el('daysBad').textContent = fmt(bad) + ' lỗi thật';
      renderList(el('codes'), today.byCode);
      renderList(el('keys'), today.byKey);

      const upstream = (data.gateway.status || {}).upstream || {};
      el('upstream').textContent = data.models.length + ' model đang phục vụ · ' +
        (upstream.signedIn ? 'đã đăng nhập upstream' : 'chưa đăng nhập upstream') +
        (data.gateway.status && data.gateway.status.catalog_warm ? ' · bảng giá sẵn sàng' : ' · bảng giá đang nguội') +
        (upstream.dependencyVersion ? ' · phụ thuộc ' + upstream.dependencyVersion : '');

      const recent = data.recent.filter(row => row && row.at)
        .sort((a, b) => (a.at < b.at ? 1 : a.at > b.at ? -1 : 0));
      el('recentCount').textContent = recent.length + ' dòng';
      renderRecent(recent);
    } catch {
      el('overviewUpdated').textContent = 'Chưa đọc được số liệu';
    }
  }

  el('chart')?.addEventListener('mousemove', hoverChart);
  el('chart')?.addEventListener('mouseleave', clearChart);
  document.addEventListener('click', event => {
    const row = event.target.closest('tr[data-id]');
    if (row) openSheet(row.dataset.id);
  });
  document.addEventListener('keydown', event => {
    if (event.key === 'Escape') closeSheet();
    const row = event.target.closest && event.target.closest('tr[data-id]');
    if (row && (event.key === 'Enter' || event.key === ' ')) { event.preventDefault(); openSheet(row.dataset.id); }
  });
  el('sheetClose')?.addEventListener('click', closeSheet);

  tick();
  setInterval(tick, 60000);
})();
