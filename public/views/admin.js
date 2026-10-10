// Dashboard for staff and the owner: kitchen display, sold-out switches, finances,
// menu editor, staff management, shifts and own working time.
import { api, euro, esc, toast, session, modBadges, whenLabel } from '../app.js';

const fmtClock = new Intl.DateTimeFormat('de-DE', { timeZone: 'Europe/Berlin', hour: '2-digit', minute: '2-digit' });
const fmtDateTime = new Intl.DateTimeFormat('de-DE', { timeZone: 'Europe/Berlin', weekday: 'short', day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit' });
const NEXT = { new: 'preparing', preparing: 'ready', ready: 'picked_up' };
const NEXT_LABEL = { new: 'Zubereiten', preparing: 'Fertig', ready: 'Abgeholt' };
const STATE_LABEL = { new: 'Neu', preparing: 'In Arbeit', ready: 'Abholbereit' };
const CATEGORY = { coffee: 'Kaffee', cold: 'Kalt', cake: 'Kuchen', pastry: 'Gebäck' };
const TAG_LABEL = { vegan: 'vegan', plant: 'vegan mit Pflanzenmilch', gluten: 'Gluten', nuts: 'Nüsse', lactose: 'Laktose' };
const hours = (h) => h.toFixed(1).replace('.', ',') + ' h';
const fmtShort = new Intl.DateTimeFormat('de-DE', { timeZone: 'Europe/Berlin', day: '2-digit', month: '2-digit' });
const fmtWeekday = new Intl.DateTimeFormat('de-DE', { timeZone: 'Europe/Berlin', weekday: 'short' });
const fmtDayTime = new Intl.DateTimeFormat('de-DE', { timeZone: 'Europe/Berlin', weekday: 'short', day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit' });
const dayKey = (d) => d.toLocaleDateString('en-CA', { timeZone: 'Europe/Berlin' }); // YYYY-MM-DD in Berlin
const timeRange = (p) => `${fmtClock.format(new Date(p.start))}–${fmtClock.format(new Date(p.end)).replace(/^00:00$/, '24:00')}`;
// Calendar-day steps (not 24 h): a day is 23 or 25 hours when the clocks change.
function addDays(d, n) {
  const x = new Date(d);
  x.setDate(x.getDate() + n);
  return x;
}
function mondayOf(d) {
  const day = new Date(`${dayKey(d)}T00:00:00`);
  day.setDate(day.getDate() - ((day.getDay() + 6) % 7));
  return day;
}
function isoWeek(d) {
  const t = new Date(Date.UTC(d.getFullYear(), d.getMonth(), d.getDate()));
  t.setUTCDate(t.getUTCDate() + 4 - (t.getUTCDay() || 7));
  return Math.ceil(((t - Date.UTC(t.getUTCFullYear(), 0, 1)) / 864e5 + 1) / 7);
}
const cents = (value) => Math.round(Number(String(value).replace(',', '.')) * 100);

let pollTimer;
let workTimer; // refreshes "Meine Zeit" while it's open
let stream; // camera stream of the QR scanner
let scanTimer;

function stopCamera() {
  clearTimeout(scanTimer);
  stream?.getTracks().forEach((t) => t.stop());
  stream = null;
}

export default {
  title: 'Dashboard',
  hero: false,
  auth: 'staff',
  async mount(root, params, alive) {
    const $ = (id) => root.querySelector('#' + id);
    const view = root.querySelector('.dash'); // listeners go here: <main> outlives this view, .dash doesn't
    const user = await session.get();
    const isAdmin = user.role === 'admin';
    root.querySelectorAll('[data-admin]').forEach((b) => { b.hidden = !isAdmin; });
    const fail = (el) => (err) => { if (alive()) el.innerHTML = `<p class="error">${esc(err.message)}</p>`; };

    // --- tabs ---------------------------------------------------------------------
    const LOADERS = { kitchen: loadKitchen, soldout: loadSoldOut, beans: loadBeans, finance: loadFinance, menu: loadMenu, team: loadTeam, shifts: loadShifts, rota: loadRota, mytime: loadMyTime };
    $('admin-tabs').addEventListener('click', (e) => {
      const tab = e.target.dataset.tab;
      if (!tab) return;
      clearTimeout(pollTimer);
      clearTimeout(workTimer);
      $('admin-tabs').querySelectorAll('button').forEach((b) => b.setAttribute('aria-pressed', b === e.target));
      root.querySelectorAll('[data-panel]').forEach((p) => { p.hidden = p.dataset.panel !== tab; });
      LOADERS[tab]();
    });

    // --- kitchen display: tickets ------------------------------------------------------
    const ticket = (o) => `
      <article class="ticket ${o.status}">
        <header>
          <div class="when"><span class="time">${fmtClock.format(new Date(o.pickup_at))}</span><span class="day">${whenLabel(o.pickup_at).split(',')[0]}</span></div>
          <span class="state">${STATE_LABEL[o.status]}</span>
        </header>
        <div class="who">${esc(o.customer)} <small>${esc(o.member_id)}</small></div>
        <ul class="lines">${o.items.map((i) => `<li><b>${i.qty}×</b> ${esc(i.name)}<div class="mods">${modBadges(i.modifiers)}</div></li>`).join('')}</ul>
        <footer>
          <button class="kds-go" data-id="${o.id}" data-status="${NEXT[o.status]}">${NEXT_LABEL[o.status]}</button>
          ${o.status === 'new' ? `<button class="kds-cancel" data-id="${o.id}" data-status="cancelled">Stornieren</button>` : ''}
        </footer>
      </article>`;

    async function loadOrders() {
      clearTimeout(pollTimer);
      const orders = await api('/api/admin/orders').catch(fail($('open-orders')));
      if (!orders || !alive()) return;
      $('open-orders').innerHTML = orders.length ? orders.map(ticket).join('') : '<p class="kds-empty">Keine offenen Bestellungen. Zeit für einen Kaffee.</p>';
      if (!root.querySelector('[data-panel="kitchen"]').hidden) pollTimer = setTimeout(loadOrders, 10000);
    }

    async function advance(btn) {
      btn.disabled = true;
      try {
        await api(`/api/admin/orders/${btn.dataset.id}`, { method: 'PATCH', body: { status: btn.dataset.status } });
        if (btn.dataset.status === 'picked_up') toast('Abgeholt – Punkte gutgeschrieben');
      } catch (err) { toast(err.message); }
      loadOrders();
      if (!$('lookup-result').hidden && $('lookup-result').dataset.member) lookup($('lookup-result').dataset.member);
    }
    view.addEventListener('click', (e) => {
      const btn = e.target.closest('[data-status][data-id]');
      if (btn) advance(btn);
    });

    // --- kitchen display: rush controls ---------------------------------------------------
    function showSettings(s) {
      $('t-pause').setAttribute('aria-pressed', !!s.orders_paused);
      $('t-pause-state').textContent = s.orders_paused ? 'PAUSIERT' : 'Aktiv';
      $('t-delay').setAttribute('aria-pressed', s.extra_delay_min > 0);
      $('t-delay-state').textContent = s.extra_delay_min ? 'An – Abholung ab 30 min' : 'Aus';
    }
    async function setSetting(body) {
      try { showSettings(await api('/api/admin/settings', { method: 'PATCH', body })); } catch (err) { toast(err.message); }
    }
    $('t-pause').addEventListener('click', () => {
      const on = $('t-pause').getAttribute('aria-pressed') !== 'true';
      setSetting({ orders_paused: on ? 1 : 0 });
      toast(on ? 'Online-Bestellungen pausiert' : 'Online-Bestellungen wieder aktiv');
    });
    $('t-delay').addEventListener('click', () => {
      const on = $('t-delay').getAttribute('aria-pressed') !== 'true';
      setSetting({ extra_delay_min: on ? 15 : 0 });
      toast(on ? 'Abholung jetzt frühestens in 30 Minuten' : 'Abholung wieder ab 15 Minuten');
    });

    // --- kitchen display: member lookup (typed, USB scanner or camera) -------------------
    async function lookup(memberId) {
      const box = $('lookup-result');
      if (/^G-/i.test(memberId.trim())) return lookupGift(memberId.trim().toUpperCase());
      try {
        const m = await api(`/api/admin/members/${encodeURIComponent(memberId.trim())}`);
        if (!alive()) return;
        box.dataset.member = m.member_id;
        box.innerHTML = `
          <div class="member-hit">
            <div><strong>${esc(m.name)}</strong> <small>${esc(m.member_id)} · ${m.tier.name} · ${m.points} Punkte</small></div>
            <button class="kds-btn" type="button" id="lookup-close" aria-label="Schließen">×</button>
          </div>
          <div class="kds-grid">${m.orders.length ? m.orders.map((o) => ticket({ ...o, customer: m.name, member_id: m.member_id })).join('') : '<p class="kds-empty">Keine offenen Bestellungen für dieses Mitglied.</p>'}</div>`;
      } catch (err) {
        box.dataset.member = '';
        box.innerHTML = `<div class="member-hit miss"><span>${esc(err.message)}</span><button class="kds-btn" type="button" id="lookup-close" aria-label="Schließen">×</button></div>`;
      }
      box.hidden = false;
    }
    // Gift codes (G-…): see the gift; activate it once paid at the counter.
    const GIFT_STATE = { pending: 'wartet auf Bezahlung', active: 'einlösbar', redeemed: 'eingelöst', cancelled: 'storniert' };
    async function lookupGift(code) {
      const box = $('lookup-result');
      box.dataset.member = '';
      try {
        const g = await api(`/api/admin/gifts/${encodeURIComponent(code)}`);
        if (!alive()) return;
        box.innerHTML = `<div class="member-hit">
            <div><strong>Gutschein für ${esc(g.recipient_name)}</strong> <small>${esc(g.code)} · von ${esc(g.sender.name)} · ${GIFT_STATE[g.status]}</small></div>
            <button class="kds-btn" type="button" id="lookup-close" aria-label="Schließen">×</button></div>
          ${g.status === 'pending' ? `<button class="kds-go" type="button" data-activate="${esc(g.code)}">5,00 € kassiert – Gutschein aktivieren</button>` : ''}`;
      } catch (err) {
        box.innerHTML = `<div class="member-hit miss"><span>${esc(err.message)}</span><button class="kds-btn" type="button" id="lookup-close" aria-label="Schließen">×</button></div>`;
      }
      box.hidden = false;
    }

    $('lookup-form').addEventListener('submit', (e) => {
      e.preventDefault();
      const id = $('lookup-id').value.trim();
      if (!id) return;
      lookup(id);
      $('lookup-id').value = '';
    });
    $('lookup-result').addEventListener('click', async (e) => {
      const code = e.target.dataset.activate;
      if (code) {
        try { await api(`/api/admin/gifts/${encodeURIComponent(code)}/activate`, { method: 'POST' }); toast('Gutschein aktiviert'); lookupGift(code); } catch (err) { toast(err.message); }
        return;
      }
      if (e.target.id === 'lookup-close') { $('lookup-result').hidden = true; $('lookup-result').dataset.member = ''; }
    });

    // Camera scan with the browser's own BarcodeDetector (Chrome/Edge); elsewhere the input field is used.
    if ('BarcodeDetector' in window && navigator.mediaDevices?.getUserMedia) $('scan-btn').hidden = false;
    let starting = false;
    $('scan-btn').addEventListener('click', async () => {
      if (starting || stream) return; // one camera at a time (double taps)
      starting = true;
      $('scan-btn').disabled = true;
      let s;
      try {
        const detector = new window.BarcodeDetector({ formats: ['qr_code'] });
        s = await navigator.mediaDevices.getUserMedia({ video: { facingMode: 'environment' } });
        if (!alive()) { s.getTracks().forEach((t) => t.stop()); return; } // left the page while the camera started
        stream = s;
        $('scan-video').srcObject = stream;
        await $('scan-video').play();
        $('scan-dialog').showModal();
        const tick = async () => {
          if (!stream) return;
          const [code] = await detector.detect($('scan-video')).catch(() => []);
          if (code?.rawValue) {
            stopCamera();
            $('scan-dialog').close();
            lookup(code.rawValue);
          } else scanTimer = setTimeout(tick, 250);
        };
        tick();
      } catch {
        s?.getTracks().forEach((t) => t.stop());
        stopCamera();
        if (alive()) toast('Kamera nicht verfügbar – bitte Nummer eingeben');
      } finally {
        starting = false;
        if (alive()) $('scan-btn').disabled = false;
      }
    });
    $('scan-close').addEventListener('click', () => { stopCamera(); $('scan-dialog').close(); });
    $('scan-dialog').addEventListener('close', stopCamera);

    async function loadKitchen() {
      api('/api/admin/settings').then((s) => alive() && showSettings(s)).catch(() => {});
      // Who's on today: planned shifts, ● when clocked in.
      api(`/api/admin/rota?from=${dayKey(new Date())}&days=1`).then((plan) => {
        if (!alive()) return;
        const today = plan.filter((p) => dayKey(new Date(p.start)) === dayKey(new Date()));
        $('kds-today').innerHTML = today.length
          ? `<span class="label">Heute im Dienst</span>${today.map((p) => `<span class="person${p.on_shift ? ' on' : ''}">${esc(p.name.split(' ')[0])} <small>${timeRange(p)}</small></span>`).join('')}`
          : '<span class="label">Heute ist niemand eingeplant</span>';
      }).catch(() => {});
      loadOrders();
    }

    // --- sold out -------------------------------------------------------------------------
    const switchHtml = (id, on, label, kind) => `<label class="switch"><input type="checkbox" data-${kind}="${id}" ${on ? 'checked' : ''} aria-label="${esc(label)}" /><span></span></label>`;
    async function loadSoldOut() {
      const items = await api('/api/admin/menu').catch(fail($('soldout-list')));
      if (!items || !alive()) return;
      $('soldout-list').innerHTML = Object.entries(CATEGORY).map(([key, title]) => `
        <h3>${title}</h3>
        <div class="soldout-grid">${items.filter((i) => i.category === key && i.active).map((i) => `
          <div class="soldout-row${i.sold_out ? ' is-out' : ''}"><span>${esc(i.name)}</span>${switchHtml(i.id, i.sold_out, `${i.name} ausverkauft`, 'soldout')}</div>`).join('')}
        </div>`).join('');
    }
    view.addEventListener('change', async (e) => {
      const id = e.target.dataset.soldout;
      if (!id) return;
      try {
        const item = await api(`/api/admin/menu/${id}/sold-out`, { method: 'PATCH', body: { sold_out: e.target.checked ? 1 : 0 } });
        e.target.closest('.soldout-row, tr')?.classList.toggle('is-out', !!item.sold_out);
        toast(item.sold_out ? `${item.name}: ausverkauft` : `${item.name}: wieder verfügbar`);
      } catch (err) { toast(err.message); e.target.checked = !e.target.checked; }
    });

    // --- bean subscriptions due ----------------------------------------------------------------
    const BEAN = { espresso: 'Espresso', filter: 'Filter', decaf: 'Entkoffeiniert' };
    async function loadBeans() {
      const due = await api('/api/admin/beans?days=7').catch(fail($('bean-due')));
      if (!due || !alive()) return;
      const today = dayKey(new Date());
      $('bean-due').innerHTML = due.length ? due.map((b) => `
        <div class="row-line">
          <div class="grow"><strong>${esc(b.name)}</strong> <span class="muted">${esc(b.member_id)}</span><br />
            ${BEAN[b.bean]} · ${b.size === '1kg' ? '1 kg' : '250 g'} · ${euro(b.price_cents)} ·
            <span class="${b.next_pickup <= today ? 'status ready' : 'muted'}">${b.next_pickup < today ? 'überfällig' : b.next_pickup === today ? 'heute' : fmtShort.format(new Date(`${b.next_pickup}T12:00:00`))}</span></div>
          <button class="btn-cafe" type="button" data-handed="${b.id}">Ausgegeben</button>
        </div>`).join('') : '<p class="muted">Diese Woche ist keine Tüte fällig.</p>';
    }
    $('bean-due').addEventListener('click', async (e) => {
      const id = e.target.dataset.handed;
      if (!id) return;
      e.target.disabled = true;
      try { await api(`/api/admin/beans/${id}/handed`, { method: 'POST' }); toast('Ausgegeben – nächste Abholung geplant'); loadBeans(); } catch (err) { toast(err.message); e.target.disabled = false; }
    });

    // --- finance (owner) ------------------------------------------------------------------
    let range = 'week';
    async function loadFinance() {
      const f = await api(`/api/admin/finance?range=${range}`).catch(fail($('stats')));
      if (!f || !alive()) return;
      const stat = (label, value, cls = '') => `<div class="stat"><div class="label">${label}</div><div class="value ${cls}">${value}</div></div>`;
      $('stats').innerHTML = stat('Umsatz', euro(f.revenue)) + stat('Personalkosten', euro(f.wages))
        + stat('Ergebnis', euro(f.profit), f.profit < 0 ? 'neg' : '') + stat('Bestellungen', f.orders)
        + stat('Ø Bon', f.orders ? euro(Math.round(f.revenue / f.orders)) : '—');
      const max = Math.max(1, ...f.top.map((t) => t.qty));
      $('top').innerHTML = f.top.map((t) => `
        <div class="row-line"><div style="width:180px">${esc(t.name)}</div>
          <div class="grow"><div class="bar" style="width:${(t.qty / max) * 100}%"></div></div><strong>${t.qty}×</strong></div>`).join('')
        || '<p class="muted">Noch keine Verkäufe in diesem Zeitraum.</p>';
    }
    $('range').addEventListener('click', (e) => {
      if (!e.target.dataset.range) return;
      range = e.target.dataset.range;
      $('range').querySelectorAll('button').forEach((b) => b.setAttribute('aria-pressed', b === e.target));
      loadFinance();
    });

    // --- menu editor (owner) ---------------------------------------------------------------
    let menuItems = [];
    let editing = null; // item being edited, or null for a new one
    async function loadMenu() {
      menuItems = await api('/api/admin/menu').catch(fail($('menu-table'))) || [];
      if (!alive()) return;
      $('menu-table').innerHTML = `
        <thead><tr><th></th><th>Artikel</th><th>Kategorie</th><th>Preis</th><th>Ausverkauft</th><th>Sichtbar</th><th></th></tr></thead>
        <tbody>${menuItems.map((i) => `<tr class="${i.active ? '' : 'is-hidden'}${i.sold_out ? ' is-out' : ''}">
          <td><img class="thumb" src="${esc(i.photo)}" alt="" loading="lazy" /></td>
          <td><strong>${esc(i.name)}</strong><div class="muted small">${i.tags.split(',').filter(Boolean).map((t) => TAG_LABEL[t] || t).join(' · ')}</div></td>
          <td>${CATEGORY[i.category]}</td>
          <td class="num">${euro(i.price_cents)}</td>
          <td>${switchHtml(i.id, i.sold_out, `${i.name} ausverkauft`, 'soldout')}</td>
          <td>${switchHtml(i.id, i.active, `${i.name} sichtbar`, 'visible')}</td>
          <td class="actions"><button class="btn-ghost" data-edit="${i.id}">Bearbeiten</button><button class="btn-ghost danger" data-delete="${i.id}">Löschen</button></td>
        </tr>`).join('')}</tbody>`;
    }
    $('menu-table').addEventListener('change', async (e) => {
      const id = e.target.dataset.visible;
      if (!id) return;
      try {
        await api(`/api/admin/menu/${id}`, { method: 'PATCH', body: { active: e.target.checked ? 1 : 0 } });
        e.target.closest('tr').classList.toggle('is-hidden', !e.target.checked);
        toast(e.target.checked ? 'Wieder auf der Speisekarte' : 'Von der Speisekarte genommen');
      } catch (err) { toast(err.message); e.target.checked = !e.target.checked; }
    });
    $('menu-table').addEventListener('click', async (e) => {
      const edit = e.target.dataset.edit;
      const del = e.target.dataset.delete;
      if (edit) openEditor(menuItems.find((i) => i.id === Number(edit)));
      if (del) {
        // Two taps: the first arms the button, the second deletes.
        if (e.target.dataset.armed !== '1') {
          e.target.dataset.armed = '1';
          e.target.textContent = 'Wirklich löschen?';
          setTimeout(() => { if (e.target.isConnected) { e.target.dataset.armed = ''; e.target.textContent = 'Löschen'; } }, 4000);
          return;
        }
        try {
          const r = await api(`/api/admin/menu/${del}`, { method: 'DELETE' });
          toast(r.deleted ? 'Artikel gelöscht' : 'Schon bestellt – Artikel ausgeblendet statt gelöscht');
          loadMenu();
        } catch (err) { toast(err.message); }
      }
    });
    $('new-item').addEventListener('click', () => openEditor(null));

    function openEditor(item) {
      editing = item;
      $('ed-title').textContent = item ? 'Artikel bearbeiten' : 'Neuer Artikel';
      $('ed-name').value = item?.name ?? '';
      $('ed-price').value = item ? (item.price_cents / 100).toFixed(2) : '';
      $('ed-cat').value = item?.category ?? 'coffee';
      $('ed-desc').value = item?.description ?? '';
      const tags = (item?.tags ?? '').split(',');
      root.querySelectorAll('.tag-boxes input').forEach((c) => { c.checked = tags.includes(c.value); });
      $('ed-photo').value = item?.photo ?? '';
      $('ed-preview').src = item?.photo ?? 'photos/logo.png';
      $('ed-error').textContent = '';
      $('item-editor').showModal();
    }
    $('ed-photo').addEventListener('change', () => { $('ed-preview').src = $('ed-photo').value || 'photos/logo.png'; });
    $('ed-cancel').addEventListener('click', () => $('item-editor').close());
    $('editor-form').addEventListener('submit', async (e) => {
      e.preventDefault();
      const body = {
        name: $('ed-name').value.trim(),
        price_cents: cents($('ed-price').value),
        category: $('ed-cat').value,
        description: $('ed-desc').value.trim(),
        tags: [...root.querySelectorAll('.tag-boxes input:checked')].map((c) => c.value).join(','),
      };
      if ($('ed-photo').value.trim()) body.photo = $('ed-photo').value.trim();
      try {
        await api(editing ? `/api/admin/menu/${editing.id}` : '/api/admin/menu', { method: editing ? 'PATCH' : 'POST', body });
        $('item-editor').close();
        toast(editing ? 'Gespeichert' : 'Artikel angelegt');
        loadMenu();
      } catch (err) { $('ed-error').textContent = err.message; }
    });

    // --- team (owner) ------------------------------------------------------------------------
    async function loadTeam() {
      const team = await api('/api/admin/staff').catch(fail($('team-table')));
      if (!team || !alive()) return;
      $('team-table').innerHTML = `
        <thead><tr><th>Name</th><th>Rolle</th><th>Stundenlohn</th><th>Status</th><th>Aktiv</th></tr></thead>
        <tbody>${team.map((u) => `<tr class="${u.active ? '' : 'is-hidden'}">
          <td><strong>${esc(u.name)}</strong><div class="muted small">${esc(u.member_id)} · ${esc(u.email)}</div></td>
          <td>${u.role === 'admin' ? 'Inhaberin' : 'Personal'}</td>
          <td><input class="wage" type="number" step="0.01" min="0" value="${(u.hourly_wage / 100).toFixed(2)}" data-wage="${u.id}" aria-label="Stundenlohn ${esc(u.name)}" /> €</td>
          <td>${u.on_shift ? '<span class="status ready">Im Dienst</span>' : u.must_change_password ? '<span class="status">Erstes Login offen</span>' : '<span class="muted">—</span>'}</td>
          <td>${u.id === user.id ? '<span class="muted small">Sie</span>' : switchHtml(u.id, u.active, `${u.name} aktiv`, 'active')}</td>
        </tr>`).join('')}</tbody>`;
    }
    $('team-table').addEventListener('change', async (e) => {
      const { wage, active } = e.target.dataset;
      const id = wage || active;
      if (!id) return;
      const body = wage ? { hourly_wage: cents(e.target.value) } : { active: e.target.checked ? 1 : 0 };
      try {
        await api(`/api/admin/staff/${id}`, { method: 'PATCH', body });
        toast(wage ? 'Stundenlohn gespeichert' : e.target.checked ? 'Konto aktiviert' : 'Konto deaktiviert – abgemeldet');
        loadTeam();
      } catch (err) { toast(err.message); loadTeam(); }
    });
    $('staff-form').addEventListener('submit', async (e) => {
      e.preventDefault();
      $('sf-error').textContent = '';
      try {
        const u = await api('/api/admin/staff', { method: 'POST', body: {
          name: $('sf-name').value, email: $('sf-email').value, password: $('sf-pw').value, hourly_wage: cents($('sf-wage').value),
        } });
        e.target.reset();
        toast(`${u.name} angelegt (${u.member_id}) – Passwort beim ersten Login ändern`);
        loadTeam();
      } catch (err) { $('sf-error').textContent = err.message; }
    });

    // --- shifts & labour cost (owner) ---------------------------------------------------------
    let shiftRange = 'week';
    $('payroll-month').value = new Date().toISOString().slice(0, 7);
    const payrollHref = () => `/api/admin/payroll.csv?month=${$('payroll-month').value}`;
    $('payroll-link').href = payrollHref();
    $('payroll-month').addEventListener('change', () => { $('payroll-link').href = payrollHref(); });
    $('payroll-form').addEventListener('submit', (e) => e.preventDefault());

    async function loadShifts() {
      const r = await api(`/api/admin/shifts/list?range=${shiftRange}`).catch(fail($('shift-table')));
      if (!r || !alive()) return;
      $('shift-totals').innerHTML = r.totals.map((t) => `<div class="stat"><div class="label">${esc(t.name)}</div>
        <div class="value">${euro(t.cost_cents)}</div><div class="hint">${hours(t.hours)} in ${t.shifts} ${t.shifts === 1 ? 'Schicht' : 'Schichten'}</div></div>`).join('')
        || '<p class="muted">Keine Schichten in diesem Zeitraum.</p>';
      $('shift-table').innerHTML = `
        <thead><tr><th>Mitarbeiter</th><th>Beginn</th><th>Ende</th><th class="num">Stunden</th><th class="num">Kosten</th></tr></thead>
        <tbody>${r.shifts.map((s) => `<tr>
          <td>${esc(s.name)}</td><td>${fmtDateTime.format(new Date(s.clock_in))}</td>
          <td>${s.clock_out ? fmtDateTime.format(new Date(s.clock_out)) : '<span class="status ready">läuft</span>'}</td>
          <td class="num">${hours(s.hours)}</td><td class="num">${euro(s.cost_cents)}</td></tr>`).join('')}</tbody>`;
    }
    $('shift-range').addEventListener('click', (e) => {
      if (!e.target.dataset.range) return;
      shiftRange = e.target.dataset.range;
      $('shift-range').querySelectorAll('button').forEach((b) => b.setAttribute('aria-pressed', b === e.target));
      loadShifts();
    });

    // --- rota (Dienstplan): week grid; the owner adds and removes shifts ----------------------
    let weekStart = mondayOf(new Date());
    let staffList = [];
    async function loadRota() {
      const days = Array.from({ length: 7 }, (_, i) => addDays(weekStart, i));
      $('rota-label').textContent = `KW ${isoWeek(weekStart)} · ${fmtShort.format(days[0])} – ${fmtShort.format(days[6])}`;
      const [plan, team] = await Promise.all([
        api(`/api/admin/rota?from=${dayKey(weekStart)}&days=7`).catch(fail($('rota-grid'))),
        isAdmin ? api('/api/admin/staff').catch(() => []) : Promise.resolve([]),
      ]);
      if (!plan || !alive()) return;
      staffList = team.filter((u) => u.active);
      if (isAdmin && !$('ro-user').options.length) {
        $('ro-user').innerHTML = staffList.map((u) => `<option value="${u.id}">${esc(u.name)}</option>`).join('');
        $('ro-date').value = dayKey(new Date());
      }
      const people = [...new Map([...staffList.map((u) => [u.id, u.name]), ...plan.map((p) => [p.user_id, p.name])]).entries()];
      const today = dayKey(new Date());
      $('rota-grid').innerHTML = `
        <thead><tr><th></th>${days.map((d) => `<th class="${dayKey(d) === today ? 'today' : ''}">${fmtWeekday.format(d)}<br /><small>${fmtShort.format(d)}</small></th>`).join('')}</tr></thead>
        <tbody>${people.map(([uid, name]) => `<tr class="${uid === user.id ? 'mine' : ''}"><th>${esc(name)}</th>${days.map((d) => {
          const mine = plan.filter((p) => p.user_id === uid && dayKey(new Date(p.start)) === dayKey(d));
          return `<td class="${dayKey(d) === today ? 'today' : ''}">${mine.map((p) => `<div class="chip">${timeRange(p)}${p.note ? `<small>${esc(p.note)}</small>` : ''}${isAdmin ? `<button type="button" data-unplan="${p.id}" aria-label="Schicht entfernen">×</button>` : ''}</div>`).join('')}</td>`;
        }).join('')}</tr>`).join('') || `<tr><td colspan="8" class="muted">In dieser Woche ist noch nichts geplant.</td></tr>`}</tbody>`;
    }
    $('rota-prev').addEventListener('click', () => { weekStart = addDays(weekStart, -7); loadRota(); });
    $('rota-next').addEventListener('click', () => { weekStart = addDays(weekStart, 7); loadRota(); });
    $('rota-grid').addEventListener('click', async (e) => {
      const id = e.target.dataset.unplan;
      if (!id) return;
      try { await api(`/api/admin/rota/${id}`, { method: 'DELETE' }); toast('Schicht entfernt'); loadRota(); } catch (err) { toast(err.message); }
    });
    $('rota-form').addEventListener('submit', async (e) => {
      e.preventDefault();
      $('ro-error').textContent = '';
      const date = $('ro-date').value;
      const start = new Date(`${date}T${$('ro-start').value}`);
      const end = new Date(`${date}T${$('ro-end').value}`);
      if (end <= start) end.setDate(end.getDate() + 1); // e.g. 16:00 – 00:00 ends next day
      try {
        await api('/api/admin/rota', { method: 'POST', body: { user_id: Number($('ro-user').value), start: start.toISOString(), end: end.toISOString(), note: $('ro-note').value } });
        toast('Schicht eingetragen');
        weekStart = mondayOf(start);
        loadRota();
      } catch (err) { $('ro-error').textContent = err.message; }
    });

    // --- Meine Zeit: running shift, breaks, stats, chart, rota, history ------------------------
    const dur = (min) => `${Math.floor(min / 60)} h ${String(Math.round(min % 60)).padStart(2, '0')} min`;
    async function loadMyTime() {
      clearTimeout(workTimer);
      const w = await api('/api/admin/me/work').catch(fail($('shift-now')));
      if (!w || !alive()) return;
      const c = w.current;
      $('shift-now').className = `shift-now${c ? (c.on_break ? ' pause' : ' on') : ''}`;
      $('shift-now').innerHTML = c ? `
        <div class="state"><span class="dot"></span>Im Dienst seit ${fmtClock.format(new Date(c.clock_in))} Uhr${c.on_break ? ' · gerade in Pause' : ''}</div>
        <div class="big">${dur(c.worked_minutes)}</div>
        <div class="muted">Pause bisher: ${c.break_minutes} min · Verdienst heute: ${euro(Math.round((c.worked_minutes / 60) * w.wage_cents))}</div>
        ${c.break_shortfall ? `<p class="break-hint">Nach ${c.worked_minutes > 540 ? '9' : '6'} Stunden Arbeit stehen Ihnen ${c.worked_minutes > 540 ? 45 : 30} Minuten Pause zu – noch ${c.break_shortfall} min offen.</p>` : ''}
        <div class="actions"><button class="btn-cafe" type="button" id="break-btn">${c.on_break ? 'Pause beenden' : 'Pause starten'}</button>
          <button class="btn-ghost" type="button" id="clock-btn">Ausstempeln</button></div>`
        : `<div class="state">Nicht eingestempelt</div>
        ${w.upcoming[0] ? `<div class="muted">Nächste Schicht: ${fmtDayTime.format(new Date(w.upcoming[0].start))} – ${fmtClock.format(new Date(w.upcoming[0].end))} Uhr</div>` : ''}
        <div class="actions"><button class="btn-cafe" type="button" id="clock-btn">Einstempeln</button></div>`;

      const st = w.stats;
      const tile = (label, value, hint) => `<div class="stat"><div class="label">${label}</div><div class="value">${value}</div><div class="hint">${hint}</div></div>`;
      $('my-stats').innerHTML = tile('Diese Woche', hours(st.week_hours), 'letzte 7 Tage, ohne Pausen')
        + tile('Dieser Monat', hours(st.month_hours), 'seit dem 1.')
        + tile('Verdienst', euro(st.month_pay_cents), `diesen Monat · ${euro(w.wage_cents)}/h`)
        + tile('Bestellungen', st.orders_week, `bearbeitet in 7 Tagen · ${st.orders_month} im Monat`);

      const max = Math.max(8, ...w.daily.map((d) => d.hours));
      $('day-chart').innerHTML = w.daily.map((d) => {
        const date = new Date(`${d.date}T12:00:00`);
        return `<div class="day${d.date === dayKey(new Date()) ? ' today' : ''}" title="${fmtShort.format(date)}: ${hours(d.hours)}">
          <span class="h">${d.hours ? d.hours.toFixed(1).replace('.', ',') : ''}</span>
          <span class="bar" style="height:${(d.hours / max) * 100}%"></span>
          <span class="d">${fmtWeekday.format(date).slice(0, 2)}</span></div>`;
      }).join('');

      $('my-upcoming').innerHTML = w.upcoming.length ? w.upcoming.map((p) => `
        <div class="row-line"><div class="grow"><strong>${fmtDayTime.format(new Date(p.start))} – ${fmtClock.format(new Date(p.end))} Uhr</strong>
          ${p.note ? `<br /><span class="muted">${esc(p.note)}</span>` : ''}</div></div>`).join('')
        : '<p class="muted">Keine Schichten in den nächsten 14 Tagen geplant.</p>';

      $('my-history').innerHTML = `
        <thead><tr><th>Tag</th><th>Zeit</th><th class="num">Pause</th><th class="num">Netto</th><th class="num">Verdienst</th></tr></thead>
        <tbody>${w.shifts.map((x) => `<tr>
          <td>${fmtWeekday.format(new Date(x.clock_in))}, ${fmtShort.format(new Date(x.clock_in))}</td>
          <td>${fmtClock.format(new Date(x.clock_in))} – ${x.clock_out ? fmtClock.format(new Date(x.clock_out)) : '<span class="status ready">läuft</span>'}</td>
          <td class="num">${x.break_minutes} min</td><td class="num">${hours(x.hours)}</td><td class="num">${euro(x.pay_cents)}</td></tr>`).join('')
          || '<tr><td colspan="5" class="muted">Noch keine Schichten.</td></tr>'}</tbody>`;

      if (c && !root.querySelector('[data-panel="mytime"]').hidden) workTimer = setTimeout(loadMyTime, 60000); // live timer
    }
    $('shift-now').addEventListener('click', async (e) => {
      const btn = e.target.closest('#break-btn, #clock-btn');
      if (!btn || btn.disabled) return;
      btn.disabled = true; // a double-click would toggle twice
      try {
        if (btn.id === 'break-btn') {
          const { on_break } = await api('/api/admin/shifts/break', { method: 'POST' });
          toast(on_break ? 'Pause gestartet – guten Appetit!' : 'Pause beendet');
        } else {
          const { open } = await api('/api/admin/shifts/clock', { method: 'POST' });
          toast(open ? 'Eingestempelt – schönen Dienst!' : 'Ausgestempelt – schönen Feierabend!');
        }
      } catch (err) { toast(err.message); }
      loadMyTime();
    });

    loadKitchen();
  },
  unmount() {
    clearTimeout(pollTimer); // stop the 10-second order refresh
    clearTimeout(workTimer);
    stopCamera();
  },
};
