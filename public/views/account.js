// Mein Konto: Willkommen, Übersicht, Bestellverlauf, Profil.
import { api, euro, esc, cart, toast, STATUS, session } from '../app.js';
import { go } from '../router.js';

const fmtDate = new Intl.DateTimeFormat('de-DE', { timeZone: 'Europe/Berlin', dateStyle: 'medium', timeStyle: 'short' });
const berlinHour = () => Number(new Intl.DateTimeFormat('de-DE', { timeZone: 'Europe/Berlin', hour: 'numeric', hourCycle: 'h23' }).format(new Date()));
const ACTIVE = ['new', 'preparing', 'ready'];
const TIER_MIN = { Bronze: 0, Silver: 200, Gold: 500 };
const NEXT_TIER = { Bronze: 'Silver', Silver: 'Gold' };
let timer;

export default {
  title: 'Mein Konto',
  hero: true,
  auth: 'user',
  async mount(root, params, alive) {
    const $ = (id) => root.querySelector('#' + id);
    let user;
    let orders = [];
    const lastStatus = {};

    // --- tabs (inside the view; the hash belongs to the router) ---
    function showTab(tab) {
      if (!['overview', 'orders', 'profile'].includes(tab)) tab = 'overview';
      $('acc-tabs').querySelectorAll('button').forEach((b) => b.setAttribute('aria-selected', b.dataset.tab === tab));
      root.querySelectorAll('[role="tabpanel"]').forEach((p) => { p.hidden = p.id !== tab; });
    }
    $('acc-tabs').addEventListener('click', (e) => {
      if (!e.target.dataset.tab) return;
      showTab(e.target.dataset.tab);
    });

    // --- welcome + card -------------------------------------------------------------
    function renderWelcome() {
      const h = berlinHour();
      const hello = h < 11 ? 'Guten Morgen' : h < 18 ? 'Hallo' : 'Guten Abend';
      const first = user.name.split(' ')[0];
      $('greeting').textContent = `${hello}, ${first}`;
      const active = orders.filter((o) => ACTIVE.includes(o.status));
      const ready = active.find((o) => o.status === 'ready');
      $('welcome-sub').textContent = ready ? `Deine Bestellung #${ready.id} ist abholbereit.`
        : active.length ? `${active.length === 1 ? 'Eine Bestellung ist' : `${active.length} Bestellungen sind`} in Arbeit.`
          : 'Lust auf einen Kaffee? Bestell vor und hol ihn ohne Warten ab.';

      const t = user.tier;
      const pct = t.next ? Math.round(((user.lifetime_points - TIER_MIN[t.name]) / (t.next - TIER_MIN[t.name])) * 100) : 100;
      $('card').className = `member-card ${t.name}`;
      $('card').innerHTML = `
        <div class="top"><img src="photos/logo.png" alt="" /><span class="tier">${t.name}</span></div>
        <div>
          <div class="mid">${esc(user.member_id)}</div>
          <div>${esc(user.name)}</div>
        </div>
        <div>
          <div class="pts"><strong>${user.points}</strong> Punkte${t.discountPct ? ` · ${t.discountPct}% Rabatt` : ''}</div>
          <div class="progress on-dark" role="progressbar" aria-label="Fortschritt zur nächsten Stufe" aria-valuenow="${pct}" aria-valuemin="0" aria-valuemax="100"><div style="width:${pct}%"></div></div>
          <div style="font-size:13px;margin-top:4px">${t.next ? `Noch ${t.next - user.lifetime_points} Punkte bis ${NEXT_TIER[t.name]}` : 'Höchste Stufe erreicht'}</div>
        </div>`;
    }

    // --- overview -------------------------------------------------------------------
    function renderOverview(rewards) {
      const stat = (label, value) => `<div class="stat"><div class="label">${label}</div><div class="value">${value}</div></div>`;
      $('stats').innerHTML = stat('Abgeholte Bestellungen', user.stats.orders) + stat('Insgesamt ausgegeben', euro(user.stats.spent_cents))
        + stat('Dein Favorit', user.stats.favorite ? esc(user.stats.favorite) : '—');

      $('rewards').innerHTML = rewards.map((r) => {
        const pct = r.cost_points ? Math.min(100, Math.round((user.points / r.cost_points) * 100)) : 100;
        const ready = user.points >= r.cost_points;
        return `<div class="reward">
          <strong>${esc(r.name)}${r.birthday_only ? ' · Alles Gute zum Geburtstag!' : ''}</strong>
          <span class="${ready ? 'status ready' : 'muted'}">${ready ? 'Einlösbar' : `${user.points} / ${r.cost_points} Punkte`}</span>
          <div class="progress"><div style="width:${pct}%"></div></div>
        </div>`;
      }).join('');

      const active = orders.filter((o) => ACTIVE.includes(o.status));
      $('active-panel').hidden = !active.length;
      $('active-orders').innerHTML = active.map((o) => `
        <div class="row-line">
          <div class="grow"><strong>#${o.id}</strong> · Abholung ${fmtDate.format(new Date(o.pickup_at))}<br />
            <span class="muted">${o.items.map((i) => `${i.qty}× ${esc(i.name)}`).join(', ')}</span></div>
          <span class="status ${o.status === 'ready' ? 'ready' : ''}">${STATUS[o.status]}</span>
        </div>`).join('');
    }

    // --- order history --------------------------------------------------------------
    function renderOrders() {
      const open = new Set([...root.querySelectorAll('.order[open]')].map((d) => d.dataset.id));
      $('order-list').innerHTML = orders.length ? orders.map((o) => `
        <details class="order" data-id="${o.id}" ${open.has(String(o.id)) ? 'open' : ''}>
          <summary>
            <div><strong>${fmtDate.format(new Date(o.created_at))}</strong> <span class="muted">· #${o.id}</span><br />
              <span class="muted">${o.items.map((i) => `${i.qty}× ${esc(i.name)}`).join(', ')}</span></div>
            <span class="status ${o.status === 'ready' ? 'ready' : o.status === 'cancelled' ? 'cancelled' : ''}">${STATUS[o.status]}</span>
            <strong>${euro(o.total_cents)}</strong>
          </summary>
          <div class="detail">
            <p class="muted">Abholung: ${fmtDate.format(new Date(o.pickup_at))}</p>
            <table>
              ${o.items.map((i) => `<tr><td>${i.qty}× ${esc(i.name)}</td><td>${euro(i.unit_price_cents * i.qty)}</td></tr>`).join('')}
              <tr><td class="muted">Zwischensumme</td><td>${euro(o.subtotal_cents)}</td></tr>
              ${o.discount_cents ? `<tr><td class="muted">Rabatt${o.reward_id ? ' inkl. Prämie' : ''}</td><td>−${euro(o.discount_cents)}</td></tr>` : ''}
              <tr class="sum"><td>Gesamt (bezahlt bei Abholung)</td><td>${euro(o.total_cents)}</td></tr>
            </table>
            <div class="buttons">
              <button class="btn-cafe" data-reorder="${o.id}">Nochmal bestellen</button>
              ${o.status === 'new' ? `<button class="btn-ghost" data-cancel="${o.id}">Bestellung stornieren</button>` : ''}
            </div>
          </div>
        </details>`).join('') : '<p>Du hast noch nichts bestellt. <a class="btn-cafe" href="#/speisekarte">Zur Speisekarte</a></p>';
    }

    $('order-list').addEventListener('click', async (e) => {
      const { cancel, reorder } = e.target.dataset;
      if (cancel) {
        try {
          await api(`/api/orders/${cancel}/cancel`, { method: 'POST' });
          toast('Bestellung storniert');
          refresh();
        } catch (err) { toast(err.message); }
      }
      if (reorder) {
        for (const i of orders.find((o) => o.id === Number(reorder)).items) cart.add(i.menu_item_id, i.qty);
        go('#/warenkorb');
      }
    });

    // --- profile ----------------------------------------------------------------------
    function fillProfile() {
      $('p-name').value = user.name;
      $('p-email').value = user.email;
      $('p-birthday').value = user.birthday || '';
      $('p-member').value = user.member_id;
    }

    $('profile-form').addEventListener('submit', async (e) => {
      e.preventDefault();
      $('profile-error').textContent = '';
      try {
        user = await api('/api/me', { method: 'PATCH', body: {
          name: $('p-name').value, email: $('p-email').value, birthday: $('p-birthday').value || null,
        } });
        fillProfile();
        renderWelcome();
        session.refresh(); // navbar shows the new first name
        toast('Änderungen gespeichert');
      } catch (err) { $('profile-error').textContent = err.message; }
    });

    $('password-form').addEventListener('submit', async (e) => {
      e.preventDefault();
      $('password-error').textContent = '';
      try {
        await api('/api/me/password', { method: 'POST', body: { current: $('pw-current').value, next: $('pw-next').value } });
        e.target.reset();
        toast('Passwort geändert');
      } catch (err) { $('password-error').textContent = err.message; }
    });

    $('logout').addEventListener('click', async () => {
      await api('/api/logout', { method: 'POST' });
      await session.refresh();
      go('#/');
    });

    // --- load + live status -------------------------------------------------------------
    async function refresh() {
      let me, rewards, list;
      try {
        [me, rewards, list] = await Promise.all([api('/api/me'), api('/api/rewards'), api('/api/orders')]);
      } catch (err) {
        if (!alive()) return;
        if (err.status !== 401) return toast(err.message);
        me = null; // session expired while on this page
      }
      if (!alive()) return; // left the page meanwhile
      if (!me) {
        await session.refresh();
        return go('#/login?next=%23%2Fkonto');
      }
      session.user = me; // keep the shared copy in step with the points shown here
      user = me;
      orders = list;
      for (const o of orders) {
        if (lastStatus[o.id] && lastStatus[o.id] !== 'ready' && o.status === 'ready') toast(`Bestellung #${o.id} ist abholbereit`);
        lastStatus[o.id] = o.status;
      }
      renderWelcome();
      renderOverview(rewards);
      renderOrders();
      clearTimeout(timer);
      if (orders.some((o) => ACTIVE.includes(o.status))) timer = setTimeout(refresh, 10000);
    }

    showTab('overview');
    await refresh();
    if (!alive()) return;
    fillProfile();
    if (params.get('placed')) toast(`Danke! Bestellung #${params.get('placed')} ist eingegangen.`);
    if (params.get('welcome')) toast(`Willkommen! Deine Mitgliedsnummer: ${params.get('welcome')}`);
  },
  unmount() {
    clearTimeout(timer); // stop the 10-second order refresh
  },
};
