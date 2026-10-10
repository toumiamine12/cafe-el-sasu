import { DatabaseSync } from 'node:sqlite';
import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { scryptSync, randomBytes, randomInt, timingSafeEqual } from 'node:crypto';
import { seed, seedModifiers, tagPlantMilk } from './seed.js';
import { usernameBase } from './rules.js';

const SCHEMA = `
CREATE TABLE IF NOT EXISTS users (
  id INTEGER PRIMARY KEY,
  member_id TEXT UNIQUE NOT NULL,
  name TEXT NOT NULL,
  email TEXT UNIQUE NOT NULL COLLATE NOCASE,
  password_hash TEXT NOT NULL,
  points INTEGER NOT NULL DEFAULT 0,
  lifetime_points INTEGER NOT NULL DEFAULT 0,
  role TEXT NOT NULL DEFAULT 'customer' CHECK (role IN ('customer','staff','admin')),
  hourly_wage INTEGER NOT NULL DEFAULT 0,
  birthday TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE TABLE IF NOT EXISTS sessions (
  token TEXT PRIMARY KEY,
  user_id INTEGER NOT NULL REFERENCES users(id),
  expires_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS menu_items (
  id INTEGER PRIMARY KEY,
  name TEXT NOT NULL,
  description TEXT NOT NULL DEFAULT '',
  category TEXT NOT NULL CHECK (category IN ('coffee','cold','cake','pastry')),
  price_cents INTEGER NOT NULL CHECK (price_cents > 0),
  photo TEXT NOT NULL DEFAULT 'photos/logo.png',
  tags TEXT NOT NULL DEFAULT '',
  active INTEGER NOT NULL DEFAULT 1
);
CREATE TABLE IF NOT EXISTS rewards (
  id INTEGER PRIMARY KEY,
  name TEXT NOT NULL,
  cost_points INTEGER NOT NULL,
  category_allowed TEXT NOT NULL,
  birthday_only INTEGER NOT NULL DEFAULT 0
);
CREATE TABLE IF NOT EXISTS orders (
  id INTEGER PRIMARY KEY,
  user_id INTEGER NOT NULL REFERENCES users(id),
  pickup_at TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'new' CHECK (status IN ('new','preparing','ready','picked_up','cancelled')),
  subtotal_cents INTEGER NOT NULL,
  discount_cents INTEGER NOT NULL,
  total_cents INTEGER NOT NULL,
  reward_id INTEGER REFERENCES rewards(id),
  reward_points INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);
CREATE TABLE IF NOT EXISTS order_items (
  id INTEGER PRIMARY KEY,
  order_id INTEGER NOT NULL REFERENCES orders(id),
  menu_item_id INTEGER NOT NULL REFERENCES menu_items(id),
  qty INTEGER NOT NULL,
  unit_price_cents INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS shifts (
  id INTEGER PRIMARY KEY,
  user_id INTEGER NOT NULL REFERENCES users(id),
  clock_in TEXT NOT NULL,
  clock_out TEXT
);
CREATE TABLE IF NOT EXISTS modifier_groups (
  id INTEGER PRIMARY KEY,
  name TEXT NOT NULL,
  kind TEXT NOT NULL CHECK (kind IN ('one','many')),
  required INTEGER NOT NULL DEFAULT 0,
  sort INTEGER NOT NULL DEFAULT 0
);
CREATE TABLE IF NOT EXISTS modifier_options (
  id INTEGER PRIMARY KEY,
  group_id INTEGER NOT NULL REFERENCES modifier_groups(id),
  name TEXT NOT NULL,
  price_cents INTEGER NOT NULL DEFAULT 0 CHECK (price_cents >= 0),
  is_default INTEGER NOT NULL DEFAULT 0,
  sort INTEGER NOT NULL DEFAULT 0
);
CREATE TABLE IF NOT EXISTS menu_item_modifier_groups (
  menu_item_id INTEGER NOT NULL REFERENCES menu_items(id) ON DELETE CASCADE,
  group_id INTEGER NOT NULL REFERENCES modifier_groups(id),
  PRIMARY KEY (menu_item_id, group_id)
);
CREATE TABLE IF NOT EXISTS order_item_modifiers (
  id INTEGER PRIMARY KEY,
  order_item_id INTEGER NOT NULL REFERENCES order_items(id),
  option_id INTEGER REFERENCES modifier_options(id),
  group_name TEXT NOT NULL,
  name TEXT NOT NULL,
  price_cents INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS shift_breaks (
  id INTEGER PRIMARY KEY,
  shift_id INTEGER NOT NULL REFERENCES shifts(id),
  start TEXT NOT NULL,
  end TEXT
);
CREATE TABLE IF NOT EXISTS order_events (
  id INTEGER PRIMARY KEY,
  order_id INTEGER NOT NULL REFERENCES orders(id),
  user_id INTEGER NOT NULL REFERENCES users(id),
  status TEXT NOT NULL,
  at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS planned_shifts (
  id INTEGER PRIMARY KEY,
  user_id INTEGER NOT NULL REFERENCES users(id),
  start TEXT NOT NULL,
  end TEXT NOT NULL,
  note TEXT NOT NULL DEFAULT ''
);
CREATE TABLE IF NOT EXISTS favorites (
  id INTEGER PRIMARY KEY,
  user_id INTEGER NOT NULL REFERENCES users(id),
  menu_item_id INTEGER NOT NULL REFERENCES menu_items(id) ON DELETE CASCADE,
  mods TEXT NOT NULL DEFAULT '[]',
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  UNIQUE (user_id, menu_item_id, mods)
);
CREATE TABLE IF NOT EXISTS bean_subscriptions (
  id INTEGER PRIMARY KEY,
  user_id INTEGER NOT NULL REFERENCES users(id),
  bean TEXT NOT NULL CHECK (bean IN ('espresso','filter','decaf')),
  size TEXT NOT NULL CHECK (size IN ('250g','1kg')),
  every_weeks INTEGER NOT NULL CHECK (every_weeks IN (1,2,4)),
  next_pickup TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active','paused','cancelled')),
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);
CREATE TABLE IF NOT EXISTS gifts (
  id INTEGER PRIMARY KEY,
  code TEXT UNIQUE NOT NULL,
  sender_id INTEGER NOT NULL REFERENCES users(id),
  recipient_name TEXT NOT NULL,
  message TEXT NOT NULL DEFAULT '',
  pay TEXT NOT NULL CHECK (pay IN ('points','counter')),
  points_cost INTEGER NOT NULL DEFAULT 0,
  status TEXT NOT NULL CHECK (status IN ('pending','active','redeemed','cancelled')),
  redeemed_by INTEGER REFERENCES users(id),
  order_id INTEGER REFERENCES orders(id),
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);
CREATE TABLE IF NOT EXISTS bean_sales (
  id INTEGER PRIMARY KEY,
  subscription_id INTEGER REFERENCES bean_subscriptions(id),
  user_id INTEGER NOT NULL REFERENCES users(id),
  bean TEXT NOT NULL,
  size TEXT NOT NULL,
  price_cents INTEGER NOT NULL,
  at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS settings (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL
);
`;

// Columns added after the first release; added in place on older database files.
const LATER_COLUMNS = [
  ['menu_items', 'sold_out', 'INTEGER NOT NULL DEFAULT 0'],
  ['users', 'active', 'INTEGER NOT NULL DEFAULT 1'],
  ['users', 'must_change_password', 'INTEGER NOT NULL DEFAULT 0'],
  ['users', 'preferences', "TEXT NOT NULL DEFAULT '{}'"],
  ['users', 'birthday_changed_at', 'TEXT'],
  ['users', 'username', 'TEXT'],
  ['orders', 'gift_id', 'INTEGER REFERENCES gifts(id)'],
];
const DEFAULT_SETTINGS = { slot_capacity: () => process.env.SLOT_CAPACITY || '5', orders_paused: () => '0', extra_delay_min: () => '0' };

// "vorname.nachname" + 4 random digits, unique.
export function newUsername(db, name) {
  const base = usernameBase(name);
  for (;;) {
    const candidate = `${base}${String(randomInt(1000, 10000))}`;
    if (!db.prepare('SELECT 1 FROM users WHERE username = ?').get(candidate)) return candidate;
  }
}

export function hashPassword(pw) {
  const salt = randomBytes(16).toString('hex');
  return `${salt}:${scryptSync(pw, salt, 32).toString('hex')}`;
}

export function verifyPassword(pw, stored) {
  const [salt, hash] = stored.split(':');
  const expected = Buffer.from(hash || '', 'hex');
  return expected.length === 32 && timingSafeEqual(scryptSync(pw, salt, 32), expected);
}

export function openDb(file = 'data/cafe.db') {
  if (file !== ':memory:') mkdirSync(dirname(file), { recursive: true });
  const db = new DatabaseSync(file);
  db.exec('PRAGMA foreign_keys = ON;' + SCHEMA);
  for (const [table, col, def] of LATER_COLUMNS) {
    if (!db.prepare(`PRAGMA table_info(${table})`).all().some((c) => c.name === col)) db.exec(`ALTER TABLE ${table} ADD COLUMN ${col} ${def}`);
  }
  db.exec(`CREATE UNIQUE INDEX IF NOT EXISTS users_username ON users(username);
    CREATE INDEX IF NOT EXISTS order_items_order ON order_items(order_id);
    CREATE INDEX IF NOT EXISTS order_item_modifiers_item ON order_item_modifiers(order_item_id);
    CREATE INDEX IF NOT EXISTS orders_pickup ON orders(pickup_at);
    CREATE INDEX IF NOT EXISTS orders_user ON orders(user_id);
    CREATE INDEX IF NOT EXISTS shifts_clock_in ON shifts(clock_in);`);
  const setting = db.prepare('INSERT OR IGNORE INTO settings (key, value) VALUES (?, ?)');
  for (const [key, value] of Object.entries(DEFAULT_SETTINGS)) setting.run(key, value());
  if (!db.prepare('SELECT COUNT(*) n FROM menu_items').get().n) seed(db);
  else if (!db.prepare('SELECT COUNT(*) n FROM modifier_groups').get().n) tx(db, () => seedModifiers(db)); // older file: add item options
  if (!db.prepare("SELECT 1 FROM menu_items WHERE (',' || tags || ',') LIKE '%,plant,%'").get()) tx(db, () => tagPlantMilk(db)); // older file: vegan-with-plant-milk tags
  // older file: give every account a username
  for (const u of db.prepare('SELECT id, name FROM users WHERE username IS NULL').all()) db.prepare('UPDATE users SET username = ? WHERE id = ?').run(newUsername(db, u.name), u.id);
  return db;
}

// IMMEDIATE takes the write lock up front, so check-then-insert (e.g. slot capacity) can't race another writer.
export function tx(db, fn) {
  db.exec('BEGIN IMMEDIATE');
  try {
    const r = fn();
    db.exec('COMMIT');
    return r;
  } catch (e) {
    db.exec('ROLLBACK');
    throw e;
  }
}
