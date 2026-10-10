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

// auth: undefined = public, 'customer' = logged-in guest, 'staff' = staff or admin.
// guestsOnly: public page that staff/admin don't use (the cart) — they go to the dashboard instead.
const isStaff = (user) => !!user && user.role !== 'customer';
export const allowed = (view, user) => {
  if (view.auth === 'customer') return !!user && !isStaff(user);
  if (view.auth === 'staff') return isStaff(user);
  return !(view.guestsOnly && isStaff(user));
};

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
let mountId = 0; // bumps on every navigation; a view's alive() turns false when it is left

async function render() {
  const token = ++seq;
  const { path, view, params } = routeFor(location.hash);
  if (!view) return go('#/');
  // Protected views re-check the login with the server (the cookie may have expired).
  const user = view.auth ? await session.refresh() : await session.get();
  if (token !== seq) return; // a newer navigation started meanwhile
  if (view.auth && !user) return go(`#/login?next=${encodeURIComponent('#/' + path)}`);
  if (!allowed(view, user)) return go(roleHome(user));

  const id = ++mountId;
  const alive = () => id === mountId;
  current?.unmount?.();
  current = view;
  root.replaceChildren(document.getElementById(`tpl-${path || 'home'}`).content.cloneNode(true));
  markToday(root);
  document.title = view.title ? `${view.title} · Café el Sasu` : 'Café el Sasu';
  setHero(!!view.hero);
  setActiveLink(`#/${path}`);
  closeMobileNav();
  scrollTo(0, 0);
  await view.mount(root, params, alive);
}

addEventListener('hashchange', render);
addEventListener('sessionchange', render); // e.g. logout from the navbar while on the Startseite
session.get().then(renderNav);
render();
