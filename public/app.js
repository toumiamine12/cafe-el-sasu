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

// --- friendly order names: no order numbers anywhere in the UI ------------------
const fmtClock = new Intl.DateTimeFormat('de-DE', { timeZone: 'Europe/Berlin', hour: '2-digit', minute: '2-digit' });
const fmtDate = new Intl.DateTimeFormat('de-DE', { timeZone: 'Europe/Berlin', weekday: 'short', day: '2-digit', month: '2-digit' });
const berlinDay = (d) => d.toLocaleDateString('de-DE', { timeZone: 'Europe/Berlin' });

// "heute, 14:15 Uhr" / "morgen, 10:00 Uhr" / "Sa., 10.10., 14:15 Uhr"
export function whenLabel(iso) {
  const d = new Date(iso);
  const offset = (days) => berlinDay(new Date(Date.now() + days * 864e5));
  const day = { [offset(0)]: 'heute', [offset(1)]: 'morgen', [offset(-1)]: 'gestern' }[berlinDay(d)] ?? fmtDate.format(d);
  return `${day}, ${fmtClock.format(d)} Uhr`;
}

// "Cappuccino" / "2× Cappuccino" / "Cappuccino & Cheesecake" / "Cappuccino + 2 weitere". Plain text: escape before innerHTML.
export function orderName(o) {
  const names = o.items.map((i) => (i.qty > 1 ? `${i.qty}× ` : '') + i.name);
  if (names.length === 1) return names[0];
  if (names.length === 2) return `${names[0]} & ${names[1]}`;
  return `${names[0]} + ${names.length - 1} weitere`;
}
export const orderIsPlural = (o) => o.items.reduce((n, i) => n + i.qty, 0) > 1;

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
  closeUserMenu();
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
  const isStaff = user && user.role !== 'customer';
  document.getElementById('nav-actions').innerHTML =
    `<a class="nav-cart" href="#/warenkorb" aria-label="Warenkorb">${BAG}<span id="cart-count"></span></a>`
    + (user ? `
      <div class="nav-user">
        <button class="nav-pill" type="button" aria-haspopup="menu" aria-expanded="false">${first}</button>
        <div class="nav-menu" role="menu">
          <div class="who"><strong>${esc(user.name)}</strong>${esc(user.member_id)} · ${isStaff ? ROLE_LABEL[user.role] : user.tier.name}</div>
          <a href="#/konto" role="menuitem">Mein Konto</a>
          ${isStaff ? '<a href="#/admin" role="menuitem">Dashboard</a>' : ''}
          <button class="logout" type="button" role="menuitem" data-logout>Ausloggen</button>
        </div>
      </div>` : '<a class="nav-pill" href="#/login">Login</a>');
  document.querySelectorAll('#nav-links .mobile-only').forEach((a) => a.remove());
  document.getElementById('nav-links').insertAdjacentHTML('beforeend', user
    ? `<a class="mobile-only" href="#/konto">Mein Konto (${first})</a>${isStaff ? '<a class="mobile-only" href="#/admin">Dashboard</a>' : ''}<button class="mobile-only logout" type="button" data-logout>Ausloggen</button>`
    : '<a class="mobile-only" href="#/login">Login / Mitglied werden</a>');
  updateCartBadge();
}

// --- account dropdown ---------------------------------------------------------
export function closeUserMenu() {
  const box = document.querySelector('.nav-user.open');
  if (!box) return;
  box.classList.remove('open');
  box.querySelector('.nav-pill').setAttribute('aria-expanded', false);
}

document.addEventListener('click', async (e) => {
  const pill = e.target.closest('.nav-user .nav-pill');
  if (pill) {
    const box = pill.parentElement;
    const open = !box.classList.contains('open');
    closeUserMenu();
    box.classList.toggle('open', open);
    pill.setAttribute('aria-expanded', open);
    if (open) box.querySelector('[role="menuitem"]').focus();
    return;
  }
  if (!e.target.closest('.nav-menu')) closeUserMenu();
  if (e.target.closest('.nav-menu a')) closeUserMenu();
  if (e.target.closest('[data-logout]')) {
    closeUserMenu();
    await api('/api/logout', { method: 'POST' });
    await session.refresh();
    toast('Du bist ausgeloggt. Bis bald!');
    // Go home; if we're already there, ask the router to redraw for the logged-out state.
    if (location.hash && location.hash !== '#/') location.hash = '#/';
    else dispatchEvent(new Event('sessionchange'));
  }
});

addEventListener('keydown', (e) => {
  if (e.key !== 'Escape' || !document.querySelector('.nav-user.open')) return;
  closeUserMenu();
  document.querySelector('.nav-user .nav-pill').focus();
});

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
