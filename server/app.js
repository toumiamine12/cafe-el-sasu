import express from 'express';
import QRCode from 'qrcode';
import { randomBytes } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { hashPassword, verifyPassword, tx } from './db.js';
import { tierFor, isOpenAt, validatePickup, priceOrder, pointsFor, nextChange, validateModifiers, slotStart, SLOT_CAPACITY } from './rules.js';

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
const checkPassword = (v) => { if (typeof v !== 'string' || v.length < 8 || v.length > 200) fail(400, 'Passwort braucht mindestens 8 Zeichen'); };
const checkBirthday = (v) => {
  const ok = typeof v === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(v) && !isNaN(new Date(v)) && new Date(v).toISOString().startsWith(v);
  if (!ok) fail(400, 'Ungültiges Geburtsdatum');
};

const berlinDay = new Intl.DateTimeFormat('en-CA', { timeZone: 'Europe/Berlin', month: '2-digit', day: '2-digit' });
const isBirthday = (u) => !!u.birthday && u.birthday.slice(5) === berlinDay.format(new Date());

// Content-Security-Policy: only our own scripts run; fonts, the Bootstrap CSS and the Maps embed are the only outside sources.
const CSP = [
  "default-src 'self'",
  "script-src 'self'",
  "style-src 'self' 'unsafe-inline' https://fonts.googleapis.com https://maxcdn.bootstrapcdn.com",
  "font-src 'self' https://fonts.gstatic.com https://maxcdn.bootstrapcdn.com",
  "img-src 'self' data: https:", // menu photos may be hosted elsewhere (https only)
  "frame-src https://www.google.com",
  "connect-src 'self'",
  "form-action 'self'",
  "base-uri 'none'",
  "object-src 'none'",
  "frame-ancestors 'none'",
].join('; ');

// Login throttling: 5 wrong passwords per account, 20 per IP, then 15 minutes pause.
const LOCK_MS = 15 * 60e3;
function createLimiter() {
  const fails = new Map(); // key -> { n, until }
  const hit = (key) => {
    const f = fails.get(key);
    return f && f.until > Date.now() ? f : null;
  };
  return {
    blocked: (keys) => keys.some(([key, max]) => (hit(key)?.n ?? 0) >= max),
    fail(keys) {
      for (const [key] of keys) {
        const f = hit(key) ?? { n: 0 };
        fails.set(key, { n: f.n + 1, until: Date.now() + LOCK_MS });
      }
    },
    reset: (key) => fails.delete(key),
  };
}

export function createApp(db) {
  const app = express();
  app.disable('x-powered-by');
  if (process.env.NODE_ENV === 'production') app.set('trust proxy', 1); // real client IP behind Render's proxy (login throttling)
  app.use((req, res, next) => {
    res.set({
      'Content-Security-Policy': CSP,
      'X-Frame-Options': 'DENY',
      'X-Content-Type-Options': 'nosniff',
      'Referrer-Policy': 'strict-origin-when-cross-origin',
      'Permissions-Policy': 'camera=(self), microphone=(), geolocation=()', // camera: staff QR scanner
    });
    next();
  });

  // Cross-site request protection: writes must be JSON (forms can't send that cross-site without CORS)
  // and, when the browser says where the request comes from, it must be this site.
  app.use('/api', (req, res, next) => {
    if (req.method === 'GET' || req.method === 'HEAD') return next();
    const origin = req.get('origin');
    if (origin && new URL(origin).host !== req.get('host')) return res.status(403).json({ error: 'Anfrage von fremder Seite abgelehnt' });
    // Checked on the header itself: HTML forms always send a non-JSON type, even with an empty body.
    if (!/^application\/json\b/i.test(req.get('content-type') || '')) return res.status(403).json({ error: 'Nur JSON-Anfragen erlaubt' });
    next();
  });
  app.use(express.json({ limit: '20kb' }));
  const limiter = createLimiter();
  // The site is one page now; old page addresses point to their hash route.
  const OLD_PAGES = {
    '/menu.html': '/#/speisekarte', '/order.html': '/#/warenkorb', '/login.html': '/#/login',
    '/account.html': '/#/konto', '/admin.html': '/#/admin', '/credits.html': '/#/bildnachweise', '/about.html': '/#/',
  };
  for (const [old, target] of Object.entries(OLD_PAGES)) app.get(old, (req, res) => res.redirect(301, target));
  app.use(express.static(PUBLIC));

  const q = (sql) => db.prepare(sql);
  const setting = (key) => q('SELECT value FROM settings WHERE key = ?').get(key)?.value;
  const capacity = () => Number(setting('slot_capacity')) || SLOT_CAPACITY;
  const paused = () => setting('orders_paused') === '1';
  const leadMinutes = () => 15 + Number(setting('extra_delay_min') || 0); // 30 while staff run the rush delay
  // Non-cancelled orders already booked into the 15-minute window that contains `date`.
  const bookedIn = (date) => {
    const from = slotStart(date);
    return q(`SELECT COUNT(*) n FROM orders WHERE status != 'cancelled' AND pickup_at >= ? AND pickup_at < ?`)
      .get(from.toISOString(), new Date(from.getTime() + 900e3).toISOString()).n;
  };

  // --- sessions -------------------------------------------------------------
  app.use((req, res, next) => {
    const token = /(?:^|;\s*)sid=([a-f0-9]{64})/.exec(req.headers.cookie || '')?.[1];
    if (token) {
      req.user = q(`SELECT u.* FROM sessions s JOIN users u ON u.id = s.user_id
                    WHERE s.token = ? AND s.expires_at > ? AND u.active = 1`).get(token, Date.now());
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
    // A temporary password (set by the owner) unlocks nothing until the employee chooses their own.
    if (req.user.must_change_password) return res.status(403).json({ error: 'Bitte zuerst dein eigenes Passwort festlegen' });
    if (roles.length && !roles.includes(req.user.role)) return res.status(403).json({ error: 'Kein Zugriff' });
    next();
  };
  const loggedIn = requireRole();
  const customer = requireRole('customer'); // ordering, rewards and the member card are for guests, not staff

  const nextMemberId = () => `SASU-${q("SELECT COALESCE(MAX(CAST(SUBSTR(member_id, 6) AS INTEGER)), 999) + 1 n FROM users").get().n}`;

  // --- auth -----------------------------------------------------------------
  app.post('/api/register', (req, res) => {
    const { name, email, password, birthday } = req.body;
    checkName(name);
    checkEmail(email);
    checkPassword(password);
    if (birthday) checkBirthday(birthday);
    if (q('SELECT 1 FROM users WHERE email = ?').get(email)) fail(409, 'E-Mail ist bereits registriert');
    const user = tx(db, () => {
      const { lastInsertRowid } = q('INSERT INTO users (member_id, name, email, password_hash, birthday) VALUES (?, ?, ?, ?, ?)')
        .run(nextMemberId(), name.trim(), email.trim(), hashPassword(password), birthday || null);
      return q('SELECT * FROM users WHERE id = ?').get(lastInsertRowid);
    });
    startSession(res, user.id);
    res.status(201).json(publicUser(user));
  });

  app.post('/api/login', (req, res) => {
    const { id, password } = req.body;
    const user = typeof id === 'string' && q('SELECT * FROM users WHERE member_id = ? OR email = ?').get(id.trim().toUpperCase(), id.trim());
    const keys = [[`ip:${req.ip}`, 20], [`acct:${user ? user.id : String(id).trim().toLowerCase()}`, 5]];
    if (limiter.blocked(keys)) fail(429, 'Zu viele Fehlversuche. Bitte in 15 Minuten erneut versuchen.');
    if (!user || typeof password !== 'string' || !verifyPassword(password, user.password_hash)) {
      limiter.fail(keys);
      fail(401, 'Mitgliedsnummer/E-Mail oder Passwort falsch');
    }
    if (!user.active) fail(403, 'Dieses Konto ist deaktiviert. Bitte wende dich an die Inhaberin.');
    limiter.reset(keys[1][0]);
    startSession(res, user.id);
    res.json(publicUser(user));
  });

  app.post('/api/logout', (req, res) => {
    if (req.token) q('DELETE FROM sessions WHERE token = ?').run(req.token);
    res.clearCookie('sid').json({ ok: true });
  });

  // Friendly stats only: what the member saved and enjoyed, never what they spent.
  const withStats = (u) => {
    const { saved_cents, rewards_redeemed } = q(`SELECT COALESCE(SUM(discount_cents), 0) saved_cents, COUNT(reward_id) rewards_redeemed
      FROM orders WHERE user_id = ? AND status = 'picked_up'`).get(u.id);
    const fav = q(`SELECT m.name FROM order_items oi JOIN orders o ON o.id = oi.order_id JOIN menu_items m ON m.id = oi.menu_item_id
      WHERE o.user_id = ? AND o.status != 'cancelled' GROUP BY m.id ORDER BY SUM(oi.qty) DESC LIMIT 1`).get(u.id);
    return { ...publicUser(u), stats: { saved_cents, rewards_redeemed, favorite: fav?.name ?? null } };
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

  // Member card QR: encodes the member ID so staff can scan it at the counter.
  app.get('/api/me/qr', customer, async (req, res, next) => {
    try {
      const svg = await QRCode.toString(req.user.member_id, { type: 'svg', margin: 1, color: { dark: '#3b2615', light: '#ffffff' } });
      res.type('image/svg+xml').set('Cache-Control', 'private, max-age=3600').send(svg);
    } catch (e) { next(e); }
  });

  // Not behind requireRole: this is the one thing a temporary-password account may do.
  const anyLogin = (req, res, next) => (req.user ? next() : res.status(401).json({ error: 'Bitte einloggen' }));
  app.post('/api/me/password', anyLogin, (req, res) => {
    const { current, next } = req.body;
    if (typeof current !== 'string' || !verifyPassword(current, req.user.password_hash)) fail(401, 'Aktuelles Passwort ist falsch');
    checkPassword(next);
    q('UPDATE users SET password_hash = ?, must_change_password = 0 WHERE id = ?').run(hashPassword(next), req.user.id);
    // Sign out other devices, keep this one.
    q('DELETE FROM sessions WHERE user_id = ? AND token != ?').run(req.user.id, req.token);
    res.json({ ok: true });
  });

  // --- menu & rewards -------------------------------------------------------
  // Modifier groups (with options) offered per menu item: Map(itemId -> [group…]).
  function modifierGroups() {
    const options = q('SELECT * FROM modifier_options ORDER BY sort, id').all();
    const groups = q('SELECT * FROM modifier_groups ORDER BY sort, id').all()
      .map((g) => ({ ...g, options: options.filter((o) => o.group_id === g.id) }));
    const byItem = new Map();
    for (const { menu_item_id, group_id } of q('SELECT * FROM menu_item_modifier_groups').all()) {
      if (!byItem.has(menu_item_id)) byItem.set(menu_item_id, []);
      byItem.get(menu_item_id).push(groups.find((g) => g.id === group_id));
    }
    for (const list of byItem.values()) list.sort((a, b) => a.sort - b.sort);
    return byItem;
  }
  const withModifiers = (items) => {
    const byItem = modifierGroups();
    return items.map((i) => ({ ...i, modifiers: byItem.get(i.id) ?? [] }));
  };

  app.get('/api/menu', (req, res) => res.json(withModifiers(q('SELECT * FROM menu_items WHERE active = 1 ORDER BY category, name').all())));

  // Birthday reward: Gold only, on the birthday, once per year (a cancelled order gives it back).
  const usedThisYear = (u, r) => !!q(`SELECT 1 FROM orders WHERE user_id = ? AND reward_id = ? AND status != 'cancelled'
    AND created_at >= ?`).get(u.id, r.id, `${new Date().getUTCFullYear()}-01-01`);
  const rewardsFor = (u) => q('SELECT * FROM rewards ORDER BY cost_points').all()
    .filter((r) => !r.birthday_only || (tierFor(u.lifetime_points).name === 'Gold' && isBirthday(u) && !usedThisYear(u, r)));

  app.get('/api/rewards', customer, (req, res) => res.json(rewardsFor(req.user)));

  // Next 60 valid pickup times on 15-minute marks, within the next 3 days.
  app.get('/api/pickup-slots', (req, res) => {
    const slots = [];
    const t = new Date(Math.ceil(Date.now() / 900e3) * 900e3);
    for (const end = Date.now() + 3 * 864e5; t < end && slots.length < 60; t.setTime(t.getTime() + 900e3)) {
      if (!validatePickup(t, new Date(), leadMinutes())) slots.push(t.toISOString());
    }
    res.json(slots);
  });

  // Checkout: every valid slot in the next 3 days with how many places are left ("Ausgebucht" when 0).
  app.get('/api/pickup-availability', (req, res) => {
    const cap = capacity();
    const slots = [];
    const t = new Date(Math.ceil(Date.now() / 900e3) * 900e3);
    for (const end = Date.now() + 3 * 864e5; t < end && slots.length < 300; t.setTime(t.getTime() + 900e3)) {
      if (validatePickup(t, new Date(), leadMinutes())) continue;
      const left = Math.max(0, cap - bookedIn(t));
      slots.push({ at: t.toISOString(), full: left === 0, left });
    }
    res.json(slots);
  });

  // Home page: open right now? when does that change? earliest pickup?
  app.get('/api/status', (req, res) => {
    const now = new Date();
    const lead = leadMinutes();
    const next = new Date(Math.ceil((now.getTime() + lead * 60e3) / 900e3) * 900e3);
    for (const end = now.getTime() + 7 * 864e5; validatePickup(next, now, lead) && next < end;) next.setTime(next.getTime() + 900e3);
    res.json({
      open: isOpenAt(now), changes_at: nextChange(now)?.toISOString() ?? null, next_pickup: next.toISOString(),
      orders_paused: paused(), lead_minutes: lead,
    });
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
    const mods = q(`SELECT om.option_id, om.group_name, om.name, om.price_cents, COALESCE(mo.is_default, 0) is_default
      FROM order_item_modifiers om LEFT JOIN modifier_options mo ON mo.id = om.option_id WHERE om.order_item_id = ? ORDER BY om.id`);
    return orders.map((o) => ({ ...o, items: items.all(o.id).map((i) => ({ ...i, modifiers: mods.all(i.id) })) }));
  };

  app.post('/api/orders', customer, (req, res) => {
    if (paused()) fail(503, 'Online-Bestellungen sind gerade pausiert. Bitte versuch es gleich noch einmal.');
    const { items, pickup_at, reward_id } = req.body;
    if (!Array.isArray(items) || !items.length || items.length > 30) fail(400, 'Warenkorb ist leer');
    const menu = q('SELECT * FROM menu_items WHERE id = ? AND active = 1');
    const groupsByItem = modifierGroups();
    const lines = items.map(({ id, qty, mods = [] }) => {
      if (!Number.isInteger(qty) || qty < 1 || qty > 20) fail(400, 'Ungültige Menge');
      const m = Number.isInteger(id) && menu.get(id);
      if (!m) fail(400, 'Artikel nicht verfügbar');
      if (m.sold_out) fail(400, `${m.name} ist leider ausverkauft`);
      if (!Array.isArray(mods) || mods.length > 10 || !mods.every(Number.isInteger)) fail(400, 'Ungültige Optionen');
      try {
        return { ...m, qty, mods: validateModifiers(groupsByItem.get(m.id) ?? [], mods) };
      } catch (e) {
        fail(400, `${m.name}: ${e.message}`);
      }
    });
    const pickup = new Date(pickup_at);
    const err = validatePickup(pickup, new Date(), leadMinutes());
    if (err) fail(400, err);

    const order = tx(db, () => {
      // Counted inside the write transaction, so two guests can't both take the last place.
      if (bookedIn(pickup) >= capacity()) fail(409, 'Dieses Abholfenster ist ausgebucht. Bitte wähle eine andere Zeit.');
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
      const om = q('INSERT INTO order_item_modifiers (order_item_id, option_id, group_name, name, price_cents) VALUES (?, ?, ?, ?, ?)');
      const groupName = new Map([...groupsByItem.values()].flat().map((g) => [g.id, g.name]));
      for (const l of lines) {
        const unit = l.price_cents + l.mods.reduce((sum, mod) => sum + mod.price_cents, 0);
        const item = oi.run(lastInsertRowid, l.id, l.qty, unit).lastInsertRowid;
        for (const mod of l.mods) om.run(item, mod.id, groupName.get(mod.group_id), mod.name, mod.price_cents); // copied: later price changes don't touch old receipts
      }
      if (cost) q('UPDATE users SET points = points - ? WHERE id = ?').run(cost, user.id);
      return q('SELECT * FROM orders WHERE id = ?').get(lastInsertRowid);
    });
    res.status(201).json(withItems([order])[0]);
  });

  app.get('/api/orders', customer, (req, res) =>
    res.json(withItems(q('SELECT * FROM orders WHERE user_id = ? ORDER BY created_at DESC LIMIT 50').all(req.user.id))));

  app.post('/api/orders/:id/cancel', customer, (req, res) => {
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

  const TAGS = ['vegan', 'gluten', 'nuts', 'lactose'];
  // A photo is a local file under photos/ or an https URL; nothing else reaches an <img src>.
  const isPhoto = (v) => typeof v === 'string' && v.length <= 500 && (
    /^photos\/[\w-]+(\/[\w-]+)*\.(jpe?g|png|webp|gif)$/i.test(v)
    || (/^https:\/\/[^\s"'<>\\]+$/.test(v) && URL.canParse(v) && new URL(v).protocol === 'https:'));
  const MENU_FIELDS = {
    name: (v) => typeof v === 'string' && v.trim().length > 0 && v.length <= 80,
    description: (v) => typeof v === 'string' && v.length <= 300,
    category: (v) => ['coffee', 'cold', 'cake', 'pastry'].includes(v),
    price_cents: (v) => Number.isInteger(v) && v > 0 && v < 100000,
    photo: isPhoto,
    tags: (v) => typeof v === 'string' && (v === '' || v.split(',').every((t) => TAGS.includes(t))),
    active: (v) => v === 0 || v === 1,
    sold_out: (v) => v === 0 || v === 1,
  };
  const menuFields = (body) => Object.entries(body).filter(([k]) => Object.hasOwn(MENU_FIELDS, k)).map(([k, v]) => {
    if (!MENU_FIELDS[k](v)) fail(400, `Ungültiger Wert für ${k}`);
    return [k, v];
  });

  // Staff read the list too: they switch items to "Ausverkauft" during service.
  app.get('/api/admin/menu', staff, (req, res) => res.json(q('SELECT * FROM menu_items ORDER BY category, name').all()));

  app.patch('/api/admin/menu/:id/sold-out', staff, (req, res) => {
    const { sold_out } = req.body;
    if (sold_out !== 0 && sold_out !== 1) fail(400, 'sold_out muss 0 oder 1 sein');
    const r = q('UPDATE menu_items SET sold_out = ? WHERE id = ?').run(sold_out, Number(req.params.id));
    if (!r.changes) fail(404, 'Artikel nicht gefunden');
    res.json(q('SELECT * FROM menu_items WHERE id = ?').get(Number(req.params.id)));
  });

  // Never ordered → removed for good. Ordered before → only hidden, so old receipts keep their item.
  app.delete('/api/admin/menu/:id', admin, (req, res) => {
    const id = Number(req.params.id);
    const result = tx(db, () => {
      if (!q('SELECT 1 FROM menu_items WHERE id = ?').get(id)) fail(404, 'Artikel nicht gefunden');
      if (q('SELECT 1 FROM order_items WHERE menu_item_id = ?').get(id)) {
        q('UPDATE menu_items SET active = 0 WHERE id = ?').run(id);
        return { deleted: false, hidden: true };
      }
      q('DELETE FROM menu_item_modifier_groups WHERE menu_item_id = ?').run(id);
      q('DELETE FROM menu_items WHERE id = ?').run(id);
      return { deleted: true };
    });
    res.json(result);
  });

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

  // --- kitchen display: rush controls & member lookup ------------------------------
  const settingsView = () => ({
    orders_paused: Number(setting('orders_paused')), extra_delay_min: Number(setting('extra_delay_min')), slot_capacity: capacity(),
  });
  const SETTING_RULES = {
    orders_paused: { ok: (v) => v === 0 || v === 1, role: 'staff' },
    extra_delay_min: { ok: (v) => v === 0 || v === 15, role: 'staff' },
    slot_capacity: { ok: (v) => Number.isInteger(v) && v >= 1 && v <= 1000, role: 'admin' },
  };

  app.get('/api/admin/settings', staff, (req, res) => res.json(settingsView()));

  // Staff switch the rush controls during service; only the owner changes slot capacity.
  app.patch('/api/admin/settings', staff, (req, res) => {
    const entries = Object.entries(req.body);
    if (!entries.length || entries.some(([k]) => !Object.hasOwn(SETTING_RULES, k))) fail(400, 'Unbekannte Einstellung');
    for (const [k, v] of entries) {
      if (SETTING_RULES[k].role === 'admin' && req.user.role !== 'admin') fail(403, 'Nur die Inhaberin kann das ändern');
      if (!SETTING_RULES[k].ok(v)) fail(400, `Ungültiger Wert für ${k}`);
    }
    tx(db, () => { for (const [k, v] of entries) q('UPDATE settings SET value = ? WHERE key = ?').run(String(v), k); });
    res.json(settingsView());
  });

  // Barista scans the member card QR (or types the ID): who is it, and what are they picking up?
  app.get('/api/admin/members/:memberId', staff, (req, res) => {
    const u = q("SELECT * FROM users WHERE member_id = ? AND role = 'customer'").get(String(req.params.memberId).trim().toUpperCase());
    if (!u) fail(404, 'Kein Mitglied mit dieser Nummer');
    const orders = withItems(q(`SELECT * FROM orders WHERE user_id = ? AND status IN ('new','preparing','ready') ORDER BY pickup_at`).all(u.id));
    res.json({ id: u.id, name: u.name, member_id: u.member_id, points: u.points, tier: tierFor(u.lifetime_points), orders });
  });

  // --- staff management (Mitarbeiterverwaltung) ---------------------------------
  const staffRow = ({ password_hash, points, lifetime_points, birthday, ...u }) => ({
    ...u, on_shift: !!q('SELECT 1 FROM shifts WHERE user_id = ? AND clock_out IS NULL').get(u.id),
  });
  const checkWage = (v) => { if (!Number.isInteger(v) || v < 0 || v > 20000) fail(400, 'Stundenlohn in Cent, 0 bis 200 €'); };

  app.get('/api/admin/staff', admin, (req, res) =>
    res.json(q("SELECT * FROM users WHERE role IN ('staff','admin') ORDER BY active DESC, name").all().map(staffRow)));

  // New staff get a temporary password and must choose their own at first login.
  app.post('/api/admin/staff', admin, (req, res) => {
    const { name, email, password, hourly_wage } = req.body;
    checkName(name);
    checkEmail(email);
    checkPassword(password);
    checkWage(hourly_wage);
    if (q('SELECT 1 FROM users WHERE email = ?').get(email)) fail(409, 'E-Mail ist bereits registriert');
    const user = tx(db, () => {
      const { lastInsertRowid } = q(`INSERT INTO users (member_id, name, email, password_hash, role, hourly_wage, must_change_password)
        VALUES (?, ?, ?, ?, 'staff', ?, 1)`).run(nextMemberId(), name.trim(), email.trim(), hashPassword(password), hourly_wage);
      return q('SELECT * FROM users WHERE id = ?').get(lastInsertRowid);
    });
    res.status(201).json(staffRow(user));
  });

  app.patch('/api/admin/staff/:id', admin, (req, res) => {
    const id = Number(req.params.id);
    const fields = Object.keys(req.body);
    if (!fields.length || fields.some((k) => !['hourly_wage', 'active'].includes(k))) fail(400, 'Nur Stundenlohn und Aktiv sind änderbar');
    if ('hourly_wage' in req.body) checkWage(req.body.hourly_wage);
    if ('active' in req.body && ![0, 1].includes(req.body.active)) fail(400, 'active muss 0 oder 1 sein');
    if (id === req.user.id && req.body.active === 0) fail(400, 'Du kannst dein eigenes Konto nicht deaktivieren');
    const updated = tx(db, () => {
      const u = q("SELECT * FROM users WHERE id = ? AND role IN ('staff','admin')").get(id);
      if (!u) fail(404, 'Mitarbeiter nicht gefunden');
      if ('hourly_wage' in req.body) q('UPDATE users SET hourly_wage = ? WHERE id = ?').run(req.body.hourly_wage, id);
      if ('active' in req.body) {
        q('UPDATE users SET active = ? WHERE id = ?').run(req.body.active, id);
        if (req.body.active === 0) { // off the team: sign out everywhere and end a running shift
          q('DELETE FROM sessions WHERE user_id = ?').run(id);
          q('UPDATE shifts SET clock_out = ? WHERE user_id = ? AND clock_out IS NULL').run(new Date().toISOString(), id);
        }
      }
      return q('SELECT * FROM users WHERE id = ?').get(id);
    });
    res.json(staffRow(updated));
  });

  // Every shift in the range with hours and cost (open shifts count up to now), plus totals per person.
  app.get('/api/admin/shifts/list', admin, (req, res) => {
    const days = RANGES[req.query.range];
    if (!days) fail(400, 'range muss day, week oder month sein');
    const now = Date.now();
    const shifts = q(`SELECT s.id, s.user_id, u.name, u.member_id, u.hourly_wage, s.clock_in, s.clock_out
      FROM shifts s JOIN users u ON u.id = s.user_id WHERE s.clock_in >= ? ORDER BY s.clock_in DESC`).all(sinceDays(days))
      .map((s) => {
        const hours = Math.round(((s.clock_out ? Date.parse(s.clock_out) : now) - Date.parse(s.clock_in)) / 36e3) / 100;
        return { ...s, hours, cost_cents: Math.round(hours * s.hourly_wage) };
      });
    const totals = [...new Set(shifts.map((s) => s.user_id))].map((uid) => {
      const mine = shifts.filter((s) => s.user_id === uid);
      return {
        user_id: uid, name: mine[0].name, shifts: mine.length,
        hours: Math.round(mine.reduce((a, s) => a + s.hours, 0) * 100) / 100,
        cost_cents: mine.reduce((a, s) => a + s.cost_cents, 0),
      };
    });
    res.json({ shifts, totals });
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
