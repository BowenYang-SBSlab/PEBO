# Personal Building Energy Optimizer

A local web app that lowers the annual electricity bill of a single-family home in Buffalo, New York. You set a comfortable indoor temperature range, a daily routine, and when the dishwasher, washer, dryer, and range may run. The app then searches that range with EnergyPlus and prices every hour on one tariff, so heating, cooling, lighting, and appliances land on the same bill.

Nothing is uploaded. EnergyPlus runs on this machine, and the advisor is a local open-source model.

## The three pages

**Your home.** Address, which way the front faces, comfort range, daily routine, lighting fixtures, and the four appliance windows. The floor-plan sketch can be edited by typing an area or dragging a room. That sketch is for display only and is not sent to EnergyPlus. The room table above it is what the lighting calculation uses.

**Your plan.** The recommended heating and cooling setpoints (hourly or one setpoint for the whole day), the annual bill before and after, heating and cooling energy, and the lighting schedule generated from the daily routine. Lighting is one line on the same bill.

**Ask the advisor.** A locally downloaded Qwen2.5 1.5B model answers questions about the finished run. Dollar amounts, kilowatt-hours, percentages, temperatures, and appliance clock times are checked against the simulation. If a reply invents a figure, it is rewritten from the real results. Pebo, the sun mascot, sits on each page.

A **Utility Announcements** banner on the advisor page is a demonstration only. The two choices highlight a selection and do not change the setpoints.

## What you need

- Windows
- [EnergyPlus 26.1](https://energyplus.net/) at `C:\EnergyPlusV26-1-0` (or set `ENERGYPLUS_DIR`)
- Python 3.10 or newer
- For the advisor only: `llama-cpp-python` (see below). The optimization itself uses the standard library.

The building model and the Buffalo TMY3 weather file ship in [`model/`](model/).

## Run

```bat
cd personal_energy_optimizer
python server.py
```

Or double-click `run.bat`. The site opens at [http://127.0.0.1:8765/](http://127.0.0.1:8765/).

The first visit to **Ask the advisor** downloads Qwen2.5-1.5B-Instruct (Q4_K_M, Apache-2.0, about 1.1 GB) into `models/`. That file is not in this repository. Install the runtime before chatting:

```bat
pip install --only-binary=:all: -r requirements.txt --extra-index-url https://abetlen.github.io/llama-cpp-python/whl/cpu
```

Run an optimization before asking a question. The advisor reads the latest finished job, which lives in memory until the server stops.

## How a run works

1. The baseline keeps the model's original thermostat, lighting fraction, and appliance schedules, on the same footprint and orientation as the candidates.
2. Candidates walk the comfort range. Heating is swept with cooling held at the warm edge, then cooling is swept with heating held at the cool edge, and the best pair is confirmed. A full grid is available from the plan panel and is capped at 60 EnergyPlus runs.
3. Each run is a full year. Ground heat-transfer objects are removed before the run so EnergyPlus 26.1 can execute without ExpandObjects.
4. The bill is hourly whole-building electricity times the tariff, plus the monthly customer charge. Flat and National Grid Upstate New York VTOU are both available. The same prices apply to heating, cooling, lighting, and equipment.
5. Dishwasher, clothes washer, electric dryer, and electric range keep their diversity profiles and are shifted into the hours you allow, toward the cheaper part of the tariff. The dryer follows the washer when that option is on.

If the address is outside the Buffalo weather file (Buffalo, Niagara, Williamsville, Amherst, Tonawanda), the app still runs Buffalo TMY3 and says so on the result.

## Layout

| Path | Role |
| --- | --- |
| `server.py` | Local server on `127.0.0.1:8765` |
| `optimizer.py` | IDF edits, EnergyPlus runs, tariff, appliance shifts |
| `llm.py` | Model download, chat, and fact check |
| `static/` | The three pages, lighting engine, and Pebo |
| `model/` | IDF and Buffalo EPW |
| `models/` | Downloaded GGUF (not committed) |
| `runs/` | EnergyPlus output (not committed) |

Override the model folder with `EP_MODEL_DIR`. If `model/` has no IDF, the app falls back to a sibling folder named `EP model line`.

## API

| Method | Path | Purpose |
| --- | --- | --- |
| GET | `/api/model` | Installed model and EnergyPlus |
| POST | `/api/plan` | How many runs the comfort scan will make |
| POST | `/api/optimize` | Start a job |
| GET | `/api/jobs/<id>` | Progress and result |
| GET | `/api/llm` | Advisor download status |
| POST | `/api/llm/download` | Start the model download |
| POST | `/api/chat` | Ask about the latest result |

## Sources

The IDF is a single-family conversion of a PNNL multifamily Climate Zone 5A prototype, with inefficient setpoints and lighting. The weather file is Buffalo Niagara International TMY3. The advisor model is [Qwen2.5-1.5B-Instruct](https://huggingface.co/Qwen/Qwen2.5-1.5B-Instruct-GGUF) (Apache-2.0).

## Notes

- Comfort-range search on electric-resistance heat and single-speed cooling moves toward the edges of the range you allow. The useful choice is how wide that range is, and whether nights and away hours may drift past it.
- The lighting month on the plan page is one season. The lighting line in the bill is the full year.
- A server restart clears in-memory jobs. Run the optimization again before opening the advisor.
