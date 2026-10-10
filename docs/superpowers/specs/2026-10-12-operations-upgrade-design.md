# Café el Sasu — Operations Upgrade: Design

Date: 2026-10-12. Approved in chat ("do all of this without stopping").

Five phases, built in this order because later phases build on earlier ones. Existing 48 tests and the rules in `server/rules.js` keep working.

## A. Item modifiers
- Tables: `modifier_groups (id, name, kind 'one'|'many', required, sort)`, `modifier_options (id, group_id, name, price_cents ≥ 0, is_default, sort)`, `menu_item_modifier_groups (menu_item_id, group_id)`, `order_item_modifiers (order_item_id, option_id, group_name, name, price_cents)` — names/prices copied at order time.
- Seed: Milch (one, required, default Vollmilch; Hafer +0,50, Mandel +0,50, Laktosefrei +0,30), Sirup (one, optional; Vanille/Karamell/Haselnuss +0,40), Extra Shot (many; +0,80), Eis (one, required, default Normal; Wenig/Normal/Viel). Coffee + cold drinks get Extra Shot; drinks tagged lactose get Milch + Sirup; cold drinks get Eis.
- `rules.validateModifiers(groups, optionIds)` → chosen options (defaults filled in for required groups) or throws: unknown option, option not offered for the item, two choices in a 'one' group, duplicate.
- `priceOrder`: unit price = base + modifiers. **A reward makes the base price free; modifiers are still charged.**
- `order_items.unit_price_cents` stores base + modifiers. API returns `modifiers` per menu item and per order item.
- Cart lines are `{ id, qty, mods: [optionId…] }`; same item with different options = separate lines.

## B. Pickup capacity
- `settings` table (key/value). `slot_capacity` default 5 (env `SLOT_CAPACITY` overrides the seed value).
- Capacity counts non-cancelled orders whose pickup falls in the same 15-minute window. Orders, not drinks.
- Checked and inserted in one `BEGIN IMMEDIATE` transaction → 409 "Dieses Abholfenster ist ausgebucht".
- `/api/pickup-slots` unchanged (valid slots); new `/api/pickup-availability` → `[{ at, full, left }]`. Checkout shows full slots as "Ausgebucht", disabled.

## C. Menu & inventory
- `menu_items.sold_out` (0/1), separate from `active` (hidden). Sold-out items stay on the Speisekarte, greyed out with an "Ausverkauft" badge, and the server rejects them in orders.
- Admin editor: name, description, category, price, tags (vegan/gluten/nuts/lactose), photo (`photos/…` path or `https://` URL; CSP `img-src` gains `https:`), visible.
- `PATCH /api/admin/menu/:id/sold-out` for staff + admin. `GET /api/admin/menu` readable by staff.
- `DELETE /api/admin/menu/:id` (admin): hard delete when the item was never ordered, otherwise hide (`active = 0`); response says which.

## D. Staff management
- `users.active`, `users.must_change_password`.
- Admin: `GET/POST /api/admin/staff`, `PATCH /api/admin/staff/:id` (hourly wage, active). Deactivating ends sessions and closes an open shift; inactive accounts can't log in. The admin can't deactivate themselves.
- New staff get a temporary password and must set their own at first login (`#/passwort` view, enforced by the router; cleared by `POST /api/me/password`).
- `GET /api/admin/shifts/list?range=day|week|month` (admin): every shift with clock-in/out, hours, cost, plus totals per employee.

## E. Kitchen display & member lookup
- Staff view becomes a high-contrast ticket grid: big pickup time, customer name, items with bright modifier badges, one big action button.
- Toolbar for staff + admin: "Online-Bestellungen pausieren" (`orders_paused`; orders → 503, Startseite/checkout show it) and "+15 min Verzögerung" (`extra_delay_min` 0|15; earliest pickup 15 → 30 min). `GET/PATCH /api/admin/settings`; `slot_capacity` admin-only.
- Member lookup: `GET /api/admin/members/:memberId` (staff) → customer, tier, points, active orders. Input field (works with USB scanners) + camera scan via native `BarcodeDetector` where supported; Permissions-Policy `camera=(self)`.
- Sold-out switches in the staff view.
