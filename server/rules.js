// Pure business rules. No DB, no HTTP — easy to test.

const TIERS = [
  { name: 'Gold', min: 500, discountPct: 10 },
  { name: 'Silver', min: 200, discountPct: 5 },
  { name: 'Bronze', min: 0, discountPct: 0 },
];

export function tierFor(lifetimePoints) {
  const i = TIERS.findIndex((t) => lifetimePoints >= t.min);
  const { name, discountPct } = TIERS[i];
  return { name, discountPct, next: i > 0 ? TIERS[i - 1].min : null };
}

// [open, close) in minutes after midnight, Berlin time. Sunday = 0.
const HOURS = { 0: [600, 1440], 1: null, 2: [660, 1320], 3: [660, 1320], 4: [660, 1320], 5: [660, 1320], 6: [600, 1440] };
const DAYS = { Sun: 0, Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6 };
const berlinFmt = new Intl.DateTimeFormat('en-US', {
  timeZone: 'Europe/Berlin', weekday: 'short', hour: '2-digit', minute: '2-digit', hourCycle: 'h23',
});

export function isOpenAt(date) {
  const p = Object.fromEntries(berlinFmt.formatToParts(date).map((x) => [x.type, x.value]));
  const range = HOURS[DAYS[p.weekday]];
  const min = Number(p.hour) * 60 + Number(p.minute);
  return !!range && min >= range[0] && min < range[1];
}

export function validatePickup(pickupAt, now = new Date()) {
  if (isNaN(pickupAt)) return 'Ungültige Abholzeit';
  if (pickupAt - now < 15 * 60e3) return 'Abholung frühestens in 15 Minuten';
  if (!isOpenAt(pickupAt)) return 'Zu dieser Zeit haben wir geschlossen';
  return null;
}

export function priceOrder(lines, reward, discountPct) {
  const subtotal = lines.reduce((s, l) => s + l.price_cents * l.qty, 0);
  let rewardOff = 0;
  if (reward) {
    const match = lines.filter((l) => l.category === reward.category_allowed);
    if (!match.length) throw new Error('reward_no_match');
    rewardOff = Math.min(...match.map((l) => l.price_cents));
  }
  const tierOff = Math.floor(((subtotal - rewardOff) * discountPct) / 100);
  const discount = rewardOff + tierOff;
  return { subtotal, discount, total: subtotal - discount };
}

export const pointsFor = (totalCents) => Math.floor(totalCents / 100);

// Next time the café opens or closes, on the 15-minute grid, within a week.
export function nextChange(now = new Date()) {
  const open = isOpenAt(now);
  const t = new Date(Math.ceil(now / 900e3) * 900e3);
  if (t.getTime() === now.getTime()) t.setTime(t.getTime() + 900e3);
  for (const end = now.getTime() + 7 * 864e5; t < end; t.setTime(t.getTime() + 900e3)) {
    if (isOpenAt(t) !== open) return t;
  }
  return null;
}
