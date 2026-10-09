# Café el Sasu Preorder Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Turn the static café site into a working preorder app with member accounts, points/rewards, and a staff/admin dashboard.

**Architecture:** One Express server serves `public/` statically and a JSON API under `/api`. Pure business rules live in `server/rules.js` (unit-tested); `server/app.js` wires routes to a SQLite DB passed in, so tests run against `:memory:`.

**Tech Stack:** Node 22, Express 4, `node:sqlite` (stdlib), `node:crypto` scrypt for password hashing, `node --test`.

**Spec:** `docs/superpowers/specs/2026-10-10-cafe-preorder-design.md`

**Deviations from spec (stdlib-first):** `node:sqlite` replaces `better-sqlite3`; `crypto.scrypt` replaces `bcrypt`; a `sessions` table + random token in an `HttpOnly` cookie replaces `express-session`. Only runtime dependency: `express`.

## Global Constraints

- Money in integer cents everywhere; format as `x,xx €` only in the browser.
- Opening hours, Europe/Berlin time: Mon closed, Tue–Fri 11:00–22:00, Sat–Sun 10:00–24:00. Pickup ≥ 15 min from now.
- Tiers by `lifetime_points`: Bronze 0 (0%), Silver 200 (5%), Gold 500 (10%).
- Points: `floor(total_cents / 100)`, credited to `points` and `lifetime_points` when status becomes `picked_up`.
- Rewards: Free cookie 50 (category `pastry`), Any coffee 100 (`coffee`), Any cake 250 (`cake`), Birthday coffee 0 (`coffee`, Gold + birthday only).
- Reward first (cheapest matching cart item free, one unit), then tier % on remainder, rounded down to the cent.
- Prices always read from DB; client-sent prices ignored.
- Member IDs `SASU-1000` upward. Login accepts member ID or email.
- UI text stays German, matching the existing site.

## Review Focus

1. Cart contains an item that is inactive or does not exist → 400 "Artikel nicht verfügbar", no order created. (Task 3)
2. Quantity 0, negative, or non-integer → 400. (Task 3)
3. Customer tries to cancel someone else's order or one already `preparing` → 404 / 409. (Task 3)
4. Status moved to `picked_up` twice → points credited only once. (Task 4)
5. Clock out with no open shift / clock in twice → toggle never leaves two open shifts. (Task 4)

---

### Task 1: Scaffold + business rules

**Files:**
- Create: `package.json`, `server/rules.js`, `test/rules.test.js`
- Modify: `.gitignore` (add `node_modules/`, `data/`, `.idea/`)

**Interfaces — Produces:**
- `tierFor(lifetimePoints: number) -> {name: 'Bronze'|'Silver'|'Gold', discountPct: 0|5|10, next: number|null}`
- `isOpenAt(date: Date) -> boolean` (Berlin time via `Intl.DateTimeFormat`)
- `validatePickup(pickupAt: Date, now: Date) -> string|null` (error message or null)
- `priceOrder(lines: {price_cents, qty, category}[], reward: {category_allowed}|null, discountPct) -> {subtotal, discount, total}` (throws `Error('reward_no_match')`)
- `pointsFor(totalCents) -> number`

- [ ] **Step 1: Write failing tests** `test/rules.test.js`:
  - `tierFor(199).name === 'Bronze'`, `tierFor(200).name === 'Silver'`, `tierFor(500).discountPct === 10`, `tierFor(500).next === null`
  - Monday 12:00 Berlin closed; Tuesday 10:59 closed, 11:00 open; Sunday 23:59 open; Tuesday 22:00 closed
  - `validatePickup(now+10min, now)` returns error; `now+20min` on open hours returns null
  - `priceOrder([{price_cents:499,qty:2,category:'coffee'},{price_cents:699,qty:1,category:'cake'}], {category_allowed:'coffee'}, 10)` → `{subtotal:1697, discount: 499 + floor(1198*0.10)=618, total:1079}`
  - reward `cake` with no cake in cart throws `reward_no_match`
  - `pointsFor(1079) === 10`
- [ ] **Step 2:** `npm test` → FAIL (module not found)
- [ ] **Step 3:** `npm init -y`, `npm i express`, set `"type": "module"`, scripts `start: node server.js`, `test: node --test`. Implement `server/rules.js`.
- [ ] **Step 4:** `npm test` → PASS
- [ ] **Step 5:** Commit

### Task 2: Database schema + seed

**Files:**
- Create: `server/db.js`, `server/seed.js`

**Interfaces — Produces:**
- `openDb(file = 'data/cafe.db') -> DatabaseSync` — creates tables from the spec + `sessions(token PK, user_id, expires_at)`, `PRAGMA foreign_keys=ON`, seeds if `menu_items` is empty.
- `hashPassword(pw) -> 'salt:hash'`, `verifyPassword(pw, stored) -> boolean` (scrypt, `timingSafeEqual`)
- Seed: 16 existing items with exact current names/prices/photos from `main2.html` + 15 new ones (Flat White, Chai Latte, Pistachio Latte, Cold Brew, Espresso, Americano, Caramel Latte, Iced Matcha Latte; San Sebastián Cheesecake, Red Velvet, Künefe, Zimtschnecke, Brownie, Schoko-Cookie, Croissant). Users: `admin` SASU-1000 / `admin123` (role admin), 2 staff (`staff123`, wage 1400 cents), 3 customers (`demo123`) with lifetime 80 / 260 / 620 points, a few `picked_up` orders and shifts in the past 30 days so finance is non-empty.

- [ ] **Step 1:** Add test to `test/rules.test.js`: `openDb(':memory:')` has ≥ 31 active menu items, `verifyPassword('admin123', adminRow.password_hash) === true`, wrong pw → false.
- [ ] **Step 2:** Run → FAIL
- [ ] **Step 3:** Implement
- [ ] **Step 4:** Run → PASS
- [ ] **Step 5:** Commit

### Task 3: Auth + customer API

**Files:**
- Create: `server/app.js`, `server.js`, `test/api.test.js`

**Interfaces:**
- Produces: `createApp(db) -> express.Application`. `server.js`: `createApp(openDb()).listen(process.env.PORT || 3000)`, serves `public/`.
- Middleware `requireRole(...roles)` → 401 if no session, 403 if wrong role.
- Routes per spec: register, login, logout, me, menu, rewards (filtered: birthday reward only for Gold on birthday), orders (create, list own, cancel).
- `POST /api/orders` body `{items:[{id, qty}], pickup_at: ISO, reward_id?}`; deducts reward points in the same transaction as the insert.

- [ ] **Step 1:** Failing tests in `test/api.test.js` (start app on port 0 with `openDb(':memory:')`, use `fetch` + cookie):
  - register → `member_id` matches `/^SASU-\d{4,}$/`; login by member ID and by email works; wrong pw → 401
  - order with `price_cents: 1` in body → stored total equals DB price
  - reward with too few points → 400; pickup Monday → 400
  - Review Focus 1–3: inactive item → 400; qty 0 → 400; cancel other user's order → 404; cancel with reward refunds points
  - customer `GET /api/admin/orders` → 403
- [ ] **Step 2:** Run → FAIL
- [ ] **Step 3:** Implement
- [ ] **Step 4:** Run → PASS
- [ ] **Step 5:** Commit

### Task 4: Staff/admin API

**Files:**
- Modify: `server/app.js`, `test/api.test.js`

**Interfaces — Produces:** routes per spec. `GET /api/admin/finance?range=day|week|month` → `{revenue, wages, profit, orders, top:[{name, qty}]}` (cents). `GET /api/admin/shifts` → per staff `{name, member_id, open: boolean, hours_week, hours_month}`; staff sees only self, admin sees all.

- [ ] **Step 1:** Failing tests: staff can PATCH status, cannot GET finance (403); `picked_up` credits `pointsFor(total)` once even if PATCHed twice; clock toggle twice → one closed shift; finance revenue equals sum of seeded picked_up totals in range.
- [ ] **Step 2–4:** FAIL → implement → PASS
- [ ] **Step 5:** Commit

### Task 5: Customer frontend

**Files:**
- Move: all current `*.html`, `*.css`, `*.js`, `photos/` → `public/`
- Rename: `main2.*` → `menu.*`, `main3.*` → `about.*` (update links)
- Create: `public/app.js` (nav login state, cart in localStorage, `api(path, opts)` helper, `euro(cents)`), `public/login.html`, `public/account.html`, `public/order.html`, `public/shop.css`
- Modify: `public/menu.html` (render from `/api/menu`, category tabs, tags, add-to-cart; slideshows replaced by grid), `public/index.html` (offer buttons add to cart; Google Maps embed `https://www.google.com/maps?q=Einestraße+1a+47799+Krefeld&output=embed`; "Bewerte uns auf Google" link), `public/about.html` (nav)
- Account page: member card, tier progress bar to `next`, rewards list, order history with "Nochmal bestellen" and status polling every 10 s while any order is `new`/`preparing`/`ready`.

- [ ] **Step 1:** `npm start`, then manually: register → add 2 items → order for a valid time → account shows order `new`. Curl every page → 200.
- [ ] **Step 2:** Commit

### Task 6: Admin frontend

**Files:**
- Replace: `public/admin.html`, `public/admin.js`, `public/admin.css` (delete `admin123` client check)

Tabs: Bestellungen (list open orders, buttons to advance status), Personal (clock button, hours table), Finanzen (admin: range switch, 4 numbers, top 5), Speisekarte (admin: edit price/active, add item). Hide admin-only tabs for staff.

- [ ] **Step 1:** Manual: login as staff → advance demo order to `picked_up` → customer points rise; admin sees finance.
- [ ] **Step 2:** Commit

### Task 7: Docs + deploy

**Files:**
- Modify: `README.md` (features, screenshots placeholder removed — none, demo logins, `npm i && npm start`, `npm test`, Render deploy, next ideas list)
- Create: `render.yaml` (web service, `npm ci`, `npm start`, Node 22)

- [ ] **Step 1:** `npm test` all PASS; fresh `rm -rf data && npm start` boots and seeds.
- [ ] **Step 2:** Disable GitHub Pages (`gh api -X DELETE repos/toumiamine12/cafe-el-sasu/pages`), commit, push.
