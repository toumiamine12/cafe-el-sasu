// First login with a temporary password: the owner set it, the employee replaces it before anything else.
import { api, session } from '../app.js';
import { go, roleHome } from '../router.js';

export default {
  title: 'Passwort festlegen',
  hero: false,
  auth: 'user',
  mount(root) {
    const $ = (id) => root.querySelector('#' + id);
    $('pw-form').addEventListener('submit', async (e) => {
      e.preventDefault();
      $('pw-error').textContent = '';
      if ($('pw-new').value !== $('pw-new2').value) return void ($('pw-error').textContent = 'Die beiden neuen Passwörter stimmen nicht überein');
      if ($('pw-new').value === $('pw-old').value) return void ($('pw-error').textContent = 'Bitte ein anderes als das vorläufige Passwort wählen');
      try {
        await api('/api/me/password', { method: 'POST', body: { current: $('pw-old').value, next: $('pw-new').value } });
        const user = await session.refresh();
        go(roleHome(user));
      } catch (err) { $('pw-error').textContent = err.message; }
    });
  },
};
