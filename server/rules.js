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

// leadMinutes: 15 normally, 30 when staff switch on the rush delay.
export function validatePickup(pickupAt, now = new Date(), leadMinutes = 15) {
  if (isNaN(pickupAt)) return 'Ungültige Abholzeit';
  if (pickupAt - now < leadMinutes * 60e3) return `Abholung frühestens in ${leadMinutes} Minuten`;
  if (!isOpenAt(pickupAt)) return 'Zu dieser Zeit haben wir geschlossen';
  return null;
}

// Unit price = base price + chosen modifiers (oat milk, extra shot…).
const unitPrice = (l) => l.price_cents + (l.mods ?? []).reduce((s, m) => s + m.price_cents, 0);

export function priceOrder(lines, reward, discountPct) {
  const subtotal = lines.reduce((s, l) => s + unitPrice(l) * l.qty, 0);
  let rewardOff = 0;
  if (reward) {
    const match = lines.filter((l) => l.category === reward.category_allowed);
    if (!match.length) throw new Error('reward_no_match');
    rewardOff = Math.min(...match.map((l) => l.price_cents)); // base price only: modifiers stay charged
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

// Checks the options a guest picked for one item against the item's modifier groups.
// groups: [{ id, name, kind: 'one'|'many', required, options: [{ id, name, price_cents, is_default }] }]
// Returns the chosen options in group order, with defaults filled in for required groups; throws on bad input.
export function validateModifiers(groups, optionIds) {
  if (new Set(optionIds).size !== optionIds.length) throw new Error('Option doppelt gewählt');
  const known = new Map(groups.flatMap((g) => g.options.map((o) => [o.id, g])));
  for (const id of optionIds) if (!known.has(id)) throw new Error('Option für diesen Artikel nicht verfügbar');
  const chosen = [];
  for (const g of groups) {
    const picked = g.options.filter((o) => optionIds.includes(o.id));
    if (g.kind === 'one' && picked.length > 1) throw new Error(`${g.name}: bitte nur eine Option wählen`);
    if (!picked.length && g.required) {
      const fallback = g.options.find((o) => o.is_default);
      if (!fallback) throw new Error(`${g.name}: bitte eine Option wählen`);
      picked.push(fallback);
    }
    chosen.push(...picked);
  }
  return chosen;
}

// Pickup capacity: at most this many orders per 15-minute window (the settings table can override it).
export const SLOT_CAPACITY = 5;
export const slotStart = (date) => new Date(Math.floor(date.getTime() / 900e3) * 900e3);

// --- work time ---------------------------------------------------------------------
const minutesBetween = (a, b) => (Date.parse(b) - Date.parse(a)) / 60e3;

// Worked minutes of a shift minus its (unpaid) breaks. An open shift or break counts up to `now`.
export function netMinutes(start, end, breaks, now = new Date()) {
  const until = (t) => t ?? now.toISOString();
  const pause = breaks.reduce((sum, b) => sum + minutesBetween(b.start, until(b.end)), 0);
  return minutesBetween(start, until(end)) - pause;
}

// German Arbeitszeitgesetz §4: more than 6 h needs 30 min break, more than 9 h needs 45 min.
// Returns the break minutes still missing.
export function breakShortfall(workedMinutes, breakMinutes) {
  const required = workedMinutes > 540 ? 45 : workedMinutes > 360 ? 30 : 0;
  return Math.max(0, required - breakMinutes);
}

// Pay for worked minutes at an hourly wage in cents, rounded once.
export const payCents = (minutes, wageCents) => Math.round((minutes / 60) * wageCents);

// --- guest experience ------------------------------------------------------------------
// Birthday treat window: the birthday ±3 days (any year; Feb 29 counts as Feb 28 otherwise).
export function inBirthdayWeek(birthday, todayIso) {
  if (!birthday) return false;
  const [, m, d] = birthday.split('-').map(Number);
  const today = Date.parse(`${todayIso}T00:00:00Z`);
  const year = Number(todayIso.slice(0, 4));
  return [year - 1, year, year + 1].some((y) => {
    const leap = (y % 4 === 0 && y % 100 !== 0) || y % 400 === 0;
    const day = m === 2 && d === 29 && !leap ? 28 : d;
    return Math.abs(Date.UTC(y, m - 1, day) - today) <= 3 * 864e5;
  });
}

// The guest's usual: most-ordered exact item + options combination; ties go to the most recent.
// lines: [{ menu_item_id, mods: [optionId], qty, at }]
export function usualCombo(lines) {
  const combos = new Map();
  for (const l of lines) {
    const mods = [...l.mods].sort((a, b) => a - b);
    const key = `${l.menu_item_id}:${mods.join(',')}`;
    const c = combos.get(key) ?? { menu_item_id: l.menu_item_id, mods, count: 0, last: '' };
    c.count += l.qty;
    if (l.at > c.last) c.last = l.at;
    combos.set(key, c);
  }
  const best = [...combos.values()].sort((a, b) => b.count - a.count || (a.last < b.last ? 1 : -1))[0];
  return best ? { menu_item_id: best.menu_item_id, mods: best.mods, count: best.count } : null;
}

// Most common pickup time of day (Berlin, HH:MM).
const berlinHM = new Intl.DateTimeFormat('de-DE', { timeZone: 'Europe/Berlin', hour: '2-digit', minute: '2-digit', hourCycle: 'h23' });
export function usualTime(isoTimes) {
  const counts = new Map();
  for (const t of isoTimes) {
    const hm = berlinHM.format(new Date(t));
    counts.set(hm, (counts.get(hm) ?? 0) + 1);
  }
  return [...counts.entries()].sort((a, b) => b[1] - a[1])[0]?.[0] ?? null;
}

// Whole-bean bags for the pickup subscription, prices in cents.
export const BEAN_PRICES = {
  espresso: { '250g': 890, '1kg': 2990 },
  filter: { '250g': 850, '1kg': 2790 },
  decaf: { '250g': 950, '1kg': 3190 },
};
export const addWeeks = (dateIso, weeks) => new Date(Date.parse(`${dateIso}T00:00:00Z`) + weeks * 7 * 864e5).toISOString().slice(0, 10);
