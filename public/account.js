// Mitgliedskarte, Prämien, Bestellungen mit Live-Status.
const $ = (id) => document.getElementById(id);
const fmt = new Intl.DateTimeFormat('de-DE', { timeZone: 'Europe/Berlin', dateStyle: 'medium', timeStyle: 'short' });
const ACTIVE = ['new', 'preparing', 'ready'];
let lastStatus = {};
let timer;

function renderCard(u) {
  const t = u.tier;
  const prevMin = { Bronze: 0, Silver: 200, Gold: 500 }[t.name];
  const pct = t.next ? Math.round(((u.lifetime_points - prevMin) / (t.next - prevMin)) * 100) : 100;
  $('card').className = `member-card ${t.name}`;
  $('card').innerHTML = `
    <div style="display:flex;justify-content:space-between;flex-wrap:wrap;gap:8px">
      <div><div class="muted" style="color:#fff;opacity:.8">${esc(u.name)}</div><div class="mid">${esc(u.member_id)}</div></div>
      <div style="text-align:right"><div style="font-size:20px;font-weight:bold">${t.name}</div>
        <div>${t.discountPct ? `${t.discountPct}% Rabatt auf jede Bestellung` : 'Sammle Punkte für Rabatte'}</div></div>
    </div>
    <div class="pts">${u.points} <span style="font-size:16px">Punkte</span></div>
    <div>${t.next ? `Noch ${t.next - u.lifetime_points} Punkte bis ${t.name === 'Bronze' ? 'Silver' : 'Gold'}` : 'Höchste Stufe erreicht 🎉'}</div>
    <div class="progress-cafe" role="progressbar" aria-valuenow="${pct}" aria-valuemin="0" aria-valuemax="100"><div style="width:${pct}%"></div></div>`;
}

function renderRewards(u, rewards) {
  $('rewards').innerHTML = '<p class="muted">1 Punkt pro Euro. Punkte werden bei Abholung gutgeschrieben. Prämien löst du im Warenkorb ein.</p>' +
    rewards.map((r) => `
      <div class="row-line">
        <div class="grow"><strong>${esc(r.name)}</strong>${r.birthday_only ? ' 🎂 Alles Gute zum Geburtstag!' : ''}</div>
        <span class="${u.points >= r.cost_points ? 'status ready' : 'muted'}">${r.cost_points} Punkte</span>
      </div>`).join('');
}

function renderOrders(orders) {
  $('orders').innerHTML = orders.length ? orders.map((o) => `
    <div class="row-line" style="flex-wrap:wrap">
      <div class="grow">
        <strong>#${o.id}</strong> · Abholung ${fmt.format(new Date(o.pickup_at))}<br />
        <span class="muted">${o.items.map((i) => `${i.qty}× ${esc(i.name)}`).join(', ')}</span>
      </div>
      <strong>${euro(o.total_cents)}</strong>
      <span class="status ${o.status === 'ready' ? 'ready' : ''}">${STATUS[o.status]}</span>
      ${o.status === 'new' ? `<button class="btn-ghost" data-cancel="${o.id}">Stornieren</button>` : ''}
      <button class="btn-ghost" data-reorder="${o.id}">Nochmal bestellen</button>
    </div>`).join('') : '<p class="muted">Noch keine Bestellungen. <a href="menu.html">Jetzt bestellen</a></p>';
}

async function loadOrders() {
  const orders = await api('/api/orders');
  for (const o of orders) {
    if (lastStatus[o.id] && lastStatus[o.id] !== 'ready' && o.status === 'ready') toast(`Bestellung #${o.id} ist abholbereit ☕`);
    lastStatus[o.id] = o.status;
  }
  renderOrders(orders);
  window.lastOrders = orders;
  clearTimeout(timer);
  if (orders.some((o) => ACTIVE.includes(o.status))) timer = setTimeout(refresh, 10000);
}

async function refresh() {
  const u = await api('/api/me');
  renderCard(u);
  renderRewards(u, await api('/api/rewards'));
  await loadOrders();
}

$('orders').addEventListener('click', async (e) => {
  const cancel = e.target.dataset.cancel;
  const reorder = e.target.dataset.reorder;
  if (cancel) {
    try {
      await api(`/api/orders/${cancel}/cancel`, { method: 'POST' });
      toast('Bestellung storniert');
      refresh();
    } catch (err) { toast(err.message); }
  }
  if (reorder) {
    const o = window.lastOrders.find((x) => x.id === Number(reorder));
    for (const i of o.items) cart.add(i.menu_item_id, i.qty);
    location.href = 'order.html';
  }
});

$('logout').addEventListener('click', async () => {
  await api('/api/logout', { method: 'POST' });
  location.href = 'index.html';
});

me.then((u) => {
  if (!u) return location.replace('login.html?next=account.html');
  const p = new URLSearchParams(location.search);
  if (p.get('placed')) toast(`Danke! Bestellung #${p.get('placed')} ist eingegangen.`);
  if (p.get('welcome')) toast(`Willkommen! Deine Mitgliedsnummer: ${p.get('welcome')}`);
  refresh();
});
