// Login / register toggle.
let registering = false;
const $ = (id) => document.getElementById(id);
const next = new URLSearchParams(location.search).get('next');
const safeNext = /^[a-z]+\.html$/.test(next || '') ? next : 'account.html';

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
    const user = registering
      ? await api('/api/register', { method: 'POST', body: { name: $('name').value, email: $('email').value, password: $('password').value, birthday: $('birthday').value || undefined } })
      : await api('/api/login', { method: 'POST', body: { id: $('id').value, password: $('password').value } });
    location.href = registering ? `account.html?welcome=${encodeURIComponent(user.member_id)}` : (user.role === 'customer' ? safeNext : 'admin.html');
  } catch (err) {
    $('error').textContent = err.message;
    $('submit').disabled = false;
  }
});

me.then((u) => { if (u) location.replace(safeNext); });
