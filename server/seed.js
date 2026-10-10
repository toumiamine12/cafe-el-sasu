// Demo data so a fresh install has a full menu, accounts and some history.
import { randomBytes } from 'node:crypto';
import { hashPassword, tx, newUsername } from './db.js';
import { priceOrder, isOpenAt, berlinTime, validatePickup, BEAN_PRICES, addWeeks } from './rules.js';

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

// Drinks that become vegan with oat or almond milk (no cream, ice cream, chocolate or condensed milk in them).
export const PLANT_MILK_OK = ['Cappuccino', 'Macchiato', 'Flat White', 'Caramel Latte', 'Chai Latte', 'Cortado', 'Matcha Kaffee',
  'Dalgona Kaffee', 'Iced Favorites', 'Iced Caramel Macchiato'];
export function tagPlantMilk(db) {
  const tag = db.prepare("UPDATE menu_items SET tags = CASE WHEN tags = '' THEN 'plant' ELSE tags || ',plant' END WHERE name = ? AND (',' || tags || ',') NOT LIKE '%,plant,%'");
  for (const name of PLANT_MILK_OK) tag.run(name);
}

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

// Regulars who preorder online (no usable password) – about a third of the history.
const REGULARS = ['Jonas Fischer', 'Laura Weber', 'Emre Arslan', 'Hannah Meyer', 'Lukas Koch', 'Mia Bauer', 'Ali Yilmaz', 'Lea Klein',
  'Felix Wolff', 'Zeynep Şahin', 'Noah Neumann', 'Emma Schwarz', 'Ben Zimmermann', 'Clara Braun', 'Can Öztürk', 'Marie Krüger',
  'David Hartmann', 'Julia Lange', 'Elias Schmitt', 'Lina Werner'];
// Berlin opening hours weighted like a real day: morning coffee, lunch, afternoon cake (UTC = Berlin − 2 in summer).
const RUSH_HOURS = [7, 7, 8, 8, 8, 9, 10, 10, 11, 11, 12, 13, 13, 14, 14, 15, 16, 17];

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
  console.log(`${label}-Passwort (${ids}): ${pw}   – über ${envName} fest einstellbar`);
  return pw;
}

export function seed(db) {
  const pw = { ADMIN: secret('ADMIN_PASSWORD', 'Admin', 'SASU-1000'), STAFF: secret('STAFF_PASSWORD', 'Personal', 'alle 7 Mitarbeiter: SASU-1001, -1002, -1007 bis -1011') };
  tx(db, () => {
    const m = db.prepare('INSERT INTO menu_items (name, description, category, price_cents, photo, tags) VALUES (?, ?, ?, ?, ?, ?)');
    for (const [n, d, c, p, photo, tags] of MENU) m.run(n, d, c, p, `photos/${photo}`, tags);
    seedModifiers(db);
    tagPlantMilk(db);

    const r = db.prepare('INSERT INTO rewards (name, cost_points, category_allowed, birthday_only) VALUES (?, ?, ?, ?)');
    for (const row of REWARDS) r.run(...row);

    const u = db.prepare(`INSERT INTO users (member_id, name, email, password_hash, role, hourly_wage, lifetime_points, points, birthday, username)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`);
    for (const [mid, n, e, p, role, wage, life, pts, bd] of USERS) u.run(mid, n, e, p ? hashPassword(pw[p] ?? p) : 'x:x', role, wage, life, pts, bd, newUsername(db, n));
    const regulars = REGULARS.map((n, k) => Number(u.run(`SASU-${1012 + k}`, n, `${n.split(' ')[0].toLowerCase()}.${1012 + k}@example.com`, 'x:x', 'customer', 0, 0, 0, null, newUsername(db, n)).lastInsertRowid));

    // A month of history: orders from the 3 demo customers, shifts for the 2 staff.
    // Demo customers get their tier discount, and every 4th day one of their orders redeems a matching reward.
    const items = db.prepare('SELECT id, price_cents, category FROM menu_items').all();
    const rewards = db.prepare('SELECT * FROM rewards WHERE birthday_only = 0').all();
    const TIER_PCT = { 5: 5, 6: 10 };
    const o = db.prepare(`INSERT INTO orders (user_id, pickup_at, status, subtotal_cents, discount_cents, total_cents, reward_id, created_at)
      VALUES (?, ?, 'picked_up', ?, ?, ?, ?, ?)`);
    const oi = db.prepare('INSERT INTO order_items (order_id, menu_item_id, qty, unit_price_cents) VALUES (?, ?, ?, ?)');
    const s = db.prepare('INSERT INTO shifts (user_id, clock_in, clock_out) VALUES (?, ?, ?)');
    // Milk drinks get a milk choice (mostly whole milk, every 4th oat or almond) so the stats have something to count.
    const milkOf = db.prepare(`SELECT o.id, o.name, o.price_cents, o.is_default FROM menu_item_modifier_groups l
      JOIN modifier_groups g ON g.id = l.group_id AND g.name = 'Milch' JOIN modifier_options o ON o.group_id = g.id WHERE l.menu_item_id = ?`);
    const om = db.prepare("INSERT INTO order_item_modifiers (order_item_id, option_id, group_name, name, price_cents) VALUES (?, ?, 'Milch', ?, ?)");
    const pickMilk = (itemId, h) => {
      const opts = milkOf.all(itemId);
      if (!opts.length) return null;
      const want = h % 8 === 0 ? 'Hafermilch' : h % 8 === 4 ? 'Mandelmilch' : null;
      return opts.find((x) => x.name === want) ?? opts.find((x) => x.is_default) ?? opts[0];
    };
    const walkIn = db.prepare("SELECT id FROM users WHERE member_id = 'SASU-1006'").get().id;
    for (let d = 1; d <= 30; d++) {
      const guestOrders = 80 + ((d * 7) % 25); // about 1.000 € a day
      for (const [n, userId] of [[4, 4], [5, 5], [6, 6], ...Array.from({ length: guestOrders }, (_, k) => [k + 10, k % 3 ? walkIn : regulars[(d + k) % regulars.length]])]) {
        const guest = userId === walkIn || regulars.includes(userId);
        if (!guest && (d + userId) % 3) continue;
        const picks = [items[(d * n) % items.length], items[(d + n * 7) % items.length]];
        const milk = picks.map((i, k) => pickMilk(i.id, d + n + k));
        const lines = picks.map((i, k) => ({ ...i, price_cents: i.price_cents + (milk[k]?.price_cents ?? 0), qty: 1 }));
        const reward = !guest && d % 4 === 0 ? rewards.find((r) => lines.some((l) => l.category === r.category_allowed)) : null;
        const price = priceOrder(lines, reward ?? null, TIER_PCT[userId] ?? 0);
        const at = daysAgo(d, RUSH_HOURS[(n * 7 + d) % RUSH_HOURS.length]);
        const { lastInsertRowid } = o.run(userId, at, price.subtotal, price.discount, price.total, reward?.id ?? null, at);
        lines.forEach((l, k) => {
          const line = oi.run(lastInsertRowid, l.id, 1, l.price_cents).lastInsertRowid;
          if (milk[k]) om.run(line, milk[k].id, milk[k].name, milk[k].price_cents);
        });
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
      if (!isOpenAt(berlinTime(date, 12))) continue; // closed days get no shifts
      const weekend = [0, 6].includes(new Date(`${date}T12:00:00Z`).getUTCDay());
      // Open 9–20: early shift sets up from 8:30, late shift cleans up until 20:30.
      plan.run(team[(2 * d) % team.length], berlinTime(date, 8.5).toISOString(), berlinTime(date, 14.5).toISOString(), 'Frühschicht');
      plan.run(team[(2 * d + 1) % team.length], berlinTime(date, 14.5).toISOString(), berlinTime(date, 20.5).toISOString(), 'Spätschicht');
      if (weekend) plan.run(team[(2 * d + 2) % team.length], berlinTime(date, 11).toISOString(), berlinTime(date, 17).toISOString(), 'Wochenende');
    }

    seedToday(db);
    seedBeans(db);
  });
  const staff = db.prepare("SELECT username, role FROM users WHERE role IN ('admin','staff') ORDER BY member_id").all();
  console.log(`Benutzernamen – Admin: ${staff.filter((u) => u.role === 'admin').map((u) => u.username).join(', ')} · Personal: ${staff.filter((u) => u.role === 'staff').map((u) => u.username).join(', ')}`);
}

// --- today's demo service: 5 orders each Eingegangen / In Zubereitung / Abholbereit / Abgeholt --------
const TODAY_ORDERS = [
  // [member, [[item, qty, [options]]]]
  ['SASU-1003', [['Flat White', 1, ['Hafermilch', 'Extra Shot']], ['Croissant', 1, []]]],
  ['SASU-1004', [['Caramel Latte', 2, ['Mandelmilch']]]],
  ['SASU-1005', [['Cappuccino', 1, ['Vanille']], ['Cheesecake', 1, []]]],
  ['SASU-1006', [['Espresso', 2, []]]],
  ['SASU-1003', [['Iced Caramel Macchiato', 1, ['Hafermilch', 'Viel Eis']]]],
  ['SASU-1004', [['Chai Latte', 1, ['Laktosefrei']], ['Zimtschnecke', 1, []]]],
  ['SASU-1005', [['Cortado', 1, ['Extra Shot']]]],
  ['SASU-1006', [['Americano', 1, []], ['Schoko-Cookie', 2, []]]],
  ['SASU-1003', [['Matcha Kaffee', 1, ['Hafermilch', 'Haselnuss']]]],
  ['SASU-1004', [['Cold Brew', 1, ['Wenig Eis']], ['Vegan Brownie', 1, []]]],
];

function placeDemoOrder(db, memberId, lines, pickupAt, status, createdAt) {
  const user = db.prepare('SELECT * FROM users WHERE member_id = ?').get(memberId);
  const item = db.prepare('SELECT * FROM menu_items WHERE name = ?');
  const option = db.prepare(`SELECT o.*, g.name group_name FROM modifier_options o JOIN modifier_groups g ON g.id = o.group_id
    JOIN menu_item_modifier_groups l ON l.group_id = g.id WHERE l.menu_item_id = ? AND o.name = ?`);
  const full = lines.map(([name, qty, opts]) => {
    const m = item.get(name);
    return { ...m, qty, mods: opts.map((o) => option.get(m.id, o)).filter(Boolean) };
  });
  const pct = user.lifetime_points >= 500 ? 10 : user.lifetime_points >= 200 ? 5 : 0;
  const price = priceOrder(full, null, pct);
  const orderId = db.prepare(`INSERT INTO orders (user_id, pickup_at, status, subtotal_cents, discount_cents, total_cents, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)`)
    .run(user.id, pickupAt, status, price.subtotal, price.discount, price.total, createdAt).lastInsertRowid;
  for (const l of full) {
    const unit = l.price_cents + l.mods.reduce((a, o) => a + o.price_cents, 0);
    const oi = db.prepare('INSERT INTO order_items (order_id, menu_item_id, qty, unit_price_cents) VALUES (?, ?, ?, ?)').run(orderId, l.id, l.qty, unit).lastInsertRowid;
    for (const o of l.mods) db.prepare('INSERT INTO order_item_modifiers (order_item_id, option_id, group_name, name, price_cents) VALUES (?, ?, ?, ?, ?)').run(oi, o.id, o.group_name, o.name, o.price_cents);
  }
  return orderId;
}

function seedToday(db) {
  const now = Date.now();
  // upcoming pickups: the next 15 free slots, one order each (capacity stays fine)
  const next = [];
  for (let t = Math.ceil((now + 20 * 60e3) / 900e3) * 900e3; next.length < 15; t += 900e3) {
    if (!validatePickup(new Date(t), new Date(now))) next.push(new Date(t).toISOString());
  }
  // already picked up: the last 5 opening-hour slots before now
  const past = [];
  for (let t = Math.floor(now / 900e3) * 900e3 - 900e3; past.length < 5; t -= 900e3) {
    if (isOpenAt(new Date(t))) past.push(new Date(t).toISOString());
  }
  // today's early shift (Elif) is still running, so "Heute" has labor cost too
  const today = new Date(now).toLocaleDateString('en-CA', { timeZone: 'Europe/Berlin' });
  const open = berlinTime(today, 8.5).getTime(), close = berlinTime(today, 20.5).getTime();
  db.prepare("INSERT INTO shifts (user_id, clock_in, clock_out) SELECT id, ?, ? FROM users WHERE member_id = 'SASU-1009'")
    .run(new Date(Math.min(open, now - 3600e3)).toISOString(), now > close ? new Date(close).toISOString() : null);
  const lena = db.prepare("SELECT id FROM users WHERE member_id = 'SASU-1001'").get().id;
  const event = db.prepare('INSERT INTO order_events (order_id, user_id, status, at) VALUES (?, ?, ?, ?)');
  const plan = [
    ...past.map((at) => ['picked_up', at]),
    ...next.slice(0, 5).map((at) => ['ready', at]),
    ...next.slice(5, 10).map((at) => ['preparing', at]),
    ...next.slice(10, 15).map((at) => ['new', at]),
  ];
  plan.forEach(([status, at], i) => {
    const [member, lines] = TODAY_ORDERS[i % TODAY_ORDERS.length];
    const created = new Date(Math.min(now - 60e3 * (20 - i), Date.parse(at) - 20 * 60e3)).toISOString();
    const id = placeDemoOrder(db, member, lines, at, status, created);
    const steps = { preparing: ['preparing'], ready: ['preparing', 'ready'], picked_up: ['preparing', 'ready', 'picked_up'] }[status] ?? [];
    steps.forEach((st, k) => event.run(id, lena, st, new Date(Date.parse(created) + (k + 1) * 4 * 60e3).toISOString()));
  });
}

// --- 5 bean subscriptions with a month of handouts ------------------------------------------
function seedBeans(db) {
  const today = new Date().toLocaleDateString('en-CA', { timeZone: 'Europe/Berlin' });
  const id = (m) => db.prepare('SELECT id FROM users WHERE member_id = ?').get(m).id;
  const subs = [
    ['SASU-1003', 'espresso', '250g', 2, 2, 'active'],
    ['SASU-1004', 'filter', '1kg', 4, 5, 'active'],
    ['SASU-1005', 'decaf', '250g', 1, 1, 'active'],
    ['SASU-1005', 'espresso', '1kg', 2, 9, 'active'],
    ['SASU-1004', 'espresso', '250g', 2, 3, 'paused'],
  ];
  const ins = db.prepare('INSERT INTO bean_subscriptions (user_id, bean, size, every_weeks, next_pickup, status, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)');
  const sale = db.prepare('INSERT INTO bean_sales (subscription_id, user_id, bean, size, price_cents, at) VALUES (?, ?, ?, ?, ?, ?)');
  for (const [member, bean, size, every, inDays, status] of subs) {
    const next = addWeeks(today, 0).slice(0, 10);
    const nextPickup = new Date(Date.parse(`${next}T00:00:00Z`) + inDays * 864e5).toISOString().slice(0, 10);
    const uid = id(member);
    const subId = ins.run(uid, bean, size, every, nextPickup, status, new Date(Date.now() - 40 * 864e5).toISOString()).lastInsertRowid;
    // handouts in the past, one per interval, within the last 30 days
    for (let back = every * 7 - inDays; back <= 30; back += every * 7) {
      if (back <= 0) continue;
      sale.run(subId, uid, bean, size, BEAN_PRICES[bean][size], berlinTime(new Date(Date.now() - back * 864e5).toISOString().slice(0, 10), 10).toISOString());
    }
  }
}
