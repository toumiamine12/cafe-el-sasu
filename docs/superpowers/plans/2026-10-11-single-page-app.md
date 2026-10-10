# Single-Page App & Unified Login Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Serve the whole site from `index.html` with hash routes and one login that routes by role.

**Architecture:** `index.html` holds navbar, `<main id="view">`, footer and one `<template>` per view. `router.js` maps `location.hash` to an ES-module view `{ title, hero, auth, mount(root), unmount() }`, runs guards, swaps the template. `app.js` keeps shared helpers and a `session` object that re-renders the navbar.

**Tech Stack:** Plain ES modules in the browser, Express static + redirects, `node --test`, Playwright (scratchpad only) for browser checks.

**Spec:** `docs/superpowers/specs/2026-10-11-single-page-app-design.md`

## Global Constraints

- Routes: `#/`, `#/speisekarte`, `#/warenkorb`, `#/login`, `#/konto`, `#/admin`, `#/bildnachweise`. Unknown → `#/`.
- Guards: `auth: 'user'` needs login; `auth: 'staff'` needs role `staff`|`admin`, customers → `#/konto`. Not logged in → `#/login?next=<route>`.
- Login redirect: customer → `#/konto`, staff/admin → `#/admin`, or `next` if the role may open it.
- Hero (transparent navbar): `#/`, `#/speisekarte`, `#/konto`.
- Old `.html` URLs 301 to their hash route (table in spec).
- No new runtime dependencies. UI text stays German. Commits as toumiamine12, short message, no co-author line.

## Review Focus

1. Leaving `#/konto` or `#/admin` → no more `/api/orders` or `/api/admin/orders` polling. (Task 4/5 browser check)
2. Logging in/out → navbar name/Login pill updates without reload. (Task 4 browser check)
3. `#/login?next=%23%2Fadmin` as a customer → lands on `#/konto`, not a loop. (Task 4 browser check)
4. Refresh on `#/speisekarte` and back button between views → correct view each time. (Task 3 browser check)
5. Menu category buttons scroll without changing the hash. (Task 3 browser check)

---

### Task 1: Server redirects + login role

**Files:** Modify `server/app.js`; Test `test/api.test.js`

- [ ] **Step 1:** Add tests: `login returns role for each account type` (SASU-1003 → `customer`, SASU-1001 → `staff`, SASU-1000 → `admin`); `old page URLs redirect to hash routes` — for each pair in the spec table, `fetch(base + old, { redirect: 'manual' })` → status 301 and `location` header equal to the hash URL.
- [ ] **Step 2:** `npm test` → the redirect test FAILs (role test already passes; that's existing behaviour being pinned).
- [ ] **Step 3:** In `createApp`, before `express.static`, register `app.get(old, (req, res) => res.redirect(301, target))` for each pair.
- [ ] **Step 4:** `npm test` → all PASS.
- [ ] **Step 5:** Commit "Redirect old page URLs to hash routes".

### Task 2: App shell, router, session, home view

**Files:** Create `public/router.js`, `public/views/home.js`; Modify `public/index.html`, `public/app.js`

**Interfaces — Produces:**
- `app.js` (module): `export { api, euro, esc, cart, toast, STATUS, session }`; `session.get(): Promise<User|null>` (cached), `session.refresh(): Promise<User|null>` (refetch + re-render navbar). Navbar links use `#/…`.
- `router.js`: `export function go(hash)`; on `hashchange` and load: parse `#/<path>?<query>` → `{ path, params: URLSearchParams }`; route table `{ '': home, speisekarte: menu, warenkorb: cart, login, konto: account, admin, bildnachweise: credits }`.
- View contract: `{ title: string, hero: boolean, auth?: 'user'|'staff', mount(root: HTMLElement, params: URLSearchParams): void|Promise, unmount?(): void }`. Template id `tpl-<route key or 'home'>`.

- [ ] **Step 1:** Move home markup into `<template id="tpl-home">`; index body = navbar + `<main id="view">` + footer + `<script type="module" src="router.js">`. Convert `home.js` to `views/home.js` (`mount` does what the old file did at load).
- [ ] **Step 2:** Browser check: `#/` renders status, popular items, loyalty; no console errors.
- [ ] **Step 3:** Commit "Add hash router and app shell; home as first view".

### Task 3: Menu + cart views

**Files:** Create `public/views/menu.js`, `public/views/cart.js`; Modify `public/index.html` (templates)

- [ ] **Step 1:** Templates `tpl-speisekarte`, `tpl-warenkorb` from old pages; dialog + cart bar live inside the menu template. Category nav: `<button data-cat>` → `section.scrollIntoView()`. `unmount` disconnects the IntersectionObserver.
- [ ] **Step 2:** Browser check: add item via dialog and quick-add, cart bar total, search, category button keeps hash `#/speisekarte`, refresh stays on menu, back button returns to `#/`; checkout as logged-out shows login link to `#/login?next=%23%2Fwarenkorb`.
- [ ] **Step 3:** Commit "Menu and cart as SPA views".

### Task 4: Login + account views

**Files:** Create `public/views/login.js`, `public/views/account.js`; Modify `public/index.html`

- [ ] **Step 1:** Login view: one form + register toggle; on success `await session.refresh()` then `go(next allowed for role || roleHome)`. Logged-in state shows "Eingeloggt als <Name> (<Kunde|Personal|Admin>)" + Weiter/Ausloggen.
- [ ] **Step 2:** Account view: tabs in-view (no hash per tab); polling timer cleared in `unmount`; logout → `session.refresh()` + `go('#/')`; profile save → `session.refresh()`.
- [ ] **Step 3:** Browser check: customer/staff/admin each land on the right route; navbar updates without reload; Review Focus 1–3.
- [ ] **Step 4:** Commit "Unified login routing by role; account as SPA view".

### Task 5: Admin + credits views, delete old pages

**Files:** Create `public/views/admin.js`, `public/views/credits.js`; Delete `public/{menu,order,login,account,admin,credits,about}.html`, old page scripts; Modify `public/index.html`

- [ ] **Step 1:** Admin view without login gate (`auth: 'staff'`); admin-only tabs hidden for staff; order polling cleared in `unmount`. Credits view from old page.
- [ ] **Step 2:** Browser check: staff advances an order to picked up, customer points rise; admin finance renders; `#/admin` logged out → `#/login?next=…`; customer → `#/konto`; phone layout no horizontal scroll; zero console errors across all flows.
- [ ] **Step 3:** `npm test` all PASS. Update README (routes, single login). Commit "Admin and credits as SPA views; remove old pages". Push.
