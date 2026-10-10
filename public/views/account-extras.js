// Konto tabs "Bohnen-Abo" and "Verschenken" (kept apart from account.js to keep that file readable).
import { api, euro, esc, toast } from '../app.js';

const BEAN = { espresso: 'Espresso-Röstung', filter: 'Filter-Röstung', decaf: 'Entkoffeiniert' };
const SIZE = { '250g': '250 g', '1kg': '1 kg' };
const EVERY = { 1: 'jede Woche', 2: 'alle 2 Wochen', 4: 'alle 4 Wochen' };
const STATE = { active: 'Aktiv', paused: 'Pausiert', cancelled: 'Beendet' };
const GIFT_STATE = { pending: 'Wartet auf Bezahlung', active: 'Bereit zum Einlösen', redeemed: 'Eingelöst', cancelled: 'Storniert' };
const fmtDate = new Intl.DateTimeFormat('de-DE', { weekday: 'short', day: '2-digit', month: '2-digit' });
const isoDay = (offset) => new Date(Date.now() + offset * 864e5).toLocaleDateString('en-CA', { timeZone: 'Europe/Berlin' });

// --- bean subscription ----------------------------------------------------------------
export function mountBeans(root, alive) {
  const $ = (id) => root.querySelector('#' + id);
  $('bn-first').min = isoDay(1);
  $('bn-first').max = isoDay(60);
  $('bn-first').value = isoDay(1);

  async function load() {
    const subs = await api('/api/me/beans').catch(() => null);
    if (!subs || !alive()) return;
    $('bean-list').innerHTML = subs.length ? subs.map((b) => `
      <div class="bean-row ${b.status}">
        <div class="grow"><strong>${BEAN[b.bean]} · ${SIZE[b.size]}</strong> <span class="muted">${euro(b.price_cents)} · ${EVERY[b.every_weeks]}</span><br />
          ${b.status === 'active' ? `Nächste Abholung: <strong>${fmtDate.format(new Date(`${b.next_pickup}T12:00:00`))}</strong>` : `<span class="muted">${STATE[b.status]}</span>`}</div>
        ${b.status === 'cancelled' ? '' : `<div class="buttons">
          ${b.status === 'active' ? `<button class="btn-ghost" data-bean="${b.id}" data-action="skip">Einmal aussetzen</button><button class="btn-ghost" data-bean="${b.id}" data-action="pause">Pausieren</button>`
            : `<button class="btn-ghost" data-bean="${b.id}" data-action="resume">Fortsetzen</button>`}
          <button class="btn-ghost danger" data-bean="${b.id}" data-action="cancel">Beenden</button></div>`}
      </div>`).join('') : '<p class="muted">Noch kein Abo. Wählen Sie oben Sorte, Größe und Rhythmus.</p>';
  }

  $('bean-form').addEventListener('submit', async (e) => {
    e.preventDefault();
    $('bn-error').textContent = '';
    try {
      await api('/api/me/beans', { method: 'POST', body: {
        bean: $('bn-bean').value, size: $('bn-size').value, every_weeks: Number($('bn-every').value), first_pickup: $('bn-first').value,
      } });
      toast('Abo gestartet – wir legen Ihnen die Bohnen zurück');
      load();
    } catch (err) { $('bn-error').textContent = err.message; }
  });
  $('bean-list').addEventListener('click', async (e) => {
    const { bean, action } = e.target.dataset;
    if (!bean) return;
    try {
      await api(`/api/me/beans/${bean}`, { method: 'PATCH', body: { action } });
      toast({ skip: 'Nächste Abholung ausgesetzt', pause: 'Abo pausiert', resume: 'Abo läuft wieder', cancel: 'Abo beendet' }[action]);
      load();
    } catch (err) { toast(err.message); }
  });
  load();
}

// --- gifts ----------------------------------------------------------------------------
export function mountGifts(root, alive, getUser, onPointsChange) {
  const $ = (id) => root.querySelector('#' + id);
  let gifts = [];
  const link = (code) => `${location.origin}/#/gutschein?c=${code}`;

  const showPoints = () => { $('gf-points').textContent = `(Sie haben ${getUser().points})`; };

  function showMade(g) {
    const url = link(g.code);
    const text = `${g.message ? g.message + ' – ' : ''}Einladung auf einen Kaffee im Café el Sasu: ${url}`;
    $('gift-made').hidden = false;
    $('gift-made').innerHTML = `
      <img src="/api/gifts/${esc(g.code)}/qr" alt="QR-Code des Gutscheins" width="140" height="140" />
      <div class="grow">
        <strong>Gutschein für ${esc(g.recipient_name)}</strong>
        <p class="muted">${g.status === 'pending' ? 'Bezahlen Sie 5,00 € an der Theke – dann ist er sofort einlösbar.' : 'Bereit! Schicken Sie den Link oder zeigen Sie den QR-Code.'}</p>
        <input class="share-link" value="${esc(url)}" readonly aria-label="Gutschein-Link" />
        <div class="buttons">
          <a class="btn-cafe" href="https://wa.me/?text=${encodeURIComponent(text)}" target="_blank" rel="noopener">WhatsApp</a>
          <a class="btn-ghost" href="mailto:?subject=${encodeURIComponent('Ein Kaffee-Gutschein vom Café el Sasu')}&body=${encodeURIComponent(text)}">E-Mail</a>
          <button class="btn-ghost" type="button" id="gift-copy">Link kopieren</button>
        </div>
      </div>`;
    $('gift-copy').addEventListener('click', async () => {
      try { await navigator.clipboard.writeText(url); toast('Link kopiert'); } catch { root.querySelector('.share-link').select(); }
    });
  }

  async function load() {
    const list = await api('/api/me/gifts').catch(() => null);
    if (!list || !alive()) return;
    gifts = list;
    $('gift-list').innerHTML = gifts.length ? gifts.map((g) => `
      <div class="row-line">
        <div class="grow"><strong>Für ${esc(g.recipient_name)}</strong> <span class="muted">${esc(g.code)}</span><br />
          <span class="status ${g.status === 'active' ? 'ready' : g.status === 'cancelled' ? 'cancelled' : ''}">${GIFT_STATE[g.status]}</span></div>
        ${['pending', 'active'].includes(g.status) ? `<button class="btn-ghost" data-show="${esc(g.code)}">Teilen</button><button class="btn-ghost danger" data-cancel-gift="${esc(g.code)}">Stornieren</button>` : ''}
      </div>`).join('') : '<p class="muted">Sie haben noch keinen Kaffee verschenkt.</p>';
  }

  $('gift-form').addEventListener('submit', async (e) => {
    e.preventDefault();
    $('gf-error').textContent = '';
    try {
      const g = await api('/api/gifts', { method: 'POST', body: {
        recipient_name: $('gf-name').value, message: $('gf-msg').value, pay: root.querySelector('[name="gf-pay"]:checked').value,
      } });
      e.target.reset();
      showMade(g);
      toast(g.status === 'active' ? 'Gutschein erstellt' : 'Gutschein erstellt – bitte an der Theke bezahlen');
      load();
      onPointsChange();
    } catch (err) { $('gf-error').textContent = err.message; }
  });
  $('gift-list').addEventListener('click', async (e) => {
    const { show, cancelGift } = e.target.dataset;
    if (show) showMade(gifts.find((g) => g.code === show));
    if (cancelGift) {
      try {
        await api(`/api/gifts/${cancelGift}/cancel`, { method: 'POST' });
        toast('Gutschein storniert');
        load();
        onPointsChange();
      } catch (err) { toast(err.message); }
    }
  });
  showPoints();
  load();
  return { showPoints };
}
