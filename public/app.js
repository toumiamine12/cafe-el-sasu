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

// --- nav: add cart + account links to every page ------------------------------
const me = api('/api/me').catch(() => null);  // null when logged out

(async () => {
  const ul = document.querySelector('#myNavbar ul');
  if (!ul) return;
  const user = await me;
  const link = (href, html) => `<li><a href="${href}" class="nav-link normal-link">${html}</a></li>`;
  ul.insertAdjacentHTML('beforeend',
    link('order.html', 'Warenkorb <span id="cart-count" class="badge"></span>') +
    (user ? link('account.html', esc(user.name.split(' ')[0])) : link('login.html', 'Login')) +
    (user && user.role !== 'customer' ? link('admin.html', 'Admin') : ''));
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
