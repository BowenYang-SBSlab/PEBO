# WattWise Buffalo — Occupant-Centered Lighting Planner

A browser-based, rule-driven **demonstration** of household lighting scheduling and energy-cost estimation for Buffalo, New York. This repository is extracted from the delivered standalone `wattwise_buffalo.html`; the calculation code in `app.js` is the original application logic, not a newly invented implementation.

## Files

- `index.html` — page layout and form inputs; references `styles.css` and `app.js`.
- `styles.css` — visual styling extracted from the original HTML.
- `app.js` — original room inventory, schedule rules, lux/LPD/energy calculations, recommendations, CSV export.
- `original_standalone.html` — exact standalone HTML from the prior prototype (runs without other files).

## Run

Open `index.html` in Chrome/Edge/Firefox. No npm, server, dependencies, API keys, or account required. Alternatively open `original_standalone.html`.

## Inputs and example inventory

The UI accepts wake, work-start, work-end and bedtime; whether the occupant works from home; season; daylight contribution (lux); tariff mode and prices; room areas, lux targets and LPD benchmarks; and fixture quantities, watts and lumens. The `rooms` array at the top of `app.js` contains seven example areas: Kitchen, Home office, Living room, Bedroom, Bathroom, Hallway and Exterior.

The defaults are **illustrative** and should be replaced with verified fixture, room, occupancy and billing information.

## Calculation workflow (actual code)

1. `occupied(room, h)` maps each hour to a simple inferred mode (`task`, `night`, `motion`, `off`) using the occupant's routine. The inference is heuristic: it does not observe occupancy or allow a fully custom schedule for each room.
2. `sunlight(h)` selects an approximate sunrise/sunset window from three seasonal presets (winter/summer/October). `solve()` applies the **same user-entered daylight lux** to most indoor rooms during that window; no orientation, weather, shading or daylight simulation is used. Hallway and Exterior receive no daylight offset.
3. For each fixture group, estimated contribution at full output is:

   `estimated_lux = fixture_quantity * lumens_per_fixture * 0.60 * 0.80 / room_area_m2`

   These fixed 0.60 utilization and 0.80 maintenance factors are assumptions, **not** measured values or photometric simulation.
4. `solve()` sorts fixture groups by `estimated_lux / group_watts` and allocates fractional output until it reaches `max(0, target_lux - daylight_lux)`, or runs out of available fixtures. It assumes continuous dimming and **linear electrical power vs. light output**. It does not model task-plane distribution, individual fixture control limitations, color/comfort, glare, or minimum dimming levels.
5. Installed room LPD is `sum(quantity * watts) / area_m2` in W/m². The entered benchmark is **editable demonstration data**, not a verified legal maximum. For most single-family dwellings, do not assume commercial-style room LPD limits apply.
6. Hourly energy is `selected_watts / 1000` kWh for a one-hour block. Hourly variable cost is `hourly_kWh * price_per_kWh`; daily totals are multiplied by **30** for monthly estimates. This assumes the same schedule every day.
7. Baseline: during inferred `task` hours, **all installed lights are fully on**; hallway `night` mode assumes 25% installed wattage. Motion-only exterior operation is treated as zero consumption until a duty cycle is supplied. Savings are baseline cost minus optimized cost (clamped at zero for display). **Not actual household savings.**
8. Recommendation cards flag installed LPD above the editable benchmark, full-on estimated lux below the selected target, and suggest prioritizing task/efficient fixtures. These are deterministic rule-based messages, not AI or measured results.
9. The CSV export contains one row per room-hour, with mode, daylight estimate, target lux, estimated lux, power, chosen fixtures, tariff and cost.

## Electricity pricing: what is and is not local

- `flat` tariff uses an editable constant $/kWh (default set in the HTML).
- The example `TOU` calculation in `price(h)` adds hard-coded **example delivery** components: `0.12633` $/kWh on-peak (07:00–23:00), `0.01299` $/kWh off-peak (23:00–07:00), plus user-entered supply rates.
- For the `summer` season, 14:00–18:00 receives the user-entered super-peak supply rate **every simulated day**; the code does not check weekday, holidays, exact calendar date, customer rate class, rider, taxes, demand or fixed fees.
- **No live National Grid tariff API, actual Buffalo customer bill, or hourly real-time electricity pricing is connected.** The preset periods/rates should not be treated as a verified current customer tariff; confirm against the household's actual utility rate schedule before estimating financial savings.

## Standards and limitations

- Room lux targets (e.g. kitchen 300 lx, office 500 lx) and LPD thresholds in the default `rooms` array are **editable illustrative benchmarks**, **not values fetched from IES, ASHRAE, the New York State code, or Buffalo municipal records**.
- No live location-aware standards lookup, IES photometric file parsing, daylight model, compliance assessment, or tariff update exists.
- LPD is an installed-power metric, distinct from time-varying lighting consumption. Illuminance should be evaluated on appropriate task planes, not only using a whole-room average.
- Outdoor lighting should be assessed with its applicable area-based/power allowance framework rather than the indoor room LPD formula.
- The engine may report a target shortfall; it does not magically meet an impossible lux target. Also, its calculated `met` status depends on approximate lumens and simplified assumptions, not verified field performance.
- Fixture selection ignores some practical needs (e.g. countertop vs ceiling distribution, manual switches, minimum driver power, visual comfort).

## How to adapt for a research-grade prototype

1. Select and document the adopted NYS energy code and applicable residential lighting provisions; use licensed IES residential recommendations for task-specific illuminance targets. Store source, edition, measurement plane and applicability per criterion.
2. Collect measured room geometry and fixture photometry/IES files, luminaire efficacy and dimming curves. Validate predicted task-plane lux against measurements or a lighting simulation.
3. Let users specify activities and occupancy for **each room** and allow overrides.
4. Add Buffalo daylight from date, latitude, weather and window/orientation inputs, rather than the fixed daylight contribution.
5. Obtain the **actual** National Grid tariff and customer rate plan; account for weekdays, seasonal boundaries, fees and actual interval price data if applicable.
6. Optimize per fixture/circuit with constraints on task illuminance, visual comfort, safety and controllability. Show feasible/infeasible scenarios and uncertainty ranges.
7. Use a measured or explicitly chosen baseline and disclose assumptions when reporting savings.

## Editing the code

- Room/fixture defaults: `const rooms = [...]` at top of `app.js`.
- Occupancy rules: `occupied(room,h)`.
- Daylight assumptions: `sunlight(h)` and `solve()`.
- Tariff logic: `price(h)`.
- Optimization: `solve(r,h,mode)`.
- Dashboard/recommendations/export: `render()` and CSV button handler.

## License / provenance

Generated as an editable demonstration for this conversation. No third-party JavaScript libraries are bundled.
