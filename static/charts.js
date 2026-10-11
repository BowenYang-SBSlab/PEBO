/* Dependency-free SVG / canvas charts for the optimizer results. */
const Charts = (() => {
  const NS = 'http://www.w3.org/2000/svg';
  const HEAT = '#d9742b', COOL = '#2f7fc1', LIGHT = '#e0b84a', OTHER = '#a3b5ad', ACCENT = '#176c52';
  const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
  const DAYS = [31, 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31];

  function el(tag, attrs = {}, children = []) {
    const e = document.createElementNS(NS, tag);
    for (const [k, v] of Object.entries(attrs)) {
      if (k === 'text') e.textContent = v; else e.setAttribute(k, v);
    }
    for (const c of children) e.appendChild(c);
    return e;
  }
  const money = v => '$' + Number(v).toLocaleString('en-US', { maximumFractionDigits: 0 });
  const f1 = v => Number(v).toFixed(1);
  const cToF = c => c * 9 / 5 + 32;

  function scale(domain, range) {
    const [d0, d1] = domain, [r0, r1] = range;
    const s = v => r0 + (v - d0) / (d1 - d0 || 1) * (r1 - r0);
    s.ticks = n => { const out = []; const step = niceStep((d1 - d0) / n); for (let v = Math.ceil(d0 / step) * step; v <= d1 + 1e-9; v += step) out.push(+v.toFixed(6)); return out; };
    return s;
  }
  function niceStep(raw) {
    const p = Math.pow(10, Math.floor(Math.log10(raw || 1)));
    const m = raw / p;
    return (m < 1.5 ? 1 : m < 3 ? 2 : m < 7 ? 5 : 10) * p;
  }
  function axisLeft(g, y, x0, x1, fmt = v => v) {
    y.ticks(5).forEach(t => {
      g.appendChild(el('line', { x1: x0, x2: x1, y1: y(t), y2: y(t), stroke: '#e6ede9' }));
      g.appendChild(el('text', { x: x0 - 8, y: y(t) + 4, 'text-anchor': 'end', text: fmt(t) }));
    });
  }

  /* ---- Setpoint schedule (24 h step chart) ---- */
  function setpoint(container, profile, comfort, opts = {}) {
    container.innerHTML = '';
    const W = 1000, H = 300, m = { l: 56, r: 150, t: 24, b: 36 };
    const heat = profile.heating, cool = profile.cooling, state = profile.state;
    const lo = Math.min(...heat, comfort.t_min) - 1.5, hi = Math.max(...cool, comfort.t_max) + 1.5;
    const x = scale([0, 24], [m.l, W - m.r]), y = scale([lo, hi], [H - m.b, m.t]);
    const svg = el('svg', { viewBox: `0 0 ${W} ${H}` });
    const g = el('g', { class: 'axis' });
    // occupancy strips
    for (let h = 0; h < 24; h++) {
      const s = state[h];
      if (s !== 'awake') g.appendChild(el('rect', { x: x(h), y: m.t, width: x(h + 1) - x(h), height: H - m.t - m.b, fill: s === 'asleep' ? '#eef1f4' : '#f4eef8' }));
    }
    // comfort band
    g.appendChild(el('rect', { x: x(0), y: y(comfort.t_max), width: x(24) - x(0), height: y(comfort.t_min) - y(comfort.t_max), fill: 'rgba(23,108,82,.12)' }));
    g.appendChild(el('text', { x: x(24) + 8, y: y((comfort.t_min + comfort.t_max) / 2) + 4, text: `Comfort ${comfort.t_min}–${comfort.t_max} °C`, fill: ACCENT, 'font-weight': 600, 'font-size': 11 }));
    axisLeft(g, y, x(0), x(24), v => v + ' °C');
    for (let h = 0; h <= 24; h += 3) g.appendChild(el('text', { x: x(h), y: H - m.b + 18, 'text-anchor': 'middle', text: `${String(h % 24).padStart(2, '0')}:00` }));
    svg.appendChild(g);
    const path = arr => arr.map((v, h) => `${h ? 'L' : 'M'}${x(h)},${y(v)} L${x(h + 1)},${y(v)}`).join(' ');
    svg.appendChild(el('path', { d: path(cool), fill: 'none', stroke: COOL, 'stroke-width': 3, 'stroke-linejoin': 'round' }));
    svg.appendChild(el('path', { d: path(heat), fill: 'none', stroke: HEAT, 'stroke-width': 3, 'stroke-linejoin': 'round' }));
    svg.appendChild(el('text', { x: x(24) + 8, y: y(cool[23]) - 6, text: `Cooling ${cool[23]} °C`, fill: COOL, 'font-size': 12, 'font-weight': 600 }));
    svg.appendChild(el('text', { x: x(24) + 8, y: y(heat[23]) + 14, text: `Heating ${heat[23]} °C`, fill: HEAT, 'font-size': 12, 'font-weight': 600 }));
    // hover targets
    for (let h = 0; h < 24; h++) {
      const r = el('rect', { x: x(h), y: m.t, width: x(h + 1) - x(h), height: H - m.t - m.b, fill: 'transparent' });
      r.appendChild(el('title', { text: `${String(h).padStart(2, '0')}:00–${String(h + 1).padStart(2, '0')}:00 · ${state[h]} · heating ${heat[h]} °C (${f1(cToF(heat[h]))} °F) · cooling ${cool[h]} °C (${f1(cToF(cool[h]))} °F)` }));
      svg.appendChild(r);
    }
    // legend
    const lg = el('g', { transform: `translate(${m.l},12)` });
    [[HEAT, 'Heating setpoint'], [COOL, 'Cooling setpoint'], ['#dfe4ea', 'Asleep'], ['#e8dcef', 'Away']].forEach(([c, t], i) => {
      lg.appendChild(el('rect', { x: i * 150, y: -8, width: 12, height: 12, rx: 2, fill: c }));
      lg.appendChild(el('text', { x: i * 150 + 18, y: 3, text: t, 'font-size': 11, fill: '#657972' }));
    });
    svg.appendChild(lg);
    container.appendChild(svg);
  }

  /* ---- Sweep landscape ---- */
  function sweep(container, result) {
    container.innerHTML = '';
    const cands = result.candidates, best = result.best, plan = result.plan;
    if (plan.strategy === 'full') return heatmap(container, cands, best, plan);
    const W = 560, PH = 230, H = PH * 2;
    const svg = el('svg', { viewBox: `0 0 ${W} ${H}` });
    const tmin = result.plan.heat[0], tmax = result.plan.cool[result.plan.cool.length - 1];
    const heatRuns = cands.filter(c => Math.abs(c.cool_sp - tmax) < 1e-6 && !c.confirmation).sort((a, b) => a.heat_sp - b.heat_sp);
    const coolRuns = cands.filter(c => Math.abs(c.heat_sp - tmin) < 1e-6 && !c.confirmation).sort((a, b) => a.cool_sp - b.cool_sp);
    const all = cands.map(c => c.bill), lo = Math.min(...all), hi = Math.max(...all), pad = (hi - lo || 50) * 0.18;
    const panel = (runs, key, color, title, top, bestVal) => {
      const m = { l: 70, r: 30, t: 40, b: 36 };
      const xs = runs.map(r => r[key]);
      const x = scale([Math.min(...xs) - .5, Math.max(...xs) + .5], [m.l, W - m.r]);
      const y = scale([lo - pad, hi + pad], [top + PH - m.b, top + m.t]);
      const g = el('g', { class: 'axis' });
      axisLeft(g, y, m.l, W - m.r, money);
      g.appendChild(el('text', { x: m.l, y: top + 18, text: title, 'font-size': 13, 'font-weight': 600, fill: '#15302a' }));
      xs.forEach(v => g.appendChild(el('text', { x: x(v), y: top + PH - m.b + 18, 'text-anchor': 'middle', text: v + ' °C' })));
      svg.appendChild(g);
      svg.appendChild(el('path', { d: runs.map((r, i) => `${i ? 'L' : 'M'}${x(r[key])},${y(r.bill)}`).join(' '), fill: 'none', stroke: color, 'stroke-width': 2.5 }));
      runs.forEach(r => {
        const isBest = Math.abs(r[key] - bestVal) < 1e-6;
        const c = el('circle', { cx: x(r[key]), cy: y(r.bill), r: isBest ? 7 : 4.5, fill: isBest ? color : '#fff', stroke: color, 'stroke-width': 2.5 });
        c.appendChild(el('title', { text: `${key === 'heat_sp' ? 'Heating' : 'Cooling'} ${r[key]} °C · annual bill ${money(r.bill)} · heating ${Math.round(r.heating_kwh)} kWh · cooling ${Math.round(r.cooling_kwh)} kWh` }));
        svg.appendChild(c);
        svg.appendChild(el('text', { x: x(r[key]), y: y(r.bill) - 12, 'text-anchor': 'middle', text: money(r.bill), 'font-size': 11, fill: '#35514a', 'font-weight': isBest ? 700 : 400 }));
      });
    };
    panel(heatRuns, 'heat_sp', HEAT, `Heating setpoint (cooling held at ${tmax} °C)`, 0, best.heat_sp);
    panel(coolRuns, 'cool_sp', COOL, `Cooling setpoint (heating held at ${tmin} °C)`, PH, best.cool_sp);
    container.appendChild(svg);
  }

  function heatmap(container, cands, best, plan) {
    const heats = plan.heat, cools = plan.cool.slice().reverse();
    const W = 560, cell = Math.min(84, (W - 90) / heats.length), H = 70 + cell * cools.length;
    const svg = el('svg', { viewBox: `0 0 ${W} ${H}` });
    const bills = cands.map(c => c.bill), lo = Math.min(...bills), hi = Math.max(...bills);
    const color = v => { const t = (v - lo) / ((hi - lo) || 1); return mix('#2f9e6f', '#f0e2a6', '#d9742b', t); };
    cools.forEach((c, j) => {
      svg.appendChild(el('text', { x: 62, y: 40 + j * cell + cell / 2 + 4, 'text-anchor': 'end', text: c + ' °C', 'font-size': 11, fill: COOL }));
      heats.forEach((h, i) => {
        const cand = cands.find(k => Math.abs(k.heat_sp - h) < 1e-6 && Math.abs(k.cool_sp - c) < 1e-6);
        const x = 70 + i * cell, y = 40 + j * cell;
        if (!cand) { svg.appendChild(el('rect', { x, y, width: cell - 2, height: cell - 2, rx: 6, fill: '#f1f4f2' })); return; }
        const isBest = cand === best || (Math.abs(best.heat_sp - h) < 1e-6 && Math.abs(best.cool_sp - c) < 1e-6);
        const r = el('rect', { x, y, width: cell - 2, height: cell - 2, rx: 6, fill: color(cand.bill), stroke: isBest ? '#15302a' : 'none', 'stroke-width': 3 });
        r.appendChild(el('title', { text: `Heating ${h} °C · cooling ${c} °C · ${money(cand.bill)} / yr` }));
        svg.appendChild(r);
        svg.appendChild(el('text', { x: x + cell / 2 - 1, y: y + cell / 2 + 4, 'text-anchor': 'middle', text: money(cand.bill), 'font-size': cell > 50 ? 11 : 9, 'font-weight': isBest ? 700 : 500, fill: '#15302a' }));
      });
    });
    heats.forEach((h, i) => svg.appendChild(el('text', { x: 70 + i * cell + cell / 2 - 1, y: 30, 'text-anchor': 'middle', text: h + ' °C', 'font-size': 11, fill: HEAT })));
    svg.appendChild(el('text', { x: 70, y: 14, text: 'Heating setpoint →', 'font-size': 11, fill: HEAT, 'font-weight': 600 }));
    svg.appendChild(el('text', { x: 8, y: 14, text: '↓ Cooling', 'font-size': 11, fill: COOL, 'font-weight': 600 }));
    svg.appendChild(el('text', { x: 70, y: H - 10, text: `Outlined cell = lowest annual bill. Colour from ${money(lo)} (green) to ${money(hi)} (amber).`, 'font-size': 11, fill: '#657972' }));
    container.appendChild(svg);
  }

  function hex(c) { return [1, 3, 5].map(i => parseInt(c.slice(i, i + 2), 16)); }
  function mix(a, b, c, t) {
    const [p, q] = t < .5 ? [hex(a), hex(b)] : [hex(b), hex(c)];
    const u = t < .5 ? t * 2 : (t - .5) * 2;
    return `rgb(${p.map((v, i) => Math.round(v + (q[i] - v) * u)).join(',')})`;
  }

  /* ---- Monthly stacked bars ---- */
  function monthly(container, base, best) {
    container.innerHTML = '';
    const W = 560, H = 300, m = { l: 60, r: 16, t: 30, b: 40 };
    const max = Math.max(...base.kwh, ...best.kwh) * 1.08;
    const x = scale([0, 12], [m.l, W - m.r]), y = scale([0, max], [H - m.b, m.t]);
    const svg = el('svg', { viewBox: `0 0 ${W} ${H}` });
    const g = el('g', { class: 'axis' });
    axisLeft(g, y, x(0), x(12), v => Math.round(v) + ' kWh');
    MONTHS.forEach((mo, i) => g.appendChild(el('text', { x: x(i + .5), y: H - m.b + 18, 'text-anchor': 'middle', text: mo })));
    svg.appendChild(g);
    const bw = (x(1) - x(0)) * 0.36;
    const draw = (data, i, dx, label) => {
      let acc = 0;
      [['heating', HEAT], ['cooling', COOL], ['lighting', LIGHT], ['other', OTHER]].forEach(([k, c]) => {
        const v = data[k][i]; if (v <= 0) return;
        const r = el('rect', { x: x(i) + dx, y: y(acc + v), width: bw, height: y(acc) - y(acc + v), fill: c, rx: 1.5 });
        r.appendChild(el('title', { text: `${label} · ${MONTHS[i]} · ${k}: ${Math.round(v)} kWh · total ${Math.round(data.kwh[i])} kWh · ${money(data.cost[i])}` }));
        svg.appendChild(r); acc += v;
      });
    };
    for (let i = 0; i < 12; i++) { draw(base, i, (x(1) - x(0)) * .1, 'Baseline'); draw(best, i, (x(1) - x(0)) * .52, 'Optimized'); }
    const lg = el('g', { transform: `translate(${m.l},14)` });
    [[HEAT, 'Heating'], [COOL, 'Cooling'], [LIGHT, 'Lighting'], [OTHER, 'Other']].forEach(([c, t], i) => {
      lg.appendChild(el('rect', { x: i * 95, y: -8, width: 12, height: 12, rx: 2, fill: c }));
      lg.appendChild(el('text', { x: i * 95 + 18, y: 3, text: t, 'font-size': 11, fill: '#657972' }));
    });
    svg.appendChild(lg);
    container.appendChild(svg);
  }

  /* ---- Temperature carpet plot ---- */
  const STOPS = [[14, [36, 87, 163]], [18, [143, 187, 230]], [20.5, [226, 240, 232]], [23.5, [247, 214, 160]], [26, [224, 112, 45]], [30, [140, 25, 25]]];
  function tempColor(t) {
    if (!isFinite(t)) return 'rgb(230,230,230)';
    if (t <= STOPS[0][0]) return `rgb(${STOPS[0][1]})`;
    for (let i = 1; i < STOPS.length; i++) {
      if (t <= STOPS[i][0]) {
        const [t0, c0] = STOPS[i - 1], [t1, c1] = STOPS[i], u = (t - t0) / (t1 - t0);
        return `rgb(${c0.map((v, k) => Math.round(v + (c1[k] - v) * u)).join(',')})`;
      }
    }
    return `rgb(${STOPS[STOPS.length - 1][1]})`;
  }
  function carpet(canvas, hourly, legendEl, tipEl) {
    const ctx = canvas.getContext('2d');
    const left = 34, top = 6, cw = (canvas.width - left - 4) / 365, ch = (canvas.height - top - 22) / 24;
    ctx.fillStyle = '#fff'; ctx.fillRect(0, 0, canvas.width, canvas.height);
    for (let d = 0; d < 365; d++) for (let h = 0; h < 24; h++) {
      ctx.fillStyle = tempColor(hourly[d * 24 + h]);
      ctx.fillRect(left + d * cw, top + h * ch, Math.ceil(cw), Math.ceil(ch));
    }
    ctx.fillStyle = '#657972'; ctx.font = '11px Inter, Segoe UI, sans-serif'; ctx.textAlign = 'right';
    [0, 6, 12, 18, 24].forEach(h => ctx.fillText(String(h).padStart(2, '0'), left - 6, top + h * ch + (h === 0 ? 10 : h === 24 ? -2 : 4)));
    ctx.textAlign = 'center'; let day = 0;
    DAYS.forEach((n, i) => { ctx.fillStyle = 'rgba(255,255,255,.7)'; ctx.fillRect(left + day * cw, top, 1, 24 * ch); ctx.fillStyle = '#657972'; ctx.fillText(MONTHS[i], left + (day + n / 2) * cw, canvas.height - 6); day += n; });
    if (legendEl) {
      const grad = `linear-gradient(90deg, ${[14, 16, 18, 20.5, 23.5, 26, 30].map(t => tempColor(t)).join(',')})`;
      legendEl.innerHTML = `<span>14 °C</span><i class="grad" style="background:${grad}"></i><span>30 °C</span><span style="margin-left:14px">Living-zone mean air temperature</span>`;
    }
    if (tipEl) {
      canvas.onmousemove = e => {
        const r = canvas.getBoundingClientRect(), sx = canvas.width / r.width, sy = canvas.height / r.height;
        const d = Math.floor(((e.clientX - r.left) * sx - left) / cw), h = Math.floor(((e.clientY - r.top) * sy - top) / ch);
        if (d < 0 || d > 364 || h < 0 || h > 23) { tipEl.style.display = 'none'; return; }
        let mo = 0, dd = d; while (dd >= DAYS[mo]) { dd -= DAYS[mo]; mo++; }
        const t = hourly[d * 24 + h];
        tipEl.textContent = `${MONTHS[mo]} ${dd + 1} · ${String(h).padStart(2, '0')}:00 · ${t.toFixed(1)} °C (${f1(cToF(t))} °F)`;
        tipEl.style.display = 'block'; tipEl.style.left = (e.clientX + 14) + 'px'; tipEl.style.top = (e.clientY + 14) + 'px';
      };
      canvas.onmouseleave = () => { tipEl.style.display = 'none'; };
    }
  }

  /* Grouped bars: baseline vs optimized dollars by end use. */
  function breakdown(container, baseRows, bestRows) {
    container.innerHTML = '';
    const W = 1000, H = 320, m = { l: 150, r: 16, t: 28, b: 36 };
    const labels = bestRows.map(r => r.label.replace(' (fans, water heating, fridge, plugs)', ''));
    const max = Math.max(...baseRows.map(r => r.cost), ...bestRows.map(r => r.cost), 1) * 1.15;
    const y = scale([0, labels.length], [m.t, H - m.b]);
    const x = scale([0, max], [m.l, W - m.r]);
    const svg = el('svg', { viewBox: `0 0 ${W} ${H}` });
    const g = el('g', { class: 'axis' });
    x.ticks(4).forEach(t => {
      g.appendChild(el('line', { x1: x(t), x2: x(t), y1: m.t, y2: H - m.b, stroke: '#e6ede9' }));
      g.appendChild(el('text', { x: x(t), y: H - m.b + 16, 'text-anchor': 'middle', text: money(t) }));
    });
    svg.appendChild(g);
    const bh = (y(1) - y(0)) * 0.32;
    bestRows.forEach((row, i) => {
      const was = baseRows.find(b => b.key === row.key) || { cost: 0 };
      const cy = y(i + 0.5);
      svg.appendChild(el('text', { x: m.l - 10, y: cy + 4, 'text-anchor': 'end', text: labels[i], 'font-size': 12, fill: '#35514a' }));
      const a = el('rect', { x: x(0), y: cy - bh - 1, width: Math.max(0, x(was.cost) - x(0)), height: bh, rx: 3, fill: '#c5d4cc' });
      a.appendChild(el('title', { text: `Baseline ${labels[i]}: ${money(was.cost)}` }));
      const b = el('rect', { x: x(0), y: cy + 1, width: Math.max(0, x(row.cost) - x(0)), height: bh, rx: 3, fill: ACCENT });
      b.appendChild(el('title', { text: `Optimized ${labels[i]}: ${money(row.cost)}` }));
      svg.appendChild(a); svg.appendChild(b);
    });
    const lg = el('g', { transform: `translate(${m.l},14)` });
    [[ '#c5d4cc', 'Baseline' ], [ ACCENT, 'Optimized' ]].forEach(([c, t], i) => {
      lg.appendChild(el('rect', { x: i * 110, y: -8, width: 12, height: 12, rx: 2, fill: c }));
      lg.appendChild(el('text', { x: i * 110 + 18, y: 3, text: t, 'font-size': 11, fill: '#657972' }));
    });
    svg.appendChild(lg);
    container.appendChild(svg);
  }

  /* Before/after diversity profile for each flexible appliance. */
  function appliances(container, apps) {
    container.innerHTML = '';
    const W = 1000, rowH = 88, H = 16 + apps.length * rowH;
    const svg = el('svg', { viewBox: `0 0 ${W} ${H}` });
    apps.forEach((app, i) => {
      const top = 8 + i * rowH;
      const max = Math.max(...app.weekday_before, ...app.weekday_after, 0.01);
      const x = scale([0, 24], [150, W - 16]);
      const y = scale([0, max], [top + 62, top + 16]);
      svg.appendChild(el('text', { x: 8, y: top + 28, text: app.label, 'font-size': 13, 'font-weight': 650, fill: '#15302a' }));
      svg.appendChild(el('text', { x: 8, y: top + 46, text: app.shift_hours ? `+${app.shift_hours} h` : 'unchanged', 'font-size': 11, fill: '#657972' }));
      for (let h = 0; h < 24; h++) {
        const bw = (x(1) - x(0)) * 0.7;
        svg.appendChild(el('rect', { x: x(h), y: y(app.weekday_before[h]), width: bw / 2, height: y(0) - y(app.weekday_before[h]), fill: '#c5d4cc' }));
        svg.appendChild(el('rect', { x: x(h) + bw / 2, y: y(app.weekday_after[h]), width: bw / 2, height: y(0) - y(app.weekday_after[h]), fill: ACCENT }));
      }
      [0, 6, 12, 18, 24].forEach(h => svg.appendChild(el('text', { x: x(h), y: top + 76, 'text-anchor': 'middle', text: String(h).padStart(2, '0'), 'font-size': 10, fill: '#657972' })));
    });
    container.appendChild(svg);
  }

  return { setpoint, sweep, monthly, carpet, breakdown, appliances, money };
})();
