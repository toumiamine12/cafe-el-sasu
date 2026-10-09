import { test } from 'node:test';
import assert from 'node:assert/strict';
import { tierFor, isOpenAt, validatePickup, priceOrder, pointsFor } from '../server/rules.js';

// Berlin is UTC+2 in summer: 2026-07-07 is a Tuesday.
const berlin = (iso) => new Date(iso + '+02:00');

test('tierFor picks tier by lifetime points', () => {
  assert.equal(tierFor(199).name, 'Bronze');
  assert.equal(tierFor(199).next, 200);
  assert.equal(tierFor(200).name, 'Silver');
  assert.equal(tierFor(200).discountPct, 5);
  assert.equal(tierFor(500).discountPct, 10);
  assert.equal(tierFor(500).next, null);
});

test('isOpenAt follows opening hours in Berlin time', () => {
  assert.equal(isOpenAt(berlin('2026-07-06T12:00')), false); // Monday
  assert.equal(isOpenAt(berlin('2026-07-07T10:59')), false); // Tue before 11
  assert.equal(isOpenAt(berlin('2026-07-07T11:00')), true);
  assert.equal(isOpenAt(berlin('2026-07-07T22:00')), false); // Tue closes 22
  assert.equal(isOpenAt(berlin('2026-07-12T23:59')), true);  // Sunday late
  assert.equal(isOpenAt(berlin('2026-07-11T09:59')), false); // Sat before 10
});

test('validatePickup needs 15 minutes lead and open hours', () => {
  const now = berlin('2026-07-07T12:00');
  assert.ok(validatePickup(new Date(now.getTime() + 10 * 60e3), now));
  assert.equal(validatePickup(new Date(now.getTime() + 20 * 60e3), now), null);
  assert.ok(validatePickup(berlin('2026-07-13T12:00'), now)); // Monday
  assert.ok(validatePickup(new Date('nope'), now));
});

test('priceOrder applies reward then tier discount', () => {
  const lines = [
    { price_cents: 499, qty: 2, category: 'coffee' },
    { price_cents: 699, qty: 1, category: 'cake' },
  ];
  assert.deepEqual(priceOrder(lines, { category_allowed: 'coffee' }, 10),
    { subtotal: 1697, discount: 618, total: 1079 });
  assert.deepEqual(priceOrder(lines, null, 0), { subtotal: 1697, discount: 0, total: 1697 });
});

test('priceOrder frees the cheapest matching item', () => {
  const lines = [
    { price_cents: 899, qty: 1, category: 'cake' },
    { price_cents: 599, qty: 1, category: 'cake' },
  ];
  assert.equal(priceOrder(lines, { category_allowed: 'cake' }, 0).total, 899);
});

test('priceOrder rejects reward with no matching item', () => {
  assert.throws(() => priceOrder([{ price_cents: 499, qty: 1, category: 'coffee' }], { category_allowed: 'cake' }, 0),
    /reward_no_match/);
});

test('pointsFor gives 1 point per full euro', () => {
  assert.equal(pointsFor(1079), 10);
  assert.equal(pointsFor(99), 0);
});
