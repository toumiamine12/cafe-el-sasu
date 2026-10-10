import express from 'express';
import QRCode from 'qrcode';
import { randomBytes } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { hashPassword, verifyPassword, tx, newUsername } from './db.js';
import { tierFor, isOpenAt, validatePickup, priceOrder, pointsFor, nextChange, validateModifiers, slotStart, SLOT_CAPACITY, netMinutes, breakShortfall, payCents,
  inBirthdayWeek, usualCombo, usualTime, BEAN_PRICES, addWeeks, birthdayTreatOpen,
  berlinTime, vatSplit, businessInsights } from './rules.js';

const SESSION_DAYS = 30;
const PUBLIC = fileURLToPath(new URL('../public', import.meta.url));

class HttpError extends Error {
  constructor(status, message) { super(message); this.status = status; }
}
const fail = (status, message) => { throw new HttpError(status, message); };

const berlinToday = () => new Date().toLocaleDateString('en-CA', { timeZone: 'Europe/Berlin' });
const parsePrefs = (p) => ({ milk: null, vegan_only: false, ...JSON.parse(p || '{}') });
const publicUser = ({ password_hash, ...u }) => ({
  ...u, preferences: parsePrefs(u.preferences), tier: tierFor(u.lifetime_points), birthday_week: inBirthdayWeek(u.birthday, berlinToday()),
});

// Field checks shared by register and profile edit.
const checkName = (v) => { if (typeof v !== 'string' || !v.trim() || v.length > 80) fail(400, 'Name fehlt'); };
const checkEmail = (v) => { if (typeof v !== 'string' || v.length > 120 || !/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(v)) fail(400, 'Ungültige E-Mail'); };
const checkPassword = (v) => { if (typeof v !== 'string' || v.length < 8 || v.length > 200) fail(400, 'Passwort braucht mindestens 8 Zeichen'); };
const checkBirthday = (v) => {
  const ok = typeof v === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(v) && !isNaN(new Date(v)) && new Date(v).toISOString().startsWith(v);
  if (!ok) fail(400, 'Ungültiges Geburtsdatum');
};


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
    if (req.user.must_change_password) return res.status(403).json({ error: 'Bitte legen Sie zuerst Ihr eigenes Passwort fest' });
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
      const { lastInsertRowid } = q('INSERT INTO users (member_id, name, email, password_hash, birthday, birthday_changed_at, username) VALUES (?, ?, ?, ?, ?, ?, ?)')
        .run(nextMemberId(), name.trim(), email.trim(), hashPassword(password), birthday || null, birthday ? new Date().toISOString() : null, newUsername(db, name.trim()));
      return q('SELECT * FROM users WHERE id = ?').get(lastInsertRowid);
    });
    startSession(res, user.id);
    res.status(201).json(publicUser(user));
  });

  app.post('/api/login', (req, res) => {
    const { id, password } = req.body;
    // Member ID, e-mail or username (vorname.nachname1234) — all case-insensitive.
    const user = typeof id === 'string' && q('SELECT * FROM users WHERE member_id = ? OR email = ? OR username = ?').get(id.trim().toUpperCase(), id.trim(), id.trim().toLowerCase());
    const keys = [[`ip:${req.ip}`, 20], [`acct:${user ? user.id : String(id).trim().toLowerCase()}`, 5]];
    if (limiter.blocked(keys)) fail(429, 'Zu viele Fehlversuche. Bitte in 15 Minuten erneut versuchen.');
    if (!user || typeof password !== 'string' || !verifyPassword(password, user.password_hash)) {
      limiter.fail(keys);
      fail(401, 'Mitgliedsnummer/E-Mail oder Passwort falsch');
    }
    if (!user.active) fail(403, 'Dieses Konto ist deaktiviert. Bitte wenden Sie sich an die Inhaberin.');
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
    const { saved_cents, rewards_redeemed, orders } = q(`SELECT COALESCE(SUM(discount_cents), 0) saved_cents, COUNT(reward_id) rewards_redeemed, COUNT(*) orders
      FROM orders WHERE user_id = ? AND status = 'picked_up'`).get(u.id);
    const fav = q(`SELECT m.name FROM order_items oi JOIN orders o ON o.id = oi.order_id JOIN menu_items m ON m.id = oi.menu_item_id
      WHERE o.user_id = ? AND o.status != 'cancelled' GROUP BY m.id ORDER BY SUM(oi.qty) DESC LIMIT 1`).get(u.id);
    return { ...publicUser(u), stats: { saved_cents, rewards_redeemed, orders, favorite: fav?.name ?? null } };
  };

  // 200 + null when logged out, so pages can check login without a console error.
  app.get('/api/me', (req, res) => res.json(req.user ? withStats(req.user) : null));

  // Preferences: { milk: a Milch option name or null, vegan_only: boolean } — both keys, nothing else.
  const checkPrefs = (v) => {
    const ok = v && typeof v === 'object' && !Array.isArray(v) && Object.keys(v).sort().join() === 'milk,vegan_only'
      && typeof v.vegan_only === 'boolean'
      && (v.milk === null || !!q(`SELECT 1 FROM modifier_options o JOIN modifier_groups g ON g.id = o.group_id WHERE g.name = 'Milch' AND o.name = ?`).get(v.milk));
    if (!ok) fail(400, 'Ungültige Vorlieben');
  };
  const PROFILE_FIELDS = { name: checkName, email: checkEmail, birthday: (v) => v === null || checkBirthday(v), preferences: checkPrefs };
  app.patch('/api/me', loggedIn, (req, res) => {
    const fields = Object.entries(req.body);
    if (!fields.length || fields.some(([k]) => !Object.hasOwn(PROFILE_FIELDS, k))) fail(400, 'Nur Name, E-Mail, Geburtstag und Vorlieben sind änderbar');
    for (const [k, v] of fields) PROFILE_FIELDS[k](v);
    const email = req.body.email?.trim();
    if (email && q('SELECT 1 FROM users WHERE email = ? AND id != ?').get(email, req.user.id)) fail(409, 'E-Mail ist bereits registriert');
    const values = fields.map(([k, v]) => (k === 'preferences' ? JSON.stringify(v) : typeof v === 'string' ? v.trim() : v));
    q(`UPDATE users SET ${fields.map(([k]) => `${k} = ?`)} WHERE id = ?`).run(...values, req.user.id);
    if ('birthday' in req.body && req.body.birthday !== req.user.birthday) { // a new birthday only counts for the treat after 30 days
      q('UPDATE users SET birthday_changed_at = ? WHERE id = ?').run(new Date().toISOString(), req.user.id);
    }
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

  // Birthday treat: every member during their birthday week (±3 days), once per birthday (a cancelled order gives it back).
  // Against throwaway accounts: at least one picked-up order, and a birthday entered/changed in the last 30 days doesn't count yet.
  const birthdayTreatFor = (u, r) => {
    if (!inBirthdayWeek(u.birthday, berlinToday())) return false;
    if (u.birthday_changed_at && Date.now() - Date.parse(u.birthday_changed_at) < 30 * 864e5) return false;
    if (!q("SELECT 1 FROM orders WHERE user_id = ? AND status = 'picked_up'").get(u.id)) return false;
    const last = q(`SELECT MAX(created_at) at FROM orders WHERE user_id = ? AND reward_id = ? AND status != 'cancelled'`).get(u.id, r.id).at;
    return birthdayTreatOpen(last);
  };
  const rewardsFor = (u) => q('SELECT * FROM rewards ORDER BY cost_points').all()
    .filter((r) => !r.birthday_only || birthdayTreatFor(u, r));

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
  const giftBack = (giftId) => q("UPDATE gifts SET status = 'active', redeemed_by = NULL, order_id = NULL WHERE id = ?").run(giftId); // order cancelled
  const withItems = (orders) => {
    const items = q(`SELECT oi.*, m.name, m.photo FROM order_items oi JOIN menu_items m ON m.id = oi.menu_item_id WHERE oi.order_id = ?`);
    const mods = q(`SELECT om.option_id, om.group_name, om.name, om.price_cents, COALESCE(mo.is_default, 0) is_default
      FROM order_item_modifiers om LEFT JOIN modifier_options mo ON mo.id = om.option_id WHERE om.order_item_id = ? ORDER BY om.id`);
    return orders.map((o) => ({ ...o, items: items.all(o.id).map((i) => ({ ...i, modifiers: mods.all(i.id) })) }));
  };

  app.post('/api/orders', customer, (req, res) => {
    if (paused()) fail(503, 'Online-Bestellungen sind gerade pausiert. Bitte versuchen Sie es gleich noch einmal.');
    const { items, pickup_at, reward_id, gift_code } = req.body;
    if (reward_id != null && gift_code != null) fail(400, 'Bitte entweder eine Prämie oder einen Gutschein einlösen');
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
      if (bookedIn(pickup) >= capacity()) fail(409, 'Dieses Abholfenster ist ausgebucht. Bitte wählen Sie eine andere Zeit.');
      const user = q('SELECT * FROM users WHERE id = ?').get(req.user.id);
      let reward = null;
      if (reward_id != null) {
        reward = rewardsFor(user).find((r) => r.id === reward_id);
        if (!reward) fail(400, 'Prämie nicht verfügbar');
        if (user.points < reward.cost_points) fail(400, 'Nicht genug Punkte');
      }
      let gift = null;
      if (gift_code != null) {
        gift = q("SELECT * FROM gifts WHERE code = ? AND status = 'active'").get(String(gift_code).trim().toUpperCase());
        if (!gift) fail(400, 'Gutschein ist nicht gültig oder schon eingelöst');
        if (gift.sender_id === user.id) fail(400, 'Eigene Gutscheine können Sie verschenken, aber nicht selbst einlösen');
      }
      let price;
      try {
        // A gift is one coffee of choice: priced like a coffee reward (base free, options charged).
        price = priceOrder(lines, gift ? { category_allowed: 'coffee' } : reward, tierFor(user.lifetime_points).discountPct);
      } catch {
        fail(400, gift ? 'Für den Gutschein fehlt ein Kaffee im Warenkorb' : 'Für diese Prämie fehlt ein passender Artikel im Warenkorb');
      }
      const cost = reward?.cost_points ?? 0;
      const { lastInsertRowid } = q(`INSERT INTO orders (user_id, pickup_at, subtotal_cents, discount_cents, total_cents, reward_id, reward_points, gift_id)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?)`).run(user.id, pickup.toISOString(), price.subtotal, price.discount, price.total, reward?.id ?? null, cost, gift?.id ?? null);
      if (gift) q("UPDATE gifts SET status = 'redeemed', redeemed_by = ?, order_id = ? WHERE id = ?").run(user.id, lastInsertRowid, gift.id);
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
      if (o.gift_id) giftBack(o.gift_id);
    });
    res.json({ ok: true });
  });

  // --- Das Übliche & favorites ----------------------------------------------------
  // Resolve an item + chosen option ids into what the guest sees (names, unit price).
  function comboView(itemId, mods) {
    const item = q('SELECT * FROM menu_items WHERE id = ?').get(itemId);
    if (!item) return null;
    const groups = modifierGroups().get(item.id) ?? [];
    const known = new Set(groups.flatMap((g) => g.options.map((o) => o.id)));
    const chosen = validateModifiers(groups, mods.filter((m) => known.has(m))); // options removed since then are dropped
    return {
      item: { ...item, modifiers: groups }, mods: chosen.map(({ id, name, price_cents, is_default }) => ({ id, name, price_cents, is_default })),
      unit_price_cents: item.price_cents + chosen.reduce((a, o) => a + o.price_cents, 0),
      available: !!item.active && !item.sold_out,
    };
  }

  app.get('/api/me/usual', customer, (req, res) => {
    const rows = q(`SELECT oi.id, oi.menu_item_id, oi.qty, o.created_at at FROM order_items oi JOIN orders o ON o.id = oi.order_id
      WHERE o.user_id = ? AND o.status != 'cancelled'`).all(req.user.id);
    const modsOf = q('SELECT option_id FROM order_item_modifiers WHERE order_item_id = ? AND option_id IS NOT NULL');
    const combo = usualCombo(rows.map((r) => ({ ...r, mods: modsOf.all(r.id).map((m) => m.option_id) })));
    if (!combo) return res.json(null);
    const pickups = q("SELECT pickup_at FROM orders WHERE user_id = ? AND status != 'cancelled'").all(req.user.id).map((o) => o.pickup_at);
    res.json({ ...comboView(combo.menu_item_id, combo.mods), count: combo.count, usual_time: usualTime(pickups) });
  });

  const favMods = (mods) => {
    if (!Array.isArray(mods) || mods.length > 10 || !mods.every(Number.isInteger)) fail(400, 'Ungültige Optionen');
    return [...new Set(mods)].sort((a, b) => a - b);
  };
  app.get('/api/me/favorites', customer, (req, res) =>
    res.json(q('SELECT * FROM favorites WHERE user_id = ? ORDER BY created_at').all(req.user.id)
      .map((f) => ({ id: f.id, ...comboView(f.menu_item_id, JSON.parse(f.mods)) })).filter((f) => f.item)));

  app.post('/api/me/favorites', customer, (req, res) => {
    const { menu_item_id } = req.body;
    const mods = favMods(req.body.mods ?? []);
    const item = Number.isInteger(menu_item_id) && q('SELECT * FROM menu_items WHERE id = ? AND active = 1').get(menu_item_id);
    if (!item) fail(400, 'Artikel nicht verfügbar');
    try { validateModifiers(modifierGroups().get(item.id) ?? [], mods); } catch (e) { fail(400, e.message); }
    const existing = q('SELECT id FROM favorites WHERE user_id = ? AND menu_item_id = ? AND mods = ?').get(req.user.id, item.id, JSON.stringify(mods));
    if (existing) return res.json({ id: existing.id, ...comboView(item.id, mods) });
    const { lastInsertRowid } = q('INSERT INTO favorites (user_id, menu_item_id, mods) VALUES (?, ?, ?)').run(req.user.id, item.id, JSON.stringify(mods));
    res.status(201).json({ id: lastInsertRowid, ...comboView(item.id, mods) });
  });

  app.delete('/api/me/favorites/:id', customer, (req, res) => {
    if (!q('DELETE FROM favorites WHERE id = ? AND user_id = ?').run(Number(req.params.id), req.user.id).changes) fail(404, 'Favorit nicht gefunden');
    res.json({ ok: true });
  });

  // --- bean subscription (pickup reservations) ----------------------------------------
  const beanView = (b) => ({ ...b, price_cents: BEAN_PRICES[b.bean][b.size] });
  app.get('/api/me/beans', customer, (req, res) =>
    res.json(q("SELECT * FROM bean_subscriptions WHERE user_id = ? ORDER BY status = 'cancelled', created_at").all(req.user.id).map(beanView)));

  app.post('/api/me/beans', customer, (req, res) => {
    const { bean, size, every_weeks, first_pickup } = req.body;
    if (!Object.hasOwn(BEAN_PRICES, bean) || !Object.hasOwn(BEAN_PRICES[bean], size)) fail(400, 'Unbekannte Sorte oder Größe');
    if (![1, 2, 4].includes(every_weeks)) fail(400, 'Rhythmus: jede 1, 2 oder 4 Wochen');
    const today = berlinToday();
    const latest = new Date(Date.now() + 60 * 864e5).toISOString().slice(0, 10);
    if (typeof first_pickup !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(first_pickup) || first_pickup <= today || first_pickup > latest) fail(400, 'Erste Abholung: ab morgen, höchstens 60 Tage im Voraus');
    const { lastInsertRowid } = q('INSERT INTO bean_subscriptions (user_id, bean, size, every_weeks, next_pickup) VALUES (?, ?, ?, ?, ?)')
      .run(req.user.id, bean, size, every_weeks, first_pickup);
    res.status(201).json(beanView(q('SELECT * FROM bean_subscriptions WHERE id = ?').get(lastInsertRowid)));
  });

  app.patch('/api/me/beans/:id', customer, (req, res) => {
    const { action } = req.body;
    if (!['skip', 'pause', 'resume', 'cancel'].includes(action)) fail(400, 'Aktion: skip, pause, resume oder cancel');
    const row = tx(db, () => {
      const b = q('SELECT * FROM bean_subscriptions WHERE id = ? AND user_id = ?').get(Number(req.params.id), req.user.id);
      if (!b) fail(404, 'Abo nicht gefunden');
      if (b.status === 'cancelled') fail(409, 'Dieses Abo ist beendet');
      const set = (sql, ...v) => q(`UPDATE bean_subscriptions SET ${sql} WHERE id = ?`).run(...v, b.id);
      if (action === 'skip') set('next_pickup = ?', addWeeks(b.next_pickup, b.every_weeks));
      if (action === 'pause') set("status = 'paused'");
      if (action === 'resume') set("status = 'active'");
      if (action === 'cancel') set("status = 'cancelled'");
      return q('SELECT * FROM bean_subscriptions WHERE id = ?').get(b.id);
    });
    res.json(beanView(row));
  });

  // --- gifts: "Kaffee verschenken" ---------------------------------------------------------
  const GIFT_POINTS = 100;
  const GIFT_PRICE_CENTS = 500;
  const CODE_CHARS = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789'; // no 0/O, 1/I
  const newGiftCode = () => {
    for (;;) {
      const code = 'G-' + [...randomBytes(8)].map((b) => CODE_CHARS[b % CODE_CHARS.length]).join('');
      if (!q('SELECT 1 FROM gifts WHERE code = ?').get(code)) return code;
    }
  };
  const giftView = (g) => ({ ...g, price_cents: g.pay === 'counter' ? GIFT_PRICE_CENTS : 0 });
  const giftByCode = (code) => q('SELECT * FROM gifts WHERE code = ?').get(String(code).trim().toUpperCase());

  app.post('/api/gifts', customer, (req, res) => {
    const { recipient_name, message = '', pay } = req.body;
    if (typeof recipient_name !== 'string' || !recipient_name.trim() || recipient_name.length > 40) fail(400, 'Für wen ist der Gutschein?');
    if (typeof message !== 'string' || message.length > 200) fail(400, 'Nachricht höchstens 200 Zeichen');
    if (!['points', 'counter'].includes(pay)) fail(400, 'Bezahlen mit Punkten oder an der Theke');
    const gift = tx(db, () => {
      if (pay === 'points') {
        if (q('SELECT points FROM users WHERE id = ?').get(req.user.id).points < GIFT_POINTS) fail(400, `Dafür benötigen Sie ${GIFT_POINTS} Punkte`);
        q('UPDATE users SET points = points - ? WHERE id = ?').run(GIFT_POINTS, req.user.id);
      }
      const { lastInsertRowid } = q(`INSERT INTO gifts (code, sender_id, recipient_name, message, pay, points_cost, status) VALUES (?, ?, ?, ?, ?, ?, ?)`)
        .run(newGiftCode(), req.user.id, recipient_name.trim(), message.trim(), pay, pay === 'points' ? GIFT_POINTS : 0, pay === 'points' ? 'active' : 'pending');
      return q('SELECT * FROM gifts WHERE id = ?').get(lastInsertRowid);
    });
    res.status(201).json(giftView(gift));
  });

  app.get('/api/me/gifts', customer, (req, res) =>
    res.json(q('SELECT * FROM gifts WHERE sender_id = ? ORDER BY created_at DESC').all(req.user.id).map(giftView)));

  app.post('/api/gifts/:code/cancel', customer, (req, res) => {
    const g = tx(db, () => {
      const gift = giftByCode(req.params.code);
      if (!gift || gift.sender_id !== req.user.id) fail(404, 'Gutschein nicht gefunden');
      if (!['pending', 'active'].includes(gift.status)) fail(409, 'Dieser Gutschein ist schon eingelöst oder storniert');
      q("UPDATE gifts SET status = 'cancelled' WHERE id = ?").run(gift.id);
      if (gift.points_cost) q('UPDATE users SET points = points + ? WHERE id = ?').run(gift.points_cost, gift.sender_id);
      return q('SELECT * FROM gifts WHERE id = ?').get(gift.id);
    });
    res.json(giftView(g));
  });

  // Public: what the friend sees when opening the link (no ids, no emails).
  app.get('/api/gifts/:code', (req, res) => {
    const g = giftByCode(req.params.code);
    if (!g) fail(404, 'Gutschein nicht gefunden');
    const from = q('SELECT name FROM users WHERE id = ?').get(g.sender_id).name.split(' ')[0];
    res.json({ from, recipient_name: g.recipient_name, message: g.message, status: g.status });
  });

  app.get('/api/gifts/:code/qr', async (req, res, next) => {
    try {
      const g = giftByCode(req.params.code);
      if (!g) fail(404, 'Gutschein nicht gefunden');
      const url = `${req.protocol}://${req.get('host')}/#/gutschein?c=${g.code}`;
      res.type('image/svg+xml').send(await QRCode.toString(url, { type: 'svg', margin: 1, color: { dark: '#3b2615', light: '#ffffff' } }));
    } catch (e) { next(e); }
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
      q('INSERT INTO order_events (order_id, user_id, status, at) VALUES (?, ?, ?, ?)').run(o.id, req.user.id, status, new Date().toISOString());
      if (status === 'picked_up') {
        const pts = pointsFor(o.total_cents);
        q('UPDATE users SET points = points + ?, lifetime_points = lifetime_points + ? WHERE id = ?').run(pts, pts, o.user_id);
      }
      if (status === 'cancelled' && o.reward_points) q('UPDATE users SET points = points + ? WHERE id = ?').run(o.reward_points, o.user_id);
      if (status === 'cancelled' && o.gift_id) giftBack(o.gift_id);
    });
    res.json({ ok: true });
  });

  app.post('/api/admin/shifts/clock', staff, (req, res) => {
    const open = tx(db, () => {
      const s = q('SELECT id FROM shifts WHERE user_id = ? AND clock_out IS NULL').get(req.user.id);
      const now = new Date().toISOString();
      if (s) {
        q('UPDATE shift_breaks SET end = ? WHERE shift_id = ? AND end IS NULL').run(now, s.id); // clocking out ends a break
        q('UPDATE shifts SET clock_out = ? WHERE id = ?').run(now, s.id);
      }
      else q('INSERT INTO shifts (user_id, clock_in) VALUES (?, ?)').run(req.user.id, now);
      return !s;
    });
    res.json({ open });
  });

  // --- work time: net minutes (breaks are unpaid), pay, history -------------------------
  const sinceDays = (d) => new Date(Date.now() - d * 864e5).toISOString();
  const breaksOf = (shiftId) => q('SELECT start, end FROM shift_breaks WHERE shift_id = ? ORDER BY start').all(shiftId);
  const round2 = (x) => Math.round(x * 100) / 100;
  // One shift with breaks, net minutes/hours and pay at the person's wage.
  function shiftDetail(sh, now = new Date()) {
    const breaks = breaksOf(sh.id);
    const net = netMinutes(sh.clock_in, sh.clock_out, breaks, now);
    const breakMin = breaks.reduce((a, b) => a + (Date.parse(b.end ?? now.toISOString()) - Date.parse(b.start)) / 60e3, 0);
    return { ...sh, break_minutes: Math.round(breakMin), net_minutes: Math.round(net), hours: round2(net / 60), pay_cents: payCents(net, sh.hourly_wage) };
  }
  const shiftsSince = (since, userId) => q(`SELECT s.id, s.user_id, u.name, u.member_id, u.hourly_wage, s.clock_in, s.clock_out
    FROM shifts s JOIN users u ON u.id = s.user_id WHERE s.clock_in >= ? ${userId ? 'AND s.user_id = ?' : ''} ORDER BY s.clock_in DESC`)
    .all(...(userId ? [since, userId] : [since])).map((sh) => shiftDetail(sh));
  const netHoursSince = (since, userId) => round2(shiftsSince(since, userId).reduce((a, sh) => a + sh.net_minutes, 0) / 60);

  app.get('/api/admin/shifts', staff, (req, res) => {
    const people = req.user.role === 'admin'
      ? q("SELECT * FROM users WHERE role IN ('staff','admin') ORDER BY name").all()
      : [req.user];
    res.json(people.map((u) => ({
      id: u.id, name: u.name, member_id: u.member_id, role: u.role, hourly_wage: u.hourly_wage,
      open: !!q('SELECT 1 FROM shifts WHERE user_id = ? AND clock_out IS NULL').get(u.id),
      hours_week: netHoursSince(sinceDays(7), u.id),
      hours_month: netHoursSince(sinceDays(30), u.id),
    })));
  });

  // Start or end a break on your own running shift.
  app.post('/api/admin/shifts/break', staff, (req, res) => {
    const onBreak = tx(db, () => {
      const sh = q('SELECT id FROM shifts WHERE user_id = ? AND clock_out IS NULL').get(req.user.id);
      if (!sh) fail(409, 'Sie sind nicht eingestempelt');
      const open = q('SELECT id FROM shift_breaks WHERE shift_id = ? AND end IS NULL').get(sh.id);
      const now = new Date().toISOString();
      if (open) q('UPDATE shift_breaks SET end = ? WHERE id = ?').run(now, open.id);
      else q('INSERT INTO shift_breaks (shift_id, start) VALUES (?, ?)').run(sh.id, now);
      return !open;
    });
    res.json({ on_break: onBreak });
  });

  // Everything "Meine Zeit" shows: running shift, stats, 14 daily totals, history, upcoming rota shifts.
  const berlinDate = new Intl.DateTimeFormat('en-CA', { timeZone: 'Europe/Berlin' });
  app.get('/api/admin/me/work', staff, (req, res) => {
    const me = req.user;
    const now = new Date();
    const open = q(`SELECT s.id, s.user_id, s.clock_in, s.clock_out, ? hourly_wage FROM shifts s WHERE s.user_id = ? AND s.clock_out IS NULL`).get(me.hourly_wage, me.id);
    let current = null;
    if (open) {
      const d = shiftDetail(open, now);
      current = {
        shift_id: open.id, clock_in: open.clock_in, worked_minutes: d.net_minutes, break_minutes: d.break_minutes,
        on_break: !!q('SELECT 1 FROM shift_breaks WHERE shift_id = ? AND end IS NULL').get(open.id),
        break_shortfall: breakShortfall(d.net_minutes, d.break_minutes),
      };
    }
    const monthStart = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1)).toISOString();
    const month = shiftsSince(monthStart, me.id);
    const handled = (since) => q('SELECT COUNT(DISTINCT order_id) n FROM order_events WHERE user_id = ? AND at >= ?').get(me.id, since).n;
    const recent = shiftsSince(sinceDays(60), me.id);
    const daily = Array.from({ length: 14 }, (_, i) => {
      const date = berlinDate.format(new Date(now.getTime() - (13 - i) * 864e5));
      const mins = recent.filter((sh) => berlinDate.format(new Date(sh.clock_in)) === date).reduce((a, sh) => a + sh.net_minutes, 0);
      return { date, hours: round2(mins / 60) };
    });
    const upcoming = q('SELECT id, start, end, note FROM planned_shifts WHERE user_id = ? AND end >= ? AND start < ? ORDER BY start')
      .all(me.id, now.toISOString(), new Date(now.getTime() + 14 * 864e5).toISOString());
    res.json({
      current,
      wage_cents: me.hourly_wage,
      stats: {
        week_hours: netHoursSince(sinceDays(7), me.id),
        month_hours: round2(month.reduce((a, sh) => a + sh.net_minutes, 0) / 60),
        month_pay_cents: month.reduce((a, sh) => a + sh.pay_cents, 0),
        orders_week: handled(sinceDays(7)),
        orders_month: handled(monthStart),
      },
      daily,
      shifts: recent.map(({ hourly_wage, ...sh }) => sh),
      upcoming,
    });
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
    const wages = shiftsSince(since).reduce((a, sh) => a + sh.pay_cents, 0); // breaks are unpaid
    const top = q(`SELECT m.name, SUM(oi.qty) qty FROM order_items oi JOIN orders o ON o.id = oi.order_id JOIN menu_items m ON m.id = oi.menu_item_id
      WHERE o.status = 'picked_up' AND o.pickup_at >= ? GROUP BY m.id ORDER BY qty DESC LIMIT 5`).all(since);
    res.json({ revenue, wages, profit: revenue - wages, orders, top });
  });

  const TAGS = ['vegan', 'plant', 'gluten', 'nuts', 'lactose']; // plant = vegan with oat/almond milk
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

  // --- staff: bean bags due, gifts paid at the counter --------------------------------
  app.get('/api/admin/beans', staff, (req, res) => {
    const days = Number(req.query.days ?? 7);
    if (!Number.isInteger(days) || days < 0 || days > 60) fail(400, 'days=0..60');
    const until = new Date(Date.parse(`${berlinToday()}T00:00:00Z`) + days * 864e5).toISOString().slice(0, 10);
    res.json(q(`SELECT b.*, u.name, u.member_id FROM bean_subscriptions b JOIN users u ON u.id = b.user_id
      WHERE b.status = 'active' AND b.next_pickup <= ? ORDER BY b.next_pickup, u.name`).all(until).map(beanView));
  });

  app.post('/api/admin/beans/:id/handed', staff, (req, res) => {
    const row = tx(db, () => {
      const b = q("SELECT * FROM bean_subscriptions WHERE id = ? AND status = 'active'").get(Number(req.params.id));
      if (!b) fail(409, 'Kein aktives Abo');
      q('UPDATE bean_subscriptions SET next_pickup = ? WHERE id = ?').run(addWeeks(b.next_pickup, b.every_weeks), b.id);
      q('INSERT INTO bean_sales (subscription_id, user_id, bean, size, price_cents, at) VALUES (?, ?, ?, ?, ?, ?)')
        .run(b.id, b.user_id, b.bean, b.size, BEAN_PRICES[b.bean][b.size], new Date().toISOString()); // counts as revenue
      return q('SELECT * FROM bean_subscriptions WHERE id = ?').get(b.id);
    });
    res.json(beanView(row));
  });

  app.get('/api/admin/gifts/:code', staff, (req, res) => {
    const g = giftByCode(req.params.code);
    if (!g) fail(404, 'Gutschein nicht gefunden');
    res.json({ ...giftView(g), sender: q('SELECT name, member_id FROM users WHERE id = ?').get(g.sender_id) });
  });

  // Paid at the counter → staff switch the gift on.
  app.post('/api/admin/gifts/:code/activate', staff, (req, res) => {
    const g = tx(db, () => {
      const gift = giftByCode(req.params.code);
      if (!gift) fail(404, 'Gutschein nicht gefunden');
      if (gift.status !== 'pending') fail(409, 'Dieser Gutschein ist nicht offen');
      q("UPDATE gifts SET status = 'active' WHERE id = ?").run(gift.id);
      return q('SELECT * FROM gifts WHERE id = ?').get(gift.id);
    });
    res.json(giftView(g));
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
      const { lastInsertRowid } = q(`INSERT INTO users (member_id, name, email, password_hash, role, hourly_wage, must_change_password, username)
        VALUES (?, ?, ?, ?, 'staff', ?, 1, ?)`).run(nextMemberId(), name.trim(), email.trim(), hashPassword(password), hourly_wage, newUsername(db, name.trim()));
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
    if (id === req.user.id && req.body.active === 0) fail(400, 'Sie können Ihr eigenes Konto nicht deaktivieren');
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
    const shifts = shiftsSince(sinceDays(days)).map((sh) => ({ ...sh, cost_cents: sh.pay_cents }));
    const totals = [...new Set(shifts.map((s) => s.user_id))].map((uid) => {
      const mine = shifts.filter((s) => s.user_id === uid);
      return {
        user_id: uid, name: mine[0].name, shifts: mine.length,
        hours: round2(mine.reduce((a, s) => a + s.net_minutes, 0) / 60),
        cost_cents: mine.reduce((a, s) => a + s.cost_cents, 0),
      };
    });
    res.json({ shifts, totals });
  });

  // --- Finanzen analytics -------------------------------------------------------------------
  const CAT_LABEL = { coffee: 'Kaffee', cold: 'Kaltgetränke', cake: 'Kuchen', pastry: 'Gebäck', beans: 'Kaffeebohnen' };
  const FOOD = new Set(['cake', 'pastry', 'beans']); // 7 % VAT; drinks 19 %
  const WEEKDAY = ['Sonntag', 'Montag', 'Dienstag', 'Mittwoch', 'Donnerstag', 'Freitag', 'Samstag'];
  const WALKIN_EMAIL = 'gast@cafe-elsasu.de';
  // Cached formatters: toLocaleString with a timeZone builds a new one per call (seconds for a month of orders).
  const HOUR_FMT = new Intl.DateTimeFormat('en-US', { timeZone: 'Europe/Berlin', hour: 'numeric', hourCycle: 'h23' });
  const DAY_FMT = new Intl.DateTimeFormat('en-CA', { timeZone: 'Europe/Berlin' });
  const berlinHourOf = (iso) => Number(HOUR_FMT.format(new Date(iso)));
  const berlinDayOf = (iso) => DAY_FMT.format(new Date(iso));
  const plusDays = (date, n) => new Date(Date.parse(`${date}T12:00:00Z`) + n * 864e5).toISOString().slice(0, 10);
  const isDate = (v) => typeof v === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(v) && !isNaN(Date.parse(v)) && new Date(v).toISOString().startsWith(v);

  // Split `total` into parts proportional to `weights`, rounding so the parts add up exactly.
  function allocate(total, weights) {
    const sum = weights.reduce((a, w) => a + w, 0);
    if (!sum) return weights.map(() => 0);
    const raw = weights.map((w) => (total * w) / sum);
    const out = raw.map(Math.floor);
    let left = total - out.reduce((a, x) => a + x, 0);
    raw.map((r, i) => [r - Math.floor(r), i]).sort((a, b) => b[0] - a[0]).forEach(([, i]) => { if (left-- > 0) out[i]++; });
    return out;
  }

  function parseRange(qs) {
    const today = berlinToday();
    let from, to;
    if (qs.from || qs.to) {
      ({ from, to } = qs);
      if (!isDate(from) || !isDate(to) || to < from) fail(400, 'Zeitraum: from und to als JJJJ-MM-TT, from ≤ to');
      if ((Date.parse(to) - Date.parse(from)) / 864e5 > 91) fail(400, 'Höchstens 92 Tage auf einmal');
    } else {
      const days = { day: 1, week: 7, month: 30 }[qs.range];
      if (!days) fail(400, 'range: day, week oder month – oder from/to');
      from = plusDays(today, 1 - days);
      to = today;
    }
    const days = Math.round((Date.parse(to) - Date.parse(from)) / 864e5) + 1;
    return { from, to, days, from_utc: berlinTime(from, 0).toISOString(), to_utc: berlinTime(plusDays(to, 1), 0).toISOString() };
  }

  function analytics(range) {
    const { from_utc, to_utc } = range;
    const orders = q(`SELECT o.*, u.email FROM orders o JOIN users u ON u.id = o.user_id
      WHERE o.status = 'picked_up' AND o.pickup_at >= ? AND o.pickup_at < ?`).all(from_utc, to_utc);
    const itemsOf = q(`SELECT oi.*, m.name, m.category FROM order_items oi JOIN menu_items m ON m.id = oi.menu_item_id WHERE oi.order_id = ?`);
    const modsOf = q('SELECT name, group_name, price_cents FROM order_item_modifiers WHERE order_item_id = ?');
    const beans = q('SELECT * FROM bean_sales WHERE at >= ? AND at < ?').all(from_utc, to_utc);
    const shifts = q(`SELECT s.id, s.user_id, u.hourly_wage, s.clock_in, s.clock_out FROM shifts s JOIN users u ON u.id = s.user_id
      WHERE s.clock_in >= ? AND s.clock_in < ?`).all(from_utc, to_utc).map((sh) => shiftDetail(sh));

    // Per item line: what was actually paid (order discounts spread over the lines by value).
    const lines = [];
    for (const o of orders) {
      const its = itemsOf.all(o.id);
      const paid = allocate(o.total_cents, its.map((i) => i.unit_price_cents * i.qty));
      its.forEach((i, k) => lines.push({ ...i, paid: paid[k], order: o, mods: modsOf.all(i.id) }));
    }
    const hourly = range.days === 1;
    const bucket = (iso) => (hourly ? berlinHourOf(iso) : berlinDayOf(iso));
    const keys = hourly ? Array.from({ length: 11 }, (_, i) => 9 + i) : Array.from({ length: range.days }, (_, i) => plusDays(range.from, i));
    const timeline = keys.map((key) => ({ key, revenue_cents: 0, labor_cents: 0, orders: 0 }));
    const slot = (key) => timeline.find((t) => t.key === key) ?? timeline[hourly ? (key < 9 ? 0 : timeline.length - 1) : 0];
    for (const o of orders) { const t = slot(bucket(o.pickup_at)); t.revenue_cents += o.total_cents; t.orders++; }
    for (const b of beans) slot(bucket(b.at)).revenue_cents += b.price_cents;
    for (const sh of shifts) slot(bucket(sh.clock_in)).labor_cents += sh.pay_cents;

    const gross = orders.reduce((a, o) => a + o.total_cents, 0) + beans.reduce((a, b) => a + b.price_cents, 0);
    const labor = shifts.reduce((a, sh) => a + sh.pay_cents, 0);
    const byCat = Object.fromEntries(Object.keys(CAT_LABEL).map((c) => [c, 0]));
    for (const l of lines) byCat[l.category] += l.paid;
    byCat.beans += beans.reduce((a, b) => a + b.price_cents, 0);

    const perItem = new Map();
    for (const l of lines) {
      const it = perItem.get(l.menu_item_id) ?? { name: l.name, qty: 0, revenue_cents: 0 };
      it.qty += l.qty;
      it.revenue_cents += l.paid;
      perItem.set(l.menu_item_id, it);
    }
    const slow = q('SELECT id, name FROM menu_items WHERE active = 1').all()
      .map((m) => ({ name: m.name, qty: perItem.get(m.id)?.qty ?? 0 })).sort((a, b) => a.qty - b.qty || a.name.localeCompare(b.name)).slice(0, 5);
    const mods = new Map();
    let milkDrinks = 0, plant = 0;
    for (const l of lines) {
      for (const m of l.mods) {
        if (m.group_name === 'Milch') { milkDrinks += l.qty; if (['Hafermilch', 'Mandelmilch'].includes(m.name)) plant += l.qty; }
        if (!m.price_cents) continue;
        const x = mods.get(m.name) ?? { name: m.name, count: 0, revenue_cents: 0 };
        x.count += l.qty;
        x.revenue_cents += m.price_cents * l.qty;
        mods.set(m.name, x);
      }
    }
    const weekdays = WEEKDAY.map((day) => ({ day, revenue_cents: 0 }));
    for (const o of orders) weekdays[new Date(berlinTime(berlinDayOf(o.pickup_at), 12)).getUTCDay()].revenue_cents += o.total_cents;
    const hours = Array.from({ length: 11 }, (_, i) => ({ hour: 9 + i, orders: orders.filter((o) => berlinHourOf(o.pickup_at) === 9 + i).length }));
    const walkin = orders.filter((o) => o.email === WALKIN_EMAIL).length;
    const ordersRevenue = orders.reduce((a, o) => a + o.total_cents, 0);
    const result = {
      range,
      kpi: {
        gross_cents: gross, labor_cents: labor, net_cents: gross - labor, labor_ratio: gross ? labor / gross : 0,
        orders: orders.length, avg_ticket_cents: orders.length ? Math.round(ordersRevenue / orders.length) : 0,
        discounts_cents: orders.reduce((a, o) => a + o.discount_cents, 0),
        rewards: orders.filter((o) => o.reward_id).length, gifts: orders.filter((o) => o.gift_id).length,
      },
      timeline: timeline.map(({ key, ...t }) => ({ [hourly ? 'hour' : 'date']: key, ...t })),
      hours,
      categories: Object.entries(byCat).map(([c, cents]) => ({ category: c, label: CAT_LABEL[c], revenue_cents: cents, share: gross ? cents / gross : 0 })),
      top_items: [...perItem.values()].sort((a, b) => b.revenue_cents - a.revenue_cents).slice(0, 10),
      slow_items: slow,
      modifiers: [...mods.values()].sort((a, b) => b.count - a.count).slice(0, 8),
      plant_share: milkDrinks ? plant / milkDrinks : 0,
      channels: { online: orders.length - walkin, walkin },
      weekdays,
      vat: vatSplit({
        food: Object.entries(byCat).filter(([c]) => FOOD.has(c)).reduce((a, [, v]) => a + v, 0),
        drinks: Object.entries(byCat).filter(([c]) => !FOOD.has(c)).reduce((a, [, v]) => a + v, 0),
      }),
    };
    result.insights = businessInsights(result);
    return result;
  }

  app.get('/api/admin/analytics', admin, (req, res) => res.json(analytics(parseRange(req.query))));

  // "Tagesabschluss / Bericht": summary + one row per day, for Excel (; separated, decimal comma).
  app.get('/api/admin/report.csv', admin, (req, res) => {
    const range = parseRange(req.query);
    const a = analytics(range);
    const daily = range.days === 1 ? [{ date: range.from, revenue_cents: a.kpi.gross_cents, labor_cents: a.kpi.labor_cents, orders: a.kpi.orders }] : a.timeline;
    const eur = (c) => (c / 100).toFixed(2).replace('.', ',');
    const v = a.vat;
    const rows = [
      ['Zeitraum', `${range.from} bis ${range.to}`],
      ['Brutto-Umsatz', eur(a.kpi.gross_cents)],
      ['Netto-Umsatz', eur(v.reduced.net + v.standard.net), 'ohne MwSt'],
      ['MwSt 7 %', eur(v.reduced.vat), 'Kuchen, Gebäck, Kaffeebohnen'],
      ['MwSt 19 %', eur(v.standard.vat), 'Getränke'],
      ['Personalkosten', eur(a.kpi.labor_cents)],
      ['Personalkostenquote', `${Math.round(a.kpi.labor_ratio * 100)} %`],
      ['Ergebnis', eur(a.kpi.net_cents), 'Umsatz minus Personalkosten'],
      ['Bestellungen', a.kpi.orders],
      ['Durchschnittlicher Bestellwert', eur(a.kpi.avg_ticket_cents)],
      ['Rabatte & Prämien', eur(a.kpi.discounts_cents)],
      ['Hinweis', 'MwSt-Aufteilung ist eine Schätzung – bitte mit dem Steuerberater abstimmen'],
      [],
      ['Datum', 'Umsatz', 'Personalkosten', 'Ergebnis', 'Bestellungen'],
      ...daily.map((d) => [d.date, eur(d.revenue_cents), eur(d.labor_cents), eur(d.revenue_cents - d.labor_cents), d.orders]),
    ];
    res.type('text/csv; charset=utf-8').set('Content-Disposition', `attachment; filename="bericht-${range.from}-bis-${range.to}.csv"`)
      .send('\uFEFF' + rows.map((r) => r.map(csvCell).join(';')).join('\r\n') + '\r\n');
  });

  // --- payroll export (CSV for the payroll office / Excel) -------------------------
  const fmtDay = new Intl.DateTimeFormat('de-DE', { timeZone: 'Europe/Berlin', day: '2-digit', month: '2-digit', year: 'numeric' });
  const fmtTime = new Intl.DateTimeFormat('de-DE', { timeZone: 'Europe/Berlin', hour: '2-digit', minute: '2-digit' });
  const de = (n, digits = 2) => n.toFixed(digits).replace('.', ','); // German decimal comma
  // Text that starts like a formula (= + - @) gets a leading ' so Excel shows it instead of running it.
  const csvCell = (v) => {
    let t = String(v);
    if (/^[=+\-@\t\r]/.test(t) && !/^-[\d.]+(,\d+)?$/.test(t)) t = `'${t}`; // plain negative amounts stay numbers
    return /[;"\r\n]/.test(t) ? `"${t.replace(/"/g, '""')}"` : t;
  };

  app.get('/api/admin/payroll.csv', admin, (req, res) => {
    const month = String(req.query.month ?? '');
    if (!/^\d{4}-(0[1-9]|1[0-2])$/.test(month)) fail(400, 'month im Format JJJJ-MM');
    const [y, m] = month.split('-').map(Number);
    const from = new Date(Date.UTC(y, m - 1, 1)).toISOString();
    const to = new Date(Date.UTC(y, m, 1)).toISOString();
    const shifts = q(`SELECT s.id, s.user_id, u.name, u.member_id, u.hourly_wage, s.clock_in, s.clock_out FROM shifts s JOIN users u ON u.id = s.user_id
      WHERE s.clock_in >= ? AND s.clock_in < ? AND s.clock_out IS NOT NULL ORDER BY u.name, u.id, s.clock_in`).all(from, to).map((sh) => shiftDetail(sh));
    const rows = [['Name', 'Mitgliedsnr', 'Datum', 'Beginn', 'Ende', 'Pause (min)', 'Netto-Stunden', 'Stundenlohn', 'Lohn']];
    for (const userId of [...new Set(shifts.map((sh) => sh.user_id))]) { // per person, not per name: names can repeat
      const mine = shifts.filter((sh) => sh.user_id === userId);
      const { name } = mine[0];
      for (const sh of mine) {
        rows.push([sh.name, sh.member_id, fmtDay.format(new Date(sh.clock_in)), fmtTime.format(new Date(sh.clock_in)), fmtTime.format(new Date(sh.clock_out)),
          sh.break_minutes, de(sh.net_minutes / 60), de(sh.hourly_wage / 100), de(sh.pay_cents / 100)]);
      }
      rows.push([`Summe ${name}`, '', '', '', '', mine.reduce((a, sh) => a + sh.break_minutes, 0),
        de(mine.reduce((a, sh) => a + sh.net_minutes, 0) / 60), '', de(mine.reduce((a, sh) => a + sh.pay_cents, 0) / 100)]);
    }
    res.type('text/csv; charset=utf-8')
      .set('Content-Disposition', `attachment; filename="lohn-${month}.csv"`)
      .send('\uFEFF' + rows.map((r) => r.map(csvCell).join(';')).join('\r\n') + '\r\n');
  });

  // --- rota (Dienstplan) ---------------------------------------------------------------
  const isIso = (v) => typeof v === 'string' && /^\d{4}-\d{2}-\d{2}T/.test(v) && !isNaN(Date.parse(v));

  app.get('/api/admin/rota', staff, (req, res) => {
    const from = String(req.query.from ?? '');
    const days = Number(req.query.days ?? 7);
    if (!/^\d{4}-\d{2}-\d{2}$/.test(from) || isNaN(Date.parse(from)) || !Number.isInteger(days) || days < 1 || days > 31) fail(400, 'from=JJJJ-MM-TT, days=1..31');
    // A few hours of margin: days are Berlin days, timestamps are UTC.
    const start = new Date(Date.parse(from) - 3 * 3600e3).toISOString();
    const end = new Date(Date.parse(from) + days * 864e5 + 3 * 3600e3).toISOString();
    res.json(q(`SELECT p.*, u.name, u.member_id, EXISTS(SELECT 1 FROM shifts s WHERE s.user_id = p.user_id AND s.clock_out IS NULL) on_shift
      FROM planned_shifts p JOIN users u ON u.id = p.user_id WHERE p.start >= ? AND p.start < ? ORDER BY p.start`).all(start, end));
  });

  app.post('/api/admin/rota', admin, (req, res) => {
    const { user_id, start, end, note = '' } = req.body;
    if (!isIso(start) || !isIso(end)) fail(400, 'Beginn und Ende als Zeitpunkt angeben');
    const minutes = (Date.parse(end) - Date.parse(start)) / 60e3;
    if (minutes <= 0) fail(400, 'Ende muss nach dem Beginn liegen');
    if (minutes > 12 * 60) fail(400, 'Eine Schicht darf höchstens 12 Stunden dauern');
    if (typeof note !== 'string' || note.length > 80) fail(400, 'Notiz höchstens 80 Zeichen');
    const row = tx(db, () => {
      if (!Number.isInteger(user_id) || !q("SELECT 1 FROM users WHERE id = ? AND role IN ('staff','admin') AND active = 1").get(user_id)) fail(400, 'Unbekannter Mitarbeiter');
      const s0 = new Date(start).toISOString();
      const e0 = new Date(end).toISOString();
      if (q('SELECT 1 FROM planned_shifts WHERE user_id = ? AND start < ? AND end > ?').get(user_id, e0, s0)) fail(409, 'Überschneidet sich mit einer anderen Schicht dieser Person');
      const { lastInsertRowid } = q('INSERT INTO planned_shifts (user_id, start, end, note) VALUES (?, ?, ?, ?)').run(user_id, s0, e0, note.trim());
      return q('SELECT * FROM planned_shifts WHERE id = ?').get(lastInsertRowid);
    });
    res.status(201).json(row);
  });

  app.delete('/api/admin/rota/:id', admin, (req, res) => {
    if (!q('DELETE FROM planned_shifts WHERE id = ?').run(Number(req.params.id)).changes) fail(404, 'Schicht nicht gefunden');
    res.json({ ok: true });
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
