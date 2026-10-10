// Speisekarte: menu sections per category, search, item dialog, floating cart bar.
const CATEGORIES = [
  ['coffee', 'Kaffee', 'Heiß und frisch aus der Siebträgermaschine'],
  ['cold', 'Kalt', 'Auf Eis, für warme Tage'],
  ['cake', 'Kuchen', 'Hausgemacht, jeden Morgen frisch'],
  ['pastry', 'Gebäck', 'Süßes zum Mitnehmen'],
];
const TAG_LABELS = { vegan: 'vegan', gluten: 'Gluten', nuts: 'Nüsse', lactose: 'Laktose' };
const $ = (id) => document.getElementById(id);
let items = [];
let current = null;
let qty = 1;

const tags = (i) => i.tags.split(',').filter(Boolean)
  .map((t) => `<span class="tag ${esc(t)}">${esc(TAG_LABELS[t] || t)}</span>`).join('');

function render() {
  const term = $('search').value.trim().toLowerCase();
  const match = (i) => !term || (i.name + ' ' + i.description).toLowerCase().includes(term);
  const sections = CATEGORIES.map(([key, title, sub]) => {
    const list = items.filter((i) => i.category === key && match(i));
    if (!list.length) return '';
    return `
      <section class="menu-sheet" id="${key}">
        <header><h2>${title}</h2><p>${sub}</p></header>
        <div class="menu-list">${list.map((i) => `
          <article class="menu-item" data-id="${i.id}">
            <img src="${esc(i.photo)}" alt="" loading="lazy" width="84" height="84" />
            <div>
              <div class="name-line"><h3>${esc(i.name)}</h3><span class="dots"></span><span class="price">${euro(i.price_cents)}</span></div>
              <p>${esc(i.description)}</p>
              <div>${tags(i)}</div>
            </div>
            <button class="add-btn" type="button" data-quick="${i.id}" aria-label="${esc(i.name)} in den Warenkorb">+</button>
          </article>`).join('')}
        </div>
      </section>`;
  }).join('');
  $('menu-root').innerHTML = sections
    || `<p class="menu-empty panel">Nichts gefunden für „${esc(term)}“. <button class="btn-ghost" type="button" id="clear-search">Suche löschen</button></p>`;
}

// Category nav: jump links, highlight the section in view.
$('cat-nav').innerHTML = CATEGORIES.map(([key, title]) => `<a href="#${key}" data-cat="${key}">${title}</a>`).join('');
const spy = new IntersectionObserver((entries) => {
  for (const e of entries) {
    if (e.isIntersecting) {
      $('cat-nav').querySelectorAll('a').forEach((a) => a.setAttribute('aria-current', a.dataset.cat === e.target.id));
    }
  }
}, { rootMargin: '-80px 0px -60% 0px' });
const observeSections = () => document.querySelectorAll('.menu-sheet').forEach((s) => spy.observe(s));

$('search').addEventListener('input', () => { render(); observeSections(); });

// --- dialog -----------------------------------------------------------------
function updateDialogButton() {
  $('dlg-qty').textContent = qty;
  $('dlg-add').textContent = `In den Warenkorb · ${euro(current.price_cents * qty)}`;
}

function openItem(item) {
  current = item;
  qty = 1;
  $('dlg-img').src = item.photo;
  $('dlg-name').textContent = item.name;
  $('dlg-desc').textContent = item.description;
  $('dlg-tags').innerHTML = tags(item);
  updateDialogButton();
  $('item-dialog').showModal();
}

$('dlg-minus').addEventListener('click', () => { qty = Math.max(1, qty - 1); updateDialogButton(); });
$('dlg-plus').addEventListener('click', () => { qty = Math.min(20, qty + 1); updateDialogButton(); });
$('dlg-close').addEventListener('click', () => $('item-dialog').close());
$('item-dialog').addEventListener('click', (e) => { if (e.target === e.currentTarget) e.currentTarget.close(); });
$('dlg-add').addEventListener('click', () => {
  cart.add(current.id, qty);
  $('item-dialog').close();
  toast(`${qty}× ${current.name} im Warenkorb`);
  updateCartBar();
});

$('menu-root').addEventListener('click', (e) => {
  if (e.target.id === 'clear-search') { $('search').value = ''; render(); observeSections(); return; }
  const quick = e.target.closest('[data-quick]');
  if (quick) {
    const item = items.find((i) => i.id === Number(quick.dataset.quick));
    cart.add(item.id);
    toast(`${item.name} im Warenkorb`);
    updateCartBar();
    return;
  }
  const row = e.target.closest('.menu-item');
  if (row) openItem(items.find((i) => i.id === Number(row.dataset.id)));
});

// --- cart bar ---------------------------------------------------------------
function updateCartBar() {
  const lines = cart.get().map((l) => ({ ...l, item: items.find((i) => i.id === l.id) })).filter((l) => l.item);
  const count = lines.reduce((n, l) => n + l.qty, 0);
  const total = lines.reduce((s, l) => s + l.qty * l.item.price_cents, 0);
  $('cart-bar').hidden = !count;
  $('cart-bar-text').innerHTML = `${count} Artikel · <strong>${euro(total)}</strong>`;
}

(window.menuPromise ||= api('/api/menu'))
  .then((data) => {
    items = data;
    render();
    observeSections();
    updateCartBar();
    document.getElementById(location.hash.slice(1))?.scrollIntoView();
  })
  .catch(() => { $('menu-root').innerHTML = '<p class="menu-empty panel error">Die Speisekarte konnte nicht geladen werden. Bitte Seite neu laden.</p>'; });
