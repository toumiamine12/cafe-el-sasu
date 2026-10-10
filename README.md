# Café el Sasu — Online-Vorbestellung

A full-stack preorder app for a café in Krefeld. Customers log in with a member ID, order coffee and cakes for pickup, collect points and unlock rewards. Staff run the order queue and clock their hours, and the owner sees the finances.

Built with **Node.js, Express and SQLite** (`node:sqlite`). The frontend is plain HTML/CSS/JS on top of the original Bootstrap 3 site, with no build step. The only runtime dependency is `express`.

| Speisekarte | Item details |
|---|---|
| ![Menu](docs/screenshots/menu.png) | ![Item](docs/screenshots/item.png) |
| **Member account** | **Admin finance** |
| ![Account](docs/screenshots/account.png) | ![Finance](docs/screenshots/admin-finance.png) |

## Features

**One app, one login**
- Single-page app: everything runs from `index.html` with hash routes — `#/`, `#/speisekarte`, `#/warenkorb`, `#/login`, `#/konto`, `#/admin`, `#/bildnachweise`. No page reloads; back button, refresh and bookmarks work.
- One login form for customers, staff and admin. The account decides where you land: customers → `#/konto`, staff/admin → `#/admin`. Protected routes send you to login and back.

**Startseite**
- Live status: "Jetzt geöffnet · bis 22:00 Uhr" or when it opens next, plus the earliest pickup time
- "Beliebt diese Woche": the real top 4 best-sellers of the last 7 days, addable to the cart
- How it works in 3 steps, loyalty tiers (highlights your own tier when logged in), "repeat last order" button
- Über uns with photo gallery, map and opening hours with today highlighted

**Customers**
- Register and get a member ID (`SASU-1007`, …); log in with the member ID or email
- Menu of 49 items laid out like a printed café menu: sticky category bar, search, item popup with quantity, allergen/vegan tags, floating cart bar
- Preorder for pickup: only valid 15-minute slots inside opening hours, at least 15 min ahead
- Pay at pickup, cancel while the order is still "Eingegangen"
- Live order status on the account page (refreshes every 10 s, toast when ready)
- Account page: welcome banner, member card with QR code (tap to enlarge at the counter), stats (orders, total spent, favorite), full purchase history with receipts, reorder in one click
- Edit name, email and birthday; change password (signs out other devices)

**Speed dial**
- "Das Übliche": the guest's most-ordered exact drink (with options) as a one-tap hero button; checkout preselects their usual pickup time
- Favorites: star any customised drink in the item popup; one tap from the account puts it in the cart
- Preferences: preferred milk preselected in every drink, optional vegan-only Speisekarte

**Live order pulse**
- Progress bar Eingegangen → In Zubereitung → Abholbereit with a countdown to pickup
- "Dein Kaffee ist ready!" banner on every page the moment an order is ready

**Bean subscription & gifts**
- Bohnen-Abo: whole beans (Espresso, Filter, Decaf; 250 g / 1 kg) reserved every 1, 2 or 4 weeks for pickup; pause, skip or cancel; staff see what's due
- Kaffee verschenken: a coffee-of-choice voucher paid with 100 points or 5 € at the counter (staff activate it); shared as link + QR via WhatsApp / e-mail; the friend redeems it at checkout

**Loyalty**
- 1 point per €1, credited when the order is picked up
- Tiers by lifetime points: **Bronze** → **Silver** (200, 5 % off) → **Gold** (500, 10 % off)
- Rewards: free pastry (50), free coffee (100), free cake (250), birthday coffee for every member during their birthday week (with a banner)
- Treuepass: stamp card towards the next reward ("noch etwa 3 Bestellungen bis Gratis Kuchen"); tier card with the discount that's applied automatically
- "Karte aufs Handy": the member card with QR as a phone-sized image, and the site can be added to the home screen (web app manifest). Real Apple/Google Wallet passes need paid developer accounts and aren't included
- Redeeming never drops your tier; cancelling refunds the reward points

**Item options**
- Milk (Vollmilch, Hafer +0,50 €, Mandel +0,50 €, Laktosefrei +0,30 €), syrup (+0,40 €), extra shot (+0,80 €), ice level
- Picked in the item popup with a live price; shown as badges in the cart, receipts and the kitchen display
- Prices and options are validated on the server and copied onto each order line (later price changes don't touch old receipts); a reward makes the base price free, options are still charged

**Pickup capacity**
- At most 5 orders per 15-minute window (owner can change it); full windows show as "Ausgebucht" in checkout
- Checked inside the same write transaction as the order, so two guests can't take the last place

**Staff & admin** (`#/admin`)
- Kitchen display: high-contrast ticket grid with big pickup times, customer names and bright option badges (HAFERMILCH, EXTRA SHOT); one tap moves a ticket Neu → In Arbeit → Abholbereit → Abgeholt
- Rush controls for staff: pause online orders, or push the earliest pickup from 15 to 30 minutes
- Member lookup: scan the member-card QR (camera via the browser's BarcodeDetector, or a USB scanner) or type the SASU number to see that guest's open orders
- "Ausverkauft" switches: sold-out items stay on the Speisekarte, greyed out, and can't be ordered
- Clock in/out, hours per person for the last 7 and 30 days
- Admin only: revenue, wage cost, profit, order count, average order value, top 5 items (today / 7 / 30 days)
- Admin only: full menu editor (name, description, category, price, allergen tags, photo path or https URL), hide/show, delete (never-ordered items are removed, ordered ones hidden)
- Admin only: staff management — create staff with a temporary password (changed at first login), set hourly wages, deactivate accounts (signs them out, ends a running shift)
- Admin only: shift table with clock-in/out, hours and wage cost per shift and per employee
- Admin only: payroll export — one CSV per month (Name; Mitgliedsnr; Datum; Beginn; Ende; Pause; Netto-Stunden; Stundenlohn; Lohn) with totals per employee, ready for Excel / the payroll office
- Dienstplan (rota): week grid of planned shifts; the owner adds and removes shifts (no overlaps, max 12 h), staff see it read-only, and the kitchen display shows who's on today

**Meine Zeit (every staff member)**
- Live shift card: clocked in since…, worked time, Pause starten/beenden (breaks are unpaid), reminder when the legal break (30 min after 6 h, 45 min after 9 h) is still open
- This week's and month's net hours, earnings at your wage, orders you handled
- 14-day hours chart, your next planned shifts, and the full history with breaks, net hours and pay

**Security**
- scrypt-hashed passwords (min. 8 characters), HttpOnly SameSite session cookies (Secure in production)
- Login throttling: 5 wrong passwords per account / 20 per IP → 15-minute pause
- Content-Security-Policy (only own scripts), no framing, `nosniff`, strict referrer policy, no `X-Powered-By`
- Cross-site request protection: writes must be JSON from the site's own origin
- Server-side role checks: admin routes for staff/admin only; ordering, rewards and member card for customers only
- Prices always from the database, parameterised SQL, all user text escaped before rendering
- No staff/admin passwords in the code (env vars or generated on first start)

## Run locally

Needs Node.js 22.13 or newer.

```bash
npm install
npm start          # http://localhost:3000
npm test           # 104 API + rules tests
```

The database (`data/cafe.db`) is created and filled with demo data on first start. Delete `data/` to reset.

### Logins

| Role | Login | Password |
|---|---|---|
| Demo customer | `SASU-1004` or `mehmet@example.com` | `demo123` |
| Admin | `SASU-1000` | `ADMIN_PASSWORD` env var |
| Staff (7) | `SASU-1001`, `SASU-1002`, `SASU-1007` … `SASU-1011` | `STAFF_PASSWORD` env var |

Staff and admin passwords are never stored in the code. Set them as environment variables; if they're missing on first start, the server generates random ones and prints them once in the terminal.

## Deploy (free, Render)

1. Push this repo to GitHub
2. On [render.com](https://render.com): **New → Blueprint** → pick the repo (it reads `render.yaml`)
3. Open the `*.onrender.com` URL

The free plan has no persistent disk, so the demo data resets on every restart. That's fine for a demo; a real deployment needs a persistent disk or a hosted database.

## Project structure

```
server.js            entry point
server/app.js        Express routes (auth, orders, admin)
server/rules.js      pure business rules: tiers, opening hours, pricing, points
server/db.js         schema, password hashing
server/seed.js       demo menu, users, a month of order history
public/index.html    the whole site: navbar, footer, one <template> per view
public/router.js     hash router + route guards
public/app.js        shared helpers, session, navbar
public/views/        one module per view (home, menu, cart, login, account, admin, credits)
test/                node --test suites
```

## Photo credits

The photos of 30 menu items come from Wikimedia Commons and Flickr under Creative Commons licenses; each one is credited on `/credits.html`. All other photos belong to Café El Sasu.

## Next ideas

- QR code on the member card to scan at the counter
- Invite a friend: both get 50 points
- Limit orders per pickup slot so the kitchen isn't flooded
- Online payment (Stripe) and email confirmations
