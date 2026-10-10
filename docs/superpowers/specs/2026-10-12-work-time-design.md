# Café el Sasu — Work Time, Payroll Export, Rota: Design

Date: 2026-10-12. Chosen in chat: Meine Zeit (full history), payroll export, Dienstplan, 7 staff accounts.

## Data
- `shift_breaks (id, shift_id → shifts, start, end NULL while running)`. Breaks are unpaid: net hours = shift length − breaks.
- `order_events (id, order_id → orders, user_id → users, status, at)`: written on every staff status change ("Bestellungen bearbeitet").
- `planned_shifts (id, user_id → users, start, end, note)`: the rota. ISO UTC timestamps.
- Seed: 7 staff (Lena, Yusuf + Sara, Tim, Elif, Paul, Nina) with varied wages, a month of shifts with breaks for the new five, and a rota for the next 14 days. Existing seeded shifts of Lena/Yusuf stay unchanged.

## Rules (`server/rules.js`, pure)
- `netMinutes(start, end, breaks)` — worked minutes minus break minutes; open shift/break counts up to `now`.
- `breakShortfall(workedMinutes, breakMinutes)` — German ArbZG: > 6 h needs 30 min, > 9 h needs 45 min; returns minutes still missing.
- `payCents(minutes, wageCents)` — rounded once, from minutes.

## API
- `POST /api/admin/shifts/break` (staff/admin): start/end a break on your open shift; 409 when not clocked in.
- `GET /api/admin/me/work` (staff/admin): current shift (start, on break, worked/break minutes, break shortfall), stats (week/month hours, month pay, orders handled week/month), 14 daily totals, last 60 days of shifts (start, end, break min, net hours, pay), next 14 days of your planned shifts.
- `GET /api/admin/payroll.csv?month=YYYY-MM` (admin): one row per shift — Name; Mitgliedsnr; Datum; Beginn; Ende; Pause (min); Netto-Stunden; Stundenlohn; Lohn — semicolon separated, decimal comma, UTF-8 BOM, plus a total row per employee.
- `GET /api/admin/rota?from=YYYY-MM-DD&days=1..31` (staff/admin): planned shifts with names. `POST /api/admin/rota` (admin): `{ user_id, start, end, note }`, end after start, max 12 h, active staff/admin only, no overlap for the same person (409). `DELETE /api/admin/rota/:id` (admin).
- Shift list and finance wages use net hours (breaks deducted).

## UI
- Meine Zeit: live card (timer, Pause, Ausstempeln/Einstempeln, ArbZG reminder), tiles (Woche, Monat, Verdienst Monat, Bestellungen), 14-day bar chart, upcoming rota shifts, history.
- Dienstplan tab: week grid (people × days) with prev/next week; admin adds shifts and removes them; staff read-only.
- Schichten tab: month picker + "Lohnabrechnung (CSV)" download.
- Kitchen display: "Heute im Dienst" strip (planned today, ● when clocked in).
