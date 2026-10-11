/* WattWise Buffalo lighting engine.
 * Pure-function port of the original app.js calculation code (occupancy rules, simplified
 * lumen method, fixture allocation, tariff pricing). No DOM access; everything is parameterised
 * so the same engine can feed both the on-page schedule view and the EnergyPlus lighting inputs.
 */
const WattWise = (() => {
  const DEFAULT_ROOMS = [
    { name: 'Kitchen', area: 16, lux: 300, lpd: 9, fixtures: [['Under-cabinet', 2, 7, 800], ['Downlights', 6, 9, 1100], ['Pendant', 2, 8, 900]] },
    { name: 'Home office', area: 12, lux: 500, lpd: 9, fixtures: [['Desk lamp', 1, 20, 2500], ['Downlights', 6, 14, 1700]] },
    { name: 'Living room', area: 22, lux: 150, lpd: 8, fixtures: [['Floor lamp', 2, 9, 800], ['Sconces', 4, 7, 550], ['Downlights', 6, 9, 800]] },
    { name: 'Bedroom', area: 15, lux: 100, lpd: 8, fixtures: [['Bedside lamp', 2, 7, 600], ['Ceiling light', 1, 16, 2000]] },
    { name: 'Bathroom', area: 8, lux: 200, lpd: 9, fixtures: [['Vanity sconces', 2, 9, 900], ['Downlights', 2, 9, 950]] },
    { name: 'Hallway', area: 9, lux: 75, lpd: 6, fixtures: [['Downlights', 3, 7, 550]] },
    { name: 'Exterior', area: 15, lux: 0, lpd: 0, fixtures: [['Porch sconces', 2, 8, 650]] },
  ];

  // Approximate Buffalo sunrise / sunset (decimal hours) used by the original planner.
  const SEASONS = {
    winter: { a: 7.67, b: 16.7, label: 'Winter · sunrise ≈ 7:40, sunset ≈ 4:42', months: 'Dec–Feb' },
    shoulder: { a: 7.48, b: 18.53, label: 'Spring / fall · sunrise ≈ 7:29, sunset ≈ 6:32', months: 'Mar–May, Sep–Nov' },
    summer: { a: 5.6, b: 20.93, label: 'Summer · sunrise ≈ 5:36, sunset ≈ 8:56', months: 'Jun–Aug' },
  };

  const sunlight = (h, season) => { const s = SEASONS[season] || SEASONS.shoulder; return h >= s.a && h < s.b; };

  /* $/kWh at hour h. tariff = {mode, flat, offSupply, onSupply, superSupply}. Super-peak applies to
   * summer weekdays 2–6 PM. Published National Grid VTOU delivery: 12.633¢ on-peak, 1.299¢ off-peak. */
  function price(h, tariff, season, weekend = false) {
    if (tariff.mode === 'flat') return +tariff.flat;
    const peak = h >= 7 && h < 23;
    const superpeak = season === 'summer' && !weekend && h >= 14 && h < 18;
    return (peak ? 0.12633 : 0.01299) + (superpeak ? +tariff.superSupply : peak ? +tariff.onSupply : +tariff.offSupply);
  }

  /* Inferred activity mode for a room at hour h (original heuristic). occ = {wake, work, end, bed, wfh}.
   * weekend = true treats the occupant as home all day with no work block. */
  function occupied(room, h, occ, weekend = false) {
    const w = occ.wake, a = occ.work, e = occ.end, b = occ.bed;
    const home = weekend ? true : occ.wfh;
    const workday = !weekend;
    if (h < w || h >= b) return room === 'Hallway' ? 'night' : room === 'Exterior' ? 'motion' : 'off';
    if (!home && h >= a && h < e) return room === 'Exterior' ? 'motion' : 'off';
    if (room === 'Kitchen') return (h >= w && h < w + 1) || (h >= e && h < e + 2) ? 'task' : 'off';
    if (room === 'Home office') return workday && home && h >= a && h < e ? 'task' : 'off';
    if (room === 'Living room') return (h >= w + 1 && h < a) || (h >= e + 2 && h < b) ? 'task' : 'off';
    if (room === 'Bedroom') return (h >= w && h < w + 1) || (h >= b - 1 && h < b) ? 'task' : 'off';
    if (room === 'Bathroom') return (h >= w && h < w + 1) || (h >= b - 1 && h < b) ? 'task' : 'off';
    if (room === 'Hallway') return 'night';
    if (room === 'Exterior') return 'motion';
    return 'off';
  }

  /* Lumen-method fixture allocation: utilisation 0.60 × maintenance 0.80, most efficient fixtures first. */
  function solve(r, h, mode, season, daylux) {
    const daylight = sunlight(h, season) && r.name !== 'Exterior' && r.name !== 'Hallway' ? Math.max(0, +daylux) : 0;
    const target = mode === 'task' ? r.lux : mode === 'night' ? Math.min(15, r.lux) : 0;
    if (mode === 'off') return { power: 0, lux: daylight, parts: [], met: true, daylight, target };
    if (mode === 'motion') return { power: 0, lux: 0, parts: [], met: true, daylight: 0, target };
    const needed = Math.max(0, target - daylight);
    const options = r.fixtures.map(f => ({ name: f[0], power: f[1] * f[2], lux: f[1] * f[3] * .6 * .8 / r.area }))
      .filter(x => x.power > 0 && x.lux > 0).sort((a, b) => (b.lux / b.power) - (a.lux / a.power));
    let power = 0, lit = 0; const parts = [];
    for (const o of options) {
      if (lit >= needed - 0.001) break;
      const frac = Math.min(1, (needed - lit) / o.lux);
      power += frac * o.power; lit += frac * o.lux; parts.push(`${o.name} ${Math.round(frac * 100)}%`);
    }
    return { power, lux: lit + daylight, parts, met: lit + daylight + 0.01 >= target, daylight, target };
  }

  const installedWatts = r => r.fixtures.reduce((a, f) => a + f[1] * f[2], 0);
  const fullOnLux = r => r.fixtures.reduce((a, f) => a + f[1] * f[3] * .48 / r.area, 0);

  /* 24 hourly electric lighting watts for one room on a representative day. */
  function roomProfile(r, occ, season, daylux, weekend = false) {
    const out = [];
    for (let h = 0; h < 24; h++) {
      const mode = occupied(r.name, h + .5, occ, weekend);
      out.push(solve(r, h + .5, mode, season, daylux).power);
    }
    return out;
  }

  /* Exterior fixtures run on a motion sensor: installed watts × duty cycle while it is dark. */
  function exteriorProfile(r, season, duty) {
    const w = installedWatts(r) * Math.min(1, Math.max(0, duty));
    return Array.from({ length: 24 }, (_, h) => (!sunlight(h + .5, season) ? w : 0));
  }

  /* Full representative-weekday plan (identical maths to the original render()). */
  function plan(rooms, occ, tariff, season, daylux) {
    const records = []; const cells = []; const notes = [];
    let kwh = 0, cost = 0, base = 0, basecost = 0, unmet = 0;
    rooms.forEach(r => {
      const watts = installedWatts(r), lpd = watts / r.area, fullLux = fullOnLux(r);
      let hours = 0; const row = [];
      for (let h = 0; h < 24; h++) {
        const mode = occupied(r.name, h + .5, occ), x = solve(r, h + .5, mode, season, daylux);
        const e = x.power / 1000, p = price(h + .5, tariff, season);
        const baseline = (mode === 'task' ? watts : mode === 'night' ? watts * .25 : 0) / 1000;
        kwh += e; cost += e * p; base += baseline; basecost += baseline * p;
        if (!x.met) unmet++; if (e > 0) hours++;
        records.push({ room: r.name, hour: h, activity: mode, daylight_lux: x.daylight.toFixed(2), target_lux: x.target,
          estimated_lux: x.lux.toFixed(2), estimated_watts: x.power.toFixed(2), selected_fixtures: x.parts.join('; '),
          price_per_kwh: p.toFixed(4), hourly_cost: (e * p).toFixed(4), target_met: x.met ? 'yes' : 'no' });
        row.push({ mode, power: x.power, lux: x.lux, parts: x.parts, met: x.met });
      }
      cells.push({ room: r.name, hours, lpd, watts, row });
      if (r.name !== 'Exterior' && r.lpd > 0 && lpd > r.lpd)
        notes.push({ kind: 'warn', title: `${r.name}: installed LPD benchmark exceeded`, text: `${lpd.toFixed(2)} W/m² vs editable benchmark ${r.lpd} W/m². Review fixture power and applicable residential energy-code provisions. This is not a code violation determination.` });
      if (r.name !== 'Exterior' && fullLux < r.lux)
        notes.push({ kind: 'warn', title: `${r.name}: potential illuminance shortfall`, text: `Estimated full-on ${fullLux.toFixed(0)} lx vs selected ${r.lux} lx before daylight. Review task lighting, actual fixture photometry and room layout.` });
    });
    return { records, cells, notes, kwh, cost, base, basecost, unmet };
  }

  return { DEFAULT_ROOMS, SEASONS, sunlight, price, occupied, solve, plan, roomProfile, exteriorProfile, installedWatts, fullOnLux };
})();
