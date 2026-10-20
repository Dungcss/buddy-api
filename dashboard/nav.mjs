// Sidebar navigation shared by the release builder and the server. Keeping the
// list in one module means a new page cannot appear in one place only.
export const NAV = [
  { group: null, items: [
    { href: '/', label: 'Tổng quan', hint: 'Nhịp hoạt động', icon: 'home' },
  ] },
  { group: 'CỔNG', items: [
    { href: '/models', label: 'Danh mục model', hint: 'Miễn phí và trả phí', icon: 'layers' },
    { href: '/accounts', label: 'Tài khoản', hint: 'WorkBuddy đang nối', icon: 'users' },
    { href: '/keys', label: 'Khóa API', hint: 'Tạo, thu hồi, theo dõi', icon: 'key' },
  ] },
  { group: 'PHÂN TÍCH', items: [
    { href: '/usage', label: 'Sử dụng token', hint: 'Theo tài khoản, model', icon: 'chart' },
    { href: '/logs', label: 'Nhật ký request', hint: 'Từng lần gọi upstream', icon: 'list' },
  ] },
];

const ICONS = {
  home: '<path d="M3 10.5 12 3l9 7.5"/><path d="M5.5 9.5V21h13V9.5"/>',
  layers: '<path d="m12 3 9 5-9 5-9-5 9-5Z"/><path d="m3 13 9 5 9-5"/>',
  users: '<circle cx="9" cy="8" r="3.2"/><path d="M3 20c0-3.3 2.7-5.4 6-5.4s6 2.1 6 5.4"/><path d="M16 5.2a3.2 3.2 0 0 1 0 6"/><path d="M18 20c0-2.4-.8-4-2-5"/>',
  key: '<circle cx="8" cy="8" r="4.2"/><path d="m11 11 9 9"/><path d="m16 16 2.5-2.5"/><path d="m18.5 18.5 2-2"/>',
  chart: '<path d="M4 20V6"/><path d="M4 20h16"/><path d="m7.5 15 3.5-4 3 2.5L20 7"/>',
  list: '<path d="M8 6h13"/><path d="M8 12h13"/><path d="M8 18h13"/><path d="M3.5 6h.01"/><path d="M3.5 12h.01"/><path d="M3.5 18h.01"/>',
};

const esc = value => String(value ?? '').replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));

export function navMarkup(active) {
  return NAV.map(section => {
    const items = section.items.map(item => {
      const current = item.href === active;
      return '<a class="nav-item' + (current ? ' current' : '') + '" href="__BASE__' + esc(item.href) + '"' +
        (current ? ' aria-current="page"' : '') + ' data-search="' + esc((item.label + ' ' + item.hint).toLowerCase()) + '">' +
        '<svg class="nav-icon" viewBox="0 0 24 24" aria-hidden="true">' + (ICONS[item.icon] || '') + '</svg>' +
        '<span><b>' + esc(item.label) + '</b><small>' + esc(item.hint) + '</small></span></a>';
    }).join('');
    return (section.group ? '<p class="nav-group">' + esc(section.group) + '</p>' : '') + items;
  }).join('');
}

// `fragment` is the source file in dashboard/pages/; `file` is the generated
// document in dashboard/public/ that the server actually serves.
export const PAGE_META = {
  '/': { file: 'index.html', fragment: 'overview.html', title: 'Tổng quan', crumb: 'Tổng quan', script: 'app.js' },
  '/models': { file: 'models.html', fragment: 'models.html', title: 'Danh mục model', crumb: 'Danh mục model', script: 'models.js' },
  '/accounts': { file: 'accounts.html', fragment: 'accounts.html', title: 'Tài khoản', crumb: 'Tài khoản', script: 'accounts.js' },
  '/keys': { file: 'keys.html', fragment: 'keys.html', title: 'Khóa API', crumb: 'Khóa API', script: 'keys.js' },
  '/usage': { file: 'usage.html', fragment: 'usage.html', title: 'Sử dụng token', crumb: 'Sử dụng token', script: 'usage.js' },
  '/logs': { file: 'logs.html', fragment: 'logs.html', title: 'Nhật ký request', crumb: 'Nhật ký request', script: 'logs.js' },
};
