import { test } from 'node:test';
import assert from 'node:assert/strict';
import { openDb, verifyPassword } from '../server/db.js';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

process.env.ADMIN_PASSWORD = 'admin123';
process.env.STAFF_PASSWORD = 'staff123';

test('openDb seeds menu, users and history', () => {
  const db = openDb(':memory:');
  assert.ok(db.prepare('SELECT COUNT(*) n FROM menu_items WHERE active = 1').get().n >= 49);
  const admin = db.prepare("SELECT * FROM users WHERE member_id = 'SASU-1000'").get();
  assert.equal(admin.role, 'admin');
  assert.ok(db.prepare("SELECT COUNT(*) n FROM orders WHERE status = 'picked_up'").get().n > 0);
  assert.ok(db.prepare('SELECT COUNT(*) n FROM shifts').get().n > 0);
});

test('verifyPassword checks scrypt hashes', () => {
  const db = openDb(':memory:');
  const admin = db.prepare("SELECT * FROM users WHERE member_id = 'SASU-1000'").get();
  assert.equal(verifyPassword('admin123', admin.password_hash), true);
  assert.equal(verifyPassword('wrong', admin.password_hash), false);
});

test('without env passwords, staff/admin get random ones, not admin123', () => {
  const saved = [process.env.ADMIN_PASSWORD, process.env.STAFF_PASSWORD];
  delete process.env.ADMIN_PASSWORD; delete process.env.STAFF_PASSWORD;
  const log = console.log; console.log = () => {};
  try {
    const db = openDb(':memory:');
    const admin = db.prepare("SELECT * FROM users WHERE member_id = 'SASU-1000'").get();
    const staff = db.prepare("SELECT * FROM users WHERE member_id = 'SASU-1001'").get();
    assert.equal(verifyPassword('admin123', admin.password_hash), false);
    assert.equal(verifyPassword('staff123', staff.password_hash), false);
  } finally {
    console.log = log;
    [process.env.ADMIN_PASSWORD, process.env.STAFF_PASSWORD] = saved;
  }
});

test('an older database without item options gets them on start', () => {
  const dir = mkdtempSync(join(tmpdir(), 'cafe-'));
  const file = join(dir, 'cafe.db');
  try {
    const old = openDb(file);
    // simulate a file created before item options existed
    old.exec('DELETE FROM menu_item_modifier_groups; DELETE FROM order_item_modifiers; DELETE FROM modifier_options; DELETE FROM modifier_groups;');
    old.close();
    const db = openDb(file);
    assert.ok(db.prepare('SELECT COUNT(*) n FROM modifier_groups').get().n >= 4);
    const flat = db.prepare(`SELECT GROUP_CONCAT(g.name) names FROM menu_item_modifier_groups l
      JOIN modifier_groups g ON g.id = l.group_id JOIN menu_items m ON m.id = l.menu_item_id WHERE m.name = 'Flat White'`).get();
    assert.match(flat.names, /Milch/);
    db.close();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('demo data: 5 orders in each state today, 5 bean subscriptions, usernames for everyone', () => {
  const db = openDb(':memory:');
  const today = new Date().toLocaleDateString('en-CA', { timeZone: 'Europe/Berlin' });
  const count = (status) => db.prepare('SELECT COUNT(*) n FROM orders WHERE status = ? AND created_at >= ?').get(status, new Date(Date.now() - 864e5).toISOString()).n;
  for (const st of ['new', 'preparing', 'ready']) assert.equal(count(st), 5, st);
  assert.ok(count('picked_up') >= 5);
  assert.ok(db.prepare("SELECT COUNT(*) n FROM order_item_modifiers").get().n > 0, 'demo orders carry options');
  assert.equal(db.prepare('SELECT COUNT(*) n FROM bean_subscriptions').get().n, 5);
  assert.ok(db.prepare('SELECT COUNT(*) n FROM bean_sales').get().n > 0);
  for (const u of db.prepare('SELECT name, username FROM users').all()) assert.match(u.username, /^[a-z0-9.-]+\d{4}$/, u.name);
  assert.match(db.prepare("SELECT username FROM users WHERE member_id = 'SASU-1000'").get().username, /^leyla\.aksoy\d{4}$/);
  assert.ok(today);
});
