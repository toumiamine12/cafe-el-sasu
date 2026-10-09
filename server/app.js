import express from 'express';
import { randomBytes } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { hashPassword, verifyPassword, tx } from './db.js';
import { tierFor, validatePickup, priceOrder } from './rules.js';

const SESSION_DAYS = 30;
const PUBLIC = fileURLToPath(new URL('../public', import.meta.url));

class HttpError extends Error {
  constructor(status, message) { super(message); this.status = status; }
}
const fail = (status, message) => { throw new HttpError(status, message); };

const publicUser = ({ password_hash, ...u }) => ({ ...u, tier: tierFor(u.lifetime_points) });

const berlinDay = new Intl.DateTimeFormat('en-CA', { timeZone: 'Europe/Berlin', month: '2-digit', day: '2-digit' });
const isBirthday = (u) => !!u.birthday && u.birthday.slice(5) === berlinDay.format(new Date());

export function createApp(db) {
  const app = express();
  app.use(express.json({ limit: '20kb' }));
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
    res.cookie('sid', token, { httpOnly: true, sameSite: 'lax', maxAge: SESSION_DAYS * 864e5 });
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
    if (typeof name !== 'string' || !name.trim() || name.length > 80) fail(400, 'Name fehlt');
    if (typeof email !== 'string' || !/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) fail(400, 'Ungültige E-Mail');
    if (typeof password !== 'string' || password.length < 6) fail(400, 'Passwort braucht mindestens 6 Zeichen');
    if (birthday && !/^\d{4}-\d{2}-\d{2}$/.test(birthday)) fail(400, 'Ungültiges Geburtsdatum');
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

  app.get('/api/me', loggedIn, (req, res) => res.json(publicUser(req.user)));

  // --- menu & rewards -------------------------------------------------------
  app.get('/api/menu', (req, res) => res.json(q('SELECT * FROM menu_items WHERE active = 1 ORDER BY category, name').all()));

  const rewardsFor = (u) => q('SELECT * FROM rewards ORDER BY cost_points').all()
    .filter((r) => !r.birthday_only || (tierFor(u.lifetime_points).name === 'Gold' && isBirthday(u)));

  app.get('/api/rewards', loggedIn, (req, res) => res.json(rewardsFor(req.user)));

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
