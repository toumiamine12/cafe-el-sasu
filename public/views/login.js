// One login for customers, staff and admin. The account's role decides where you land.
import { api, esc, session, ROLE_LABEL } from '../app.js';
import { go, roleHome, routeFor, allowed } from '../router.js';

// Where to go after login: the requested page if this role may open it, else the role's home.
function destination(user, next) {
  const target = next && routeFor(next);
  return target?.view && allowed(target.view, user) && target.path !== 'login' ? next : roleHome(user);
}

export default {
  title: 'Login',
  hero: false,
  async mount(root, params) {
    const $ = (id) => root.querySelector('#' + id);
    const next = params.get('next');
    let registering = false;

    const user = await session.get();
    if (!root.isConnected) return;
    if (user) {
      $('login-panel').hidden = true;
      $('logged-in').hidden = false;
      $('logged-in-as').innerHTML = `Eingeloggt als <strong>${esc(user.name)}</strong> (${ROLE_LABEL[user.role]}, ${esc(user.member_id)}).`;
      $('continue').href = destination(user, next);
      $('logout').addEventListener('click', async () => {
        await api('/api/logout', { method: 'POST' });
        await session.refresh();
        go('#/login');
      });
      return;
    }

    $('toggle').addEventListener('click', () => {
      registering = !registering;
      $('register-fields').hidden = !registering;
      $('login-fields').hidden = registering;
      $('form-title').textContent = $('submit').textContent = registering ? 'Mitglied werden' : 'Einloggen';
      $('toggle').textContent = registering ? 'Schon Mitglied? Einloggen' : 'Noch kein Mitglied? Jetzt registrieren';
      $('password').autocomplete = registering ? 'new-password' : 'current-password';
    });

    $('auth-form').addEventListener('submit', async (e) => {
      e.preventDefault();
      $('error').textContent = '';
      $('submit').disabled = true;
      try {
        const u = registering
          ? await api('/api/register', { method: 'POST', body: { name: $('name').value, email: $('email').value, password: $('password').value, birthday: $('birthday').value || undefined } })
          : await api('/api/login', { method: 'POST', body: { id: $('id').value, password: $('password').value } });
        await session.refresh();
        go(registering ? `#/konto?welcome=${encodeURIComponent(u.member_id)}` : destination(u, next));
      } catch (err) {
        $('error').textContent = err.message;
        $('submit').disabled = false;
      }
    });
  },
};
