// Finanzen (owner): KPI cards, SVG charts, insights, CSV/print export.
// Colors are the validated categorical slots (dataviz validator, surface #fff8ef):
// caramel, blue, mustard, violet, green — in this fixed order, never cycled.
import { api, esc } from '../app.js';

const SLOT = ['#b8652a', '#2f7fc1', '#d9a21b', '#8e5bc4', '#3f8f3a'];
const money = new Intl.NumberFormat('de-DE', { style: 'currency', currency: 'EUR' });
const money0 = new Intl.NumberFormat('de-DE', { style: 'currency', currency: 'EUR', maximumFractionDigits: 0 });
const eur = (c) => money.format(c / 100);
const eur0 = (c) => money0.format(c / 100);
const pct = (x) => `${Math.round(x * 100)} %`;
const fmtDay = new Intl.DateTimeFormat('de-DE', { weekday: 'short', day: '2-digit', month: '2-digit' });
const dayLabel = (d) => fmtDay.format(new Date(`${d}T12:00:00`));
const NS = 'http://www.w3.org/2000/svg';

// "Nice" axis maximum and 4 ticks.
function niceMax(v) {
  if (v <= 0) return 100;
  const p = 10 ** Math.floor(Math.log10(v));
  return [1, 2, 2.5, 5, 10].map((m) => m * p).find((m) => m >= v);
}

export function mountFinance(root, alive) {
  const $ = (id) => root.querySelector('#' + id);
  let params = 'range=week';

  // --- shared tooltip: hover or keyboard focus on any [data-tip] mark ------------------------
  const tip = $('chart-tip');
  const panel = root.querySelector('[data-panel="finance"]');
  function showTip(el, x, y) {
    tip.innerHTML = el.dataset.tip;
    tip.hidden = false;
    const box = panel.getBoundingClientRect();
    const w = tip.offsetWidth;
    tip.style.left = `${Math.min(Math.max(8, x - box.left + 12), box.width - w - 8)}px`;
    tip.style.top = `${y - box.top - tip.offsetHeight - 12}px`;
  }
  panel.addEventListener('pointermove', (e) => {
    const el = e.target.closest('[data-tip]');
    if (el) showTip(el, e.clientX, e.clientY); else tip.hidden = true;
  });
  panel.addEventListener('pointerleave', () => { tip.hidden = true; });
  panel.addEventListener('focusin', (e) => {
    const el = e.target.closest('[data-tip]');
    if (!el) return;
    const r = el.getBoundingClientRect();
    showTip(el, r.left + r.width / 2, r.top);
  });
  panel.addEventListener('focusout', () => { tip.hidden = true; });

  // --- range controls ------------------------------------------------------------------------
  const today = new Date().toLocaleDateString('en-CA', { timeZone: 'Europe/Berlin' });
  $('fin-to').value = today;
  $('fin-from').value = new Date(Date.now() - 13 * 864e5).toLocaleDateString('en-CA', { timeZone: 'Europe/Berlin' });
  $('fin-to').max = today;
  $('range').addEventListener('click', (e) => {
    const r = e.target.dataset.range;
    if (!r) return;
    $('range').querySelectorAll('button').forEach((b) => b.setAttribute('aria-pressed', b === e.target));
    $('fin-custom').hidden = r !== 'custom';
    if (r !== 'custom') { params = `range=${r}`; load(); }
  });
  $('fin-custom').addEventListener('submit', (e) => {
    e.preventDefault();
    params = `from=${$('fin-from').value}&to=${$('fin-to').value}`;
    load();
  });
  $('fin-print').addEventListener('click', () => window.print());

  // --- KPI cards ---------------------------------------------------------------------------------
  function renderKpis(k) {
    const card = (label, value, hint, cls = '') => `<div class="stat kpi"><div class="label">${label}</div><div class="value ${cls}">${value}</div><div class="hint">${hint}</div></div>`;
    $('fin-kpis').innerHTML =
      card('Brutto-Umsatz', eur0(k.gross_cents), 'abgeholte Bestellungen inkl. Extras + Kaffeebohnen')
      + card('Netto-Gewinn', eur0(k.net_cents), 'Umsatz minus Personalkosten, noch inkl. MwSt', k.net_cents < 0 ? 'neg' : 'pos')
      + card('Personalkosten', eur0(k.labor_cents), `Quote ${pct(k.labor_ratio)} vom Umsatz`, k.labor_ratio > 0.35 ? 'warn' : '')
      + card('Bestellungen', k.orders.toLocaleString('de-DE'), `Ø Bestellwert ${eur(k.avg_ticket_cents)}`)
      + card('Rabatte & Prämien', eur0(k.discounts_cents), `${k.rewards} Prämien · ${k.gifts} Gutscheine eingelöst`);
  }

  // --- 1. revenue (bars) and labor cost (line) on one euro axis ----------------------------------
  function renderTimeline(a) {
    const rows = a.timeline;
    const hourly = 'hour' in rows[0];
    const W = 760, H = 260, L = 64, R = 12, T = 14, B = 34;
    const max = niceMax(Math.max(...rows.map((r) => Math.max(r.revenue_cents, r.labor_cents))));
    const x = (i) => L + ((W - L - R) / rows.length) * i;
    const bw = Math.max(3, (W - L - R) / rows.length - 2);
    const y = (v) => T + (H - T - B) * (1 - v / max);
    const label = (r) => (hourly ? `${r.hour}:00` : dayLabel(r.date));
    const every = Math.ceil(rows.length / 8);
    let svg = `<svg viewBox="0 0 ${W} ${H}" role="img" aria-label="Umsatz und Personalkosten im Zeitraum" class="svg-chart">`;
    for (let t = 0; t <= 4; t++) {
      const v = (max / 4) * t;
      svg += `<line class="grid" x1="${L}" x2="${W - R}" y1="${y(v)}" y2="${y(v)}"/><text class="tick" x="${L - 8}" y="${y(v) + 4}" text-anchor="end">${eur0(v)}</text>`;
    }
    rows.forEach((r, i) => {
      const h = Math.max(0, y(0) - y(r.revenue_cents));
      if (h > 0) svg += `<path fill="${SLOT[0]}" d="M${x(i) + 1},${y(0)} v${-Math.max(0, h - 4)} q0,-4 4,-4 h${bw - 8} q4,0 4,4 v${Math.max(0, h - 4)} z"/>`;
      if (i % every === 0) svg += `<text class="tick" x="${x(i) + bw / 2 + 1}" y="${H - 12}" text-anchor="middle">${label(r)}</text>`;
    });
    const pts = rows.map((r, i) => `${x(i) + bw / 2 + 1},${y(r.labor_cents)}`).join(' ');
    svg += `<polyline fill="none" stroke="${SLOT[1]}" stroke-width="2" stroke-linejoin="round" points="${pts}"/>`;
    if (rows.length <= 31) rows.forEach((r, i) => { svg += `<circle cx="${x(i) + bw / 2 + 1}" cy="${y(r.labor_cents)}" r="4" fill="${SLOT[1]}" stroke="#fff8ef" stroke-width="2"/>`; });
    rows.forEach((r, i) => {
      const t = `<strong>${label(r)}</strong><br>Umsatz ${eur(r.revenue_cents)}<br>Personalkosten ${eur(r.labor_cents)}<br>Ergebnis ${eur(r.revenue_cents - r.labor_cents)} · ${r.orders} Bestellungen`;
      svg += `<rect class="hit" x="${x(i)}" y="${T}" width="${(W - L - R) / rows.length}" height="${H - T - B}" data-tip="${esc(t)}" tabindex="0" aria-label="${esc(label(r))}"/>`;
    });
    $('ch-timeline').innerHTML = svg + '</svg>';
    $('tb-timeline').innerHTML = `<table class="table"><thead><tr><th>${hourly ? 'Stunde' : 'Tag'}</th><th class="num">Umsatz</th><th class="num">Personal</th><th class="num">Ergebnis</th><th class="num">Bestellungen</th></tr></thead><tbody>
      ${rows.map((r) => `<tr><td>${label(r)}</td><td class="num">${eur(r.revenue_cents)}</td><td class="num">${eur(r.labor_cents)}</td><td class="num">${eur(r.revenue_cents - r.labor_cents)}</td><td class="num">${r.orders}</td></tr>`).join('')}</tbody></table>`;
  }

  // --- 2. rush hours --------------------------------------------------------------------------------
  function renderHours(hours) {
    const W = 380, H = 220, L = 30, R = 8, T = 22, B = 28;
    const max = Math.max(1, ...hours.map((h) => h.orders));
    const peak = hours.reduce((a, h) => (h.orders > a.orders ? h : a), hours[0]);
    const slotW = (W - L - R) / hours.length;
    const y = (v) => T + (H - T - B) * (1 - v / max);
    let svg = `<svg viewBox="0 0 ${W} ${H}" role="img" aria-label="Bestellungen je Stunde" class="svg-chart">`;
    svg += `<line class="axis" x1="${L}" x2="${W - R}" y1="${y(0)}" y2="${y(0)}"/>`;
    hours.forEach((h, i) => {
      const x = L + slotW * i + 1;
      const bh = y(0) - y(h.orders);
      const w = slotW - 2;
      if (bh > 0) svg += `<path fill="${SLOT[0]}" opacity="${h === peak ? 1 : 0.55}" d="M${x},${y(0)} v${-Math.max(0, bh - 4)} q0,-4 4,-4 h${w - 8} q4,0 4,4 v${Math.max(0, bh - 4)} z"/>`;
      svg += `<text class="tick" x="${x + w / 2}" y="${H - 10}" text-anchor="middle">${h.hour}</text>`;
      if (h === peak && h.orders) svg += `<text class="val" x="${x + w / 2}" y="${y(h.orders) - 6}" text-anchor="middle">${h.orders}</text>`;
      svg += `<rect class="hit" x="${x - 1}" y="${T}" width="${slotW}" height="${H - T - B}" tabindex="0" data-tip="${esc(`<strong>${h.hour}–${h.hour + 1} Uhr</strong><br>${h.orders} Bestellungen`)}" aria-label="${h.hour} Uhr: ${h.orders}"/>`;
    });
    $('ch-hours').innerHTML = svg + '</svg>';
  }

  // --- 3. category donut + legend with values -------------------------------------------------------------
  function renderCategories(cats, gross) {
    const S = 200, C = S / 2, R1 = 90, R0 = 58;
    let a0 = -Math.PI / 2;
    const arc = (r, a) => [C + r * Math.cos(a), C + r * Math.sin(a)];
    let svg = `<svg viewBox="0 0 ${S} ${S}" role="img" aria-label="Umsatzanteile nach Kategorie" class="svg-chart donut">`;
    cats.forEach((c, i) => {
      if (!c.revenue_cents) return;
      const a1 = a0 + c.share * Math.PI * 2;
      const large = a1 - a0 > Math.PI ? 1 : 0;
      const [x0, y0] = arc(R1, a0), [x1, y1] = arc(R1, a1), [x2, y2] = arc(R0, a1), [x3, y3] = arc(R0, a0);
      const d = c.share >= 0.9999
        ? `M${C - R1},${C} a${R1},${R1} 0 1,0 ${2 * R1},0 a${R1},${R1} 0 1,0 ${-2 * R1},0 M${C - R0},${C} a${R0},${R0} 0 1,1 ${2 * R0},0 a${R0},${R0} 0 1,1 ${-2 * R0},0`
        : `M${x0},${y0} A${R1},${R1} 0 ${large},1 ${x1},${y1} L${x2},${y2} A${R0},${R0} 0 ${large},0 ${x3},${y3} Z`;
      svg += `<path d="${d}" fill="${SLOT[i]}" stroke="#fff8ef" stroke-width="2" fill-rule="evenodd" tabindex="0" data-tip="${esc(`<strong>${esc(c.label)}</strong><br>${eur(c.revenue_cents)} · ${pct(c.share)}`)}" aria-label="${c.label} ${pct(c.share)}"/>`;
      a0 = a1;
    });
    svg += `<text class="donut-total" x="${C}" y="${C - 2}" text-anchor="middle">${eur0(gross)}</text><text class="tick" x="${C}" y="${C + 16}" text-anchor="middle">Umsatz</text></svg>`;
    $('ch-categories').innerHTML = svg;
    $('lg-categories').innerHTML = cats.map((c, i) => `<li><i class="sw" style="background:${SLOT[i]}"></i><span>${esc(c.label)}</span><b>${pct(c.share)}</b><small>${eur0(c.revenue_cents)}</small></li>`).join('');
  }

  // --- 4. top 10 items: ranked horizontal bars with values at the bar ends -------------------------------
  function renderTop(items) {
    if (!items.length) { $('ch-top').innerHTML = '<p class="muted">Keine Verkäufe in diesem Zeitraum.</p>'; return; }
    const W = 760, rowH = 26, L = 190, R = 90, H = items.length * rowH + 8;
    const max = items[0].revenue_cents || 1;
    let svg = `<svg viewBox="0 0 ${W} ${H}" role="img" aria-label="Top 10 Artikel nach Umsatz" class="svg-chart">`;
    items.forEach((it, i) => {
      const y = 4 + i * rowH;
      const w = Math.max(2, ((W - L - R) * it.revenue_cents) / max);
      svg += `<text class="cat" x="${L - 10}" y="${y + 16}" text-anchor="end">${esc(it.name)}</text>`;
      svg += `<path fill="${SLOT[0]}" d="M${L},${y + 4} h${w - 4} q4,0 4,4 v${rowH - 16} q0,4 -4,4 h${-(w - 4)} z"/>`;
      svg += `<text class="val" x="${L + w + 8}" y="${y + 16}">${eur0(it.revenue_cents)}</text>`;
      svg += `<rect class="hit" x="0" y="${y}" width="${W}" height="${rowH}" tabindex="0" data-tip="${esc(`<strong>${esc(it.name)}</strong><br>${it.qty}× verkauft · ${eur(it.revenue_cents)}`)}" aria-label="${esc(it.name)}"/>`;
    });
    $('ch-top').innerHTML = svg + '</svg>';
  }

  function renderLists(a) {
    $('ls-slow').innerHTML = a.slow_items.map((s) => `<li><span>${esc(s.name)}</span><b>${s.qty}×</b></li>`).join('');
    $('ls-mods').innerHTML = a.modifiers.length ? a.modifiers.slice(0, 5).map((m) => `<li><span>${esc(m.name)}</span><b>${m.count}× · ${eur0(m.revenue_cents)}</b></li>`).join('') : '<li class="muted">Noch keine kostenpflichtigen Extras.</li>';
    const { online, walkin } = a.channels;
    const n = online + walkin || 1;
    $('ch-channels').innerHTML = `
      <div class="split-bar"><span style="width:${(online / n) * 100}%;background:${SLOT[0]}" data-tip="${esc(`<strong>Online vorbestellt</strong><br>${online} Bestellungen`)}" tabindex="0"></span><span style="width:${(walkin / n) * 100}%;background:${SLOT[1]}" data-tip="${esc(`<strong>An der Theke</strong><br>${walkin} Bestellungen`)}" tabindex="0"></span></div>
      <div class="split-labels"><span><i class="sw" style="background:${SLOT[0]}"></i>Online ${pct(online / n)} (${online})</span><span><i class="sw" style="background:${SLOT[1]}"></i>Theke ${pct(walkin / n)} (${walkin})</span></div>`;
    const v = a.vat;
    $('tb-vat').innerHTML = `<thead><tr><th></th><th class="num">Brutto</th><th class="num">Netto</th><th class="num">MwSt</th></tr></thead><tbody>
      <tr><td>7 % Speisen &amp; Bohnen</td><td class="num">${eur(v.reduced.gross)}</td><td class="num">${eur(v.reduced.net)}</td><td class="num">${eur(v.reduced.vat)}</td></tr>
      <tr><td>19 % Getränke</td><td class="num">${eur(v.standard.gross)}</td><td class="num">${eur(v.standard.net)}</td><td class="num">${eur(v.standard.vat)}</td></tr></tbody>`;
    const ICON = { good: '✓', warn: '!', info: 'i' };
    const LABEL = { good: 'Gut', warn: 'Achtung', info: 'Hinweis' };
    $('ls-insights').innerHTML = a.insights.map((t) => `<li class="${t.tone}"><span class="tone" aria-label="${LABEL[t.tone]}">${ICON[t.tone]}</span><span>${esc(t.text)}</span></li>`).join('');
  }

  async function load() {
    $('fin-csv').href = `/api/admin/report.csv?${params}`;
    $('fin-kpis').classList.add('loading');
    let a;
    try { a = await api(`/api/admin/analytics?${params}`); } catch (err) {
      if (alive()) $('fin-period').textContent = err.message;
      return;
    } finally { $('fin-kpis')?.classList.remove('loading'); }
    if (!alive()) return;
    $('fin-period').textContent = a.range.from === a.range.to ? dayLabel(a.range.from) : `${dayLabel(a.range.from)} – ${dayLabel(a.range.to)} (${a.range.days} Tage)`;
    renderKpis(a.kpi);
    renderTimeline(a);
    renderHours(a.hours);
    renderCategories(a.categories, a.kpi.gross_cents);
    renderTop(a.top_items);
    renderLists(a);
  }

  return { load };
}
