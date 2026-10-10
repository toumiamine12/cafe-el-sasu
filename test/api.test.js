import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { openDb } from '../server/db.js';
import { createApp } from '../server/app.js';
import { validatePickup } from '../server/rules.js';

let server, base, db;
before(async () => {
  db = openDb(':memory:');
  server = createApp(db).listen(0);
  await new Promise((r) => server.once('listening', r));
  base = `http://localhost:${server.address().port}`;
});
after(() => server.close());

// Minimal client that keeps the session cookie.
function client() {
  let cookie = '';
  return async (method, path, body) => {
    const res = await fetch(base + path, {
      method,
      headers: { 'content-type': 'application/json', cookie },
      body: body && JSON.stringify(body),
    });
    const set = res.headers.get('set-cookie');
    if (set) cookie = set.split(';')[0];
    return { status: res.status, body: await res.json().catch(() => null) };
  };
}

async function login(id, password) {
  const c = client();
  assert.equal((await c('POST', '/api/login', { id, password })).status, 200);
  return c;
}

// Next pickup slot that passes validation (an hour step search from tomorrow).
function nextOpen() {
  const t = new Date(Date.now() + 864e5);
  t.setUTCMinutes(0, 0, 0);
  while (validatePickup(t)) t.setTime(t.getTime() + 3600e3);
  return t.toISOString();
}
function nextMonday() {
  const t = new Date(Date.now() + 864e5);
  t.setUTCHours(10, 0, 0, 0); // 12:00 Berlin in summer, 11:00 in winter
  while (t.getUTCDay() !== 1) t.setTime(t.getTime() + 864e5);
  return t.toISOString();
}

const itemByName = (name) => db.prepare('SELECT * FROM menu_items WHERE name = ?').get(name);

test('register returns a member ID and logs in', async () => {
  const c = client();
  const r = await c('POST', '/api/register', { name: 'Test', email: 't@example.com', password: 'secret12' });
  assert.equal(r.status, 201);
  assert.match(r.body.member_id, /^SASU-\d{4,}$/);
  assert.equal((await c('GET', '/api/me')).body.email, 't@example.com');
});

test('register rejects duplicate email and short password', async () => {
  const c = client();
  assert.equal((await c('POST', '/api/register', { name: 'A', email: 'anna@example.com', password: 'secret12' })).status, 409);
  assert.equal((await c('POST', '/api/register', { name: 'A', email: 'x@example.com', password: '123' })).status, 400);
});

test('login works with member ID or email, rejects wrong password', async () => {
  await login('SASU-1003', 'demo123');
  await login('ANNA@example.com', 'demo123');
  assert.equal((await client()('POST', '/api/login', { id: 'SASU-1003', password: 'nope' })).status, 401);
  assert.equal((await client()('POST', '/api/login', { id: 'SASU-9999', password: 'nope' })).status, 401);
});

test('me includes tier info', async () => {
  const c = await login('SASU-1005', 'demo123');
  const me = (await c('GET', '/api/me')).body;
  assert.equal(me.tier.name, 'Gold');
  assert.equal(me.password_hash, undefined);
});

test('order total uses DB prices, ignores client prices', async () => {
  const c = await login('SASU-1003', 'demo123'); // Bronze, no discount
  const cap = itemByName('Cappuccino');
  const r = await c('POST', '/api/orders', { items: [{ id: cap.id, qty: 2, price_cents: 1 }], pickup_at: nextOpen() });
  assert.equal(r.status, 201);
  assert.equal(r.body.total_cents, cap.price_cents * 2);
});

test('order gets tier discount', async () => {
  const c = await login('SASU-1004', 'demo123'); // Silver 5%
  const r = await c('POST', '/api/orders', { items: [{ id: itemByName('Cheesecake').id, qty: 1 }], pickup_at: nextOpen() });
  assert.equal(r.body.total_cents, 799 - Math.floor(799 * 0.05));
});

test('order rejects pickup on Monday and anonymous users', async () => {
  const c = await login('SASU-1003', 'demo123');
  const items = [{ id: itemByName('Cappuccino').id, qty: 1 }];
  assert.equal((await c('POST', '/api/orders', { items, pickup_at: nextMonday() })).status, 400);
  assert.equal((await client()('POST', '/api/orders', { items, pickup_at: nextOpen() })).status, 401);
});

test('order rejects bad items and quantities', async () => {
  const c = await login('SASU-1003', 'demo123');
  const pickup_at = nextOpen();
  const id = itemByName('Croissant').id;
  for (const items of [[], [{ id, qty: 0 }], [{ id, qty: -1 }], [{ id, qty: 1.5 }], [{ id: 99999, qty: 1 }], 'x']) {
    assert.equal((await c('POST', '/api/orders', { items, pickup_at })).status, 400, JSON.stringify(items));
  }
  db.prepare('UPDATE menu_items SET active = 0 WHERE id = ?').run(id);
  assert.equal((await c('POST', '/api/orders', { items: [{ id, qty: 1 }], pickup_at })).status, 400);
  db.prepare('UPDATE menu_items SET active = 1 WHERE id = ?').run(id);
});

test('reward with too few points is rejected', async () => {
  const c = await login('SASU-1003', 'demo123'); // 80 points
  const cake = db.prepare("SELECT id FROM rewards WHERE category_allowed = 'cake'").get();
  const r = await c('POST', '/api/orders', { items: [{ id: itemByName('Cheesecake').id, qty: 1 }], pickup_at: nextOpen(), reward_id: cake.id });
  assert.equal(r.status, 400);
});

test('reward makes item free, cancel refunds points', async () => {
  const c = await login('SASU-1003', 'demo123');
  const pastry = db.prepare("SELECT id FROM rewards WHERE category_allowed = 'pastry'").get();
  const before = (await c('GET', '/api/me')).body.points;
  const r = await c('POST', '/api/orders', {
    items: [{ id: itemByName('Croissant').id, qty: 1 }, { id: itemByName('Espresso').id, qty: 1 }],
    pickup_at: nextOpen(), reward_id: pastry.id,
  });
  assert.equal(r.status, 201);
  assert.equal(r.body.total_cents, 249);
  assert.equal((await c('GET', '/api/me')).body.points, before - 50);
  assert.equal((await c('POST', `/api/orders/${r.body.id}/cancel`)).status, 200);
  assert.equal((await c('GET', '/api/me')).body.points, before);
});

test('cannot cancel someone else\'s order or a started one', async () => {
  const anna = await login('SASU-1003', 'demo123');
  const mehmet = await login('SASU-1004', 'demo123');
  const r = await anna('POST', '/api/orders', { items: [{ id: itemByName('Espresso').id, qty: 1 }], pickup_at: nextOpen() });
  assert.equal((await mehmet('POST', `/api/orders/${r.body.id}/cancel`)).status, 404);
  db.prepare("UPDATE orders SET status = 'preparing' WHERE id = ?").run(r.body.id);
  assert.equal((await anna('POST', `/api/orders/${r.body.id}/cancel`)).status, 409);
});

test('orders list shows only own orders with items', async () => {
  const c = await login('SASU-1003', 'demo123');
  const list = (await c('GET', '/api/orders')).body;
  assert.ok(list.length > 0);
  assert.ok(list.every((o) => o.user_id === 4));
  assert.ok(list[0].items[0].name);
});

test('menu is public and hides inactive items', async () => {
  const r = await client()('GET', '/api/menu');
  assert.equal(r.status, 200);
  assert.ok(r.body.length >= 49);
  assert.ok(r.body.every((i) => i.active === 1));
});

test('customer is blocked from admin API', async () => {
  const c = await login('SASU-1003', 'demo123');
  assert.equal((await c('GET', '/api/admin/orders')).status, 403);
  assert.equal((await client()('GET', '/api/admin/orders')).status, 401);
});

test('logout ends the session', async () => {
  const c = await login('SASU-1003', 'demo123');
  await c('POST', '/api/logout');
  const r = await c('GET', '/api/me');
  assert.equal(r.status, 200);
  assert.equal(r.body, null);
});

// --- staff / admin ---------------------------------------------------------

async function newOrder(c) {
  return (await c('POST', '/api/orders', { items: [{ id: itemByName('Cheesecake').id, qty: 2 }], pickup_at: nextOpen() })).body;
}

test('staff moves order to picked_up, points credited once', async () => {
  const anna = await login('SASU-1003', 'demo123');
  const lena = await login('SASU-1001', 'staff123');
  const o = await newOrder(anna);
  const before = (await anna('GET', '/api/me')).body;
  assert.ok((await lena('GET', '/api/admin/orders')).body.some((x) => x.id === o.id));
  for (const status of ['preparing', 'ready', 'picked_up']) {
    assert.equal((await lena('PATCH', `/api/admin/orders/${o.id}`, { status })).status, 200);
  }
  assert.equal((await lena('PATCH', `/api/admin/orders/${o.id}`, { status: 'picked_up' })).status, 409);
  const after = (await anna('GET', '/api/me')).body;
  assert.equal(after.points - before.points, Math.floor(o.total_cents / 100));
  assert.equal(after.lifetime_points - before.lifetime_points, Math.floor(o.total_cents / 100));
  assert.equal((await lena('PATCH', `/api/admin/orders/${o.id}`, { status: 'bogus' })).status, 400);
});

test('staff cannot see finance or edit menu', async () => {
  const lena = await login('SASU-1001', 'staff123');
  assert.equal((await lena('GET', '/api/admin/finance?range=month')).status, 403);
  assert.equal((await lena('PATCH', '/api/admin/menu/1', { price_cents: 1 })).status, 403);
});

test('clock toggles one shift at a time', async () => {
  const yusuf = await login('SASU-1002', 'staff123');
  const before = db.prepare('SELECT COUNT(*) n FROM shifts WHERE user_id = 3').get().n;
  assert.equal((await yusuf('POST', '/api/admin/shifts/clock')).body.open, true);
  assert.equal((await yusuf('POST', '/api/admin/shifts/clock')).body.open, false);
  assert.equal(db.prepare('SELECT COUNT(*) n FROM shifts WHERE user_id = 3').get().n, before + 1);
  assert.equal(db.prepare('SELECT COUNT(*) n FROM shifts WHERE clock_out IS NULL').get().n, 0);
  const mine = (await yusuf('GET', '/api/admin/shifts')).body;
  assert.equal(mine.length, 1);
  assert.equal(mine[0].member_id, 'SASU-1002');
});

test('admin sees all staff hours and finance', async () => {
  const admin = await login('SASU-1000', 'admin123');
  const shifts = (await admin('GET', '/api/admin/shifts')).body;
  assert.ok(shifts.length >= 2);
  assert.ok(shifts.find((s) => s.member_id === 'SASU-1001').hours_month > 0);

  const f = (await admin('GET', '/api/admin/finance?range=month')).body;
  const since = new Date(Date.now() - 30 * 864e5).toISOString();
  const expected = db.prepare("SELECT SUM(total_cents) s FROM orders WHERE status = 'picked_up' AND pickup_at >= ?").get(since).s;
  assert.equal(f.revenue, expected);
  assert.ok(f.wages > 0);
  assert.equal(f.profit, f.revenue - f.wages);
  assert.ok(f.top.length > 0 && f.top.length <= 5);
  assert.equal((await admin('GET', '/api/admin/finance?range=year')).status, 400);
});

test('admin edits and adds menu items', async () => {
  const admin = await login('SASU-1000', 'admin123');
  const id = itemByName('Espresso').id;
  assert.equal((await admin('PATCH', `/api/admin/menu/${id}`, { price_cents: 279 })).status, 200);
  assert.equal(itemByName('Espresso').price_cents, 279);
  assert.equal((await admin('PATCH', `/api/admin/menu/${id}`, { price_cents: -5 })).status, 400);
  const r = await admin('POST', '/api/admin/menu', { name: 'Ristretto', category: 'coffee', price_cents: 259 });
  assert.equal(r.status, 201);
  assert.ok((await admin('GET', '/api/admin/menu')).body.some((m) => m.name === 'Ristretto'));
});

test('pickup slots are all valid and 15 minutes apart', async () => {
  const slots = (await client()('GET', '/api/pickup-slots')).body;
  assert.ok(slots.length > 0 && slots.length <= 60);
  for (const s of slots) assert.equal(validatePickup(new Date(s)), null, s);
  assert.equal(new Date(slots[0]).getUTCMinutes() % 15, 0);
});

test('walk-in account cannot log in', async () => {
  assert.equal((await client()('POST', '/api/login', { id: 'gast@cafe-elsasu.de', password: 'x' })).status, 401);
});

test('birthday coffee can be redeemed once per year', async () => {
  const today = new Intl.DateTimeFormat('en-CA', { timeZone: 'Europe/Berlin' }).format(new Date());
  db.prepare("UPDATE users SET birthday = ? WHERE member_id = 'SASU-1005'").run('1995' + today.slice(4));
  const c = await login('SASU-1005', 'demo123'); // Gold
  const bday = db.prepare('SELECT id FROM rewards WHERE birthday_only = 1').get();
  assert.ok((await c('GET', '/api/rewards')).body.some((r) => r.id === bday.id));
  const body = { items: [{ id: itemByName('Espresso').id, qty: 1 }], pickup_at: nextOpen(), reward_id: bday.id };
  const first = await c('POST', '/api/orders', body);
  assert.equal(first.status, 201);
  assert.equal(first.body.total_cents, 0);
  assert.equal((await c('POST', '/api/orders', body)).status, 400);
  assert.ok(!(await c('GET', '/api/rewards')).body.some((r) => r.id === bday.id));
  await c('POST', `/api/orders/${first.body.id}/cancel`);
  assert.ok((await c('GET', '/api/rewards')).body.some((r) => r.id === bday.id), 'cancel gives it back');
});

// --- account ----------------------------------------------------------------

test('me includes purchase stats', async () => {
  const c = await login('SASU-1004', 'demo123');
  const me = (await c('GET', '/api/me')).body;
  const row = db.prepare("SELECT COUNT(*) n, SUM(total_cents) s FROM orders WHERE user_id = 5 AND status = 'picked_up'").get();
  assert.equal(me.stats.orders, row.n);
  assert.equal(me.stats.spent_cents, row.s);
  assert.ok(me.stats.favorite);
});

test('profile update changes name, email, birthday', async () => {
  const c = client();
  await c('POST', '/api/register', { name: 'Old', email: 'old@example.com', password: 'secret12' });
  const r = await c('PATCH', '/api/me', { name: 'Neu Name', email: 'neu@example.com', birthday: '1990-05-17' });
  assert.equal(r.status, 200);
  assert.equal(r.body.name, 'Neu Name');
  assert.equal(r.body.email, 'neu@example.com');
  assert.equal(r.body.birthday, '1990-05-17');
  assert.equal((await c('PATCH', '/api/me', { email: 'anna@example.com' })).status, 409);
  assert.equal((await c('PATCH', '/api/me', { email: 'nope' })).status, 400);
  assert.equal((await c('PATCH', '/api/me', { birthday: '2000-13-45' })).status, 400);
  assert.equal((await c('PATCH', '/api/me', { role: 'admin', points: 9999 })).status, 400);
  assert.equal((await c('GET', '/api/me')).body.role, 'customer');
  assert.equal((await c('PATCH', '/api/me', { birthday: null })).body.birthday, null);
});

test('password change needs the current password', async () => {
  const c = client();
  await c('POST', '/api/register', { name: 'Pw', email: 'pw@example.com', password: 'secret12' });
  assert.equal((await c('POST', '/api/me/password', { current: 'wrong', next: 'newsecret' })).status, 401);
  assert.equal((await c('POST', '/api/me/password', { current: 'secret12', next: '123' })).status, 400);
  assert.equal((await c('POST', '/api/me/password', { current: 'secret12', next: 'newsecret' })).status, 200);
  assert.equal((await client()('POST', '/api/login', { id: 'pw@example.com', password: 'secret12' })).status, 401);
  await login('pw@example.com', 'newsecret');
});

test('account routes need login', async () => {
  assert.equal((await client()('PATCH', '/api/me', { name: 'x' })).status, 401);
  assert.equal((await client()('POST', '/api/me/password', { current: 'a', next: 'bbbbbb' })).status, 401);
});

// --- home page ---------------------------------------------------------------

test('status reports open/closed with next change and next pickup', async () => {
  const s = (await client()('GET', '/api/status')).body;
  assert.equal(typeof s.open, 'boolean');
  assert.ok(!isNaN(new Date(s.changes_at)));
  assert.ok(new Date(s.changes_at) > new Date());
  assert.equal(validatePickup(new Date(s.next_pickup)), null);
});

test('popular returns up to 4 active items, best sellers first', async () => {
  const list = (await client()('GET', '/api/popular')).body;
  assert.equal(list.length, 4);
  assert.ok(list.every((i) => i.active === 1 && i.sold >= 0));
  assert.ok(list[0].sold >= list[3].sold);
});

// --- single-page app -----------------------------------------------------------

test('login returns role for each account type', async () => {
  for (const [id, pw, role] of [['SASU-1003', 'demo123', 'customer'], ['SASU-1001', 'staff123', 'staff'], ['SASU-1000', 'admin123', 'admin']]) {
    const r = await client()('POST', '/api/login', { id, password: pw });
    assert.equal(r.body.role, role, id);
  }
});

test('old page URLs redirect to hash routes', async () => {
  const map = {
    '/menu.html': '/#/speisekarte', '/order.html': '/#/warenkorb', '/login.html': '/#/login',
    '/account.html': '/#/konto', '/admin.html': '/#/admin', '/credits.html': '/#/bildnachweise', '/about.html': '/#/',
  };
  for (const [old, target] of Object.entries(map)) {
    const res = await fetch(base + old, { redirect: 'manual' });
    assert.equal(res.status, 301, old);
    assert.equal(res.headers.get('location'), target, old);
  }
});
