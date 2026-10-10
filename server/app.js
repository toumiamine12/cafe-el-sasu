import express from 'express';
import { randomBytes } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { hashPassword, verifyPassword, tx } from './db.js';
import { tierFor, isOpenAt, validatePickup, priceOrder, pointsFor, nextChange } from './rules.js';

const SESSION_DAYS = 30;
const PUBLIC = fileURLToPath(new URL('../public', import.meta.url));

class HttpError extends Error {
  constructor(status, message) { super(message); this.status = status; }
}
const fail = (status, message) => { throw new HttpError(status, message); };

const publicUser = ({ password_hash, ...u }) => ({ ...u, tier: tierFor(u.lifetime_points) });

// Field checks shared by register and profile edit.
const checkName = (v) => { if (typeof v !== 'string' || !v.trim() || v.length > 80) fail(400, 'Name fehlt'); };
const checkEmail = (v) => { if (typeof v !== 'string' || v.length > 120 || !/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(v)) fail(400, 'Ungültige E-Mail'); };
const checkPassword = (v) => { if (typeof v !== 'string' || v.length < 6) fail(400, 'Passwort braucht mindestens 6 Zeichen'); };
const checkBirthday = (v) => {
  const ok = typeof v === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(v) && !isNaN(new Date(v)) && new Date(v).toISOString().startsWith(v);
  if (!ok) fail(400, 'Ungültiges Geburtsdatum');
};

const berlinDay = new Intl.DateTimeFormat('en-CA', { timeZone: 'Europe/Berlin', month: '2-digit', day: '2-digit' });
const isBirthday = (u) => !!u.birthday && u.birthday.slice(5) === berlinDay.format(new Date());

export function createApp(db) {
  const app = express();
  app.use(express.json({ limit: '20kb' }));
  // The site is one page now; old page addresses point to their hash route.
  const OLD_PAGES = {
    '/menu.html': '/#/speisekarte', '/order.html': '/#/warenkorb', '/login.html': '/#/login',
    '/account.html': '/#/konto', '/admin.html': '/#/admin', '/credits.html': '/#/bildnachweise', '/about.html': '/#/',
  };
  for (const [old, target] of Object.entries(OLD_PAGES)) app.get(old, (req, res) => res.redirect(301, target));
  app.use(express.static(PUBLIC));

  const q = (sql) => db.prepare(sql);

  // --- sessions -------------------------------------------------------------
  app.use((req, res, next) => {
    const token = /(?:^|;\s*)sid=([a-f0-9]{64})/.exec(req.headers.cookie || '')?.[1];
    if (token) {
      req.user = q(`SELECT u.* FROM sessions s JOIN users u ON u.id = s.user_id
                    WHERE s.token = ? AND s.expires_at > ?`).get(token, Date.now());
      req.token = token;
    }
    next();
  });

  function startSession(res, userId) {
    const token = randomBytes(32).toString('hex');
    q('INSERT INTO sessions (token, user_id, expires_at) VALUES (?, ?, ?)').run(token, userId, Date.now() + SESSION_DAYS * 864e5);
    res.cookie('sid', token, { httpOnly: true, sameSite: 'lax', secure: process.env.NODE_ENV === 'production', maxAge: SESSION_DAYS * 864e5 });
  }

  const requireRole = (...roles) => (req, res, next) => {
    if (!req.user) return res.status(401).json({ error: 'Bitte einloggen' });
    if (roles.length && !roles.includes(req.user.role)) return res.status(403).json({ error: 'Kein Zugriff' });
    next();
  };
  const loggedIn = requireRole();

  // --- auth -----------------------------------------------------------------
  app.post('/api/register', (req, res) => {
    const { name, email, password, birthday } = req.body;
    checkName(name);
    checkEmail(email);
    checkPassword(password);
    if (birthday) checkBirthday(birthday);
    if (q('SELECT 1 FROM users WHERE email = ?').get(email)) fail(409, 'E-Mail ist bereits registriert');
    const user = tx(db, () => {
      const n = q("SELECT COALESCE(MAX(CAST(SUBSTR(member_id, 6) AS INTEGER)), 999) + 1 n FROM users").get().n;
      const { lastInsertRowid } = q('INSERT INTO users (member_id, name, email, password_hash, birthday) VALUES (?, ?, ?, ?, ?)')
        .run(`SASU-${n}`, name.trim(), email.trim(), hashPassword(password), birthday || null);
      return q('SELECT * FROM users WHERE id = ?').get(lastInsertRowid);
    });
    startSession(res, user.id);
    res.status(201).json(publicUser(user));
  });

  app.post('/api/login', (req, res) => {
    const { id, password } = req.body;
    const user = typeof id === 'string' && q('SELECT * FROM users WHERE member_id = ? OR email = ?').get(id.trim().toUpperCase(), id.trim());
    if (!user || typeof password !== 'string' || !verifyPassword(password, user.password_hash)) fail(401, 'Mitgliedsnummer/E-Mail oder Passwort falsch');
    startSession(res, user.id);
    res.json(publicUser(user));
  });

  app.post('/api/logout', (req, res) => {
    if (req.token) q('DELETE FROM sessions WHERE token = ?').run(req.token);
    res.clearCookie('sid').json({ ok: true });
  });

  const withStats = (u) => {
    const { orders, spent_cents } = q(`SELECT COUNT(*) orders, COALESCE(SUM(total_cents), 0) spent_cents FROM orders
      WHERE user_id = ? AND status = 'picked_up'`).get(u.id);
    const fav = q(`SELECT m.name FROM order_items oi JOIN orders o ON o.id = oi.order_id JOIN menu_items m ON m.id = oi.menu_item_id
      WHERE o.user_id = ? AND o.status != 'cancelled' GROUP BY m.id ORDER BY SUM(oi.qty) DESC LIMIT 1`).get(u.id);
    return { ...publicUser(u), stats: { orders, spent_cents, favorite: fav?.name ?? null } };
  };

  // 200 + null when logged out, so pages can check login without a console error.
  app.get('/api/me', (req, res) => res.json(req.user ? withStats(req.user) : null));

  const PROFILE_FIELDS = { name: checkName, email: checkEmail, birthday: (v) => v === null || checkBirthday(v) };
  app.patch('/api/me', loggedIn, (req, res) => {
    const fields = Object.entries(req.body);
    if (!fields.length || fields.some(([k]) => !Object.hasOwn(PROFILE_FIELDS, k))) fail(400, 'Nur Name, E-Mail und Geburtstag sind änderbar');
    for (const [k, v] of fields) PROFILE_FIELDS[k](v);
    const email = req.body.email?.trim();
    if (email && q('SELECT 1 FROM users WHERE email = ? AND id != ?').get(email, req.user.id)) fail(409, 'E-Mail ist bereits registriert');
    const values = fields.map(([k, v]) => (typeof v === 'string' ? v.trim() : v));
    q(`UPDATE users SET ${fields.map(([k]) => `${k} = ?`)} WHERE id = ?`).run(...values, req.user.id);
    res.json(withStats(q('SELECT * FROM users WHERE id = ?').get(req.user.id)));
  });

  app.post('/api/me/password', loggedIn, (req, res) => {
    const { current, next } = req.body;
    if (typeof current !== 'string' || !verifyPassword(current, req.user.password_hash)) fail(401, 'Aktuelles Passwort ist falsch');
    checkPassword(next);
    q('UPDATE users SET password_hash = ? WHERE id = ?').run(hashPassword(next), req.user.id);
    // Sign out other devices, keep this one.
    q('DELETE FROM sessions WHERE user_id = ? AND token != ?').run(req.user.id, req.token);
    res.json({ ok: true });
  });

  // --- menu & rewards -------------------------------------------------------
  app.get('/api/menu', (req, res) => res.json(q('SELECT * FROM menu_items WHERE active = 1 ORDER BY category, name').all()));

  // Birthday reward: Gold only, on the birthday, once per year (a cancelled order gives it back).
  const usedThisYear = (u, r) => !!q(`SELECT 1 FROM orders WHERE user_id = ? AND reward_id = ? AND status != 'cancelled'
    AND created_at >= ?`).get(u.id, r.id, `${new Date().getUTCFullYear()}-01-01`);
  const rewardsFor = (u) => q('SELECT * FROM rewards ORDER BY cost_points').all()
    .filter((r) => !r.birthday_only || (tierFor(u.lifetime_points).name === 'Gold' && isBirthday(u) && !usedThisYear(u, r)));

  app.get('/api/rewards', loggedIn, (req, res) => res.json(rewardsFor(req.user)));

  // Next 60 valid pickup times on 15-minute marks, within the next 3 days.
  app.get('/api/pickup-slots', (req, res) => {
    const slots = [];
    const t = new Date(Math.ceil(Date.now() / 900e3) * 900e3);
    for (const end = Date.now() + 3 * 864e5; t < end && slots.length < 60; t.setTime(t.getTime() + 900e3)) {
      if (!validatePickup(t)) slots.push(t.toISOString());
    }
    res.json(slots);
  });

  // Home page: open right now? when does that change? earliest pickup?
  app.get('/api/status', (req, res) => {
    const now = new Date();
    const next = new Date(Math.ceil((now.getTime() + 15 * 60e3) / 900e3) * 900e3);
    for (const end = now.getTime() + 7 * 864e5; validatePickup(next, now) && next < end;) next.setTime(next.getTime() + 900e3);
    res.json({ open: isOpenAt(now), changes_at: nextChange(now)?.toISOString() ?? null, next_pickup: next.toISOString() });
  });

  // Home page: best sellers of the last 7 days (padded with other items if sales are thin).
  app.get('/api/popular', (req, res) => {
    res.json(q(`SELECT m.*, COALESCE(s.sold, 0) sold FROM menu_items m
      LEFT JOIN (SELECT oi.menu_item_id, SUM(oi.qty) sold FROM order_items oi JOIN orders o ON o.id = oi.order_id
                 WHERE o.status != 'cancelled' AND o.created_at >= ? GROUP BY oi.menu_item_id) s ON s.menu_item_id = m.id
      WHERE m.active = 1 ORDER BY sold DESC, m.id LIMIT 4`).all(new Date(Date.now() - 7 * 864e5).toISOString()));
  });

  // --- orders ---------------------------------------------------------------
  const withItems = (orders) => {
    const items = q(`SELECT oi.*, m.name, m.photo FROM order_items oi JOIN menu_items m ON m.id = oi.menu_item_id WHERE oi.order_id = ?`);
    return orders.map((o) => ({ ...o, items: items.all(o.id) }));
  };

  app.post('/api/orders', loggedIn, (req, res) => {
    const { items, pickup_at, reward_id } = req.body;
    if (!Array.isArray(items) || !items.length || items.length > 30) fail(400, 'Warenkorb ist leer');
    const menu = q('SELECT * FROM menu_items WHERE id = ? AND active = 1');
    const lines = items.map(({ id, qty }) => {
      if (!Number.isInteger(qty) || qty < 1 || qty > 20) fail(400, 'Ungültige Menge');
      const m = Number.isInteger(id) && menu.get(id);
      if (!m) fail(400, 'Artikel nicht verfügbar');
      return { ...m, qty };
    });
    const pickup = new Date(pickup_at);
    const err = validatePickup(pickup);
    if (err) fail(400, err);

    const order = tx(db, () => {
      const user = q('SELECT * FROM users WHERE id = ?').get(req.user.id);
      let reward = null;
      if (reward_id != null) {
        reward = rewardsFor(user).find((r) => r.id === reward_id);
        if (!reward) fail(400, 'Prämie nicht verfügbar');
        if (user.points < reward.cost_points) fail(400, 'Nicht genug Punkte');
      }
      let price;
      try {
        price = priceOrder(lines, reward, tierFor(user.lifetime_points).discountPct);
      } catch {
        fail(400, 'Für diese Prämie fehlt ein passender Artikel im Warenkorb');
      }
      const cost = reward?.cost_points ?? 0;
      const { lastInsertRowid } = q(`INSERT INTO orders (user_id, pickup_at, subtotal_cents, discount_cents, total_cents, reward_id, reward_points)
        VALUES (?, ?, ?, ?, ?, ?, ?)`).run(user.id, pickup.toISOString(), price.subtotal, price.discount, price.total, reward?.id ?? null, cost);
      const oi = q('INSERT INTO order_items (order_id, menu_item_id, qty, unit_price_cents) VALUES (?, ?, ?, ?)');
      for (const l of lines) oi.run(lastInsertRowid, l.id, l.qty, l.price_cents);
      if (cost) q('UPDATE users SET points = points - ? WHERE id = ?').run(cost, user.id);
      return q('SELECT * FROM orders WHERE id = ?').get(lastInsertRowid);
    });
    res.status(201).json(withItems([order])[0]);
  });

  app.get('/api/orders', loggedIn, (req, res) =>
    res.json(withItems(q('SELECT * FROM orders WHERE user_id = ? ORDER BY created_at DESC LIMIT 50').all(req.user.id))));

  app.post('/api/orders/:id/cancel', loggedIn, (req, res) => {
    tx(db, () => {
      const o = q('SELECT * FROM orders WHERE id = ? AND user_id = ?').get(Number(req.params.id), req.user.id);
      if (!o) fail(404, 'Bestellung nicht gefunden');
      if (o.status !== 'new') fail(409, 'Bestellung wird schon zubereitet');
      q("UPDATE orders SET status = 'cancelled' WHERE id = ?").run(o.id);
      if (o.reward_points) q('UPDATE users SET points = points + ? WHERE id = ?').run(o.reward_points, o.user_id);
    });
    res.json({ ok: true });
  });

  // --- staff / admin --------------------------------------------------------
  const staff = requireRole('staff', 'admin');

  app.get('/api/admin/orders', staff, (req, res) =>
    res.json(withItems(q(`SELECT o.*, u.name customer, u.member_id FROM orders o JOIN users u ON u.id = o.user_id
      WHERE o.status IN ('new','preparing','ready') ORDER BY o.pickup_at`).all())));

  app.patch('/api/admin/orders/:id', staff, (req, res) => {
    const { status } = req.body;
    if (!['preparing', 'ready', 'picked_up', 'cancelled'].includes(status)) fail(400, 'Ungültiger Status');
    tx(db, () => {
      const o = q('SELECT * FROM orders WHERE id = ?').get(Number(req.params.id));
      if (!o) fail(404, 'Bestellung nicht gefunden');
      if (['picked_up', 'cancelled'].includes(o.status)) fail(409, 'Bestellung ist bereits abgeschlossen');
      q('UPDATE orders SET status = ? WHERE id = ?').run(status, o.id);
      if (status === 'picked_up') {
        const pts = pointsFor(o.total_cents);
        q('UPDATE users SET points = points + ?, lifetime_points = lifetime_points + ? WHERE id = ?').run(pts, pts, o.user_id);
      }
      if (status === 'cancelled' && o.reward_points) q('UPDATE users SET points = points + ? WHERE id = ?').run(o.reward_points, o.user_id);
    });
    res.json({ ok: true });
  });

  app.post('/api/admin/shifts/clock', staff, (req, res) => {
    const open = tx(db, () => {
      const s = q('SELECT id FROM shifts WHERE user_id = ? AND clock_out IS NULL').get(req.user.id);
      const now = new Date().toISOString();
      if (s) q('UPDATE shifts SET clock_out = ? WHERE id = ?').run(now, s.id);
      else q('INSERT INTO shifts (user_id, clock_in) VALUES (?, ?)').run(req.user.id, now);
      return !s;
    });
    res.json({ open });
  });

  // Hours worked since a date; open shifts count up to now.
  const HOURS_SQL = `COALESCE(SUM((julianday(COALESCE(s.clock_out, ?)) - julianday(s.clock_in)) * 24), 0)`;
  const sinceDays = (d) => new Date(Date.now() - d * 864e5).toISOString();

  app.get('/api/admin/shifts', staff, (req, res) => {
    const now = new Date().toISOString();
    const hours = q(`SELECT ${HOURS_SQL} h FROM shifts s WHERE s.user_id = ? AND s.clock_in >= ?`);
    const people = req.user.role === 'admin'
      ? q("SELECT * FROM users WHERE role IN ('staff','admin') ORDER BY name").all()
      : [req.user];
    res.json(people.map((u) => ({
      id: u.id, name: u.name, member_id: u.member_id, role: u.role, hourly_wage: u.hourly_wage,
      open: !!q('SELECT 1 FROM shifts WHERE user_id = ? AND clock_out IS NULL').get(u.id),
      hours_week: hours.get(now, u.id, sinceDays(7)).h,
      hours_month: hours.get(now, u.id, sinceDays(30)).h,
    })));
  });

  // --- admin only -----------------------------------------------------------
  const admin = requireRole('admin');
  const RANGES = { day: 1, week: 7, month: 30 };

  app.get('/api/admin/finance', admin, (req, res) => {
    const days = RANGES[req.query.range];
    if (!days) fail(400, 'range muss day, week oder month sein');
    const since = sinceDays(days);
    const { revenue, orders } = q(`SELECT COALESCE(SUM(total_cents), 0) revenue, COUNT(*) orders FROM orders
      WHERE status = 'picked_up' AND pickup_at >= ?`).get(since);
    const wages = Math.round(q(`SELECT COALESCE(SUM((julianday(COALESCE(s.clock_out, ?)) - julianday(s.clock_in)) * 24 * u.hourly_wage), 0) w
      FROM shifts s JOIN users u ON u.id = s.user_id WHERE s.clock_in >= ?`).get(new Date().toISOString(), since).w);
    const top = q(`SELECT m.name, SUM(oi.qty) qty FROM order_items oi JOIN orders o ON o.id = oi.order_id JOIN menu_items m ON m.id = oi.menu_item_id
      WHERE o.status = 'picked_up' AND o.pickup_at >= ? GROUP BY m.id ORDER BY qty DESC LIMIT 5`).all(since);
    res.json({ revenue, wages, profit: revenue - wages, orders, top });
  });

  const MENU_FIELDS = {
    name: (v) => typeof v === 'string' && v.trim().length > 0 && v.length <= 80,
    description: (v) => typeof v === 'string' && v.length <= 300,
    category: (v) => ['coffee', 'cold', 'cake', 'pastry'].includes(v),
    price_cents: (v) => Number.isInteger(v) && v > 0 && v < 100000,
    photo: (v) => typeof v === 'string' && /^photos\/[\w.-]+$/.test(v),
    tags: (v) => typeof v === 'string' && v.length <= 100,
    active: (v) => v === 0 || v === 1,
  };
  const menuFields = (body) => Object.entries(body).filter(([k]) => k in MENU_FIELDS).map(([k, v]) => {
    if (!MENU_FIELDS[k](v)) fail(400, `Ungültiger Wert für ${k}`);
    return [k, v];
  });

  app.get('/api/admin/menu', admin, (req, res) => res.json(q('SELECT * FROM menu_items ORDER BY category, name').all()));

  app.post('/api/admin/menu', admin, (req, res) => {
    const fields = menuFields(req.body);
    const keys = fields.map(([k]) => k);
    if (!['name', 'category', 'price_cents'].every((k) => keys.includes(k))) fail(400, 'Name, Kategorie und Preis sind Pflicht');
    const { lastInsertRowid } = q(`INSERT INTO menu_items (${keys}) VALUES (${keys.map(() => '?')})`).run(...fields.map(([, v]) => v));
    res.status(201).json(q('SELECT * FROM menu_items WHERE id = ?').get(lastInsertRowid));
  });

  app.patch('/api/admin/menu/:id', admin, (req, res) => {
    const fields = menuFields(req.body);
    if (!fields.length) fail(400, 'Keine Änderungen');
    const r = q(`UPDATE menu_items SET ${fields.map(([k]) => `${k} = ?`)} WHERE id = ?`).run(...fields.map(([, v]) => v), Number(req.params.id));
    if (!r.changes) fail(404, 'Artikel nicht gefunden');
    res.json(q('SELECT * FROM menu_items WHERE id = ?').get(Number(req.params.id)));
  });

  // --- errors ---------------------------------------------------------------
  app.use('/api', (req, res) => res.status(404).json({ error: 'Nicht gefunden' }));
  app.use((err, req, res, next) => {
    if (err instanceof HttpError) return res.status(err.status).json({ error: err.message });
    if (err.type === 'entity.parse.failed') return res.status(400).json({ error: 'Ungültige Anfrage' });
    console.error(err);
    res.status(500).json({ error: 'Serverfehler' });
  });

  return app;
}
