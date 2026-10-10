// Shared helpers for every page: API calls, cart, nav login state.

async function api(path, { method = 'GET', body } = {}) {
  const res = await fetch(path, {
    method,
    headers: body ? { 'content-type': 'application/json' } : {},
    body: body && JSON.stringify(body),
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw Object.assign(new Error(data.error || 'Fehler'), { status: res.status });
  return data;
}

const euro = (cents) => (cents / 100).toFixed(2).replace('.', ',') + ' €';

const esc = (s) => String(s).replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);

const STATUS = { new: 'Eingegangen', preparing: 'In Zubereitung', ready: 'Abholbereit ☕', picked_up: 'Abgeholt', cancelled: 'Storniert' };

// --- cart: [{id, qty}] in localStorage ---------------------------------------
const cart = {
  get() {
    try { return JSON.parse(localStorage.getItem('cart')) || []; } catch { return []; }
  },
  set(items) {
    try { localStorage.setItem('cart', JSON.stringify(items.filter((i) => i.qty > 0))); } catch {}
    updateCartBadge();
  },
  add(id, qty = 1) {
    const items = cart.get();
    const line = items.find((i) => i.id === id);
    if (line) line.qty = Math.min(20, line.qty + qty);
    else items.push({ id, qty });
    cart.set(items);
  },
  count: () => cart.get().reduce((n, i) => n + i.qty, 0),
};

function updateCartBadge() {
  const b = document.getElementById('cart-count');
  if (b) b.textContent = cart.count() || '';
}

function toast(msg) {
  let t = document.getElementById('toast');
  if (!t) {
    t = document.body.appendChild(document.createElement('div'));
    t.id = 'toast';
    t.setAttribute('role', 'status');
  }
  t.textContent = msg;
  t.classList.add('show');
  clearTimeout(t.timer);
  t.timer = setTimeout(() => t.classList.remove('show'), 2500);
}

// Mark today's opening hours (Berlin time) wherever they're listed.
const berlinWeekday = new Date(new Date().toLocaleString('en-US', { timeZone: 'Europe/Berlin' })).getDay();
document.querySelectorAll('[data-days]').forEach((el) => {
  if (el.dataset.days.split(',').map(Number).includes(berlinWeekday)) el.classList.add('today');
});

// --- nav: active page, cart, account, scroll + phone menu ---------------------
const me = api('/api/me').catch(() => null);  // null when logged out

(async () => {
  const nav = document.getElementById('site-nav');
  if (!nav) return;
  const page = location.pathname.split('/').pop() || 'index.html';
  nav.querySelectorAll('.nav-links a').forEach((a) => { if (a.getAttribute('href') === page) a.setAttribute('aria-current', 'page'); });

  // Transparent over the banner photo, solid once scrolled.
  const onScroll = () => nav.classList.toggle('solid', !document.body.classList.contains('has-hero') || scrollY > 40);
  addEventListener('scroll', onScroll, { passive: true });
  onScroll();

  const toggle = document.getElementById('nav-toggle');
  toggle.addEventListener('click', () => {
    const open = nav.classList.toggle('open');
    toggle.setAttribute('aria-expanded', open);
    toggle.setAttribute('aria-label', open ? 'Menü schließen' : 'Menü öffnen');
  });

  const user = await me;
  const bag = '<svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" aria-hidden="true"><path d="M6 7h12l-1 13H7L6 7Z"/><path d="M9 7a3 3 0 0 1 6 0"/></svg>';
  document.getElementById('nav-actions').innerHTML =
    (user && user.role !== 'customer' ? '<a class="nav-admin" href="admin.html">Admin</a>' : '')
    + `<a class="nav-cart" href="order.html" aria-label="Warenkorb">${bag}<span id="cart-count"></span></a>`
    + (user ? `<a class="nav-pill" href="account.html">${esc(user.name.split(' ')[0])}</a>` : '<a class="nav-pill" href="login.html">Login</a>');
  document.getElementById('nav-links').insertAdjacentHTML('beforeend', user
    ? `<a class="mobile-only" href="account.html">Mein Konto (${esc(user.name.split(' ')[0])})</a>`
    : '<a class="mobile-only" href="login.html">Login / Mitglied werden</a>');
  updateCartBadge();
})();

// Any element with data-add="<menu item name>" becomes an add-to-cart button.
document.addEventListener('click', async (e) => {
  const btn = e.target.closest('[data-add]');
  if (!btn) return;
  const items = await (window.menuPromise ||= api('/api/menu'));
  const item = items.find((i) => i.name === btn.dataset.add || String(i.id) === btn.dataset.add);
  if (!item) return toast('Gerade nicht verfügbar');
  cart.add(item.id);
  toast(`${item.name} im Warenkorb`);
});
