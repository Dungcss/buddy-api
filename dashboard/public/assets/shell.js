// Chrome behaviour shared by every page: mobile rail, theme persistence, and
// the two search boxes. Page logic lives in its own script and never touches
// these elements, so a page failure cannot take the navigation down.
(() => {
  const root = document.documentElement;
  const rail = document.getElementById('rail');
  const scrim = document.getElementById('railScrim');
  const toggle = document.getElementById('railToggle');

  function setRail(open) {
    if (!rail) return;
    rail.classList.toggle('open', open);
    if (scrim) scrim.hidden = !open;
    if (toggle) toggle.setAttribute('aria-expanded', open ? 'true' : 'false');
    // A fixed rail over content must not let the page scroll behind it.
    document.body.style.overflow = open ? 'hidden' : '';
  }
  toggle?.addEventListener('click', () => setRail(!rail.classList.contains('open')));
  scrim?.addEventListener('click', () => setRail(false));
  rail?.addEventListener('click', event => {
    if (event.target.closest('a') && window.matchMedia('(max-width: 860px)').matches) setRail(false);
  });

  const themeButton = document.getElementById('themeToggle');
  themeButton?.addEventListener('click', () => {
    const next = root.dataset.theme === 'dark' ? 'light' : 'dark';
    root.dataset.theme = next;
    try { localStorage.setItem('buddy-theme', next); } catch {}
  });

  // Rail filter: hide the links that do not match, and the group heading when
  // every link under it is hidden. Groups are siblings, so the heading is found
  // by walking back to the nearest .nav-group before the next match.
  const navSearch = document.getElementById('navSearch');
  const nav = document.getElementById('railNav');
  navSearch?.addEventListener('input', () => {
    const query = navSearch.value.trim().toLowerCase();
    let visibleInGroup = 0;
    for (const node of [...(nav?.children || [])]) {
      if (node.classList.contains('nav-group')) {
        // Decided after the links that follow it have been visited.
        node.dataset.pending = query ? '1' : '0';
        visibleInGroup = 0;
        continue;
      }
      const text = node.dataset.search || node.textContent.toLowerCase();
      const match = !query || text.includes(query);
      node.hidden = !match;
      if (match) visibleInGroup++;
      const group = node.previousElementSibling;
      if (group?.classList.contains('nav-group')) group.hidden = query ? visibleInGroup === 0 : false;
    }
  });

  // "/" focuses page search, Escape clears it — the same shortcut the reference
  // console advertises in its header.
  const pageSearch = document.getElementById('pageSearch');
  document.addEventListener('keydown', event => {
    if (event.key === '/' && !/^(INPUT|TEXTAREA|SELECT)$/.test(event.target.tagName)) {
      if (pageSearch && pageSearch.offsetParent !== null) { event.preventDefault(); pageSearch.focus(); }
    }
    if (event.key === 'Escape') {
      if (rail?.classList.contains('open')) setRail(false);
      if (pageSearch && document.activeElement === pageSearch) { pageSearch.value = ''; pageSearch.dispatchEvent(new Event('input')); }
    }
  });

  // Page search filters table rows by their text. It is deliberately a filter,
  // not a jump: nothing scrolls away under the pointer.
  pageSearch?.addEventListener('input', () => {
    const query = pageSearch.value.trim().toLowerCase();
    for (const table of document.querySelectorAll('main table')) {
      let shown = 0;
      for (const row of table.tBodies[0]?.rows || []) {
        if (row.dataset.always) continue;
        const match = !query || row.textContent.toLowerCase().includes(query);
        row.hidden = !match;
        if (match) shown++;
      }
      const empty = table.parentElement?.querySelector('.filter-empty');
      if (empty) empty.hidden = shown > 0;
    }
  });

  // Gateway status is the one thing every page should show: an operator reading
  // the model catalog still needs to know the upstream is answering.
  const status = document.getElementById('status');
  async function ping() {
    if (!status) return;
    try {
      const res = await fetch((document.body.dataset.base || '') + '/api/ping', { cache: 'no-store' });
      if (!res.ok) throw new Error();
      const data = await res.json();
      const healthy = data.gateway === 'ok';
      status.className = 'status ' + (healthy ? 'ok' : 'bad');
      status.querySelector('span').textContent = healthy ? 'gateway hoạt động' : 'gateway ' + data.gateway;
    } catch {
      status.className = 'status bad';
      status.querySelector('span').textContent = 'mất kết nối';
    }
  }
  ping();
  setInterval(() => { if (!document.hidden) ping(); }, 60000);
})();
