import { test } from 'node:test';
import assert from 'node:assert/strict';
import { openDb, verifyPassword } from '../server/db.js';

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
