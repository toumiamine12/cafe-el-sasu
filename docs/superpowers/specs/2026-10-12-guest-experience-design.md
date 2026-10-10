# Café el Sasu — Guest Experience: Design

Date: 2026-10-12. Chosen in chat: Wallet = fallback only; gifts paid with points or at the counter; bean subscription = pickup reservations.

## 1. Speed-dial reordering
- **Das Übliche**: `GET /api/me/usual` → the guest's most-ordered exact combination (item + options, from non-cancelled orders; ties → most recent) and their usual pickup time (most common Berlin HH:MM). Konto shows it as the hero button; one tap fills the cart and checkout preselects the next free slot at that time.
- **Favoriten**: `favorites (user_id, menu_item_id, mods JSON sorted, created_at)`, unique per combination. `GET/POST/DELETE /api/me/favorites`. Star in the item popup; list with one-tap "In den Warenkorb" in Konto.

## 2. Loyalty hub
- Stamp card toward the next reward (10 stamps), "noch N Bestellungen" estimated from the guest's average points per order.
- Tier card: current perk and that it's applied automatically; the cart shows the tier discount as its own line.
- Wallet fallback: "Karte aufs Handy" saves a phone-sized PNG of the member card (drawn on a canvas with the QR), plus a web app manifest so the site can be added to the home screen (opens on `#/konto`).

## 3. Live order pulse
- Konto: progress bar Eingegangen → In Zubereitung → Abholbereit with a countdown to the pickup time.
- Every page: when an order turns ready, a fixed banner "Dein Kaffee ist ready! Express-Abholung am Tresen." (customers with open orders poll every 15 s; stops when none are open).

## 4. Preferences & bean subscription
- `users.preferences` JSON `{ milk: optionName|null, vegan_only: bool }`, edited in Profil via `PATCH /api/me`. Item popup preselects the preferred milk; Speisekarte opens with "Nur vegan" when set (vegan = tagged vegan, or a drink that can take plant milk).
- `bean_subscriptions (user_id, bean espresso|filter|decaf, size 250g|1kg, every_weeks 1|2|4, next_pickup YYYY-MM-DD, status active|paused|cancelled)`. Prices in `rules.BEAN_PRICES`. Guests: `GET/POST /api/me/beans`, `PATCH /api/me/beans/:id` (pause/resume/cancel/skip). Staff: `GET /api/admin/beans?days=7` (due), `POST /api/admin/beans/:id/handed` (moves next pickup on).

## 5. Gifts & birthday
- `gifts (code unique, sender_id, recipient_name, message, pay points|counter, status pending|active|redeemed|cancelled, points_cost, redeemed_by, order_id, created_at)`. A gift = one coffee of choice (cheapest coffee in the order free, options still charged — same rule as rewards). 100 points or 5,00 € at the counter.
- `POST /api/gifts` (customer), `GET /api/me/gifts`, `POST /api/gifts/:code/cancel` (sender; points refunded if unredeemed). Public `GET /api/gifts/:code` (from-name, message, status only) and `/api/gifts/:code/qr`. Staff: `GET /api/admin/gifts/:code`, `POST /api/admin/gifts/:code/activate` (paid at the counter).
- Redeem: `POST /api/orders` with `gift_code`; not your own gift; one reward or gift per order; marked redeemed in the same transaction.
- Recipient page `#/gutschein?c=CODE`; sender shares link + QR via WhatsApp / E-Mail / copy.
- Birthday: the birthday treat is for **every member during their birthday week (±3 days)**, once a year (`rules.inBirthdayWeek`). Konto and Startseite show a banner then.
