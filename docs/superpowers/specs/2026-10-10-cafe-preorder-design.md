# Café el Sasu — Online Preorder: Design

Date: 2026-10-10
Status: approved in chat, awaiting written-spec review

## Goal

Turn the static café site into a working portfolio project: customers log in with a member ID, preorder menu items for pickup, earn points and rewards; staff/admin manage orders, shifts and see finances.

Audience: GitHub portfolio reviewers. Not a real business deployment (no payments, no GDPR pages).

## Stack

- Node.js + Express
- SQLite via `better-sqlite3` (single file `data/cafe.db`, created and seeded on first start)
- `bcrypt` for password hashing
- `express-session` cookie sessions
- Frontend: plain HTML/CSS/JS + existing Bootstrap 3 styling, calling a JSON API with `fetch`
- Tests: Node built-in test runner (`node --test`)

## Data model

| Table | Columns |
|---|---|
| `users` | id, member_id (unique, `SASU-1000`+), name, email (unique), password_hash, points (int, spendable), lifetime_points (int, for tiers), role (`customer`/`staff`/`admin`), hourly_wage (cents, staff only), birthday (nullable), created_at |
| `menu_items` | id, name, description, category (`coffee`/`cold`/`cake`/`pastry`), price_cents, photo, tags (comma list: `vegan`, `gluten`, `nuts`, `lactose`), active (0/1) |
| `orders` | id, user_id, pickup_at, status (`new`/`preparing`/`ready`/`picked_up`/`cancelled`), subtotal_cents, discount_cents, total_cents, reward_id (nullable), created_at |
| `order_items` | id, order_id, menu_item_id, qty, unit_price_cents |
| `rewards` | id, name, cost_points, category_allowed (nullable — free item of that category) |
| `shifts` | id, user_id, clock_in, clock_out (nullable) |

Money is stored in integer cents.

## Rules

- **Points:** 1 point per full €1 of `total_cents`, credited when an order moves to `picked_up`.
- **Tiers** (by `lifetime_points`):
  - Bronze 0+ — no discount
  - Silver 200+ — 5% off
  - Gold 500+ — 10% off, plus a free coffee on their birthday (0-point reward visible only on that date)
- **Rewards:** free cookie (50), any coffee (100), any cake (250). Redeeming subtracts points at order time; the cheapest matching item in the cart becomes free. Insufficient points or no matching item → 400.
- **Discount order:** reward applied first, then tier % on the remainder.
- **Pickup time:** at least 15 minutes from now, within opening hours (Tue–Fri 11–22, Sat–Sun 10–24, Mon closed). Otherwise 400.
- **Prices** always come from the database; client-sent prices are ignored.
- **Cancel:** customer may cancel while status is `new`; spent reward points are refunded.

## API

Auth: `POST /api/register`, `POST /api/login` (member ID or email + password), `POST /api/logout`, `GET /api/me`.

Customer: `GET /api/menu`, `POST /api/orders`, `GET /api/orders` (own), `POST /api/orders/:id/cancel`, `GET /api/rewards`.

Staff/admin (role check → 403 otherwise): `GET /api/admin/orders`, `PATCH /api/admin/orders/:id` (status), `POST /api/admin/shifts/clock` (toggle own), `GET /api/admin/shifts`.

Admin only: `GET /api/admin/finance?range=day|week|month`, `POST/PATCH /api/admin/menu`.

Finance = revenue from `picked_up` orders in range − wage cost (shift hours × hourly_wage in range), plus top 5 items by quantity.

## Pages

| File | Content |
|---|---|
| `index.html` | Existing home + Google Maps embed + "Rate us on Google" link. No fabricated reviews. |
| `menu.html` (was `main2.html`) | Menu from API, category tabs, allergen/vegan tags, "add to cart" |
| `about.html` (was `main3.html`) | Existing about page |
| `login.html` | Register / login |
| `account.html` | Member card, points, tier progress bar, rewards, order history with reorder + live status (poll 10s) |
| `order.html` | Cart (localStorage), pickup time picker, reward selection, place order |
| `admin.html` | Staff login gate; tabs: Orders, Staff (clock in/out, hours), Finance (admin), Menu (admin) |

Shared `app.js` holds the nav login state + cart helpers. Old client-side `admin123` check is removed.

## Seed data

- Existing 16 menu items + ~15 new ones (flat white, chai latte, pistachio latte, cold brew, San Sebastián cheesecake, cinnamon roll, künefe, red velvet, …). New items reuse existing photos where none fit.
- `admin` account (`SASU-1000`), 2 staff, 3 demo customers with order history across tiers. Demo credentials listed in README.

## Testing

`test/api.test.js` against an in-memory DB:
1. Order total computed server-side ignores client prices
2. Tier discount and points crediting on `picked_up`
3. Redeeming a reward with too few points → 400
4. Pickup time outside opening hours → 400
5. Customer calling `/api/admin/*` → 403

## Deployment

`render.yaml` + README section. GitHub Pages is disabled (no server there).

## Out of scope (README "next ideas")

QR member card, referral bonus, pickup-slot capacity limits, real payments, email notifications.
