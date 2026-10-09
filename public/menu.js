// Speisekarte: render items from the API with category tabs.
const CATEGORIES = { all: 'Alle', coffee: 'Kaffee', cold: 'Kalt', cake: 'Kuchen', pastry: 'Gebäck' };
const TAG_LABELS = { vegan: 'vegan', gluten: 'Gluten', nuts: 'Nüsse', lactose: 'Laktose' };

const grid = document.getElementById('menu-grid');
const tabs = document.getElementById('tabs');
let items = [];
let current = 'all';

function render() {
  const shown = items.filter((i) => current === 'all' || i.category === current);
  grid.innerHTML = shown.map((i) => `
    <article class="item-card">
      <img src="${esc(i.photo)}" alt="${esc(i.name)}" loading="lazy" />
      <h3>${esc(i.name)}</h3>
      <p>${esc(i.description)}</p>
      <div>${i.tags.split(',').filter(Boolean).map((t) => `<span class="tag ${esc(t)}">${esc(TAG_LABELS[t] || t)}</span>`).join('')}</div>
      <p class="price">${euro(i.price_cents)}</p>
      <button class="btn-cafe" data-add="${i.id}">In den Warenkorb</button>
    </article>`).join('');
  tabs.querySelectorAll('button').forEach((b) => b.setAttribute('aria-pressed', b.dataset.cat === current));
}

tabs.innerHTML = Object.entries(CATEGORIES).map(([k, v]) => `<button data-cat="${k}">${v}</button>`).join('');
tabs.addEventListener('click', (e) => {
  if (!e.target.dataset.cat) return;
  current = e.target.dataset.cat;
  render();
});

(window.menuPromise ||= api('/api/menu'))
  .then((data) => { items = data; render(); })
  .catch(() => { grid.innerHTML = '<p class="error">Speisekarte konnte nicht geladen werden.</p>'; });
