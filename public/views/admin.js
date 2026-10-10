// Dashboard for staff and the owner: kitchen display, sold-out switches, finances,
// menu editor, staff management, shifts and own working time.
import { api, euro, esc, toast, session, modBadges, whenLabel } from '../app.js';

const fmtClock = new Intl.DateTimeFormat('de-DE', { timeZone: 'Europe/Berlin', hour: '2-digit', minute: '2-digit' });
const fmtDateTime = new Intl.DateTimeFormat('de-DE', { timeZone: 'Europe/Berlin', weekday: 'short', day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit' });
const NEXT = { new: 'preparing', preparing: 'ready', ready: 'picked_up' };
const NEXT_LABEL = { new: 'Zubereiten', preparing: 'Fertig', ready: 'Abgeholt' };
const STATE_LABEL = { new: 'Neu', preparing: 'In Arbeit', ready: 'Abholbereit' };
const CATEGORY = { coffee: 'Kaffee', cold: 'Kalt', cake: 'Kuchen', pastry: 'Gebäck' };
const TAG_LABEL = { vegan: 'vegan', gluten: 'Gluten', nuts: 'Nüsse', lactose: 'Laktose' };
const hours = (h) => h.toFixed(1).replace('.', ',') + ' h';
const cents = (value) => Math.round(Number(String(value).replace(',', '.')) * 100);

let pollTimer;
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
    const LOADERS = { kitchen: loadKitchen, soldout: loadSoldOut, finance: loadFinance, menu: loadMenu, team: loadTeam, shifts: loadShifts, mytime: loadMyTime };
    $('admin-tabs').addEventListener('click', (e) => {
      const tab = e.target.dataset.tab;
      if (!tab) return;
      clearTimeout(pollTimer);
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
    $('lookup-form').addEventListener('submit', (e) => {
      e.preventDefault();
      const id = $('lookup-id').value.trim();
      if (!id) return;
      lookup(id);
      $('lookup-id').value = '';
    });
    $('lookup-result').addEventListener('click', (e) => {
      if (e.target.id === 'lookup-close') { $('lookup-result').hidden = true; $('lookup-result').dataset.member = ''; }
    });

    // Camera scan with the browser's own BarcodeDetector (Chrome/Edge); elsewhere the input field is used.
    if ('BarcodeDetector' in window && navigator.mediaDevices?.getUserMedia) $('scan-btn').hidden = false;
    $('scan-btn').addEventListener('click', async () => {
      try {
        const detector = new window.BarcodeDetector({ formats: ['qr_code'] });
        stream = await navigator.mediaDevices.getUserMedia({ video: { facingMode: 'environment' } });
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
        stopCamera();
        toast('Kamera nicht verfügbar – bitte Nummer eingeben');
      }
    });
    $('scan-close').addEventListener('click', () => { stopCamera(); $('scan-dialog').close(); });
    $('scan-dialog').addEventListener('close', stopCamera);

    async function loadKitchen() {
      api('/api/admin/settings').then((s) => alive() && showSettings(s)).catch(() => {});
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
          <td>${u.id === user.id ? '<span class="muted small">du</span>' : switchHtml(u.id, u.active, `${u.name} aktiv`, 'active')}</td>
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

    // --- own working time ----------------------------------------------------------------------
    async function loadMyTime() {
      const rows = await api('/api/admin/shifts').catch(fail($('my-hours')));
      if (!rows || !alive()) return;
      const me = rows.find((r) => r.id === user.id);
      $('clock').textContent = me?.open ? 'Ausstempeln' : 'Einstempeln';
      $('my-hours').innerHTML = me ? `<div class="stat"><div class="label">Letzte 7 Tage</div><div class="value">${hours(me.hours_week)}</div></div>
        <div class="stat"><div class="label">Letzte 30 Tage</div><div class="value">${hours(me.hours_month)}</div></div>` : '';
    }
    $('clock').addEventListener('click', async () => {
      if ($('clock').disabled) return;
      $('clock').disabled = true; // a double-click would clock in and straight back out
      try {
        const { open } = await api('/api/admin/shifts/clock', { method: 'POST' });
        toast(open ? 'Eingestempelt – schönen Dienst!' : 'Ausgestempelt');
        await loadMyTime();
      } catch (err) { toast(err.message); }
      $('clock').disabled = false;
    });

    loadKitchen();
  },
  unmount() {
    clearTimeout(pollTimer); // stop the 10-second order refresh
    stopCamera();
  },
};
