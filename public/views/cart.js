// Warenkorb + checkout.
import { api, euro, esc, cart, session, getMenu, lineKey, unitPrice, resolveMods, modBadges } from '../app.js';
import { go } from '../router.js';

const fmtSlot = new Intl.DateTimeFormat('de-DE', { timeZone: 'Europe/Berlin', weekday: 'short', day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit' });

export default {
  title: 'Warenkorb',
  hero: false,
  guestsOnly: true,
  async mount(root, params, alive) {
    const $ = (id) => root.querySelector('#' + id);
    let menu = [];

    function renderCart() {
      const lines = cart.get().map((l) => ({ ...l, item: menu.find((m) => m.id === l.id) })).filter((l) => l.item);
      $('checkout').hidden = !lines.length;
      if (!lines.length) {
        $('cart-lines').innerHTML = '<p class="muted">Dein Warenkorb ist leer. <a href="#/speisekarte">Zur Speisekarte</a></p>';
        $('totals').innerHTML = '';
        return;
      }
      $('cart-lines').innerHTML = lines.map((l) => `
        <div class="row-line">
          <img src="${esc(l.item.photo)}" alt="" />
          <div class="grow"><strong>${esc(l.item.name)}</strong> <span class="muted">${euro(unitPrice(l.item, l.mods))}</span>
            <div class="mods">${modBadges(resolveMods(l.item, l.mods))}</div></div>
          <div class="qty">
            <button type="button" data-key="${lineKey(l)}" data-d="-1" aria-label="${esc(l.item.name)} weniger">−</button>
            <span>${l.qty}</span>
            <button type="button" data-key="${lineKey(l)}" data-d="1" aria-label="${esc(l.item.name)} mehr">+</button>
          </div>
        </div>`).join('');
      const subtotal = lines.reduce((s, l) => s + unitPrice(l.item, l.mods) * l.qty, 0);
      $('totals').innerHTML = `<span class="muted">Zwischensumme</span> <span class="total">${euro(subtotal)}</span>`;
    }

    $('cart-lines').addEventListener('click', (e) => {
      const b = e.target.closest('button[data-key]');
      if (!b) return;
      cart.set(cart.get().map((l) => (lineKey(l) === b.dataset.key ? { ...l, qty: Math.min(20, l.qty + Number(b.dataset.d)) } : l)));
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
        await session.refresh(); // points may have been spent on a reward
        go('#/konto?placed=1'); // the account page thanks for the newest order
      } catch (err) {
        $('error').textContent = err.message;
        $('place').disabled = false;
      }
    });

    menu = await getMenu();
    if (!alive()) return;
    cart.set(cart.get().filter((l) => menu.some((m) => m.id === l.id)));
    renderCart();
    const user = await session.refresh(); // fresh points for the reward list
    if (!alive()) return;
    if (!user) {
      $('order-form').innerHTML = '<p>Bitte <a href="#/login?next=%23%2Fwarenkorb">einloggen oder registrieren</a>, um vorzubestellen und Punkte zu sammeln.</p>';
      return;
    }
    const [slots, rewards] = await Promise.all([api('/api/pickup-availability'), api('/api/rewards')]);
    if (!alive()) return;
    // Full 15-minute windows stay visible but can't be picked.
    $('pickup').innerHTML = slots.map((s) => `<option value="${s.at}" ${s.full ? 'disabled' : ''}>${fmtSlot.format(new Date(s.at))} Uhr${s.full ? ' – Ausgebucht' : s.left <= 2 ? ` – noch ${s.left} frei` : ''}</option>`).join('')
      || '<option value="">Gerade keine Abholzeit verfügbar</option>';
    const firstFree = slots.find((s) => !s.full);
    if (firstFree) $('pickup').value = firstFree.at;
    else $('place').disabled = true;
    $('reward').innerHTML += rewards.filter((r) => r.cost_points <= user.points)
      .map((r) => `<option value="${r.id}">${esc(r.name)} (${r.cost_points} Punkte)</option>`).join('');
    $('discount-note').textContent = user.tier.discountPct
      ? `Als ${user.tier.name}-Mitglied bekommst du ${user.tier.discountPct}% Rabatt.`
      : `Du hast ${user.points} Punkte. Ab 200 Punkten gibt's 5% Rabatt.`;
  },
};
