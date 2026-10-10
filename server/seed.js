// Demo data so a fresh install has a full menu, accounts and some history.
import { randomBytes } from 'node:crypto';
import { hashPassword, tx } from './db.js';
import { priceOrder, isOpenAt } from './rules.js';

// [name, description, category, price_cents, photo, tags]
const MENU = [
  ['Cappuccino', 'Ein Espresso mit warmer Milch, gekrönt von feinem Milchschaum', 'coffee', 499, 'cappuccino.jpg', 'lactose'],
  ['Macchiato', 'Espresso mit einem Hauch Milchschaum, elegant serviert', 'coffee', 399, 'macchiato.jpg', 'lactose'],
  ['Espresso', 'Kurz, kräftig und aromatisch', 'coffee', 249, 'menu/espresso.jpg', 'vegan'],
  ['Americano', 'Espresso mit heißem Wasser, mild und klar', 'coffee', 329, 'menu/americano.jpg', 'vegan'],
  ['Flat White', 'Doppelter Espresso mit samtiger Mikroschaum-Milch', 'coffee', 459, 'menu/flatwhite.jpg', 'lactose'],
  ['Caramel Latte', 'Milchkaffee mit hausgemachtem Karamellsirup', 'coffee', 549, 'menu/caramellatte.jpg', 'lactose'],
  ['Pistachio Latte', 'Cremiger Latte mit Pistaziencreme', 'coffee', 599, 'menu/pistachiolatte.jpg', 'lactose,nuts'],
  ['Chai Latte', 'Gewürzter Schwarztee mit aufgeschäumter Milch', 'coffee', 479, 'menu/chailatte.jpg', 'lactose'],
  ['Mokka Kaffee', 'Ein schokoladiger Espresso-Kaffee, cremig und süß', 'coffee', 1099, 'caffeemocha.jpg', 'lactose'],
  ['Türkischer Kaffee', 'Intensiv, aromatisch und traditionell fein gemahlen', 'coffee', 1099, 'turkishcoffee.jpg', 'vegan'],
  ['Matcha Kaffee', 'Sanfter Kaffee mit grünem Tee, cremig und belebend', 'coffee', 1099, 'machacoffee.jpg', 'lactose'],
  ['Irischer Kaffee', 'Wärmender Kaffee mit Whiskey und süßer Sahne', 'coffee', 1099, 'irishcoffee.jpg', 'lactose'],
  ['Dalgona Kaffee', 'Cremiger Kaffeeschaum trifft auf eiskalte Milch, ein süßer Hingucker im Glas', 'cold', 799, 'dalgona.jpg', 'lactose'],
  ['Eiskaffee', 'Ein erfrischender Kaffee auf Eis, perfekt für heiße Tage', 'cold', 999, 'icedcoffee.jpg', 'lactose'],
  ['Frappé Kaffee', 'Ein kühler, schaumiger Kaffee-Genuss zum Mitnehmen', 'cold', 1099, 'frappe.jpg', 'lactose'],
  ['Iced Favorites', 'Erfrischende Eiskaffees für heiße Sommertage', 'cold', 599, 'iced.jpg', 'lactose'],
  ['Cold Brew', '18 Stunden kalt extrahiert, mild und schokoladig', 'cold', 449, 'menu/coldbrew.jpg', 'vegan'],
  ['Iced Matcha Latte', 'Matcha auf Eis mit Hafermilch', 'cold', 549, 'menu/icedmatcha.jpg', 'vegan'],
  ['Affogato', 'Espresso trifft auf cremiges Vanilleeis, süß und stark', 'cold', 599, 'affogato.jpg', 'lactose'],
  ['Chocolate Tiramisu', 'Cremiges Dessert mit Schokolade und Kaffee-Aroma', 'cake', 699, 'chocolattiramisu.jpg', 'lactose,gluten'],
  ['Cheesecake', 'Cremiger Käsekuchen mit zarter, süßer Kruste', 'cake', 799, 'cheesecake.jpg', 'lactose,gluten'],
  ['San Sebastián Cheesecake', 'Außen karamellisiert, innen cremig', 'cake', 699, 'menu/basque.jpg', 'lactose'],
  ['Australian Lamingtons', 'Saftige Kuchenwürfel, umhüllt mit Schokolade und Kokos', 'cake', 499, 'lamingtons.jpg', 'gluten,lactose'],
  ['Apple Pie', 'Klassischer Apfelkuchen, warm und süß mit Zimt', 'cake', 499, 'applepie.jpg', 'gluten,lactose'],
  ['Erdbeertorte', 'Leichte Torte mit frischen Erdbeeren und Sahne', 'cake', 499, 'tarte.jpg', 'gluten,lactose'],
  ['Chocolate Mousse', 'Luftig-cremige Schokoladenspezialität, süß und zart', 'cake', 499, 'mousse.jpg', 'lactose'],
  ['Red Velvet', 'Samtiger Kakaokuchen mit Frischkäse-Frosting', 'cake', 599, 'menu/redvelvet.jpg', 'gluten,lactose'],
  ['Baklava', 'Süßes Blätterteiggebäck mit Nüssen und Honigsirup', 'pastry', 499, 'baklava.jpg', 'gluten,nuts'],
  ['Künefe', 'Warmes Engelshaar-Gebäck mit Käse und Pistazien', 'pastry', 749, 'menu/kunefe.jpg', 'gluten,lactose,nuts'],
  ['Cookie Croissant', 'Buttrig, knusprig und mit süßen Cookie-Stückchen gefüllt', 'pastry', 699, 'cookiecroissant.jpg', 'gluten,lactose'],
  ['Croissant', 'Klassisch französisch, frisch gebacken', 'pastry', 299, 'menu/croissant.jpg', 'gluten,lactose'],
  ['Zimtschnecke', 'Fluffiger Hefeteig mit Zimt und Zuckerguss', 'pastry', 349, 'menu/cinnamonroll.jpg', 'gluten,lactose'],
  ['Schoko-Cookie', 'Großer Cookie mit Schokostückchen', 'pastry', 249, 'menu/cookie.jpg', 'gluten,lactose'],
  ['Vegan Brownie', 'Saftiger Schokobrownie ohne tierische Produkte', 'pastry', 349, 'menu/brownie.jpg', 'vegan,gluten'],
  ['Cortado', 'Espresso mit gleich viel warmer Milch, kräftig und rund', 'coffee', 379, 'menu/cortado.jpg', 'lactose'],
  ['Spanish Latte', 'Espresso mit gesüßter Kondensmilch, cremig und süß', 'coffee', 529, 'menu/spanishlatte.jpg', 'lactose'],
  ['Wiener Melange', 'Wiener Klassiker mit Milchschaum und Sahnehaube', 'coffee', 489, 'menu/melange.jpg', 'lactose'],
  ['Heiße Schokolade', 'Echte Schokolade mit Milch und Marshmallows', 'coffee', 449, 'menu/hotchocolate.jpg', 'lactose'],
  ['Iced Caramel Macchiato', 'Milch, Vanille, Espresso und Karamell auf Eis', 'cold', 579, 'menu/icedcaramel.jpg', 'lactose'],
  ['Espresso Tonic', 'Espresso über Tonic Water und Eis, spritzig und bitter', 'cold', 499, 'menu/espressotonic.jpg', 'vegan'],
  ['Eisschokolade', 'Kalte Schokolade mit Vanilleeis und Sahne', 'cold', 549, 'menu/icedchocolate.jpg', 'lactose'],
  ['Karottenkuchen', 'Saftiger Möhrenkuchen mit Walnüssen und Frischkäse-Topping', 'cake', 549, 'menu/carrotcake.jpg', 'gluten,lactose,nuts'],
  ['Schwarzwälder Kirschtorte', 'Schokobiskuit, Sauerkirschen, Kirschwasser und viel Sahne', 'cake', 649, 'menu/blackforest.jpg', 'gluten,lactose'],
  ['Zitronentarte', 'Mürbeteig mit frischer, säuerlicher Zitronencreme', 'cake', 529, 'menu/lemontart.jpg', 'gluten,lactose'],
  ['Klassisches Tiramisu', 'Löffelbiskuit in Espresso, Mascarpone und Kakao', 'cake', 599, 'menu/tiramisu.jpg', 'gluten,lactose'],
  ['Pain au Chocolat', 'Buttriger Blätterteig mit zwei Schokoladenstangen', 'pastry', 329, 'menu/painauchocolat.jpg', 'gluten,lactose'],
  ['Macarons', 'Drei französische Mandelbaisers, wechselnde Sorten', 'pastry', 449, 'menu/macarons.jpg', 'nuts,lactose'],
  ['Profiteroles', 'Windbeutel mit Vanillecreme und Schokoladensauce', 'pastry', 579, 'menu/profiteroles.jpg', 'gluten,lactose'],
  ['Churros', 'Frittiertes Spritzgebäck mit Zimtzucker und Schokodip', 'pastry', 499, 'menu/churros.jpg', 'gluten,lactose'],
];

// Modifier groups: [name, kind, required, [[option, price_cents, is_default], …]]
const MODIFIERS = [
  ['Milch', 'one', 1, [['Vollmilch', 0, 1], ['Hafermilch', 50, 0], ['Mandelmilch', 50, 0], ['Laktosefrei', 30, 0]]],
  ['Sirup', 'one', 0, [['Vanille', 40, 0], ['Karamell', 40, 0], ['Haselnuss', 40, 0]]],
  ['Extra Shot', 'many', 0, [['Extra Shot', 80, 0]]],
  ['Eis', 'one', 1, [['Wenig Eis', 0, 0], ['Normales Eis', 0, 1], ['Viel Eis', 0, 0]]],
];

// Which groups an item offers: drinks with milk get Milch + Sirup, coffee and cold drinks get Extra Shot, cold drinks get Eis.
const groupsFor = (category, tags) => [
  tags.includes('lactose') && ['coffee', 'cold'].includes(category) && 'Milch',
  tags.includes('lactose') && ['coffee', 'cold'].includes(category) && 'Sirup',
  ['coffee', 'cold'].includes(category) && 'Extra Shot',
  category === 'cold' && 'Eis',
].filter(Boolean);

const REWARDS = [
  ['Gratis Gebäck', 50, 'pastry', 0],
  ['Gratis Kaffee', 100, 'coffee', 0],
  ['Gratis Kuchen', 250, 'cake', 0],
  ['Geburtstagskaffee', 0, 'coffee', 1],
];

// [member_id, name, email, password, role, wage, lifetime_points, points, birthday]
const USERS = [
  ['SASU-1000', 'Leyla Aksoy', 'admin@cafe-elsasu.de', 'ADMIN', 'admin', 0, 0, 0, null],
  ['SASU-1001', 'Lena Becker', 'lena@cafe-elsasu.de', 'STAFF', 'staff', 1400, 0, 0, null],
  ['SASU-1002', 'Yusuf Demir', 'yusuf@cafe-elsasu.de', 'STAFF', 'staff', 1400, 0, 0, null],
  ['SASU-1003', 'Anna Schmidt', 'anna@example.com', 'demo123', 'customer', 0, 80, 80, '1998-03-14'],
  ['SASU-1004', 'Mehmet Kaya', 'mehmet@example.com', 'demo123', 'customer', 0, 260, 140, '1990-11-02'],
  ['SASU-1005', 'Sophie Wagner', 'sophie@example.com', 'demo123', 'customer', 0, 620, 310, '1995-06-21'],
  ['SASU-1007', 'Sara Hoffmann', 'sara@cafe-elsasu.de', 'STAFF', 'staff', 1500, 0, 0, null],
  ['SASU-1008', 'Tim Schulz', 'tim@cafe-elsasu.de', 'STAFF', 'staff', 1300, 0, 0, null],
  ['SASU-1009', 'Elif Yıldız', 'elif@cafe-elsasu.de', 'STAFF', 'staff', 1450, 0, 0, null],
  ['SASU-1010', 'Paul Richter', 'paul@cafe-elsasu.de', 'STAFF', 'staff', 1350, 0, 0, null],
  ['SASU-1011', 'Nina Wolf', 'nina@cafe-elsasu.de', 'STAFF', 'staff', 1600, 0, 0, null],
  // Bulk history so the finance dashboard shows a realistic month. No usable password.
  ['SASU-1006', 'Laufkundschaft', 'gast@cafe-elsasu.de', null, 'customer', 0, 0, 0, null],
];

// UTC instant of a Berlin wall-clock hour on a date (handles summer/winter time).
const berlinParts = new Intl.DateTimeFormat('en-US', { timeZone: 'Europe/Berlin', hourCycle: 'h23', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit' });
function berlinTime(date, hour) {
  const guess = new Date(Date.parse(`${date}T00:00:00Z`) + hour * 3600e3);
  const p = Object.fromEntries(berlinParts.formatToParts(guess).map((x) => [x.type, Number(x.value)]));
  const offset = Date.UTC(p.year, p.month - 1, p.day, p.hour, p.minute) - guess.getTime();
  return new Date(guess.getTime() - offset);
}

const daysAgo = (d, hour) => {
  const t = new Date(Date.now() - d * 864e5);
  t.setUTCHours(hour, 0, 0, 0);
  return t.toISOString();
};

// Item options (milk, syrup, extra shot, ice) and which menu items offer them.
// Also run on databases created before item options existed (see openDb).
export function seedModifiers(db) {
  const groupId = {};
  MODIFIERS.forEach(([name, kind, required, options], gi) => {
    groupId[name] = db.prepare('INSERT INTO modifier_groups (name, kind, required, sort) VALUES (?, ?, ?, ?)').run(name, kind, required, gi).lastInsertRowid;
    options.forEach(([o, price, def], oi) => db.prepare('INSERT INTO modifier_options (group_id, name, price_cents, is_default, sort) VALUES (?, ?, ?, ?, ?)')
      .run(groupId[name], o, price, def, oi));
  });
  const link = db.prepare('INSERT OR IGNORE INTO menu_item_modifier_groups (menu_item_id, group_id) VALUES (?, ?)');
  for (const { id, category, tags } of db.prepare('SELECT id, category, tags FROM menu_items').all()) {
    for (const g of groupsFor(category, tags)) link.run(id, groupId[g]);
  }
}

// Staff/admin passwords are never in the code: take them from the environment,
// or generate random ones and print them once on first start.
function secret(envName, label, ids) {
  if (process.env[envName]) return process.env[envName];
  const pw = randomBytes(9).toString('base64url');
  console.log(`${label}-Passwort (${ids}): ${pw}   – setze ${envName}, um es festzulegen`);
  return pw;
}

export function seed(db) {
  const pw = { ADMIN: secret('ADMIN_PASSWORD', 'Admin', 'SASU-1000'), STAFF: secret('STAFF_PASSWORD', 'Personal', 'alle 7 Mitarbeiter: SASU-1001, -1002, -1007 bis -1011') };
  tx(db, () => {
    const m = db.prepare('INSERT INTO menu_items (name, description, category, price_cents, photo, tags) VALUES (?, ?, ?, ?, ?, ?)');
    for (const [n, d, c, p, photo, tags] of MENU) m.run(n, d, c, p, `photos/${photo}`, tags);
    seedModifiers(db);

    const r = db.prepare('INSERT INTO rewards (name, cost_points, category_allowed, birthday_only) VALUES (?, ?, ?, ?)');
    for (const row of REWARDS) r.run(...row);

    const u = db.prepare(`INSERT INTO users (member_id, name, email, password_hash, role, hourly_wage, lifetime_points, points, birthday)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`);
    for (const [mid, n, e, p, role, wage, life, pts, bd] of USERS) u.run(mid, n, e, p ? hashPassword(pw[p] ?? p) : 'x:x', role, wage, life, pts, bd);

    // A month of history: orders from the 3 demo customers, shifts for the 2 staff.
    // Demo customers get their tier discount, and every 4th day one of their orders redeems a matching reward.
    const items = db.prepare('SELECT id, price_cents, category FROM menu_items').all();
    const rewards = db.prepare('SELECT * FROM rewards WHERE birthday_only = 0').all();
    const TIER_PCT = { 5: 5, 6: 10 };
    const o = db.prepare(`INSERT INTO orders (user_id, pickup_at, status, subtotal_cents, discount_cents, total_cents, reward_id, created_at)
      VALUES (?, ?, 'picked_up', ?, ?, ?, ?, ?)`);
    const oi = db.prepare('INSERT INTO order_items (order_id, menu_item_id, qty, unit_price_cents) VALUES (?, ?, ?, ?)');
    const s = db.prepare('INSERT INTO shifts (user_id, clock_in, clock_out) VALUES (?, ?, ?)');
    for (let d = 1; d <= 30; d++) {
      const guestOrders = 14 + ((d * 7) % 9);
      for (const [n, userId] of [[4, 4], [5, 5], [6, 6], ...Array.from({ length: guestOrders }, (_, k) => [k + 10, 7])]) {
        if (userId < 7 && (d + userId) % 3) continue;
        const picks = [items[(d * n) % items.length], items[(d + n * 7) % items.length]];
        const lines = picks.map((i) => ({ ...i, qty: 1 }));
        const reward = userId < 7 && d % 4 === 0 ? rewards.find((r) => lines.some((l) => l.category === r.category_allowed)) : null;
        const price = priceOrder(lines, reward ?? null, TIER_PCT[userId] ?? 0);
        const at = daysAgo(d, 8 + (n % 12));
        const { lastInsertRowid } = o.run(userId, at, price.subtotal, price.discount, price.total, reward?.id ?? null, at);
        for (const i of picks) oi.run(lastInsertRowid, i.id, 1, i.price_cents);
      }
      if (d % 7 !== 0) s.run(2 + (d % 2), daysAgo(d, 9), daysAgo(d, 17));
    }

    // The five newer staff: about four shifts a week each, with a 30-minute break in the middle.
    const staffIds = db.prepare("SELECT id FROM users WHERE member_id BETWEEN 'SASU-1007' AND 'SASU-1011' ORDER BY member_id").all().map((u) => u.id);
    const b = db.prepare('INSERT INTO shift_breaks (shift_id, start, end) VALUES (?, ?, ?)');
    for (let d = 1; d <= 30; d++) {
      staffIds.forEach((uid, k) => {
        if ((d + k) % 7 >= 4) return; // days off
        const startHour = (d + k) % 2 ? 8 : 13; // early or late shift (UTC)
        const shift = s.run(uid, daysAgo(d, startHour), daysAgo(d, startHour + 8)).lastInsertRowid;
        b.run(shift, daysAgo(d, startHour + 4), new Date(Date.parse(daysAgo(d, startHour + 4)) + 30 * 60e3).toISOString());
      });
    }

    // Rota for the next 14 days: an early and a late shift every opening day, rotating through the team.
    const team = db.prepare("SELECT id FROM users WHERE role = 'staff' ORDER BY member_id").all().map((u) => u.id);
    const plan = db.prepare('INSERT INTO planned_shifts (user_id, start, end, note) VALUES (?, ?, ?, ?)');
    for (let d = 0; d < 14; d++) {
      const date = new Date(Date.now() + d * 864e5).toISOString().slice(0, 10);
      if (!isOpenAt(berlinTime(date, 12))) continue; // Monday: closed
      const weekend = isOpenAt(berlinTime(date, 23));
      plan.run(team[(2 * d) % team.length], berlinTime(date, weekend ? 9 : 10).toISOString(), berlinTime(date, 16).toISOString(), 'Frühschicht');
      plan.run(team[(2 * d + 1) % team.length], berlinTime(date, 16).toISOString(), berlinTime(date, weekend ? 24 : 22).toISOString(), 'Spätschicht');
      if (weekend) plan.run(team[(2 * d + 2) % team.length], berlinTime(date, 11).toISOString(), berlinTime(date, 19).toISOString(), 'Wochenende');
    }
  });
}
