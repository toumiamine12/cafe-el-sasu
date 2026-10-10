# Café el Sasu — Demo data, usernames, Finanzen analytics: Design

Date: 2026-10-12. Chosen in chat: login usernames; VAT 7 % food / 19 % drinks (estimate).

## Demo data
- Today: 5 orders each in `new`, `preparing`, `ready`, `picked_up` (demo customers + walk-in, with milk/syrup/shot options; one per pickup slot so capacity holds).
- 5 bean subscriptions across the demo customers (some due this week), plus `bean_sales` history.

## Usernames
- `users.username` (unique index): `vorname.nachname` + 4 random digits, ASCII-folded (ä→ae, ö→oe, ü→ue, ß→ss, ı→i, ş→s, ç→c, ğ→g, é→e); one-word names use the word. Generated for every seeded user, every registration and every new staff account; older databases get them at start.
- Login accepts member ID, e-mail or username. Shown in the profile, staff list and startup log (owner).

## Bean sales
- `bean_sales (subscription_id, user_id, bean, size, price_cents, at)`, written by "Ausgegeben". Counted in revenue as category "Kaffeebohnen" (7 % VAT).

## Analytics — `GET /api/admin/analytics?range=day|week|month` or `?from=YYYY-MM-DD&to=YYYY-MM-DD` (max 92 days), admin only
Completed = `picked_up` orders by pickup time, Berlin days. All money in cents.
- `kpi`: gross (paid totals incl. options + bean sales), labor (net of breaks × wage), net = gross − labor, labor ratio, orders, average ticket, discounts (tier + rewards + gifts), rewards/gifts redeemed.
- `timeline`: per Berlin day revenue and labor (per hour for a single day).
- `hours`: orders per opening hour 9–19.
- `categories`: Kaffee, Kaltgetränke, Kuchen, Gebäck, Kaffeebohnen with share.
- `top_items` (10 by revenue), `slow_items` (5 active items with the fewest sold), `modifiers` (most chosen paid options).
- `channels`: online preorders vs. walk-in (the walk-in account).
- `vat`: 7 % (cake, pastry, beans) and 19 % (drinks), discounts spread proportionally.
- `insights`: rules in `rules.businessInsights()` — plant-milk share, rush hours and staffing, labor ratio, top seller share, slow item, channel share, strongest weekday.
- `GET /api/admin/report.csv` (same range params): summary + per-day table, German Excel format. "Drucken / PDF" uses the browser print dialog with a print stylesheet.

## UI — Finanzen tab
Range: Heute / 7 Tage / 30 Tage / Benutzerdefiniert (von–bis). Five KPI cards, then SVG charts (revenue vs labor per day, rush hours, category donut, top 10 bars with slowest items and options), insights list, channel split, export buttons.
