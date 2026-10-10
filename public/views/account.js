// Mein Konto: welcome + member card, live order pulse, "Das Übliche", loyalty pass, favorites,
// history, bean subscription, gifts, preferences and profile.
import { api, euro, esc, cart, toast, STATUS, session, orderName, orderIsPlural, whenLabel, modBadges, getMenu } from '../app.js';
import { go } from '../router.js';
import { mountBeans, mountGifts } from './account-extras.js';
import { saveCardImage } from '../card-image.js';

const berlinHour = () => Number(new Intl.DateTimeFormat('de-DE', { timeZone: 'Europe/Berlin', hour: 'numeric', hourCycle: 'h23' }).format(new Date()));
const fmtClock = new Intl.DateTimeFormat('de-DE', { timeZone: 'Europe/Berlin', hour: '2-digit', minute: '2-digit' });
const ACTIVE = ['new', 'preparing', 'ready'];
const STEPS = ['new', 'preparing', 'ready'];
const TIER_MIN = { Bronze: 0, Silver: 200, Gold: 500 };
const NEXT_TIER = { Bronze: 'Silver', Silver: 'Gold' };
const TIER_PERK = { Bronze: 'Bronze: 1 Punkt pro Euro, gutgeschrieben bei Abholung', Silver: 'Silver: 5 % Rabatt, automatisch an der Kasse', Gold: 'Gold: 10 % Rabatt, automatisch an der Kasse' };
const TABS = ['overview', 'orders', 'beans', 'gifts', 'profile'];
let timer;

const comboLabel = (c) => `${c.item.name}${c.mods.filter((m) => !m.is_default).map((m) => ` · ${m.name}`).join('')}`;

export default {
  title: 'Mein Konto',
  hero: true,
  auth: 'customer',
  async mount(root, params, alive) {
    const $ = (id) => root.querySelector('#' + id);
    let user;
    let orders = [];
    let rewards = [];
    let usual = null;
    let favorites = [];
    let gifts = null; // the "Verschenken" tab, mounted after the first load
    const lastStatus = {};

    // --- tabs (inside the view; the hash belongs to the router) ---
    function showTab(tab) {
      if (!TABS.includes(tab)) tab = 'overview';
      $('acc-tabs').querySelectorAll('button').forEach((b) => b.setAttribute('aria-selected', b.dataset.tab === tab));
      root.querySelectorAll('[role="tabpanel"]').forEach((p) => { p.hidden = p.id !== tab; });
    }
    $('acc-tabs').addEventListener('click', (e) => {
      if (e.target.dataset.tab) showTab(e.target.dataset.tab);
    });

    // --- welcome + card -------------------------------------------------------------
    function renderWelcome() {
      const h = berlinHour();
      $('greeting').textContent = `${h < 11 ? 'Guten Morgen' : h < 18 ? 'Guten Tag' : 'Guten Abend'}, ${user.name}`;
      const active = orders.filter((o) => ACTIVE.includes(o.status));
      const ready = active.find((o) => o.status === 'ready');
      $('welcome-sub').textContent = ready ? `${orderName(ready)} ${orderIsPlural(ready) ? 'sind' : 'ist'} abholbereit – bis gleich!`
        : active.length === 1 ? `Wir bereiten ${orderName(active[0])} für ${whenLabel(active[0].pickup_at)} vor.`
          : active.length ? `${active.length} Bestellungen sind in Arbeit.`
            : 'Lust auf einen Kaffee? Bestellen Sie vor und holen Sie ihn ohne Warten ab.';
      const t = user.tier;
      const pct = t.next ? Math.round(((user.lifetime_points - TIER_MIN[t.name]) / (t.next - TIER_MIN[t.name])) * 100) : 100;
      $('card').className = `member-card ${t.name}`;
      $('card').innerHTML = `
        <div class="top"><img src="photos/logo.png" alt="" /><span class="tier">${t.name}</span></div>
        <div><div class="mid">${esc(user.member_id)}</div><div>${esc(user.name)}</div></div>
        <button class="qr" type="button" id="qr-open" aria-label="QR-Code groß anzeigen"><img src="/api/me/qr" alt="" width="64" height="64" /></button>
        <div>
          <div class="pts"><strong>${user.points}</strong> Punkte${t.discountPct ? ` · ${t.discountPct}% Rabatt` : ''}</div>
          <div class="progress on-dark" role="progressbar" aria-label="Fortschritt zur nächsten Stufe" aria-valuenow="${pct}" aria-valuemin="0" aria-valuemax="100"><div style="width:${pct}%"></div></div>
          <div style="font-size:13px;margin-top:4px">${t.next ? `Noch ${t.next - user.lifetime_points} Punkte bis ${NEXT_TIER[t.name]}` : 'Höchste Stufe erreicht'}</div>
        </div>`;
    }

    // --- live order pulse: steps + countdown; big alert when ready ----------------------
    function renderPulse() {
      const active = orders.filter((o) => ACTIVE.includes(o.status));
      $('pulse').innerHTML = active.map((o) => {
        const step = STEPS.indexOf(o.status);
        const mins = Math.round((Date.parse(o.pickup_at) - Date.now()) / 60e3);
        const eta = o.status === 'ready' ? 'Express-Abholung am Tresen – einfach Namen sagen.'
          : mins > 0 ? `Abholbereit um ${fmtClock.format(new Date(o.pickup_at))} Uhr · noch ${mins >= 60 ? `${Math.floor(mins / 60)} h ${mins % 60} min` : `${mins} Min.`}`
            : 'Gleich fertig – wir sind dran.';
        return `<article class="pulse ${o.status}">
          ${o.status === 'ready' ? '<div class="pulse-ready">Ihr Kaffee ist ready!</div>' : ''}
          <div class="pulse-head"><strong>${esc(orderName(o))}</strong><span>${eta}</span></div>
          <ol class="pulse-steps">${STEPS.map((s, i) => `<li class="${i < step ? 'done' : i === step ? 'now' : ''}">${STATUS[s].replace(' ☕', '')}</li>`).join('')}</ol>
        </article>`;
      }).join('');
    }

    // --- Das Übliche: one tap → cart, usual pickup time preselected ------------------------
    function renderUsual() {
      $('usual').hidden = !usual?.available;
      if (!usual?.available) return;
      $('usual').innerHTML = `
        <div class="grow">
          <span class="eyebrow">Das Übliche</span>
          <strong class="usual-name">${esc(usual.item.name)}</strong>
          <div class="mods">${modBadges(usual.mods.filter((m) => !m.is_default))}</div>
          <span class="muted">${usual.count}× bestellt${usual.usual_time ? ` · meist um ${usual.usual_time} Uhr` : ''}</span>
        </div>
        <button class="btn-cafe big" type="button" id="usual-go">Bestellen · ${euro(usual.unit_price_cents)}</button>`;
    }
    $('usual').addEventListener('click', (e) => {
      if (e.target.id !== 'usual-go') return;
      cart.add(usual.item.id, 1, usual.mods.map((m) => m.id));
      try { if (usual.usual_time) sessionStorage.setItem('sasu.time', usual.usual_time); } catch {}
      go('#/warenkorb');
    });

    // --- Prämien-Strecke: one track with every reward as a milestone, tier badge in the corner ----------
    const short = (name) => name.replace(/^Gratis /, '');
    function renderLoyalty() {
      const t = user.tier;
      const steps = rewards.filter((r) => !r.birthday_only).sort((a, b) => a.cost_points - b.cost_points);
      const top = steps.at(-1)?.cost_points ?? 100;
      const scale = Math.max(top, user.points) * 1.06; // a little room after the last milestone
      const at = (pts) => `${Math.min(100, (pts / scale) * 100).toFixed(2)}%`;
      const next = steps.find((r) => r.cost_points > user.points);
      // "noch etwa N Bestellungen": from the guest's own average points per picked-up order (5 if new).
      const perOrder = user.stats.orders ? Math.max(1, Math.round(user.lifetime_points / user.stats.orders)) : 5;
      const visits = next ? Math.max(1, Math.ceil((next.cost_points - user.points) / perOrder)) : 0;
      const nextTier = NEXT_TIER[t.name];
      $('pass').className = `panel points-track ${t.name}`;
      $('pass').innerHTML = `
        <header>
          <div><span class="eyebrow">Ihre Treuepunkte</span><div class="points-now"><strong>${user.points}</strong> Punkte</div></div>
          <span class="tier-badge ${t.name}">${t.name}${t.discountPct ? ` · −${t.discountPct} %` : ''}</span>
        </header>
        <div class="track" role="img" aria-label="${user.points} Punkte; ${steps.map((r) => `${short(r.name)} ab ${r.cost_points}`).join(', ')}">
          <div class="rail"></div>
          <div class="fill" style="width:${at(user.points)}"></div>
          <div class="you" style="left:${at(user.points)}"><span>Sie: ${user.points}</span></div>
          ${steps.map((r) => {
            const ok = user.points >= r.cost_points;
            return `<div class="milestone${ok ? ' reached' : ''}" style="left:${at(r.cost_points)}">
              <span class="dot"></span>
              <span class="label"><b>${r.cost_points}</b> ${esc(short(r.name))}<small>${ok ? 'einlösbar' : `noch ${r.cost_points - user.points} Punkte`}</small></span>
            </div>`;
          }).join('')}
        </div>
        <ul class="track-legend">${steps.map((r) => `<li class="${user.points >= r.cost_points ? 'reached' : ''}"><b>${r.cost_points}</b> ${esc(short(r.name))} – ${user.points >= r.cost_points ? 'einlösbar' : `noch ${r.cost_points - user.points} Punkte`}</li>`).join('')}</ul>
        <p class="track-next">${next
          ? `Noch etwa <strong>${visits} ${visits === 1 ? 'Bestellung' : 'Bestellungen'}</strong> bis zum Gratis-${esc(short(next.name))}.`
          : '<strong>Alle Prämien sind einlösbar</strong> – wählen Sie im Warenkorb einfach eine aus.'}</p>
        <p class="track-tier">${TIER_PERK[t.name]}${nextTier ? ` · Noch ${t.next - user.lifetime_points} Punkte bis ${nextTier} (${nextTier === 'Silver' ? '5' : '10'} % Rabatt).` : ' · Höchste Stufe – vielen Dank für Ihre Treue!'}</p>`;
    }

    // --- favorites ------------------------------------------------------------------------------
    function renderFavorites() {
      $('favorites').innerHTML = favorites.length ? favorites.map((f) => `
        <div class="row-line fav">
          <img src="${esc(f.item.photo)}" alt="" />
          <div class="grow"><strong>${esc(f.item.name)}</strong> <span class="muted">${euro(f.unit_price_cents)}</span>
            <div class="mods">${modBadges(f.mods.filter((m) => !m.is_default))}</div></div>
          ${f.available ? `<button class="btn-cafe" data-fav-add="${f.id}">In den Warenkorb</button>` : '<span class="muted">gerade nicht verfügbar</span>'}
          <button class="star on" data-fav-del="${f.id}" aria-label="Aus Favoriten entfernen">★</button>
        </div>`).join('') : '<p class="muted">Tipp: Stellen Sie sich in der Speisekarte Ihr Getränk zusammen und tippen Sie auf ☆ – dann liegt es hier mit einem Klick bereit.</p>';
    }
    $('favorites').addEventListener('click', async (e) => {
      const add = e.target.dataset.favAdd;
      const del = e.target.dataset.favDel;
      if (add) {
        const f = favorites.find((x) => x.id === Number(add));
        cart.add(f.item.id, 1, f.mods.map((m) => m.id));
        toast(`${f.item.name} im Warenkorb`);
      }
      if (del) {
        try { await api(`/api/me/favorites/${del}`, { method: 'DELETE' }); favorites = favorites.filter((x) => x.id !== Number(del)); renderFavorites(); } catch (err) { toast(err.message); }
      }
    });

    // --- stats + rewards ---------------------------------------------------------------------------
    function renderStats() {
      const stat = (label, value, hint) => `<div class="stat"><div class="label">${label}</div><div class="value">${value}</div><div class="hint">${hint}</div></div>`;
      const treats = user.stats.rewards_redeemed;
      $('stats').innerHTML = stat('Gespart', euro(user.stats.saved_cents), user.stats.saved_cents ? 'mit Rabatten und Prämien' : 'ab Silver gibt\'s Rabatt')
        + stat('Gratis genossen', treats, treats === 1 ? 'Leckerei auf uns' : 'Leckereien auf uns')
        + stat('Ihr Favorit', user.stats.favorite ? esc(user.stats.favorite) : '—', user.stats.favorite ? 'am häufigsten bestellt' : 'noch nichts bestellt');
      const bday = rewards.find((r) => r.birthday_only);
      $('bday-banner').hidden = !user.birthday_week;
      $('bday-banner').innerHTML = user.birthday_week
        ? `<strong>Alles Gute zum Geburtstag, ${esc(user.name)}!</strong>
           <span>${bday ? 'Ihr Geburtstagskaffee geht auf uns – wählen Sie im Warenkorb die Prämie „Geburtstagskaffee“.' : 'Schön, dass Sie da sind – feiern Sie schön!'}</span>`
        : '';
    }

    // --- order history ---------------------------------------------------------------------------
    function renderOrders() {
      const open = new Set([...root.querySelectorAll('.order[open]')].map((d) => d.dataset.id));
      $('order-list').innerHTML = orders.length ? orders.map((o) => `
        <details class="order" data-id="${o.id}" ${open.has(String(o.id)) ? 'open' : ''}>
          <summary>
            <div><strong>${esc(orderName(o))}</strong><br /><span class="muted">Bestellt ${whenLabel(o.created_at)}</span></div>
            <span class="status ${o.status === 'ready' ? 'ready' : o.status === 'cancelled' ? 'cancelled' : ''}">${STATUS[o.status]}</span>
            <strong>${euro(o.total_cents)}</strong>
          </summary>
          <div class="detail">
            <p class="muted">Abholung ${whenLabel(o.pickup_at)}</p>
            <table>
              ${o.items.map((i) => `<tr><td>${i.qty}× ${esc(i.name)}<div class="mods">${modBadges(i.modifiers)}</div></td><td>${euro(i.unit_price_cents * i.qty)}</td></tr>`).join('')}
              <tr><td class="muted">Zwischensumme</td><td>${euro(o.subtotal_cents)}</td></tr>
              ${o.discount_cents ? `<tr><td class="muted">Rabatt${o.gift_id ? ' inkl. Gutschein' : o.reward_id ? ' inkl. Prämie' : ''}</td><td>−${euro(o.discount_cents)}</td></tr>` : ''}
              <tr class="sum"><td>Gesamt (bezahlt bei Abholung)</td><td>${euro(o.total_cents)}</td></tr>
            </table>
            <div class="buttons">
              <button class="btn-cafe" data-reorder="${o.id}">Nochmal bestellen</button>
              ${o.status === 'new' ? `<button class="btn-ghost" data-cancel="${o.id}">Bestellung stornieren</button>` : ''}
            </div>
          </div>
        </details>`).join('') : '<p>Sie haben noch nichts bestellt. <a class="btn-cafe" href="#/speisekarte">Zur Speisekarte</a></p>';
    }
    $('order-list').addEventListener('click', async (e) => {
      const { cancel, reorder } = e.target.dataset;
      if (cancel) {
        try { await api(`/api/orders/${cancel}/cancel`, { method: 'POST' }); toast('Bestellung storniert'); refresh(); } catch (err) { toast(err.message); }
      }
      if (reorder) {
        for (const i of orders.find((o) => o.id === Number(reorder)).items) cart.add(i.menu_item_id, i.qty, i.modifiers.map((m) => m.option_id).filter(Boolean));
        go('#/warenkorb');
      }
    });

    // --- profile + preferences -----------------------------------------------------------------
    function fillProfile() {
      $('p-name').value = user.name;
      $('p-email').value = user.email;
      $('p-birthday').value = user.birthday || '';
      $('p-member').value = user.member_id;
      $('pf-vegan').checked = user.preferences.vegan_only;
      $('pf-milk').value = user.preferences.milk ?? '';
    }
    getMenu().then((menu) => {
      if (!alive()) return;
      const milks = [...new Set(menu.flatMap((i) => i.modifiers).filter((g) => g.name === 'Milch').flatMap((g) => g.options.map((o) => o.name)))];
      $('pf-milk').innerHTML = '<option value="">Keine Vorliebe</option>' + milks.map((m) => `<option>${esc(m)}</option>`).join('');
      if (user) $('pf-milk').value = user.preferences.milk ?? '';
    }).catch(() => {});
    $('prefs-form').addEventListener('submit', async (e) => {
      e.preventDefault();
      try {
        user = await api('/api/me', { method: 'PATCH', body: { preferences: { milk: $('pf-milk').value || null, vegan_only: $('pf-vegan').checked } } });
        session.user = user;
        toast('Vorlieben gespeichert – die Speisekarte wählt sie für Sie vor');
      } catch (err) { toast(err.message); }
    });
    $('profile-form').addEventListener('submit', async (e) => {
      e.preventDefault();
      $('profile-error').textContent = '';
      try {
        user = await api('/api/me', { method: 'PATCH', body: { name: $('p-name').value, email: $('p-email').value, birthday: $('p-birthday').value || null } });
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

    // --- load + live status -------------------------------------------------------------
    async function refresh() {
      let me, list;
      try {
        [me, rewards, list] = await Promise.all([api('/api/me'), api('/api/rewards'), api('/api/orders')]);
      } catch (err) {
        if (!alive()) return;
        if (err.status !== 401) return toast(err.message);
        me = null; // session expired while on this page
      }
      if (!alive()) return;
      if (!me) {
        await session.refresh();
        return go('#/login?next=%23%2Fkonto');
      }
      session.user = me;
      user = me;
      orders = list;
      for (const o of orders) {
        if (lastStatus[o.id] && lastStatus[o.id] !== 'ready' && o.status === 'ready') toast(`${orderName(o)} ${orderIsPlural(o) ? 'sind' : 'ist'} abholbereit`);
        lastStatus[o.id] = o.status;
      }
      renderWelcome();
      renderPulse();
      renderLoyalty();
      renderStats();
      renderOrders();
      gifts?.showPoints();
      clearTimeout(timer);
      if (orders.some((o) => ACTIVE.includes(o.status))) timer = setTimeout(refresh, 10000);
    }

    // Member card: QR big at the counter; "Karte aufs Handy" saves it as an image.
    $('card').addEventListener('click', (e) => { // on the card itself: <main> outlives this view
      if (e.target.closest('#qr-open')) {
        $('qr-mid').textContent = user.member_id;
        $('qr-dialog').showModal();
      }
    });
    $('qr-close').addEventListener('click', () => $('qr-dialog').close());
    $('qr-dialog').addEventListener('click', (e) => { if (e.target === e.currentTarget) e.currentTarget.close(); });
    $('card-save').addEventListener('click', async () => {
      try { await saveCardImage(user); toast('Karte gespeichert – legen Sie sie in Ihre Fotos oder als Sperrbildschirm'); } catch { toast('Speichern hat nicht geklappt'); }
    });

    showTab(params.get('tab') ?? 'overview');
    await refresh();
    if (!alive()) return;
    fillProfile();
    mountBeans(root, alive);
    gifts = mountGifts(root, alive, () => user, refresh);
    [usual, favorites] = await Promise.all([api('/api/me/usual').catch(() => null), api('/api/me/favorites').catch(() => [])]);
    if (!alive()) return;
    renderUsual();
    renderFavorites();
    if (params.has('placed') && orders[0]) toast(`Danke! ${orderName(orders[0])} – Abholung ${whenLabel(orders[0].pickup_at)}.`);
    if (params.get('welcome')) toast(`Willkommen! Ihre Mitgliedsnummer: ${params.get('welcome')}`);
  },
  unmount() {
    clearTimeout(timer); // stop the 10-second order refresh
  },
};
