# Café el Sasu — Single-Page App & Unified Login: Design

Date: 2026-10-11
Status: approved in chat, awaiting written-spec review

## Goal

1. The whole site runs from one page (`index.html`) at one address, with hash routes (`localhost:3000/#/…`). No full page reloads when navigating.
2. One login form for every account type. The account's role decides where the user lands.

## Routes

| Hash | View | Access | Navbar over photo |
|---|---|---|---|
| `#/` | Startseite | public | yes |
| `#/speisekarte` | Menu | public | yes |
| `#/warenkorb` | Cart + checkout | public (placing an order needs login) | no |
| `#/login` | Login / register | public | no |
| `#/konto` | Account | logged in | yes |
| `#/admin` | Dashboard | role `staff` or `admin` | no |
| `#/bildnachweise` | Photo credits | public | no |

- Unknown hash → `#/`.
- Guarded route without login → `#/login?next=<route>`; after login, go to `next` if the user's role may open it, else the role's home.
- `#/admin` with a customer account → `#/konto`. `#/konto` with a staff/admin account is allowed (staff can also order).
- Account tabs stay inside the view (no route per tab).

## Architecture

- `public/index.html`: `<head>`, navbar, `<main id="view">`, footer, and one `<template id="tpl-<name>">` per view. It is the only HTML file left in `public/`.
- `public/router.js`: reads `location.hash`, resolves route → view module, runs guards, calls previous view's `unmount()`, clones template into `#view`, calls `mount()`. Sets `document.title`, toggles `body.has-hero`, updates nav `aria-current`, scrolls to top. Listens to `hashchange`.
- `public/app.js`: shared helpers (`api`, `euro`, `esc`, `cart`, `toast`, `STATUS`) + navbar rendering. Exposes `session.get()` (cached `/api/me`) and `session.refresh()` that re-renders the navbar; used after login/logout/profile change.
- View scripts become ES modules exporting `{ title, hero, auth, mount(root), unmount() }`:
  `views/home.js`, `views/menu.js`, `views/cart.js` (was order.js), `views/login.js`, `views/account.js`, `views/admin.js`, `views/credits.js`.
  `auth`: `undefined` (public), `'user'`, or `'staff'`.
- `unmount()` clears every `setTimeout`/`setInterval`/`IntersectionObserver` the view created.
- Internal links use `#/…` hrefs. Menu category nav uses buttons that `scrollIntoView` the section (no `#coffee` anchors).

## Login

- One form: "Mitgliedsnummer oder E-Mail" + password. `POST /api/login` already returns the user with `role`.
- Redirect: customer → `#/konto`, staff/admin → `#/admin` (or `next` if allowed).
- Registration toggle stays; it only creates customers.
- The admin view no longer has its own login gate; the router guard handles it.
- If already logged in, `#/login` shows "Eingeloggt als <Name> (<Rolle>)" with "Weiter" and "Ausloggen".

## Server

- Redirects (301 → hash routes): `/menu.html`→`/#/speisekarte`, `/order.html`→`/#/warenkorb`, `/login.html`→`/#/login`, `/account.html`→`/#/konto`, `/admin.html`→`/#/admin`, `/credits.html`→`/#/bildnachweise`, `/about.html`→`/#/`.
- No API changes.

## Removed

`menu.html`, `order.html`, `login.html`, `account.html`, `admin.html`, `credits.html`, `about.html`, and the per-page `<script>` includes.

## Testing

- Existing 39 API/rules tests unchanged and passing.
- New API tests: login response includes `role` for customer/staff/admin; each old page URL returns a 301 to its hash route.
- Browser checks (Playwright, scratchpad): customer order flow, staff order → picked up, admin finance, account profile edit, login redirects per role, guard redirects (`#/admin` logged out → `#/login`, customer → `#/konto`), back button between views, refresh on `#/speisekarte`, phone layout without horizontal scroll, zero console errors, and no 10-second polling requests after leaving `#/konto` / `#/admin`.
