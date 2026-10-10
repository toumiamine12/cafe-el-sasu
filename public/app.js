// Shared helpers for every view: API calls, cart, toast, session + navbar.

export async function api(path, { method = 'GET', body } = {}) {
  const res = await fetch(path, {
    method,
    headers: body ? { 'content-type': 'application/json' } : {},
    body: body && JSON.stringify(body),
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw Object.assign(new Error(data.error || 'Fehler'), { status: res.status });
  return data;
}

export const euro = (cents) => (cents / 100).toFixed(2).replace('.', ',') + ' €';

export const esc = (s) => String(s).replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);

export const STATUS = { new: 'Eingegangen', preparing: 'In Zubereitung', ready: 'Abholbereit ☕', picked_up: 'Abgeholt', cancelled: 'Storniert' };

export const ROLE_LABEL = { customer: 'Kunde', staff: 'Personal', admin: 'Admin' };

// Menu is fetched once per visit and shared by every view.
let menuPromise;
export const getMenu = () => (menuPromise ||= api('/api/menu').catch((e) => { menuPromise = null; throw e; }));

// --- cart: [{id, qty}] in localStorage ---------------------------------------
export const cart = {
  get() {
    try { return JSON.parse(localStorage.getItem('cart')) || []; } catch { return []; }
  },
  set(items) {
    try { localStorage.setItem('cart', JSON.stringify(items.filter((i) => i.qty > 0))); } catch {}
    updateCartBadge();
    dispatchEvent(new Event('cartchange'));
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

export function toast(msg) {
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

// Mark today's opening hours (Berlin time) inside a freshly mounted view.
export function markToday(root) {
  const day = new Date(new Date().toLocaleString('en-US', { timeZone: 'Europe/Berlin' })).getDay();
  root.querySelectorAll('[data-days]').forEach((el) => {
    if (el.dataset.days.split(',').map(Number).includes(day)) el.classList.add('today');
  });
}

// --- session: who is logged in; refresh() also redraws the navbar -------------
export const session = {
  user: undefined,
  async get() {
    if (this.user === undefined) this.user = await api('/api/me').catch(() => null);
    return this.user;
  },
  async refresh() {
    this.user = undefined;
    const user = await this.get();
    renderNav(user);
    return user;
  },
};

// --- navbar -------------------------------------------------------------------
const nav = document.getElementById('site-nav');
const toggle = document.getElementById('nav-toggle');

const onScroll = () => nav.classList.toggle('solid', !document.body.classList.contains('has-hero') || scrollY > 40);
addEventListener('scroll', onScroll, { passive: true });

export function setHero(on) {
  document.body.classList.toggle('has-hero', on);
  onScroll();
}

export function setActiveLink(hash) {
  nav.querySelectorAll('.nav-links a').forEach((a) => {
    if (a.getAttribute('href') === hash) a.setAttribute('aria-current', 'page');
    else a.removeAttribute('aria-current');
  });
}

export function closeMobileNav() {
  nav.classList.remove('open');
  toggle.setAttribute('aria-expanded', false);
  toggle.setAttribute('aria-label', 'Menü öffnen');
}

toggle.addEventListener('click', () => {
  const open = nav.classList.toggle('open');
  toggle.setAttribute('aria-expanded', open);
  toggle.setAttribute('aria-label', open ? 'Menü schließen' : 'Menü öffnen');
});

const BAG = '<svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" aria-hidden="true"><path d="M6 7h12l-1 13H7L6 7Z"/><path d="M9 7a3 3 0 0 1 6 0"/></svg>';

export function renderNav(user) {
  const first = user && esc(user.name.split(' ')[0]);
  document.getElementById('nav-actions').innerHTML =
    (user && user.role !== 'customer' ? '<a class="nav-admin" href="#/admin">Admin</a>' : '')
    + `<a class="nav-cart" href="#/warenkorb" aria-label="Warenkorb">${BAG}<span id="cart-count"></span></a>`
    + (user ? `<a class="nav-pill" href="#/konto">${first}</a>` : '<a class="nav-pill" href="#/login">Login</a>');
  document.querySelector('#nav-links .mobile-only')?.remove();
  document.getElementById('nav-links').insertAdjacentHTML('beforeend', user
    ? `<a class="mobile-only" href="#/konto">Mein Konto (${first})</a>`
    : '<a class="mobile-only" href="#/login">Login / Mitglied werden</a>');
  updateCartBadge();
}

// Any element with data-add="<menu item id or name>" adds that item to the cart.
document.addEventListener('click', async (e) => {
  const btn = e.target.closest('[data-add]');
  if (!btn) return;
  const items = await getMenu();
  const item = items.find((i) => i.name === btn.dataset.add || String(i.id) === btn.dataset.add);
  if (!item) return toast('Gerade nicht verfügbar');
  cart.add(item.id);
  toast(`${item.name} im Warenkorb`);
});
