import { test } from 'node:test';
import assert from 'node:assert/strict';
import { openDb, verifyPassword } from '../server/db.js';

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
