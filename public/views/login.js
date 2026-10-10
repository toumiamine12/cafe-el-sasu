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
  async mount(root, params, alive) {
    const $ = (id) => root.querySelector('#' + id);
    const next = params.get('next');
    let registering = false;

    const user = await session.get();
    if (!alive()) return;
    if (user) {
      $('auth-hello').textContent = `Hallo, ${user.name.split(' ')[0]}`;
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

    function setMode(register) {
      registering = register;
      $('mode-login').setAttribute('aria-selected', !register);
      $('mode-register').setAttribute('aria-selected', register);
      $('register-fields').hidden = !register;
      $('login-fields').hidden = register;
      $('form-title').textContent = $('submit').textContent = register ? 'Mitglied werden' : 'Einloggen';
      $('form-sub').textContent = register
        ? 'Kostenlos, in einer Minute erledigt. Deine Mitgliedsnummer bekommst du sofort.'
        : 'Mit Mitgliedsnummer oder E-Mail – für Gäste, Personal und Admin.';
      $('auth-hello').textContent = register ? 'Schön, dich kennenzulernen' : 'Willkommen zurück';
      $('password').autocomplete = register ? 'new-password' : 'current-password';
      $('error').textContent = '';
      $(register ? 'name' : 'id').focus();
    }
    $('mode-login').addEventListener('click', () => setMode(false));
    $('mode-register').addEventListener('click', () => setMode(true));

    $('pw-eye').addEventListener('click', () => {
      const show = $('password').type === 'password';
      $('password').type = show ? 'text' : 'password';
      $('pw-eye').setAttribute('aria-pressed', show);
      $('pw-eye').setAttribute('aria-label', show ? 'Passwort verbergen' : 'Passwort anzeigen');
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
