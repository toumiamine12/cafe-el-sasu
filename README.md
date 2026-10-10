# Café el Sasu — Online-Vorbestellung

A full-stack preorder app for a café in Krefeld. Customers log in with a member ID, order coffee and cakes for pickup, collect points and unlock rewards. Staff run the order queue and clock their hours, and the owner sees the finances.

Built with **Node.js, Express and SQLite** (`node:sqlite`). The frontend is plain HTML/CSS/JS on top of the original Bootstrap 3 site, with no build step. The only runtime dependency is `express`.

| Speisekarte | Item details |
|---|---|
| ![Menu](docs/screenshots/menu.png) | ![Item](docs/screenshots/item.png) |
| **Member account** | **Admin finance** |
| ![Account](docs/screenshots/account.png) | ![Finance](docs/screenshots/admin-finance.png) |

## Features

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
- Account page: welcome banner, member card, stats (orders, total spent, favorite), full purchase history with receipts, reorder in one click
- Edit name, email and birthday; change password (signs out other devices)

**Loyalty**
- 1 point per €1, credited when the order is picked up
- Tiers by lifetime points: **Bronze** → **Silver** (200, 5 % off) → **Gold** (500, 10 % off)
- Rewards: free pastry (50), free coffee (100), free cake (250), birthday coffee for Gold members
- Redeeming never drops your tier; cancelling refunds the reward points

**Staff & admin** (`/admin.html`)
- Order queue: Eingegangen → In Zubereitung → Abholbereit → Abgeholt
- Clock in/out, hours per person for the last 7 and 30 days
- Admin only: revenue, wage cost, profit, order count, average order value, top 5 items (today / 7 / 30 days)
- Admin only: edit prices, hide items, add new items

**Security basics**: scrypt-hashed passwords, HttpOnly session cookies, prices always taken from the database, server-side role checks on every admin route, and all user text escaped before rendering.

## Run locally

Needs Node.js 22.13 or newer.

```bash
npm install
npm start          # http://localhost:3000
npm test           # 39 API + rules tests
```

The database (`data/cafe.db`) is created and filled with demo data on first start. Delete `data/` to reset.

### Demo logins

| Role | Member ID | Password |
|---|---|---|
| Admin | `SASU-1000` | `admin123` |
| Staff | `SASU-1001` | `staff123` |
| Customer (Bronze) | `SASU-1003` | `demo123` |
| Customer (Silver) | `SASU-1004` | `demo123` |
| Customer (Gold) | `SASU-1005` | `demo123` |

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
public/              the website (HTML/CSS/JS, photos)
test/                node --test suites
```

## Photo credits

The photos of 30 menu items come from Wikimedia Commons and Flickr under Creative Commons licenses; each one is credited on `/credits.html`. All other photos belong to Café El Sasu.

## Next ideas

- QR code on the member card to scan at the counter
- Invite a friend: both get 50 points
- Limit orders per pickup slot so the kitchen isn't flooded
- Online payment (Stripe) and email confirmations
