// Document shell: one sidebar, one sticky header, one content column. Pages are
// content fragments in dashboard/pages/, expanded here by build-pages.mjs so the
// chrome cannot drift between pages.
import { navMarkup, PAGE_META } from './nav.mjs';

const esc = value => String(value ?? '').replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));

const ICON = {
  menu: '<path d="M4 7h16"/><path d="M4 12h16"/><path d="M4 17h16"/>',
  sun: '<circle cx="12" cy="12" r="4"/><path d="M12 2v2"/><path d="M12 20v2"/><path d="m4.9 4.9 1.4 1.4"/><path d="m17.7 17.7 1.4 1.4"/><path d="M2 12h2"/><path d="M20 12h2"/><path d="m4.9 19.1 1.4-1.4"/><path d="m17.7 6.3 1.4-1.4"/>',
  moon: '<path d="M20 14.5A8.5 8.5 0 0 1 9.5 4a7 7 0 1 0 10.5 10.5Z"/>',
  search: '<circle cx="11" cy="11" r="7"/><path d="m20 20-3.5-3.5"/>',
};

// __BASE__ and __VERSION__ stay as placeholders: the server substitutes them
// per request, so the same built file works under /dashboard and at the root.
export function renderDocument(route, fragment) {
  const meta = PAGE_META[route];
  return `<!doctype html>
<html lang="vi" data-theme="light">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<meta name="color-scheme" content="light dark">
<title>${esc(meta.title)} · Buddy</title>
<link rel="icon" href="data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 32 32'%3E%3Crect width='32' height='32' rx='9' fill='%23e54d5e'/%3E%3Ctext x='16' y='22' font-family='system-ui' font-size='18' font-weight='700' fill='white' text-anchor='middle'%3EB%3C/text%3E%3C/svg%3E">
<link rel="stylesheet" href="__BASE__/assets/app.css?v=__VERSION__">
<script>(function(){try{var t=localStorage.getItem('buddy-theme');if(t==='dark'||t==='light')document.documentElement.dataset.theme=t;}catch(e){}})();</script>
</head>
<body data-base="__BASE__" data-page="${esc(meta.fragment.replace('.html', ''))}">
<div class="app">
  <aside class="rail" id="rail" aria-label="Điều hướng">
    <div class="rail-head">
      <span class="logo" aria-hidden="true">B</span>
      <span class="rail-title"><b>Buddy</b><small>API gateway</small></span>
    </div>
    <label class="rail-search">
      <svg viewBox="0 0 24 24" aria-hidden="true">${ICON.search}</svg>
      <input id="navSearch" type="search" placeholder="Tìm mục…" autocomplete="off" aria-label="Tìm mục điều hướng">
    </label>
    <nav class="rail-nav" id="railNav">${navMarkup(route)}</nav>
    <div class="rail-foot">
      <p class="status" id="status"><i aria-hidden="true"></i><span>đang kết nối</span></p>
      <a class="rail-link" href="__BASE__/logout">Đăng xuất</a>
    </div>
  </aside>
  <div class="rail-scrim" id="railScrim" hidden></div>
  <div class="main">
    <header class="topbar">
      <button type="button" class="icon-btn only-mobile" id="railToggle" aria-label="Mở điều hướng" aria-expanded="false">
        <svg viewBox="0 0 24 24" aria-hidden="true">${ICON.menu}</svg>
      </button>
      <div class="topbar-title">
        <span class="crumb">Buddy / ${esc(meta.crumb)}</span>
        <h1>${esc(meta.title)}</h1>
      </div>
      <label class="topbar-search">
        <svg viewBox="0 0 24 24" aria-hidden="true">${ICON.search}</svg>
        <input id="pageSearch" type="search" placeholder="Tìm trong trang…" autocomplete="off" aria-label="Tìm trong trang">
        <kbd>/</kbd>
      </label>
      <button type="button" class="icon-btn" id="themeToggle" aria-label="Đổi giao diện sáng/tối" title="Đổi giao diện sáng/tối">
        <svg class="icon-sun" viewBox="0 0 24 24" aria-hidden="true">${ICON.sun}</svg>
        <svg class="icon-moon" viewBox="0 0 24 24" aria-hidden="true">${ICON.moon}</svg>
      </button>
    </header>
    <main class="content" id="content">
${fragment}
    </main>
  </div>
</div>
<script src="__BASE__/assets/shell.js?v=__VERSION__" defer></script>
<script src="__BASE__/assets/${esc(meta.script)}?v=__VERSION__" defer></script>
</body>
</html>
`;
}
