const API = '/api';
let currentPage = 'dashboard';
const LAST_PAGE_KEY = 'netadmin_lastPage';

// Clock — forces Asia/Ho_Chi_Minh display regardless of the viewer's own browser timezone, same
// reasoning as formatTime()/toVNDate() below (this app's data is all Vietnam-local).
function updateClock() {
  const now = new Date();
  document.getElementById('clock').textContent = now.toLocaleTimeString('vi-VN', { timeZone: 'Asia/Ho_Chi_Minh' });
}
setInterval(updateClock, 1000);
updateClock();

// Toast
function toast(msg, type = 'success') {
  const icons = { success: '✓', error: '✗', info: 'ℹ' };
  const el = document.createElement('div');
  el.className = `toast ${type}`;
  el.innerHTML = `<span>${icons[type]}</span><span>${msg}</span>`;
  document.getElementById('toastContainer').appendChild(el);
  setTimeout(() => el.remove(), 4000);
}

// Modal
function openModal(title, bodyHTML, extraClass) {
  document.getElementById('modalTitle').textContent = title;
  document.getElementById('modalBody').innerHTML = bodyHTML;
  document.getElementById('modalOverlay').classList.add('open');
  if (extraClass) document.getElementById('modal').classList.add(extraClass);
}
function closeModal() {
  document.getElementById('modalOverlay').classList.remove('open');
  // Strip size-variant classes so the next openModal() call (a normal create/edit form) isn't
  // left wider than intended — only detail-modal exists today, but written to tolerate more.
  document.getElementById('modal').classList.remove('detail-modal');
}
document.getElementById('modalClose').onclick = closeModal;
document.getElementById('modalOverlay').onclick = (e) => { if (e.target.id === 'modalOverlay') closeModal(); };

// VM Console (WebMKS) — jquery/jquery-ui/wmks are only loaded the first time a console is opened
let wmksAssetsPromise = null;
let wmksInstance = null;
let currentConsoleVmName = '';

function loadScript(src) {
  return new Promise((resolve, reject) => {
    const s = document.createElement('script');
    s.src = src; s.onload = resolve; s.onerror = () => reject(new Error(`Không tải được ${src}`));
    document.head.appendChild(s);
  });
}
function loadStyle(href) {
  const l = document.createElement('link');
  l.rel = 'stylesheet'; l.href = href;
  document.head.appendChild(l);
}
function loadWmksAssets() {
  if (!wmksAssetsPromise) {
    loadStyle('vendor/jquery-ui/jquery-ui.min.css');
    wmksAssetsPromise = loadScript('vendor/jquery/jquery.min.js')
      .then(() => loadScript('vendor/jquery-ui/jquery-ui.min.js'))
      .then(() => loadScript('vendor/wmks/wmks.js'));
  }
  return wmksAssetsPromise;
}

async function openVmConsole(id, name) {
  // Guard against opening a new console while a previous one (e.g. minimized) is still connected —
  // same stale-widget issue as closeConsole handles, triggered a different way.
  if (wmksInstance) { try { wmksInstance.disconnect(); } catch {} wmksInstance = null; resetWmksContainer(); }
  currentConsoleVmName = name;
  document.getElementById('consoleTitle').textContent = `Console — ${name}`;
  document.getElementById('consoleMinPillLabel').textContent = name;
  document.getElementById('wmksContainer').innerHTML = `<div class="loading" style="height:100%;color:#fff"><div class="spinner"></div> Đang kết nối console...</div>`;
  document.getElementById('consoleOverlay').classList.remove('minimized');
  document.getElementById('consoleMinPill').style.display = 'none';
  document.getElementById('consoleOverlay').classList.add('open');
  try {
    const [, { ticket }] = await Promise.all([loadWmksAssets(), api(`/vcenter/vms/${id}/console`, 'POST')]);
    document.getElementById('wmksContainer').innerHTML = '';
    wmksInstance = WMKS.createWMKS('wmksContainer', { changeResolution: true, rescale: true })
      .register(WMKS.CONST.Events.ERROR, (e, data) => {
        console.error('WMKS error:', data);
        toast(`Console lỗi: ${data?.error || data?.errorType || JSON.stringify(data) || 'unknown'}`, 'error');
      })
      .register(WMKS.CONST.Events.CONNECTION_STATE_CHANGE, (e, data) => {
        if (data.state === WMKS.CONST.ConnectionState.DISCONNECTED) toast('Console đã ngắt kết nối', 'info');
      });
    wmksInstance.connect(ticket);
  } catch (e) {
    document.getElementById('wmksContainer').innerHTML = `<div class="empty-state" style="color:#fff"><h3>Không mở được console</h3><p>${e.message}</p></div>`;
  }
}

// WMKS is a jQuery UI widget (registered as "nwmks") — it attaches instance data directly to the
// #wmksContainer DOM node. Clearing innerHTML doesn't remove that data, so calling createWMKS again
// on the same node reuses the old (disconnected) widget instead of starting fresh — the guest screen
// then stays blank on the 2nd+ open. Swapping in a brand-new node sidesteps this entirely.
function resetWmksContainer() {
  const old = document.getElementById('wmksContainer');
  const fresh = document.createElement('div');
  fresh.id = 'wmksContainer';
  fresh.style.cssText = old.style.cssText;
  old.replaceWith(fresh);
}

function closeConsole() {
  document.getElementById('consoleOverlay').classList.remove('open', 'minimized');
  document.getElementById('consoleModal').classList.remove('maximized');
  document.getElementById('consoleMinPill').style.display = 'none';
  if (wmksInstance) { try { wmksInstance.disconnect(); } catch {} wmksInstance = null; }
  resetWmksContainer();
  document.getElementById('consoleKeyboard').style.display = 'none';
  vkActiveModifiers.clear();
}
document.getElementById('consoleClose').onclick = closeConsole;
document.getElementById('consoleOverlay').onclick = (e) => { if (e.target.id === 'consoleOverlay') closeConsole(); };

// Minimize keeps the WMKS connection alive in the background (unlike close, which disconnects) —
// visibility:hidden rather than display:none so the canvas keeps real dimensions for its render loop.
function minimizeConsole() {
  document.getElementById('consoleOverlay').classList.add('minimized');
  document.getElementById('consoleMinPill').style.display = 'flex';
}
function restoreConsole() {
  document.getElementById('consoleOverlay').classList.remove('minimized');
  document.getElementById('consoleMinPill').style.display = 'none';
  if (wmksInstance) setTimeout(() => wmksInstance.rescale(), 50);
}
function toggleMaximizeConsole() {
  const modal = document.getElementById('consoleModal');
  modal.classList.toggle('maximized');
  document.getElementById('consoleMaximize').innerHTML = modal.classList.contains('maximized') ? '&#9635;' : '&#9723;';
  // The container's CSS size changed but no native window resize event fired — WMKS won't know
  // to rescale on its own, so trigger it manually once the browser has laid out the new size.
  if (wmksInstance) setTimeout(() => wmksInstance.rescale(), 50);
}
document.getElementById('consoleMinimize').onclick = minimizeConsole;
document.getElementById('consoleMaximize').onclick = toggleMaximizeConsole;

// On-screen key combos for keys the OS/browser intercepts (Ctrl+Alt+Del, Alt+Tab, Win, Esc, F-keys).
// keys = standard DOM keyCodes, vscan = PS/2 Set 1 scan codes (extended keys use 0x100 + base, matching sendCAD's own [17,18,46]/[29,56,339]).
const VM_KEY_COMBOS = {
  altTab: { keys: [18, 9], vscan: [56, 15] },
  ctrlEsc: { keys: [17, 27], vscan: [29, 1] },
  winKey: { keys: [91], vscan: [347] },
  esc: { keys: [27], vscan: [1] }
};
const F_KEY_VSCAN = [59, 60, 61, 62, 63, 64, 65, 66, 67, 68, 87, 88];

function sendVmKeyCombo(name) {
  if (!wmksInstance) return;
  if (name === 'cad') { wmksInstance.sendCAD(); return; }
  const combo = VM_KEY_COMBOS[name];
  if (combo) wmksInstance.sendKeyCodes(combo.keys, combo.vscan);
}

function sendVmFKey(n) {
  if (!wmksInstance || !n) return;
  const i = Number(n) - 1;
  wmksInstance.sendKeyCodes([112 + i], [F_KEY_VSCAN[i]]);
}

// ── Full virtual keyboard (standard US 104-key layout) ──
// { k: DOM keyCode, v: PS/2 Set 1 scan code }. Extended keys (nav cluster, right-side modifiers,
// Windows/Menu, numpad Enter/Divide) use 0x100 + base scan code for their E0 prefix — the same
// convention verified against the library's own sendCAD() (Delete = 0x100+0x53 = 339).
const VK_MAP = {
  '`': { k: 192, v: 41 }, '1': { k: 49, v: 2 }, '2': { k: 50, v: 3 }, '3': { k: 51, v: 4 }, '4': { k: 52, v: 5 }, '5': { k: 53, v: 6 },
  '6': { k: 54, v: 7 }, '7': { k: 55, v: 8 }, '8': { k: 56, v: 9 }, '9': { k: 57, v: 10 }, '0': { k: 48, v: 11 },
  '-': { k: 189, v: 12 }, '=': { k: 187, v: 13 },
  'q': { k: 81, v: 16 }, 'w': { k: 87, v: 17 }, 'e': { k: 69, v: 18 }, 'r': { k: 82, v: 19 }, 't': { k: 84, v: 20 },
  'y': { k: 89, v: 21 }, 'u': { k: 85, v: 22 }, 'i': { k: 73, v: 23 }, 'o': { k: 79, v: 24 }, 'p': { k: 80, v: 25 },
  '[': { k: 219, v: 26 }, ']': { k: 221, v: 27 }, '\\': { k: 220, v: 43 },
  'a': { k: 65, v: 30 }, 's': { k: 83, v: 31 }, 'd': { k: 68, v: 32 }, 'f': { k: 70, v: 33 }, 'g': { k: 71, v: 34 },
  'h': { k: 72, v: 35 }, 'j': { k: 74, v: 36 }, 'k': { k: 75, v: 37 }, 'l': { k: 76, v: 38 },
  ';': { k: 186, v: 39 }, "'": { k: 222, v: 40 },
  'z': { k: 90, v: 44 }, 'x': { k: 88, v: 45 }, 'c': { k: 67, v: 46 }, 'v': { k: 86, v: 47 }, 'b': { k: 66, v: 48 },
  'n': { k: 78, v: 49 }, 'm': { k: 77, v: 50 }, ',': { k: 188, v: 51 }, '.': { k: 190, v: 52 }, '/': { k: 191, v: 53 },
  tab: { k: 9, v: 15 }, capslock: { k: 20, v: 58 }, backspace: { k: 8, v: 14 }, enter: { k: 13, v: 28 }, space: { k: 32, v: 57 }, esc: { k: 27, v: 1 },
  shiftl: { k: 16, v: 42 }, shiftr: { k: 16, v: 54 }, ctrll: { k: 17, v: 29 }, ctrlr: { k: 17, v: 285 }, altl: { k: 18, v: 56 }, altr: { k: 18, v: 312 },
  winl: { k: 91, v: 347 }, winr: { k: 92, v: 348 }, menu: { k: 93, v: 349 },
  left: { k: 37, v: 331 }, up: { k: 38, v: 328 }, right: { k: 39, v: 333 }, down: { k: 40, v: 336 },
  insert: { k: 45, v: 338 }, home: { k: 36, v: 327 }, pageup: { k: 33, v: 329 },
  delete: { k: 46, v: 339 }, end: { k: 35, v: 335 }, pagedown: { k: 34, v: 337 },
  prtsc: { k: 44, v: 311 }, scrlk: { k: 145, v: 70 }, pause: { k: 19, v: 256 },
  numlock: { k: 144, v: 69 }, numdiv: { k: 111, v: 309 }, nummul: { k: 106, v: 55 }, numsub: { k: 109, v: 74 }, numadd: { k: 107, v: 78 }, numenter: { k: 13, v: 284 }, numdec: { k: 110, v: 83 },
  num0: { k: 96, v: 82 }, num1: { k: 97, v: 79 }, num2: { k: 98, v: 80 }, num3: { k: 99, v: 81 }, num4: { k: 100, v: 75 },
  num5: { k: 101, v: 76 }, num6: { k: 102, v: 77 }, num7: { k: 103, v: 71 }, num8: { k: 104, v: 72 }, num9: { k: 105, v: 73 }
};
for (let i = 1; i <= 12; i++) VK_MAP['f' + i] = { k: 111 + i, v: F_KEY_VSCAN[i - 1] };

// Main alphanumeric block only — the editing cluster, arrow cluster, and numpad are laid out as
// their own independent zones below (a real keyboard's nav cluster/arrows don't share row heights
// with the main block, so coupling them into one row list can't align correctly).
const VK_MAIN_ROWS = [
  ['esc', 'gap', 'f1', 'f2', 'f3', 'f4', 'gap', 'f5', 'f6', 'f7', 'f8', 'gap', 'f9', 'f10', 'f11', 'f12'],
  ['`', '1', '2', '3', '4', '5', '6', '7', '8', '9', '0', '-', '=', 'backspace'],
  ['tab', 'q', 'w', 'e', 'r', 't', 'y', 'u', 'i', 'o', 'p', '[', ']', '\\'],
  ['capslock', 'a', 's', 'd', 'f', 'g', 'h', 'j', 'k', 'l', ';', "'", 'enter'],
  ['shiftl', 'z', 'x', 'c', 'v', 'b', 'n', 'm', ',', '.', '/', 'shiftr'],
  ['ctrll', 'winl', 'altl', 'space', 'altr', 'winr', 'menu', 'ctrlr']
];
const VK_CLUSTER_TOP = ['prtsc', 'scrlk', 'pause']; // aligned with the F-key row
const VK_CLUSTER_NAV = [['insert', 'home', 'pageup'], ['delete', 'end', 'pagedown']];
const VK_CLUSTER_ARROWS = [[null, 'up', null], ['left', 'down', 'right']]; // classic inverted-T
// Real numpad has tall + and Enter keys spanning 2 rows — represented with rowspan/colspan.
const VK_NUMPAD_CELLS = [
  { key: 'numlock', row: 1, col: 1 }, { key: 'numdiv', row: 1, col: 2 }, { key: 'nummul', row: 1, col: 3 }, { key: 'numsub', row: 1, col: 4 },
  { key: 'num7', row: 2, col: 1 }, { key: 'num8', row: 2, col: 2 }, { key: 'num9', row: 2, col: 3 }, { key: 'numadd', row: 2, col: 4, rowspan: 2 },
  { key: 'num4', row: 3, col: 1 }, { key: 'num5', row: 3, col: 2 }, { key: 'num6', row: 3, col: 3 },
  { key: 'num1', row: 4, col: 1 }, { key: 'num2', row: 4, col: 2 }, { key: 'num3', row: 4, col: 3 }, { key: 'numenter', row: 4, col: 4, rowspan: 2 },
  { key: 'num0', row: 5, col: 1, colspan: 2 }, { key: 'numdec', row: 5, col: 3 }
];

const VK_LABEL = {
  backspace: '⌫', enter: '↵', space: '', tab: 'Tab', capslock: 'Caps', esc: 'Esc',
  shiftl: 'Shift', shiftr: 'Shift', ctrll: 'Ctrl', ctrlr: 'Ctrl', altl: 'Alt', altr: 'Alt',
  winl: 'Win', winr: 'Win', menu: 'Menu', left: '←', up: '↑', right: '→', down: '↓',
  insert: 'Ins', home: 'Home', pageup: 'PgUp', delete: 'Del', end: 'End', pagedown: 'PgDn',
  prtsc: 'PrtSc', scrlk: 'ScrLk', pause: 'Pause',
  numlock: 'Num', numdiv: '/', nummul: '*', numsub: '-', numadd: '+', numenter: '↵', numdec: '.',
  num0: '0', num1: '1', num2: '2', num3: '3', num4: '4', num5: '5', num6: '6', num7: '7', num8: '8', num9: '9'
};
// Shift-symbol shown stacked above the base character, like a physical US keycap.
const VK_SHIFT_SYMBOL = {
  '`': '~', '1': '!', '2': '@', '3': '#', '4': '$', '5': '%', '6': '^', '7': '&', '8': '*', '9': '(', '0': ')',
  '-': '_', '=': '+', '[': '{', ']': '}', '\\': '|', ';': ':', "'": '"', ',': '<', '.': '>', '/': '?'
};
const VK_WIDE = new Set(['backspace', 'enter', 'shiftl', 'shiftr', 'capslock', 'ctrll', 'ctrlr', 'altl', 'altr', 'winl', 'winr', 'menu', 'tab']);
// Left/right of the same modifier share one toggle state — the guest doesn't care which physical key was used.
const VK_MODIFIER_GROUP = { shiftl: 'shift', shiftr: 'shift', ctrll: 'ctrl', ctrlr: 'ctrl', altl: 'alt', altr: 'alt' };
const vkActiveModifiers = new Set();

function vkKeyButton(key) {
  const isModifier = key in VK_MODIFIER_GROUP;
  const cls = ['vk-key', VK_WIDE.has(key) ? 'vk-wide' : '', key === 'space' ? 'vk-space' : '', isModifier ? 'vk-modifier' : '', VK_SHIFT_SYMBOL[key] ? 'vk-dual' : ''].filter(Boolean).join(' ');
  const label = VK_SHIFT_SYMBOL[key]
    ? `<span class="vk-shift">${VK_SHIFT_SYMBOL[key]}</span><span class="vk-base">${key}</span>`
    : (VK_LABEL[key] ?? key.toUpperCase());
  return `<button type="button" class="${cls}" data-vk="${key}" onclick="vkPress('${key}', this)">${label}</button>`;
}

function vkRowHTML(row) {
  return `<div class="vk-row">${row.map(key => key == null ? `<span class="vk-key vk-blank"></span>` : key === 'gap' ? `<span class="vk-gap"></span>` : vkKeyButton(key)).join('')}</div>`;
}

function renderVirtualKeyboard() {
  const el = document.getElementById('consoleKeyboard');
  const main = VK_MAIN_ROWS.map(vkRowHTML).join('');
  const cluster = `
    ${vkRowHTML(VK_CLUSTER_TOP)}
    <div class="vk-spacer-sm"></div>
    ${VK_CLUSTER_NAV.map(vkRowHTML).join('')}
    <div class="vk-spacer-lg"></div>
    ${VK_CLUSTER_ARROWS.map(vkRowHTML).join('')}
  `;
  const numpad = `<div class="vk-numgrid">${VK_NUMPAD_CELLS.map(c =>
    `<button type="button" class="vk-key" data-vk="${c.key}" onclick="vkPress('${c.key}', this)" style="grid-row:${c.row}${c.rowspan ? ` / span ${c.rowspan}` : ''};grid-column:${c.col}${c.colspan ? ` / span ${c.colspan}` : ''}">${VK_LABEL[c.key] ?? c.key}</button>`
  ).join('')}</div>`;
  el.innerHTML = `<div class="vk-keyboard">
    <div class="vk-col vk-col-main">${main}</div>
    <div class="vk-col vk-col-cluster">${cluster}</div>
    <div class="vk-col vk-col-numpad">${numpad}</div>
  </div>`;
}

function toggleVirtualKeyboard() {
  const el = document.getElementById('consoleKeyboard');
  if (!el.innerHTML) renderVirtualKeyboard();
  el.style.display = el.style.display === 'none' ? 'flex' : 'none';
}

function vkPress(key, btn) {
  const modGroup = VK_MODIFIER_GROUP[key];
  if (modGroup) {
    if (vkActiveModifiers.has(modGroup)) vkActiveModifiers.delete(modGroup); else vkActiveModifiers.add(modGroup);
    const active = vkActiveModifiers.has(modGroup);
    document.querySelectorAll('#consoleKeyboard .vk-modifier').forEach(b => { if (VK_MODIFIER_GROUP[b.dataset.vk] === modGroup) b.classList.toggle('active', active); });
    return;
  }
  if (!wmksInstance) return;
  const modKeyIds = { shift: 'shiftl', ctrl: 'ctrll', alt: 'altl' };
  const mods = [...vkActiveModifiers].map(m => modKeyIds[m]);
  const keys = [...mods.map(m => VK_MAP[m].k), VK_MAP[key].k];
  const vscan = [...mods.map(m => VK_MAP[m].v), VK_MAP[key].v];
  wmksInstance.sendKeyCodes(keys, vscan);
  // One-shot modifiers, like a mobile virtual keyboard's Shift — avoids a modifier getting stuck "held".
  vkActiveModifiers.clear();
  document.querySelectorAll('#consoleKeyboard .vk-modifier.active').forEach(b => b.classList.remove('active'));
}

// API helpers
async function api(path, method = 'GET', body) {
  const opts = { method, headers: { 'Content-Type': 'application/json' }, credentials: 'same-origin' };
  if (body) opts.body = JSON.stringify(body);
  const r = await fetch(API + path, opts);
  // 401 on a login attempt itself just means wrong credentials — only treat 401 as "session
  // expired" for already-authenticated calls, otherwise a bad password would incorrectly bounce
  // back to the (already-showing) login screen with a misleading "session expired" message.
  if (r.status === 401 && !path.startsWith('/auth/')) { showLoginScreen(); throw new Error('Phiên đăng nhập đã hết hạn, vui lòng đăng nhập lại'); }
  if (!r.ok) { const e = await r.json().catch(() => ({})); throw new Error(e.error || 'Lỗi server'); }
  return r.json();
}

// ─── AUTH ───────────────────────────────────────────────────────────────────
let currentUser = null;

function showLoginScreen() {
  currentUser = null;
  document.getElementById('app').style.display = 'none';
  document.getElementById('loginScreen').style.display = 'flex';
  document.getElementById('chatFab').style.display = 'none';
  document.getElementById('chatPanel').style.display = 'none';
}

function showApp() {
  document.getElementById('loginScreen').style.display = 'none';
  document.getElementById('app').style.display = 'flex';
  document.getElementById('userMenuName').textContent = currentUser.name;
  document.getElementById('userMenuRole').textContent = currentUser.roleName || '—';
  document.getElementById('chatFab').style.display = 'flex';
  applyPermissionVisibility();
  // Restore whatever page was open before a refresh (F5) instead of always landing back on
  // Dashboard — PAGES is the same lookup renderPage() uses, so an unrecognized/stale saved value
  // (or one from a page that no longer exists) safely falls back to dashboard.
  const lastPage = localStorage.getItem(LAST_PAGE_KEY);
  navigate(PAGES[lastPage] ? lastPage : 'dashboard');
}

async function checkAuthAndInit() {
  try {
    const { user } = await api('/auth/me');
    currentUser = user;
    showApp();
  } catch (e) {
    showLoginScreen();
  }
}

// Elements with data-permission="vcenter.vm.create" or data-permission="servers.write,devices.write"
// (comma-separated = OR) are hidden unless currentUser.permissions includes at least one of them.
// A MutationObserver re-applies this after any dynamic re-render (table reloads, modal opens, tab
// switches) so render functions don't each need to remember to call it.
function applyPermissionVisibility() {
  if (!currentUser) return;
  document.querySelectorAll('[data-permission]').forEach(el => {
    const required = el.dataset.permission.split(',');
    el.style.display = required.some(p => currentUser.permissions.includes(p)) ? '' : 'none';
  });
}
new MutationObserver(() => applyPermissionVisibility()).observe(document.body, { childList: true, subtree: true });

function setLoginTab(tab) {
  document.querySelectorAll('#loginTabs .filter-tab').forEach(t => t.classList.toggle('active', t.dataset.tab === tab));
  document.getElementById('localLoginForm').style.display = tab === 'local' ? '' : 'none';
  document.getElementById('ldapLoginForm').style.display = tab === 'ldap' ? '' : 'none';
}

function showLoginError(msg) {
  const el = document.getElementById('loginError');
  el.textContent = msg;
  el.style.display = 'block';
}

async function submitLocalLogin(e) {
  e.preventDefault();
  document.getElementById('loginError').style.display = 'none';
  const fd = new FormData(e.target);
  try {
    const { user } = await api('/auth/login', 'POST', { email: fd.get('email'), password: fd.get('password') });
    currentUser = user;
    showApp();
  } catch (err) { showLoginError(err.message); }
}

async function submitLdapLogin(e) {
  e.preventDefault();
  document.getElementById('loginError').style.display = 'none';
  const fd = new FormData(e.target);
  try {
    const { user } = await api('/auth/ldap/login', 'POST', { username: fd.get('username'), password: fd.get('password') });
    currentUser = user;
    showApp();
  } catch (err) { showLoginError(err.message); }
}

document.getElementById('btnLogout').onclick = async () => {
  try { await api('/auth/logout', 'POST'); } catch {}
  localStorage.removeItem(LAST_PAGE_KEY); // don't carry one user's last-viewed page into the next login
  showLoginScreen();
};

// Navigation
function navigate(page) {
  if (page !== 'security' && securityRefreshTimer) { clearInterval(securityRefreshTimer); securityRefreshTimer = null; }
  if (page !== 'alerts' && alertsRefreshTimer) { clearInterval(alertsRefreshTimer); alertsRefreshTimer = null; }
  if (page !== 'vcenter' && vcenterRefreshTimer) { clearInterval(vcenterRefreshTimer); vcenterRefreshTimer = null; }
  if (page !== 'pfsense' && pfsenseRefreshTimer) { clearInterval(pfsenseRefreshTimer); pfsenseRefreshTimer = null; }
  if (page !== 'dashboard' && dashboardRefreshTimer) { clearInterval(dashboardRefreshTimer); dashboardRefreshTimer = null; }
  currentPage = page;
  localStorage.setItem(LAST_PAGE_KEY, page);
  document.querySelectorAll('.nav-item').forEach(el => el.classList.toggle('active', el.dataset.page === page));
  document.getElementById('globalSearch').value = '';
  renderPage(page);
  // Close sidebar on mobile
  if (window.innerWidth <= 768) document.getElementById('sidebar').classList.remove('open');
}

document.querySelectorAll('.nav-item').forEach(el => el.addEventListener('click', (e) => { e.preventDefault(); navigate(el.dataset.page); }));
document.getElementById('menuToggle').onclick = () => document.getElementById('sidebar').classList.toggle('open');

// Global search
let searchTimeout;
document.getElementById('globalSearch').addEventListener('input', (e) => {
  clearTimeout(searchTimeout);
  searchTimeout = setTimeout(() => {
    if (currentPage === 'servers') renderServers(e.target.value);
    else if (currentPage === 'devices') renderDevices(e.target.value);
    else if (currentPage === 'alerts') renderAlerts(e.target.value);
    else if (currentPage === 'vcenter') renderVcenter(e.target.value);
    else if (currentPage === 'security') renderSecurity(e.target.value);
  }, 300);
});

// Ping all
document.getElementById('btnPingAll').onclick = async () => {
  const btn = document.getElementById('btnPingAll');
  btn.disabled = true;
  btn.textContent = 'Đang ping...';
  try {
    const r = await api('/ping/all', 'POST');
    toast(`Đã ping ${r.results.servers.length + r.results.devices.length} thiết bị`, 'info');
    renderPage(currentPage);
  } catch (e) { toast(e.message, 'error'); }
  btn.disabled = false;
  btn.innerHTML = `<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><circle cx="12" cy="12" r="10"/><path d="M12 8v4l3 3"/></svg> Ping Tất cả`;
};

// Render page
const PAGES = { dashboard: renderDashboard, servers: renderServers, devices: renderDevices, alerts: renderAlerts, rules: renderRules, vcenter: renderVcenter, security: renderSecurity, activity: renderActivity, users: renderUsers, roles: renderRoles, monitors: renderUptimeMonitors, credentials: renderCredentials, settings: renderSettings, pfsense: renderPfsense };
function renderPage(page) {
  if (PAGES[page]) PAGES[page]();
}

// ─── DASHBOARD ────────────────────────────────────────────────────────────────
async function renderDashboard() {
  const c = document.getElementById('pageContent');
  c.innerHTML = `<div class="loading"><div class="spinner"></div> Đang tải...</div>`;
  try {
    const [dash, sStats, dStats] = await Promise.all([
      api('/dashboard'), api('/servers/stats'), api('/devices/stats')
    ]);

    const sTotal = sStats.total, sOnline = sStats.online, sOffline = sStats.offline;
    const dTotal = dStats.total, dOnline = dStats.online, dOffline = dStats.offline;

    c.innerHTML = `
    <div class="page-header">
      <div><div class="page-title">Dashboard</div><div class="page-subtitle">Tổng quan hệ thống — ${new Date().toLocaleDateString('vi-VN', {weekday:'long',year:'numeric',month:'long',day:'numeric',timeZone:'Asia/Ho_Chi_Minh'})}</div></div>
      <div style="display:flex;gap:8px;align-items:center">
        <select class="filter-select" id="dashboardRefreshSelect" onchange="onDashboardRefreshIntervalChange(this.value)">
          <option value="0">Tự động: Tắt</option>
          <option value="5000">Auto (5s)</option>
          <option value="10000">10s</option>
          <option value="15000">15s</option>
        </select>
        <button class="btn btn-secondary btn-sm" onclick="renderDashboard()">
          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><polyline points="23 4 23 10 17 10"/><path d="M20.49 15a9 9 0 1 1-2.12-9.36L23 10"/></svg>
          Làm mới
        </button>
      </div>
    </div>
    <div class="stats-grid">
      <div class="stat-card">
        <div class="stat-icon blue"><svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><rect x="2" y="2" width="20" height="8" rx="2"/><rect x="2" y="14" width="20" height="8" rx="2"/></svg></div>
        <div class="stat-label">Tổng máy chủ</div>
        <div class="stat-value blue" id="dashStatServers">${sTotal}</div>
      </div>
      <div class="stat-card">
        <div class="stat-icon green"><svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M22 11.08V12a10 10 0 1 1-5.93-9.14"/><polyline points="22 4 12 14.01 9 11.01"/></svg></div>
        <div class="stat-label">Máy chủ Online</div>
        <div class="stat-value green" id="dashStatOnline">${sOnline}</div>
      </div>
      <div class="stat-card">
        <div class="stat-icon blue"><svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M5 12H2M22 12h-3M12 2v3M12 19v3"/><circle cx="12" cy="12" r="4"/></svg></div>
        <div class="stat-label">Thiết bị mạng</div>
        <div class="stat-value blue" id="dashStatDevices">${dTotal}</div>
      </div>
      <div class="stat-card">
        <div class="stat-icon red"><svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><circle cx="12" cy="12" r="10"/><line x1="15" y1="9" x2="9" y2="15"/><line x1="9" y1="9" x2="15" y2="15"/></svg></div>
        <div class="stat-label">Offline</div>
        <div class="stat-value red" id="dashStatOffline">${sOffline + dOffline}</div>
      </div>
    </div>
    <div class="dashboard-grid">
      <div class="card">
        <div class="card-title"><svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><rect x="2" y="2" width="20" height="8" rx="2"/><rect x="2" y="14" width="20" height="8" rx="2"/></svg> Trạng thái máy chủ</div>
        <div id="dashServerStatusCard">
          ${statusBar([{l:'Online',v:sOnline,c:'#22C55E'},{l:'Offline',v:sOffline,c:'#EF4444'},{l:'Unknown',v:sTotal-sOnline-sOffline,c:'#475569'}], sTotal)}
          ${statusLegend([{l:'Online',v:sOnline,c:'var(--accent)'},{l:'Offline',v:sOffline,c:'var(--red)'},{l:'Unknown',v:sTotal-sOnline-sOffline,c:'var(--fg-dim)'}])}
        </div>
      </div>
      <div class="card">
        <div class="card-title"><svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M5 12H2M22 12h-3M12 2v3M12 19v3"/><circle cx="12" cy="12" r="4"/></svg> Thiết bị mạng theo loại</div>
        <div id="dashDeviceTypeList">${dashboardDeviceTypeHtml(dStats.byType)}</div>
      </div>
      <div class="card" style="grid-column:1/-1">
        <div class="card-title"><svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><polyline points="22 12 18 12 15 21 9 3 6 12 2 12"/></svg> Hoạt động gần đây</div>
        <div class="activity-list" id="dashActivityList">${dashboardActivityHtml(dash.recentActivity)}</div>
      </div>
    </div>`;
    document.getElementById('dashboardRefreshSelect').value = String(dashboardRefreshMs);
    onDashboardRefreshIntervalChange(dashboardRefreshMs);
  } catch (e) { c.innerHTML = `<div class="empty-state"><h3>Lỗi tải dữ liệu</h3><p>${e.message}</p></div>`; }
}

function dashboardDeviceTypeHtml(byType) {
  return (byType || []).map(t => `
    <div style="display:flex;justify-content:space-between;align-items:center;padding:6px 0;border-bottom:1px solid var(--border);font-size:13px;">
      <span style="color:var(--fg-muted)">${deviceTypeLabel(t.type)}</span>
      <span style="font-family:'Fira Code',monospace;color:var(--blue)">${t.cnt}</span>
    </div>
  `).join('') || '<div style="color:var(--fg-dim);font-size:13px;padding:12px 0">Chưa có dữ liệu</div>';
}

function dashboardActivityHtml(recentActivity) {
  return (recentActivity || []).slice(0, 10).map(a => `
    <div class="activity-item">
      <div class="activity-dot ${a.action}"></div>
      <div>
        <div class="activity-text"><strong>${a.user_name || 'Hệ thống'}</strong> đã ${actionLabel(a.action).toLowerCase()} <strong>${a.entity_name || ''}</strong> (${a.entity_type || ''})</div>
        <div class="activity-time">${formatTime(a.created_at)}</div>
      </div>
    </div>
  `).join('') || '<div style="color:var(--fg-dim);font-size:13px;padding:12px 0">Chưa có hoạt động</div>';
}

let dashboardRefreshMs = 5000;
let dashboardRefreshTimer = null;

function onDashboardRefreshIntervalChange(val) {
  dashboardRefreshMs = Number(val) || 0;
  if (dashboardRefreshTimer) { clearInterval(dashboardRefreshTimer); dashboardRefreshTimer = null; }
  if (dashboardRefreshMs > 0) dashboardRefreshTimer = setInterval(refreshDashboardData, dashboardRefreshMs);
}

async function refreshDashboardData() {
  if (currentPage !== 'dashboard') { clearInterval(dashboardRefreshTimer); dashboardRefreshTimer = null; return; }
  try {
    const [dash, sStats, dStats] = await Promise.all([api('/dashboard'), api('/servers/stats'), api('/devices/stats')]);
    // Re-check after the await — the user may have navigated away while these calls were
    // in-flight, in which case the dashboard's DOM elements no longer exist.
    if (currentPage !== 'dashboard') return;
    const sTotal = sStats.total, sOnline = sStats.online, sOffline = sStats.offline;
    const dTotal = dStats.total, dOffline = dStats.offline;
    document.getElementById('dashStatServers').textContent = sTotal;
    document.getElementById('dashStatOnline').textContent = sOnline;
    document.getElementById('dashStatDevices').textContent = dTotal;
    document.getElementById('dashStatOffline').textContent = sOffline + dOffline;
    document.getElementById('dashServerStatusCard').innerHTML = `
      ${statusBar([{l:'Online',v:sOnline,c:'#22C55E'},{l:'Offline',v:sOffline,c:'#EF4444'},{l:'Unknown',v:sTotal-sOnline-sOffline,c:'#475569'}], sTotal)}
      ${statusLegend([{l:'Online',v:sOnline,c:'var(--accent)'},{l:'Offline',v:sOffline,c:'var(--red)'},{l:'Unknown',v:sTotal-sOnline-sOffline,c:'var(--fg-dim)'}])}
    `;
    document.getElementById('dashDeviceTypeList').innerHTML = dashboardDeviceTypeHtml(dStats.byType);
    document.getElementById('dashActivityList').innerHTML = dashboardActivityHtml(dash.recentActivity);
  } catch { /* transient — next tick retries */ }
}

function statusBar(items, total) {
  if (!total) return '<div class="mini-bar"></div>';
  return `<div class="mini-bar">${items.map(i => `<span style="flex:${i.v};background:${i.c};min-width:${i.v?2:0}px"></span>`).join('')}</div>`;
}
function statusLegend(items) {
  return `<div style="display:flex;gap:16px;flex-wrap:wrap">${items.map(i => `<div style="display:flex;align-items:center;gap:6px;font-size:13px"><div style="width:8px;height:8px;border-radius:50%;background:${i.c}"></div><span style="color:var(--fg-muted)">${i.l}: <strong style="color:var(--fg)">${i.v}</strong></span></div>`).join('')}</div>`;
}
function deviceTypeLabel(t) {
  const m = { switch:'Switch', router:'Router', firewall:'Firewall', access_point:'Access Point', load_balancer:'Load Balancer', ups:'UPS', printer:'Printer', camera:'Camera IP', other:'Khác' };
  return m[t] || t;
}
function actionLabel(a) {
  return { CREATE:'Thêm mới', UPDATE:'Cập nhật', DELETE:'Xóa' }[a] || a;
}
// Backend timestamps come from MySQL CURRENT_TIMESTAMP/NOW(), plain strings with no zone marker
// ("YYYY-MM-DD HH:MM:SS"). This server's MySQL has time_zone=SYSTEM, and the system itself is
// Asia/Ho_Chi_Minh — confirmed by comparing a fresh metrics_history row's recorded_at against the
// OS clock at the same instant, they matched to the second. So these strings are ALREADY GMT+7
// wall-clock time, not UTC (an earlier version of this code assumed UTC, a leftover from when the
// backend was SQLite — SQLite's CURRENT_TIMESTAMP really is always UTC — and double-shifted every
// displayed time 7 hours into the future after the MySQL migration). Mark them +07:00, not Z, so
// Date math and display are correct regardless of the viewer's own browser timezone.
function toVNDate(dt) {
  const iso = /Z|[+-]\d{2}:?\d{2}$/.test(dt) ? dt : `${dt.replace(' ', 'T')}+07:00`;
  return new Date(iso);
}
function formatTime(dt) {
  if (!dt) return '';
  return toVNDate(dt).toLocaleString('vi-VN', { timeZone: 'Asia/Ho_Chi_Minh' });
}
function pingColor(ms) {
  if (!ms) return 'unknown';
  if (ms < 20) return 'fast';
  if (ms < 100) return 'medium';
  return 'slow';
}

// ─── Generic sortable-table helpers (STT column + click-to-sort headers) ──────
function cmpValues(a, b) {
  if (a == null && b == null) return 0;
  if (a == null) return -1;
  if (b == null) return 1;
  if (typeof a === 'number' && typeof b === 'number') return a - b;
  return String(a).localeCompare(String(b), 'vi', { numeric: true, sensitivity: 'base' });
}
function applySort(rows, state, keyFn) {
  if (!state.key) return rows;
  const sorted = [...rows].sort((a, b) => cmpValues(keyFn(a, state.key), keyFn(b, state.key)));
  return state.dir === 'desc' ? sorted.reverse() : sorted;
}
function sortArrow(state, key) { return state.key === key ? (state.dir === 'asc' ? ' ▲' : ' ▼') : ''; }
function thSort(label, key, state, toggleFn) {
  return `<th style="cursor:pointer;user-select:none;white-space:nowrap" onclick="${toggleFn}('${key}')">${label}${sortArrow(state, key)}</th>`;
}
function toggleSortState(state, key) {
  if (state.key === key) state.dir = state.dir === 'asc' ? 'desc' : 'asc';
  else { state.key = key; state.dir = 'asc'; }
}

// ─── PAGINATION (shared by every list page) ────────────────────────────────────
const PAGE_SIZE_OPTIONS = [10, 20, 50, 100];

function newPagination(pageSize = 20) { return { page: 1, pageSize }; }

// Clamps page into [1, totalPages] as a side effect (so callers never need a separate clamp step —
// e.g. after a delete shrinks the dataset below the current page), then returns just that page's
// slice from an already filtered/sorted full array. Client-side pagination only — for the one
// server-side page (Activity Log) the "total"/"page" the bar displays come from the API response
// instead, paginationBar() itself doesn't care which kind it's given.
function paginateRows(rows, state) {
  const totalPages = Math.max(1, Math.ceil(rows.length / state.pageSize));
  state.page = Math.min(Math.max(1, state.page), totalPages);
  const start = (state.page - 1) * state.pageSize;
  return rows.slice(start, start + state.pageSize);
}

// stateVar/renderFn are GLOBAL identifier NAMES (strings) embedded directly into onclick handlers —
// matches the app's existing convention (thSort()/toggleServerSort() already do this) rather than
// needing an event-delegation system.
function paginationBar(state, total, stateVar, renderFn) {
  if (!total) return '';
  const totalPages = Math.max(1, Math.ceil(total / state.pageSize));
  const page = Math.min(Math.max(1, state.page), totalPages);
  const from = (page - 1) * state.pageSize + 1;
  const to = Math.min(page * state.pageSize, total);
  const go = p => `${stateVar}.page=${p};${renderFn}()`;
  const navBtn = (p, label, title) => `<button class="btn-icon" ${p === page || p < 1 || p > totalPages ? 'disabled' : ''} onclick="${go(p)}" title="${title}">${label}</button>`;
  return `<div style="display:flex;align-items:center;justify-content:space-between;gap:12px;padding:12px 4px;flex-wrap:wrap;font-size:12px;color:var(--fg-muted)">
    <div>Hiển thị ${from}-${to} / ${total}</div>
    <div style="display:flex;align-items:center;gap:4px">
      ${navBtn(1, '«', 'Trang đầu')}
      ${navBtn(page - 1, '‹', 'Trang trước')}
      <span style="padding:0 8px;white-space:nowrap">Trang ${page}/${totalPages}</span>
      ${navBtn(page + 1, '›', 'Trang sau')}
      ${navBtn(totalPages, '»', 'Trang cuối')}
      <select class="filter-select" style="margin-left:8px;padding:4px 8px" onchange="${stateVar}.pageSize=Number(this.value);${stateVar}.page=1;${renderFn}()">
        ${PAGE_SIZE_OPTIONS.map(n => `<option value="${n}" ${state.pageSize === n ? 'selected' : ''}>${n}/trang</option>`).join('')}
      </select>
    </div>
  </div>`;
}

// ─── SERVERS ──────────────────────────────────────────────────────────────────
let serverFilter = { status: '', type: '' };

async function renderServers(search = '') {
  const c = document.getElementById('pageContent');
  // Checks for #serverTableBody specifically, not the generic .table-wrap class — several other
  // pages (Rules, Security...) also render a .table-wrap, so navigating here right after one of
  // those left its markup behind would otherwise fool this "already rendered, just refresh data"
  // check into skipping the real Servers shell, leaving #serverTableBody never created and crashing
  // loadServerTable() on the next line.
  if (!document.getElementById('serverTableBody')) {
    c.innerHTML = `
    <div class="page-header">
      <div><div class="page-title">Máy chủ</div><div class="page-subtitle">Quản lý danh sách máy chủ vật lý và ảo hóa</div></div>
      <button class="btn btn-primary" onclick="openServerForm()" data-permission="servers.write">
        <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><line x1="12" y1="5" x2="12" y2="19"/><line x1="5" y1="12" x2="19" y2="12"/></svg>
        Thêm máy chủ
      </button>
    </div>
    <div class="table-wrap">
      <div class="table-toolbar">
        <div class="search-box">
          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><circle cx="11" cy="11" r="8"/><path d="m21 21-4.35-4.35"/></svg>
          <input type="text" id="serverSearch" placeholder="Tìm tên, IP, hostname..." value="${search}">
        </div>
        <select class="filter-select" id="statusFilter" onchange="applyServerFilter()">
          <option value="">Tất cả trạng thái</option>
          <option value="online">Online</option>
          <option value="offline">Offline</option>
          <option value="unknown">Unknown</option>
        </select>
        <select class="filter-select" id="typeFilter" onchange="applyServerFilter()">
          <option value="">Tất cả loại</option>
          <option value="server">Server</option>
          <option value="vm">VM</option>
          <option value="container">Container</option>
        </select>
      </div>
      <div id="serverTableBody"><div class="loading"><div class="spinner"></div></div></div>
    </div>`;
    document.getElementById('serverSearch').addEventListener('input', (e) => {
      clearTimeout(searchTimeout);
      searchTimeout = setTimeout(() => loadServerTable(), 300);
    });
  }
  loadServerTable(search);
}

function applyServerFilter() {
  serverFilter.status = document.getElementById('statusFilter')?.value || '';
  serverFilter.type = document.getElementById('typeFilter')?.value || '';
  loadServerTable();
}

let serverRows = [];
let serverSortState = { key: null, dir: 'asc' };
let serverPagination = newPagination();

async function loadServerTable(search) {
  const s = search || document.getElementById('serverSearch')?.value || '';
  const params = new URLSearchParams({ search: s, status: serverFilter.status, type: serverFilter.type });
  try {
    serverRows = await api(`/servers?${params}`);
    serverPagination.page = 1; // fresh fetch (new filter/search, or reload after create/edit/delete) — don't leave the user stranded on a now-out-of-range page
    renderServerRows();
  } catch (e) { document.getElementById('serverTableBody').innerHTML = `<div class="empty-state"><h3>Lỗi</h3><p>${e.message}</p></div>`; }
}

function toggleServerSort(key) {
  toggleSortState(serverSortState, key);
  renderServerRows();
}

// power/health -> status badge, mirrors vcPowerBadge()/fail2ban toggle's color scheme (online=green,
// warning=yellow, offline=red, unknown=gray).
function ipmiBadge(s) {
  if (!s.ipmi_host) return '<span class="status unknown"><span class="dot"></span>Chưa cấu hình</span>';
  const health = s.ipmi_health || 'unknown';
  const power = s.ipmi_power_state || 'unknown';
  const cls = health === 'critical' ? 'offline' : health === 'warning' ? 'warning' : health === 'ok' ? 'online' : 'unknown';
  const powerLabel = power === 'on' ? 'On' : power === 'off' ? 'Off' : '?';
  const healthLabel = { ok: 'OK', warning: 'Warning', critical: 'Critical' }[health] || '?';
  const title = s.ipmi_error ? escAttr(s.ipmi_error) : (s.ipmi_checked_at ? `Kiểm tra lúc ${formatTime(s.ipmi_checked_at)}` : 'Chưa kiểm tra lần nào');
  return `<span class="status ${cls}" title="${title}"><span class="dot"></span>${powerLabel} · ${healthLabel}</span>`;
}

// snmp_status ('up'/'down'/'unknown') -> badge, mirrors ipmiBadge()'s color scheme. CPU/RAM shown
// inline when available; per-interface traffic listed in the title tooltip (kept simple — no chart —
// same reasoning as ipmi's health tooltip).
function snmpBadge(row) {
  if (!row.snmp_enabled) return '<span class="status unknown"><span class="dot"></span>Chưa cấu hình</span>';
  const status = row.snmp_status || 'unknown';
  const cls = status === 'up' ? 'online' : status === 'down' ? 'offline' : 'unknown';
  let label = status === 'up' ? 'Up' : status === 'down' ? 'Down' : '?';
  if (status === 'up') {
    const parts = [];
    if (row.snmp_cpu_pct != null) parts.push(`CPU ${row.snmp_cpu_pct}%`);
    if (row.snmp_mem_used_pct != null) parts.push(`RAM ${row.snmp_mem_used_pct}%`);
    if (parts.length) label += ' · ' + parts.join(' · ');
  }
  let title = row.snmp_error ? row.snmp_error : (row.snmp_checked_at ? `Kiểm tra lúc ${formatTime(row.snmp_checked_at)}` : 'Chưa kiểm tra lần nào');
  try {
    const ifaces = JSON.parse(row.snmp_interfaces || '[]');
    if (ifaces.length) {
      title += '\n' + ifaces.map(i => `${i.name}: ↓${fmtBps(i.in_bps)} ↑${fmtBps(i.out_bps)}`).join('\n');
    }
  } catch {}
  return `<span class="status ${cls}" title="${escAttr(title)}"><span class="dot"></span>${label}</span>`;
}

function fmtBps(v) {
  if (v == null) return '?';
  if (v >= 1_000_000) return (v / 1_000_000).toFixed(1) + ' Mbps';
  if (v >= 1_000) return (v / 1_000).toFixed(1) + ' Kbps';
  return v + ' bps';
}

function fmtBytes(v) {
  if (v == null) return '—';
  if (v >= 1_073_741_824) return (v / 1_073_741_824).toFixed(2) + ' GB';
  if (v >= 1_048_576) return (v / 1_048_576).toFixed(1) + ' MB';
  if (v >= 1024) return (v / 1024).toFixed(1) + ' KB';
  return v + ' B';
}

function renderServerRows() {
  const tbody = document.getElementById('serverTableBody');
  if (!serverRows.length) {
    tbody.innerHTML = `<div class="empty-state"><svg width="48" height="48" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5"><rect x="2" y="2" width="20" height="8" rx="2"/><rect x="2" y="14" width="20" height="8" rx="2"/></svg><h3>Không có máy chủ nào</h3><p>Thêm máy chủ mới</p></div>`;
    return;
  }
  const sortedServers = applySort(serverRows, serverSortState, (row, key) => row[key]);
  const servers = paginateRows(sortedServers, serverPagination);
  const rowOffset = (serverPagination.page - 1) * serverPagination.pageSize;
  tbody.innerHTML = `<table>
      <thead><tr><th>#</th>${thSort('Tên', 'name', serverSortState, 'toggleServerSort')}${thSort('IP Address', 'ip_address', serverSortState, 'toggleServerSort')}${thSort('Loại', 'type', serverSortState, 'toggleServerSort')}${thSort('OS', 'os', serverSortState, 'toggleServerSort')}${thSort('Vị trí', 'location', serverSortState, 'toggleServerSort')}${thSort('Trạng thái', 'status', serverSortState, 'toggleServerSort')}${thSort('Ping', 'ping_ms', serverSortState, 'toggleServerSort')}<th>IPMI</th><th>SNMP</th><th>Tags</th><th>Hành động</th></tr></thead>
      <tbody>${servers.map((s, i) => `
        <tr>
          <td style="color:var(--fg-dim)">${rowOffset + i + 1}</td>
          <td><div style="font-weight:600;cursor:pointer" onclick="openServerDetail(${s.id})" title="Xem chi tiết">${s.name}</div><div class="hostname-cell">${s.hostname || ''}</div></td>
          <td><span class="ip-cell">${s.ip_address}</span></td>
          <td><span style="font-size:12px;color:var(--fg-muted)">${s.type || 'server'}</span></td>
          <td><span style="font-size:12px;color:var(--fg-muted)">${s.os || '—'}</span></td>
          <td><span style="font-size:12px;color:var(--fg-muted)">${s.location || '—'}${s.rack ? ' / '+s.rack : ''}</span></td>
          <td><span class="status ${s.status}"><span class="dot"></span>${s.status}</span></td>
          <td><span class="ping-ms ${pingColor(s.ping_ms)}">${s.ping_ms ? s.ping_ms+'ms' : '—'}</span></td>
          <td>${ipmiBadge(s)}</td>
          <td>${snmpBadge(s)}</td>
          <td><div class="tags">${(s.tags||[]).map(t => `<span class="tag">${t}</span>`).join('')}</div></td>
          <td><div class="actions">
            <button class="btn-icon ping" title="Ping" data-permission="ping.write" onclick="pingServer(${s.id}, this)"><svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><polyline points="22 12 18 12 15 21 9 3 6 12 2 12"/></svg></button>
            <button class="btn-icon ping" title="Kiểm tra IPMI" data-permission="ping.write" ${s.ipmi_host ? '' : 'disabled'} onclick="checkServerIpmi(${s.id}, this)"><svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><polyline points="23 4 23 10 17 10"/><path d="M20.49 15a9 9 0 1 1-2.12-9.36L23 10"/></svg></button>
            <button class="btn-icon ping" title="Kiểm tra SNMP" data-permission="ping.write" ${s.snmp_enabled ? '' : 'disabled'} onclick="checkServerSnmp(${s.id}, this)"><svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M22 12h-4l-3 9L9 3l-3 9H2"/></svg></button>
            <button class="btn-icon edit" title="Sửa" data-permission="servers.write" onclick="openServerForm(${JSON.stringify(s).replace(/"/g,'&quot;')})"><svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M11 4H4a2 2 0 00-2 2v14a2 2 0 002 2h14a2 2 0 002-2v-7"/><path d="M18.5 2.5a2.121 2.121 0 013 3L12 15l-4 1 1-4 9.5-9.5z"/></svg></button>
            <button class="btn-icon delete" title="Xóa" data-permission="servers.delete" onclick="deleteServer(${s.id}, '${s.name}')"><svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><polyline points="3 6 5 6 21 6"/><path d="M19 6l-1 14a2 2 0 01-2 2H8a2 2 0 01-2-2L5 6"/><path d="M10 11v6M14 11v6"/></svg></button>
          </div></td>
        </tr>`).join('')}
      </tbody></table>${paginationBar(serverPagination, sortedServers.length, 'serverPagination', 'renderServerRows')}`;
}

async function checkServerIpmi(id, btn) {
  btn.disabled = true;
  try {
    const r = await api(`/servers/${id}/ipmi/check`, 'POST');
    if (r.error) toast(`IPMI lỗi: ${r.error}`, 'error');
    else toast(`IPMI: nguồn ${r.power_state === 'on' ? 'đang bật' : r.power_state === 'off' ? 'đang tắt' : '?'}, tình trạng phần cứng: ${r.health}`, r.health === 'critical' ? 'error' : 'success');
    loadServerTable();
  } catch (e) { toast(e.message, 'error'); }
  btn.disabled = false;
}

async function checkServerSnmp(id, btn) {
  btn.disabled = true;
  try {
    const r = await api(`/servers/${id}/snmp/check`, 'POST');
    if (r.status !== 'up') toast(`SNMP lỗi: ${r.error || 'không phản hồi'}`, 'error');
    else toast(`SNMP: CPU ${r.cpu_pct ?? '?'}%, RAM ${r.mem_used_pct ?? '?'}%`, 'success');
    loadServerTable();
  } catch (e) { toast(e.message, 'error'); }
  btn.disabled = false;
}

async function pingServer(id, btn) {
  btn.disabled = true;
  const statusEl = btn.closest('tr').querySelector('.status');
  statusEl.classList.add('pinging');
  try {
    const r = await api(`/ping/server/${id}`, 'POST');
    statusEl.className = `status ${r.status}`;
    statusEl.innerHTML = `<span class="dot"></span>${r.status}`;
    btn.closest('tr').querySelector('.ping-ms').textContent = r.ping_ms ? r.ping_ms + 'ms' : '—';
    btn.closest('tr').querySelector('.ping-ms').className = `ping-ms ${pingColor(r.ping_ms)}`;
    toast(`${r.status === 'online' ? 'Online' : 'Offline'} — ${r.ping_ms ? r.ping_ms+'ms' : 'timeout'}`, r.status === 'online' ? 'success' : 'error');
  } catch (e) { toast(e.message, 'error'); }
  statusEl.classList.remove('pinging');
  btn.disabled = false;
}

function pctColor(v) {
  if (v == null) return 'var(--fg-dim)';
  if (v >= 90) return 'var(--red)';
  if (v >= 70) return 'var(--yellow)';
  return 'var(--accent)';
}

// Hand-rolled SVG polyline — app has no charting dependency (confirmed: every other trend
// visualization here, e.g. the uptime monitor's heartbeat bar, is CSS/SVG built by hand too).
// Fixed viewBox, values assumed 0-100 (cpu/ram/disk %).
function renderSparkline(values, color) {
  const clean = values.filter(v => v != null);
  if (!clean.length) return '<div style="font-size:12px;color:var(--fg-dim)">Chưa có dữ liệu</div>';
  const W = 260, H = 44;
  const points = values.map((v, i) => {
    const x = (i / Math.max(values.length - 1, 1)) * W;
    const y = v == null ? null : H - (Math.min(Math.max(v, 0), 100) / 100) * H;
    return y == null ? null : `${x.toFixed(1)},${y.toFixed(1)}`;
  }).filter(Boolean).join(' ');
  const last = clean[clean.length - 1];
  return `<svg width="${W}" height="${H}" viewBox="0 0 ${W} ${H}" style="display:block">
    <polyline points="${points}" fill="none" stroke="${color}" stroke-width="2" stroke-linejoin="round" stroke-linecap="round"/>
  </svg>`;
}

function formatUptimeSec(sec) {
  if (sec == null) return '—';
  const d = Math.floor(sec / 86400), h = Math.floor((sec % 86400) / 3600), m = Math.floor((sec % 3600) / 60);
  if (d > 0) return `${d} ngày ${h} giờ`;
  if (h > 0) return `${h} giờ ${m} phút`;
  return `${m} phút`;
}

const IPMI_CATEGORY_LABELS = { cpu: 'CPU', memory: 'RAM', storage: 'Ổ đĩa', fan: 'Quạt', power: 'Nguồn', temperature: 'Nhiệt độ', other: 'Khác' };
const IPMI_CATEGORY_ORDER = ['cpu', 'memory', 'storage', 'fan', 'power', 'temperature', 'other'];

// One pill per component category (CPU/RAM/Ổ đĩa/Quạt/Nguồn/Nhiệt độ) — count + worst status color,
// hover shows exactly which sensor(s) triggered a non-ok state. Pure IPMI (ipmitool sdr elist) only
// gives per-sensor status here, not capacity/model (e.g. no RAM size in GB, no CPU model string) —
// those still come from the manually-entered CPU/RAM/Storage fields shown in "Thông số" above.
function ipmiCategoryPill(category, sensors) {
  if (!sensors || !sensors.length) return '';
  const worst = sensors.some(s => s.status === 'critical') ? 'critical' : sensors.some(s => s.status === 'warning') ? 'warning' : 'ok';
  const cls = worst === 'critical' ? 'offline' : worst === 'warning' ? 'warning' : 'online';
  const okCount = sensors.filter(s => s.status === 'ok').length;
  const badList = sensors.filter(s => s.status !== 'ok').map(s => `${s.name}: ${s.status}`).join('\n');
  return `<span class="status ${cls}" title="${escAttr(badList || 'Tất cả bình thường')}"><span class="dot"></span>${IPMI_CATEGORY_LABELS[category] || category}: ${okCount}/${sensors.length} OK</span>`;
}

function renderIpmiDetail(s) {
  const statusLine = `${ipmiBadge(s)}<div style="font-size:12px;color:var(--fg-muted);margin-top:6px">${s.ipmi_checked_at ? 'Kiểm tra lúc ' + formatTime(s.ipmi_checked_at) : 'Chưa kiểm tra lần nào'}${s.ipmi_error ? ' — ' + s.ipmi_error : ''}</div>`;

  let sensors = null;
  try { sensors = JSON.parse(s.ipmi_sensors || 'null'); } catch { sensors = null; }
  const pills = sensors
    ? IPMI_CATEGORY_ORDER.map(cat => ipmiCategoryPill(cat, sensors[cat])).filter(Boolean).join(' ')
    : '';
  const pillsHTML = pills ? `<div style="display:flex;gap:8px;flex-wrap:wrap;margin-top:10px">${pills}</div>` : '';

  let selLog = null;
  try { selLog = JSON.parse(s.ipmi_sel_log || 'null'); } catch { selLog = null; }
  let selHTML = '';
  if (selLog && selLog.length) {
    const shown = selLog.slice(0, 10);
    selHTML = `
      <div style="font-size:11px;color:var(--fg-dim);text-transform:uppercase;letter-spacing:0.04em;margin-top:14px;margin-bottom:6px">Sự kiện gần đây (SEL)</div>
      <table style="width:100%;font-size:12px"><thead><tr><th style="text-align:left;color:var(--fg-muted)">Thời gian</th><th style="text-align:left;color:var(--fg-muted)">Cảm biến</th><th style="text-align:left;color:var(--fg-muted)">Mô tả</th></tr></thead><tbody>${
        shown.map(e => `<tr><td style="white-space:nowrap;font-family:'Fira Code',monospace">${e.occurred_at}</td><td>${e.sensor}</td><td>${e.description}${e.direction === 'Deasserted' ? ' <span style="color:var(--fg-dim)">(đã hết)</span>' : ''}</td></tr>`).join('')
      }</tbody></table>
      ${selLog.length > 10 ? `<div style="font-size:11px;color:var(--fg-dim);margin-top:4px">Còn ${selLog.length - 10} sự kiện khác — xem đầy đủ trên iDRAC</div>` : ''}
    `;
  }

  return statusLine + pillsHTML + selHTML;
}

async function openServerDetail(id) {
  openModal('Chi tiết máy chủ', `<div class="loading"><div class="spinner"></div></div>`, 'detail-modal');
  let s;
  try { s = await api(`/servers/${id}`); } catch (e) { document.getElementById('modalBody').innerHTML = `<div class="empty-state"><h3>Lỗi</h3><p>${e.message}</p></div>`; return; }

  document.getElementById('modalTitle').textContent = s.name;

  // Ping: reuse the same heartbeat-bar CSS as the uptime monitor page, oldest -> newest left to right.
  const pingHistory = [...(s.ping_history || [])].reverse();
  const heartbeatHTML = pingHistory.length
    ? `<div class="heartbeat-bar">${pingHistory.map(h => `<span class="heartbeat-tick ${h.status === 'online' ? 'up' : 'down'}" title="${h.status} — ${formatTime(h.checked_at)}"></span>`).join('')}</div>`
    : `<div style="font-size:12px;color:var(--fg-dim)">Chưa có lịch sử ping</div>`;

  const ipmiHTML = s.ipmi_host ? renderIpmiDetail(s) : `<div style="font-size:13px;color:var(--fg-dim)">Chưa cấu hình IPMI</div>`;

  let snmpHTML;
  if (s.snmp_enabled) {
    let ifaceRows = '';
    try {
      const ifaces = JSON.parse(s.snmp_interfaces || '[]');
      if (ifaces.length) {
        ifaceRows = `<table style="width:100%;margin-top:8px;font-size:12px"><thead><tr><th style="text-align:left;color:var(--fg-muted)">Interface</th><th style="text-align:right;color:var(--fg-muted)">Download</th><th style="text-align:right;color:var(--fg-muted)">Upload</th></tr></thead><tbody>${
          ifaces.map(i => `<tr><td>${i.name}</td><td style="text-align:right">${fmtBps(i.in_bps)}</td><td style="text-align:right">${fmtBps(i.out_bps)}</td></tr>`).join('')
        }</tbody></table>`;
      }
    } catch {}
    snmpHTML = `${snmpBadge(s)}<div style="font-size:12px;color:var(--fg-muted);margin-top:6px">Uptime: ${formatUptimeSec(s.snmp_uptime_sec)}${s.snmp_checked_at ? ' — kiểm tra lúc ' + formatTime(s.snmp_checked_at) : ''}${s.snmp_error ? ' — ' + s.snmp_error : ''}</div>${ifaceRows}`;
  } else {
    snmpHTML = `<div style="font-size:13px;color:var(--fg-dim)">Chưa bật giám sát SNMP</div>`;
  }

  const metrics = s.metrics_history || [];
  const cpuVals = metrics.map(m => m.cpu_pct);
  const ramVals = metrics.map(m => m.ram_pct);
  const diskVals = metrics.map(m => m.disk_pct);
  const lastMetric = metrics[metrics.length - 1];
  const trendRow = (label, vals, current) => `
    <div style="display:flex;align-items:center;gap:12px;margin-bottom:10px">
      <div style="width:70px;font-size:12px;color:var(--fg-muted)">${label}</div>
      ${renderSparkline(vals, pctColor(current))}
      <div style="width:44px;text-align:right;font-weight:600;color:${pctColor(current)}">${current != null ? current + '%' : '—'}</div>
    </div>`;

  document.getElementById('modalBody').innerHTML = `
    <div style="font-size:12px;font-weight:600;color:var(--fg-muted);text-transform:uppercase;letter-spacing:0.04em;margin-bottom:8px">Thông số</div>
    <div class="form-grid" style="margin-bottom:18px">
      <div><div style="font-size:11px;color:var(--fg-dim)">IP Address</div><div>${s.ip_address}</div></div>
      <div><div style="font-size:11px;color:var(--fg-dim)">Loại</div><div>${s.type || 'server'}</div></div>
      <div><div style="font-size:11px;color:var(--fg-dim)">Hệ điều hành</div><div>${s.os || '—'}</div></div>
      <div><div style="font-size:11px;color:var(--fg-dim)">CPU</div><div>${s.cpu || '—'}</div></div>
      <div><div style="font-size:11px;color:var(--fg-dim)">RAM</div><div>${s.ram || '—'}</div></div>
      <div><div style="font-size:11px;color:var(--fg-dim)">Storage</div><div>${s.storage || '—'}</div></div>
      <div><div style="font-size:11px;color:var(--fg-dim)">Vị trí</div><div>${s.location || '—'}${s.rack ? ' / '+s.rack : ''}</div></div>
      <div><div style="font-size:11px;color:var(--fg-dim)">Trạng thái</div><div><span class="status ${s.status}"><span class="dot"></span>${s.status}</span></div></div>
    </div>

    <div style="font-size:12px;font-weight:600;color:var(--fg-muted);text-transform:uppercase;letter-spacing:0.04em;margin-bottom:8px">Ping</div>
    <div style="margin-bottom:18px">${heartbeatHTML}</div>

    <div style="font-size:12px;font-weight:600;color:var(--fg-muted);text-transform:uppercase;letter-spacing:0.04em;margin-bottom:8px">IPMI (iDRAC / iLO)</div>
    <div style="margin-bottom:18px">${ipmiHTML}</div>

    <div style="font-size:12px;font-weight:600;color:var(--fg-muted);text-transform:uppercase;letter-spacing:0.04em;margin-bottom:8px">SNMP (v1/v2c)</div>
    <div style="margin-bottom:18px">${snmpHTML}</div>

    <div style="font-size:12px;font-weight:600;color:var(--fg-muted);text-transform:uppercase;letter-spacing:0.04em;margin-bottom:8px">Xu hướng CPU / RAM / Disk (~2 giờ gần nhất)</div>
    <div>
      ${trendRow('CPU', cpuVals, lastMetric?.cpu_pct)}
      ${trendRow('RAM', ramVals, lastMetric?.ram_pct)}
      ${trendRow('Disk', diskVals, lastMetric?.disk_pct)}
    </div>
  `;
}

async function openServerForm(server) {
  const s = typeof server === 'string' ? JSON.parse(server) : server;
  const isEdit = s && s.id;
  openModal(isEdit ? 'Cập nhật máy chủ' : 'Thêm máy chủ', `<div class="loading"><div class="spinner"></div></div>`);
  let credentials = [];
  try { credentials = await api('/ssh-credentials/options'); } catch { /* dropdown just shows "không giám sát" option */ }
  const credOptions = credentials.map(cr => `<option value="${cr.id}" ${s?.ssh_credential_id === cr.id ? 'selected' : ''}>${cr.name} (${cr.username})${cr.is_default ? ' — mặc định' : ''}</option>`).join('');
  document.getElementById('modalTitle').textContent = isEdit ? 'Cập nhật máy chủ' : 'Thêm máy chủ';
  document.getElementById('modalBody').innerHTML = `
    <form id="serverForm" onsubmit="saveServer(event, ${isEdit ? s.id : 'null'})">
      <div class="form-grid">
        <div class="form-group"><label>Tên máy chủ *</label><input type="text" name="name" value="${s?.name||''}" required placeholder="Web Server 01"></div>
        <div class="form-group"><label>Hostname</label><input type="text" name="hostname" value="${s?.hostname||''}" placeholder="web01.local"></div>
        <div class="form-group"><label>IP Address *</label><input type="text" name="ip_address" value="${s?.ip_address||''}" required placeholder="192.168.1.10"></div>
        <div class="form-group"><label>Loại</label>
          <select name="type" class="form-select">
            <option value="server" ${s?.type==='server'?'selected':''}>Server</option>
            <option value="vm" ${s?.type==='vm'?'selected':''}>Virtual Machine</option>
            <option value="container" ${s?.type==='container'?'selected':''}>Container</option>
          </select></div>
        <div class="form-group"><label>Hệ điều hành</label><input type="text" name="os" value="${s?.os||''}" placeholder="Ubuntu 22.04 LTS"></div>
        <div class="form-group"><label>CPU</label><input type="text" name="cpu" value="${s?.cpu||''}" placeholder="Intel Xeon E5-2620"></div>
        <div class="form-group"><label>RAM</label><input type="text" name="ram" value="${s?.ram||''}" placeholder="32GB DDR4"></div>
        <div class="form-group"><label>Storage</label><input type="text" name="storage" value="${s?.storage||''}" placeholder="2TB SSD"></div>
        <div class="form-group"><label>Vị trí</label><input type="text" name="location" value="${s?.location||''}" placeholder="Datacenter A"></div>
        <div class="form-group"><label>Rack</label><input type="text" name="rack" value="${s?.rack||''}" placeholder="Rack-01"></div>
        <div class="form-group"><label>SSH Port</label><input type="number" name="ssh_port" value="${s?.ssh_port||22}" placeholder="22"></div>
        <div class="form-group"><label>Tài khoản kết nối SSH</label>
          <select name="credentialId" class="form-select">
            <option value="">— Không giám sát SSH —</option>
            ${credOptions}
          </select>
        </div>
        <div class="form-group full"><label>Tags (phân cách bằng dấu phẩy)</label><input type="text" name="tags" value="${Array.isArray(s?.tags) ? s.tags.join(', ') : (s?.tags||'')}" placeholder="web, production, critical"></div>
        <div class="form-group full"><label>Ghi chú</label><textarea name="notes">${s?.notes||''}</textarea></div>
      </div>
      <div data-permission="servers.ipmi_config" style="margin-top:14px">
        <div style="font-size:12px;font-weight:600;color:var(--fg-muted);text-transform:uppercase;letter-spacing:0.04em;margin-bottom:8px">Giám sát IPMI (iDRAC / iLO)</div>
        <div class="form-grid">
          <div class="form-group"><label>IPMI Host</label><input type="text" name="ipmi_host" value="${s?.ipmi_host||''}" placeholder="10.0.1.230 (IP giao diện quản lý, khác IP hệ điều hành)"></div>
          <div class="form-group"><label>IPMI Username</label><input type="text" name="ipmi_username" value="${s?.ipmi_username||''}" placeholder="root"></div>
          <div class="form-group full"><label>IPMI Password${isEdit ? ' (để trống nếu không đổi)' : ''}</label><input type="password" name="ipmi_password" placeholder="${isEdit && s?.ipmi_host ? '••••••••' : ''}" autocomplete="new-password"></div>
        </div>
      </div>
      <div data-permission="servers.snmp_config" style="margin-top:14px">
        <div style="font-size:12px;font-weight:600;color:var(--fg-muted);text-transform:uppercase;letter-spacing:0.04em;margin-bottom:8px">Giám sát SNMP (v1/v2c — community string)</div>
        <div class="form-grid">
          <div class="form-group full"><label style="display:flex;align-items:center;gap:8px;font-weight:400"><input type="checkbox" name="snmp_enabled" value="1" ${s?.snmp_enabled?'checked':''} style="width:auto"> Bật giám sát SNMP cho máy này</label></div>
          <div class="form-group"><label>SNMP Port</label><input type="number" name="snmp_port" value="${s?.snmp_port||161}" placeholder="161"></div>
          <div class="form-group"><label>Community String</label><input type="text" name="snmp_community" value="${s?.snmp_community||'public'}" placeholder="public"></div>
        </div>
      </div>
      <div class="form-actions">
        <button type="button" class="btn btn-secondary" onclick="closeModal()">Hủy</button>
        <button type="submit" class="btn btn-primary">${isEdit ? 'Cập nhật' : 'Thêm mới'}</button>
      </div>
    </form>`;
}

async function saveServer(e, id) {
  e.preventDefault();
  const fd = new FormData(e.target);
  const data = Object.fromEntries(fd);
  try {
    if (id) { await api(`/servers/${id}`, 'PUT', data); toast('Đã cập nhật máy chủ'); }
    else { await api('/servers', 'POST', data); toast('Đã thêm máy chủ'); }
    closeModal();
    loadServerTable();
  } catch (err) { toast(err.message, 'error'); }
}

async function deleteServer(id, name) {
  if (!confirm(`Xóa máy chủ "${name}"?`)) return;
  try {
    await api(`/servers/${id}`, 'DELETE');
    toast(`Đã xóa "${name}"`);
    loadServerTable();
  } catch (e) { toast(e.message, 'error'); }
}

// ─── DEVICES ──────────────────────────────────────────────────────────────────
let deviceFilter = { status: '', type: '' };

async function renderDevices(search = '') {
  const c = document.getElementById('pageContent');
  // See renderServers()'s identical fix above — must key off #deviceTableBody, not the generic
  // .table-wrap class shared by other pages.
  if (!document.getElementById('deviceTableBody')) {
    c.innerHTML = `
    <div class="page-header">
      <div><div class="page-title">Thiết bị mạng</div><div class="page-subtitle">Switch, Router, Firewall, Access Point và các thiết bị khác</div></div>
      <button class="btn btn-primary" onclick="openDeviceForm()" data-permission="devices.write">
        <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><line x1="12" y1="5" x2="12" y2="19"/><line x1="5" y1="12" x2="19" y2="12"/></svg>
        Thêm thiết bị
      </button>
    </div>
    <div class="table-wrap">
      <div class="table-toolbar">
        <div class="search-box">
          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><circle cx="11" cy="11" r="8"/><path d="m21 21-4.35-4.35"/></svg>
          <input type="text" id="deviceSearch" placeholder="Tìm tên, IP, hãng...">
        </div>
        <select class="filter-select" id="deviceStatusFilter" onchange="applyDeviceFilter()">
          <option value="">Tất cả trạng thái</option>
          <option value="online">Online</option>
          <option value="offline">Offline</option>
          <option value="unknown">Unknown</option>
        </select>
        <select class="filter-select" id="deviceTypeFilter" onchange="applyDeviceFilter()">
          <option value="">Tất cả loại</option>
          <option value="switch">Switch</option>
          <option value="router">Router</option>
          <option value="firewall">Firewall</option>
          <option value="access_point">Access Point</option>
          <option value="load_balancer">Load Balancer</option>
          <option value="ups">UPS</option>
          <option value="other">Khác</option>
        </select>
      </div>
      <div id="deviceTableBody"><div class="loading"><div class="spinner"></div></div></div>
    </div>`;
    document.getElementById('deviceSearch').addEventListener('input', () => {
      clearTimeout(searchTimeout);
      searchTimeout = setTimeout(() => loadDeviceTable(), 300);
    });
  }
  loadDeviceTable(search);
}

function applyDeviceFilter() {
  deviceFilter.status = document.getElementById('deviceStatusFilter')?.value || '';
  deviceFilter.type = document.getElementById('deviceTypeFilter')?.value || '';
  loadDeviceTable();
}

let deviceRows = [];
let deviceSortState = { key: null, dir: 'asc' };
let devicePagination = newPagination();

async function loadDeviceTable(search) {
  const s = search || document.getElementById('deviceSearch')?.value || '';
  const params = new URLSearchParams({ search: s, status: deviceFilter.status, type: deviceFilter.type });
  try {
    deviceRows = await api(`/devices?${params}`);
    devicePagination.page = 1;
    renderDeviceRows();
  } catch (e) { document.getElementById('deviceTableBody').innerHTML = `<div class="empty-state"><h3>Lỗi</h3><p>${e.message}</p></div>`; }
}

function toggleDeviceSort(key) {
  toggleSortState(deviceSortState, key);
  renderDeviceRows();
}

function renderDeviceRows() {
  const tbody = document.getElementById('deviceTableBody');
  if (!deviceRows.length) {
    tbody.innerHTML = `<div class="empty-state"><svg width="48" height="48" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5"><path d="M5 12H2M22 12h-3M12 2v3M12 19v3"/><circle cx="12" cy="12" r="4"/></svg><h3>Không có thiết bị nào</h3><p>Thêm thiết bị mới</p></div>`;
    return;
  }
  const sortedDevices = applySort(deviceRows, deviceSortState, (row, key) => row[key]);
  const devices = paginateRows(sortedDevices, devicePagination);
  const rowOffset = (devicePagination.page - 1) * devicePagination.pageSize;
  tbody.innerHTML = `<table>
      <thead><tr><th>#</th>${thSort('Tên', 'name', deviceSortState, 'toggleDeviceSort')}${thSort('IP Address', 'ip_address', deviceSortState, 'toggleDeviceSort')}${thSort('MAC', 'mac_address', deviceSortState, 'toggleDeviceSort')}${thSort('Loại', 'type', deviceSortState, 'toggleDeviceSort')}${thSort('Hãng / Model', 'brand', deviceSortState, 'toggleDeviceSort')}${thSort('Vị trí', 'location', deviceSortState, 'toggleDeviceSort')}${thSort('Trạng thái', 'status', deviceSortState, 'toggleDeviceSort')}${thSort('Ping', 'ping_ms', deviceSortState, 'toggleDeviceSort')}<th>SNMP</th><th>Hành động</th></tr></thead>
      <tbody>${devices.map((d, i) => `
        <tr>
          <td style="color:var(--fg-dim)">${rowOffset + i + 1}</td>
          <td><div style="font-weight:600">${d.name}</div><div class="hostname-cell">${d.hostname||''}</div></td>
          <td><span class="ip-cell">${d.ip_address}</span></td>
          <td><span style="font-size:11px;font-family:'Fira Code',monospace;color:var(--fg-dim)">${d.mac_address||'—'}</span></td>
          <td><span style="font-size:12px;padding:2px 8px;border-radius:4px;background:var(--blue-dim);color:var(--blue)">${deviceTypeLabel(d.type)}</span></td>
          <td><span style="font-size:13px">${d.brand||''}${d.model ? ' '+d.model : ''}</span></td>
          <td><span style="font-size:12px;color:var(--fg-muted)">${d.location||'—'}${d.vlan ? ' / VLAN '+d.vlan : ''}</span></td>
          <td><span class="status ${d.status}"><span class="dot"></span>${d.status}</span></td>
          <td><span class="ping-ms ${pingColor(d.ping_ms)}">${d.ping_ms ? d.ping_ms+'ms' : '—'}</span></td>
          <td>${snmpBadge(d)}</td>
          <td><div class="actions">
            <button class="btn-icon ping" title="Ping" data-permission="ping.write" onclick="pingDevice(${d.id}, this)"><svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><polyline points="22 12 18 12 15 21 9 3 6 12 2 12"/></svg></button>
            <button class="btn-icon ping" title="Kiểm tra SNMP" data-permission="ping.write" ${d.snmp_enabled ? '' : 'disabled'} onclick="checkDeviceSnmp(${d.id}, this)"><svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M22 12h-4l-3 9L9 3l-3 9H2"/></svg></button>
            <button class="btn-icon edit" title="Sửa" data-permission="devices.write" onclick="openDeviceForm(${JSON.stringify(d).replace(/"/g,'&quot;')})"><svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M11 4H4a2 2 0 00-2 2v14a2 2 0 002 2h14a2 2 0 002-2v-7"/><path d="M18.5 2.5a2.121 2.121 0 013 3L12 15l-4 1 1-4 9.5-9.5z"/></svg></button>
            <button class="btn-icon delete" title="Xóa" data-permission="devices.delete" onclick="deleteDevice(${d.id}, '${d.name}')"><svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><polyline points="3 6 5 6 21 6"/><path d="M19 6l-1 14a2 2 0 01-2 2H8a2 2 0 01-2-2L5 6"/><path d="M10 11v6M14 11v6"/></svg></button>
          </div></td>
        </tr>`).join('')}
      </tbody></table>${paginationBar(devicePagination, sortedDevices.length, 'devicePagination', 'renderDeviceRows')}`;
}

async function pingDevice(id, btn) {
  btn.disabled = true;
  const statusEl = btn.closest('tr').querySelector('.status');
  statusEl.classList.add('pinging');
  try {
    const r = await api(`/ping/device/${id}`, 'POST');
    statusEl.className = `status ${r.status}`;
    statusEl.innerHTML = `<span class="dot"></span>${r.status}`;
    toast(`${r.status === 'online' ? 'Online' : 'Offline'} — ${r.ping_ms ? r.ping_ms+'ms' : 'timeout'}`, r.status === 'online' ? 'success' : 'error');
  } catch (e) { toast(e.message, 'error'); }
  statusEl.classList.remove('pinging');
  btn.disabled = false;
}

async function checkDeviceSnmp(id, btn) {
  btn.disabled = true;
  try {
    const r = await api(`/devices/${id}/snmp/check`, 'POST');
    if (r.status !== 'up') toast(`SNMP lỗi: ${r.error || 'không phản hồi'}`, 'error');
    else toast(`SNMP: CPU ${r.cpu_pct ?? '?'}%, RAM ${r.mem_used_pct ?? '?'}%`, 'success');
    loadDeviceTable();
  } catch (e) { toast(e.message, 'error'); }
  btn.disabled = false;
}

function openDeviceForm(device) {
  const d = typeof device === 'string' ? JSON.parse(device) : device;
  const isEdit = d && d.id;
  openModal(isEdit ? 'Cập nhật thiết bị' : 'Thêm thiết bị mạng', `
    <form id="deviceForm" onsubmit="saveDevice(event, ${isEdit ? d.id : 'null'})">
      <div class="form-grid">
        <div class="form-group"><label>Tên thiết bị *</label><input type="text" name="name" value="${d?.name||''}" required placeholder="Core Switch"></div>
        <div class="form-group"><label>Loại *</label>
          <select name="type" class="form-select" required>
            <option value="switch" ${d?.type==='switch'?'selected':''}>Switch</option>
            <option value="router" ${d?.type==='router'?'selected':''}>Router</option>
            <option value="firewall" ${d?.type==='firewall'?'selected':''}>Firewall</option>
            <option value="access_point" ${d?.type==='access_point'?'selected':''}>Access Point</option>
            <option value="load_balancer" ${d?.type==='load_balancer'?'selected':''}>Load Balancer</option>
            <option value="ups" ${d?.type==='ups'?'selected':''}>UPS</option>
            <option value="other" ${d?.type==='other'?'selected':''}>Khác</option>
          </select></div>
        <div class="form-group"><label>IP Address *</label><input type="text" name="ip_address" value="${d?.ip_address||''}" required placeholder="192.168.1.1"></div>
        <div class="form-group"><label>MAC Address</label><input type="text" name="mac_address" value="${d?.mac_address||''}" placeholder="00:1A:2B:3C:4D:5E"></div>
        <div class="form-group"><label>Hostname</label><input type="text" name="hostname" value="${d?.hostname||''}" placeholder="sw01.local"></div>
        <div class="form-group"><label>Hãng sản xuất</label><input type="text" name="brand" value="${d?.brand||''}" placeholder="Cisco"></div>
        <div class="form-group"><label>Model</label><input type="text" name="model" value="${d?.model||''}" placeholder="Catalyst 9300"></div>
        <div class="form-group"><label>Firmware</label><input type="text" name="firmware" value="${d?.firmware||''}" placeholder="16.12.5"></div>
        <div class="form-group"><label>Vị trí</label><input type="text" name="location" value="${d?.location||''}" placeholder="Datacenter A"></div>
        <div class="form-group"><label>VLAN</label><input type="text" name="vlan" value="${d?.vlan||''}" placeholder="VLAN10"></div>
        <div class="form-group"><label>Số cổng</label><input type="number" name="ports" value="${d?.ports||0}"></div>
        <div class="form-group full"><label>Tags</label><input type="text" name="tags" value="${Array.isArray(d?.tags) ? d.tags.join(', ') : (d?.tags||'')}" placeholder="core, critical"></div>
        <div class="form-group full"><label>Ghi chú</label><textarea name="notes">${d?.notes||''}</textarea></div>
      </div>
      <div data-permission="devices.snmp_config" style="margin-top:14px">
        <div style="font-size:12px;font-weight:600;color:var(--fg-muted);text-transform:uppercase;letter-spacing:0.04em;margin-bottom:8px">Giám sát SNMP (v1/v2c — community string)</div>
        <div class="form-grid">
          <div class="form-group full"><label style="display:flex;align-items:center;gap:8px;font-weight:400"><input type="checkbox" name="snmp_enabled" value="1" ${d?.snmp_enabled?'checked':''} style="width:auto"> Bật giám sát SNMP cho thiết bị này</label></div>
          <div class="form-group"><label>SNMP Port</label><input type="number" name="snmp_port" value="${d?.snmp_port||161}" placeholder="161"></div>
          <div class="form-group"><label>Community String</label><input type="text" name="snmp_community" value="${d?.snmp_community||'public'}" placeholder="public"></div>
        </div>
      </div>
      <div class="form-actions">
        <button type="button" class="btn btn-secondary" onclick="closeModal()">Hủy</button>
        <button type="submit" class="btn btn-primary">${isEdit ? 'Cập nhật' : 'Thêm mới'}</button>
      </div>
    </form>`);
}

async function saveDevice(e, id) {
  e.preventDefault();
  const fd = new FormData(e.target);
  const data = Object.fromEntries(fd);
  try {
    if (id) { await api(`/devices/${id}`, 'PUT', data); toast('Đã cập nhật thiết bị'); }
    else { await api('/devices', 'POST', data); toast('Đã thêm thiết bị'); }
    closeModal();
    loadDeviceTable();
  } catch (err) { toast(err.message, 'error'); }
}

async function deleteDevice(id, name) {
  if (!confirm(`Xóa thiết bị "${name}"?`)) return;
  try {
    await api(`/devices/${id}`, 'DELETE');
    toast(`Đã xóa "${name}"`);
    loadDeviceTable();
  } catch (e) { toast(e.message, 'error'); }
}

// ─── ALERTS ───────────────────────────────────────────────────────────────────
let alertFilter = { severity: '', category: '', status: '' };
let alertRows = [];
let selectedAlertIds = new Set();
let alertPagination = newPagination();

async function renderAlerts(search = '') {
  const c = document.getElementById('pageContent');
  c.innerHTML = `<div class="loading"><div class="spinner"></div> Đang tải...</div>`;
  try {
    const stats = await api('/alerts/stats');
    c.innerHTML = `
    <div class="page-header">
      <div><div class="page-title">Trung tâm cảnh báo</div><div class="page-subtitle">Cảnh báo tài nguyên, lỗi ứng dụng và bảo mật</div></div>
      <div style="display:flex;gap:8px;align-items:center">
        <select class="filter-select" id="alertsRefreshSelect" onchange="onAlertsRefreshIntervalChange(this.value)">
          <option value="0">Tự động: Tắt</option>
          <option value="5000">Auto (5s)</option>
          <option value="10000">10s</option>
          <option value="15000">15s</option>
        </select>
        <button class="btn btn-secondary btn-sm" onclick="renderAlerts()">
          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><polyline points="23 4 23 10 17 10"/><path d="M20.49 15a9 9 0 1 1-2.12-9.36L23 10"/></svg>
          Làm mới
        </button>
      </div>
    </div>
    <div class="stats-grid">
      <div class="stat-card">
        <div class="stat-icon red"><svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><circle cx="12" cy="12" r="10"/><line x1="12" y1="8" x2="12" y2="12"/><line x1="12" y1="16" x2="12.01" y2="16"/></svg></div>
        <div class="stat-label">Đang mở</div>
        <div class="stat-value red" id="alertStatOpen">${stats.open}</div>
      </div>
      <div class="stat-card">
        <div class="stat-icon yellow"><svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><circle cx="12" cy="12" r="10"/><path d="M12 8v4l3 3"/></svg></div>
        <div class="stat-label">Đã ghi nhận</div>
        <div class="stat-value yellow" id="alertStatAck">${stats.acknowledged}</div>
      </div>
      <div class="stat-card">
        <div class="stat-icon green"><svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M22 11.08V12a10 10 0 1 1-5.93-9.14"/><polyline points="22 4 12 14.01 9 11.01"/></svg></div>
        <div class="stat-label">Đã xử lý</div>
        <div class="stat-value green" id="alertStatResolved">${stats.resolved}</div>
      </div>
      <div class="stat-card">
        <div class="stat-icon blue"><svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M18 8a6 6 0 00-12 0c0 7-3 9-3 9h18s-3-2-3-9"/><path d="M13.73 21a2 2 0 01-3.46 0"/></svg></div>
        <div class="stat-label">Tổng cảnh báo</div>
        <div class="stat-value blue" id="alertStatTotal">${stats.total}</div>
      </div>
    </div>
    <div style="margin-bottom:14px;display:flex;flex-direction:column;gap:12px">
      <div style="display:flex;gap:12px;flex-wrap:wrap">
        <div class="search-box">
          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><circle cx="11" cy="11" r="8"/><path d="m21 21-4.35-4.35"/></svg>
          <input type="text" id="alertSearch" placeholder="Tìm theo tiêu đề, máy chủ..." value="${search}">
        </div>
        <select class="filter-select" id="alertCategoryFilter" onchange="applyAlertFilter()">
          <option value="">Tất cả loại</option>
          <option value="resource">Tài nguyên</option>
          <option value="app_error">Lỗi ứng dụng</option>
          <option value="security">Bảo mật</option>
        </select>
        <select class="filter-select" id="alertStatusFilter" onchange="applyAlertFilter()">
          <option value="">Tất cả trạng thái</option>
          <option value="open">Đang mở</option>
          <option value="acknowledged">Đã ghi nhận</option>
          <option value="resolved">Đã xử lý</option>
        </select>
      </div>
      <div class="filter-tabs" id="severityTabs">
        <div class="filter-tab active" data-sev="" onclick="setSeverityTab(this,'')">Tất cả</div>
        <div class="filter-tab" data-sev="critical" onclick="setSeverityTab(this,'critical')">Critical</div>
        <div class="filter-tab" data-sev="high" onclick="setSeverityTab(this,'high')">High</div>
        <div class="filter-tab" data-sev="medium" onclick="setSeverityTab(this,'medium')">Medium</div>
        <div class="filter-tab" data-sev="low" onclick="setSeverityTab(this,'low')">Low</div>
      </div>
    </div>
    <div id="alertBulkToolbar" style="display:none;align-items:center;gap:12px;background:var(--surface2);border:1px solid var(--border);border-radius:var(--radius-lg);padding:10px 14px;margin-bottom:12px">
      <span style="font-size:13px;color:var(--fg-muted)" id="alertBulkCount"></span>
      <button class="btn btn-secondary btn-sm" onclick="bulkAckSelected()">Ghi nhận đã chọn</button>
      <button class="btn btn-primary btn-sm" onclick="bulkResolveSelected()">Xử lý xong đã chọn</button>
      <button class="btn btn-secondary btn-sm" onclick="clearAlertSelection()" style="margin-left:auto">Bỏ chọn</button>
    </div>
    <div id="alertListBody"><div class="loading"><div class="spinner"></div></div></div>`;
    document.getElementById('alertSearch').addEventListener('input', (e) => {
      clearTimeout(searchTimeout);
      searchTimeout = setTimeout(() => { alertPagination.page = 1; loadAlertList(); }, 300);
    });
    document.getElementById('alertsRefreshSelect').value = String(alertsRefreshMs);
    onAlertsRefreshIntervalChange(alertsRefreshMs);
    loadAlertList(search);
  } catch (e) { c.innerHTML = `<div class="empty-state"><h3>Lỗi tải dữ liệu</h3><p>${e.message}</p></div>`; }
}

let alertsRefreshMs = 5000;
let alertsRefreshTimer = null;

function onAlertsRefreshIntervalChange(val) {
  alertsRefreshMs = Number(val) || 0;
  if (alertsRefreshTimer) { clearInterval(alertsRefreshTimer); alertsRefreshTimer = null; }
  if (alertsRefreshMs > 0) alertsRefreshTimer = setInterval(refreshAlertsData, alertsRefreshMs);
}

async function refreshAlertsData() {
  if (currentPage !== 'alerts') { clearInterval(alertsRefreshTimer); alertsRefreshTimer = null; return; }
  try {
    const stats = await api('/alerts/stats');
    // Re-check after the await — the user may have navigated away while it was in-flight.
    if (currentPage !== 'alerts') return;
    document.getElementById('alertStatOpen').textContent = stats.open;
    document.getElementById('alertStatAck').textContent = stats.acknowledged;
    document.getElementById('alertStatResolved').textContent = stats.resolved;
    document.getElementById('alertStatTotal').textContent = stats.total;
  } catch { /* transient — next tick retries */ }
  if (currentPage === 'alerts') loadAlertList();
  updateAlertBadge();
}

function setSeverityTab(el, sev) {
  document.querySelectorAll('#severityTabs .filter-tab').forEach(t => t.classList.remove('active'));
  el.classList.add('active');
  alertFilter.severity = sev;
  alertPagination.page = 1;
  loadAlertList();
}

function applyAlertFilter() {
  alertFilter.category = document.getElementById('alertCategoryFilter')?.value || '';
  alertFilter.status = document.getElementById('alertStatusFilter')?.value || '';
  alertPagination.page = 1;
  loadAlertList();
}

// Does NOT reset alertPagination.page — this is also called by the periodic auto-refresh timer
// (every 5-15s), which would otherwise yank the user back to page 1 while they're reviewing older
// alerts every few seconds. Only an actual filter/search change (below) should jump to page 1,
// since that's the case where the result set genuinely changed out from under the current page.
async function loadAlertList(search) {
  const s = search || document.getElementById('alertSearch')?.value || '';
  const params = new URLSearchParams({ search: s, severity: alertFilter.severity, category: alertFilter.category, status: alertFilter.status });
  try {
    alertRows = await api(`/alerts?${params}`);
    // Re-check after the await — auto-refresh may fire this while the user has already navigated
    // away, in which case alertListBody no longer exists.
    if (!document.getElementById('alertListBody')) return;
    // A filter/search change or periodic auto-refresh can hide previously-selected alerts from
    // view — clearing the selection avoids silently bulk-acting on rows the user can no longer see.
    selectedAlertIds.clear();
    renderAlertRows();
  } catch (e) {
    const el = document.getElementById('alertListBody');
    if (el) el.innerHTML = `<div class="empty-state"><h3>Lỗi</h3><p>${e.message}</p></div>`;
  }
}

function renderAlertRows() {
  const body = document.getElementById('alertListBody');
  updateAlertBulkToolbar();
  if (!alertRows.length) {
    body.innerHTML = `<div class="empty-state"><svg width="48" height="48" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5"><path d="M22 11.08V12a10 10 0 1 1-5.93-9.14"/><polyline points="22 4 12 14.01 9 11.01"/></svg><h3>Không có cảnh báo nào</h3><p>Hệ thống đang hoạt động bình thường</p></div>`;
    return;
  }
  const paged = paginateRows(alertRows, alertPagination);
  body.innerHTML = `
    <div style="margin-bottom:10px" data-permission="alerts.write">
      <label style="display:flex;align-items:center;gap:8px;font-size:13px;color:var(--fg-muted);cursor:pointer;width:fit-content">
        <input type="checkbox" id="alertSelectAll" onchange="toggleSelectAllAlerts(this.checked)"> Chọn tất cả trong trang này (${paged.length})
      </label>
    </div>
    <div class="alert-list">${paged.map(alertCard).join('')}</div>
    ${paginationBar(alertPagination, alertRows.length, 'alertPagination', 'renderAlertRows')}`;
}

// fail2ban already took the mitigating action by itself — showing it as "Đang mở" (needs attention)
// like a resource/app-error alert is misleading, so give it its own display-only status. The real
// a.status stays 'open' underneath (ack/resolve buttons and stats buckets are unaffected); this only
// changes the badge shown, and only until the collector auto-resolves it on unban.
function alertDisplayStatus(a) {
  if (a.metric === 'fail2ban_ban' && a.status === 'open') return 'auto_blocked';
  return a.status;
}

function alertCard(a) {
  const isResolved = a.status === 'resolved';
  const displayStatus = alertDisplayStatus(a);
  return `<div class="alert-card sev-${a.severity} ${isResolved ? 'is-resolved' : ''}">
    <input type="checkbox" class="alert-select" data-permission="alerts.write" style="margin-top:2px" ${selectedAlertIds.has(a.id) ? 'checked' : ''} onchange="toggleAlertSelect(${a.id}, this.checked)">
    <div class="alert-icon ${a.severity}">${alertCategoryIcon(a.category)}</div>
    <div class="alert-body">
      <div class="alert-top">
        <span class="severity ${a.severity}"><span class="dot"></span>${severityLabel(a.severity)}</span>
        <span class="alert-status ${displayStatus}">${alertStatusLabel(displayStatus)}</span>
        <span class="alert-title">${a.title}</span>
      </div>
      <div class="alert-message">${a.message || ''}</div>
      <div class="alert-meta">
        <span>${categoryLabel(a.category)}</span>
        <span>Nguồn: <strong>${a.source_name || '—'}</strong></span>
        ${a.metric_value ? `<span>${a.metric}: <strong>${a.metric_value}</strong></span>` : ''}
        <span>${timeAgo(a.created_at)}</span>
      </div>
    </div>
    <div class="alert-actions">
      ${a.status === 'open' ? `<button class="btn btn-secondary btn-sm" data-permission="alerts.write" onclick="ackAlert(${a.id})">Ghi nhận</button>` : ''}
      ${a.status !== 'resolved'
        ? `<button class="btn btn-primary btn-sm" data-permission="alerts.write" onclick="resolveAlert(${a.id})">Xử lý xong</button>`
        : `<button class="btn-icon delete" title="Xóa" data-permission="alerts.delete" onclick="deleteAlert(${a.id})"><svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><polyline points="3 6 5 6 21 6"/><path d="M19 6l-1 14a2 2 0 01-2 2H8a2 2 0 01-2-2L5 6"/></svg></button>`}
    </div>
  </div>`;
}

function alertCategoryIcon(cat) {
  const icons = {
    resource: '<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><rect x="4" y="4" width="16" height="16" rx="2"/><path d="M9 9h6v6H9z"/></svg>',
    app_error: '<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><circle cx="12" cy="12" r="10"/><line x1="12" y1="8" x2="12" y2="12"/><line x1="12" y1="16" x2="12.01" y2="16"/></svg>',
    security: '<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M12 2l8 4v6c0 5-3.5 8.5-8 10-4.5-1.5-8-5-8-10V6l8-4z"/></svg>'
  };
  return icons[cat] || icons.resource;
}

function severityLabel(s) { return { critical: 'Critical', high: 'High', medium: 'Medium', low: 'Low' }[s] || s; }
function categoryLabel(c) { return { resource: 'Tài nguyên', app_error: 'Lỗi ứng dụng', security: 'Bảo mật' }[c] || c; }
function alertStatusLabel(s) { return { open: 'Đang mở', acknowledged: 'Đã ghi nhận', resolved: 'Đã xử lý', auto_blocked: 'Tự động chặn' }[s] || s; }

function timeAgo(dt) {
  if (!dt) return '';
  // Same +07:00-not-Z fix as formatTime()/toVNDate() — this used its own inline `+ 'Z'` parsing
  // instead of going through toVNDate(), so it had the exact same UTC-assumption bug independently:
  // every diff came out negative (parsed time landing 7h in the future), which always satisfied
  // `diff < 60`, so every alert/event silently showed "vừa xong" no matter how old it actually was.
  const diff = Math.floor((Date.now() - toVNDate(dt).getTime()) / 1000);
  if (diff < 60) return 'vừa xong';
  if (diff < 3600) return `${Math.floor(diff / 60)} phút trước`;
  if (diff < 86400) return `${Math.floor(diff / 3600)} giờ trước`;
  return `${Math.floor(diff / 86400)} ngày trước`;
}

function isRecentTimestamp(dt, withinMs) {
  if (!dt) return false;
  // Same bug as timeAgo() above — negative diff always passed the "within window" check, so
  // foreign-login blink highlighting and "active connection" flags never actually expired.
  return Date.now() - toVNDate(dt).getTime() < withinMs;
}

async function ackAlert(id) {
  try { await api(`/alerts/${id}/ack`, 'POST'); toast('Đã ghi nhận cảnh báo', 'info'); refreshAlertsData(); }
  catch (e) { toast(e.message, 'error'); }
}
async function resolveAlert(id) {
  try { await api(`/alerts/${id}/resolve`, 'POST'); toast('Đã xử lý cảnh báo', 'success'); refreshAlertsData(); }
  catch (e) { toast(e.message, 'error'); }
}
async function deleteAlert(id) {
  if (!confirm('Xóa cảnh báo này?')) return;
  try { await api(`/alerts/${id}`, 'DELETE'); toast('Đã xóa cảnh báo'); refreshAlertsData(); }
  catch (e) { toast(e.message, 'error'); }
}

function toggleAlertSelect(id, checked) {
  if (checked) selectedAlertIds.add(id); else selectedAlertIds.delete(id);
  const selectAllBox = document.getElementById('alertSelectAll');
  const pageIds = paginateRows(alertRows, alertPagination).map(a => a.id);
  if (selectAllBox) selectAllBox.checked = pageIds.length > 0 && pageIds.every(id => selectedAlertIds.has(id));
  updateAlertBulkToolbar();
}

// "Select all" only selects the current page's alerts (what's actually visible/checkable) —
// selecting across every page silently, with no way to show which off-page rows got checked,
// would be confusing. Doesn't clear selections made on other pages, so paging back and forth
// while building up a larger bulk selection still works.
function toggleSelectAllAlerts(checked) {
  const pageIds = paginateRows(alertRows, alertPagination).map(a => a.id);
  pageIds.forEach(id => checked ? selectedAlertIds.add(id) : selectedAlertIds.delete(id));
  document.querySelectorAll('.alert-select').forEach(cb => { cb.checked = checked; });
  updateAlertBulkToolbar();
}

function clearAlertSelection() {
  selectedAlertIds.clear();
  document.querySelectorAll('.alert-select').forEach(cb => { cb.checked = false; });
  const selectAllBox = document.getElementById('alertSelectAll');
  if (selectAllBox) selectAllBox.checked = false;
  updateAlertBulkToolbar();
}

function updateAlertBulkToolbar() {
  const toolbar = document.getElementById('alertBulkToolbar');
  if (!toolbar) return;
  const n = selectedAlertIds.size;
  toolbar.style.display = n > 0 ? 'flex' : 'none';
  const countEl = document.getElementById('alertBulkCount');
  if (countEl) countEl.textContent = `Đã chọn ${n} cảnh báo`;
}

async function bulkAckSelected() {
  if (!selectedAlertIds.size) return;
  try {
    const r = await api('/alerts/bulk-ack', 'POST', { ids: [...selectedAlertIds] });
    toast(`Đã ghi nhận ${r.count} cảnh báo`, 'info');
    selectedAlertIds.clear();
    refreshAlertsData();
  } catch (e) { toast(e.message, 'error'); }
}

async function bulkResolveSelected() {
  if (!selectedAlertIds.size) return;
  try {
    const r = await api('/alerts/bulk-resolve', 'POST', { ids: [...selectedAlertIds] });
    toast(`Đã xử lý ${r.count} cảnh báo`, 'success');
    selectedAlertIds.clear();
    refreshAlertsData();
  } catch (e) { toast(e.message, 'error'); }
}

async function updateAlertBadge() {
  try {
    const stats = await api('/alerts/stats');
    const badge = document.getElementById('alertNavBadge');
    if (stats.open > 0) { badge.textContent = stats.open; badge.style.display = 'inline-flex'; }
    else { badge.style.display = 'none'; }
  } catch {}
}

// ─── ALERT RULES (THRESHOLDS) ──────────────────────────────────────────────────
async function renderRules() {
  const c = document.getElementById('pageContent');
  c.innerHTML = `<div class="loading"><div class="spinner"></div> Đang tải...</div>`;
  try {
    const [rules, servers, vms] = await Promise.all([api('/rules'), api('/servers'), api('/vcenter/vms').catch(() => [])]);
    rulesState.servers = servers;
    rulesState.vms = vms;
    c.innerHTML = `
    <div class="page-header">
      <div><div class="page-title">Ngưỡng cảnh báo</div><div class="page-subtitle">Cấu hình ngưỡng CPU/RAM/Disk cho server (SSH) và VM (vCenter) để engine tự động sinh cảnh báo</div></div>
      <button class="btn btn-primary" onclick="openRuleForm()" data-permission="rules.write">
        <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><line x1="12" y1="5" x2="12" y2="19"/><line x1="5" y1="12" x2="19" y2="12"/></svg>
        Thêm ngưỡng
      </button>
    </div>
    <div class="table-wrap" id="rulesTableWrap"></div>`;
    renderRulesTable(rules);
  } catch (e) { c.innerHTML = `<div class="empty-state"><h3>Lỗi tải dữ liệu</h3><p>${e.message}</p></div>`; }
}

const rulesState = { servers: [], vms: [] };
let rulesRows = [];
let rulesPagination = newPagination();

function scopeLabel(r) {
  if (r.scope_type === 'server') return r.scope_name || 'Server đã xóa';
  if (r.scope_type === 'vm') return `${r.scope_name || 'VM đã xóa'} (vCenter)`;
  if (r.scope_type === 'all_vms') return 'Tất cả VM (vCenter)';
  return 'Tất cả server';
}

// `rules` param only passed by the initial fetch / reloadRulesTable(); the pagination bar's re-render
// call (page/page-size change) invokes this with no argument, re-using the cached rulesRows.
function renderRulesTable(rules) {
  if (rules) { rulesRows = rules; rulesPagination.page = 1; }
  const wrap = document.getElementById('rulesTableWrap');
  if (!rulesRows.length) {
    wrap.innerHTML = `<div class="empty-state"><svg width="48" height="48" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5"><path d="M4 21v-7M4 10V3M12 21v-9M12 8V3M20 21v-5M20 12V3"/><path d="M1 14h6M9 8h6M17 16h6"/></svg><h3>Chưa có ngưỡng nào</h3><p>Thêm ngưỡng để engine bắt đầu giám sát</p></div>`;
    return;
  }
  const paged = paginateRows(rulesRows, rulesPagination);
  wrap.innerHTML = `<table>
    <thead><tr><th>Tên</th><th>Phạm vi</th><th>Điều kiện</th><th>Mức độ</th><th>Bật/Tắt</th><th>Hành động</th></tr></thead>
    <tbody>${paged.map(r => `
      <tr>
        <td style="font-weight:600">${r.name}</td>
        <td><span style="font-size:12px;color:var(--fg-muted)">${scopeLabel(r)}</span></td>
        <td><span class="ping-ms" style="font-size:13px">${metricLabel(r.metric)} ${r.operator} ${r.threshold}%</span> <span style="font-size:12px;color:var(--fg-dim)">liên tục ${r.duration_sec}s</span></td>
        <td><span class="severity ${r.severity}"><span class="dot"></span>${severityLabel(r.severity)}</span></td>
        <td><label class="switch"><input type="checkbox" ${r.enabled ? 'checked' : ''} onchange="toggleRule(${r.id})"><span class="slider"></span></label></td>
        <td><div class="actions">
          <button class="btn-icon edit" title="Sửa" data-permission="rules.write" onclick='openRuleForm(${JSON.stringify(r).replace(/'/g, "&#39;")})'><svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M11 4H4a2 2 0 00-2 2v14a2 2 0 002 2h14a2 2 0 002-2v-7"/><path d="M18.5 2.5a2.121 2.121 0 013 3L12 15l-4 1 1-4 9.5-9.5z"/></svg></button>
          <button class="btn-icon delete" title="Xóa" data-permission="rules.delete" onclick="deleteRule(${r.id}, '${r.name.replace(/'/g, "\\'")}')"><svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><polyline points="3 6 5 6 21 6"/><path d="M19 6l-1 14a2 2 0 01-2 2H8a2 2 0 01-2-2L5 6"/><path d="M10 11v6M14 11v6"/></svg></button>
        </div></td>
      </tr>`).join('')}
    </tbody></table>${paginationBar(rulesPagination, rulesRows.length, 'rulesPagination', 'renderRulesTable')}`;
}

function metricLabel(m) { return { cpu: 'CPU', ram: 'RAM', disk: 'Disk' }[m] || m; }

async function reloadRulesTable() {
  try { renderRulesTable(await api('/rules')); } catch (e) { toast(e.message, 'error'); }
}

async function toggleRule(id) {
  try { await api(`/rules/${id}/toggle`, 'POST'); reloadRulesTable(); }
  catch (e) { toast(e.message, 'error'); }
}

async function deleteRule(id, name) {
  if (!confirm(`Xóa ngưỡng "${name}"?`)) return;
  try { await api(`/rules/${id}`, 'DELETE'); toast(`Đã xóa "${name}"`); reloadRulesTable(); }
  catch (e) { toast(e.message, 'error'); }
}

function ruleScopeTargetGroup(scopeType, selectedId) {
  if (scopeType !== 'server' && scopeType !== 'vm') return '';
  const list = scopeType === 'server' ? rulesState.servers : rulesState.vms;
  const label = scopeType === 'server' ? 'Server' : 'VM';
  return `<div class="form-group" id="ruleScopeTargetGroup">
    <label>${label}</label>
    <select name="scope_id" class="form-select">
      ${list.map(s => `<option value="${s.id}" ${selectedId === s.id ? 'selected' : ''}>${s.name}</option>`).join('')}
    </select></div>`;
}

function onRuleScopeChange(sel) {
  document.getElementById('ruleScopeTargetGroup')?.remove();
  const html = ruleScopeTargetGroup(sel.value, null);
  if (html) sel.closest('.form-group').insertAdjacentHTML('afterend', html);
}

function openRuleForm(rule) {
  const r = typeof rule === 'string' ? JSON.parse(rule) : rule;
  const isEdit = r && r.id;
  const scopeType = r?.scope_type || 'all';
  openModal(isEdit ? 'Cập nhật ngưỡng' : 'Thêm ngưỡng cảnh báo', `
    <form id="ruleForm" onsubmit="saveRule(event, ${isEdit ? r.id : 'null'})">
      <div class="form-grid">
        <div class="form-group full"><label>Tên ngưỡng *</label><input type="text" name="name" value="${r?.name || ''}" required placeholder="CPU quá cao"></div>
        <div class="form-group"><label>Chỉ số</label>
          <select name="metric" class="form-select">
            <option value="cpu" ${r?.metric === 'cpu' ? 'selected' : ''}>CPU</option>
            <option value="ram" ${r?.metric === 'ram' ? 'selected' : ''}>RAM</option>
            <option value="disk" ${r?.metric === 'disk' ? 'selected' : ''}>Disk</option>
          </select></div>
        <div class="form-group"><label>Toán tử</label>
          <select name="operator" class="form-select">
            <option value=">" ${r?.operator === '>' ? 'selected' : ''}>&gt;</option>
            <option value=">=" ${r?.operator === '>=' ? 'selected' : ''}>&gt;=</option>
            <option value="<" ${r?.operator === '<' ? 'selected' : ''}>&lt;</option>
            <option value="<=" ${r?.operator === '<=' ? 'selected' : ''}>&lt;=</option>
          </select></div>
        <div class="form-group"><label>Ngưỡng (%)</label><input type="number" name="threshold" value="${r?.threshold ?? 90}" min="0" max="100" required></div>
        <div class="form-group"><label>Liên tục (giây)</label><input type="number" name="duration_sec" value="${r?.duration_sec ?? 60}" min="10" required></div>
        <div class="form-group"><label>Mức độ</label>
          <select name="severity" class="form-select">
            <option value="critical" ${r?.severity === 'critical' ? 'selected' : ''}>Critical</option>
            <option value="high" ${r?.severity === 'high' ? 'selected' : ''}>High</option>
            <option value="medium" ${r?.severity === 'medium' ? 'selected' : ''}>Medium</option>
            <option value="low" ${r?.severity === 'low' ? 'selected' : ''}>Low</option>
          </select></div>
        <div class="form-group"><label>Phạm vi</label>
          <select name="scope_type" class="form-select" onchange="onRuleScopeChange(this)">
            <option value="all" ${scopeType === 'all' ? 'selected' : ''}>Tất cả server</option>
            <option value="server" ${scopeType === 'server' ? 'selected' : ''}>Server cụ thể</option>
            <option value="all_vms" ${scopeType === 'all_vms' ? 'selected' : ''}>Tất cả VM (vCenter)</option>
            <option value="vm" ${scopeType === 'vm' ? 'selected' : ''}>VM cụ thể (vCenter)</option>
          </select></div>
        ${ruleScopeTargetGroup(scopeType, r?.scope_id)}
      </div>
      <div class="form-actions">
        <button type="button" class="btn btn-secondary" onclick="closeModal()">Hủy</button>
        <button type="submit" class="btn btn-primary">${isEdit ? 'Cập nhật' : 'Thêm mới'}</button>
      </div>
    </form>`);
}

async function saveRule(e, id) {
  e.preventDefault();
  const fd = new FormData(e.target);
  const data = Object.fromEntries(fd);
  data.threshold = Number(data.threshold);
  data.duration_sec = Number(data.duration_sec);
  try {
    if (id) { await api(`/rules/${id}`, 'PUT', data); toast('Đã cập nhật ngưỡng'); }
    else { await api('/rules', 'POST', data); toast('Đã thêm ngưỡng'); }
    closeModal();
    reloadRulesTable();
  } catch (err) { toast(err.message, 'error'); }
}

// ─── VCENTER ──────────────────────────────────────────────────────────────────
let vcenterTab = 'vms';
let vcenterFilter = { power_state: '', cluster_id: '' };
let vcenterClustersCache = [];

async function renderVcenter(search = '') {
  const c = document.getElementById('pageContent');
  c.innerHTML = `<div class="loading"><div class="spinner"></div> Đang tải...</div>`;
  try {
    const stats = await api('/vcenter/stats');
    c.innerHTML = `
    <div class="page-header">
      <div><div class="page-title">vCenter</div><div class="page-subtitle">Inventory VM — đồng bộ lần cuối: <span id="vcLastSync">${stats.lastSync ? formatTime(stats.lastSync) : 'chưa đồng bộ'}</span></div></div>
      <div style="display:flex;gap:8px">
        <select class="filter-select" id="vcenterRefreshSelect" onchange="onVcenterRefreshIntervalChange(this.value)">
          <option value="0">Tự động: Tắt</option>
          <option value="5000">Auto (5s)</option>
          <option value="10000">10s</option>
          <option value="15000">15s</option>
        </select>
        <button class="btn btn-secondary btn-sm" id="btnVcSync" onclick="syncVcenter()">
          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><polyline points="23 4 23 10 17 10"/><path d="M20.49 15a9 9 0 1 1-2.12-9.36L23 10"/></svg>
          Đồng bộ ngay
        </button>
        <button class="btn btn-primary btn-sm" onclick="openCreateVmForm()" data-permission="vcenter.vm.create">
          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><line x1="12" y1="5" x2="12" y2="19"/><line x1="5" y1="12" x2="19" y2="12"/></svg>
          Tạo VM
        </button>
      </div>
    </div>
    <div class="stats-grid">
      <div class="stat-card">
        <div class="stat-icon blue"><svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><rect x="3" y="4" width="18" height="12" rx="2"/><line x1="7" y1="20" x2="17" y2="20"/><line x1="12" y1="16" x2="12" y2="20"/></svg></div>
        <div class="stat-label">Tổng VM</div>
        <div class="stat-value blue" id="vcStatTotal">${stats.total}</div>
      </div>
      <div class="stat-card">
        <div class="stat-icon green"><svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M22 11.08V12a10 10 0 1 1-5.93-9.14"/><polyline points="22 4 12 14.01 9 11.01"/></svg></div>
        <div class="stat-label">Powered On</div>
        <div class="stat-value green" id="vcStatOn">${stats.on}</div>
      </div>
      <div class="stat-card">
        <div class="stat-icon red"><svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><circle cx="12" cy="12" r="10"/><line x1="15" y1="9" x2="9" y2="15"/><line x1="9" y1="9" x2="15" y2="15"/></svg></div>
        <div class="stat-label">Powered Off</div>
        <div class="stat-value red" id="vcStatOff">${stats.off}</div>
      </div>
    </div>
    <div class="filter-tabs" id="vcenterTabs" style="margin-bottom:16px">
      <div class="filter-tab ${vcenterTab === 'vms' ? 'active' : ''}" data-tab="vms" onclick="setVcenterTab('vms')">Danh sách VM</div>
      <div class="filter-tab ${vcenterTab === 'clusters' ? 'active' : ''}" data-tab="clusters" onclick="setVcenterTab('clusters')">Cụm vCenter</div>
    </div>
    <div id="vcenterTabBody"></div>`;
    document.getElementById('vcenterRefreshSelect').value = String(vcenterRefreshMs);
    onVcenterRefreshIntervalChange(vcenterRefreshMs);
    // Chưa có cụm nào bật -> mở thẳng tab Cụm vCenter thay vì 1 bảng VM trống khó hiểu.
    if (!stats.configured) vcenterTab = 'clusters';
    renderVcenterTabBody(search);
  } catch (e) { c.innerHTML = `<div class="empty-state"><h3>Lỗi tải dữ liệu</h3><p>${e.message}</p></div>`; }
}

function setVcenterTab(tab) {
  vcenterTab = tab;
  document.querySelectorAll('#vcenterTabs .filter-tab').forEach(t => t.classList.toggle('active', t.dataset.tab === tab));
  renderVcenterTabBody();
}

function renderVcenterTabBody(search) {
  if (vcenterTab === 'clusters') renderVcenterClustersTab();
  else renderVcenterVmsTab(search);
}

let vcenterRefreshMs = 5000;
let vcenterRefreshTimer = null;

function onVcenterRefreshIntervalChange(val) {
  vcenterRefreshMs = Number(val) || 0;
  if (vcenterRefreshTimer) { clearInterval(vcenterRefreshTimer); vcenterRefreshTimer = null; }
  if (vcenterRefreshMs > 0) vcenterRefreshTimer = setInterval(refreshVcenterData, vcenterRefreshMs);
}

// Silent variant of syncVcenter(): triggers a real inventory sync against vCenter but skips the
// toast + full-page re-render so it doesn't spam a toast every 5-15s or wipe the search/filter.
async function refreshVcenterData() {
  if (currentPage !== 'vcenter') { clearInterval(vcenterRefreshTimer); vcenterRefreshTimer = null; return; }
  try {
    await api('/vcenter/sync', 'POST');
    const stats = await api('/vcenter/stats');
    // Re-check after the awaits — the user may have navigated away while these calls were in-flight.
    if (currentPage !== 'vcenter') return;
    document.getElementById('vcStatTotal').textContent = stats.total;
    document.getElementById('vcStatOn').textContent = stats.on;
    document.getElementById('vcStatOff').textContent = stats.off;
    document.getElementById('vcLastSync').textContent = stats.lastSync ? formatTime(stats.lastSync) : 'chưa đồng bộ';
  } catch { /* transient — next tick retries */ }
  if (currentPage === 'vcenter' && vcenterTab === 'vms') loadVcenterTable();
}

function applyVcenterFilter() {
  vcenterFilter.power_state = document.getElementById('vcPowerFilter')?.value || '';
  vcenterFilter.cluster_id = document.getElementById('vcClusterFilter')?.value || '';
  vcenterPagination.page = 1;
  loadVcenterTable();
}

let vcenterRows = [];
let vcenterSortState = { key: null, dir: 'asc' };
let vcenterPagination = newPagination();

// ── Tab: Danh sách VM ──
function renderVcenterVmsTab(search) {
  const body = document.getElementById('vcenterTabBody');
  body.innerHTML = `
    <div class="table-wrap">
      <div class="table-toolbar">
        <div class="search-box">
          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><circle cx="11" cy="11" r="8"/><path d="m21 21-4.35-4.35"/></svg>
          <input type="text" id="vcenterSearch" placeholder="Tìm tên VM..." value="${search || ''}">
        </div>
        <select class="filter-select" id="vcClusterFilter" onchange="applyVcenterFilter()">
          <option value="">Tất cả cụm</option>
          ${vcenterClustersCache.map(cl => `<option value="${cl.id}" ${String(vcenterFilter.cluster_id) === String(cl.id) ? 'selected' : ''}>${cl.name}</option>`).join('')}
        </select>
        <select class="filter-select" id="vcPowerFilter" onchange="applyVcenterFilter()">
          <option value="">Tất cả trạng thái</option>
          <option value="POWERED_ON" ${vcenterFilter.power_state === 'POWERED_ON' ? 'selected' : ''}>Powered On</option>
          <option value="POWERED_OFF" ${vcenterFilter.power_state === 'POWERED_OFF' ? 'selected' : ''}>Powered Off</option>
        </select>
      </div>
      <div id="vcenterTableBody"><div class="loading"><div class="spinner"></div></div></div>
    </div>`;
  document.getElementById('vcenterSearch').addEventListener('input', () => {
    clearTimeout(searchTimeout);
    searchTimeout = setTimeout(() => { vcenterPagination.page = 1; loadVcenterTable(); }, 300);
  });
  loadVcenterTable(search);
}

// Does NOT reset vcenterPagination.page — also called by refreshVcenterData()'s periodic timer
// (every 5-15s), same reasoning as loadAlertList() above. Only genuine filter/search changes reset
// to page 1 (search box handler, applyVcenterFilter()).
async function loadVcenterTable(search) {
  const s = search || document.getElementById('vcenterSearch')?.value || '';
  const params = new URLSearchParams({ search: s, power_state: vcenterFilter.power_state, cluster_id: vcenterFilter.cluster_id });
  try {
    vcenterRows = await api(`/vcenter/vms?${params}`);
    // Re-check after the await — auto-refresh may fire this while the user has already navigated
    // away, in which case vcenterTableBody no longer exists.
    if (!document.getElementById('vcenterTableBody')) return;
    // Xây danh sách cụm để lọc từ chính dữ liệu VM (không gọi /clusters riêng — tránh nhấp nháy khi
    // đang lọc, và luôn khớp đúng những cụm thực sự có VM).
    const seen = new Map();
    vcenterRows.forEach(v => { if (v.vcenter_cluster_id && !seen.has(v.vcenter_cluster_id)) seen.set(v.vcenter_cluster_id, v.cluster_name); });
    if (!vcenterClustersCache.length || vcenterClustersCache.length !== seen.size) {
      vcenterClustersCache = [...seen].map(([id, name]) => ({ id, name }));
      const clusterFilterEl = document.getElementById('vcClusterFilter');
      if (clusterFilterEl) {
        clusterFilterEl.innerHTML = `<option value="">Tất cả cụm</option>${vcenterClustersCache.map(cl => `<option value="${cl.id}" ${String(vcenterFilter.cluster_id) === String(cl.id) ? 'selected' : ''}>${cl.name}</option>`).join('')}`;
      }
    }
    renderVcenterRows();
  } catch (e) {
    const el = document.getElementById('vcenterTableBody');
    if (el) el.innerHTML = `<div class="empty-state"><h3>Lỗi</h3><p>${e.message}</p></div>`;
  }
}

function toggleVcenterSort(key) {
  toggleSortState(vcenterSortState, key);
  renderVcenterRows();
}

function renderVcenterRows() {
  const tbody = document.getElementById('vcenterTableBody');
  if (!vcenterRows.length) {
    tbody.innerHTML = `<div class="empty-state"><svg width="48" height="48" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5"><rect x="3" y="4" width="18" height="12" rx="2"/><line x1="7" y1="20" x2="17" y2="20"/><line x1="12" y1="16" x2="12" y2="20"/></svg><h3>Không tìm thấy VM</h3><p>Thử đồng bộ lại hoặc đổi bộ lọc</p></div>`;
    return;
  }
  // No manual sort chosen yet -> keep the backend's severity order (critical/high resource VMs first).
  const sortedVms = applySort(vcenterRows, vcenterSortState, (row, key) => row[key]);
  const vms = paginateRows(sortedVms, vcenterPagination);
  const rowOffset = (vcenterPagination.page - 1) * vcenterPagination.pageSize;
  tbody.innerHTML = `<table>
      <thead><tr><th>#</th>${thSort('Tên VM', 'name', vcenterSortState, 'toggleVcenterSort')}<th>Cụm</th>${thSort('Trạng thái', 'power_state', vcenterSortState, 'toggleVcenterSort')}${thSort('vCPU', 'cpu_count', vcenterSortState, 'toggleVcenterSort')}${thSort('RAM cấp phát', 'memory_mib', vcenterSortState, 'toggleVcenterSort')}${thSort('CPU dùng', 'cpu_pct', vcenterSortState, 'toggleVcenterSort')}${thSort('RAM dùng', 'mem_pct', vcenterSortState, 'toggleVcenterSort')}${thSort('Disk dùng', 'disk_pct', vcenterSortState, 'toggleVcenterSort')}${thSort('Đồng bộ lần cuối', 'last_synced_at', vcenterSortState, 'toggleVcenterSort')}<th>Hành động</th></tr></thead>
      <tbody>${vms.map((v, i) => `
        <tr>
          <td style="color:var(--fg-dim)">${rowOffset + i + 1}</td>
          <td style="font-weight:600">${v.name}</td>
          <td><span class="tag">${v.cluster_name || '—'}</span></td>
          <td>${vcPowerBadge(v.power_state)}</td>
          <td><span class="ping-ms" style="font-size:13px">${v.cpu_count ?? '—'}</span></td>
          <td><span class="ping-ms" style="font-size:13px">${v.memory_mib ? (v.memory_mib / 1024).toFixed(0) + ' GB' : '—'}</span></td>
          <td>${vcPctCell(v.cpu_pct)}</td>
          <td>${vcPctCell(v.mem_pct)}</td>
          <td>${vcPctCell(v.disk_pct)}</td>
          <td><span style="font-size:12px;color:var(--fg-muted)">${formatTime(v.last_synced_at)}</span></td>
          <td><div class="actions">
            ${v.power_state === 'POWERED_ON'
              ? `<button class="btn-icon" title="Tắt nguồn" data-permission="vcenter.vm.power" onclick="vmPowerAction(${v.id},'stop','${escAttr(v.name)}',this)"><svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M18.36 6.64a9 9 0 1 1-12.73 0"/><line x1="12" y1="2" x2="12" y2="12"/></svg></button>
                 <button class="btn-icon" title="Khởi động lại" data-permission="vcenter.vm.power" onclick="vmPowerAction(${v.id},'reset','${escAttr(v.name)}',this)"><svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><polyline points="23 4 23 10 17 10"/><path d="M20.49 15a9 9 0 1 1-2.12-9.36L23 10"/></svg></button>`
              : `<button class="btn-icon ping" title="Bật nguồn" data-permission="vcenter.vm.power" onclick="vmPowerAction(${v.id},'start','${escAttr(v.name)}',this)"><svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><polygon points="5 3 19 12 5 21 5 3"/></svg></button>`}
            ${v.power_state === 'POWERED_ON' ? `<button class="btn-icon" title="Console" data-permission="vcenter.vm.console" onclick="openVmConsole(${v.id},'${escAttr(v.name)}')"><svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><rect x="2" y="3" width="20" height="14" rx="2"/><line x1="8" y1="21" x2="16" y2="21"/><line x1="12" y1="17" x2="12" y2="21"/></svg></button>` : ''}
            <button class="btn-icon edit" title="Sửa cấu hình" data-permission="vcenter.vm.edit" onclick='openEditVmForm(${JSON.stringify({ id: v.id, name: v.name, cpu_count: v.cpu_count, memory_mib: v.memory_mib }).replace(/'/g, "&#39;")})'><svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M11 4H4a2 2 0 00-2 2v14a2 2 0 002 2h14a2 2 0 002-2v-7"/><path d="M18.5 2.5a2.121 2.121 0 013 3L12 15l-4 1 1-4 9.5-9.5z"/></svg></button>
            <button class="btn-icon delete" title="Xóa" data-permission="vcenter.vm.delete" onclick="openDeleteVmConfirm(${v.id},'${escAttr(v.name)}')"><svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><polyline points="3 6 5 6 21 6"/><path d="M19 6l-1 14a2 2 0 01-2 2H8a2 2 0 01-2-2L5 6"/><path d="M10 11v6M14 11v6"/></svg></button>
          </div></td>
        </tr>`).join('')}
      </tbody></table>${paginationBar(vcenterPagination, sortedVms.length, 'vcenterPagination', 'renderVcenterRows')}`;
}

// ── Tab: Cụm vCenter (kết nối) ──
async function renderVcenterClustersTab() {
  const body = document.getElementById('vcenterTabBody');
  body.innerHTML = `<div class="loading"><div class="spinner"></div></div>`;
  try {
    const clusters = await api('/vcenter/clusters');
    vcenterClustersCache = clusters;
    body.innerHTML = `
    <div class="table-wrap">
      <div class="table-toolbar">
        <div style="font-size:13px;color:var(--fg-muted)">Kết nối tới nhiều hệ thống vCenter khác nhau — VM được đồng bộ và quản lý theo từng cụm</div>
        <button class="btn btn-primary btn-sm" style="margin-left:auto" onclick="openAddClusterForm()" data-permission="vcenter.cluster.manage">
          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><line x1="12" y1="5" x2="12" y2="19"/><line x1="5" y1="12" x2="19" y2="12"/></svg>
          Thêm cụm
        </button>
      </div>
      <div id="vcenterClustersBody">${renderClustersTable(clusters)}</div>
    </div>`;
    applyPermissionVisibility();
  } catch (e) { body.innerHTML = `<div class="empty-state"><h3>Lỗi tải dữ liệu</h3><p>${e.message}</p></div>`; }
}

function renderClustersTable(clusters) {
  if (!clusters.length) {
    return `<div class="empty-state"><svg width="48" height="48" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5"><rect x="3" y="4" width="18" height="12" rx="2"/><line x1="7" y1="20" x2="17" y2="20"/><line x1="12" y1="16" x2="12" y2="20"/></svg><h3>Chưa có cụm vCenter nào</h3><p>Bấm "Thêm cụm" để kết nối tới 1 hệ thống vCenter</p></div>`;
  }
  return `<table>
    <thead><tr><th>Tên</th><th>Host</th><th>Username</th><th>Trạng thái</th><th>Số VM</th><th>Đồng bộ lần cuối</th><th>Bật</th><th>Hành động</th></tr></thead>
    <tbody>${clusters.map(cl => `
      <tr>
        <td style="font-weight:600">${cl.name}</td>
        <td style="font-family:'Fira Code',monospace;font-size:13px">${cl.host}</td>
        <td style="font-size:13px">${cl.username}</td>
        <td>${clusterStatusBadge(cl.status, cl.last_error)}</td>
        <td>${cl.vm_count}</td>
        <td><span style="font-size:12px;color:var(--fg-muted)">${cl.last_synced_at ? formatTime(cl.last_synced_at) : 'chưa đồng bộ'}</span></td>
        <td>${cl.enabled ? '<span class="status online"><span class="dot"></span>Bật</span>' : '<span class="status offline"><span class="dot"></span>Tắt</span>'}</td>
        <td><div class="actions">
          <button class="btn-icon" title="Đồng bộ cụm này" data-permission="vcenter.sync" onclick="syncOneClusterUi(${cl.id},this)"><svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><polyline points="23 4 23 10 17 10"/><path d="M20.49 15a9 9 0 1 1-2.12-9.36L23 10"/></svg></button>
          <button class="btn-icon" title="Kiểm tra kết nối" data-permission="vcenter.cluster.manage" onclick="testSavedCluster(${cl.id},this)"><svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M22 11.08V12a10 10 0 1 1-5.93-9.14"/><polyline points="22 4 12 14.01 9 11.01"/></svg></button>
          <button class="btn-icon edit" title="Sửa" data-permission="vcenter.cluster.manage" onclick='openEditClusterForm(${JSON.stringify({ id: cl.id, name: cl.name, host: cl.host, username: cl.username, insecure: !!cl.insecure, enabled: !!cl.enabled }).replace(/'/g, "&#39;")})'><svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M11 4H4a2 2 0 00-2 2v14a2 2 0 002 2h14a2 2 0 002-2v-7"/><path d="M18.5 2.5a2.121 2.121 0 013 3L12 15l-4 1 1-4 9.5-9.5z"/></svg></button>
          <button class="btn-icon delete" title="Xóa" data-permission="vcenter.cluster.manage" onclick="openDeleteClusterConfirm(${cl.id},'${escAttr(cl.name)}')"><svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><polyline points="3 6 5 6 21 6"/><path d="M19 6l-1 14a2 2 0 01-2 2H8a2 2 0 01-2-2L5 6"/><path d="M10 11v6M14 11v6"/></svg></button>
        </div></td>
      </tr>`).join('')}
    </tbody></table>`;
}

function clusterStatusBadge(status, lastError) {
  if (status === 'ok') return `<span class="status online"><span class="dot"></span>OK</span>`;
  if (status === 'error') return `<span class="status offline" title="${escAttr(lastError || '')}"><span class="dot"></span>Lỗi</span>`;
  return `<span class="status unknown"><span class="dot"></span>Chưa rõ</span>`;
}

function openAddClusterForm() {
  openModal('Thêm cụm vCenter', clusterFormHtml());
}
function openEditClusterForm(cluster) {
  openModal(`Sửa cụm — ${cluster.name}`, clusterFormHtml(cluster));
}
function clusterFormHtml(cluster) {
  const isEdit = !!cluster;
  return `
    <form id="clusterForm" onsubmit="saveCluster(event, ${isEdit ? cluster.id : 'null'})">
      <div class="form-grid">
        <div class="form-group full"><label>Tên cụm *</label><input type="text" name="name" value="${cluster?.name || ''}" required placeholder="vd: DC1 - vCenter chính"></div>
        <div class="form-group full"><label>Host *</label><input type="text" name="host" value="${cluster?.host || ''}" required placeholder="vcenter.example.local"></div>
        <div class="form-group"><label>Username *</label><input type="text" name="username" value="${cluster?.username || ''}" required placeholder="administrator@vsphere.local"></div>
        <div class="form-group"><label>Mật khẩu ${isEdit ? '(để trống nếu giữ nguyên)' : '*'}</label><input type="password" name="password" ${isEdit ? '' : 'required'} autocomplete="new-password"></div>
        <div class="form-group full">
          <label style="text-transform:none;font-size:14px"><input type="checkbox" name="insecure" ${cluster?.insecure !== false ? 'checked' : ''} style="width:auto;margin-right:6px"> Bỏ qua xác thực chứng chỉ tự ký (self-signed cert)</label>
        </div>
        <div class="form-group full">
          <label style="text-transform:none;font-size:14px"><input type="checkbox" name="enabled" ${cluster?.enabled !== false ? 'checked' : ''} style="width:auto;margin-right:6px"> Bật (tham gia đồng bộ tự động)</label>
        </div>
      </div>
      <div id="clusterTestResult" style="margin-top:8px;font-size:13px"></div>
      <div class="form-actions">
        <button type="button" class="btn btn-secondary" onclick="testClusterForm(this)">Kiểm tra kết nối</button>
        <button type="button" class="btn btn-secondary" onclick="closeModal()">Hủy</button>
        <button type="submit" class="btn btn-primary">${isEdit ? 'Lưu thay đổi' : 'Thêm cụm'}</button>
      </div>
    </form>`;
}

async function testClusterForm(btn) {
  const form = document.getElementById('clusterForm');
  const fd = new FormData(form);
  const host = fd.get('host'), username = fd.get('username'), password = fd.get('password');
  const resultEl = document.getElementById('clusterTestResult');
  if (!host || !username || !password) {
    resultEl.innerHTML = `<span style="color:var(--yellow)">Nhập đủ Host/Username/Mật khẩu để kiểm tra (mật khẩu để trống chỉ dùng được khi lưu, không test được lúc chưa lưu)</span>`;
    return;
  }
  btn.disabled = true;
  resultEl.innerHTML = `<span style="color:var(--fg-dim)">Đang kiểm tra...</span>`;
  try {
    const result = await api('/vcenter/clusters/test', 'POST', { host, username, password, insecure: fd.get('insecure') === 'on' });
    resultEl.innerHTML = result.ok
      ? `<span style="color:var(--accent)">✓ ${result.message}</span>`
      : `<span style="color:var(--red)">✗ ${result.message}</span>`;
  } catch (e) {
    resultEl.innerHTML = `<span style="color:var(--red)">✗ ${e.message}</span>`;
  } finally {
    btn.disabled = false;
  }
}

async function saveCluster(e, id) {
  e.preventDefault();
  const fd = new FormData(e.target);
  const payload = {
    name: fd.get('name'), host: fd.get('host'), username: fd.get('username'), password: fd.get('password') || '',
    insecure: fd.get('insecure') === 'on', enabled: fd.get('enabled') === 'on'
  };
  try {
    if (id) await api(`/vcenter/clusters/${id}`, 'PUT', payload);
    else await api('/vcenter/clusters', 'POST', payload);
    toast(id ? 'Đã cập nhật cụm' : 'Đã thêm cụm', 'success');
    closeModal();
    renderVcenterClustersTab();
  } catch (err) { toast(err.message, 'error'); }
}

async function testSavedCluster(id, btn) {
  btn.disabled = true;
  try {
    const result = await api(`/vcenter/clusters/${id}/test`, 'POST');
    toast(result.ok ? `Kết nối thành công: ${result.message}` : `Lỗi kết nối: ${result.message}`, result.ok ? 'success' : 'error');
  } catch (e) { toast(e.message, 'error'); }
  finally { btn.disabled = false; renderVcenterClustersTab(); }
}

async function syncOneClusterUi(id, btn) {
  btn.disabled = true;
  try {
    await api(`/vcenter/clusters/${id}/sync`, 'POST');
    toast('Đã đồng bộ', 'success');
  } catch (e) { toast(e.message, 'error'); }
  finally { renderVcenterClustersTab(); }
}

function openDeleteClusterConfirm(id, name) {
  openModal('Xóa cụm vCenter', `
    <form id="clusterDeleteForm" onsubmit="confirmDeleteCluster(event, ${id}, '${escAttr(name)}')">
      <p style="font-size:14px;margin-bottom:12px">Thao tác này sẽ xóa cụm <strong>${name}</strong> và toàn bộ dữ liệu VM/lịch sử đã đồng bộ thuộc cụm này (không xóa VM thật trong vCenter, chỉ xóa dữ liệu theo dõi). Không thể hoàn tác.</p>
      <div class="form-group full"><label>Gõ chính xác tên cụm để xác nhận</label><input type="text" name="confirmName" placeholder="${name}" autocomplete="off" required></div>
      <div class="form-actions">
        <button type="button" class="btn btn-secondary" onclick="closeModal()">Hủy</button>
        <button type="submit" class="btn btn-danger">Xóa vĩnh viễn</button>
      </div>
    </form>`);
}

async function confirmDeleteCluster(e, id, name) {
  e.preventDefault();
  const fd = new FormData(e.target);
  const confirmName = fd.get('confirmName');
  if (confirmName !== name) { toast('Tên không khớp — đã hủy xóa', 'error'); return; }
  try {
    await api(`/vcenter/clusters/${id}`, 'DELETE', { confirmName });
    toast(`Đã xóa cụm "${name}"`, 'success');
    closeModal();
    renderVcenterClustersTab();
  } catch (err) { toast(err.message, 'error'); }
}

function vcPctCell(pct) {
  if (pct == null) return `<span style="font-size:13px;color:var(--fg-dim)">—</span>`;
  const cls = pct >= 90 ? 'slow' : pct >= 70 ? 'medium' : 'fast';
  const blink = pct >= 70 ? 'blink-warning-text' : '';
  return `<span class="ping-ms ${cls} ${blink}">${pct.toFixed(1)}%</span>`;
}

function vcPowerBadge(state) {
  if (state === 'POWERED_ON') return `<span class="status online"><span class="dot"></span>Powered On</span>`;
  if (state === 'POWERED_OFF') return `<span class="status offline"><span class="dot"></span>Powered Off</span>`;
  return `<span class="status unknown"><span class="dot"></span>${state || 'Unknown'}</span>`;
}

function escAttr(s) { return String(s).replace(/'/g, "\\'").replace(/"/g, '&quot;'); }

const POWER_ACTION_LABEL = { start: 'bật nguồn', stop: 'tắt nguồn', reset: 'khởi động lại', suspend: 'tạm dừng' };

async function vmPowerAction(id, action, name, btn) {
  if (action !== 'start' && !confirm(`${POWER_ACTION_LABEL[action]} VM "${name}"?`)) return;
  if (btn) btn.disabled = true;
  try {
    await api(`/vcenter/vms/${id}/power`, 'POST', { action });
    toast(`Đã ${POWER_ACTION_LABEL[action]} "${name}"`, 'success');
    loadVcenterTable();
  } catch (e) { toast(e.message, 'error'); if (btn) btn.disabled = false; }
}

// ── Edit hardware/name ──
function openEditVmForm(vm) {
  openModal(`Sửa cấu hình — ${vm.name}`, `
    <form id="vmEditForm" onsubmit="saveEditVm(event, ${vm.id})">
      <div class="form-grid">
        <div class="form-group full"><label>Tên VM</label><input type="text" name="name" value="${vm.name}" required></div>
        <div class="form-group"><label>vCPU</label><input type="number" name="cpuCount" value="${vm.cpu_count ?? 1}" min="1" max="128" required></div>
        <div class="form-group"><label>RAM (MB)</label><input type="number" name="memoryMib" value="${vm.memory_mib ?? 1024}" min="128" step="128" required></div>
      </div>
      <p style="font-size:12px;color:var(--fg-dim);margin-top:10px">Một số VM yêu cầu tắt nguồn trước khi đổi vCPU/RAM nếu hot-add chưa được bật.</p>
      <div class="form-actions">
        <button type="button" class="btn btn-secondary" onclick="closeModal()">Hủy</button>
        <button type="submit" class="btn btn-primary">Lưu thay đổi</button>
      </div>
    </form>`);
}

async function saveEditVm(e, id) {
  e.preventDefault();
  const fd = new FormData(e.target);
  const name = fd.get('name');
  const cpuCount = Number(fd.get('cpuCount'));
  const memoryMib = Number(fd.get('memoryMib'));
  try {
    await api(`/vcenter/vms/${id}/hardware`, 'PATCH', { cpuCount, memoryMib });
    await api(`/vcenter/vms/${id}/rename`, 'PATCH', { name });
    toast('Đã cập nhật VM', 'success');
    closeModal();
    loadVcenterTable();
  } catch (err) { toast(err.message, 'error'); }
}

// ── Delete (type-to-confirm — this is real production infrastructure) ──
function openDeleteVmConfirm(id, name) {
  openModal(`Xóa VM — không thể hoàn tác`, `
    <form id="vmDeleteForm" onsubmit="confirmDeleteVm(event, ${id}, '${escAttr(name)}')">
      <p style="font-size:14px;margin-bottom:12px">Thao tác này sẽ <strong style="color:var(--red)">xóa vĩnh viễn</strong> VM <strong>${name}</strong> khỏi vCenter (tự động tắt nguồn nếu đang bật). Không thể hoàn tác.</p>
      <div class="form-group full"><label>Gõ chính xác tên VM để xác nhận</label><input type="text" name="confirmName" placeholder="${name}" autocomplete="off" required></div>
      <div class="form-actions">
        <button type="button" class="btn btn-secondary" onclick="closeModal()">Hủy</button>
        <button type="submit" class="btn btn-danger">Xóa vĩnh viễn</button>
      </div>
    </form>`);
}

async function confirmDeleteVm(e, id, name) {
  e.preventDefault();
  const fd = new FormData(e.target);
  const confirmName = fd.get('confirmName');
  if (confirmName !== name) { toast('Tên không khớp — đã hủy xóa', 'error'); return; }
  try {
    await api(`/vcenter/vms/${id}`, 'DELETE', { confirmName });
    toast(`Đã xóa "${name}"`, 'success');
    closeModal();
    loadVcenterTable();
  } catch (err) { toast(err.message, 'error'); }
}

// ── Create (empty VM via multi-step wizard, or clone from template) ──
let createVmState = null;

// host/datastore/network/folder/template chỉ tồn tại trong 1 vCenter cụ thể — phải chọn cụm trước
// khi tải các danh sách này. Nếu chỉ có đúng 1 cụm khả dụng thì tự chọn luôn, đỡ thêm 1 bước cho
// trường hợp phổ biến nhất (chỉ dùng 1 vCenter).
let createVmClusterId = null;

async function openCreateVmForm() {
  openModal('Tạo VM', `<div class="loading"><div class="spinner"></div> Đang tải danh sách cụm vCenter...</div>`);
  try {
    const clusters = (await api('/vcenter/clusters')).filter(cl => cl.enabled);
    if (!clusters.length) {
      document.getElementById('modalBody').innerHTML = `<div class="empty-state"><h3>Chưa có cụm vCenter khả dụng</h3><p>Vào tab "Cụm vCenter" để thêm và bật 1 kết nối trước khi tạo VM.</p></div>`;
      return;
    }
    if (clusters.length === 1) {
      createVmClusterId = clusters[0].id;
      await loadCreateVmPlacementData();
    } else {
      renderCreateVmClusterPicker(clusters);
    }
  } catch (e) {
    document.getElementById('modalBody').innerHTML = `<div class="empty-state"><h3>Lỗi</h3><p>${e.message}</p></div>`;
  }
}

function renderCreateVmClusterPicker(clusters) {
  document.getElementById('modalTitle').textContent = 'Tạo VM';
  document.getElementById('modalBody').innerHTML = `
    <div class="form-group full"><label>Chọn cụm vCenter</label>
      <select id="createVmClusterSelect" class="form-select">${clusters.map(cl => `<option value="${cl.id}">${cl.name} (${cl.host})</option>`).join('')}</select>
    </div>
    <div class="form-actions">
      <button type="button" class="btn btn-secondary" onclick="closeModal()">Hủy</button>
      <button type="button" class="btn btn-primary" onclick="confirmCreateVmCluster()">Tiếp tục</button>
    </div>`;
}

async function confirmCreateVmCluster() {
  createVmClusterId = document.getElementById('createVmClusterSelect').value;
  document.getElementById('modalBody').innerHTML = `<div class="loading"><div class="spinner"></div> Đang tải danh sách host/datastore...</div>`;
  await loadCreateVmPlacementData();
}

async function loadCreateVmPlacementData() {
  try {
    const [placement, templates, guestOsGroups] = await Promise.all([
      api(`/vcenter/placement?cluster_id=${createVmClusterId}`),
      api(`/vcenter/templates?cluster_id=${createVmClusterId}`),
      api('/vcenter/guest-os')
    ]);
    createVmState = { placement, templates, guestOsGroups };
    renderCreateVmForm('empty');
  } catch (e) {
    document.getElementById('modalBody').innerHTML = `<div class="empty-state"><h3>Lỗi</h3><p>${e.message}</p></div>`;
  }
}

function datastoreOptionsForHost(hostId, selectedId) {
  const host = createVmState.placement.hosts.find(h => h.id === hostId);
  const allowedIds = new Set(host?.datastore_ids || []);
  const opts = createVmState.placement.datastores
    .filter(d => allowedIds.has(d.id))
    .map(d => `<option value="${d.id}" ${d.id === selectedId ? 'selected' : ''}>${d.name} (còn ${d.free_gb}GB)</option>`).join('');
  return opts || '<option value="">Không có datastore khả dụng cho host này</option>';
}

function onCreateVmHostChange(sel) {
  sel.form.poolId.value = sel.selectedOptions[0].dataset.pool || '';
  sel.form.datastoreId.innerHTML = datastoreOptionsForHost(sel.value);
}

function createVmModeTabs(mode) {
  return `<div class="filter-tabs" style="margin-bottom:16px">
    <div class="filter-tab ${mode === 'empty' ? 'active' : ''}" onclick="renderCreateVmForm('empty')">Tạo VM rỗng</div>
    <div class="filter-tab ${mode === 'clone' ? 'active' : ''}" onclick="renderCreateVmForm('clone')">Clone từ template</div>
  </div>`;
}

function renderCreateVmForm(mode) {
  if (mode === 'empty') {
    initEmptyWizard();
    renderEmptyWizardStep();
  } else {
    renderCloneForm();
  }
}

// ── Clone from template (single-page form) ──
function renderCloneForm() {
  const { placement, templates } = createVmState;
  const hostOptions = placement.hosts.map(h => `<option value="${h.id}" data-pool="${h.resource_pool || ''}">${h.name}</option>`).join('');
  const dsOptions = datastoreOptionsForHost(placement.hosts[0]?.id);
  const tmplOptions = templates.map(t => `<option value="${t.moref}">${t.name}</option>`).join('');

  document.getElementById('modalTitle').textContent = 'Tạo VM';
  document.getElementById('modalBody').innerHTML = `
    <form id="createVmForm" onsubmit="saveCreateVm(event)">
      ${createVmModeTabs('clone')}
      <input type="hidden" name="mode" value="clone">
      <div class="form-grid">
        <div class="form-group full"><label>Tên VM *</label><input type="text" name="name" required placeholder="my-new-vm"></div>
        <div class="form-group full"><label>Template *</label><select name="templateMoref" class="form-select" required onchange="onCreateVmTemplateChange(this)">${tmplOptions || '<option value="">Không có template nào</option>'}</select></div>
        <div id="cloneSpecFields" style="display:contents"><div class="form-group full"><span style="font-size:12px;color:var(--fg-dim)">Chọn template để xem cấu hình mặc định</span></div></div>
        <div class="form-group"><label>Host *</label><select name="hostId" class="form-select" required onchange="onCreateVmHostChange(this)">${hostOptions}</select></div>
        <input type="hidden" name="poolId">
        <div class="form-group"><label>Datastore *</label><select name="datastoreId" class="form-select" required>${dsOptions}</select></div>
      </div>
      <div class="form-actions">
        <button type="button" class="btn btn-secondary" onclick="closeModal()">Hủy</button>
        <button type="submit" class="btn btn-primary">Clone</button>
      </div>
    </form>`;
  document.getElementById('createVmForm').poolId.value = placement.hosts[0]?.resource_pool || '';
  if (templates.length) onCreateVmTemplateChange(document.getElementById('createVmForm').templateMoref);
}

// ── Empty VM wizard (name/location → guest OS → hardware → review), matching vCenter's own flow ──
// Single-page form (matches Clone's layout) — Name/Host/Datastore/Guest OS/Hardware all on one
// page rather than a multi-step wizard, so nothing is hidden behind a "Tiếp tục" click.
function initEmptyWizard() {
  const { placement } = createVmState;
  const firstHost = placement.hosts[0];
  const firstDs = placement.datastores.find(d => (firstHost?.datastore_ids || []).includes(d.id));
  createVmState.wizard = {
    name: '',
    hostId: firstHost?.id || '',
    datastoreId: firstDs?.id || '',
    guestOs: 'UBUNTU_64',
    cpuCount: 2,
    memoryMib: 2048,
    disks: [{ gb: 20 }],
    nics: [],
    cdromEnabled: false,
    cdromIso: '',
    isoCache: {}
  };
}

function renderEmptyWizardStep() {
  const w = createVmState.wizard;
  const { placement, guestOsGroups } = createVmState;
  const hostOptions = placement.hosts.map(h => `<option value="${h.id}" data-pool="${h.resource_pool || ''}" ${h.id === w.hostId ? 'selected' : ''}>${h.name}</option>`).join('');
  const dsOptions = datastoreOptionsForHost(w.hostId, w.datastoreId);
  const groupsHtml = guestOsGroups.map(g => `<optgroup label="${g.group}">${g.options.map(o => `<option value="${o.id}" ${o.id === w.guestOs ? 'selected' : ''}>${o.label}</option>`).join('')}</optgroup>`).join('');
  const diskRows = w.disks.map((d, i) => `
    <div class="wizard-row">
      <div class="form-group"><label>Ổ đĩa ${i + 1} (GB)</label><input type="number" class="wz-disk-gb" data-i="${i}" value="${d.gb}" min="1" required></div>
      ${w.disks.length > 1 ? `<button type="button" class="btn btn-secondary btn-sm" onclick="removeWizardDisk(${i})">Xóa</button>` : ''}
    </div>`).join('');
  const nicRows = w.nics.map((n, i) => `
    <div class="wizard-row">
      <div class="form-group"><label>Network Adapter ${i + 1}</label><select class="wz-nic-net form-select" data-i="${i}">${placement.networks.map(net => `<option value="${net.id}" ${net.id === n.networkId ? 'selected' : ''}>${net.name}</option>`).join('')}</select></div>
      <button type="button" class="btn btn-secondary btn-sm" onclick="removeWizardNic(${i})">Xóa</button>
    </div>`).join('');

  document.getElementById('modalTitle').textContent = 'Tạo VM';
  document.getElementById('modalBody').innerHTML = `
    ${createVmModeTabs('empty')}
    <form id="emptyVmForm" onsubmit="submitEmptyVm(event)">
      <div class="form-grid">
        <div class="form-group full"><label>Tên VM *</label><input type="text" id="wzName" value="${w.name}" required placeholder="my-new-vm"></div>
        <div class="form-group"><label>Host *</label><select id="wzHostId" class="form-select" required onchange="onWizardHostChange(this)">${hostOptions}</select></div>
        <div class="form-group"><label>Datastore *</label><select id="wzDatastoreId" class="form-select" required>${dsOptions}</select></div>
        <div class="form-group full"><label>Hệ điều hành khách (Guest OS) *</label><select id="wzGuestOs" class="form-select" required>${groupsHtml}</select></div>
        <div class="form-group"><label>vCPU</label><input type="number" id="wzCpuCount" value="${w.cpuCount}" min="1" max="64" required></div>
        <div class="form-group"><label>RAM (MB)</label><input type="number" id="wzMemoryMib" value="${w.memoryMib}" min="128" step="128" required></div>
      </div>
      <div class="form-group full" style="margin-top:10px"><label>Ổ cứng</label></div>
      ${diskRows}
      <button type="button" class="btn btn-secondary btn-sm" onclick="addWizardDisk()">+ Thêm ổ đĩa</button>
      <div class="form-group full" style="margin-top:16px"><label>Network Adapter</label></div>
      ${nicRows || '<div style="font-size:12px;color:var(--fg-dim);margin-bottom:8px">Chưa có network adapter nào</div>'}
      <button type="button" class="btn btn-secondary btn-sm" onclick="addWizardNic()">+ Thêm Network Adapter</button>
      <div class="form-group full" style="margin-top:16px">
        <label style="text-transform:none;font-size:14px"><input type="checkbox" id="wzCdromEnabled" ${w.cdromEnabled ? 'checked' : ''} onchange="onWizardCdromToggle(this.checked)" style="width:auto;margin-right:6px"> Gắn CD/DVD từ ISO</label>
      </div>
      <div id="wzCdromIsoWrap" class="form-group full" style="${w.cdromEnabled ? '' : 'display:none'}">
        <label>Chọn file ISO</label>
        <select id="wzCdromIso" class="form-select"><option value="">Đang tải danh sách ISO...</option></select>
      </div>
      <div class="form-actions">
        <button type="button" class="btn btn-secondary" onclick="closeModal()">Hủy</button>
        <button type="submit" class="btn btn-primary">Tạo VM</button>
      </div>
    </form>`;
  if (w.cdromEnabled) wizardRefreshIsoOptions();
}

// Reads every current field into state — called before add/remove-row re-renders and before
// submit, so nothing typed is lost when the disk/NIC list changes shape.
function wizardSyncFromDom() {
  const w = createVmState.wizard;
  w.name = document.getElementById('wzName').value.trim();
  w.hostId = document.getElementById('wzHostId').value;
  w.datastoreId = document.getElementById('wzDatastoreId').value;
  w.guestOs = document.getElementById('wzGuestOs').value;
  w.cpuCount = Number(document.getElementById('wzCpuCount').value) || 1;
  w.memoryMib = Number(document.getElementById('wzMemoryMib').value) || 128;
  document.querySelectorAll('.wz-disk-gb').forEach(el => { w.disks[Number(el.dataset.i)].gb = Number(el.value) || 1; });
  document.querySelectorAll('.wz-nic-net').forEach(el => { w.nics[Number(el.dataset.i)].networkId = el.value; });
  const cdromEl = document.getElementById('wzCdromEnabled');
  w.cdromEnabled = cdromEl ? cdromEl.checked : false;
  const isoSel = document.getElementById('wzCdromIso');
  w.cdromIso = w.cdromEnabled && isoSel ? isoSel.value : '';
}

function onWizardHostChange(sel) {
  const w = createVmState.wizard;
  w.hostId = sel.value;
  w.datastoreId = '';
  document.getElementById('wzDatastoreId').innerHTML = datastoreOptionsForHost(sel.value, '');
}

function addWizardDisk() {
  wizardSyncFromDom();
  createVmState.wizard.disks.push({ gb: 20 });
  renderEmptyWizardStep();
}
function removeWizardDisk(i) {
  wizardSyncFromDom();
  createVmState.wizard.disks.splice(i, 1);
  renderEmptyWizardStep();
}
function addWizardNic() {
  wizardSyncFromDom();
  const firstNet = createVmState.placement.networks[0];
  createVmState.wizard.nics.push({ networkId: firstNet?.id || '' });
  renderEmptyWizardStep();
}
function removeWizardNic(i) {
  wizardSyncFromDom();
  createVmState.wizard.nics.splice(i, 1);
  renderEmptyWizardStep();
}

function onWizardCdromToggle(checked) {
  wizardSyncFromDom();
  createVmState.wizard.cdromEnabled = checked;
  renderEmptyWizardStep();
}

async function wizardRefreshIsoOptions() {
  const w = createVmState.wizard;
  const select = document.getElementById('wzCdromIso');
  if (!w.cdromEnabled || !select) return;
  const renderIsoOptions = (isos) => {
    select.innerHTML = isos.length
      ? isos.map(p => `<option value="${p}" ${p === w.cdromIso ? 'selected' : ''}>${p}</option>`).join('')
      : '<option value="">Không tìm thấy file .iso nào trên datastore này</option>';
  };
  if (w.isoCache[w.datastoreId]) { renderIsoOptions(w.isoCache[w.datastoreId]); return; }
  try {
    const isos = await api(`/vcenter/datastore/${w.datastoreId}/isos?cluster_id=${createVmClusterId}`);
    w.isoCache[w.datastoreId] = isos;
    renderIsoOptions(isos);
  } catch (e) {
    select.innerHTML = `<option value="">Không đọc được danh sách ISO: ${e.message}</option>`;
  }
}

async function submitEmptyVm(e) {
  e.preventDefault();
  wizardSyncFromDom();
  const w = createVmState.wizard;
  if (!w.datastoreId) { toast('Vui lòng chọn Datastore khả dụng cho host này', 'error'); return; }
  const payload = {
    mode: 'empty',
    name: w.name,
    guestOs: w.guestOs,
    cpuCount: w.cpuCount,
    memoryMib: w.memoryMib,
    disks: w.disks,
    nics: w.nics,
    cdromIso: w.cdromEnabled ? w.cdromIso : '',
    hostId: w.hostId,
    datastoreId: w.datastoreId,
    folderId: createVmState.placement.vmFolder,
    clusterId: createVmClusterId
  };
  const btn = document.querySelector('#emptyVmForm .btn-primary');
  btn.disabled = true;
  btn.textContent = 'Đang tạo...';
  try {
    await api('/vcenter/vms', 'POST', payload);
    toast(`Đã tạo VM "${payload.name}"`, 'success');
    closeModal();
    loadVcenterTable();
  } catch (err) {
    toast(err.message, 'error');
    btn.disabled = false;
    btn.textContent = 'Tạo VM';
  }
}

let cloneExtraState = { spec: null, disks: [], nics: [] };

async function onCreateVmTemplateChange(sel) {
  const container = document.getElementById('cloneSpecFields');
  container.innerHTML = `<div class="form-group full"><span style="font-size:12px;color:var(--fg-dim)">Đang tải cấu hình template...</span></div>`;
  try {
    const spec = await api(`/vcenter/templates/${sel.value}/spec?cluster_id=${createVmClusterId}`);
    cloneExtraState = { spec, disks: [], nics: [] };
    renderCloneSpecFields();
  } catch (e) {
    container.innerHTML = `<div class="form-group full"><span style="font-size:12px;color:var(--red)">Không đọc được cấu hình template: ${e.message}</span></div>`;
  }
}

function renderCloneSpecFields() {
  const container = document.getElementById('cloneSpecFields');
  const spec = cloneExtraState.spec;
  const networks = createVmState.placement.networks;
  const netOptions = networks.map(n => `<option value="${n.id}" ${n.id === spec.networkId ? 'selected' : ''}>${n.name}</option>`).join('');

  const extraDiskRows = cloneExtraState.disks.map((d, i) => `
    <div class="wizard-row">
      <div class="form-group"><label>Ổ đĩa thêm ${i + 1} (GB)</label><input type="number" class="clone-extra-disk-gb" data-i="${i}" value="${d.gb}" min="1" required></div>
      <button type="button" class="btn btn-secondary btn-sm" onclick="removeCloneDisk(${i})">Xóa</button>
    </div>`).join('');

  const extraNicRows = cloneExtraState.nics.map((n, i) => `
    <div class="wizard-row">
      <div class="form-group"><label>Network Adapter thêm ${i + 1}</label><select class="clone-extra-nic-net form-select" data-i="${i}">${networks.map(net => `<option value="${net.id}" ${net.id === n.networkId ? 'selected' : ''}>${net.name}</option>`).join('')}</select></div>
      <button type="button" class="btn btn-secondary btn-sm" onclick="removeCloneNic(${i})">Xóa</button>
    </div>`).join('');

  container.innerHTML = `
    <div class="form-group"><label>vCPU (tối thiểu ${spec.cpuCount})</label><input type="number" name="cpuCount" value="${spec.cpuCount}" min="${spec.cpuCount}" max="64" required></div>
    <div class="form-group"><label>RAM MB (tối thiểu ${spec.memoryMib})</label><input type="number" name="memoryMib" value="${spec.memoryMib}" min="${spec.memoryMib}" step="128" required></div>
    <div class="form-group"><label>Disk GB (tối thiểu ${spec.diskGb ?? '—'})</label><input type="number" name="diskGb" value="${spec.diskGb ?? 20}" min="${spec.diskGb ?? 1}" required ${spec.diskId ? '' : 'disabled'}></div>
    <div class="form-group"><label>Network Adapter${spec.networkName ? ` (hiện: ${spec.networkName})` : ''}</label><select name="networkId" class="form-select" ${spec.nicId ? '' : 'disabled'}>${netOptions}</select></div>
    <div class="form-group full" style="margin-top:10px"><label>Ổ đĩa thêm (ngoài ổ mặc định của template)</label></div>
    ${extraDiskRows}
    <div class="form-group full"><button type="button" class="btn btn-secondary btn-sm" onclick="addCloneDisk()">+ Thêm ổ đĩa</button></div>
    <div class="form-group full" style="margin-top:10px"><label>Network Adapter thêm (ngoài adapter mặc định của template)</label></div>
    ${extraNicRows}
    <div class="form-group full"><button type="button" class="btn btn-secondary btn-sm" onclick="addCloneNic()">+ Thêm Network Adapter</button></div>
  `;
}

function syncCloneExtrasFromDom() {
  document.querySelectorAll('.clone-extra-disk-gb').forEach(el => { cloneExtraState.disks[Number(el.dataset.i)].gb = Number(el.value) || 1; });
  document.querySelectorAll('.clone-extra-nic-net').forEach(el => { cloneExtraState.nics[Number(el.dataset.i)].networkId = el.value; });
}

function addCloneDisk() {
  syncCloneExtrasFromDom();
  cloneExtraState.disks.push({ gb: 20 });
  renderCloneSpecFields();
}
function removeCloneDisk(i) {
  syncCloneExtrasFromDom();
  cloneExtraState.disks.splice(i, 1);
  renderCloneSpecFields();
}
function addCloneNic() {
  syncCloneExtrasFromDom();
  const firstNet = createVmState.placement.networks[0];
  cloneExtraState.nics.push({ networkId: firstNet?.id || '' });
  renderCloneSpecFields();
}
function removeCloneNic(i) {
  syncCloneExtrasFromDom();
  cloneExtraState.nics.splice(i, 1);
  renderCloneSpecFields();
}

async function saveCreateVm(e) {
  e.preventDefault();
  const fd = new FormData(e.target);
  const data = Object.fromEntries(fd);
  data.folderId = createVmState.placement.vmFolder;
  data.clusterId = createVmClusterId;
  if (data.cpuCount) data.cpuCount = Number(data.cpuCount);
  if (data.memoryMib) data.memoryMib = Number(data.memoryMib);
  if (data.diskGb) data.diskGb = Number(data.diskGb);
  if (data.mode === 'clone') {
    syncCloneExtrasFromDom();
    data.extraDisks = cloneExtraState.disks;
    data.extraNics = cloneExtraState.nics;
  }
  const btn = e.target.querySelector('button[type=submit]');
  btn.disabled = true;
  btn.textContent = data.mode === 'clone' ? 'Đang clone...' : 'Đang tạo...';
  try {
    await api('/vcenter/vms', 'POST', data);
    toast(`Đã tạo VM "${data.name}"`, 'success');
    closeModal();
    loadVcenterTable();
  } catch (err) {
    toast(err.message, 'error');
    btn.disabled = false;
    btn.textContent = data.mode === 'clone' ? 'Clone' : 'Tạo VM';
  }
}

async function syncVcenter() {
  const btn = document.getElementById('btnVcSync');
  btn.disabled = true;
  btn.innerHTML = `<div class="spinner" style="width:14px;height:14px;border-width:2px"></div> Đang đồng bộ...`;
  try {
    const r = await api('/vcenter/sync', 'POST');
    toast(`Đã đồng bộ ${r.count ?? 0} VM`, 'success');
    renderVcenter();
  } catch (e) { toast(e.message, 'error'); }
  finally {
    if (document.getElementById('btnVcSync')) {
      btn.disabled = false;
      btn.innerHTML = `<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><polyline points="23 4 23 10 17 10"/><path d="M20.49 15a9 9 0 1 1-2.12-9.36L23 10"/></svg> Đồng bộ ngay`;
    }
  }
}

// ─── SECURITY (Giám sát bất thường) ────────────────────────────────────────────
let securityTab = 'events';
const securityFilter = { vmId: '', eventType: '', foreignOnly: false };
const securityState = { vms: [] };
let securityRefreshMs = 5000;
let securityRefreshTimer = null;

async function renderSecurity(search = '') {
  const c = document.getElementById('pageContent');
  c.innerHTML = `<div class="loading"><div class="spinner"></div> Đang tải...</div>`;
  try {
    const [stats, vms, outboundStats] = await Promise.all([api('/security/stats'), api('/security/vms'), api('/security/outbound/stats')]);
    securityState.vms = vms;
    if (search) securityTab = 'events';
    c.innerHTML = `
    <div class="page-header">
      <div><div class="page-title">Giám sát bất thường</div><div class="page-subtitle">Đăng nhập SSH và kết nối ra ngoài trên các VM — cảnh báo truy cập từ ngoài Việt Nam</div></div>
      <div style="display:flex;gap:8px;align-items:center">
        <select class="filter-select" id="securityRefreshSelect" onchange="onSecurityRefreshIntervalChange(this.value)">
          <option value="0">Tự động: Tắt</option>
          <option value="5000">Auto (5s)</option>
          <option value="10000">10s</option>
          <option value="15000">15s</option>
        </select>
        <button class="btn btn-secondary btn-sm" onclick="renderSecurity()">
          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><polyline points="23 4 23 10 17 10"/><path d="M20.49 15a9 9 0 1 1-2.12-9.36L23 10"/></svg>
          Làm mới
        </button>
      </div>
    </div>
    <div class="stats-grid">
      <div class="stat-card">
        <div class="stat-icon blue"><svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M18 8a6 6 0 00-12 0c0 7-3 9-3 9h18s-3-2-3-9"/><path d="M13.73 21a2 2 0 01-3.46 0"/></svg></div>
        <div class="stat-label">SSH events (24h)</div>
        <div class="stat-value blue" id="secStatTotal">${stats.total}</div>
      </div>
      <div class="stat-card">
        <div class="stat-icon green"><svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M22 11.08V12a10 10 0 1 1-5.93-9.14"/><polyline points="22 4 12 14.01 9 11.01"/></svg></div>
        <div class="stat-label">Đăng nhập thành công</div>
        <div class="stat-value green" id="secStatAccepted">${stats.accepted}</div>
      </div>
      <div class="stat-card">
        <div class="stat-icon red"><svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><circle cx="12" cy="12" r="10"/><line x1="15" y1="9" x2="9" y2="15"/><line x1="9" y1="9" x2="15" y2="15"/></svg></div>
        <div class="stat-label">Đăng nhập thất bại</div>
        <div class="stat-value red" id="secStatFailed">${stats.failed}</div>
      </div>
      <div class="stat-card">
        <div class="stat-icon red"><svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><circle cx="12" cy="12" r="10"/><line x1="12" y1="8" x2="12" y2="12"/><line x1="12" y1="16" x2="12.01" y2="16"/></svg></div>
        <div class="stat-label">Đăng nhập thành công từ nước ngoài</div>
        <div class="stat-value red" id="secStatForeign">${stats.foreign}</div>
      </div>
      <div class="stat-card">
        <div class="stat-icon yellow"><svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M5 12h14M13 6l6 6-6 6"/></svg></div>
        <div class="stat-label">Kết nối ra IP nước ngoài (đang mở)</div>
        <div class="stat-value yellow" id="secStatOutbound">${outboundStats.foreignActive}<span style="font-size:13px;color:var(--fg-dim);font-weight:500"> / ${outboundStats.foreign} lịch sử</span></div>
      </div>
      <div class="stat-card">
        <div class="stat-icon blue"><svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><rect x="3" y="4" width="18" height="12" rx="2"/><line x1="7" y1="20" x2="17" y2="20"/><line x1="12" y1="16" x2="12" y2="20"/></svg></div>
        <div class="stat-label">VM đang giám sát</div>
        <div class="stat-value blue" id="secStatMonitored">${stats.monitored}</div>
      </div>
    </div>
    <div class="filter-tabs" id="securityTabs" style="margin-bottom:16px">
      <div class="filter-tab ${securityTab === 'events' ? 'active' : ''}" data-tab="events" onclick="setSecurityTab('events')">Nhật ký đăng nhập SSH</div>
      <div class="filter-tab ${securityTab === 'outbound' ? 'active' : ''}" data-tab="outbound" onclick="setSecurityTab('outbound')">Kết nối ra ngoài</div>
      <div class="filter-tab ${securityTab === 'manage' ? 'active' : ''}" data-tab="manage" onclick="setSecurityTab('manage')">Quản lý VM giám sát</div>
    </div>
    <div id="securityTabBody"></div>`;
    document.getElementById('securityRefreshSelect').value = String(securityRefreshMs);
    onSecurityRefreshIntervalChange(securityRefreshMs);
    renderSecurityTabBody(search);
  } catch (e) { c.innerHTML = `<div class="empty-state"><h3>Lỗi tải dữ liệu</h3><p>${e.message}</p></div>`; }
}

function onSecurityRefreshIntervalChange(val) {
  securityRefreshMs = Number(val) || 0;
  if (securityRefreshTimer) { clearInterval(securityRefreshTimer); securityRefreshTimer = null; }
  if (securityRefreshMs > 0) securityRefreshTimer = setInterval(refreshSecurityData, securityRefreshMs);
}

// Lighter than renderSecurity(): updates the stat numbers and the current tab's data in place,
// without rebuilding the toolbar/inputs — so an in-progress search/filter (or an edit in the
// "Quản lý VM giám sát" tab) doesn't get wiped out every 5-15s by auto-refresh.
async function refreshSecurityData() {
  if (currentPage !== 'security') { clearInterval(securityRefreshTimer); securityRefreshTimer = null; return; }
  try {
    const [stats, outboundStats] = await Promise.all([api('/security/stats'), api('/security/outbound/stats')]);
    // Re-check after the await — the user may have navigated away while these calls were in-flight.
    if (currentPage !== 'security') return;
    document.getElementById('secStatTotal').textContent = stats.total;
    document.getElementById('secStatAccepted').textContent = stats.accepted;
    document.getElementById('secStatFailed').textContent = stats.failed;
    document.getElementById('secStatForeign').textContent = stats.foreign;
    document.getElementById('secStatMonitored').textContent = stats.monitored;
    document.getElementById('secStatOutbound').innerHTML = `${outboundStats.foreignActive}<span style="font-size:13px;color:var(--fg-dim);font-weight:500"> / ${outboundStats.foreign} lịch sử</span>`;
  } catch { /* transient — next tick retries */ }
  if (currentPage !== 'security') return;
  if (securityTab === 'events') loadSecurityEvents();
  else if (securityTab === 'outbound') loadOutboundConnections();
}

function setSecurityTab(tab) {
  securityTab = tab;
  document.querySelectorAll('#securityTabs .filter-tab').forEach(t => t.classList.toggle('active', t.dataset.tab === tab));
  renderSecurityTabBody();
}

function renderSecurityTabBody(search = '') {
  if (securityTab === 'manage') renderSecurityManage();
  else if (securityTab === 'outbound') renderSecurityOutbound(search);
  else renderSecurityEvents(search);
}

function renderSecurityEvents(search = '') {
  const monitoredVms = securityState.vms.filter(v => v.ssh_user);
  document.getElementById('securityTabBody').innerHTML = `
    <div class="table-wrap">
      <div class="table-toolbar">
        <div class="search-box">
          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><circle cx="11" cy="11" r="8"/><path d="m21 21-4.35-4.35"/></svg>
          <input type="text" id="securitySearch" placeholder="Tìm theo VM, IP, user..." value="${search}">
        </div>
        <select class="filter-select" id="securityVmFilter" onchange="applySecurityFilter()">
          <option value="">Tất cả VM</option>
          ${monitoredVms.map(v => `<option value="${v.id}">${v.name}</option>`).join('')}
        </select>
        <select class="filter-select" id="securityTypeFilter" onchange="applySecurityFilter()">
          <option value="">Tất cả loại</option>
          <option value="accepted">Thành công</option>
          <option value="failed">Thất bại</option>
        </select>
        <label style="display:flex;align-items:center;gap:6px;font-size:13px;color:var(--fg-muted);cursor:pointer">
          <input type="checkbox" id="securityForeignOnly" onchange="applySecurityFilter()" style="width:auto"> Chỉ hiện cảnh báo nước ngoài
        </label>
      </div>
      <div id="securityEventsBody"><div class="loading"><div class="spinner"></div></div></div>
    </div>`;
  document.getElementById('securitySearch').addEventListener('input', () => {
    clearTimeout(searchTimeout);
    searchTimeout = setTimeout(() => { securityEventPagination.page = 1; loadSecurityEvents(); }, 300);
  });
  loadSecurityEvents(search);
}

function applySecurityFilter() {
  securityFilter.vmId = document.getElementById('securityVmFilter')?.value || '';
  securityFilter.eventType = document.getElementById('securityTypeFilter')?.value || '';
  securityFilter.foreignOnly = document.getElementById('securityForeignOnly')?.checked || false;
  securityEventPagination.page = 1;
  loadSecurityEvents();
}

let securityEventRows = [];
let securityEventSortState = { key: null, dir: 'asc' };
let securityEventPagination = newPagination();

// Does NOT reset securityEventPagination.page — also called by refreshSecurityData()'s periodic
// timer, same reasoning as loadAlertList()/loadVcenterTable() above. Only genuine filter/search
// changes reset to page 1 (search box handler, applySecurityFilter()).
async function loadSecurityEvents(search) {
  const s = search || document.getElementById('securitySearch')?.value || '';
  const params = new URLSearchParams({
    search: s, vmId: securityFilter.vmId, eventType: securityFilter.eventType,
    foreignOnly: securityFilter.foreignOnly ? 'true' : ''
  });
  try {
    securityEventRows = await api(`/security/events?${params}`);
    // Re-check after the await — auto-refresh may fire this while the user has already navigated
    // away, in which case securityEventsBody no longer exists.
    if (!document.getElementById('securityEventsBody')) return;
    renderSecurityEventRows();
  } catch (e) {
    const el = document.getElementById('securityEventsBody');
    if (el) el.innerHTML = `<div class="empty-state"><h3>Lỗi</h3><p>${e.message}</p></div>`;
  }
}

function toggleSecurityEventSort(key) {
  toggleSortState(securityEventSortState, key);
  renderSecurityEventRows();
}

function renderSecurityEventRows() {
  const body = document.getElementById('securityEventsBody');
  if (!securityEventRows.length) {
    body.innerHTML = `<div class="empty-state"><svg width="48" height="48" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5"><path d="M18 8a6 6 0 00-12 0c0 7-3 9-3 9h18s-3-2-3-9"/><path d="M13.73 21a2 2 0 01-3.46 0"/></svg><h3>Chưa có sự kiện SSH nào</h3><p>Bật giám sát cho VM ở tab "Quản lý VM giám sát"</p></div>`;
    return;
  }
  // No manual sort chosen yet -> keep the backend's order (foreign successful logins first).
  const sortedEvents = applySort(securityEventRows, securityEventSortState, (row, key) => row[key]);
  const events = paginateRows(sortedEvents, securityEventPagination);
  const rowOffset = (securityEventPagination.page - 1) * securityEventPagination.pageSize;
  body.innerHTML = `<table>
      <thead><tr><th>#</th>${thSort('Thời gian', 'occurred_at', securityEventSortState, 'toggleSecurityEventSort')}${thSort('VM', 'source_name', securityEventSortState, 'toggleSecurityEventSort')}${thSort('Loại', 'event_type', securityEventSortState, 'toggleSecurityEventSort')}${thSort('User', 'username', securityEventSortState, 'toggleSecurityEventSort')}${thSort('IP nguồn', 'src_ip', securityEventSortState, 'toggleSecurityEventSort')}${thSort('Quốc gia', 'country', securityEventSortState, 'toggleSecurityEventSort')}<th>Cảnh báo</th></tr></thead>
      <tbody>${events.map((ev, i) => {
        const isForeignLogin = ev.event_type === 'accepted' && ev.is_foreign;
        const recent = isForeignLogin && isRecentTimestamp(ev.occurred_at, 300000); // blink for ~5 min after detection
        return `
        <tr>
          <td style="color:var(--fg-dim)">${rowOffset + i + 1}</td>
          <td><span style="font-size:12px;color:var(--fg-muted)">${formatTime(ev.occurred_at)}</span></td>
          <td style="font-weight:600">${ev.source_name || '—'}</td>
          <td>${ev.event_type === 'accepted' ? '<span class="status online"><span class="dot"></span>Thành công</span>' : '<span class="status offline"><span class="dot"></span>Thất bại</span>'}</td>
          <td>${ev.username || '—'}</td>
          <td><span style="font-family:monospace">${ev.src_ip || '—'}</span></td>
          <td>${ev.country || '—'}</td>
          <td>${isForeignLogin ? `<span class="severity critical ${recent ? 'blink' : ''}"><span class="dot"></span>Đăng nhập từ nước ngoài</span>` : ''}</td>
        </tr>`;
      }).join('')}
      </tbody></table>${paginationBar(securityEventPagination, sortedEvents.length, 'securityEventPagination', 'renderSecurityEventRows')}`;
}

const outboundFilter = { vmId: '', foreignOnly: false };

function renderSecurityOutbound(search = '') {
  const monitoredVms = securityState.vms.filter(v => v.ssh_user);
  document.getElementById('securityTabBody').innerHTML = `
    <div class="table-wrap">
      <div class="table-toolbar">
        <div class="search-box">
          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><circle cx="11" cy="11" r="8"/><path d="m21 21-4.35-4.35"/></svg>
          <input type="text" id="outboundSearch" placeholder="Tìm theo VM, IP..." value="${search}">
        </div>
        <select class="filter-select" id="outboundVmFilter" onchange="applyOutboundFilter()">
          <option value="">Tất cả VM</option>
          ${monitoredVms.map(v => `<option value="${v.id}">${v.name}</option>`).join('')}
        </select>
        <label style="display:flex;align-items:center;gap:6px;font-size:13px;color:var(--fg-muted);cursor:pointer">
          <input type="checkbox" id="outboundForeignOnly" onchange="applyOutboundFilter()" style="width:auto"> Chỉ hiện kết nối ra nước ngoài
        </label>
      </div>
      <div id="outboundBody"><div class="loading"><div class="spinner"></div></div></div>
    </div>`;
  document.getElementById('outboundSearch').addEventListener('input', () => {
    clearTimeout(searchTimeout);
    searchTimeout = setTimeout(() => { outboundPagination.page = 1; loadOutboundConnections(); }, 300);
  });
  loadOutboundConnections(search);
}

function applyOutboundFilter() {
  outboundFilter.vmId = document.getElementById('outboundVmFilter')?.value || '';
  outboundFilter.foreignOnly = document.getElementById('outboundForeignOnly')?.checked || false;
  outboundPagination.page = 1;
  loadOutboundConnections();
}

let outboundRows = [];
let outboundSortState = { key: null, dir: 'asc' };
let outboundPagination = newPagination();

// Does NOT reset outboundPagination.page — also called by the periodic security-page auto-refresh
// timer, same reasoning as loadSecurityEvents() above.
async function loadOutboundConnections(search) {
  const s = search || document.getElementById('outboundSearch')?.value || '';
  const params = new URLSearchParams({ search: s, vmId: outboundFilter.vmId, foreignOnly: outboundFilter.foreignOnly ? 'true' : '' });
  try {
    outboundRows = await api(`/security/outbound?${params}`);
    // Re-check after the await — auto-refresh may fire this while the user has already navigated
    // away, in which case outboundBody no longer exists.
    if (!document.getElementById('outboundBody')) return;
    renderOutboundRows();
  } catch (e) {
    const el = document.getElementById('outboundBody');
    if (el) el.innerHTML = `<div class="empty-state"><h3>Lỗi</h3><p>${e.message}</p></div>`;
  }
}

function toggleOutboundSort(key) {
  toggleSortState(outboundSortState, key);
  renderOutboundRows();
}

function renderOutboundRows() {
  const body = document.getElementById('outboundBody');
  if (!outboundRows.length) {
    body.innerHTML = `<div class="empty-state"><svg width="48" height="48" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5"><path d="M5 12h14M13 6l6 6-6 6"/></svg><h3>Chưa ghi nhận kết nối ra ngoài nào</h3><p>Bật giám sát cho VM ở tab "Quản lý VM giám sát"</p></div>`;
    return;
  }
  // "Trạng thái" (active/closed) isn't a raw DB column — it's computed here from last_seen so it
  // can be used both for display and for sorting, same cutoff as the badge itself.
  const withActive = outboundRows.map(c => ({ ...c, is_active: isRecentTimestamp(c.last_seen, 150000) ? 1 : 0 }));

  let sortedConns;
  if (outboundSortState.key) {
    sortedConns = applySort(withActive, outboundSortState, (row, key) => key === 'is_active' ? row.is_active : row[key]);
  } else {
    // No manual sort chosen yet -> Đang mở + nước ngoài lên đầu tiên, rồi nước ngoài (đã đóng),
    // rồi Đang mở (nội bộ), còn lại xuống cuối.
    const priority = (r) => (r.is_active && r.is_foreign) ? 0 : (r.is_foreign ? 1 : (r.is_active ? 2 : 3));
    sortedConns = [...withActive].sort((a, b) => priority(a) - priority(b));
  }
  const conns = paginateRows(sortedConns, outboundPagination);
  const rowOffset = (outboundPagination.page - 1) * outboundPagination.pageSize;

  body.innerHTML = `<table>
      <thead><tr><th>#</th>${thSort('VM', 'vm_name', outboundSortState, 'toggleOutboundSort')}${thSort('Process', 'process_name', outboundSortState, 'toggleOutboundSort')}${thSort('IP đích', 'remote_ip', outboundSortState, 'toggleOutboundSort')}${thSort('Cổng', 'remote_port', outboundSortState, 'toggleOutboundSort')}${thSort('Quốc gia', 'country', outboundSortState, 'toggleOutboundSort')}${thSort('Lần đầu thấy', 'first_seen', outboundSortState, 'toggleOutboundSort')}${thSort('Lần cuối thấy', 'last_seen', outboundSortState, 'toggleOutboundSort')}${thSort('Trạng thái', 'is_active', outboundSortState, 'toggleOutboundSort')}<th>Cảnh báo</th></tr></thead>
      <tbody>${conns.map((c, i) => {
        const active = !!c.is_active;
        return `
        <tr>
          <td style="color:var(--fg-dim)">${rowOffset + i + 1}</td>
          <td style="font-weight:600">${c.vm_name || '—'}</td>
          <td>${c.process_name ? `<span style="font-family:monospace">${c.process_name}</span><span style="font-size:11px;color:var(--fg-dim)"> (PID ${c.pid})</span>` : '<span style="font-size:12px;color:var(--fg-dim)">không xác định</span>'}</td>
          <td><span style="font-family:monospace">${c.remote_ip}</span></td>
          <td>${c.remote_port ?? '—'}</td>
          <td>${c.country || '—'}</td>
          <td><span style="font-size:12px;color:var(--fg-muted)">${formatTime(c.first_seen)}</span></td>
          <td><span style="font-size:12px;color:var(--fg-muted)">${formatTime(c.last_seen)}</span></td>
          <td>${active ? '<span class="status online"><span class="dot"></span>Đang mở</span>' : '<span class="status offline"><span class="dot"></span>Đã đóng</span>'}</td>
          <td>${c.is_foreign ? `<span class="severity critical ${active ? 'blink' : ''}"><span class="dot"></span>IP lạ - nước ngoài</span>` : ''}</td>
        </tr>`;
      }).join('')}
      </tbody></table>${paginationBar(outboundPagination, sortedConns.length, 'outboundPagination', 'renderOutboundRows')}`;
}

let manageSortState = { key: null, dir: 'asc' };

function toggleManageSort(key) {
  toggleSortState(manageSortState, key);
  renderManageRows();
}

const FAIL2BAN_LABEL = {
  unknown: 'Chưa kiểm tra',
  not_installed: 'Chưa cài đặt',
  installed_not_running: 'Đã cài, chưa chạy',
  installing: 'Đang cài đặt…',
  running: 'Đang chạy',
  error: 'Lỗi'
};
const FAIL2BAN_CLASS = {
  unknown: 'unknown', not_installed: 'offline', installed_not_running: 'warning',
  installing: 'installing', running: 'online', error: 'offline'
};

function fail2banToggle(v) {
  const status = v.fail2ban_status || 'unknown';
  const monitored = !!v.ssh_user;
  const checked = status === 'running';
  const disabled = !monitored || status === 'installing';
  const extraClass = status === 'installing' ? 'installing' : (status === 'error' ? 'error' : '');
  const title = status === 'error' && v.fail2ban_error ? escAttr(v.fail2ban_error)
    : !monitored ? 'Bật giám sát SSH trước'
    : (FAIL2BAN_LABEL[status] || status);
  return `<label class="toggle-switch ${extraClass}" data-permission="security.fail2ban.manage" title="${title}">
      <input type="checkbox" ${checked ? 'checked' : ''} ${disabled ? 'disabled' : ''} onclick="handleFail2banToggle(event, ${v.id})">
      <span class="toggle-slider"></span>
    </label>`;
}

let managePagination = newPagination();
let manageSearchFilter = '';

function renderManageRows() {
  const wrap = document.getElementById('securityManageTableWrap');
  if (!wrap) return;
  const q = manageSearchFilter.trim().toLowerCase();
  const filteredVms = q
    ? securityState.vms.filter(v => (v.name || '').toLowerCase().includes(q) || (v.ip_address || '').toLowerCase().includes(q))
    : securityState.vms;
  if (!filteredVms.length) {
    wrap.innerHTML = `<div class="empty-state"><svg width="48" height="48" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5"><circle cx="11" cy="11" r="8"/><path d="m21 21-4.35-4.35"/></svg><h3>Không tìm thấy VM</h3><p>Thử đổi từ khóa tìm kiếm</p></div>`;
    return;
  }
  const sortedVms = applySort(filteredVms, manageSortState, (row, key) => row[key]);
  const vms = paginateRows(sortedVms, managePagination);
  const rowOffset = (managePagination.page - 1) * managePagination.pageSize;
  wrap.innerHTML = `<table>
        <thead><tr><th>#</th>${thSort('Tên VM', 'name', manageSortState, 'toggleManageSort')}${thSort('Trạng thái', 'power_state', manageSortState, 'toggleManageSort')}${thSort('IP', 'ip_address', manageSortState, 'toggleManageSort')}${thSort('Guest OS', 'guest_family', manageSortState, 'toggleManageSort')}<th>Tài khoản kết nối</th>${thSort('SSH Port', 'ssh_port', manageSortState, 'toggleManageSort')}${thSort('Fail2ban', 'fail2ban_status', manageSortState, 'toggleManageSort')}<th>Hành động</th></tr></thead>
        <tbody>${vms.map((v, i) => {
          const eligible = v.guest_family === 'LINUX' && v.ip_address;
          // Chưa gán tài khoản nào -> gợi ý sẵn tài khoản mặc định (vd "dev") thay vì để trống, đỡ
          // 1 bước chọn thủ công cho trường hợp phổ biến nhất (VM Linux mới, chưa từng bật giám
          // sát); VM đã có ssh_credential_id thì giữ đúng lựa chọn hiện tại, không bị ghi đè.
          const defaultCredId = securityCredentialOptions.find(cr => cr.is_default)?.id;
          const preselectedId = v.ssh_credential_id || (eligible ? defaultCredId : null);
          const credOptions = securityCredentialOptions.map(cr => `<option value="${cr.id}" ${preselectedId === cr.id ? 'selected' : ''}>${cr.name} (${cr.username})</option>`).join('');
          return `<tr>
            <td style="color:var(--fg-dim)">${rowOffset + i + 1}</td>
            <td style="font-weight:600">${v.name}</td>
            <td>${vcPowerBadge(v.power_state)}</td>
            <td>${v.ip_address || '—'}</td>
            <td>${v.guest_family || '—'}</td>
            <td><select class="sec-ssh-cred filter-select" data-id="${v.id}" style="max-width:170px" ${eligible ? '' : 'disabled'}>
              <option value="">— Không giám sát —</option>
              ${credOptions}
            </select></td>
            <td><input type="number" class="sec-ssh-port" data-id="${v.id}" value="${v.ssh_port || 22}" min="1" max="65535" style="max-width:90px" ${eligible ? '' : 'disabled'}></td>
            <td>${fail2banToggle(v)}</td>
            <td><button class="btn btn-secondary btn-sm" data-permission="security.ssh_config" ${eligible ? '' : 'disabled'} onclick="saveSecuritySshUser(${v.id}, this)">Lưu</button></td>
          </tr>`;
        }).join('')}</tbody>
      </table>${paginationBar(managePagination, sortedVms.length, 'managePagination', 'renderManageRows')}`;
}

async function refreshManageVms() {
  try {
    securityState.vms = await api('/security/vms');
  } catch { /* keep stale data, next manual retry will refetch */ }
  renderManageRows();
}

async function handleFail2banToggle(e, id) {
  e.preventDefault(); // decide the real outcome via the API first — checkbox visually reverts to its
  // pre-click state until refreshManageVms() re-renders it from confirmed server state
  const checkbox = e.target;
  const turningOn = checkbox.checked; // per checkbox activation behavior, .checked already reflects the attempted new state at this point
  const vm = securityState.vms.find(v => v.id === id);
  if (!vm) return;
  checkbox.disabled = true;
  try {
    if (turningOn) {
      const check = await api(`/security/vms/${id}/fail2ban/check`, 'POST');
      if (check.status === 'running') {
        toast(`fail2ban đang chạy trên "${vm.name}"`, 'success');
      } else {
        const reason = check.status === 'not_installed' ? 'chưa được cài đặt' : (check.error || 'chưa hoạt động');
        if (confirm(`fail2ban trên VM "${vm.name}" ${reason}. Tự động cài đặt/khởi động ngay bây giờ?`)) {
          const install = await api(`/security/vms/${id}/fail2ban/install`, 'POST');
          if (install.status === 'running') toast(`Đã cài đặt và khởi động fail2ban trên "${vm.name}"`, 'success');
          else toast(install.error || 'Cài đặt fail2ban thất bại', 'error');
        }
      }
    } else {
      if (confirm(`Tắt fail2ban trên VM "${vm.name}"? VM sẽ KHÔNG còn tự động chặn brute-force SSH cho đến khi bật lại.`)) {
        const stop = await api(`/security/vms/${id}/fail2ban/stop`, 'POST');
        if (stop.status === 'installed_not_running') toast(`Đã tắt fail2ban trên "${vm.name}"`, 'success');
        else toast(stop.error || 'Không tắt được fail2ban', 'error');
      }
    }
  } catch (err) {
    toast(err.message, 'error');
  } finally {
    await refreshManageVms();
  }
}

let securityCredentialOptions = [];

async function renderSecurityManage() {
  document.getElementById('securityTabBody').innerHTML = `<div class="loading"><div class="spinner"></div></div>`;
  try { securityCredentialOptions = await api('/ssh-credentials/options'); } catch { securityCredentialOptions = []; }
  document.getElementById('securityTabBody').innerHTML = `
    <div class="table-wrap">
      <div style="padding:14px 16px 0;font-size:13px;color:var(--fg-dim)">
        <p style="margin-bottom:8px">Chỉ VM Linux đã có IP (do VMware Tools báo cáo) mới bật giám sát được. Chọn 1 tài khoản kết nối (mục "Tài khoản kết nối" bên sidebar) rồi bấm Lưu — để trống rồi Lưu để tắt giám sát.</p>
        <p style="margin-bottom:6px">auth.log/secure chỉ root đọc được, và tên tiến trình đứng sau mỗi kết nối ra ngoài cũng cần root (<code>ss -p</code>) — trước khi bật giám sát, chạy trên VM đó (thay <code>USER</code> bằng username của tài khoản kết nối sẽ dùng):</p>
        <pre style="background:var(--surface2);border:1px solid var(--border);border-radius:var(--radius);padding:10px 12px;font-size:12px;overflow-x:auto;margin-bottom:10px">echo 'USER ALL=(root) NOPASSWD: /usr/bin/wc -l /var/log/auth.log, /usr/bin/wc -l /var/log/secure, /usr/bin/tail -n +* /var/log/auth.log, /usr/bin/tail -n +* /var/log/secure, /usr/bin/ss *' | sudo tee /etc/sudoers.d/netadmin-ssh-monitor</pre>
        <p style="margin-bottom:6px;font-size:12px">(Thiếu dòng <code>ss *</code> vẫn giám sát kết nối ra ngoài được, chỉ là không biết tên tiến trình — cột "Process" sẽ hiện "không xác định".)</p>
        <p style="margin-bottom:6px">Cột <strong>Fail2ban</strong>: bấm nút để kiểm tra VM đã cài fail2ban chưa; nếu chưa, hệ thống sẽ hỏi và tự cài đặt + khởi động qua sudo. Cần thêm quyền sudo cho các lệnh cài đặt (thay <code>USER</code> bằng username của tài khoản kết nối):</p>
        <pre style="background:var(--surface2);border:1px solid var(--border);border-radius:var(--radius);padding:10px 12px;font-size:12px;overflow-x:auto;margin-bottom:10px">echo 'USER ALL=(ALL) NOPASSWD: /usr/bin/apt-get, /usr/bin/dnf, /usr/bin/yum, /usr/bin/systemctl, /usr/bin/fail2ban-client' | sudo tee /etc/sudoers.d/netadmin-fail2ban-install</pre>
      </div>
      <div class="table-toolbar">
        <div class="search-box">
          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><circle cx="11" cy="11" r="8"/><path d="m21 21-4.35-4.35"/></svg>
          <input type="text" id="manageSearch" placeholder="Tìm theo tên VM, IP..." value="${manageSearchFilter}">
        </div>
      </div>
      <div id="securityManageTableWrap"></div>
    </div>`;
  document.getElementById('manageSearch').addEventListener('input', (e) => {
    clearTimeout(searchTimeout);
    searchTimeout = setTimeout(() => { manageSearchFilter = e.target.value; managePagination.page = 1; renderManageRows(); }, 300);
  });
  renderManageRows();
}

async function saveSecuritySshUser(id, btn) {
  const credSelect = document.querySelector(`.sec-ssh-cred[data-id="${id}"]`);
  const portInput = document.querySelector(`.sec-ssh-port[data-id="${id}"]`);
  const credentialId = credSelect.value || null;
  const sshPort = Number(portInput.value) || 22;
  btn.disabled = true;
  try {
    await api(`/security/vms/${id}/ssh-user`, 'PATCH', { credentialId, sshPort });
    toast(credentialId ? 'Đã bật giám sát SSH' : 'Đã tắt giám sát SSH', 'success');
    renderSecurity();
  } catch (e) { toast(e.message, 'error'); btn.disabled = false; }
}

// ─── USERS (Người dùng, cần quyền users.manage) ────────────────────────────────
let userRows = [];
let userSortState = { key: null, dir: 'asc' };
let userPagination = newPagination();
let cachedRoles = []; // refreshed each time the Users or Vai trò page loads — used to build the role <select>

async function renderUsers() {
  const c = document.getElementById('pageContent');
  c.innerHTML = `
    <div class="page-header">
      <div><div class="page-title">Người dùng</div><div class="page-subtitle">Quản lý tài khoản đăng nhập và phân quyền</div></div>
      <button class="btn btn-primary" onclick="openUserForm()">
        <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><line x1="12" y1="5" x2="12" y2="19"/><line x1="5" y1="12" x2="19" y2="12"/></svg>
        Thêm người dùng
      </button>
    </div>
    <div class="table-wrap"><div id="userTableBody"><div class="loading"><div class="spinner"></div></div></div></div>`;
  loadUserTable();
}

async function loadUserTable() {
  try {
    [userRows, cachedRoles] = await Promise.all([api('/users'), api('/roles')]);
    userPagination.page = 1;
    renderUserRows();
  } catch (e) { document.getElementById('userTableBody').innerHTML = `<div class="empty-state"><h3>Lỗi</h3><p>${e.message}</p></div>`; }
}

function toggleUserSort(key) {
  toggleSortState(userSortState, key);
  renderUserRows();
}

function renderUserRows() {
  const tbody = document.getElementById('userTableBody');
  if (!userRows.length) {
    tbody.innerHTML = `<div class="empty-state"><h3>Chưa có người dùng nào</h3></div>`;
    return;
  }
  const sortedUsers = applySort(userRows, userSortState, (row, key) => row[key]);
  const users = paginateRows(sortedUsers, userPagination);
  const rowOffset = (userPagination.page - 1) * userPagination.pageSize;
  tbody.innerHTML = `<table>
      <thead><tr><th>#</th>${thSort('Tên', 'name', userSortState, 'toggleUserSort')}${thSort('Email', 'email', userSortState, 'toggleUserSort')}${thSort('Vai trò', 'roleName', userSortState, 'toggleUserSort')}${thSort('Đăng nhập', 'auth_provider', userSortState, 'toggleUserSort')}${thSort('Trạng thái', 'status', userSortState, 'toggleUserSort')}${thSort('Đăng nhập lần cuối', 'last_login_at', userSortState, 'toggleUserSort')}<th>Hành động</th></tr></thead>
      <tbody>${users.map((u, i) => `
        <tr>
          <td style="color:var(--fg-dim)">${rowOffset + i + 1}</td>
          <td style="font-weight:600">${u.name}${u.id === currentUser.id ? ' <span style="font-size:11px;color:var(--fg-dim)">(bạn)</span>' : ''}</td>
          <td><span style="font-size:13px;color:var(--fg-muted)">${u.email}</span></td>
          <td><span class="user-role-badge">${u.roleName || '—'}</span></td>
          <td><span style="font-size:12px;color:var(--fg-muted)">${u.auth_provider.toUpperCase()}</span></td>
          <td>${u.status === 'active' ? '<span class="status online"><span class="dot"></span>Hoạt động</span>' : '<span class="status offline"><span class="dot"></span>Vô hiệu hóa</span>'}</td>
          <td><span style="font-size:12px;color:var(--fg-muted)">${u.last_login_at ? formatTime(u.last_login_at) : 'Chưa đăng nhập'}</span></td>
          <td><div class="actions">
            <button class="btn-icon edit" title="Sửa" data-permission="users.manage" onclick='openUserForm(${JSON.stringify(u).replace(/'/g, "&#39;")})'><svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M11 4H4a2 2 0 00-2 2v14a2 2 0 002 2h14a2 2 0 002-2v-7"/><path d="M18.5 2.5a2.121 2.121 0 013 3L12 15l-4 1 1-4 9.5-9.5z"/></svg></button>
            ${u.id !== currentUser.id ? `<button class="btn-icon delete" title="Xóa" onclick="deleteUser(${u.id}, '${escAttr(u.name)}')"><svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><polyline points="3 6 5 6 21 6"/><path d="M19 6l-1 14a2 2 0 01-2 2H8a2 2 0 01-2-2L5 6"/><path d="M10 11v6M14 11v6"/></svg></button>` : ''}
          </div></td>
        </tr>`).join('')}
      </tbody></table>${paginationBar(userPagination, sortedUsers.length, 'userPagination', 'renderUserRows')}`;
}

function openUserForm(user) {
  const u = typeof user === 'string' ? JSON.parse(user) : user;
  const isEdit = u && u.id;
  const isLocal = !isEdit || u.auth_provider === 'local';
  const roleOptions = cachedRoles.map(r =>
    `<option value="${r.id}" ${u?.role_id === r.id ? 'selected' : ''}>${r.name}${r.is_system ? '' : ' (tùy biến)'} — ${r.permissions.length} quyền</option>`
  ).join('');
  openModal(isEdit ? 'Sửa người dùng' : 'Thêm người dùng', `
    <form id="userForm" onsubmit="saveUser(event, ${isEdit ? u.id : 'null'})">
      <div class="form-grid">
        <div class="form-group full"><label>Tên *</label><input type="text" name="name" value="${u?.name || ''}" required></div>
        <div class="form-group full"><label>Email *</label><input type="email" name="email" value="${u?.email || ''}" required ${isEdit ? 'disabled' : ''}></div>
        <div class="form-group"><label>Vai trò</label>
          <select name="roleId" class="form-select">${roleOptions}</select></div>
        ${!isEdit ? `<div class="form-group full"><label>Mật khẩu * (tối thiểu 8 ký tự)</label><input type="password" name="password" required minlength="8"></div>` : ''}
        ${isEdit ? `<div class="form-group"><label>Trạng thái</label>
          <select name="status" class="form-select">
            <option value="active" ${u?.status === 'active' ? 'selected' : ''}>Hoạt động</option>
            <option value="disabled" ${u?.status === 'disabled' ? 'selected' : ''}>Vô hiệu hóa</option>
          </select></div>` : ''}
      </div>
      ${isEdit && isLocal ? `
      <div class="form-group full" style="margin-top:10px">
        <label>Đặt lại mật khẩu (để trống nếu không đổi)</label>
        <input type="password" name="newPassword" minlength="8" placeholder="Tối thiểu 8 ký tự">
      </div>` : ''}
      <div class="form-actions">
        <button type="button" class="btn btn-secondary" onclick="closeModal()">Hủy</button>
        <button type="submit" class="btn btn-primary">${isEdit ? 'Cập nhật' : 'Thêm mới'}</button>
      </div>
    </form>`);
}

async function saveUser(e, id) {
  e.preventDefault();
  const fd = new FormData(e.target);
  const btn = e.target.querySelector('button[type=submit]');
  btn.disabled = true;
  const roleId = Number(fd.get('roleId')) || null;
  try {
    if (id) {
      await api(`/users/${id}`, 'PATCH', { name: fd.get('name'), roleId, status: fd.get('status') });
      const newPassword = fd.get('newPassword');
      if (newPassword) await api(`/users/${id}/reset-password`, 'POST', { password: newPassword });
      toast('Đã cập nhật người dùng', 'success');
    } else {
      await api('/users', 'POST', { name: fd.get('name'), email: fd.get('email'), password: fd.get('password'), roleId });
      toast('Đã thêm người dùng', 'success');
    }
    closeModal();
    loadUserTable();
  } catch (err) {
    toast(err.message, 'error');
    btn.disabled = false;
  }
}

async function deleteUser(id, name) {
  if (!confirm(`Xóa người dùng "${name}"?`)) return;
  try {
    await api(`/users/${id}`, 'DELETE');
    toast('Đã xóa người dùng', 'success');
    loadUserTable();
  } catch (e) { toast(e.message, 'error'); }
}

// ─── VAI TRÒ (Roles, cần quyền roles.manage) ───────────────────────────────────
let roleRows = [];
let permissionCatalog = [];
let rolePagination = newPagination();

async function renderRoles() {
  const c = document.getElementById('pageContent');
  c.innerHTML = `
    <div class="page-header">
      <div><div class="page-title">Vai trò</div><div class="page-subtitle">Tạo vai trò tùy biến với từng quyền bật/tắt riêng lẻ</div></div>
      <button class="btn btn-primary" onclick="openRoleForm()">
        <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><line x1="12" y1="5" x2="12" y2="19"/><line x1="5" y1="12" x2="19" y2="12"/></svg>
        Tạo vai trò
      </button>
    </div>
    <div class="table-wrap"><div id="roleTableBody"><div class="loading"><div class="spinner"></div></div></div></div>`;
  loadRoleTable();
}

async function loadRoleTable() {
  try {
    [roleRows, permissionCatalog] = await Promise.all([api('/roles'), api('/roles/permissions')]);
    cachedRoles = roleRows; // keep the Users page's role <select> in sync with the latest edits
    rolePagination.page = 1;
    renderRoleRows();
  } catch (e) { document.getElementById('roleTableBody').innerHTML = `<div class="empty-state"><h3>Lỗi</h3><p>${e.message}</p></div>`; }
}

function renderRoleRows() {
  const tbody = document.getElementById('roleTableBody');
  const roles = paginateRows(roleRows, rolePagination);
  const rowOffset = (rolePagination.page - 1) * rolePagination.pageSize;
  tbody.innerHTML = `<table>
      <thead><tr><th>#</th><th>Tên vai trò</th><th>Số quyền</th><th>Số user</th><th>Loại</th><th>Hành động</th></tr></thead>
      <tbody>${roles.map((r, i) => `
        <tr>
          <td style="color:var(--fg-dim)">${rowOffset + i + 1}</td>
          <td style="font-weight:600">${r.name}</td>
          <td>${r.permissions.length} / ${permissionCatalog.length}</td>
          <td>${r.userCount}</td>
          <td>${r.is_system ? '<span class="status unknown"><span class="dot"></span>Hệ thống</span>' : '<span class="status online"><span class="dot"></span>Tùy biến</span>'}</td>
          <td><div class="actions">
            <button class="btn-icon edit" title="${r.is_system ? 'Vai trò hệ thống không thể sửa' : 'Sửa'}" ${r.is_system ? 'disabled' : ''} onclick='openRoleForm(${JSON.stringify(r).replace(/'/g, "&#39;")})'><svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M11 4H4a2 2 0 00-2 2v14a2 2 0 002 2h14a2 2 0 002-2v-7"/><path d="M18.5 2.5a2.121 2.121 0 013 3L12 15l-4 1 1-4 9.5-9.5z"/></svg></button>
            <button class="btn-icon delete" title="${r.is_system ? 'Vai trò hệ thống không thể xóa' : 'Xóa'}" ${r.is_system ? 'disabled' : ''} onclick="deleteRoleEntry(${r.id}, '${escAttr(r.name)}')"><svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><polyline points="3 6 5 6 21 6"/><path d="M19 6l-1 14a2 2 0 01-2 2H8a2 2 0 01-2-2L5 6"/><path d="M10 11v6M14 11v6"/></svg></button>
          </div></td>
        </tr>`).join('')}
      </tbody></table>${paginationBar(rolePagination, roleRows.length, 'rolePagination', 'renderRoleRows')}`;
}

function openRoleForm(role) {
  const r = typeof role === 'string' ? JSON.parse(role) : role;
  const isEdit = r && r.id;
  const groups = {};
  for (const p of permissionCatalog) (groups[p.group] ||= []).push(p);
  const groupsHtml = Object.entries(groups).map(([group, perms]) => `
    <div class="perm-group">
      <div class="perm-group-title">${group}</div>
      ${perms.map(p => `
        <label class="perm-checkbox">
          <input type="checkbox" name="perm" value="${p.key}" ${r?.permissions?.includes(p.key) ? 'checked' : ''}>
          ${p.label}
        </label>`).join('')}
    </div>`).join('');
  openModal(isEdit ? `Sửa vai trò: ${r.name}` : 'Tạo vai trò', `
    <form id="roleForm" onsubmit="saveRole(event, ${isEdit ? r.id : 'null'})">
      <div class="form-group full"><label>Tên vai trò *</label><input type="text" name="name" value="${r?.name || ''}" required></div>
      <div class="form-group full" style="margin-top:10px"><label>Quyền</label>
        <div class="perm-groups">${groupsHtml}</div>
      </div>
      <div class="form-actions">
        <button type="button" class="btn btn-secondary" onclick="closeModal()">Hủy</button>
        <button type="submit" class="btn btn-primary">${isEdit ? 'Cập nhật' : 'Tạo vai trò'}</button>
      </div>
    </form>`);
}

async function saveRole(e, id) {
  e.preventDefault();
  const form = e.target;
  const btn = form.querySelector('button[type=submit]');
  btn.disabled = true;
  const name = form.querySelector('[name=name]').value;
  const permissions = [...form.querySelectorAll('[name=perm]:checked')].map(el => el.value);
  try {
    if (id) await api(`/roles/${id}`, 'PUT', { name, permissions });
    else await api('/roles', 'POST', { name, permissions });
    toast(id ? 'Đã cập nhật vai trò' : 'Đã tạo vai trò', 'success');
    closeModal();
    loadRoleTable();
  } catch (err) {
    toast(err.message, 'error');
    btn.disabled = false;
  }
}

async function deleteRoleEntry(id, name) {
  if (!confirm(`Xóa vai trò "${name}"?`)) return;
  try {
    await api(`/roles/${id}`, 'DELETE');
    toast('Đã xóa vai trò', 'success');
    loadRoleTable();
  } catch (e) { toast(e.message, 'error'); }
}

// ─── SSH CREDENTIALS (Tài khoản kết nối, cần quyền ssh_credentials.manage) ─────
let credentialRows = [];
let credentialPagination = newPagination();

async function renderCredentials() {
  const c = document.getElementById('pageContent');
  c.innerHTML = `<div class="loading"><div class="spinner"></div> Đang tải...</div>`;
  try {
    credentialRows = await api('/ssh-credentials');
    credentialPagination.page = 1;
    c.innerHTML = `
    <div class="page-header">
      <div><div class="page-title">Tài khoản kết nối</div><div class="page-subtitle">Quản lý tài khoản SSH (private key hoặc mật khẩu) dùng để kết nối vào máy chủ/VM</div></div>
      <button class="btn btn-primary" onclick="openCredentialForm()">
        <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><line x1="12" y1="5" x2="12" y2="19"/><line x1="5" y1="12" x2="19" y2="12"/></svg>
        Thêm tài khoản
      </button>
    </div>
    <div class="table-wrap"><div id="credentialTableBody"></div></div>`;
    renderCredentialRows();
  } catch (e) { c.innerHTML = `<div class="empty-state"><h3>Lỗi tải dữ liệu</h3><p>${e.message}</p></div>`; }
}

function credentialAuthBadge(type) {
  return type === 'password' ? `<span class="tag">Mật khẩu</span>` : `<span class="tag">Private Key</span>`;
}

function renderCredentialRows() {
  const tbody = document.getElementById('credentialTableBody');
  if (!credentialRows.length) {
    tbody.innerHTML = `<div class="empty-state"><svg width="48" height="48" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5"><rect x="3" y="11" width="18" height="11" rx="2"/><path d="M7 11V7a5 5 0 0110 0v4"/></svg><h3>Chưa có tài khoản kết nối nào</h3><p>Thêm tài khoản SSH (private key hoặc mật khẩu) để dùng cho giám sát máy chủ/VM</p></div>`;
    return;
  }
  const rows = paginateRows(credentialRows, credentialPagination);
  const rowOffset = (credentialPagination.page - 1) * credentialPagination.pageSize;
  tbody.innerHTML = `<table>
      <thead><tr><th>#</th><th>Tên</th><th>Loại</th><th>Username</th><th>Mặc định</th><th>Đang dùng</th><th>Ghi chú</th><th>Hành động</th></tr></thead>
      <tbody>${rows.map((cr, i) => `
        <tr>
          <td style="color:var(--fg-dim)">${rowOffset + i + 1}</td>
          <td style="font-weight:600">${cr.name}</td>
          <td>${credentialAuthBadge(cr.auth_type)}</td>
          <td style="font-family:'Fira Code',monospace;font-size:13px">${cr.username}</td>
          <td>${cr.is_default ? '<span class="status online"><span class="dot"></span>Mặc định</span>' : ''}</td>
          <td>${cr.usage_count} máy</td>
          <td style="font-size:12px;color:var(--fg-muted)">${cr.notes || ''}</td>
          <td><div class="actions">
            <button class="btn-icon edit" title="Sửa" onclick='openCredentialForm(${JSON.stringify(cr).replace(/'/g, "&#39;")})'><svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M11 4H4a2 2 0 00-2 2v14a2 2 0 002 2h14a2 2 0 002-2v-7"/><path d="M18.5 2.5a2.121 2.121 0 013 3L12 15l-4 1 1-4 9.5-9.5z"/></svg></button>
            <button class="btn-icon delete" title="Xóa" onclick="deleteCredentialEntry(${cr.id}, '${escAttr(cr.name)}', ${cr.usage_count})"><svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><polyline points="3 6 5 6 21 6"/><path d="M19 6l-1 14a2 2 0 01-2 2H8a2 2 0 01-2-2L5 6"/><path d="M10 11v6M14 11v6"/></svg></button>
          </div></td>
        </tr>`).join('')}
      </tbody></table>${paginationBar(credentialPagination, credentialRows.length, 'credentialPagination', 'renderCredentialRows')}`;
}

function openCredentialForm(cred) {
  const cr = typeof cred === 'string' ? JSON.parse(cred) : cred;
  const isEdit = cr && cr.id;
  const authType = cr?.auth_type || 'private_key';
  openModal(isEdit ? `Sửa tài khoản — ${cr.name}` : 'Thêm tài khoản kết nối', `
    <form id="credentialForm" onsubmit="saveCredential(event, ${isEdit ? cr.id : 'null'})">
      <div class="form-grid">
        <div class="form-group full"><label>Tên *</label><input type="text" name="name" value="${cr?.name || ''}" required placeholder="vd: dev, root-key, win-admin"></div>
        <div class="form-group full"><label>Loại xác thực</label>
          <select name="auth_type" class="form-select" onchange="onCredentialAuthTypeChange(this.value)">
            <option value="private_key" ${authType === 'private_key' ? 'selected' : ''}>Private Key (SSH)</option>
            <option value="password" ${authType === 'password' ? 'selected' : ''}>Mật khẩu</option>
          </select>
        </div>
        <div class="form-group full"><label>Username *</label><input type="text" name="username" value="${cr?.username || ''}" required placeholder="dev"></div>
      </div>
      <div id="credAuthFields-private_key" style="display:${authType === 'password' ? 'none' : 'block'};margin-top:10px">
        <div class="form-group full"><label>Private Key ${isEdit ? '(để trống nếu giữ nguyên)' : '*'}</label><textarea name="private_key" rows="6" style="font-family:'Fira Code',monospace;font-size:12px" placeholder="${isEdit && cr?.has_private_key ? '(đã có key — để trống để giữ nguyên)' : '-----BEGIN OPENSSH PRIVATE KEY-----...'}"></textarea></div>
        <div class="form-group full"><label>Passphrase (nếu key có mật khẩu, để trống nếu không đổi)</label><input type="password" name="passphrase" autocomplete="new-password"></div>
      </div>
      <div id="credAuthFields-password" style="display:${authType === 'password' ? 'block' : 'none'};margin-top:10px">
        <div class="form-group full"><label>Mật khẩu ${isEdit ? '(để trống nếu giữ nguyên)' : '*'}</label><input type="password" name="password" placeholder="${isEdit && cr?.has_password ? '••••••••' : ''}" autocomplete="new-password"></div>
      </div>
      <div class="form-group full" style="margin-top:10px">
        <label style="text-transform:none;font-size:14px"><input type="checkbox" name="is_default" ${cr?.is_default ? 'checked' : ''} style="width:auto;margin-right:6px"> Đặt làm mặc định (gợi ý sẵn khi bật giám sát SSH cho VM Linux mới)</label>
      </div>
      <div class="form-group full" style="margin-top:10px"><label>Ghi chú</label><textarea name="notes" rows="2">${cr?.notes || ''}</textarea></div>
      <div style="margin-top:10px">
        <div style="display:flex;gap:8px;align-items:center;flex-wrap:wrap">
          <input type="text" id="credTestHost" placeholder="IP/host để kiểm tra" style="max-width:180px">
          <input type="number" id="credTestPort" placeholder="Port" value="22" style="max-width:80px">
          <button type="button" class="btn btn-secondary btn-sm" onclick="testCredentialConnection(${isEdit ? cr.id : 'null'})">Kiểm tra kết nối</button>
        </div>
        <div id="credTestResult" style="margin-top:6px;font-size:13px"></div>
      </div>
      <div class="form-actions">
        <button type="button" class="btn btn-secondary" onclick="closeModal()">Hủy</button>
        <button type="submit" class="btn btn-primary">${isEdit ? 'Lưu thay đổi' : 'Thêm tài khoản'}</button>
      </div>
    </form>`);
}

function onCredentialAuthTypeChange(type) {
  document.getElementById('credAuthFields-private_key').style.display = type === 'password' ? 'none' : 'block';
  document.getElementById('credAuthFields-password').style.display = type === 'password' ? 'block' : 'none';
}

async function testCredentialConnection(id) {
  const host = document.getElementById('credTestHost').value.trim();
  const port = Number(document.getElementById('credTestPort').value) || 22;
  const resultEl = document.getElementById('credTestResult');
  if (!host) { resultEl.innerHTML = `<span style="color:var(--yellow)">Nhập host để kiểm tra</span>`; return; }
  if (!id) {
    resultEl.innerHTML = `<span style="color:var(--yellow)">Lưu tài khoản trước, sau đó bấm "Kiểm tra kết nối" lại ở trang danh sách</span>`;
    return;
  }
  resultEl.innerHTML = `<span style="color:var(--fg-dim)">Đang kiểm tra...</span>`;
  try {
    const result = await api('/ssh-credentials/test', 'POST', { credentialId: id, host, port });
    resultEl.innerHTML = result.ok ? `<span style="color:var(--accent)">✓ ${result.message}</span>` : `<span style="color:var(--red)">✗ ${result.message}</span>`;
  } catch (e) {
    resultEl.innerHTML = `<span style="color:var(--red)">✗ ${e.message}</span>`;
  }
}

async function saveCredential(e, id) {
  e.preventDefault();
  const form = e.target;
  const btn = form.querySelector('button[type=submit]');
  btn.disabled = true;
  const fd = new FormData(form);
  const payload = {
    name: fd.get('name'), auth_type: fd.get('auth_type'), username: fd.get('username'),
    private_key: fd.get('private_key') || '', passphrase: fd.get('passphrase') || '',
    password: fd.get('password') || '', is_default: fd.get('is_default') === 'on', notes: fd.get('notes') || ''
  };
  try {
    if (id) await api(`/ssh-credentials/${id}`, 'PUT', payload);
    else await api('/ssh-credentials', 'POST', payload);
    toast(id ? 'Đã cập nhật tài khoản' : 'Đã thêm tài khoản', 'success');
    closeModal();
    renderCredentials();
  } catch (err) {
    toast(err.message, 'error');
    btn.disabled = false;
  }
}

async function deleteCredentialEntry(id, name, usageCount) {
  if (usageCount > 0) { toast(`Đang được dùng bởi ${usageCount} máy chủ/VM — gỡ hết trước khi xóa`, 'error'); return; }
  if (!confirm(`Xóa tài khoản kết nối "${name}"?`)) return;
  try {
    await api(`/ssh-credentials/${id}`, 'DELETE');
    toast('Đã xóa tài khoản', 'success');
    renderCredentials();
  } catch (e) { toast(e.message, 'error'); }
}

// ─── SETTINGS (Cài đặt hệ thống — AI key, SSO, cần quyền settings.manage) ──────
async function renderSettings() {
  const c = document.getElementById('pageContent');
  c.innerHTML = `<div class="loading"><div class="spinner"></div> Đang tải...</div>`;
  try {
    const s = await api('/settings');
    c.innerHTML = `
    <div class="page-header">
      <div><div class="page-title">Cài đặt</div><div class="page-subtitle">Cấu hình AI key và đăng nhập SSO — lưu trong cơ sở dữ liệu, có hiệu lực ngay không cần khởi động lại server</div></div>
    </div>
    <form id="settingsForm" onsubmit="saveSettings(event)" style="max-width:700px">
      <div class="card" style="margin-bottom:16px">
        <div class="card-title">Trợ lý AI (Chatbot)</div>
        <div class="form-grid">
          <div class="form-group full"><label>Anthropic API Key ${s.has_anthropic_api_key ? '(để trống nếu giữ nguyên)' : ''}</label>
            <input type="password" name="anthropic_api_key" placeholder="${s.has_anthropic_api_key ? '••••••••' : 'sk-ant-...'}" autocomplete="new-password"></div>
        </div>
      </div>
      <div class="card" style="margin-bottom:16px">
        <div class="card-title">SAML SSO</div>
        <div class="form-grid">
          <div class="form-group full"><label>IdP Entry Point (URL)</label><input type="text" name="saml_idp_entry_point" value="${s.saml_idp_entry_point || ''}" placeholder="https://idp.example.com/sso"></div>
          <div class="form-group full"><label>IdP Certificate ${s.has_saml_cert ? '(để trống nếu giữ nguyên)' : ''}</label>
            <textarea name="saml_idp_cert" rows="5" style="font-family:'Fira Code',monospace;font-size:12px" placeholder="${s.has_saml_cert ? '(đã có chứng chỉ — để trống để giữ nguyên)' : '-----BEGIN CERTIFICATE-----...'}"></textarea></div>
          <div class="form-group"><label>SP Entity ID</label><input type="text" name="saml_sp_entity_id" value="${s.saml_sp_entity_id || 'netadmin-pro'}"></div>
          <div class="form-group"><label>SP Callback URL</label><input type="text" name="saml_sp_callback_url" value="${s.saml_sp_callback_url || ''}" placeholder="https://your-domain/api/auth/saml/callback"></div>
        </div>
      </div>
      <div class="card" style="margin-bottom:16px">
        <div class="card-title">LDAP / Active Directory</div>
        <div class="form-grid">
          <div class="form-group full"><label>LDAP URL</label><input type="text" name="ldap_url" value="${s.ldap_url || ''}" placeholder="ldap://dc.example.local"></div>
          <div class="form-group"><label>Bind DN (tài khoản dịch vụ)</label><input type="text" name="ldap_bind_dn" value="${s.ldap_bind_dn || ''}" placeholder="cn=svc,dc=example,dc=local"></div>
          <div class="form-group"><label>Bind Password ${s.has_ldap_bind_password ? '(để trống nếu giữ nguyên)' : ''}</label>
            <input type="password" name="ldap_bind_password" placeholder="${s.has_ldap_bind_password ? '••••••••' : ''}" autocomplete="new-password"></div>
          <div class="form-group full"><label>Base DN</label><input type="text" name="ldap_base_dn" value="${s.ldap_base_dn || ''}" placeholder="dc=example,dc=local"></div>
          <div class="form-group full"><label>User Filter</label><input type="text" name="ldap_user_filter" value="${s.ldap_user_filter || '(sAMAccountName={{username}})'}"></div>
        </div>
      </div>
      <div class="form-actions">
        <button type="submit" class="btn btn-primary">Lưu cài đặt</button>
      </div>
    </form>`;
  } catch (e) { c.innerHTML = `<div class="empty-state"><h3>Lỗi tải dữ liệu</h3><p>${e.message}</p></div>`; }
}

async function saveSettings(e) {
  e.preventDefault();
  const btn = e.target.querySelector('button[type=submit]');
  btn.disabled = true;
  const fd = new FormData(e.target);
  const payload = Object.fromEntries(fd);
  try {
    await api('/settings', 'PUT', payload);
    toast('Đã lưu cài đặt', 'success');
    renderSettings();
  } catch (err) {
    toast(err.message, 'error');
    btn.disabled = false;
  }
}

// ─── pfSense (tường lửa) ────────────────────────────────────────────────────
let pfsenseTab = 'status';
let pfsenseFirewallId = null;
let pfsenseFirewallsCache = [];
let pfsenseInterfacesCache = [];
let pfsenseRulesCache = [];
let pfsenseRulesPagination = newPagination(20);
let pfsenseRulesSearch = '';
let pfsenseRulesSortState = { key: null, dir: 'asc' };

function togglePfsenseRulesSort(key) {
  toggleSortState(pfsenseRulesSortState, key);
  renderPfsenseRulesTable();
}

async function renderPfsense() {
  const c = document.getElementById('pageContent');
  c.innerHTML = `<div class="loading"><div class="spinner"></div> Đang tải...</div>`;
  try {
    pfsenseFirewallsCache = await api('/pfsense/firewalls');
    if (!pfsenseFirewallsCache.find(f => f.id === pfsenseFirewallId)) {
      pfsenseFirewallId = pfsenseFirewallsCache[0]?.id || null;
    }
    // Chưa có firewall nào -> mở thẳng tab Kết nối thay vì các tab đọc dữ liệu trống khó hiểu.
    if (!pfsenseFirewallsCache.length) pfsenseTab = 'firewalls';
    c.innerHTML = `
    <div class="page-header">
      <div><div class="page-title">pfSense</div><div class="page-subtitle">Quản lý firewall pfSense qua REST API — trạng thái, rule, VPN</div></div>
      <div style="display:flex;gap:8px;align-items:center">
        <select class="filter-select" id="pfsenseRefreshSelect" onchange="onPfsenseRefreshIntervalChange(this.value)">
          <option value="0">Tự động: Tắt</option>
          <option value="5000">Auto (5s)</option>
          <option value="10000">10s</option>
          <option value="15000">15s</option>
        </select>
        ${pfsenseFirewallsCache.length ? `<select class="filter-select" id="pfsenseFirewallSelect" onchange="onPfsenseFirewallChange(this.value)">
          ${pfsenseFirewallsCache.map(f => `<option value="${f.id}" ${f.id === pfsenseFirewallId ? 'selected' : ''}>${f.name}</option>`).join('')}
        </select>` : ''}
      </div>
    </div>
    <div class="filter-tabs" id="pfsenseTabs" style="margin-bottom:16px">
      <div class="filter-tab ${pfsenseTab === 'status' ? 'active' : ''}" data-tab="status" onclick="setPfsenseTab('status')">Trạng thái</div>
      <div class="filter-tab ${pfsenseTab === 'rules' ? 'active' : ''}" data-tab="rules" onclick="setPfsenseTab('rules')">Rule tường lửa</div>
      <div class="filter-tab ${pfsenseTab === 'vpn' ? 'active' : ''}" data-tab="vpn" onclick="setPfsenseTab('vpn')">VPN</div>
      <div class="filter-tab ${pfsenseTab === 'ovpn-users' ? 'active' : ''}" data-tab="ovpn-users" onclick="setPfsenseTab('ovpn-users')" data-permission="pfsense.vpn.manage">Người dùng OpenVPN</div>
      <div class="filter-tab ${pfsenseTab === 'firewalls' ? 'active' : ''}" data-tab="firewalls" onclick="setPfsenseTab('firewalls')" data-permission="pfsense.manage">Kết nối pfSense</div>
    </div>
    <div id="pfsenseTabBody"></div>`;
    document.getElementById('pfsenseRefreshSelect').value = String(pfsenseRefreshMs);
    onPfsenseRefreshIntervalChange(pfsenseRefreshMs);
    applyPermissionVisibility();
    renderPfsenseTabBody();
  } catch (e) { c.innerHTML = `<div class="empty-state"><h3>Lỗi tải dữ liệu</h3><p>${e.message}</p></div>`; }
}

function onPfsenseFirewallChange(id) {
  pfsenseFirewallId = Number(id);
  renderPfsenseTabBody();
}

function setPfsenseTab(tab) {
  pfsenseTab = tab;
  document.querySelectorAll('#pfsenseTabs .filter-tab').forEach(t => t.classList.toggle('active', t.dataset.tab === tab));
  renderPfsenseTabBody();
}

let pfsenseRefreshMs = 5000;
let pfsenseRefreshTimer = null;

function onPfsenseRefreshIntervalChange(val) {
  pfsenseRefreshMs = Number(val) || 0;
  if (pfsenseRefreshTimer) { clearInterval(pfsenseRefreshTimer); pfsenseRefreshTimer = null; }
  if (pfsenseRefreshMs > 0) pfsenseRefreshTimer = setInterval(refreshPfsenseData, pfsenseRefreshMs);
}

// Only refreshes the currently active tab's data in place (see loadPfsenseStatusData()/
// loadPfsenseVpnData()/renderPfsenseRulesTable() above) — never the connection-management tab,
// since that one is Admin-only CRUD with forms that a background refresh could disrupt mid-edit.
// Also skips entirely while a modal is open, for the same reason.
async function refreshPfsenseData() {
  if (currentPage !== 'pfsense') { clearInterval(pfsenseRefreshTimer); pfsenseRefreshTimer = null; return; }
  if (!pfsenseFirewallId) return;
  if (document.getElementById('modalOverlay')?.classList.contains('open')) return;
  try {
    if (pfsenseTab === 'status') await loadPfsenseStatusData();
    else if (pfsenseTab === 'vpn') await loadPfsenseVpnData();
    else if (pfsenseTab === 'rules') {
      pfsenseRulesCache = await api(`/pfsense/firewalls/${pfsenseFirewallId}/rules`);
      renderPfsenseRulesTable();
    } else if (pfsenseTab === 'ovpn-users' && document.getElementById('pfsenseOvpnUsersBody')) {
      pfsenseOvpnUsersCache = await api(`/pfsense/firewalls/${pfsenseFirewallId}/openvpn/users`);
      renderPfsenseOvpnUsersTable();
    }
  } catch { /* transient — next tick retries */ }
}

function renderPfsenseTabBody() {
  if (pfsenseTab === 'firewalls') return renderPfsenseFirewallsTab();
  if (!pfsenseFirewallId) {
    document.getElementById('pfsenseTabBody').innerHTML = `<div class="empty-state"><h3>Chưa có firewall pfSense nào</h3><p>Vào tab "Kết nối pfSense" để thêm</p></div>`;
    return;
  }
  if (pfsenseTab === 'status') return renderPfsenseStatusTab();
  if (pfsenseTab === 'rules') return renderPfsenseRulesTab();
  if (pfsenseTab === 'vpn') return renderPfsenseVpnTab();
  if (pfsenseTab === 'ovpn-users') return renderPfsenseOvpnUsersTab();
}

// ── Tab: Trạng thái ──
// Skeleton is built once (with stable ids) by renderPfsenseStatusTab(); loadPfsenseStatusData()
// only updates those elements' content in place — reused by the 5s auto-refresh timer so it
// doesn't flash a loading spinner over the whole tab every tick (same convention as
// refreshSecurityData()).
async function renderPfsenseStatusTab() {
  const body = document.getElementById('pfsenseTabBody');
  body.innerHTML = `
    <div class="stats-grid">
      <div class="stat-card">
        <div class="stat-icon blue"><svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><rect x="4" y="4" width="16" height="16" rx="2"/><path d="M9 9h6v6H9z"/></svg></div>
        <div class="stat-label">CPU</div>
        <div class="stat-value blue" id="pfStatCpu">—</div>
      </div>
      <div class="stat-card">
        <div class="stat-icon green"><svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M6 2h9l5 5v13a2 2 0 01-2 2H6a2 2 0 01-2-2V4a2 2 0 012-2z"/></svg></div>
        <div class="stat-label">RAM</div>
        <div class="stat-value green" id="pfStatRam">—</div>
      </div>
      <div class="stat-card">
        <div class="stat-icon yellow"><svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><ellipse cx="12" cy="5" rx="9" ry="3"/><path d="M3 5v14a9 3 0 0018 0V5"/></svg></div>
        <div class="stat-label">Ổ đĩa</div>
        <div class="stat-value yellow" id="pfStatDisk">—</div>
      </div>
      <div class="stat-card">
        <div class="stat-icon purple"><svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><circle cx="12" cy="12" r="10"/><path d="M12 6v6l4 2"/></svg></div>
        <div class="stat-label">Uptime</div>
        <div class="stat-value purple" style="font-size:16px" id="pfStatUptime">—</div>
      </div>
    </div>
    <div class="card" style="margin-top:16px">
      <div class="card-title">Phần cứng</div>
      <div style="font-size:13px;color:var(--fg-muted);line-height:1.8" id="pfHardwareInfo">Đang tải...</div>
    </div>
    <div class="table-wrap" style="margin-top:16px">
      <div class="table-toolbar">
        <div style="font-weight:600">Interface — băng thông</div>
        <div class="search-box" style="margin-left:auto">
          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><circle cx="11" cy="11" r="8"/><path d="m21 21-4.35-4.35"/></svg>
          <input type="text" id="pfsenseInterfaceSearch" placeholder="Tìm theo tên/mô tả/IP...">
        </div>
      </div>
      <table>
        <thead><tr>${thSort('Tên', 'if_name', pfsenseInterfacesSortState, 'togglePfsenseInterfacesSort')}${thSort('Mô tả', 'description', pfsenseInterfacesSortState, 'togglePfsenseInterfacesSort')}${thSort('Trạng thái', 'status', pfsenseInterfacesSortState, 'togglePfsenseInterfacesSort')}${thSort('Địa chỉ IP', 'ip_address', pfsenseInterfacesSortState, 'togglePfsenseInterfacesSort')}${thSort('Gateway', 'gateway_status', pfsenseInterfacesSortState, 'togglePfsenseInterfacesSort')}${thSort('Vào (In)', 'in_bps', pfsenseInterfacesSortState, 'togglePfsenseInterfacesSort')}${thSort('Ra (Out)', 'out_bps', pfsenseInterfacesSortState, 'togglePfsenseInterfacesSort')}${thSort('Tổng đã truyền', 'total_bytes', pfsenseInterfacesSortState, 'togglePfsenseInterfacesSort')}</tr></thead>
        <tbody id="pfsenseInterfacesTableBody"><tr><td colspan="8"><div class="loading"><div class="spinner"></div></div></td></tr></tbody>
      </table>
    </div>`;
  document.getElementById('pfsenseInterfaceSearch').addEventListener('input', () => {
    clearTimeout(searchTimeout);
    searchTimeout = setTimeout(() => {
      pfsenseInterfacesSearch = document.getElementById('pfsenseInterfaceSearch').value;
      renderPfsenseInterfacesTable();
    }, 300);
  });
  await loadPfsenseStatusData();
}

let pfsenseInterfacesSearch = '';
let pfsenseInterfacesSortState = { key: null, dir: 'asc' };

function togglePfsenseInterfacesSort(key) {
  toggleSortState(pfsenseInterfacesSortState, key);
  renderPfsenseInterfacesTable();
}

async function loadPfsenseStatusData() {
  if (!document.getElementById('pfsenseInterfacesTableBody')) return;
  try {
    const { system, interfaces } = await api(`/pfsense/firewalls/${pfsenseFirewallId}/status`);
    // Re-check after the await — the user may have navigated/switched tabs away while it was
    // in-flight, in which case these elements no longer exist.
    if (!document.getElementById('pfsenseInterfacesTableBody')) return;
    pfsenseInterfacesCache = interfaces;
    document.getElementById('pfStatCpu').textContent = `${system.cpu_usage ?? '—'}%`;
    document.getElementById('pfStatRam').textContent = `${system.mem_usage ?? '—'}%`;
    document.getElementById('pfStatDisk').textContent = `${system.disk_usage ?? '—'}%`;
    document.getElementById('pfStatUptime').textContent = system.uptime ?? '—';
    document.getElementById('pfHardwareInfo').innerHTML = `CPU: ${system.cpu_model || '—'} (${system.cpu_count ?? '?'} lõi)<br>Nền tảng: ${system.platform || '—'}`;
    renderPfsenseInterfacesTable();
  } catch (e) {
    const el = document.getElementById('pfsenseInterfacesTableBody');
    if (el) el.innerHTML = `<tr><td colspan="8"><div class="empty-state"><h3>Lỗi tải trạng thái</h3><p>${e.message}</p></div></td></tr>`;
  }
}

function renderPfsenseInterfacesTable() {
  const el = document.getElementById('pfsenseInterfacesTableBody');
  if (!el) return;
  const q = pfsenseInterfacesSearch.trim().toLowerCase();
  const filtered = !q ? pfsenseInterfacesCache : pfsenseInterfacesCache.filter(i =>
    i.if_name.toLowerCase().includes(q) || (i.description || '').toLowerCase().includes(q) || (i.ip_address || '').toLowerCase().includes(q));
  if (!filtered.length) {
    el.innerHTML = `<tr><td colspan="8" style="text-align:center;color:var(--fg-muted)">Không tìm thấy interface nào</td></tr>`;
    return;
  }
  const keyFn = (row, key) => key === 'total_bytes' ? (row.in_bytes || 0) + (row.out_bytes || 0) : row[key];
  const sorted = applySort(filtered, pfsenseInterfacesSortState, keyFn);
  el.innerHTML = sorted.map(i => `
          <tr>
            <td style="font-family:'Fira Code',monospace;font-weight:600">${i.if_name}</td>
            <td>${i.description || '—'}</td>
            <td>${i.status === 'up' ? '<span class="status online"><span class="dot"></span>Up</span>' : '<span class="status offline"><span class="dot"></span>Down</span>'}</td>
            <td style="font-family:'Fira Code',monospace">${i.ip_address || '—'}</td>
            <td>${i.gateway_status ? (i.gateway_status === 'online' ? '<span class="status online"><span class="dot"></span>Online</span>' : `<span class="status offline"><span class="dot"></span>${i.gateway_status}</span>`) : '—'}</td>
            <td style="color:var(--blue);font-family:'Fira Code',monospace">↓ ${fmtBps(i.in_bps)}</td>
            <td style="color:var(--accent);font-family:'Fira Code',monospace">↑ ${fmtBps(i.out_bps)}</td>
            <td style="font-size:12px;color:var(--fg-muted)">↓${fmtBytes(i.in_bytes)} / ↑${fmtBytes(i.out_bytes)}</td>
          </tr>`).join('');
}

// ── Tab: Rule tường lửa ──
async function renderPfsenseRulesTab() {
  const body = document.getElementById('pfsenseTabBody');
  body.innerHTML = `<div class="loading"><div class="spinner"></div></div>`;
  try {
    // Interface list cần cho form thêm/sửa rule — tải kèm nếu chưa có (vd vào thẳng tab Rule).
    if (!pfsenseInterfacesCache.length) {
      const status = await api(`/pfsense/firewalls/${pfsenseFirewallId}/status`).catch(() => null);
      if (status) pfsenseInterfacesCache = status.interfaces;
    }
    pfsenseRulesCache = await api(`/pfsense/firewalls/${pfsenseFirewallId}/rules`);
    body.innerHTML = `
    <div class="table-wrap">
      <div class="table-toolbar">
        <div class="search-box">
          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><circle cx="11" cy="11" r="8"/><path d="m21 21-4.35-4.35"/></svg>
          <input type="text" id="pfsenseRuleSearch" placeholder="Tìm theo mô tả/nguồn/đích..." value="${pfsenseRulesSearch}">
        </div>
        <button class="btn btn-secondary btn-sm" onclick="applyPfsenseChanges(this)" data-permission="pfsense.rules.write">
          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><polyline points="20 6 9 17 4 12"/></svg>
          Áp dụng thay đổi
        </button>
        <button class="btn btn-primary btn-sm" style="margin-left:auto" onclick="openAddRuleForm()" data-permission="pfsense.rules.write">
          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><line x1="12" y1="5" x2="12" y2="19"/><line x1="5" y1="12" x2="19" y2="12"/></svg>
          Thêm rule
        </button>
      </div>
      <div id="pfsenseRulesTableBody"></div>
    </div>`;
    document.getElementById('pfsenseRuleSearch').addEventListener('input', () => {
      clearTimeout(searchTimeout);
      searchTimeout = setTimeout(() => {
        pfsenseRulesSearch = document.getElementById('pfsenseRuleSearch').value;
        pfsenseRulesPagination.page = 1;
        renderPfsenseRulesTable();
      }, 300);
    });
    renderPfsenseRulesTable();
    applyPermissionVisibility();
  } catch (e) { body.innerHTML = `<div class="empty-state"><h3>Lỗi tải rule</h3><p>${e.message}</p></div>`; }
}

function renderPfsenseRulesTable() {
  const el = document.getElementById('pfsenseRulesTableBody');
  if (!el) return;
  const q = pfsenseRulesSearch.trim().toLowerCase();
  const filtered = !q ? pfsenseRulesCache : pfsenseRulesCache.filter(r =>
    (r.description || '').toLowerCase().includes(q) || (r.source || '').toLowerCase().includes(q) || (r.destination || '').toLowerCase().includes(q) || (r.interface || '').toLowerCase().includes(q));
  if (!filtered.length) {
    el.innerHTML = `<div class="empty-state"><h3>Không có rule nào</h3></div>`;
    return;
  }
  const sorted = applySort(filtered, pfsenseRulesSortState, (row, key) => row[key]);
  const page = paginateRows(sorted, pfsenseRulesPagination);
  el.innerHTML = `<table>
    <thead><tr>${thSort('Interface', 'interface', pfsenseRulesSortState, 'togglePfsenseRulesSort')}${thSort('Hành động', 'action', pfsenseRulesSortState, 'togglePfsenseRulesSort')}${thSort('Giao thức', 'protocol', pfsenseRulesSortState, 'togglePfsenseRulesSort')}${thSort('Nguồn', 'source', pfsenseRulesSortState, 'togglePfsenseRulesSort')}${thSort('Đích', 'destination', pfsenseRulesSortState, 'togglePfsenseRulesSort')}${thSort('Mô tả', 'description', pfsenseRulesSortState, 'togglePfsenseRulesSort')}<th>Bật</th><th></th></tr></thead>
    <tbody>${page.map(r => `
      <tr>
        <td style="font-family:'Fira Code',monospace">${r.interface || '—'}</td>
        <td>${ruleActionBadge(r.action)}</td>
        <td style="font-family:'Fira Code',monospace">${r.protocol || 'any'}</td>
        <td style="font-family:'Fira Code',monospace;font-size:12px">${r.source || '—'}</td>
        <td style="font-family:'Fira Code',monospace;font-size:12px">${r.destination || '—'}</td>
        <td>${r.description || '—'}</td>
        <td><label class="switch" title="${r.enabled ? 'Bật' : 'Tắt'}"><input type="checkbox" ${r.enabled ? 'checked' : ''} data-permission="pfsense.rules.write" onchange="togglePfsenseRule('${r.rule_tracker}', !this.checked, this)"><span class="slider"></span></label></td>
        <td><div class="actions">
          <button class="btn-icon edit" title="Sửa" data-permission="pfsense.rules.write" onclick='openEditRuleForm(${JSON.stringify(r).replace(/'/g, "&#39;")})'><svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M11 4H4a2 2 0 00-2 2v14a2 2 0 002 2h14a2 2 0 002-2v-7"/><path d="M18.5 2.5a2.121 2.121 0 013 3L12 15l-4 1 1-4 9.5-9.5z"/></svg></button>
          <button class="btn-icon delete" title="Xóa" data-permission="pfsense.rules.delete" onclick="openDeleteRuleConfirm('${r.rule_tracker}', '${escAttr(r.description || r.rule_tracker)}')"><svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><polyline points="3 6 5 6 21 6"/><path d="M19 6l-1 14a2 2 0 01-2 2H8a2 2 0 01-2-2L5 6"/><path d="M10 11v6M14 11v6"/></svg></button>
        </div></td>
      </tr>`).join('')}
    </tbody></table>${paginationBar(pfsenseRulesPagination, filtered.length, 'pfsenseRulesPagination', 'renderPfsenseRulesTable')}`;
  applyPermissionVisibility();
}

function ruleActionBadge(action) {
  if (action === 'pass') return `<span class="status online"><span class="dot"></span>Pass</span>`;
  if (action === 'block' || action === 'reject') return `<span class="status offline"><span class="dot"></span>${action === 'block' ? 'Block' : 'Reject'}</span>`;
  return action || '—';
}

function openAddRuleForm() {
  openModal('Thêm rule tường lửa', ruleFormHtml());
}
function openEditRuleForm(rule) {
  openModal(`Sửa rule — ${rule.description || rule.rule_tracker}`, ruleFormHtml(rule));
}
function ruleFormHtml(rule) {
  const isEdit = !!rule;
  const ifaceOptions = pfsenseInterfacesCache.length
    ? pfsenseInterfacesCache.map(i => `<option value="${i.if_name}" ${rule?.interface === i.if_name ? 'selected' : ''}>${i.if_name}${i.description ? ' - ' + i.description : ''}</option>`).join('')
    : `<option value="${rule?.interface || 'wan'}">${rule?.interface || 'wan'}</option>`;
  return `
    <form id="ruleForm" onsubmit="saveRule(event, ${isEdit ? `'${rule.rule_tracker}'` : 'null'})">
      <div class="form-grid">
        <div class="form-group"><label>Interface *</label><select name="interface" required>${ifaceOptions}</select></div>
        <div class="form-group"><label>Hành động *</label>
          <select name="type" required>
            <option value="pass" ${rule?.action === 'pass' ? 'selected' : ''}>Pass (cho phép)</option>
            <option value="block" ${rule?.action === 'block' ? 'selected' : ''}>Block (chặn âm thầm)</option>
            <option value="reject" ${rule?.action === 'reject' ? 'selected' : ''}>Reject (chặn + phản hồi)</option>
          </select>
        </div>
        <div class="form-group"><label>IP version *</label>
          <select name="ipprotocol" required>
            <option value="inet" ${!rule || rule?.ipprotocol !== 'inet6' ? 'selected' : ''}>IPv4</option>
            <option value="inet6">IPv6</option>
            <option value="inet46">IPv4+IPv6</option>
          </select>
        </div>
        <div class="form-group"><label>Giao thức</label>
          <select name="protocol">
            <option value="" ${!rule?.protocol ? 'selected' : ''}>Any</option>
            ${['tcp', 'udp', 'tcp/udp', 'icmp', 'esp', 'gre'].map(p => `<option value="${p}" ${rule?.protocol === p ? 'selected' : ''}>${p}</option>`).join('')}
          </select>
        </div>
        <div class="form-group"><label>Nguồn *</label><input type="text" name="source" value="${rule?.source || 'any'}" required placeholder="any, lan, 10.0.0.0/24..."></div>
        <div class="form-group"><label>Cổng nguồn</label><input type="text" name="source_port" placeholder="để trống = any"></div>
        <div class="form-group"><label>Đích *</label><input type="text" name="destination" value="${rule?.destination || 'any'}" required placeholder="any, wan:ip, 10.0.0.0/24..."></div>
        <div class="form-group"><label>Cổng đích</label><input type="text" name="destination_port" placeholder="để trống = any"></div>
        <div class="form-group full"><label>Mô tả</label><input type="text" name="descr" value="${rule?.description || ''}" placeholder="Mục đích của rule này"></div>
        <div class="form-group full">
          <label style="text-transform:none;font-size:14px"><input type="checkbox" name="log" style="width:auto;margin-right:6px"> Ghi log traffic khớp rule</label>
        </div>
        <div class="form-group full">
          <label style="text-transform:none;font-size:14px"><input type="checkbox" name="disabled" ${rule && !rule.enabled ? 'checked' : ''} style="width:auto;margin-right:6px"> Tắt rule (không có hiệu lực)</label>
        </div>
      </div>
      <div style="margin-top:8px;font-size:12px;color:var(--fg-muted)">Sau khi lưu, bấm "Áp dụng thay đổi" ở trang danh sách để rule có hiệu lực trên pfSense (đúng hành vi mặc định của pfSense).</div>
      <div class="form-actions">
        <button type="button" class="btn btn-secondary" onclick="closeModal()">Hủy</button>
        <button type="submit" class="btn btn-primary">${isEdit ? 'Lưu thay đổi' : 'Thêm rule'}</button>
      </div>
    </form>`;
}

async function saveRule(e, tracker) {
  e.preventDefault();
  const fd = new FormData(e.target);
  const payload = {
    type: fd.get('type'), interface: fd.get('interface'), ipprotocol: fd.get('ipprotocol'),
    protocol: fd.get('protocol') || undefined, source: fd.get('source'), destination: fd.get('destination'),
    source_port: fd.get('source_port') || null, destination_port: fd.get('destination_port') || null,
    descr: fd.get('descr') || '', disabled: fd.get('disabled') === 'on', log: fd.get('log') === 'on'
  };
  try {
    if (tracker) await api(`/pfsense/firewalls/${pfsenseFirewallId}/rules/${tracker}`, 'PUT', payload);
    else await api(`/pfsense/firewalls/${pfsenseFirewallId}/rules`, 'POST', payload);
    toast(tracker ? 'Đã cập nhật rule' : 'Đã thêm rule', 'success');
    closeModal();
    renderPfsenseRulesTab();
  } catch (err) { toast(err.message, 'error'); }
}

async function togglePfsenseRule(tracker, disabled, checkboxEl) {
  checkboxEl.disabled = true;
  try {
    await api(`/pfsense/firewalls/${pfsenseFirewallId}/rules/${tracker}/toggle`, 'PATCH', { disabled });
    toast(disabled ? 'Đã tắt rule' : 'Đã bật rule', 'success');
    renderPfsenseRulesTab();
  } catch (e) { toast(e.message, 'error'); renderPfsenseRulesTab(); }
}

function openDeleteRuleConfirm(tracker, label) {
  openModal('Xóa rule tường lửa', `
    <form id="ruleDeleteForm" onsubmit="confirmDeleteRule(event, '${tracker}')">
      <p style="font-size:14px;margin-bottom:12px">Thao tác này sẽ xóa rule <strong>${label}</strong> khỏi pfSense thật. Không thể hoàn tác. Nhớ bấm "Áp dụng thay đổi" sau khi xóa.</p>
      <div class="form-actions">
        <button type="button" class="btn btn-secondary" onclick="closeModal()">Hủy</button>
        <button type="submit" class="btn btn-danger">Xóa vĩnh viễn</button>
      </div>
    </form>`);
}

async function confirmDeleteRule(e, tracker) {
  e.preventDefault();
  try {
    await api(`/pfsense/firewalls/${pfsenseFirewallId}/rules/${tracker}`, 'DELETE');
    toast('Đã xóa rule', 'success');
    closeModal();
    renderPfsenseRulesTab();
  } catch (err) { toast(err.message, 'error'); }
}

async function applyPfsenseChanges(btn) {
  btn.disabled = true;
  try {
    await api(`/pfsense/firewalls/${pfsenseFirewallId}/apply`, 'POST');
    toast('Đã áp dụng thay đổi lên pfSense', 'success');
  } catch (e) { toast(e.message, 'error'); }
  finally { btn.disabled = false; }
}

// ── Tab: VPN ──
// Same split-skeleton/in-place-refresh convention as the Trạng thái tab above.
let pfsenseVpnConnsCache = [];
let pfsenseVpnConnsSearch = '';
let pfsenseVpnConnsSortState = { key: null, dir: 'asc' };
let pfsenseVpnConnsPagination = newPagination(20);

function togglePfsenseVpnConnsSort(key) {
  toggleSortState(pfsenseVpnConnsSortState, key);
  renderPfsenseVpnConnsTable();
}

async function renderPfsenseVpnTab() {
  const body = document.getElementById('pfsenseTabBody');
  body.innerHTML = `
    <div class="table-wrap">
      <div class="table-toolbar">
        <div style="font-weight:600" id="pfVpnConnsTitle">Kết nối VPN đang hoạt động</div>
        <div class="search-box" style="margin-left:auto">
          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><circle cx="11" cy="11" r="8"/><path d="m21 21-4.35-4.35"/></svg>
          <input type="text" id="pfsenseVpnConnSearch" placeholder="Tìm theo tunnel/IP/quốc gia...">
        </div>
      </div>
      <table>
        <thead><tr>${thSort('Loại', 'vpn_type', pfsenseVpnConnsSortState, 'togglePfsenseVpnConnsSort')}${thSort('Tunnel', 'tunnel_name', pfsenseVpnConnsSortState, 'togglePfsenseVpnConnsSort')}${thSort('Trạng thái', 'status', pfsenseVpnConnsSortState, 'togglePfsenseVpnConnsSort')}${thSort('Địa chỉ IP client', 'remote_info', pfsenseVpnConnsSortState, 'togglePfsenseVpnConnsSort')}${thSort('IP tunnel VPN', 'tunnel_ip', pfsenseVpnConnsSortState, 'togglePfsenseVpnConnsSort')}${thSort('Quốc gia', 'country', pfsenseVpnConnsSortState, 'togglePfsenseVpnConnsSort')}${thSort('Nhận (↓)', 'rate_recv_bps', pfsenseVpnConnsSortState, 'togglePfsenseVpnConnsSort')}${thSort('Gửi (↑)', 'rate_sent_bps', pfsenseVpnConnsSortState, 'togglePfsenseVpnConnsSort')}${thSort('Tổng đã truyền', 'total_bytes', pfsenseVpnConnsSortState, 'togglePfsenseVpnConnsSort')}${thSort('Kết nối từ', 'connected_since', pfsenseVpnConnsSortState, 'togglePfsenseVpnConnsSort')}</tr></thead>
        <tbody id="pfsenseVpnConnsTableBody"><tr><td colspan="10"><div class="loading"><div class="spinner"></div></div></td></tr></tbody>
      </table>
      <div id="pfsenseVpnConnsPaginationBar"></div>
    </div>
    <div class="table-wrap" style="margin-top:16px">
      <div class="table-toolbar"><div style="font-weight:600">Cấu hình OpenVPN Server</div></div>
      <table>
        <thead><tr><th>Tên</th><th>Chế độ</th><th>Cổng</th><th>Số client tối đa</th><th></th></tr></thead>
        <tbody id="pfsenseVpnServersTableBody"><tr><td colspan="5"><div class="loading"><div class="spinner"></div></div></td></tr></tbody>
      </table>
    </div>`;
  document.getElementById('pfsenseVpnConnSearch').addEventListener('input', () => {
    clearTimeout(searchTimeout);
    searchTimeout = setTimeout(() => {
      pfsenseVpnConnsSearch = document.getElementById('pfsenseVpnConnSearch').value;
      pfsenseVpnConnsPagination.page = 1;
      renderPfsenseVpnConnsTable();
    }, 300);
  });
  await loadPfsenseVpnData();
}

async function loadPfsenseVpnData() {
  if (!document.getElementById('pfsenseVpnConnsTableBody')) return;
  try {
    const [conns, servers] = await Promise.all([
      api(`/pfsense/firewalls/${pfsenseFirewallId}/vpn`),
      api(`/pfsense/firewalls/${pfsenseFirewallId}/openvpn/servers`).catch(() => [])
    ]);
    // Re-check after the awaits — the user may have navigated/switched tabs away while in-flight.
    if (!document.getElementById('pfsenseVpnConnsTableBody')) return;
    pfsenseVpnConnsCache = conns;
    renderPfsenseVpnConnsTable();
    document.getElementById('pfsenseVpnServersTableBody').innerHTML = servers.length ? servers.map(s => `
          <tr>
            <td style="font-weight:600">${s.description || s.name}</td>
            <td>${s.mode || '—'}</td>
            <td>${s.local_port || '—'}</td>
            <td>${s.maxclients ?? '—'}</td>
            <td><div class="actions">
              <button class="btn-icon edit" title="Sửa cấu hình" data-permission="pfsense.vpn.manage" onclick='openEditOpenvpnServerForm(${JSON.stringify(s).replace(/'/g, "&#39;")})'><svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M11 4H4a2 2 0 00-2 2v14a2 2 0 002 2h14a2 2 0 002-2v-7"/><path d="M18.5 2.5a2.121 2.121 0 013 3L12 15l-4 1 1-4 9.5-9.5z"/></svg></button>
            </div></td>
          </tr>`).join('') : `<tr><td colspan="5" style="text-align:center;color:var(--fg-muted)">Không có OpenVPN server nào</td></tr>`;
    applyPermissionVisibility();
  } catch (e) {
    const el = document.getElementById('pfsenseVpnConnsTableBody');
    if (el) el.innerHTML = `<tr><td colspan="10"><div class="empty-state"><h3>Lỗi tải VPN</h3><p>${e.message}</p></div></td></tr>`;
  }
}

function renderPfsenseVpnConnsTable() {
  const el = document.getElementById('pfsenseVpnConnsTableBody');
  if (!el) return;
  const conns = pfsenseVpnConnsCache;
  const q = pfsenseVpnConnsSearch.trim().toLowerCase();
  const filtered = !q ? conns : conns.filter(c =>
    (c.tunnel_name || '').toLowerCase().includes(q) || (c.remote_info || '').toLowerCase().includes(q) ||
    (c.tunnel_ip || '').toLowerCase().includes(q) || (c.country || '').toLowerCase().includes(q));
  // Cảnh báo an ninh (số kết nối nước ngoài) luôn tính trên toàn bộ danh sách, không bị ẩn bởi bộ lọc
  // tìm kiếm — nhưng bảng bên dưới hiển thị theo đúng những gì đã lọc/sắp xếp/phân trang.
  const foreignCount = conns.filter(c => c.is_foreign).length;
  document.getElementById('pfVpnConnsTitle').textContent =
    `Kết nối VPN đang hoạt động (${conns.length})${foreignCount ? ` — ⚠ ${foreignCount} kết nối từ nước ngoài` : ''}`;
  if (!filtered.length) {
    el.innerHTML = `<tr><td colspan="10" style="text-align:center;color:var(--fg-muted)">Không có kết nối VPN nào đang hoạt động</td></tr>`;
    document.getElementById('pfsenseVpnConnsPaginationBar').innerHTML = '';
    return;
  }
  // Chưa bấm sắp xếp theo cột nào -> giữ mặc định: nước ngoài lên đầu, sau đó theo tổng băng thông —
  // cảnh báo bất thường quan trọng hơn thứ tự theo lưu lượng. Bấm vào 1 cột thì tôn trọng lựa chọn đó.
  const keyFn = (row, key) => key === 'total_bytes' ? (row.bytes_recv || 0) + (row.bytes_sent || 0) : row[key];
  const sorted = pfsenseVpnConnsSortState.key ? applySort(filtered, pfsenseVpnConnsSortState, keyFn) : [...filtered].sort((a, b) => {
    if (!!b.is_foreign !== !!a.is_foreign) return (b.is_foreign ? 1 : 0) - (a.is_foreign ? 1 : 0);
    return keyFn(b, 'total_bytes') - keyFn(a, 'total_bytes');
  });
  const page = paginateRows(sorted, pfsenseVpnConnsPagination);
  el.innerHTML = page.map(c => `
          <tr${c.is_foreign ? ' style="background:rgba(239,68,68,0.08)"' : ''}>
            <td style="text-transform:uppercase;font-size:12px;color:var(--fg-muted)">${c.vpn_type}</td>
            <td>${c.tunnel_name}</td>
            <td>${c.status === 'connected' ? '<span class="status online"><span class="dot"></span>Đang kết nối</span>' : `<span class="status unknown"><span class="dot"></span>${c.status}</span>`}</td>
            <td style="font-family:'Fira Code',monospace;font-size:12px">${c.remote_info || '—'}</td>
            <td style="font-family:'Fira Code',monospace;font-size:12px;color:var(--accent)">${c.tunnel_ip || '—'}</td>
            <td>${c.is_foreign ? `<span class="severity critical blink"><span class="dot"></span>${c.country || '?'} - nước ngoài</span>` : (c.country ? `<span style="font-size:12px;color:var(--fg-muted)">${c.country}</span>` : '<span style="font-size:12px;color:var(--fg-muted)">—</span>')}</td>
            <td style="color:var(--blue);font-family:'Fira Code',monospace">↓ ${fmtBps(c.rate_recv_bps)}</td>
            <td style="color:var(--accent);font-family:'Fira Code',monospace">↑ ${fmtBps(c.rate_sent_bps)}</td>
            <td style="font-size:12px;color:var(--fg-muted)">↓${fmtBytes(c.bytes_recv)} / ↑${fmtBytes(c.bytes_sent)}</td>
            <td style="font-size:12px;color:var(--fg-muted)">${c.connected_since ? formatTime(c.connected_since) : '—'}</td>
          </tr>`).join('');
  document.getElementById('pfsenseVpnConnsPaginationBar').innerHTML = paginationBar(pfsenseVpnConnsPagination, filtered.length, 'pfsenseVpnConnsPagination', 'renderPfsenseVpnConnsTable');
}

function openEditOpenvpnServerForm(server) {
  openModal(`Sửa OpenVPN Server — ${server.description || server.name}`, `
    <form id="ovpnServerForm" onsubmit="saveOpenvpnServer(event, ${server.id})">
      <p style="font-size:13px;color:var(--yellow);margin-bottom:12px">⚠ Sửa cấu hình này có thể làm gián đoạn các kết nối VPN đang hoạt động. Xác nhận kỹ trước khi lưu.</p>
      <div class="form-grid">
        <div class="form-group full"><label>Mô tả</label><input type="text" name="description" value="${server.description || ''}"></div>
        <div class="form-group"><label>Số client tối đa</label><input type="number" name="maxclients" value="${server.maxclients ?? ''}" min="1" placeholder="không giới hạn nếu để trống"></div>
        <div class="form-group full">
          <label style="text-transform:none;font-size:14px"><input type="checkbox" name="disable" ${server.disable ? 'checked' : ''} style="width:auto;margin-right:6px"> Tắt server này (ngắt toàn bộ kết nối VPN qua server này)</label>
        </div>
      </div>
      <div class="form-actions">
        <button type="button" class="btn btn-secondary" onclick="closeModal()">Hủy</button>
        <button type="submit" class="btn btn-primary">Lưu thay đổi</button>
      </div>
    </form>`);
}

async function saveOpenvpnServer(e, vpnid) {
  e.preventDefault();
  const fd = new FormData(e.target);
  const payload = {
    description: fd.get('description') || '',
    maxclients: fd.get('maxclients') ? Number(fd.get('maxclients')) : null,
    disable: fd.get('disable') === 'on'
  };
  try {
    await api(`/pfsense/firewalls/${pfsenseFirewallId}/openvpn/servers/${vpnid}`, 'PUT', payload);
    toast('Đã cập nhật cấu hình OpenVPN', 'success');
    closeModal();
    renderPfsenseVpnTab();
  } catch (err) { toast(err.message, 'error'); }
}

// ── Tab: Người dùng OpenVPN (chứng chỉ + tài khoản + CSO + tải cấu hình) ──
let pfsenseOvpnUsersCache = [];
let pfsenseOvpnUsersSearch = '';
let pfsenseOvpnUsersPagination = newPagination(20);
let pfsenseOvpnUsersSortState = { key: null, dir: 'asc' };

function togglePfsenseOvpnUsersSort(key) {
  toggleSortState(pfsenseOvpnUsersSortState, key);
  renderPfsenseOvpnUsersTable();
}

async function renderPfsenseOvpnUsersTab() {
  const body = document.getElementById('pfsenseTabBody');
  body.innerHTML = `<div class="loading"><div class="spinner"></div></div>`;
  try {
    pfsenseOvpnUsersCache = await api(`/pfsense/firewalls/${pfsenseFirewallId}/openvpn/users`);
    body.innerHTML = `
    <div class="table-wrap">
      <div class="table-toolbar">
        <div class="search-box">
          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><circle cx="11" cy="11" r="8"/><path d="m21 21-4.35-4.35"/></svg>
          <input type="text" id="pfsenseOvpnUserSearch" placeholder="Tìm theo username/mô tả..." value="${pfsenseOvpnUsersSearch}">
        </div>
        <button class="btn btn-primary btn-sm" style="margin-left:auto" onclick="openAddOvpnUserForm()" data-permission="pfsense.vpn.manage">
          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><line x1="12" y1="5" x2="12" y2="19"/><line x1="5" y1="12" x2="19" y2="12"/></svg>
          Thêm user
        </button>
      </div>
      <div style="font-size:12px;color:var(--fg-muted);padding:0 4px 10px">Mỗi user = 1 tài khoản pfSense + 1 chứng chỉ TLS riêng — tạo mới sẽ ký chứng chỉ bằng CA đang dùng cho OpenVPN server</div>
      <div id="pfsenseOvpnUsersBody"></div>
    </div>`;
    document.getElementById('pfsenseOvpnUserSearch').addEventListener('input', () => {
      clearTimeout(searchTimeout);
      searchTimeout = setTimeout(() => {
        pfsenseOvpnUsersSearch = document.getElementById('pfsenseOvpnUserSearch').value;
        pfsenseOvpnUsersPagination.page = 1;
        renderPfsenseOvpnUsersTable();
      }, 300);
    });
    renderPfsenseOvpnUsersTable();
    applyPermissionVisibility();
  } catch (e) { body.innerHTML = `<div class="empty-state"><h3>Lỗi tải dữ liệu</h3><p>${e.message}</p></div>`; }
}

function ovpnExpiryBadge(expires) {
  if (!expires) return '<span style="color:var(--fg-muted);font-size:12px">Không giới hạn</span>';
  const [m, d, y] = expires.split('/').map(Number);
  const expDate = new Date(y, m - 1, d);
  const isExpired = expDate.getTime() < Date.now();
  return `<span style="font-size:12px;color:${isExpired ? 'var(--red)' : 'var(--fg-muted)'}">${isExpired ? '⚠ Đã hết hạn ' : ''}${expires}</span>`;
}

function renderPfsenseOvpnUsersTable() {
  const el = document.getElementById('pfsenseOvpnUsersBody');
  if (!el) return;
  const q = pfsenseOvpnUsersSearch.trim().toLowerCase();
  const filtered = !q ? pfsenseOvpnUsersCache : pfsenseOvpnUsersCache.filter(u =>
    u.name.toLowerCase().includes(q) || (u.descr || '').toLowerCase().includes(q));
  if (!filtered.length) {
    el.innerHTML = `<div class="empty-state"><svg width="48" height="48" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5"><path d="M17 21v-2a4 4 0 00-4-4H5a4 4 0 00-4 4v2"/><circle cx="9" cy="7" r="4"/></svg><h3>Không có user OpenVPN nào</h3><p>Bấm "Thêm user" để tạo</p></div>`;
    return;
  }
  // "Hết hạn" là chuỗi mm/dd/YYYY — so sánh trực tiếp theo alphabet sẽ sai thứ tự thời gian, nên
  // chuyển qua ISO (YYYY-MM-DD) trước khi so sánh; "không giới hạn" xếp cuối cùng khi sắp asc.
  const keyFn = (row, key) => key === 'expires' ? (row.expires ? pfDateToIso(row.expires) : '9999-99-99') : row[key];
  const sorted = applySort(filtered, pfsenseOvpnUsersSortState, keyFn);
  const page = paginateRows(sorted, pfsenseOvpnUsersPagination);
  el.innerHTML = `<table>
    <thead><tr>${thSort('Username', 'name', pfsenseOvpnUsersSortState, 'togglePfsenseOvpnUsersSort')}${thSort('Mô tả', 'descr', pfsenseOvpnUsersSortState, 'togglePfsenseOvpnUsersSort')}${thSort('Trạng thái', 'disabled', pfsenseOvpnUsersSortState, 'togglePfsenseOvpnUsersSort')}${thSort('Hết hạn', 'expires', pfsenseOvpnUsersSortState, 'togglePfsenseOvpnUsersSort')}${thSort('IP VPN', 'staticIp', pfsenseOvpnUsersSortState, 'togglePfsenseOvpnUsersSort')}${thSort('Kết nối', 'connected', pfsenseOvpnUsersSortState, 'togglePfsenseOvpnUsersSort')}<th>Hành động</th></tr></thead>
    <tbody>${page.map(u => `
      <tr>
        <td style="font-weight:600;font-family:'Fira Code',monospace">${u.name}</td>
        <td>${u.descr || '—'}</td>
        <td>
          <label class="switch" title="${u.disabled ? 'Đã khóa' : 'Active'}"><input type="checkbox" ${!u.disabled ? 'checked' : ''} data-permission="pfsense.vpn.manage" onchange="togglePfsenseOvpnUserActive('${escAttr(u.name)}', !this.checked, this)"><span class="slider"></span></label>
          ${u.csoBlocked ? '<div style="font-size:11px;color:var(--red);margin-top:2px">Bị chặn VPN (CSO)</div>' : ''}
        </td>
        <td>${ovpnExpiryBadge(u.expires)}</td>
        <td style="font-family:'Fira Code',monospace;font-size:12px">${u.staticIp || '<span style="color:var(--fg-muted)">Tự động</span>'}</td>
        <td>${u.connected ? `<span class="status online" title="${escAttr(u.remoteHost || '')}${u.connectedSince ? ' — từ ' + formatTime(u.connectedSince) : ''}"><span class="dot"></span>Đang kết nối</span>` : '<span class="status offline"><span class="dot"></span>Ngắt kết nối</span>'}</td>
        <td><div class="actions">
          <button class="btn-icon" title="Tải file cấu hình" data-permission="pfsense.vpn.manage" onclick="downloadOvpnUserConfig('${escAttr(u.name)}')"><svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M21 15v4a2 2 0 01-2 2H5a2 2 0 01-2-2v-4"/><polyline points="7 10 12 15 17 10"/><line x1="12" y1="15" x2="12" y2="3"/></svg></button>
          <button class="btn-icon edit" title="Sửa user" data-permission="pfsense.vpn.manage" onclick="openEditOvpnUserForm('${escAttr(u.name)}')"><svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M11 4H4a2 2 0 00-2 2v14a2 2 0 002 2h14a2 2 0 002-2v-7"/><path d="M18.5 2.5a2.121 2.121 0 013 3L12 15l-4 1 1-4 9.5-9.5z"/></svg></button>
          <button class="btn-icon delete" title="Xóa" data-permission="pfsense.vpn.manage" onclick="openDeleteOvpnUserConfirm('${escAttr(u.name)}')"><svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><polyline points="3 6 5 6 21 6"/><path d="M19 6l-1 14a2 2 0 01-2 2H8a2 2 0 01-2-2L5 6"/><path d="M10 11v6M14 11v6"/></svg></button>
        </div></td>
      </tr>`).join('')}
    </tbody></table>${paginationBar(pfsenseOvpnUsersPagination, filtered.length, 'pfsenseOvpnUsersPagination', 'renderPfsenseOvpnUsersTable')}`;
  applyPermissionVisibility();
}

async function togglePfsenseOvpnUserActive(name, disabled, checkboxEl) {
  checkboxEl.disabled = true;
  try {
    await api(`/pfsense/firewalls/${pfsenseFirewallId}/openvpn/users/${encodeURIComponent(name)}`, 'PATCH', { disabled });
    toast(disabled ? `Đã khóa user "${name}"` : `Đã kích hoạt user "${name}"`, 'success');
    const cached = pfsenseOvpnUsersCache.find(u => u.name === name);
    if (cached) cached.disabled = disabled;
    renderPfsenseOvpnUsersTable();
  } catch (e) { toast(e.message, 'error'); renderPfsenseOvpnUsersTable(); }
}

// Các field CSO (Client Specific Override) hữu ích nhất trong ~26 field pfSense hỗ trợ — không phơi
// hết ra form, chỉ tập hợp con hay dùng thật: IP tunnel tĩnh ("force" IP VPN riêng), route riêng,
// DNS riêng, chặn kết nối.
function ovpnCsoFieldsHtml(cso) {
  return `
    <div class="form-grid">
      <div class="form-group"><label>IP VPN tĩnh (force IP, IPv4)</label><input type="text" name="staticIp" value="${cso?.staticIp || ''}" placeholder="vd: 192.168.67.50 — để trống = cấp tự động"><div style="font-size:11px;color:var(--fg-muted);margin-top:4px">Ghi qua ifconfig-push (subnet 255.255.255.0), đúng cách hệ thống này đang dùng</div></div>
      <div class="form-group"><label>DNS server riêng</label><input type="text" name="dns_server1" value="${cso?.dns_server1 || ''}" placeholder="để trống = dùng mặc định server"></div>
      <div class="form-group full"><label>Mạng nội bộ riêng cho client này</label><input type="text" name="local_network" value="${(cso?.local_network || []).join(',')}" placeholder="192.168.1.0/24, ..."></div>
      <div class="form-group full"><label>Mạng phía client route về server</label><input type="text" name="remote_network" value="${(cso?.remote_network || []).join(',')}" placeholder="10.10.0.0/24, ..."></div>
      <div class="form-group full">
        <label style="text-transform:none;font-size:14px"><input type="checkbox" name="block" ${cso?.block ? 'checked' : ''} style="width:auto;margin-right:6px"> Chặn user này kết nối VPN (CSO — khác với khóa tài khoản)</label>
      </div>
    </div>`;
}

// input[type=date] cho ra YYYY-MM-DD, pfSense cần mm/dd/YYYY — 2 chiều chuyển đổi dùng chung cho
// form thêm mới lẫn sửa user.
function isoToPfDate(iso) {
  if (!iso) return '';
  const [y, m, d] = iso.split('-');
  return `${m}/${d}/${y}`;
}
function pfDateToIso(pf) {
  if (!pf) return '';
  const [m, d, y] = pf.split('/');
  return `${y}-${m.padStart(2, '0')}-${d.padStart(2, '0')}`;
}

function openAddOvpnUserForm() {
  openModal('Thêm user OpenVPN', `
    <form id="ovpnUserForm" onsubmit="saveOvpnUser(event)">
      <div class="form-grid">
        <div class="form-group"><label>Username *</label><input type="text" name="name" required autocomplete="off" placeholder="vd: nguyenvana"></div>
        <div class="form-group"><label>Mật khẩu *</label><input type="password" name="password" required autocomplete="new-password"></div>
        <div class="form-group full"><label>Mô tả</label><input type="text" name="descr" placeholder="Họ tên / đơn vị"></div>
        <div class="form-group"><label>Ngày hết hạn</label><input type="date" name="expires"><div style="font-size:11px;color:var(--fg-muted);margin-top:4px">Để trống = không giới hạn</div></div>
      </div>
      <details style="margin-top:8px">
        <summary style="cursor:pointer;font-size:13px;color:var(--fg-muted);margin-bottom:8px">Cài đặt nâng cao (tùy chọn) — IP VPN tĩnh, route riêng...</summary>
        ${ovpnCsoFieldsHtml()}
      </details>
      <p style="font-size:12px;color:var(--fg-muted);margin-top:8px">Sẽ tạo 1 chứng chỉ TLS mới ký bởi CA hiện dùng cho OpenVPN server, gắn liền với user này.</p>
      <div class="form-actions">
        <button type="button" class="btn btn-secondary" onclick="closeModal()">Hủy</button>
        <button type="submit" class="btn btn-primary">Tạo user</button>
      </div>
    </form>`);
}

function collectOvpnCsoPayload(form) {
  const fd = new FormData(form);
  // staticIp always included (even blank) so the edit form can clear an existing IP by emptying
  // the field — the backend only treats it as "leave untouched" when the key is absent entirely.
  const payload = { staticIp: fd.get('staticIp') || '' };
  const local = (fd.get('local_network') || '').split(',').map(s => s.trim()).filter(Boolean);
  if (local.length) payload.local_network = local;
  const remote = (fd.get('remote_network') || '').split(',').map(s => s.trim()).filter(Boolean);
  if (remote.length) payload.remote_network = remote;
  if (fd.get('dns_server1')) payload.dns_server1 = fd.get('dns_server1');
  payload.block = fd.get('block') === 'on';
  return payload;
}

async function saveOvpnUser(e) {
  e.preventDefault();
  const fd = new FormData(e.target);
  const cso = collectOvpnCsoPayload(e.target);
  // staticIp/block are always present in the payload (see collectOvpnCsoPayload) so can't be used
  // to detect "did the admin actually customize anything" — check the meaningful fields instead,
  // to avoid creating a useless empty CSO for every brand-new user.
  const hasCsoData = !!(cso.staticIp || cso.local_network || cso.remote_network || cso.dns_server1 || cso.block);
  const payload = {
    name: fd.get('name'), password: fd.get('password'), descr: fd.get('descr') || '',
    expires: isoToPfDate(fd.get('expires'))
  };
  if (hasCsoData) payload.cso = cso;
  const btn = e.target.querySelector('button[type=submit]');
  btn.disabled = true;
  try {
    const result = await api(`/pfsense/firewalls/${pfsenseFirewallId}/openvpn/users`, 'POST', payload);
    toast(result.message, result.warning ? 'error' : 'success');
    closeModal();
    renderPfsenseOvpnUsersTab();
  } catch (err) {
    toast(err.message, 'error');
    btn.disabled = false;
  }
}

async function openEditOvpnUserForm(name) {
  openModal(`Sửa user — ${name}`, `<div class="loading"><div class="spinner"></div></div>`);
  const cached = pfsenseOvpnUsersCache.find(u => u.name === name) || {};
  let cso = null;
  try {
    cso = await api(`/pfsense/firewalls/${pfsenseFirewallId}/openvpn/users/${encodeURIComponent(name)}/cso`);
  } catch { /* form vẫn mở được (CSO trống) dù load cài đặt hiện tại thất bại */ }
  document.getElementById('modalBody').innerHTML = `
    <form id="ovpnUserEditForm" onsubmit="saveOvpnUserEdit(event, '${escAttr(name)}')">
      <div class="form-grid">
        <div class="form-group full"><label>Mô tả</label><input type="text" name="descr" value="${cached.descr || ''}"></div>
        <div class="form-group"><label>Ngày hết hạn</label><input type="date" name="expires" value="${pfDateToIso(cached.expires)}"><div style="font-size:11px;color:var(--fg-muted);margin-top:4px">Để trống = không giới hạn</div></div>
      </div>
      <div style="margin-top:12px;font-size:13px;font-weight:600;color:var(--fg-muted)">Cài đặt nâng cao</div>
      ${ovpnCsoFieldsHtml(cso)}
      <div class="form-actions">
        <button type="button" class="btn btn-secondary" onclick="closeModal()">Hủy</button>
        <button type="submit" class="btn btn-primary">Lưu</button>
      </div>
    </form>`;
}

async function saveOvpnUserEdit(e, name) {
  e.preventDefault();
  const fd = new FormData(e.target);
  const cso = collectOvpnCsoPayload(e.target);
  const btn = e.target.querySelector('button[type=submit]');
  btn.disabled = true;
  try {
    await api(`/pfsense/firewalls/${pfsenseFirewallId}/openvpn/users/${encodeURIComponent(name)}`, 'PATCH', {
      descr: fd.get('descr') || '', expires: isoToPfDate(fd.get('expires'))
    });
    await api(`/pfsense/firewalls/${pfsenseFirewallId}/openvpn/users/${encodeURIComponent(name)}/cso`, 'PUT', cso);
    toast('Đã lưu thay đổi', 'success');
    closeModal();
    renderPfsenseOvpnUsersTab();
  } catch (err) {
    toast(err.message, 'error');
    btn.disabled = false;
  }
}

function downloadOvpnUserConfig(name) {
  window.open(`${API}/pfsense/firewalls/${pfsenseFirewallId}/openvpn/users/${encodeURIComponent(name)}/config`, '_blank');
}

function openDeleteOvpnUserConfirm(name) {
  openModal('Xóa user OpenVPN', `
    <form id="ovpnUserDeleteForm" onsubmit="confirmDeleteOvpnUser(event, '${escAttr(name)}')">
      <p style="font-size:14px;margin-bottom:12px">Thao tác này sẽ xóa user <strong>${name}</strong> (và cài đặt nâng cao nếu có) khỏi pfSense thật — người dùng này sẽ không đăng nhập VPN được nữa. Không thể hoàn tác.</p>
      <div class="form-group full"><label>Gõ chính xác username để xác nhận</label><input type="text" name="confirmName" placeholder="${name}" autocomplete="off" required></div>
      <div class="form-group full">
        <label style="text-transform:none;font-size:14px"><input type="checkbox" name="deleteCert" style="width:auto;margin-right:6px"> Xóa luôn chứng chỉ TLS của user này</label>
      </div>
      <div class="form-actions">
        <button type="button" class="btn btn-secondary" onclick="closeModal()">Hủy</button>
        <button type="submit" class="btn btn-danger">Xóa vĩnh viễn</button>
      </div>
    </form>`);
}

async function confirmDeleteOvpnUser(e, name) {
  e.preventDefault();
  const fd = new FormData(e.target);
  if (fd.get('confirmName') !== name) { toast('Tên không khớp — đã hủy xóa', 'error'); return; }
  const deleteCert = fd.get('deleteCert') === 'on';
  try {
    await api(`/pfsense/firewalls/${pfsenseFirewallId}/openvpn/users/${encodeURIComponent(name)}?deleteCert=${deleteCert}`, 'DELETE');
    toast(`Đã xóa user "${name}"`, 'success');
    closeModal();
    renderPfsenseOvpnUsersTab();
  } catch (err) { toast(err.message, 'error'); }
}

// ── Tab: Kết nối pfSense (CRUD) ──
async function renderPfsenseFirewallsTab() {
  const body = document.getElementById('pfsenseTabBody');
  body.innerHTML = `<div class="loading"><div class="spinner"></div></div>`;
  try {
    const firewalls = pfsenseFirewallsCache.length ? pfsenseFirewallsCache : await api('/pfsense/firewalls');
    body.innerHTML = `
    <div class="table-wrap">
      <div class="table-toolbar">
        <div style="font-size:13px;color:var(--fg-muted)">Kết nối tới firewall pfSense thật qua REST API (pfSense-pkg-API)</div>
        <button class="btn btn-primary btn-sm" style="margin-left:auto" onclick="openAddFirewallForm()" data-permission="pfsense.manage">
          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><line x1="12" y1="5" x2="12" y2="19"/><line x1="5" y1="12" x2="19" y2="12"/></svg>
          Thêm firewall
        </button>
      </div>
      <div id="pfsenseFirewallsBody">${renderPfsenseFirewallsTable(firewalls)}</div>
    </div>`;
    applyPermissionVisibility();
  } catch (e) { body.innerHTML = `<div class="empty-state"><h3>Lỗi tải dữ liệu</h3><p>${e.message}</p></div>`; }
}

function renderPfsenseFirewallsTable(firewalls) {
  if (!firewalls.length) {
    return `<div class="empty-state"><svg width="48" height="48" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5"><rect x="2" y="4" width="20" height="16" rx="2"/><path d="M2 9h20"/></svg><h3>Chưa có firewall pfSense nào</h3><p>Bấm "Thêm firewall" để kết nối</p></div>`;
  }
  return `<table>
    <thead><tr><th>Tên</th><th>Host</th><th>Xác thực</th><th>Trạng thái</th><th>Đồng bộ lần cuối</th><th>Bật</th><th>Hành động</th></tr></thead>
    <tbody>${firewalls.map(f => `
      <tr>
        <td style="font-weight:600">${f.name}</td>
        <td style="font-family:'Fira Code',monospace;font-size:13px">${f.host}:${f.port}</td>
        <td style="font-size:13px">${f.auth_type === 'api_key' ? 'API Key' : `Basic (${f.username})`}</td>
        <td>${clusterStatusBadge(f.status, f.last_error)}</td>
        <td><span style="font-size:12px;color:var(--fg-muted)">${f.last_synced_at ? formatTime(f.last_synced_at) : 'chưa đồng bộ'}</span></td>
        <td>${f.enabled ? '<span class="status online"><span class="dot"></span>Bật</span>' : '<span class="status offline"><span class="dot"></span>Tắt</span>'}</td>
        <td><div class="actions">
          <button class="btn-icon" title="Đồng bộ ngay" data-permission="pfsense.sync" onclick="syncOneFirewallUi(${f.id},this)"><svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><polyline points="23 4 23 10 17 10"/><path d="M20.49 15a9 9 0 1 1-2.12-9.36L23 10"/></svg></button>
          <button class="btn-icon" title="Kiểm tra kết nối" data-permission="pfsense.manage" onclick="testSavedFirewall(${f.id},this)"><svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M22 11.08V12a10 10 0 1 1-5.93-9.14"/><polyline points="22 4 12 14.01 9 11.01"/></svg></button>
          <button class="btn-icon edit" title="Sửa" data-permission="pfsense.manage" onclick='openEditFirewallForm(${JSON.stringify({ id: f.id, name: f.name, host: f.host, port: f.port, auth_type: f.auth_type, username: f.username, insecure: !!f.insecure, enabled: !!f.enabled }).replace(/'/g, "&#39;")})'><svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M11 4H4a2 2 0 00-2 2v14a2 2 0 002 2h14a2 2 0 002-2v-7"/><path d="M18.5 2.5a2.121 2.121 0 013 3L12 15l-4 1 1-4 9.5-9.5z"/></svg></button>
          <button class="btn-icon delete" title="Xóa" data-permission="pfsense.manage" onclick="openDeleteFirewallConfirm(${f.id},'${escAttr(f.name)}')"><svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><polyline points="3 6 5 6 21 6"/><path d="M19 6l-1 14a2 2 0 01-2 2H8a2 2 0 01-2-2L5 6"/><path d="M10 11v6M14 11v6"/></svg></button>
        </div></td>
      </tr>`).join('')}
    </tbody></table>`;
}

function openAddFirewallForm() {
  openModal('Thêm kết nối pfSense', firewallFormHtml());
}
function openEditFirewallForm(fw) {
  openModal(`Sửa kết nối — ${fw.name}`, firewallFormHtml(fw));
}
function firewallFormHtml(fw) {
  const isEdit = !!fw;
  const authType = fw?.auth_type || 'basic';
  return `
    <form id="firewallForm" onsubmit="saveFirewall(event, ${isEdit ? fw.id : 'null'})">
      <div class="form-grid">
        <div class="form-group full"><label>Tên *</label><input type="text" name="name" value="${fw?.name || ''}" required placeholder="vd: FDS pfSense"></div>
        <div class="form-group"><label>Host *</label><input type="text" name="host" value="${fw?.host || ''}" required placeholder="pfsense.example.local"></div>
        <div class="form-group"><label>Port</label><input type="number" name="port" value="${fw?.port || 443}" placeholder="443"></div>
        <div class="form-group full"><label>Kiểu xác thực</label>
          <select name="auth_type" onchange="togglePfsenseAuthFields(this.value)">
            <option value="basic" ${authType === 'basic' ? 'selected' : ''}>Username/Password (Basic Auth)</option>
            <option value="api_key" ${authType === 'api_key' ? 'selected' : ''}>API Key</option>
          </select>
        </div>
        <div id="pfsenseBasicFields" style="display:${authType === 'basic' ? 'contents' : 'none'}">
          <div class="form-group"><label>Username</label><input type="text" name="username" value="${fw?.username || ''}"></div>
          <div class="form-group"><label>Mật khẩu ${isEdit ? '(để trống nếu giữ nguyên)' : ''}</label><input type="password" name="password" autocomplete="new-password"></div>
        </div>
        <div class="form-group full" id="pfsenseApiKeyField" style="display:${authType === 'api_key' ? '' : 'none'}">
          <label>API Key ${isEdit ? '(để trống nếu giữ nguyên)' : ''}</label><input type="password" name="api_key" autocomplete="new-password">
        </div>
        <div class="form-group full">
          <label style="text-transform:none;font-size:14px"><input type="checkbox" name="insecure" ${fw?.insecure !== false ? 'checked' : ''} style="width:auto;margin-right:6px"> Bỏ qua xác thực chứng chỉ tự ký (self-signed cert)</label>
        </div>
        <div class="form-group full">
          <label style="text-transform:none;font-size:14px"><input type="checkbox" name="enabled" ${fw?.enabled !== false ? 'checked' : ''} style="width:auto;margin-right:6px"> Bật (tham gia đồng bộ tự động)</label>
        </div>
      </div>
      <div id="firewallTestResult" style="margin-top:8px;font-size:13px"></div>
      <div class="form-actions">
        <button type="button" class="btn btn-secondary" onclick="testFirewallForm(this)">Kiểm tra kết nối</button>
        <button type="button" class="btn btn-secondary" onclick="closeModal()">Hủy</button>
        <button type="submit" class="btn btn-primary">${isEdit ? 'Lưu thay đổi' : 'Thêm firewall'}</button>
      </div>
    </form>`;
}

function togglePfsenseAuthFields(authType) {
  document.getElementById('pfsenseBasicFields').style.display = authType === 'basic' ? 'contents' : 'none';
  document.getElementById('pfsenseApiKeyField').style.display = authType === 'api_key' ? '' : 'none';
}

async function testFirewallForm(btn) {
  const form = document.getElementById('firewallForm');
  const fd = new FormData(form);
  const payload = {
    host: fd.get('host'), port: Number(fd.get('port')) || 443, auth_type: fd.get('auth_type'),
    username: fd.get('username'), password: fd.get('password'), api_key: fd.get('api_key'),
    insecure: fd.get('insecure') === 'on'
  };
  const resultEl = document.getElementById('firewallTestResult');
  btn.disabled = true;
  resultEl.innerHTML = `<span style="color:var(--fg-dim)">Đang kiểm tra...</span>`;
  try {
    const result = await api('/pfsense/firewalls/test', 'POST', payload);
    resultEl.innerHTML = result.ok
      ? `<span style="color:var(--accent)">✓ ${result.message}${result.platform ? ' — ' + result.platform : ''}</span>`
      : `<span style="color:var(--red)">✗ ${result.message}</span>`;
  } catch (e) {
    resultEl.innerHTML = `<span style="color:var(--red)">✗ ${e.message}</span>`;
  } finally {
    btn.disabled = false;
  }
}

async function saveFirewall(e, id) {
  e.preventDefault();
  const fd = new FormData(e.target);
  const payload = {
    name: fd.get('name'), host: fd.get('host'), port: Number(fd.get('port')) || 443, auth_type: fd.get('auth_type'),
    username: fd.get('username') || '', password: fd.get('password') || '', api_key: fd.get('api_key') || '',
    insecure: fd.get('insecure') === 'on', enabled: fd.get('enabled') === 'on'
  };
  try {
    if (id) await api(`/pfsense/firewalls/${id}`, 'PUT', payload);
    else await api('/pfsense/firewalls', 'POST', payload);
    toast(id ? 'Đã cập nhật' : 'Đã thêm firewall', 'success');
    closeModal();
    renderPfsense();
  } catch (err) { toast(err.message, 'error'); }
}

async function testSavedFirewall(id, btn) {
  btn.disabled = true;
  try {
    const result = await api(`/pfsense/firewalls/${id}/test`, 'POST');
    toast(result.ok ? `Kết nối thành công: ${result.message}` : `Lỗi kết nối: ${result.message}`, result.ok ? 'success' : 'error');
  } catch (e) { toast(e.message, 'error'); }
  finally { btn.disabled = false; renderPfsenseFirewallsTab(); }
}

async function syncOneFirewallUi(id, btn) {
  btn.disabled = true;
  try {
    await api(`/pfsense/firewalls/${id}/sync`, 'POST');
    toast('Đã đồng bộ', 'success');
  } catch (e) { toast(e.message, 'error'); }
  finally { renderPfsenseFirewallsTab(); }
}

function openDeleteFirewallConfirm(id, name) {
  openModal('Xóa kết nối pfSense', `
    <form id="firewallDeleteForm" onsubmit="confirmDeleteFirewall(event, ${id}, '${escAttr(name)}')">
      <p style="font-size:14px;margin-bottom:12px">Thao tác này sẽ xóa kết nối <strong>${name}</strong> và toàn bộ dữ liệu đã đồng bộ (không thay đổi gì trên pfSense thật, chỉ xóa dữ liệu theo dõi). Không thể hoàn tác.</p>
      <div class="form-group full"><label>Gõ chính xác tên để xác nhận</label><input type="text" name="confirmName" placeholder="${name}" autocomplete="off" required></div>
      <div class="form-actions">
        <button type="button" class="btn btn-secondary" onclick="closeModal()">Hủy</button>
        <button type="submit" class="btn btn-danger">Xóa vĩnh viễn</button>
      </div>
    </form>`);
}

async function confirmDeleteFirewall(e, id, name) {
  e.preventDefault();
  const fd = new FormData(e.target);
  const confirmName = fd.get('confirmName');
  if (confirmName !== name) { toast('Tên không khớp — đã hủy xóa', 'error'); return; }
  try {
    await api(`/pfsense/firewalls/${id}`, 'DELETE', { confirmName });
    toast(`Đã xóa "${name}"`, 'success');
    closeModal();
    pfsenseFirewallId = null;
    renderPfsense();
  } catch (err) { toast(err.message, 'error'); }
}

// ─── UPTIME MONITORS (Giám sát Uptime) ─────────────────────────────────────────
let monitorRows = [];
let monitorPagination = newPagination();

async function renderUptimeMonitors() {
  const c = document.getElementById('pageContent');
  c.innerHTML = `<div class="loading"><div class="spinner"></div> Đang tải...</div>`;
  try {
    monitorRows = await api('/monitors');
    monitorPagination.page = 1;
    c.innerHTML = `
    <div class="page-header">
      <div><div class="page-title">Giám sát Uptime</div><div class="page-subtitle">Theo dõi HTTP/HTTPS domain, IP public và hạn chứng chỉ SSL</div></div>
      <button class="btn btn-primary" data-permission="monitors.write" onclick="openMonitorForm()">
        <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><line x1="12" y1="5" x2="12" y2="19"/><line x1="5" y1="12" x2="19" y2="12"/></svg>
        Thêm monitor
      </button>
    </div>
    <div id="monitorList"></div>`;
    renderMonitorList();
  } catch (e) { c.innerHTML = `<div class="empty-state"><h3>Lỗi tải dữ liệu</h3><p>${e.message}</p></div>`; }
}

function certBadge(m) {
  if (m.cert_days_remaining == null) return '';
  const d = m.cert_days_remaining;
  const cls = d <= 7 ? 'offline' : d <= 30 ? 'warning' : 'online';
  const label = d < 0 ? `SSL hết hạn ${Math.abs(d)} ngày trước` : `SSL còn ${d} ngày`;
  return `<span class="status ${cls}" title="${escAttr(m.cert_issuer || '')}"><span class="dot"></span>${label}</span>`;
}

function renderMonitorList() {
  const wrap = document.getElementById('monitorList');
  if (!monitorRows.length) {
    wrap.innerHTML = `<div class="empty-state"><svg width="48" height="48" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5"><path d="M22 12h-4l-3 9L9 3l-3 9H2"/></svg><h3>Chưa có monitor nào</h3><p>Thêm domain/IP để bắt đầu giám sát uptime</p></div>`;
    return;
  }
  const paged = paginateRows(monitorRows, monitorPagination);
  wrap.innerHTML = paged.map(m => `
    <div class="card monitor-card" style="margin-bottom:12px">
      <div style="display:flex;justify-content:space-between;align-items:flex-start;flex-wrap:wrap;gap:10px">
        <div>
          <div style="font-weight:600;font-size:15px;cursor:pointer" onclick="openMonitorDetail(${m.id})" title="Xem chi tiết">${m.name}${m.enabled ? '' : ' <span style="font-size:11px;color:var(--fg-dim);font-weight:400">(đã tắt)</span>'}</div>
          <div style="font-size:12px;color:var(--fg-dim);font-family:'Fira Code',monospace">${m.url}</div>
        </div>
        <div style="display:flex;gap:8px;align-items:center;flex-wrap:wrap">
          <span class="status ${m.current_status === 'up' ? 'online' : m.current_status === 'down' ? 'offline' : 'unknown'}"><span class="dot"></span>${m.current_status === 'up' ? 'Up' : m.current_status === 'down' ? 'Down' : 'Chưa kiểm tra'}</span>
          ${certBadge(m)}
          <span style="font-size:12px;color:var(--fg-muted)">${m.last_response_ms != null ? m.last_response_ms + 'ms' : ''}</span>
        </div>
      </div>
      <div style="display:flex;justify-content:space-between;align-items:center;margin-top:10px;gap:10px;flex-wrap:wrap">
        <div id="heartbeat-${m.id}" class="heartbeat-bar"></div>
        <div style="font-size:12px;color:var(--fg-muted);white-space:nowrap">Uptime 24h: <b>${m.uptime_24h != null ? m.uptime_24h + '%' : '—'}</b> · 7d: <b>${m.uptime_7d != null ? m.uptime_7d + '%' : '—'}</b></div>
      </div>
      ${m.last_error ? `<div style="font-size:12px;color:var(--red);margin-top:6px">${escAttr(m.last_error)}</div>` : ''}
      <div class="actions" style="margin-top:10px;justify-content:flex-end;display:flex;gap:6px">
        <button class="btn-icon ping" title="Kiểm tra ngay" data-permission="monitors.write" onclick="checkMonitorNow(${m.id}, this)"><svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><polyline points="23 4 23 10 17 10"/><path d="M20.49 15a9 9 0 1 1-2.12-9.36L23 10"/></svg></button>
        <button class="btn-icon edit" title="Sửa" data-permission="monitors.write" onclick="openMonitorForm(${JSON.stringify(m).replace(/"/g, '&quot;')})"><svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M11 4H4a2 2 0 00-2 2v14a2 2 0 002 2h14a2 2 0 002-2v-7"/><path d="M18.5 2.5a2.121 2.121 0 013 3L12 15l-4 1 1-4 9.5-9.5z"/></svg></button>
        <button class="btn-icon delete" title="Xóa" data-permission="monitors.delete" onclick="deleteMonitor(${m.id}, '${escAttr(m.name)}')"><svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><polyline points="3 6 5 6 21 6"/><path d="M19 6l-1 14a2 2 0 01-2 2H8a2 2 0 01-2-2L5 6"/><path d="M10 11v6M14 11v6"/></svg></button>
      </div>
    </div>
  `).join('') + paginationBar(monitorPagination, monitorRows.length, 'monitorPagination', 'renderMonitorList');
  paged.forEach(m => loadHeartbeat(m.id));
}

async function loadHeartbeat(id) {
  try {
    const history = await api(`/monitors/${id}/history?limit=50`);
    const el = document.getElementById(`heartbeat-${id}`);
    if (!el) return;
    if (!history.length) { el.innerHTML = `<span style="font-size:11px;color:var(--fg-dim)">Chưa có lịch sử</span>`; return; }
    el.innerHTML = history.map(h => `<span class="heartbeat-tick ${h.status === 'up' ? 'up' : 'down'}" title="${formatTime(h.checked_at)} — ${h.status === 'up' ? 'Up' : 'Down'}${h.error ? ': ' + escAttr(h.error) : ''}"></span>`).join('');
  } catch { /* transient — next full re-render retries */ }
}

// ─── Monitor detail: response-time chart over a selectable time range ─────────────────────────
const MONITOR_RANGE_PRESETS = [
  { label: '1h', hours: 1 }, { label: '2h', hours: 2 }, { label: '4h', hours: 4 },
  { label: '8h', hours: 8 }, { label: '12h', hours: 12 }, { label: '1 ngày', hours: 24 },
  { label: '7 ngày', hours: 168 }, { label: '30 ngày', hours: 720 },
];
let monitorDetailId = null;
let monitorDetailHours = 24;

async function openMonitorDetail(id) {
  const m = monitorRows.find(r => r.id === id);
  monitorDetailId = id;
  monitorDetailHours = 24;
  openModal(m ? m.name : 'Chi tiết monitor', `<div class="loading"><div class="spinner"></div></div>`, 'detail-modal');
  if (m) {
    document.getElementById('modalBody').innerHTML = `
      <div style="margin-bottom:14px">
        <div style="font-size:12px;color:var(--fg-dim);font-family:'Fira Code',monospace">${m.url}</div>
        <div style="display:flex;gap:8px;align-items:center;margin-top:6px;flex-wrap:wrap">
          <span class="status ${m.current_status === 'up' ? 'online' : m.current_status === 'down' ? 'offline' : 'unknown'}"><span class="dot"></span>${m.current_status === 'up' ? 'Up' : m.current_status === 'down' ? 'Down' : 'Chưa kiểm tra'}</span>
          ${certBadge(m)}
        </div>
      </div>
      <div style="display:flex;gap:6px;flex-wrap:wrap;align-items:center;margin-bottom:12px" id="monitorRangeButtons">
        ${MONITOR_RANGE_PRESETS.map(p => `<button class="btn btn-secondary btn-sm range-btn" data-hours="${p.hours}" onclick="loadMonitorChart(${id}, ${p.hours})">${p.label}</button>`).join('')}
        <button class="btn btn-secondary btn-sm" onclick="toggleMonitorCustomRange()">Tùy chỉnh</button>
      </div>
      <div id="monitorCustomRange" style="display:none;gap:8px;align-items:center;margin-bottom:12px;flex-wrap:wrap">
        <input type="datetime-local" id="monitorRangeFrom">
        <span style="color:var(--fg-dim);font-size:12px">đến</span>
        <input type="datetime-local" id="monitorRangeTo">
        <button class="btn btn-primary btn-sm" onclick="applyMonitorCustomRange(${id})">Áp dụng</button>
      </div>
      <div style="font-size:12px;color:var(--fg-muted);margin-bottom:8px" id="monitorRangeUptime"></div>
      <div id="monitorChart"><div class="loading"><div class="spinner"></div></div></div>
    `;
    loadMonitorChart(id, 24);
  } else {
    document.getElementById('modalBody').innerHTML = `<div class="empty-state"><h3>Không tìm thấy monitor</h3></div>`;
  }
}

function toggleMonitorCustomRange() {
  const el = document.getElementById('monitorCustomRange');
  el.style.display = el.style.display === 'none' ? 'flex' : 'none';
}

function applyMonitorCustomRange(id) {
  const from = document.getElementById('monitorRangeFrom')?.value;
  const to = document.getElementById('monitorRangeTo')?.value;
  if (!from) { toast('Chọn thời điểm bắt đầu', 'error'); return; }
  loadMonitorChart(id, null, from, to || null);
}

async function loadMonitorChart(id, hours, from, to) {
  monitorDetailHours = hours;
  document.querySelectorAll('#monitorRangeButtons .range-btn').forEach(b => {
    b.classList.toggle('btn-primary', Number(b.dataset.hours) === hours);
    b.classList.toggle('btn-secondary', Number(b.dataset.hours) !== hours);
  });
  const chartEl = document.getElementById('monitorChart');
  chartEl.innerHTML = `<div class="loading"><div class="spinner"></div></div>`;
  try {
    const params = from ? new URLSearchParams({ from, ...(to ? { to } : {}) }) : new URLSearchParams({ hours });
    const { points, uptime_pct, bucketed } = await api(`/monitors/${id}/history?${params}`);
    document.getElementById('monitorRangeUptime').textContent = uptime_pct != null
      ? `Uptime trong khoảng này: ${uptime_pct}% (${points.length} điểm dữ liệu${bucketed ? ', đã gộp nhóm để vẽ' : ''})`
      : 'Chưa có dữ liệu trong khoảng này';
    chartEl.innerHTML = renderTimeSeriesChart(points);
  } catch (e) {
    chartEl.innerHTML = `<div class="empty-state"><h3>Lỗi</h3><p>${e.message}</p></div>`;
  }
}

// Hand-rolled SVG line chart (app has no charting dependency — see renderSparkline()'s identical
// reasoning) — response_ms polyline, red-tinted background bands over any down period, minimal
// axis labels. `points`: [{t, response_ms, up}], oldest-first.
function renderTimeSeriesChart(points) {
  if (!points || !points.length) return `<div style="padding:40px 0;text-align:center;color:var(--fg-dim);font-size:13px">Chưa có dữ liệu trong khoảng này</div>`;
  const W = 760, H = 220, padL = 46, padR = 10, padT = 10, padB = 24;
  const plotW = W - padL - padR, plotH = H - padT - padB;
  const n = points.length;
  const validMs = points.map(p => p.response_ms).filter(v => v != null);
  const maxMs = Math.max(10, ...(validMs.length ? validMs : [0])) * 1.15;
  const x = i => padL + (n <= 1 ? plotW / 2 : (i / (n - 1)) * plotW);
  const y = ms => padT + plotH - (Math.min(ms, maxMs) / maxMs) * plotH;

  let bands = '';
  points.forEach((p, i) => {
    if (!p.up) {
      const x0 = i === 0 ? x(i) : (x(i - 1) + x(i)) / 2;
      const x1 = i === n - 1 ? x(i) : (x(i) + x(i + 1)) / 2;
      bands += `<rect x="${x0.toFixed(1)}" y="${padT}" width="${Math.max(1, x1 - x0).toFixed(1)}" height="${plotH}" fill="var(--red-dim)"/>`;
    }
  });

  let polylines = '', seg = [];
  const flushSeg = () => { if (seg.length > 1) polylines += `<polyline points="${seg.join(' ')}" fill="none" stroke="var(--accent)" stroke-width="1.5"/>`; seg = []; };
  points.forEach((p, i) => {
    if (p.response_ms == null) { flushSeg(); return; }
    seg.push(`${x(i).toFixed(1)},${y(p.response_ms).toFixed(1)}`);
  });
  flushSeg();

  const yTicks = [0, maxMs / 2, maxMs];
  const yLabels = yTicks.map(v => `<text x="${(padL - 6).toFixed(1)}" y="${(y(v) + 3).toFixed(1)}" text-anchor="end" font-size="10" fill="var(--fg-dim)">${Math.round(v)}ms</text>`).join('');
  const yGrid = yTicks.map(v => `<line x1="${padL}" y1="${y(v).toFixed(1)}" x2="${W - padR}" y2="${y(v).toFixed(1)}" stroke="var(--border)" stroke-width="1"/>`).join('');

  const tickIdxs = [...new Set([0, Math.floor((n - 1) / 2), n - 1])];
  const xLabels = tickIdxs.map(i => `<text x="${x(i).toFixed(1)}" y="${H - 6}" text-anchor="middle" font-size="10" fill="var(--fg-dim)">${String(points[i].t).slice(5, 16)}</text>`).join('');

  return `<svg width="100%" height="${H}" viewBox="0 0 ${W} ${H}" style="display:block;overflow:visible">
    ${bands}${yGrid}
    ${polylines}
    ${yLabels}${xLabels}
  </svg>`;
}

function openMonitorForm(monitor) {
  const m = typeof monitor === 'string' ? JSON.parse(monitor) : monitor;
  const isEdit = m && m.id;
  openModal(isEdit ? 'Sửa monitor' : 'Thêm monitor', `
    <form id="monitorForm" onsubmit="saveMonitor(event, ${isEdit ? m.id : 'null'})">
      <div class="form-grid">
        <div class="form-group full"><label>Tên *</label><input type="text" name="name" value="${m?.name || ''}" required placeholder="Website công ty"></div>
        <div class="form-group full"><label>URL *</label><input type="text" name="url" value="${m?.url || ''}" required placeholder="https://example.com hoặc http://1.2.3.4:8080"></div>
        <div class="form-group"><label>Chu kỳ kiểm tra (giây)</label><input type="number" name="check_interval_sec" value="${m?.check_interval_sec || 300}" min="30"></div>
        <div class="form-group"><label>Timeout (giây)</label><input type="number" name="timeout_sec" value="${m?.timeout_sec || 10}" min="1"></div>
        <div class="form-group"><label>Từ khóa kiểm tra (tùy chọn)</label><input type="text" name="keyword" value="${m?.keyword || ''}" placeholder="vd: Đăng nhập thành công"></div>
        <div class="form-group"><label>Loại từ khóa</label>
          <select name="keyword_type" class="form-select">
            <option value="contains" ${m?.keyword_type !== 'not_contains' ? 'selected' : ''}>Phải CÓ từ khóa</option>
            <option value="not_contains" ${m?.keyword_type === 'not_contains' ? 'selected' : ''}>KHÔNG được có từ khóa</option>
          </select></div>
        <div class="form-group full"><label style="display:flex;align-items:center;gap:8px;text-transform:none;font-size:13px;color:var(--fg)"><input type="checkbox" name="ignore_tls_errors" value="1" style="width:auto" ${m?.ignore_tls_errors ? 'checked' : ''}> Bỏ qua lỗi chứng chỉ TLS (cho IP public/cert tự ký)</label></div>
        <div class="form-group full"><label style="display:flex;align-items:center;gap:8px;text-transform:none;font-size:13px;color:var(--fg)"><input type="checkbox" name="enabled" value="1" style="width:auto" ${m?.enabled === false ? '' : 'checked'}> Bật giám sát</label></div>
      </div>
      <div class="form-actions">
        <button type="button" class="btn btn-secondary" onclick="closeModal()">Hủy</button>
        <button type="submit" class="btn btn-primary">${isEdit ? 'Cập nhật' : 'Thêm mới'}</button>
      </div>
    </form>`);
}

async function saveMonitor(e, id) {
  e.preventDefault();
  const fd = new FormData(e.target);
  const data = Object.fromEntries(fd);
  // FormData omits unchecked checkboxes entirely — fromEntries alone can't tell "off" from "never sent".
  data.ignore_tls_errors = fd.has('ignore_tls_errors');
  data.enabled = fd.has('enabled');
  try {
    if (id) { await api(`/monitors/${id}`, 'PUT', data); toast('Đã cập nhật monitor', 'success'); }
    else { await api('/monitors', 'POST', data); toast('Đã thêm monitor', 'success'); }
    closeModal();
    renderUptimeMonitors();
  } catch (err) { toast(err.message, 'error'); }
}

async function checkMonitorNow(id, btn) {
  btn.disabled = true;
  try {
    const r = await api(`/monitors/${id}/check`, 'POST');
    toast(r.status === 'up' ? `Up — ${r.response_ms}ms` : `Down: ${r.error || ''}`, r.status === 'up' ? 'success' : 'error');
    renderUptimeMonitors();
  } catch (e) { toast(e.message, 'error'); }
  btn.disabled = false;
}

async function deleteMonitor(id, name) {
  if (!confirm(`Xóa monitor "${name}"?`)) return;
  try {
    await api(`/monitors/${id}`, 'DELETE');
    toast('Đã xóa monitor', 'success');
    renderUptimeMonitors();
  } catch (e) { toast(e.message, 'error'); }
}

// ─── ACTIVITY ─────────────────────────────────────────────────────────────────
const ACTIVITY_ENTITY_TYPES = ['server', 'device', 'user', 'role', 'alert', 'vcenter_vm'];
const ACTIVITY_ENTITY_LABELS = { server: 'Máy chủ', device: 'Thiết bị mạng', user: 'Người dùng', role: 'Vai trò', alert: 'Cảnh báo', vcenter_vm: 'VM (vCenter)' };
let activityFilter = { user_id: '', entity_type: '', action: '', search: '' };
let activityRows = [];
let activityTotal = 0;
let activityPagination = newPagination();

async function renderActivity() {
  const c = document.getElementById('pageContent');
  c.innerHTML = `<div class="page-header"><div><div class="page-title">Nhật ký hoạt động</div><div class="page-subtitle">Lịch sử tất cả thao tác trong hệ thống</div></div></div><div class="loading"><div class="spinner"></div></div>`;
  let activityUsers = [];
  try { activityUsers = await api('/activity/users'); } catch { activityUsers = []; }

  c.innerHTML = `
    <div class="page-header"><div><div class="page-title">Nhật ký hoạt động</div><div class="page-subtitle">Lịch sử tất cả thao tác trong hệ thống</div></div></div>
    <div class="table-wrap">
      <div class="table-toolbar">
        <div class="search-box">
          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><circle cx="11" cy="11" r="8"/><path d="m21 21-4.35-4.35"/></svg>
          <input type="text" id="activitySearch" placeholder="Tìm theo tên đối tượng...">
        </div>
        <select class="filter-select" id="activityUserFilter" onchange="applyActivityFilter()">
          <option value="">Tất cả người thực hiện</option>
          ${activityUsers.map(u => `<option value="${u.user_id}">${u.user_name || 'Không rõ'}</option>`).join('')}
        </select>
        <select class="filter-select" id="activityEntityFilter" onchange="applyActivityFilter()">
          <option value="">Tất cả đối tượng</option>
          ${ACTIVITY_ENTITY_TYPES.map(t => `<option value="${t}">${ACTIVITY_ENTITY_LABELS[t]}</option>`).join('')}
        </select>
        <select class="filter-select" id="activityActionFilter" onchange="applyActivityFilter()">
          <option value="">Tất cả hành động</option>
          <option value="CREATE">Tạo</option>
          <option value="UPDATE">Cập nhật</option>
          <option value="DELETE">Xóa</option>
        </select>
      </div>
      <div id="activityTableBody"><div class="loading"><div class="spinner"></div></div></div>
    </div>`;
  document.getElementById('activitySearch').addEventListener('input', () => {
    clearTimeout(searchTimeout);
    searchTimeout = setTimeout(() => applyActivityFilter(), 300);
  });

  activityPagination.page = 1;
  await loadActivityRows();
}

function applyActivityFilter() {
  activityFilter.search = document.getElementById('activitySearch')?.value || '';
  activityFilter.user_id = document.getElementById('activityUserFilter')?.value || '';
  activityFilter.entity_type = document.getElementById('activityEntityFilter')?.value || '';
  activityFilter.action = document.getElementById('activityActionFilter')?.value || '';
  activityPagination.page = 1;
  loadActivityRows();
}

// Server-side pagination (unlike every other list page) — activity_logs can grow without bound, so
// this fetches just the current page from the API rather than loading everything up front. The
// pagination bar's onclick therefore calls THIS function (a fetch), not a pure re-render, on
// page/page-size change — paginationBar() doesn't care which kind it's driving.
async function loadActivityRows() {
  const offset = (activityPagination.page - 1) * activityPagination.pageSize;
  const params = new URLSearchParams({ ...activityFilter, limit: activityPagination.pageSize, offset });
  try {
    const { logs, total } = await api(`/activity?${params}`);
    activityRows = logs;
    activityTotal = total;
    renderActivityRows();
  } catch (e) {
    document.getElementById('activityTableBody').innerHTML = `<div class="empty-state"><h3>Lỗi</h3><p>${e.message}</p></div>`;
  }
}

function renderActivityRows() {
  const tbody = document.getElementById('activityTableBody');
  if (!activityRows.length) {
    tbody.innerHTML = `<div class="empty-state"><h3>Không có hoạt động nào</h3><p>Thử đổi bộ lọc</p></div>`;
    return;
  }
  tbody.innerHTML = `<table>
    <thead><tr><th>Hành động</th><th>Loại</th><th>Tên đối tượng</th><th>Người thực hiện</th><th>Chi tiết</th><th>Thời gian</th></tr></thead>
    <tbody>${activityRows.map(l => `<tr>
      <td><span style="font-size:12px;padding:2px 8px;border-radius:4px;font-weight:600;background:${l.action==='CREATE'?'var(--accent-dim)':l.action==='DELETE'?'var(--red-dim)':'var(--blue-dim)'};color:${l.action==='CREATE'?'var(--accent)':l.action==='DELETE'?'var(--red)':'var(--blue)'}">${actionLabel(l.action)}</span></td>
      <td style="font-size:13px;color:var(--fg-muted)">${ACTIVITY_ENTITY_LABELS[l.entity_type] || l.entity_type || ''}</td>
      <td style="font-weight:500">${l.entity_name||''}</td>
      <td style="font-size:13px">${l.user_name ? `<span title="${escAttr(l.user_email||'')}">${l.user_name}</span>` : '<span style="color:var(--fg-dim)">Hệ thống</span>'}</td>
      <td style="font-size:12px;color:var(--fg-muted)">${l.details||''}</td>
      <td style="font-size:12px;font-family:'Fira Code',monospace;color:var(--fg-muted)">${formatTime(l.created_at)}</td>
    </tr>`).join('')}
    </tbody></table>${paginationBar(activityPagination, activityTotal, 'activityPagination', 'loadActivityRows')}`;
}

// ─── CHATBOT WIDGET ─────────────────────────────────────────────────────────
// Floating widget, appended once outside the SPA's page-render cycle (see index.html), so it
// survives navigate() page switches. Conversation state is Anthropic message-array format, held
// only in memory here and echoed back to the server on every request — no server-side chat
// storage, so history is lost on refresh (acceptable for v1, see chatbot plan).
let chatMessages = [];
let chatPendingExtra = null;
let chatBusy = false;

function chatEscapeHtml(s) {
  return String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

function chatAppendBubble(role, html) {
  const body = document.getElementById('chatPanelBody');
  const div = document.createElement('div');
  div.className = `chat-bubble chat-bubble-${role}`;
  div.innerHTML = html;
  body.appendChild(div);
  body.scrollTop = body.scrollHeight;
  return div;
}

function chatSetBusy(busy) {
  chatBusy = busy;
  document.getElementById('chatInput').disabled = busy;
  document.querySelector('#chatForm button[type=submit]').disabled = busy;
  let indicator = document.getElementById('chatTyping');
  if (busy && !indicator) {
    indicator = chatAppendBubble('assistant', '<span class="chat-typing"><span></span><span></span><span></span></span>');
    indicator.id = 'chatTyping';
  } else if (!busy && indicator) {
    indicator.remove();
  }
}

async function chatCallApi(body) {
  const res = await fetch(`${API}/chat/message`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body)
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || `Lỗi máy chủ (${res.status})`);
  return data;
}

function chatRenderResult(result) {
  chatMessages = result.messages;
  if (result.awaitingConfirm) {
    chatPendingExtra = result.pendingExtraResults || [];
    chatAppendBubble('assistant', `
      <div class="chat-confirm-card">
        <div>${chatEscapeHtml(result.summary)}</div>
        <div class="chat-confirm-actions">
          <button class="btn btn-danger btn-sm" onclick="chatConfirmAction('${result.toolUseId}','confirm',this)">Xác nhận</button>
          <button class="btn btn-secondary btn-sm" onclick="chatConfirmAction('${result.toolUseId}','cancel',this)">Hủy</button>
        </div>
      </div>
    `);
  } else if (result.done) {
    chatPendingExtra = null;
    chatAppendBubble('assistant', chatEscapeHtml(result.text || '(không có phản hồi)').replace(/\n/g, '<br>'));
  }
}

async function sendChatMessage() {
  if (chatBusy) return;
  const input = document.getElementById('chatInput');
  const text = input.value.trim();
  if (!text) return;
  input.value = '';
  chatAppendBubble('user', chatEscapeHtml(text));
  chatSetBusy(true);
  try {
    const result = await chatCallApi({ messages: chatMessages, userText: text });
    chatRenderResult(result);
  } catch (e) {
    chatAppendBubble('assistant', `<span class="chat-error">${chatEscapeHtml(e.message)}</span>`);
  } finally {
    chatSetBusy(false);
  }
}

async function chatConfirmAction(toolUseId, decision, btnEl) {
  if (chatBusy) return;
  const card = btnEl.closest('.chat-confirm-card');
  if (card) {
    card.querySelectorAll('button').forEach(b => b.disabled = true);
    card.insertAdjacentHTML('beforeend', `<div class="chat-confirm-done">${decision === 'confirm' ? 'Đã xác nhận, đang thực hiện…' : 'Đã hủy'}</div>`);
  }
  chatSetBusy(true);
  try {
    const result = await chatCallApi({ messages: chatMessages, approveToolUseId: toolUseId, decision, pendingExtraResults: chatPendingExtra });
    chatRenderResult(result);
  } catch (e) {
    chatAppendBubble('assistant', `<span class="chat-error">${chatEscapeHtml(e.message)}</span>`);
  } finally {
    chatSetBusy(false);
  }
}

function initChatWidget() {
  const fab = document.getElementById('chatFab');
  const panel = document.getElementById('chatPanel');
  fab.onclick = () => {
    const opening = panel.style.display === 'none';
    panel.style.display = opening ? 'flex' : 'none';
    if (opening) document.getElementById('chatInput').focus();
  };
  document.getElementById('chatPanelClose').onclick = () => { panel.style.display = 'none'; };
  document.getElementById('chatForm').onsubmit = (e) => { e.preventDefault(); sendChatMessage(); };
}
initChatWidget();

// Init
checkAuthAndInit();
updateAlertBadge();
