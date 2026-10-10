// Mitarbeiter-Dashboard: Bestellungen, Arbeitszeit, Finanzen, Speisekarte.
import { api, euro, esc, toast, STATUS, session, modBadges } from '../app.js';
import { go } from '../router.js';

const fmtTime = new Intl.DateTimeFormat('de-DE', { timeZone: 'Europe/Berlin', weekday: 'short', hour: '2-digit', minute: '2-digit' });
const NEXT = { new: 'preparing', preparing: 'ready', ready: 'picked_up' };
const NEXT_LABEL = { new: 'Zubereiten', preparing: 'Fertig', ready: 'Abgeholt' };
const hours = (h) => h.toFixed(1).replace('.', ',') + ' h';
let pollTimer;

export default {
  title: 'Dashboard',
  hero: false,
  auth: 'staff',
  async mount(root, params, alive) {
    const $ = (id) => root.querySelector('#' + id);
    let user;
    let range = 'week';

    // --- tabs ---------------------------------------------------------------------
    const LOADERS = { orders: loadOrders, staff: loadStaff, finance: loadFinance, menu: loadMenu };
    $('admin-tabs').addEventListener('click', (e) => {
      const tab = e.target.dataset.tab;
      if (!tab) return;
      $('admin-tabs').querySelectorAll('button').forEach((b) => b.setAttribute('aria-pressed', b === e.target));
      root.querySelectorAll('[data-panel]').forEach((p) => { p.hidden = p.dataset.panel !== tab; });
      LOADERS[tab]();
    });

    const fail = (el) => (err) => { el.innerHTML = `<p class="error">${esc(err.message)}</p>`; };

    // --- orders (poll every 10 s while visible) -------------------------------------
    async function loadOrders() {
      clearTimeout(pollTimer);
      const orders = await api('/api/admin/orders').catch((err) => alive() && fail($('open-orders'))(err));
      if (!orders || !alive()) return; // nothing to draw, or the view was left
      $('open-orders').innerHTML = orders.length ? orders.map((o) => `
        <div class="row-line" style="flex-wrap:wrap">
          <div class="grow">
            <strong>${esc(o.customer)}</strong> <span class="muted">(${esc(o.member_id)})</span><br />
            <strong>${fmtTime.format(new Date(o.pickup_at))} Uhr</strong> ·
            <span class="muted">${o.items.map((i) => `${i.qty}× ${esc(i.name)} ${modBadges(i.modifiers)}`).join(' · ')}</span>
          </div>
          <strong>${euro(o.total_cents)}</strong>
          <span class="status ${o.status === 'ready' ? 'ready' : ''}">${STATUS[o.status]}</span>
          <button class="btn-cafe" data-id="${o.id}" data-status="${NEXT[o.status]}">${NEXT_LABEL[o.status]}</button>
          ${o.status === 'new' ? `<button class="btn-ghost" data-id="${o.id}" data-status="cancelled">Stornieren</button>` : ''}
        </div>`).join('') : '<p class="muted">Keine offenen Bestellungen.</p>';
      if (!root.querySelector('[data-panel="orders"]').hidden) pollTimer = setTimeout(loadOrders, 10000);
    }

    $('open-orders').addEventListener('click', async (e) => {
      const { id, status } = e.target.dataset;
      if (!id) return;
      e.target.disabled = true;
      try {
        await api(`/api/admin/orders/${id}`, { method: 'PATCH', body: { status } });
        if (status === 'picked_up') toast('Abgeholt – Punkte gutgeschrieben');
      } catch (err) { toast(err.message); }
      loadOrders();
    });

    // --- staff hours --------------------------------------------------------------
    async function loadStaff() {
      const rows = await api('/api/admin/shifts').catch((err) => alive() && fail($('staff-table'))(err));
      if (!rows || !alive()) return;
      const mine = rows.find((r) => r.id === user.id);
      $('clock').textContent = mine?.open ? 'Ausstempeln' : 'Einstempeln';
      const showWage = user.role === 'admin';
      $('staff-table').innerHTML = `
        <thead><tr><th>Name</th><th>Status</th><th>7 Tage</th><th>30 Tage</th>${showWage ? '<th>Lohn (30 Tage)</th>' : ''}</tr></thead>
        <tbody>${rows.map((r) => `<tr>
          <td>${esc(r.name)} <span class="muted">${esc(r.member_id)}</span></td>
          <td>${r.open ? '<span class="status ready">Im Dienst</span>' : '<span class="muted">—</span>'}</td>
          <td>${hours(r.hours_week)}</td><td>${hours(r.hours_month)}</td>
          ${showWage ? `<td>${euro(Math.round(r.hours_month * r.hourly_wage))}</td>` : ''}
        </tr>`).join('')}</tbody>`;
    }

    $('clock').addEventListener('click', async () => {
      if ($('clock').disabled) return;
      $('clock').disabled = true; // a double-click would clock in and straight back out
      try {
        const { open } = await api('/api/admin/shifts/clock', { method: 'POST' });
        toast(open ? 'Eingestempelt – schönen Dienst!' : 'Ausgestempelt');
        await loadStaff();
      } catch (err) { toast(err.message); }
      $('clock').disabled = false;
    });

    // --- finance ------------------------------------------------------------------
    async function loadFinance() {
      const f = await api(`/api/admin/finance?range=${range}`).catch((err) => alive() && fail($('stats'))(err));
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

    // --- menu ---------------------------------------------------------------------
    async function loadMenu() {
      const items = await api('/api/admin/menu').catch((err) => alive() && fail($('menu-table'))(err));
      if (!items || !alive()) return;
      $('menu-table').innerHTML = `
        <thead><tr><th>Artikel</th><th>Kategorie</th><th>Preis (€)</th><th>Aktiv</th></tr></thead>
        <tbody>${items.map((i) => `<tr>
          <td>${esc(i.name)}</td><td>${esc(i.category)}</td>
          <td><input type="number" step="0.01" min="0.01" value="${(i.price_cents / 100).toFixed(2)}" data-price="${i.id}" aria-label="Preis ${esc(i.name)}" /></td>
          <td><input type="checkbox" ${i.active ? 'checked' : ''} data-active="${i.id}" aria-label="${esc(i.name)} aktiv" /></td>
        </tr>`).join('')}</tbody>`;
    }

    $('menu-table').addEventListener('change', async (e) => {
      const { price, active } = e.target.dataset;
      const id = price || active;
      if (!id) return;
      const body = price ? { price_cents: Math.round(Number(e.target.value) * 100) } : { active: e.target.checked ? 1 : 0 };
      try {
        await api(`/api/admin/menu/${id}`, { method: 'PATCH', body });
        toast('Gespeichert');
      } catch (err) { toast(err.message); loadMenu(); }
    });

    $('new-item').addEventListener('submit', async (e) => {
      e.preventDefault();
      try {
        await api('/api/admin/menu', { method: 'POST', body: {
          name: $('ni-name').value, category: $('ni-cat').value, price_cents: Math.round(Number($('ni-price').value) * 100),
        } });
        e.target.reset();
        toast('Artikel hinzugefügt');
        loadMenu();
      } catch (err) { toast(err.message); }
    });

    // --- start (the router only lets staff and admin in) ---

    user = await session.get();
    root.querySelectorAll('[data-admin]').forEach((b) => { b.hidden = user.role !== 'admin'; });
    loadOrders();
  },
  unmount() {
    clearTimeout(pollTimer); // stop the 10-second order refresh
  },
};
