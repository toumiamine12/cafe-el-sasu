// Startseite: live open status, best sellers, personalised loyalty block.
import { api, euro, esc, cart, session } from '../app.js';

const fmtTime = new Intl.DateTimeFormat('de-DE', { timeZone: 'Europe/Berlin', hour: '2-digit', minute: '2-digit' });
const fmtDay = new Intl.DateTimeFormat('de-DE', { timeZone: 'Europe/Berlin', weekday: 'short' });
const berlinDate = (d) => d.toLocaleDateString('de-DE', { timeZone: 'Europe/Berlin' });
const at = (d) => `${berlinDate(d) === berlinDate(new Date()) ? 'heute' : fmtDay.format(d)} ${fmtTime.format(d)} Uhr`;

export default {
  title: '',
  hero: true,
  async mount(root, params, alive) {
    const $ = (id) => root.querySelector('#' + id);

    api('/api/status').then((s) => {
      if (!alive()) return;
      const change = s.changes_at && new Date(s.changes_at);
      const time = change && fmtTime.format(change).replace('00:00', '24:00');
      $('live-status').innerHTML = s.open
        ? `<span class="dot open"></span>Jetzt geöffnet · bis ${time} Uhr`
        : `<span class="dot"></span>Gerade geschlossen${change ? ` · öffnet ${at(change)}` : ''}`;
      $('next-pickup').textContent = `Früheste Abholung: ${at(new Date(s.next_pickup))}`;
    }).catch(() => { if (alive()) $('live-status').textContent = 'Di – Fr 11 – 22 Uhr · Sa – So 10 – 24 Uhr'; });

    api('/api/popular').then((items) => {
      if (!alive()) return;
      $('popular').innerHTML = items.map((i) => `
        <article class="pop-card">
          <img src="${esc(i.photo)}" alt="" loading="lazy" />
          <div class="pop-body">
            <h3>${esc(i.name)}</h3>
            <p>${esc(i.description)}</p>
            <div class="pop-foot"><strong>${euro(i.price_cents)}</strong>
              ${i.sold_out ? '<span class="tag sold">Ausverkauft</span>' : `<button class="add-btn" type="button" data-add="${i.id}" aria-label="${esc(i.name)} in den Warenkorb">+</button>`}</div>
          </div>
        </article>`).join('');
    }).catch(() => { if (alive()) $('popular').innerHTML = '<p class="muted">Gerade nicht verfügbar.</p>'; });

    const user = await session.refresh(); // fresh points for the loyalty block
    if (!user || !alive()) return;
    if (user.role !== 'customer') { // staff/admin: no loyalty or reorder, just a way to the dashboard
      $('hero-second').textContent = 'Zum Dashboard';
      $('hero-second').href = '#/admin';
      return;
    }
    $('loyalty-sub').textContent = `Du bist ${user.tier.name}-Mitglied mit ${user.points} Punkten.`;
    $('loyalty-cta').innerHTML = user.tier.next
      ? `<a class="btn-cafe" href="#/konto">Noch ${user.tier.next - user.lifetime_points} Punkte bis ${user.tier.name === 'Bronze' ? 'Silver' : 'Gold'} – zu deinem Konto</a>`
      : '<a class="btn-cafe" href="#/konto">Zu deinem Konto</a>';
    root.querySelector(`.tier-col.${user.tier.name}`)?.classList.add('mine');
    const last = (await api('/api/orders').catch(() => [])).find((o) => o.status !== 'cancelled');
    if (!alive()) return;
    const btn = $('hero-second');
    if (last) {
      btn.textContent = 'Letzte Bestellung wiederholen';
      btn.href = '#/warenkorb';
      btn.addEventListener('click', () => { for (const i of last.items) cart.add(i.menu_item_id, i.qty, i.modifiers.map((m) => m.option_id).filter(Boolean)); });
    } else {
      btn.textContent = 'Mein Konto';
      btn.href = '#/konto';
    }
  },
};
