/* Page controller: inputs → WattWise lighting plan → EnergyPlus optimization job → results dashboard. */
(() => {
  const $ = id => document.getElementById(id);
  const fmt = (n, d = 2) => Number(n).toLocaleString('en-US', { minimumFractionDigits: d, maximumFractionDigits: d });
  const int = n => Number(n).toLocaleString('en-US', { maximumFractionDigits: 0 });
  const money = Charts.money;
  const cToF = c => (c * 9 / 5 + 32).toFixed(0);
  const hr = id => { const v = $(id).value.split(':'); return Number(v[0]) + Number(v[1]) / 60; };

  const rooms = JSON.parse(JSON.stringify(WattWise.DEFAULT_ROOMS));
  let modelInfo = null, lastPlan = null, lastResult = null, records = [];
  const tip = document.createElement('div'); tip.className = 'tip'; document.body.appendChild(tip);
  const peboTpl = $('peboTpl');
  if (peboTpl) document.querySelectorAll('[data-pebo]').forEach(slot => slot.appendChild(peboTpl.content.cloneNode(true)));
  document.querySelectorAll('.announce-choice').forEach(button => {
    button.addEventListener('click', () => {
      document.querySelectorAll('.announce-choice').forEach(other => other.classList.toggle('on', other === button));
    });
  });

  /* ---------- room / fixture table ---------- */
  $('rooms').innerHTML = rooms.map((r, i) => `<tr><td><b>${r.name}</b></td>
    <td><input type="number" min="1" value="${r.area}" data-r="${i}" data-k="area"></td>
    <td><input type="number" min="0" value="${r.lux}" data-r="${i}" data-k="lux"></td>
    <td><input type="number" min="0" step=".1" value="${r.lpd}" data-r="${i}" data-k="lpd"></td>
    <td>${r.fixtures.map((f, j) => `<div style="margin:4px 0;white-space:nowrap">${f[0]}
      <input title="Quantity" style="width:56px" type="number" min="0" value="${f[1]}" data-r="${i}" data-f="${j}" data-p="1"> ×
      <input title="Wattage" style="width:62px" type="number" min="0" value="${f[2]}" data-r="${i}" data-f="${j}" data-p="2"> W,
      <input title="Lumens" style="width:75px" type="number" min="0" value="${f[3]}" data-r="${i}" data-f="${j}" data-p="3"> lm</div>`).join('')}</td></tr>`).join('');

  function syncRooms() {
    document.querySelectorAll('[data-r]').forEach(x => {
      const r = rooms[+x.dataset.r];
      if (x.dataset.f !== undefined) r.fixtures[+x.dataset.f][+x.dataset.p] = Math.max(0, +x.value || 0);
      else r[x.dataset.k] = Math.max(x.dataset.k === 'area' ? 1 : 0, +x.value || 0);
    });
  }

  /* ---------- input readers ---------- */
  const occ = () => ({ wake: hr('wake'), work: hr('work'), end: hr('end'), bed: hr('bed'), wfh: $('wfh').value === 'yes' });
  const tariff = () => ({ mode: $('tariff').value, flat: +$('flat').value, offSupply: +$('offsupply').value, onSupply: +$('onsupply').value, superSupply: +$('supersupply').value, fixed: +$('fixed').value });
  const comfort = () => ({ t_min: +$('tmin').value, t_max: +$('tmax').value, resolution: $('resolution').value, setback: +$('setback').value, step: +$('step').value, strategy: $('strategy').value });
  const indoorArea = () => rooms.filter(r => r.name !== 'Exterior').reduce((a, r) => a + r.area, 0);
  const totalArea = () => indoorArea() + (+$('otherArea').value || 0);

  /* ---------- comfort slider ---------- */
  function syncRange(changed) {
    let lo = +$('tmin').value, hi = +$('tmax').value;
    const gap = Math.max(1, +$('step').value);
    if (hi - lo < gap) { if (changed === 'tmin') lo = hi - gap; else hi = lo + gap; $('tmin').value = lo; $('tmax').value = hi; }
    const min = +$('tmin').min, max = +$('tmin').max;
    $('rangeFill').style.left = ((lo - min) / (max - min) * 100) + '%';
    $('rangeFill').style.width = ((hi - lo) / (max - min) * 100) + '%';
    $('rangeLabel').innerHTML = `${lo} °C – ${hi} °C <small>(${cToF(lo)} °F – ${cToF(hi)} °F)</small>`;
    $('setback').disabled = $('resolution').value !== 'hourly';
    refreshPlan();
  }
  $('tmin').addEventListener('input', () => syncRange('tmin'));
  $('tmax').addEventListener('input', () => syncRange('tmax'));
  ['resolution', 'setback', 'step', 'strategy'].forEach(id => $(id).addEventListener('change', () => syncRange()));

  let planTimer = null;
  function refreshPlan() {
    clearTimeout(planTimer);
    planTimer = setTimeout(async () => {
      try {
        const res = await fetch('/api/plan', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ comfort: comfort() }) });
        const plan = await res.json();
        if (plan.error) throw new Error(plan.error);
        lastPlan = plan;
        const minutes = Math.ceil(plan.estimated_runs / plan.workers) * plan.seconds_per_run / 60;
        $('planSummary').innerHTML = `<strong>${plan.estimated_runs} simulations</strong>
          <div class="row"><span>Heating candidates</span><span>${plan.heat.map(v => v + '°').join(', ') || '—'}</span></div>
          <div class="row"><span>Cooling candidates</span><span>${plan.cool.map(v => v + '°').join(', ') || '—'}</span></div>
          <div class="row"><span>Minimum deadband</span><span>${plan.deadband} °C</span></div>
          <div class="row"><span>Parallel workers</span><span>${plan.workers}</span></div>
          <div class="row"><span>Estimated wall time</span><span>≈ ${minutes < 1 ? '< 1' : fmt(minutes, 1)} min</span></div>`;
        $('runLead').textContent = `Compare the baseline with ${plan.estimated_runs - 1} candidate schedules on this computer (≈ ${minutes < 1 ? 'under a' : fmt(minutes, 1)} minute${minutes >= 2 ? 's' : ''}), then open the bill on Your plan.`;
      } catch (e) {
        $('planSummary').innerHTML = `<span class="bad">${e.message}</span>`;
      }
    }, 250);
  }

  /* ---------- floor plan sketch (display only; not sent to the simulation) ---------- */
  let sketch = null;
  let sketchDrag = false;
  function defaultSketch() {
    const area = name => (rooms.find(r => r.name === name) || { area: 8 }).area;
    return [
      ['Bedroom', 'Home office', 'Bathroom'],
      ['Living room', 'Kitchen'],
      ['Hallway'],
      ['Exterior'],
    ].map(row => row.map(name => ({ name, area: area(name) })));
  }
  function sketchRoom(name) {
    for (const row of sketch) {
      const found = row.find(r => r.name === name);
      if (found) return found;
    }
    return null;
  }
  function swapSketch(a, b) {
    let pa, pb;
    sketch.forEach(row => row.forEach((room, i) => {
      if (room.name === a) pa = [row, i];
      if (room.name === b) pb = [row, i];
    }));
    if (!pa || !pb) return;
    const tmp = pa[0][pa[1]];
    pa[0][pa[1]] = pb[0][pb[1]];
    pb[0][pb[1]] = tmp;
  }
  function updateFacingNote() {
    const face = $('facing').value;
    $('frontTag').textContent = `Front door · faces ${face}`;
    const place = $('place').value.trim() || 'Buffalo, NY';
    const local = /buffalo|niagara|williamsville|amherst|tonawanda/i.test(place);
    $('locationNote').textContent = local
      ? `Weather file: Buffalo Niagara International Airport, TMY3. The model is rotated so the front wall faces ${face}.`
      : `This package only includes Buffalo weather, so the year is still simulated with Buffalo Niagara TMY3. The house is rotated so the front faces ${face}.`;
  }
  function clampArea(value) {
    const n = Math.round(Number(value));
    if (!Number.isFinite(n)) return null;
    return Math.min(80, Math.max(4, n));
  }
  function paintArea(name, value) {
    const room = sketchRoom(name);
    const n = clampArea(value);
    if (!room || n == null) return null;
    room.area = n;
    const el = $('floorPlan').querySelector(`.room-block[data-name="${CSS.escape(name)}"]`);
    if (el) el.style.flex = String(n);
    return n;
  }
  function renderFloorPlan() {
    updateFacingNote();
    if (sketchDrag) return;
    if (!sketch) sketch = defaultSketch();
    const label = room => room.name === 'Exterior' ? 'Porch' : room.name;
    const block = room => `<div class="room-block ${room.name === 'Exterior' ? 'porch' : ''}" data-name="${room.name}" style="flex:${Math.max(room.area, 4)}"><b>${label(room)}</b><label class="area"><input class="area-num" type="number" min="4" max="80" step="1" value="${Math.round(room.area)}" aria-label="${label(room)} area in square metres"> m²</label><i class="resize" data-resize="${room.name}"></i></div>`;
    $('floorPlan').innerHTML = sketch.map(row => `<div class="row">${row.map(block).join('')}</div>`).join('');
    $('floorPlan').querySelectorAll('.room-block').forEach(el => {
      el.addEventListener('pointerdown', e => {
        if (e.button !== 0) return;
        if (e.target.closest('input, label.area')) return;
        if (e.target.classList.contains('resize')) startResize(e, el);
        else startDrag(e, el);
      });
    });
    $('floorPlan').querySelectorAll('input.area-num').forEach(input => {
      input.addEventListener('input', () => {
        const n = clampArea(input.value);
        if (n == null) return;
        paintArea(input.closest('.room-block').dataset.name, n);
      });
      input.addEventListener('change', () => {
        const name = input.closest('.room-block').dataset.name;
        const n = paintArea(name, input.value) ?? sketchRoom(name).area;
        input.value = String(n);
      });
    });
  }
  function startDrag(e, el) {
    e.preventDefault();
    sketchDrag = true;
    const name = el.dataset.name;
    el.classList.add('dragging');
    try { el.setPointerCapture(e.pointerId); } catch (err) { /* pointer may already be released */ }
    let over = null;
    const move = ev => {
      el.style.pointerEvents = 'none';
      const hit = document.elementFromPoint(ev.clientX, ev.clientY);
      el.style.pointerEvents = '';
      const next = hit && hit.closest('.room-block');
      if (over && over !== next) over.classList.remove('over');
      over = next && next.dataset.name !== name ? next : null;
      if (over) over.classList.add('over');
    };
    const up = () => {
      el.removeEventListener('pointermove', move);
      el.removeEventListener('pointerup', up);
      if (over) swapSketch(name, over.dataset.name);
      sketchDrag = false;
      renderFloorPlan();
    };
    el.addEventListener('pointermove', move);
    el.addEventListener('pointerup', up);
  }
  function startResize(e, el) {
    e.preventDefault();
    e.stopPropagation();
    sketchDrag = true;
    const room = sketchRoom(el.dataset.name);
    const startX = e.clientX, startArea = room.area;
    try { el.setPointerCapture(e.pointerId); } catch (err) { /* pointer may already be released */ }
    const move = ev => {
      room.area = Math.min(80, Math.max(4, Math.round(startArea + (ev.clientX - startX) / 6)));
      el.style.flex = String(room.area);
      el.querySelector('input.area-num').value = String(room.area);
    };
    const up = () => {
      el.removeEventListener('pointermove', move);
      el.removeEventListener('pointerup', up);
      sketchDrag = false;
    };
    el.addEventListener('pointermove', move);
    el.addEventListener('pointerup', up);
  }
  $('resetPlan').onclick = () => { syncRooms(); sketch = null; sketchDrag = false; renderFloorPlan(); };

  const hourOf = id => Number($(id).value.split(':')[0]) || 0;
  function appliancePayload() {
    return {
      dishwasher: { enabled: $('dwOn').checked, from: hourOf('dwFrom'), to: hourOf('dwTo') },
      clotheswasher: { enabled: $('cwOn').checked, from: hourOf('cwFrom'), to: hourOf('cwTo') },
      electric_dryer: { enabled: $('drOn').checked, follow_washer: $('drFollow').checked },
      electric_range: { enabled: $('rgOn').checked, from: hourOf('rgFrom'), to: hourOf('rgTo') },
    };
  }

  function renderArea() {
    const indoor = indoorArea(), total = totalArea();
    const model = modelInfo ? modelInfo.conditioned_area_m2 : null;
    const scale = $('scaleModel').value === 'yes' && model ? Math.sqrt(total / model) : 1;
    $('areaSummary').innerHTML = `
      <div><span>Lit rooms</span><strong>${fmt(indoor, 1)} m²</strong></div>
      <div><span>Conditioned floor area sent to EnergyPlus</span><strong>${fmt($('scaleModel').value === 'yes' ? total : (model || total), 1)} m² · ${int(($('scaleModel').value === 'yes' ? total : (model || total)) * 10.7639)} ft²</strong></div>
      <div><span>Model as delivered</span><strong>${model ? fmt(model, 1) + ' m²' : '…'}</strong></div>
      <div><span>Footprint scale factor</span><strong>${$('scaleModel').value === 'yes' ? '× ' + fmt(scale, 3) : 'none'}</strong></div>`;
  }

  /* ---------- lighting plan (section 5) ---------- */
  function renderLighting() {
    syncRooms(); renderArea(); renderFloorPlan();
    const season = $('season').value, o = occ(), t = tariff(), daylux = +$('daylux').value;
    const p = WattWise.plan(rooms, o, t, season, daylux);
    records = p.records;
    let html = '<div class="timegrid"><div></div>' + Array.from({ length: 24 }, (_, h) => `<div class="timehead">${h}</div>`).join('');
    p.cells.forEach(c => {
      html += `<div class="rowname">${c.room}</div>`;
      c.row.forEach((x, h) => { html += `<div class="cell ${x.power > 0 ? (x.mode === 'night' ? 'low' : 'active') : ''}" title="${c.room} ${h}:00 — ${x.parts.join(', ') || (x.mode === 'motion' ? 'Motion sensor' : 'Off')}; ${x.lux.toFixed(0)} lux"></div>`; });
    });
    html += '</div>';
    $('timeline').innerHTML = html;
    const m = n => n * 30;
    $('metrics').innerHTML = `
      <div class="metric"><span>This season, one month</span><strong>${fmt(m(p.kwh))} kWh</strong></div>
      <div class="metric"><span>Same tariff, this month</span><strong>$${fmt(m(p.cost))}</strong></div>
      <div class="metric"><span>Where it is billed</span><strong class="good">One bill</strong></div>
      <div class="metric"><span>Lighting targets this day</span><strong class="${p.unmet || p.notes.length ? 'bad' : 'good'}">${p.unmet || p.notes.length ? 'Check notes' : 'All met'}</strong></div>`;
    $('lightNotes').innerHTML = (p.unmet || p.notes.length)
      ? (p.unmet ? `<div class="note"><b>${p.unmet} room-hours are below the selected target.</b> Those rooms need more light output to hold the lux you selected.</div>` : '')
        + p.notes.map(n => `<div class="note"><b>${n.title}</b>${n.text}</div>`).join('')
      : '';
  }

  function lightingPayload() {
    const o = occ(), daylux = +$('daylux').value, duty = (+$('extDuty').value || 0) / 100;
    const seasons = ['winter', 'shoulder', 'summer'];
    const payload = { rooms: [], exterior: null };
    rooms.forEach(r => {
      if (r.name === 'Exterior') {
        const profiles = {};
        seasons.forEach(s => { const prof = WattWise.exteriorProfile(r, s, duty); profiles[s] = { weekday: prof, weekend: prof }; });
        payload.exterior = { installed_w: WattWise.installedWatts(r), duty, profiles };
        return;
      }
      const profiles = {};
      seasons.forEach(s => { profiles[s] = { weekday: WattWise.roomProfile(r, o, s, daylux, false), weekend: WattWise.roomProfile(r, o, s, daylux, true) }; });
      payload.rooms.push({ name: r.name, area_m2: r.area, installed_w: WattWise.installedWatts(r), profiles });
    });
    return payload;
  }

  /* ---------- CSV helpers ---------- */
  function download(name, rows) {
    const keys = Object.keys(rows[0]);
    const csv = [keys.join(','), ...rows.map(r => keys.map(k => '"' + String(r[k]).replaceAll('"', '""') + '"').join(','))].join('\r\n');
    const a = document.createElement('a'); a.href = URL.createObjectURL(new Blob([csv], { type: 'text/csv' })); a.download = name; a.click();
    setTimeout(() => URL.revokeObjectURL(a.href), 1000);
  }
  $('csv').onclick = () => { renderLighting(); download('wattwise_lighting_schedule.csv', records); };

  /* ---------- optimization job ---------- */
  function validate() {
    const o = occ(), c = comfort();
    if (!(o.wake < o.bed)) return 'Bedtime must be later than wake-up time.';
    if (!(o.work < o.end)) return 'Work must end after it starts.';
    if (c.t_max - c.t_min < Math.max(1, c.step)) return 'Comfort range must span at least one sweep step.';
    if (modelInfo && !modelInfo.energyplus_found) return `EnergyPlus was not found at ${modelInfo.energyplus_dir}.`;
    return null;
  }

  async function optimize() {
    renderLighting();
    const err = validate();
    $('runError').classList.toggle('hidden', !err);
    if (err) { $('runError').textContent = err; return; }
    const c = comfort(), t = tariff(), o = occ();
    const body = {
      occupant: { wake: o.wake, work_start: o.work, work_end: o.end, bed: o.bed, wfh: o.wfh },
      tariff: { mode: t.mode, flat: t.flat, off_supply: t.offSupply, on_supply: t.onSupply, super_supply: t.superSupply, fixed_monthly: t.fixed },
      comfort: c,
      floor_plan: { scale_model: $('scaleModel').value === 'yes', total_area_m2: totalArea(), rooms: rooms.map(r => ({ name: r.name, area_m2: r.area })) },
      lighting: lightingPayload(),
      location: { place: $('place').value.trim() || 'Buffalo, NY', facing: $('facing').value },
      appliances: appliancePayload(),
    };
    $('optimize').disabled = true; $('progress').classList.remove('hidden'); $('results').classList.add('hidden');
    $('progressFill').style.width = '2%'; $('progressText').textContent = 'Submitting job…'; $('progressLog').textContent = ''; $('progressCount').textContent = '';
    try {
      const res = await fetch('/api/optimize', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
      const j = await res.json();
      if (!res.ok) throw new Error(j.error || res.statusText);
      await poll(j.job_id);
    } catch (e) {
      $('runError').classList.remove('hidden'); $('runError').textContent = e.message;
    } finally { $('optimize').disabled = false; }
  }

  function poll(id) {
    return new Promise((resolve, reject) => {
      const tick = async () => {
        try {
          const job = await (await fetch(`/api/jobs/${id}`)).json();
          const p = job.progress || {};
          const pct = p.total ? Math.max(3, Math.round(p.done / p.total * 100)) : 3;
          $('progressFill').style.width = (job.status === 'done' ? 100 : pct) + '%';
          $('progressText').textContent = p.message || job.status;
          $('progressCount').textContent = p.total ? `${p.done} / ${p.total} simulations` : '';
          $('progressLog').textContent = (job.log || []).slice(-8).join('\n');
          $('progressLog').scrollTop = 1e6;
          if (job.status === 'done') { lastResult = job.result; renderResults(job.result); resolve(); }
          else if (job.status === 'error') reject(new Error(job.error || 'Optimization failed'));
          else setTimeout(tick, 1500);
        } catch (e) { reject(e); }
      };
      tick();
    });
  }
  $('optimize').onclick = optimize;

  /* ---------- results ---------- */
  let dayView = 'weekday', carpetView = 'best';
  function renderResults(r) {
    const b = r.best, base = r.baseline, c = comfort();
    $('resultsEmpty').classList.add('hidden');
    $('results').classList.remove('hidden');
    showPage('results');
    const place = (r.location && r.location.place) || 'your home';
    $('resultLead').textContent = `${place}. ${r.model.runs} annual simulations finished in ${fmt(r.elapsed_s / 60, 1)} min. Lowest bill inside ${c.t_min}–${c.t_max} °C: heat to ${b.heat_sp} °C and cool to ${b.cool_sp} °C${b.resolution === 'hourly' && b.setback ? `, relaxing by ${b.setback} °C while asleep or away` : ''}. Lighting and appliances are inside this bill.`;
    const k = b.annual_kwh, kb = base.annual_kwh;
    $('kpis').innerHTML = `
      <div class="kpi heat"><span>Heating · annual</span><strong>${int(k.heating)} kWh</strong><em>baseline ${int(kb.heating)} kWh</em></div>
      <div class="kpi cool"><span>Cooling · annual</span><strong>${int(k.cooling)} kWh</strong><em>baseline ${int(kb.cooling)} kWh</em></div>
      <div class="kpi bill"><span>Optimized electricity bill</span><strong>${money(b.bill.total)}</strong><em>${fmt(b.bill.avg_price, 3)} $/kWh average</em></div>
      <div class="kpi"><span>Baseline electricity bill</span><strong>${money(base.bill.total)}</strong><em>${int(kb.total)} kWh · as delivered</em></div>
      <div class="kpi save"><span>Annual savings</span><strong>${money(r.savings.annual_usd)}</strong><em>${fmt(r.savings.share * 100, 1)} % lower bill</em></div>
      <div class="kpi"><span>Total electricity</span><strong>${int(k.total)} kWh</strong><em>${fmt(b.comfort.inside_share * 100, 1)} % of awake hours in range</em></div>`;

    renderBill(r);
    renderLighting();
    renderAppliances(r);
    renderSetpoints(r);
    $('sweepNote').textContent = r.plan.strategy === 'full'
      ? `Every heating × cooling combination inside your range was simulated (${r.candidates.length} schedules).`
      : `Heating setpoints were swept with cooling held at ${c.t_max} °C, cooling setpoints with heating held at ${c.t_min} °C; the best pair was then confirmed in a final run.`;
    Charts.sweep($('sweepChart'), r);
    Charts.monthly($('monthlyChart'), base.monthly, b.monthly);
    renderCarpet(r);
    renderCandidates(r);
    renderMethod(r);
    window.scrollTo({ top: 0, behavior: 'smooth' });
  }

  function renderBill(r) {
    if (!r.best.breakdown) return;
    Charts.breakdown($('billChart'), r.baseline.breakdown, r.best.breakdown);
    const was = Object.fromEntries(r.baseline.breakdown.map(x => [x.key, x]));
    const rows = r.best.breakdown.map(x => {
      const b = was[x.key] || { kwh: 0, cost: 0 };
      const delta = x.cost - b.cost;
      return `<tr><td>${x.label}</td><td class="r">${int(b.kwh)}</td><td class="r">${money(b.cost)}</td><td class="r">${int(x.kwh)}</td><td class="r">${money(x.cost)}</td><td class="r ${delta < -0.5 ? 'good' : ''}">${delta > 0.5 ? '+' : ''}${money(delta)}</td></tr>`;
    }).join('');
    $('billTable').innerHTML = `<thead><tr><th>End use</th><th class="r">Baseline kWh</th><th class="r">Baseline</th><th class="r">Optimized kWh</th><th class="r">Optimized</th><th class="r">Change</th></tr></thead>
      <tbody>${rows}<tr><td><b>Basic service charge</b></td><td></td><td class="r">${money(r.baseline.bill.fixed)}</td><td></td><td class="r">${money(r.best.bill.fixed)}</td><td class="r">${money(0)}</td></tr>
      <tr><td><b>Annual bill</b></td><td class="r">${int(r.baseline.annual_kwh.total)}</td><td class="r">${money(r.baseline.bill.total)}</td><td class="r">${int(r.best.annual_kwh.total)}</td><td class="r">${money(r.best.bill.total)}</td><td class="r good">${money(r.best.bill.total - r.baseline.bill.total)}</td></tr></tbody>`;
  }

  function renderAppliances(r) {
    const apps = r.appliances || [];
    if (!apps.length) return;
    Charts.appliances($('applianceChart'), apps);
    const hh = h => `${String(h).padStart(2, '0')}:00`;
    $('applianceNote').textContent = 'Gray is the original weekday profile. Green is the shifted profile that EnergyPlus ran. The dryer uses the washer’s shift.';
    $('applianceTable').innerHTML = `<thead><tr><th>Appliance</th><th>Busiest hour</th><th class="r">Shift</th><th class="r">Tariff cost before</th><th class="r">Tariff cost after</th></tr></thead><tbody>${apps.map(a => `<tr><td>${a.label}${a.enabled ? '' : ' (left as-is)'}</td><td>${hh(a.peak_before)} → ${hh(a.peak_after)}</td><td class="r">${a.shift_hours ? '+' + a.shift_hours + ' h' : '—'}</td><td class="r">${money(a.baseline_cost)}</td><td class="r">${money(a.optimized_cost)}</td></tr>`).join('')}</tbody>`;
  }

  function renderSetpoints(r) {
    const b = r.best, c = comfort(), prof = b.profiles[dayView];
    document.querySelectorAll('#dayToggle button').forEach(x => x.classList.toggle('on', x.dataset.day === dayView));
    Charts.setpoint($('spChart'), prof, c);
    const sb = b.resolution === 'hourly' ? b.setback : 0;
    $('spSummary').innerHTML = b.resolution === 'hourly'
      ? `<b>Hourly schedule.</b> While home and awake: heat to <b>${b.heat_sp} °C (${cToF(b.heat_sp)} °F)</b>, cool to <b>${b.cool_sp} °C (${cToF(b.cool_sp)} °F)</b>. While asleep${occ().wfh ? '' : ' or away at work'}: heating drops to ${(b.heat_sp - sb).toFixed(1)} °C and cooling rises to ${(b.cool_sp + sb).toFixed(1)} °C. ${fmt(b.comfort.inside_share * 100, 1)} % of your awake-at-home hours stay inside the comfort range (±0.5 °C).`
      : `<b>Daily constant setpoints.</b> Heat to <b>${b.heat_sp} °C (${cToF(b.heat_sp)} °F)</b> and cool to <b>${b.cool_sp} °C (${cToF(b.cool_sp)} °F)</b> every hour of the year. ${fmt(b.comfort.inside_share * 100, 1)} % of your awake-at-home hours stay inside the comfort range (±0.5 °C).`;
    const wd = b.profiles.weekday, we = b.profiles.weekend;
    const row = h => `<tr><td>${String(h).padStart(2, '0')}:00–${String(h + 1).padStart(2, '0')}:00</td><td>${wd.state[h]}</td><td class="r">${wd.heating[h]} °C / ${cToF(wd.heating[h])} °F</td><td class="r">${wd.cooling[h]} °C / ${cToF(wd.cooling[h])} °F</td><td>${we.state[h]}</td><td class="r">${we.heating[h]} °C / ${cToF(we.heating[h])} °F</td><td class="r">${we.cooling[h]} °C / ${cToF(we.cooling[h])} °F</td></tr>`;
    $('spTable').innerHTML = `<thead><tr><th>Hour</th><th>Weekday</th><th class="r">Heating</th><th class="r">Cooling</th><th>Weekend</th><th class="r">Heating</th><th class="r">Cooling</th></tr></thead><tbody>${b.resolution === 'hourly' ? Array.from({ length: 24 }, (_, h) => row(h)).join('') : `<tr><td>All hours</td><td>every day</td><td class="r">${b.heat_sp} °C / ${cToF(b.heat_sp)} °F</td><td class="r">${b.cool_sp} °C / ${cToF(b.cool_sp)} °F</td><td>every day</td><td class="r">${b.heat_sp} °C / ${cToF(b.heat_sp)} °F</td><td class="r">${b.cool_sp} °C / ${cToF(b.cool_sp)} °F</td></tr>`}</tbody>`;
  }
  $('dayToggle').onclick = e => { if (e.target.dataset.day && lastResult) { dayView = e.target.dataset.day; renderSetpoints(lastResult); } };
  $('spCsv').onclick = () => {
    if (!lastResult) return;
    const b = lastResult.best, rows = [];
    ['weekday', 'weekend'].forEach(d => { const p = b.profiles[d]; for (let h = 0; h < 24; h++) rows.push({ day_type: d, hour_start: `${String(h).padStart(2, '0')}:00`, occupancy: p.state[h], heating_setpoint_c: p.heating[h], cooling_setpoint_c: p.cooling[h], heating_setpoint_f: cToF(p.heating[h]), cooling_setpoint_f: cToF(p.cooling[h]) }); });
    download('recommended_thermostat_setpoints.csv', rows);
  };

  function renderCarpet(r) {
    document.querySelectorAll('#carpetToggle button').forEach(x => x.classList.toggle('on', x.dataset.run === carpetView));
    Charts.carpet($('carpet'), (carpetView === 'best' ? r.best : r.baseline).hourly_zone_temp, $('carpetLegend'), tip);
  }
  $('carpetToggle').onclick = e => { if (e.target.dataset.run && lastResult) { carpetView = e.target.dataset.run; renderCarpet(lastResult); } };

  function renderCandidates(r) {
    const baseBill = r.baseline.bill.total;
    const rows = r.candidates.map(c => `<tr class="${c.tag === r.best.tag ? 'best' : ''}"><td>${c.heat_sp} °C</td><td>${c.cool_sp} °C</td><td class="r">${int(c.heating_kwh)}</td><td class="r">${int(c.cooling_kwh)}</td><td class="r">${int(c.total_kwh)}</td><td class="r">${money(c.bill)}</td><td class="r">${money(c.bill - baseBill)}</td><td>${c.tag === r.best.tag ? 'Recommended' : c.confirmation ? 'Confirmation run' : ''}</td></tr>`).join('');
    $('candTable').innerHTML = `<thead><tr><th>Heating setpoint</th><th>Cooling setpoint</th><th class="r">Heating kWh</th><th class="r">Cooling kWh</th><th class="r">Total kWh</th><th class="r">Annual bill</th><th class="r">Δ vs baseline</th><th></th></tr></thead>
      <tbody><tr><td colspan="2"><b>Baseline (as delivered)</b></td><td class="r">${int(r.baseline.annual_kwh.heating)}</td><td class="r">${int(r.baseline.annual_kwh.cooling)}</td><td class="r">${int(r.baseline.annual_kwh.total)}</td><td class="r">${money(baseBill)}</td><td class="r">—</td><td></td></tr>${rows}</tbody>`;
  }

  function renderMethod(r) {
    const c = comfort(), t = tariff(), s = r.model.scaling || {};
    $('method').innerHTML = `
      <p><b>Building model.</b> ${r.model.idf} — a single-storey EnergyPlus prototype home for Buffalo (climate zone 5A) with electric resistance heating, single-speed DX cooling, an energy-recovery ventilator and a heat-pump water heater, simulated at a 10-minute timestep with ${r.model.weather}.</p>
      <p><b>Floor plan.</b> ${s.scaled ? `The footprint was scaled by × ${fmt(s.factor, 3)} so the conditioned area equals your ${fmt(s.target_area_m2, 1)} m² (model as delivered: ${fmt(s.model_area_m2, 1)} m²). Window-to-wall ratio, air-leakage area and ventilation airflow scale with it; HVAC equipment is re-autosized.` : `The model's original ${fmt(r.model.original_area_m2, 1)} m² footprint was kept.`}</p>
      <p><b>Location.</b> ${r.location ? r.location.place : 'Buffalo, NY'}, front facing ${r.location ? r.location.facing : 'south'} (EnergyPlus north axis ${r.model.north_axis || 0}°). ${r.location && r.location.note ? r.location.note : ''}</p>
      <p><b>Lighting.</b> Interior lights follow your room inventory and the WattWise hourly plan for winter, spring/fall and summer, weekdays and weekends. That electricity is priced with the same hourly tariff as heating and cooling and appears on the lighting line of the one bill. The heat from the lamps also changes the heating and cooling loads.</p>
      <p><b>Appliances.</b> Dishwasher, clothes washer, electric dryer and range keep their annual energy but are shifted into the hours you allowed. Washer and dryer move together. Their meters are priced with the same tariff and shown as their own lines on the bill.</p>
      <p><b>Thermostat sweep.</b> Heating candidates ${r.plan.heat.join(', ')} °C and cooling candidates ${r.plan.cool.join(', ')} °C (step ${c.step} °C, minimum deadband ${r.plan.deadband} °C) using the ${r.plan.strategy === 'full' ? 'full grid' : 'separable'} strategy — ${r.model.runs} annual simulations on ${r.model.workers} parallel workers in ${fmt(r.elapsed_s / 60, 1)} min. ${c.resolution === 'hourly' ? `Hourly schedules relax the band by ${c.setback} °C while you are asleep or away, following your routine from step 1.` : 'Daily mode holds one heating and one cooling setpoint all day.'}</p>
      <p><b>Bill.</b> Every hour of simulated whole-house electricity is priced with ${t.mode === 'flat' ? `the flat ${fmt(t.flat, 3)} $/kWh rate` : 'the National Grid VTOU structure (published delivery periods plus your supply prices, super-peak on summer weekdays 2–6 PM)'} plus a ${fmt(t.fixed)} $/month basic service charge. Riders, taxes and demand charges are excluded.</p>
      <p><b>Baseline.</b> ${r.baseline.description}</p>
      <p><b>Limitations.</b> Single thermal zone, TMY3 typical weather (not a specific year), simplified daylight and lumen-method lighting, prototype envelope and equipment rather than your actual house. Results support decisions; they do not forecast a utility bill.</p>`;
  }

  /* ---------- boot ---------- */
  async function boot() {
    try {
      modelInfo = await (await fetch('/api/model')).json();
      if (modelInfo.error) throw new Error(modelInfo.error);
      $('heroChips').innerHTML = `
        <span class="chip ${modelInfo.energyplus_found ? 'ok' : 'bad'}">EnergyPlus 26.1 · ${modelInfo.energyplus_found ? 'ready' : 'not found'}</span>
        <span class="chip">${modelInfo.weather.replace('.epw', '')}</span>
        <span class="chip">${modelInfo.idf.replace(/\s*\(\d+\)/, '').replace('.idf', '')}</span>
        <span class="chip">${modelInfo.heating_system}</span>
        <span class="chip">${modelInfo.workers} parallel workers</span>`;
    } catch (e) {
      $('heroChips').innerHTML = `<span class="chip bad">Server unavailable: ${e.message}</span>`;
    }
    syncRange();
    renderLighting();
    refreshAdvisor();
  }

  function showPage(name) {
    ['home', 'results', 'advisor'].forEach(p => $('page-' + p).classList.toggle('hidden', p !== name));
    document.querySelectorAll('#pageNav button').forEach(b => b.classList.toggle('on', b.dataset.page === name));
    if (name === 'advisor') refreshAdvisor();
    if (name === 'results' && lastResult) requestAnimationFrame(() => renderCarpet(lastResult));
    window.scrollTo({ top: 0, behavior: 'smooth' });
  }
  document.body.addEventListener('click', e => {
    const b = e.target.closest('[data-page]');
    if (b && b.dataset.page && !e.target.closest('#dayToggle, #carpetToggle')) showPage(b.dataset.page);
  });

  const chat = [];
  const escapeChat = s => String(s).replace(/[&<>]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;' }[c]));
  const cleanReply = s => String(s || '').replaceAll('*', '');
  function renderThread(thinking) {
    $('thread').innerHTML = `<div class="bubble bot">Ask how to use the plan — when to set the thermostat back, when to run the dishwasher, or why the bill moved.</div>`
      + chat.map(t => `<div class="bubble ${t.role === 'user' ? 'me' : 'bot'}">${escapeChat(t.role === 'assistant' ? cleanReply(t.content) : t.content)}</div>`).join('')
      + (thinking ? `<div class="bubble bot thinking" aria-label="Thinking"><span class="dots"><i></i><i></i><i></i></span></div>` : '');
    $('thread').scrollTop = $('thread').scrollHeight;
  }
  async function refreshAdvisor() {
    try {
      const s = await (await fetch('/api/llm')).json();
      const box = $('llmStatus');
      const btn = $('llmDownload');
      btn.classList.add('hidden');
      if (s.state === 'ready') box.innerHTML = `<b>${s.model}</b> is on this computer and ready. License: ${s.license}.`;
      else if (s.state === 'downloading' || s.state === 'loading') {
        const pct = Math.round((s.progress || 0) * 100);
        const mb = s.total ? `${(s.bytes / 1e6).toFixed(0)} / ${(s.total / 1e6).toFixed(0)} MB` : `${(s.bytes / 1e6).toFixed(0)} MB`;
        box.innerHTML = `${s.state === 'loading' ? 'Loading' : 'Downloading'} <b>${s.model}</b>… ${pct}% <span class="small">${mb}</span><div class="bar"><div style="width:${pct}%"></div></div>`;
        setTimeout(refreshAdvisor, 1500);
      } else if (s.state === 'error') {
        box.innerHTML = `The download stopped: ${s.error}`;
        btn.classList.remove('hidden');
      } else {
        box.innerHTML = `<b>${s.model}</b> is not downloaded yet.`;
        btn.classList.remove('hidden');
      }
    } catch (e) { $('llmStatus').textContent = 'Advisor status unavailable.'; }
  }
  $('llmDownload').onclick = async () => { await fetch('/api/llm/download', { method: 'POST' }); refreshAdvisor(); };
  let asking = false;
  function setAsking(on) {
    asking = on;
    $('question').disabled = on;
    $('ask').querySelector('button').disabled = on;
    $('suggestions').querySelectorAll('button').forEach(b => { b.disabled = on; });
  }
  async function ask(text) {
    text = text.trim();
    if (!text || asking) return;
    $('askError').textContent = '';
    chat.push({ role: 'user', content: text });
    $('question').value = '';
    setAsking(true);
    renderThread(true);
    try {
      const res = await fetch('/api/chat', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ message: text, history: chat.slice(0, -1) }) });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || res.statusText);
      chat.push({ role: 'assistant', content: cleanReply(data.reply) });
    } catch (e) {
      chat.pop();
      $('askError').textContent = e.message;
    } finally {
      setAsking(false);
      renderThread();
    }
  }
  $('ask').addEventListener('submit', e => { e.preventDefault(); ask($('question').value); });
  $('suggestions').addEventListener('click', e => { if (e.target.tagName === 'BUTTON') ask(e.target.textContent); });

  ['wake', 'work', 'end', 'bed', 'wfh', 'season', 'daylux', 'tariff', 'flat', 'offsupply', 'onsupply', 'supersupply', 'fixed', 'otherArea', 'extDuty', 'scaleModel', 'place', 'facing'].forEach(id => $(id).addEventListener('change', renderLighting));
  $('rooms').addEventListener('change', renderLighting);
  boot();
})();
