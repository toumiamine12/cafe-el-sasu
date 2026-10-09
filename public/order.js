// Warenkorb + checkout.
const $ = (id) => document.getElementById(id);
const fmtSlot = new Intl.DateTimeFormat('de-DE', { timeZone: 'Europe/Berlin', weekday: 'short', day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit' });
let menu = [];

function renderCart() {
  const lines = cart.get().map((l) => ({ ...l, item: menu.find((m) => m.id === l.id) })).filter((l) => l.item);
  $('checkout').hidden = !lines.length;
  if (!lines.length) {
    $('cart-lines').innerHTML = '<p class="muted">Dein Warenkorb ist leer. <a href="menu.html">Zur Speisekarte</a></p>';
    $('totals').innerHTML = '';
    return;
  }
  $('cart-lines').innerHTML = lines.map(({ item, qty }) => `
    <div class="row-line">
      <img src="${esc(item.photo)}" alt="" />
      <div class="grow"><strong>${esc(item.name)}</strong><br /><span class="muted">${euro(item.price_cents)}</span></div>
      <div class="qty">
        <button type="button" data-id="${item.id}" data-d="-1" aria-label="${esc(item.name)} weniger">−</button>
        <span>${qty}</span>
        <button type="button" data-id="${item.id}" data-d="1" aria-label="${esc(item.name)} mehr">+</button>
      </div>
    </div>`).join('');
  const subtotal = lines.reduce((s, l) => s + l.item.price_cents * l.qty, 0);
  $('totals').innerHTML = `<span class="muted">Zwischensumme</span> <span class="total">${euro(subtotal)}</span>`;
}

$('cart-lines').addEventListener('click', (e) => {
  const b = e.target.closest('button[data-id]');
  if (!b) return;
  cart.set(cart.get().map((l) => (l.id === Number(b.dataset.id) ? { ...l, qty: Math.min(20, l.qty + Number(b.dataset.d)) } : l)));
  renderCart();
});

$('order-form').addEventListener('submit', async (e) => {
  e.preventDefault();
  $('error').textContent = '';
  $('place').disabled = true;
  try {
    const order = await api('/api/orders', { method: 'POST', body: {
      items: cart.get(),
      pickup_at: $('pickup').value,
      reward_id: $('reward').value ? Number($('reward').value) : undefined,
    } });
    cart.set([]);
    location.href = `account.html?placed=${order.id}`;
  } catch (err) {
    $('error').textContent = err.message;
    $('place').disabled = false;
  }
});

(async () => {
  menu = await (window.menuPromise ||= api('/api/menu'));
  cart.set(cart.get().filter((l) => menu.some((m) => m.id === l.id)));
  renderCart();
  const user = await me;
  if (!user) {
    $('order-form').innerHTML = '<p>Bitte <a href="login.html?next=order.html">einloggen oder registrieren</a>, um vorzubestellen und Punkte zu sammeln.</p>';
    return;
  }
  const [slots, rewards] = await Promise.all([api('/api/pickup-slots'), api('/api/rewards')]);
  $('pickup').innerHTML = slots.map((s) => `<option value="${s}">${fmtSlot.format(new Date(s))} Uhr</option>`).join('')
    || '<option value="">Gerade keine Abholzeit verfügbar</option>';
  $('reward').innerHTML += rewards.filter((r) => r.cost_points <= user.points)
    .map((r) => `<option value="${r.id}">${esc(r.name)} (${r.cost_points} Punkte)</option>`).join('');
  $('discount-note').textContent = user.tier.discountPct
    ? `Als ${user.tier.name}-Mitglied bekommst du ${user.tier.discountPct}% Rabatt.`
    : `Du hast ${user.points} Punkte. Ab 200 Punkten gibt's 5% Rabatt.`;
})();
