// Startseite: live open status, best sellers, personalised loyalty block.
const $ = (id) => document.getElementById(id);
const fmtTime = new Intl.DateTimeFormat('de-DE', { timeZone: 'Europe/Berlin', hour: '2-digit', minute: '2-digit' });
const fmtDay = new Intl.DateTimeFormat('de-DE', { timeZone: 'Europe/Berlin', weekday: 'short' });
const berlinDay = () => new Date(new Date().toLocaleString('en-US', { timeZone: 'Europe/Berlin' })).getDay();
const sameBerlinDay = (a, b) => a.toLocaleDateString('de-DE', { timeZone: 'Europe/Berlin' }) === b.toLocaleDateString('de-DE', { timeZone: 'Europe/Berlin' });
const at = (d) => `${sameBerlinDay(d, new Date()) ? 'heute' : fmtDay.format(d)} ${fmtTime.format(d)} Uhr`;

// Highlight today's row in the hours table.
document.querySelectorAll('#hours tr').forEach((tr) => {
  if (tr.dataset.days.split(',').map(Number).includes(berlinDay())) tr.classList.add('today');
});

api('/api/status').then((s) => {
  const change = s.changes_at && new Date(s.changes_at);
  const time = change && fmtTime.format(change).replace('00:00', '24:00');
  $('live-status').innerHTML = s.open
    ? `<span class="dot open"></span>Jetzt geöffnet · bis ${time} Uhr`
    : `<span class="dot"></span>Gerade geschlossen${change ? ` · öffnet ${at(change)}` : ''}`;
  $('next-pickup').textContent = `Früheste Abholung: ${at(new Date(s.next_pickup))}`;
}).catch(() => { $('live-status').textContent = 'Di – Fr 11 – 22 Uhr · Sa – So 10 – 24 Uhr'; });

api('/api/popular').then((items) => {
  $('popular').innerHTML = items.map((i) => `
    <article class="pop-card">
      <img src="${esc(i.photo)}" alt="" loading="lazy" />
      <div class="pop-body">
        <h3>${esc(i.name)}</h3>
        <p>${esc(i.description)}</p>
        <div class="pop-foot"><strong>${euro(i.price_cents)}</strong>
          <button class="add-btn" type="button" data-add="${i.id}" aria-label="${esc(i.name)} in den Warenkorb">+</button></div>
      </div>
    </article>`).join('');
}).catch(() => { $('popular').innerHTML = '<p class="muted">Gerade nicht verfügbar.</p>'; });

me.then(async (user) => {
  if (!user) return;
  $('loyalty-sub').textContent = `Du bist ${user.tier.name}-Mitglied mit ${user.points} Punkten.`;
  $('loyalty-cta').innerHTML = user.tier.next
    ? `<a class="btn-cafe" href="account.html">Noch ${user.tier.next - user.lifetime_points} Punkte bis ${user.tier.name === 'Bronze' ? 'Silver' : 'Gold'} – zu deinem Konto</a>`
    : '<a class="btn-cafe" href="account.html">Zu deinem Konto</a>';
  document.querySelector(`.tier-col.${user.tier.name}`)?.classList.add('mine');
  const last = (await api('/api/orders').catch(() => [])).find((o) => o.status !== 'cancelled');
  const btn = $('hero-second');
  if (last) {
    btn.textContent = 'Letzte Bestellung wiederholen';
    btn.href = 'order.html';
    btn.addEventListener('click', () => { for (const i of last.items) cart.add(i.menu_item_id, i.qty); });
  } else {
    btn.textContent = 'Mein Konto';
    btn.href = 'account.html';
  }
});
