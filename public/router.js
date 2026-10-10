// Hash router: #/<route>?<query> → view module mounted into <main id="view">.
import { session, renderNav, setHero, setActiveLink, closeMobileNav, markToday } from './app.js';
import home from './views/home.js';
import menu from './views/menu.js';
import cartView from './views/cart.js';
import login from './views/login.js';
import account from './views/account.js';
import admin from './views/admin.js';
import credits from './views/credits.js';

const ROUTES = { '': home, speisekarte: menu, warenkorb: cartView, login, konto: account, admin, bildnachweise: credits };

export const roleHome = (user) => (user.role === 'customer' ? '#/konto' : '#/admin');

// auth: undefined = public, 'user' = any login, 'staff' = staff or admin.
export const allowed = (view, user) => !view.auth || (!!user && (view.auth === 'user' || user.role !== 'customer'));

export function routeFor(hash) {
  const [path = '', query = ''] = hash.replace(/^#\/?/, '').split('?');
  return { path, view: ROUTES[path], params: new URLSearchParams(query) };
}

export function go(hash) {
  if (location.hash === hash) render();
  else location.hash = hash;
}

const root = document.getElementById('view');
let current = null;
let seq = 0;

async function render() {
  const token = ++seq;
  const { path, view, params } = routeFor(location.hash);
  if (!view) return go('#/');
  const user = await session.get();
  if (token !== seq) return; // a newer navigation started meanwhile
  if (view.auth && !user) return go(`#/login?next=${encodeURIComponent('#/' + path)}`);
  if (!allowed(view, user)) return go(roleHome(user));

  current?.unmount?.();
  current = view;
  root.replaceChildren(document.getElementById(`tpl-${path || 'home'}`).content.cloneNode(true));
  markToday(root);
  document.title = view.title ? `${view.title} · Café el Sasu` : 'Café el Sasu';
  setHero(!!view.hero);
  setActiveLink(`#/${path}`);
  closeMobileNav();
  scrollTo(0, 0);
  await view.mount(root, params);
}

addEventListener('hashchange', render);
session.get().then(renderNav);
render();
