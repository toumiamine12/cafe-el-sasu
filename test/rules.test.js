import { test } from 'node:test';
import assert from 'node:assert/strict';
import { tierFor, isOpenAt, validatePickup, priceOrder, pointsFor, nextChange, validateModifiers, slotStart, SLOT_CAPACITY, netMinutes, breakShortfall, payCents,
  inBirthdayWeek, usualCombo, usualTime, BEAN_PRICES, addWeeks } from '../server/rules.js';

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

test('nextChange finds the next opening or closing time', () => {
  assert.equal(nextChange(berlin('2026-07-07T12:00')).getTime(), berlin('2026-07-07T22:00').getTime()); // Tue open → closes 22:00
  assert.equal(nextChange(berlin('2026-07-06T12:00')).getTime(), berlin('2026-07-07T11:00').getTime()); // Mon closed → Tue 11:00
  assert.equal(nextChange(berlin('2026-07-07T22:05')).getTime(), berlin('2026-07-08T11:00').getTime()); // Tue night → Wed 11:00
  assert.equal(nextChange(berlin('2026-07-12T23:50')).getTime(), berlin('2026-07-13T00:00').getTime()); // Sun closes midnight
});

// --- modifiers ---------------------------------------------------------------------
const GROUPS = [
  { id: 1, name: 'Milch', kind: 'one', required: 1, options: [
    { id: 10, name: 'Vollmilch', price_cents: 0, is_default: 1 },
    { id: 11, name: 'Hafermilch', price_cents: 50, is_default: 0 },
  ] },
  { id: 2, name: 'Sirup', kind: 'one', required: 0, options: [{ id: 20, name: 'Vanille', price_cents: 40, is_default: 0 }] },
  { id: 3, name: 'Extras', kind: 'many', required: 0, options: [
    { id: 30, name: 'Extra Shot', price_cents: 80, is_default: 0 },
    { id: 31, name: 'Sahne', price_cents: 30, is_default: 0 },
  ] },
];

test('validateModifiers fills required defaults', () => {
  assert.deepEqual(validateModifiers(GROUPS, []).map((o) => o.id), [10]);
});

test('validateModifiers keeps chosen options in group order', () => {
  assert.deepEqual(validateModifiers(GROUPS, [30, 11, 20]).map((o) => o.id), [11, 20, 30]);
  assert.deepEqual(validateModifiers(GROUPS, [30, 31]).map((o) => o.id), [10, 30, 31]);
});

test('validateModifiers rejects bad choices', () => {
  assert.throws(() => validateModifiers(GROUPS, [99]), /nicht verfügbar/);
  assert.throws(() => validateModifiers(GROUPS, [10, 11]), /nur eine/);
  assert.throws(() => validateModifiers(GROUPS, [30, 30]), /doppelt/);
  assert.throws(() => validateModifiers([], [10]), /nicht verfügbar/);
  assert.throws(() => validateModifiers([{ id: 4, name: 'Eis', kind: 'one', required: 1, options: [{ id: 40, name: 'Normal', price_cents: 0, is_default: 0 }] }], []), /Eis/);
});

test('priceOrder adds modifier prices per unit', () => {
  const lines = [{ price_cents: 459, qty: 2, category: 'coffee', mods: [{ price_cents: 50 }, { price_cents: 80 }] }];
  assert.deepEqual(priceOrder(lines, null, 0), { subtotal: 1178, discount: 0, total: 1178 });
});

test('a reward frees the base price, modifiers are still charged', () => {
  const lines = [{ price_cents: 459, qty: 1, category: 'coffee', mods: [{ price_cents: 50 }] }];
  assert.deepEqual(priceOrder(lines, { category_allowed: 'coffee' }, 0), { subtotal: 509, discount: 459, total: 50 });
});

// --- pickup capacity -------------------------------------------------------------
test('slotStart rounds down to the 15-minute window', () => {
  assert.equal(slotStart(berlin('2026-07-07T12:07')).getTime(), berlin('2026-07-07T12:00').getTime());
  assert.equal(slotStart(berlin('2026-07-07T12:15')).getTime(), berlin('2026-07-07T12:15').getTime());
  assert.equal(slotStart(berlin('2026-07-07T12:29:59')).getTime(), berlin('2026-07-07T12:15').getTime());
});

test('default slot capacity is 5 orders', () => {
  assert.equal(SLOT_CAPACITY, 5);
});

test('validatePickup honours a longer lead time', () => {
  const now = berlin('2026-07-07T12:00');
  assert.equal(validatePickup(new Date(now.getTime() + 20 * 60e3), now), null);
  assert.ok(validatePickup(new Date(now.getTime() + 20 * 60e3), now, 30));
  assert.equal(validatePickup(new Date(now.getTime() + 30 * 60e3), now, 30), null);
});

// --- work time -------------------------------------------------------------------
const at = (hhmm) => `2026-07-07T${hhmm}:00.000Z`;

test('netMinutes deducts breaks and counts open ones up to now', () => {
  assert.equal(netMinutes(at('09:00'), at('17:00'), []), 480);
  assert.equal(netMinutes(at('09:00'), at('17:00'), [{ start: at('12:00'), end: at('12:30') }]), 450);
  assert.equal(netMinutes(at('09:00'), null, [{ start: at('12:00'), end: null }], new Date(at('12:20'))), 180);
});

test('breakShortfall follows the 6 h / 9 h rule', () => {
  assert.equal(breakShortfall(360, 0), 0);    // exactly 6 h: nothing required yet
  assert.equal(breakShortfall(361, 0), 30);
  assert.equal(breakShortfall(400, 20), 10);
  assert.equal(breakShortfall(541, 30), 15);  // over 9 h: 45 min
  assert.equal(breakShortfall(600, 45), 0);
});

test('payCents rounds once from minutes', () => {
  assert.equal(payCents(450, 1400), 10500);
  assert.equal(payCents(7, 1450), 169); // 7/60 * 1450 = 169.17
});

// --- guest experience --------------------------------------------------------------
test('inBirthdayWeek: ±3 days, across new year, Feb 29 in other years', () => {
  assert.equal(inBirthdayWeek('1990-10-12', '2026-10-12'), true);
  assert.equal(inBirthdayWeek('1990-10-12', '2026-10-15'), true);
  assert.equal(inBirthdayWeek('1990-10-12', '2026-10-16'), false);
  assert.equal(inBirthdayWeek('1990-01-01', '2026-12-30'), true);
  assert.equal(inBirthdayWeek('1990-12-31', '2027-01-02'), true);
  assert.equal(inBirthdayWeek('2000-02-29', '2027-02-28'), true);
  assert.equal(inBirthdayWeek(null, '2026-10-12'), false);
});

test('usualCombo picks the most-ordered exact combination, ties to the latest', () => {
  const lines = [
    { menu_item_id: 5, mods: [11, 30], qty: 1, at: '2026-10-01' },
    { menu_item_id: 5, mods: [30, 11], qty: 1, at: '2026-10-02' },
    { menu_item_id: 5, mods: [], qty: 1, at: '2026-10-03' },
    { menu_item_id: 7, mods: [], qty: 2, at: '2026-10-04' },
  ];
  assert.deepEqual(usualCombo(lines), { menu_item_id: 7, mods: [], count: 2 });
  assert.deepEqual(usualCombo(lines.slice(0, 3)), { menu_item_id: 5, mods: [11, 30], count: 2 });
  assert.equal(usualCombo([]), null);
});

test('usualTime is the most common Berlin pickup time', () => {
  assert.equal(usualTime(['2026-10-01T06:30:00.000Z', '2026-10-02T06:30:00.000Z', '2026-10-03T13:00:00.000Z']), '08:30');
  assert.equal(usualTime([]), null);
});

test('bean prices and pickup rhythm', () => {
  assert.equal(BEAN_PRICES.espresso['250g'], 890);
  assert.equal(addWeeks('2026-10-12', 2), '2026-10-26');
  assert.equal(addWeeks('2026-12-28', 1), '2027-01-04');
});
