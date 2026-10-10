// Speisekarte: menu sections per category, search, item dialog, floating cart bar.
import { api, euro, esc, cart, toast, getMenu, unitPrice, session } from '../app.js';

const CATEGORIES = [
  ['coffee', 'Kaffee', 'Heiß und frisch aus der Siebträgermaschine'],
  ['cold', 'Kalt', 'Auf Eis, für warme Tage'],
  ['cake', 'Kuchen', 'Hausgemacht, jeden Morgen frisch'],
  ['pastry', 'Gebäck', 'Süßes zum Mitnehmen'],
];
const TAG_LABELS = { vegan: 'vegan', gluten: 'Gluten', nuts: 'Nüsse', lactose: 'Laktose' };
const tags = (i) => i.tags.split(',').filter(Boolean)
  .map((t) => `<span class="tag ${esc(t)}">${esc(TAG_LABELS[t] || t)}</span>`).join('');

let spy = null;
// Vegan view: tagged vegan, or a drink that can be made with plant milk.
const PLANT = ['Hafermilch', 'Mandelmilch'];
const veganOk = (i) => i.tags.split(',').includes('vegan') || i.modifiers.some((g) => g.name === 'Milch' && g.options.some((o) => PLANT.includes(o.name)));

export default {
  title: 'Speisekarte',
  hero: true,
  async mount(root, params, alive) {
    const $ = (id) => root.querySelector('#' + id);
    let items = [];
    let current = null;
    let qty = 1;

    function render() {
      const term = $('search').value.trim().toLowerCase();
      const vegan = $('vegan-only').getAttribute('aria-pressed') === 'true';
      const match = (i) => (!term || (i.name + ' ' + i.description).toLowerCase().includes(term)) && (!vegan || veganOk(i));
      const sections = CATEGORIES.map(([key, title, sub]) => {
        const list = items.filter((i) => i.category === key && match(i));
        if (!list.length) return '';
        return `
          <section class="menu-sheet" id="cat-${key}" data-cat="${key}">
            <header><h2>${title}</h2><p>${sub}</p></header>
            <div class="menu-list">${list.map((i) => `
              <article class="menu-item${i.sold_out ? ' sold-out' : ''}" data-id="${i.id}">
                <img src="${esc(i.photo)}" alt="" loading="lazy" width="84" height="84" />
                <div>
                  <div class="name-line"><h3>${esc(i.name)}</h3><span class="dots"></span><span class="price">${euro(i.price_cents)}</span></div>
                  <p>${esc(i.description)}</p>
                  <div>${i.sold_out ? '<span class="tag sold">Ausverkauft</span>' : ''}${tags(i)}</div>
                </div>
                <button class="add-btn" type="button" data-quick="${i.id}" aria-label="${esc(i.name)} in den Warenkorb" ${i.sold_out ? 'disabled' : ''}>+</button>
              </article>`).join('')}
            </div>
          </section>`;
      }).join('');
      $('menu-root').innerHTML = sections
        || `<p class="menu-empty panel">Nichts gefunden für „${esc(term)}“. <button class="btn-ghost" type="button" id="clear-search">Suche löschen</button></p>`;
      root.querySelectorAll('.menu-sheet').forEach((s) => spy.observe(s));
    }

    // Category buttons scroll to their section (no #anchors: the hash belongs to the router).
    $('cat-nav').innerHTML = CATEGORIES.map(([key, title]) => `<button type="button" data-cat="${key}">${title}</button>`).join('');
    $('cat-nav').addEventListener('click', (e) => {
      const key = e.target.dataset.cat;
      if (key) root.querySelector(`#cat-${key}`)?.scrollIntoView({ behavior: matchMedia('(prefers-reduced-motion: reduce)').matches ? 'auto' : 'smooth' });
    });
    spy = new IntersectionObserver((entries) => {
      for (const e of entries) {
        if (e.isIntersecting) {
          $('cat-nav').querySelectorAll('button').forEach((b) => b.setAttribute('aria-current', b.dataset.cat === e.target.dataset.cat));
        }
      }
    }, { rootMargin: '-150px 0px -55% 0px' });

    $('search').addEventListener('input', render);
    $('vegan-only').addEventListener('click', () => {
      $('vegan-only').setAttribute('aria-pressed', $('vegan-only').getAttribute('aria-pressed') !== 'true');
      render();
    });
    const user = await session.get();
    const prefs = user?.role === 'customer' ? user.preferences : null;
    if (prefs?.vegan_only) $('vegan-only').setAttribute('aria-pressed', 'true');
    $('dlg-fav').hidden = !prefs; // favorites are for logged-in guests

    // --- dialog ---
    const chosenMods = () => [...root.querySelectorAll('#dlg-mods input:checked')].map((i) => Number(i.value)).filter(Boolean);
    function updateDialogButton() {
      $('dlg-qty').textContent = qty;
      $('dlg-add').textContent = `In den Warenkorb · ${euro(unitPrice(current, chosenMods()) * qty)}`;
    }
    // One fieldset per option group: radio pills for "pick one", checkbox pills for extras.
    const price = (c) => (c ? `+${euro(c)}` : '');
    function renderMods(item) {
      $('dlg-mods').innerHTML = item.modifiers.map((g) => {
        const type = g.kind === 'one' ? 'radio' : 'checkbox';
        const none = g.kind === 'one' && !g.required
          ? `<label class="mod-pill"><input type="radio" name="g${g.id}" value="0" checked /><span>Ohne</span></label>` : '';
        // Preferred milk (or a plant milk in vegan mode) instead of the default.
        const wanted = g.name === 'Milch' && (prefs?.milk ?? ($('vegan-only').getAttribute('aria-pressed') === 'true' ? 'Hafermilch' : null));
        const pick = (o) => (wanted && g.options.some((x) => x.name === wanted) ? o.name === wanted : o.is_default);
        return `<fieldset class="mod-group"><legend>${esc(g.name)}${g.required ? '' : ' <small>optional</small>'}</legend>
          <div class="mod-pills">${none}${g.options.map((o) => `
            <label class="mod-pill"><input type="${type}" name="g${g.id}" value="${o.id}" ${pick(o) ? 'checked' : ''} />
              <span>${esc(o.name)} <small>${price(o.price_cents)}</small></span></label>`).join('')}</div></fieldset>`;
      }).join('');
    }
    $('dlg-mods').addEventListener('change', updateDialogButton);
    function openItem(item) {
      current = item;
      qty = 1;
      $('dlg-img').src = item.photo;
      $('dlg-name').textContent = item.name;
      $('dlg-desc').textContent = item.description;
      $('dlg-tags').innerHTML = tags(item);
      renderMods(item);
      $('dlg-fav').textContent = '☆';
      $('dlg-fav').classList.remove('on');
      updateDialogButton();
      $('item-dialog').showModal();
    }
    $('dlg-minus').addEventListener('click', () => { qty = Math.max(1, qty - 1); updateDialogButton(); });
    $('dlg-plus').addEventListener('click', () => { qty = Math.min(20, qty + 1); updateDialogButton(); });
    $('dlg-close').addEventListener('click', () => $('item-dialog').close());
    $('dlg-fav').addEventListener('click', async () => {
      try {
        await api('/api/me/favorites', { method: 'POST', body: { menu_item_id: current.id, mods: chosenMods() } });
        $('dlg-fav').textContent = '★';
        $('dlg-fav').classList.add('on');
        toast('Als Favorit gespeichert – in Ihrem Konto mit einem Klick bestellbar');
      } catch (err) { toast(err.message); }
    });
    $('item-dialog').addEventListener('click', (e) => { if (e.target === e.currentTarget) e.currentTarget.close(); });
    $('dlg-add').addEventListener('click', () => {
      cart.add(current.id, qty, chosenMods());
      $('item-dialog').close();
      toast(`${qty}× ${current.name} im Warenkorb`);
      updateCartBar();
    });

    $('menu-root').addEventListener('click', (e) => {
      if (e.target.id === 'clear-search') { $('search').value = ''; render(); return; }
      const quick = e.target.closest('[data-quick]');
      if (quick) {
        const item = items.find((i) => i.id === Number(quick.dataset.quick));
        if (item.modifiers.length) return openItem(item); // drinks: let the guest pick milk, syrup…
        cart.add(item.id);
        toast(`${item.name} im Warenkorb`);
        updateCartBar();
        return;
      }
      const row = e.target.closest('.menu-item');
      if (row?.classList.contains('sold-out')) return toast('Heute leider ausverkauft');
      if (row) openItem(items.find((i) => i.id === Number(row.dataset.id)));
    });

    // --- cart bar ---
    function updateCartBar() {
      const lines = cart.get().map((l) => ({ ...l, item: items.find((i) => i.id === l.id) })).filter((l) => l.item);
      const count = lines.reduce((n, l) => n + l.qty, 0);
      const total = lines.reduce((s, l) => s + l.qty * unitPrice(l.item, l.mods), 0);
      $('cart-bar').hidden = !count;
      $('cart-bar-text').innerHTML = `${count} Artikel · <strong>${euro(total)}</strong>`;
    }

    try {
      items = await getMenu({ fresh: true });
    } catch {
      if (alive()) $('menu-root').innerHTML = '<p class="menu-empty panel error">Die Speisekarte konnte nicht geladen werden. Bitte Seite neu laden.</p>';
      return;
    }
    if (!alive()) return;
    render();
    updateCartBar();
  },
  unmount() {
    spy?.disconnect();
    spy = null;
  },
};
