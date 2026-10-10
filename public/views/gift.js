// The page a friend opens from a gift link: who it's from, the message, and how to redeem it.
import { api, esc, session } from '../app.js';
import { go } from '../router.js';

const STATE = {
  pending: 'Dieser Gutschein wartet noch auf die Bezahlung an der Theke.',
  redeemed: 'Dieser Gutschein wurde schon eingelöst.',
  cancelled: 'Dieser Gutschein wurde storniert.',
};

export default {
  title: 'Gutschein',
  hero: false,
  async mount(root, params, alive) {
    const box = root.querySelector('#gift-card');
    const code = (params.get('c') ?? '').toUpperCase();
    let gift;
    try { gift = await api(`/api/gifts/${encodeURIComponent(code)}`); } catch {
      if (alive()) box.innerHTML = '<h2>Gutschein nicht gefunden</h2><p class="muted">Bitte prüfen Sie den Link oder fragen Sie die Person, die ihn Ihnen geschickt hat.</p>';
      return;
    }
    const user = await session.get();
    if (!alive()) return;
    box.innerHTML = `
      <span class="eyebrow">Ein Kaffee für Sie</span>
      <h2>Hallo ${esc(gift.recipient_name)}!</h2>
      <p class="from">${esc(gift.from)} lädt Sie auf einen Kaffee nach Wahl ins Café el Sasu ein.</p>
      ${gift.message ? `<blockquote>${esc(gift.message)}</blockquote>` : ''}
      <img class="gift-qr" src="/api/gifts/${esc(code)}/qr" alt="QR-Code des Gutscheins" width="160" height="160" />
      <p class="code">${esc(code)}</p>
      ${gift.status === 'active'
        ? `<button class="btn-cafe wide" type="button" id="redeem">${user ? 'Jetzt einlösen' : 'Einloggen und einlösen'}</button>
           <p class="muted">Legen Sie einen Kaffee in den Warenkorb – der Gutschein wird an der Kasse automatisch eingetragen. Extras wie Hafermilch zahlen Sie einfach dazu.</p>`
        : `<p class="gift-state">${STATE[gift.status]}</p>`}`;
    root.querySelector('#redeem')?.addEventListener('click', () => {
      try { sessionStorage.setItem('sasu.gift', code); } catch {}
      go(user ? '#/speisekarte' : '#/login?next=%23%2Fspeisekarte');
    });
  },
};
