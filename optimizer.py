"""EnergyPlus-backed thermostat optimizer for the Personal Building Energy Optimizer.

Pipeline
--------
1. Parse the delivered IDF (single-family, CZ5A, electric resistance heat + DX cooling).
2. Apply the occupant's floor plan (optional footprint scaling), WattWise lighting
   schedules, and a candidate heating/cooling setpoint schedule.
3. Run EnergyPlus (command line, local install) for the baseline model and for every
   candidate inside the comfort range. Runs execute in parallel.
4. Price every run with the user's tariff (flat or National Grid VTOU) and return the
   schedule with the lowest annual electricity bill.

Only the Python standard library is used.
"""
from __future__ import annotations

import csv
import math
import os
import re
import shutil
import subprocess
import threading
import time
from concurrent.futures import ThreadPoolExecutor, as_completed
from pathlib import Path

ROOT = Path(__file__).resolve().parent
EP_DIR = Path(os.environ.get("ENERGYPLUS_DIR", r"C:\EnergyPlusV26-1-0"))
EP_EXE = EP_DIR / "energyplus.exe"


def _model_dir() -> Path:
    """Bundled model/ first, then the sibling folder used during development."""
    override = os.environ.get("EP_MODEL_DIR")
    if override:
        return Path(override)
    bundled = ROOT / "model"
    if any(bundled.glob("*.idf")) and any(bundled.glob("*.epw")):
        return bundled
    return ROOT.parent / "EP model line"


MODEL_DIR = _model_dir()
RUNS_DIR = ROOT / "runs"

LIVING_ZONE = "living_unit1_FrontRow_BottomFloor"
HEATING_SCHEDULE = "heating_sch"
COOLING_SCHEDULE = "cooling_sch"
MAX_RUNS = 60
MAX_WORKERS = max(1, min((os.cpu_count() or 2) - 1, 8))

# National Grid Upstate NY published VTOU delivery charges ($/kWh)
VTOU_DELIVERY_ON = 0.12633   # 7 AM - 11 PM
VTOU_DELIVERY_OFF = 0.01299  # 11 PM - 7 AM

SEASON_BLOCKS = [  # (Through date, WattWise season key)
    ("2/28", "winter"),
    ("5/31", "shoulder"),
    ("8/31", "summer"),
    ("11/30", "shoulder"),
    ("12/31", "winter"),
]
MONTH_SEASON = {1: "winter", 2: "winter", 3: "shoulder", 4: "shoulder", 5: "shoulder",
                6: "summer", 7: "summer", 8: "summer", 9: "shoulder", 10: "shoulder",
                11: "shoulder", 12: "winter"}
MONTH_NAMES = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"]
DAYS_IN_MONTH = [31, 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31]


# --------------------------------------------------------------------------------------
# File discovery
# --------------------------------------------------------------------------------------
def find_model_files() -> tuple[Path, Path]:
    idfs = sorted(MODEL_DIR.glob("*.idf"))
    epws = sorted(MODEL_DIR.glob("*.epw"))
    if not idfs or not epws:
        raise FileNotFoundError(f"Expected one .idf and one .epw inside {MODEL_DIR}")
    return idfs[0], epws[0]


# --------------------------------------------------------------------------------------
# Minimal IDF object model
# --------------------------------------------------------------------------------------
class IDF:
    """Comment-free IDF representation: a list of field lists; field 0 is the object type."""

    def __init__(self, text: str):
        body = re.sub(r"!.*", "", text)
        self.objects: list[list[str]] = []
        for chunk in body.split(";"):
            fields = [f.strip() for f in chunk.split(",")]
            if len(fields) == 1 and not fields[0]:
                continue
            self.objects.append(fields)

    def find(self, obj_type: str, name: str | None = None) -> list[list[str]]:
        t = obj_type.lower()
        out = [o for o in self.objects if o[0].lower() == t]
        if name is not None:
            out = [o for o in out if len(o) > 1 and o[1].lower() == name.lower()]
        return out

    def remove(self, obj_type: str, name: str | None = None) -> int:
        victims = self.find(obj_type, name)
        self.objects = [o for o in self.objects if o not in victims]
        return len(victims)

    def add(self, fields: list) -> None:
        self.objects.append([str(f) for f in fields])

    def to_text(self) -> str:
        lines = []
        for o in self.objects:
            if len(o) == 1:
                lines.append(f"{o[0]};\n")
                continue
            lines.append(f"{o[0]},")
            for f in o[1:-1]:
                lines.append(f"    {f},")
            lines.append(f"    {o[-1]};\n")
        return "\n".join(lines)


def conditioned_floor_area(idf: IDF) -> float:
    """Area of Floor surfaces that belong to the living zone (m2)."""
    area = 0.0
    for o in idf.find("BuildingSurface:Detailed"):
        if o[2].lower() == "floor" and o[4].lower() == LIVING_ZONE.lower():
            pts = _vertices(o)
            area += _polygon_area_xy(pts)
    return area


def _vertices(surface: list[str]) -> list[list[float]]:
    try:
        n = int(float(surface[11]))
    except (ValueError, IndexError):
        return []
    coords = [float(v) for v in surface[12:12 + 3 * n]]
    return [coords[i:i + 3] for i in range(0, len(coords), 3)]


def _polygon_area_xy(pts: list[list[float]]) -> float:
    s = 0.0
    for i in range(len(pts)):
        x1, y1 = pts[i][0], pts[i][1]
        x2, y2 = pts[(i + 1) % len(pts)][0], pts[(i + 1) % len(pts)][1]
        s += x1 * y2 - x2 * y1
    return abs(s) / 2.0


# --------------------------------------------------------------------------------------
# Schedule helpers
# --------------------------------------------------------------------------------------
def _fmt(v: float) -> str:
    return f"{v:.4f}".rstrip("0").rstrip(".") if isinstance(v, float) else str(v)


def _until_fields(values: list[float]) -> list[str]:
    """Merge 24 hourly values into Until: HH:00,value pairs."""
    out = []
    start = 0
    for h in range(1, 25):
        if h == 24 or abs(values[h] - values[start]) > 1e-9:
            out.append(f"Until: {h:02d}:00")
            out.append(_fmt(values[start]))
            start = h
    return out


def compact_schedule(name: str, type_limits: str,
                     blocks: list[tuple[str, dict[str, list[float]]]]) -> list[str]:
    """blocks: [(through_date, {"Weekdays SummerDesignDay WinterDesignDay": [24], "AllOtherDays": [24]}), ...]"""
    fields = ["Schedule:Compact", name, type_limits]
    for through, day_types in blocks:
        fields.append(f"Through: {through}")
        for day_type, values in day_types.items():
            fields.append(f"For: {day_type}")
            fields.extend(_until_fields(values))
    return fields


# --------------------------------------------------------------------------------------
# Occupant rules (mirrors WattWise occupied())
# --------------------------------------------------------------------------------------
def occupancy_state(h: float, occ: dict, weekend: bool) -> str:
    """Return 'awake', 'asleep' or 'away' for hour-centre h."""
    wake, work_start, work_end, bed = occ["wake"], occ["work_start"], occ["work_end"], occ["bed"]
    if h < wake or h >= bed:
        return "asleep"
    if not weekend and not occ["wfh"] and work_start <= h < work_end:
        return "away"
    return "awake"


def thermostat_profiles(heat_sp: float, cool_sp: float, comfort: dict, occ: dict) -> dict:
    """24-hour heating/cooling arrays for weekdays and weekends."""
    setback = float(comfort.get("setback", 0.0)) if comfort["resolution"] == "hourly" else 0.0
    out = {}
    for key, weekend in (("weekday", False), ("weekend", True)):
        heat, cool, state = [], [], []
        for h in range(24):
            s = occupancy_state(h + 0.5, occ, weekend)
            relaxed = comfort["resolution"] == "hourly" and s in ("asleep", "away")
            heat.append(round(heat_sp - setback, 3) if relaxed else heat_sp)
            cool.append(round(cool_sp + setback, 3) if relaxed else cool_sp)
            state.append(s)
        out[key] = {"heating": heat, "cooling": cool, "state": state}
    return out


def apply_thermostat(idf: IDF, profiles: dict, heat_sp: float, cool_sp: float) -> None:
    idf.remove("Schedule:Compact", HEATING_SCHEDULE)
    idf.remove("Schedule:Compact", COOLING_SCHEDULE)
    wd, we = profiles["weekday"], profiles["weekend"]
    idf.add(compact_schedule(HEATING_SCHEDULE, "Temperature", [("12/31", {
        "WinterDesignDay": [heat_sp] * 24,
        "SummerDesignDay": [heat_sp] * 24,
        "Weekdays": wd["heating"],
        "AllOtherDays": we["heating"],
    })]))
    idf.add(compact_schedule(COOLING_SCHEDULE, "Temperature", [("12/31", {
        "WinterDesignDay": [cool_sp] * 24,
        "SummerDesignDay": [cool_sp] * 24,
        "Weekdays": wd["cooling"],
        "AllOtherDays": we["cooling"],
    })]))


# --------------------------------------------------------------------------------------
# Lighting from WattWise
# --------------------------------------------------------------------------------------
def _safe_name(s: str) -> str:
    return re.sub(r"[^A-Za-z0-9_]+", "_", s).strip("_")


def apply_lighting(idf: IDF, lighting: dict) -> dict:
    """Replace the model's interior Lights and porch/pathway Exterior:Lights with WattWise rooms."""
    removed_interior = idf.remove("Lights")
    summary = {"removed_interior_lights": removed_interior, "rooms": []}

    for room in lighting.get("rooms", []):
        installed = float(room.get("installed_w", 0) or 0)
        name = _safe_name(room["name"])
        if installed <= 0:
            continue
        blocks = []
        for through, season in SEASON_BLOCKS:
            prof = room["profiles"].get(season) or room["profiles"].get("shoulder")
            wd = [min(1.0, max(0.0, w / installed)) for w in prof["weekday"]]
            we = [min(1.0, max(0.0, w / installed)) for w in prof["weekend"]]
            blocks.append((through, {"Weekdays SummerDesignDay WinterDesignDay": wd, "AllOtherDays": we}))
        sched = f"WW_LightSch_{name}"
        idf.add(compact_schedule(sched, "fraction", blocks))
        idf.add(["Lights", f"WW_Lights_{name}", LIVING_ZONE, sched, "LightingLevel", _fmt(installed),
                 "", "", "0", "0.7", "0.1", "0", "WattWise Lighting"])
        summary["rooms"].append({"name": room["name"], "installed_w": installed})

    ext = lighting.get("exterior")
    if ext and float(ext.get("installed_w", 0) or 0) > 0:
        for o in idf.find("Exterior:Lights"):
            if "garage" not in o[1].lower():
                idf.remove("Exterior:Lights", o[1])
        installed = float(ext["installed_w"])
        blocks = []
        for through, season in SEASON_BLOCKS:
            prof = ext["profiles"].get(season) or ext["profiles"].get("shoulder")
            wd = [min(1.0, max(0.0, w / installed)) for w in prof["weekday"]]
            we = [min(1.0, max(0.0, w / installed)) for w in prof["weekend"]]
            blocks.append((through, {"Weekdays SummerDesignDay WinterDesignDay": wd, "AllOtherDays": we}))
        idf.add(compact_schedule("WW_ExtLightSch", "fraction", blocks))
        idf.add(["Exterior:Lights", "WW_Exterior_Lights", "WW_ExtLightSch", _fmt(installed),
                 "ScheduleNameOnly", "Exterior-Lights"])
        summary["exterior_installed_w"] = installed
    return summary


# --------------------------------------------------------------------------------------
# Floor plan scaling
# --------------------------------------------------------------------------------------
def scale_footprint(idf: IDF, target_area_m2: float) -> dict:
    """Scale X/Y of every surface so the conditioned floor area equals target_area_m2."""
    current = conditioned_floor_area(idf)
    if current <= 0 or target_area_m2 <= 0:
        return {"scaled": False, "model_area_m2": current}
    ratio = target_area_m2 / current
    f = math.sqrt(ratio)
    if abs(f - 1.0) < 1e-4:
        return {"scaled": False, "model_area_m2": current, "factor": 1.0}

    for o in idf.find("BuildingSurface:Detailed"):
        pts = _vertices(o)
        for i, p in enumerate(pts):
            o[12 + 3 * i] = _fmt(p[0] * f)
            o[13 + 3 * i] = _fmt(p[1] * f)
    for o in idf.find("Window"):
        o[6] = _fmt(float(o[6]) * f)   # starting X along the wall
        o[8] = _fmt(float(o[8]) * f)   # length (keeps window-to-wall ratio)
    for o in idf.find("Door"):
        o[5] = _fmt(float(o[5]) * f)
    for o in idf.find("ZoneInfiltration:EffectiveLeakageArea"):
        o[4] = _fmt(float(o[4]) * ratio)
    for o in idf.find("GroundHeatTransfer:Slab:EquivalentSlab"):
        o[1] = _fmt(float(o[1]) * f)
    # Mechanical ventilation (ASHRAE 62.2-style) grows with floor area
    for o in idf.find("DesignSpecification:OutdoorAir"):
        if o[5]:
            o[5] = _fmt(float(o[5]) * ratio)
    for o in idf.find("ZoneHVAC:EnergyRecoveryVentilator"):
        o[4] = _fmt(float(o[4]) * ratio)
        o[5] = _fmt(float(o[5]) * ratio)
    for o in idf.find("HeatExchanger:AirToAir:SensibleAndLatent"):
        o[3] = _fmt(float(o[3]) * ratio)
    for o in idf.find("Fan:OnOff"):
        if o[1].lower().startswith(("oasupplyfan", "oaexhaustfan")):
            o[5] = _fmt(float(o[5]) * ratio)   # Maximum Flow Rate {m3/s}
    return {"scaled": True, "model_area_m2": current, "target_area_m2": target_area_m2, "factor": f}


# --------------------------------------------------------------------------------------
# Output requests
# --------------------------------------------------------------------------------------
METERS = ["Electricity:Facility", "Heating:Electricity", "Cooling:Electricity",
          "InteriorLights:Electricity", "ExteriorLights:Electricity", "InteriorEquipment:Electricity",
          "Fans:Electricity", "WaterSystems:Electricity",
          "dishwasher:InteriorEquipment:Electricity", "clotheswasher:InteriorEquipment:Electricity",
          "electric_dryer:InteriorEquipment:Electricity", "electric_range:InteriorEquipment:Electricity"]

# Flexible plug loads. Day schedules are the Building America diversity profiles already in the IDF;
# optimization circular-shifts each profile so its busiest hour lands inside the occupant's window
# at the cheapest time. Washer and dryer share one shift so laundry stays in order.
APPLIANCES = [
    {"id": "dishwasher", "label": "Dishwasher", "object": "dishwasher1_FrontRow_BottomFloor",
     "weekday": "DishwasherWeekday_equip_sch", "weekend": "DishwasherWeekend_equip_sch",
     "linked": ["DishwasherWeekday_flow_sch", "DishwasherWeekend_flow_sch"]},
    {"id": "clotheswasher", "label": "Clothes washer", "object": "clotheswasher1_FrontRow_BottomFloor",
     "weekday": "ClothesWasherWeekday_equip_sch", "weekend": "ClothesWasherWeekend_equip_sch",
     "linked": ["ClothesWasherWeekday_flow_sch", "ClothesWasherWeekend_flow_sch"]},
    {"id": "electric_dryer", "label": "Electric dryer", "object": "electric_dryer1_FrontRow_BottomFloor",
     "weekday": "ClothesDryerWeekday", "weekend": "ClothesDryerWeekend", "linked": [],
     "follow": "clotheswasher"},
    {"id": "electric_range", "label": "Electric range", "object": "electric_range1_FrontRow_BottomFloor",
     "weekday": "CookingRangeDay", "weekend": "CookingRangeDay", "linked": []},
]
ORIENTATION = {"south": 0, "west": 90, "north": 180, "east": 270}
BILL_GROUPS = [
    ("heating", "Heating", ["Heating:Electricity"]),
    ("cooling", "Cooling", ["Cooling:Electricity"]),
    ("lighting", "Lighting", ["InteriorLights:Electricity", "ExteriorLights:Electricity"]),
    ("dishwasher", "Dishwasher", ["dishwasher:InteriorEquipment:Electricity"]),
    ("clothes_washer", "Clothes washer", ["clotheswasher:InteriorEquipment:Electricity"]),
    ("dryer", "Electric dryer", ["electric_dryer:InteriorEquipment:Electricity"]),
    ("range", "Electric range", ["electric_range:InteriorEquipment:Electricity"]),
]


def prepare_outputs(idf: IDF) -> None:
    # The Slab/Basement preprocessors are not wired into this model (no Site:GroundTemperature is
    # produced by ExpandObjects), so drop them and run energyplus.exe directly.
    for o in list(idf.objects):
        if o[0].lower().startswith("groundheattransfer:"):
            idf.objects.remove(o)
    for t in ("Output:Meter", "Output:Meter:MeterFileOnly", "Output:Variable", "Output:Table:Monthly",
              "Output:Constructions", "Output:VariableDictionary", "OutputControl:Table:Style",
              "Output:Table:SummaryReports", "Output:SQLite", "Output:JSON"):
        idf.remove(t)
    for m in METERS:
        idf.add(["Output:Meter", m, "Hourly"])
    idf.add(["Output:Variable", LIVING_ZONE, "Zone Mean Air Temperature", "Hourly"])
    idf.add(["Output:Variable", "Environment", "Site Outdoor Air Drybulb Temperature", "Hourly"])
    idf.add(["Output:Table:SummaryReports", "AnnualBuildingUtilityPerformanceSummary"])
    idf.add(["OutputControl:Table:Style", "Comma", "JtoKWH"])


# --------------------------------------------------------------------------------------
# EnergyPlus execution and parsing
# --------------------------------------------------------------------------------------
class EnergyPlusError(RuntimeError):
    pass


def run_energyplus(idf_text: str, run_dir: Path, epw: Path, timeout: int = 1800) -> dict:
    run_dir.mkdir(parents=True, exist_ok=True)
    idf_path = run_dir / "in.idf"
    out_dir = run_dir / "out"
    idf_path.write_text(idf_text, encoding="utf-8")
    cmd = [str(EP_EXE), "-w", str(epw), "-d", str(out_dir), "-r", str(idf_path)]
    t0 = time.time()
    proc = subprocess.run(cmd, capture_output=True, text=True, timeout=timeout, cwd=str(run_dir))
    elapsed = time.time() - t0
    end_file = out_dir / "eplusout.end"
    end_text = end_file.read_text(errors="ignore") if end_file.exists() else ""
    if proc.returncode != 0 or "Successfully" not in end_text:
        err_file = out_dir / "eplusout.err"
        tail = ""
        if err_file.exists():
            lines = err_file.read_text(errors="ignore").splitlines()
            tail = "\n".join(l for l in lines if "Severe" in l or "Fatal" in l)[-2000:]
        raise EnergyPlusError(f"EnergyPlus failed in {run_dir.name}: {end_text.strip()}\n{tail}\n{proc.stdout[-800:]}")
    data = parse_hourly_csv(out_dir / "eplusout.csv")
    data["elapsed_s"] = round(elapsed, 1)
    data["warnings"] = _warning_count(end_text)
    return data


def _warning_count(end_text: str) -> int:
    m = re.search(r"(\d+)\s+Warning", end_text)
    return int(m.group(1)) if m else 0


def parse_hourly_csv(path: Path) -> dict:
    with path.open(newline="") as fh:
        reader = csv.reader(fh)
        header = next(reader)
        rows = [r for r in reader if r and r[0].strip()]
    rows = rows[-8760:]
    if len(rows) != 8760:
        raise EnergyPlusError(f"Expected 8760 hourly rows, found {len(rows)} in {path}")

    def col(needle: str) -> int | None:
        n = needle.lower()
        fallback = None
        for i, h in enumerate(header):
            name = h.split("[")[0].strip().lower()
            if name == n:
                return i
            if fallback is None and name.endswith(n):
                fallback = i
        return fallback

    series: dict[str, list[float]] = {}
    for m in METERS:
        idx = col(m)
        series[m] = [float(r[idx]) / 3.6e6 for r in rows] if idx is not None else [0.0] * 8760
    zt = col("Zone Mean Air Temperature")
    ot = col("Site Outdoor Air Drybulb Temperature")
    series["zone_temp"] = [float(r[zt]) for r in rows] if zt is not None else [math.nan] * 8760
    series["outdoor_temp"] = [float(r[ot]) for r in rows] if ot is not None else [math.nan] * 8760

    months, hours = [], []
    for r in rows:
        m = re.match(r"\s*(\d{2})/(\d{2})\s+(\d{2}):", r[0])
        months.append(int(m.group(1)))
        hours.append(int(m.group(3)) - 1)   # hour-ending -> hour-beginning (0-23)
    series["month"] = months
    series["hour"] = hours
    return series


# --------------------------------------------------------------------------------------
# Tariff
# --------------------------------------------------------------------------------------
def hourly_prices(tariff: dict, months: list[int], hours: list[int], start_dow: int = 6) -> list[float]:
    """$/kWh for every hour of the year. start_dow: 0=Mon ... 6=Sun (RunPeriod starts on Sunday)."""
    mode = tariff.get("mode", "flat")
    if mode == "flat":
        return [float(tariff.get("flat", 0.20))] * len(hours)
    off_s, on_s, super_s = (float(tariff.get("off_supply", 0.08)), float(tariff.get("on_supply", 0.11)),
                            float(tariff.get("super_supply", 0.18)))
    prices = []
    for i, (mo, h) in enumerate(zip(months, hours)):
        day_index = i // 24
        weekday = (start_dow + day_index) % 7 < 5
        peak = 7 <= h < 23
        superpeak = weekday and mo in (6, 7, 8) and 14 <= h < 18
        delivery = VTOU_DELIVERY_ON if peak else VTOU_DELIVERY_OFF
        supply = super_s if superpeak else on_s if peak else off_s
        prices.append(delivery + supply)
    return prices


def price_run(series: dict, tariff: dict) -> dict:
    prices = hourly_prices(tariff, series["month"], series["hour"])
    total_kwh = series["Electricity:Facility"]
    energy_cost = sum(k * p for k, p in zip(total_kwh, prices))
    fixed = 12 * float(tariff.get("fixed_monthly", 0.0) or 0.0)
    monthly = {"kwh": [0.0] * 12, "cost": [0.0] * 12, "heating": [0.0] * 12, "cooling": [0.0] * 12,
               "lighting": [0.0] * 12, "other": [0.0] * 12}
    for i, mo in enumerate(series["month"]):
        j = mo - 1
        monthly["kwh"][j] += total_kwh[i]
        monthly["cost"][j] += total_kwh[i] * prices[i]
        monthly["heating"][j] += series["Heating:Electricity"][i]
        monthly["cooling"][j] += series["Cooling:Electricity"][i]
        monthly["lighting"][j] += series["InteriorLights:Electricity"][i] + series["ExteriorLights:Electricity"][i]
    for j in range(12):
        monthly["other"][j] = monthly["kwh"][j] - monthly["heating"][j] - monthly["cooling"][j] - monthly["lighting"][j]
        monthly["cost"][j] += fixed / 12
    annual = {m: sum(series[m]) for m in METERS}
    breakdown = []
    grouped_kwh = grouped_cost = 0.0
    for key, label, meters in BILL_GROUPS:
        kwh = sum(annual[m] for m in meters)
        cost = sum(series[m][i] * prices[i] for m in meters for i in range(len(prices)))
        grouped_kwh += kwh
        grouped_cost += cost
        breakdown.append({"key": key, "label": label, "kwh": round(kwh, 1), "cost": round(cost, 2)})
    breakdown.append({"key": "other", "label": "Other (fans, water heating, fridge, plugs)",
                      "kwh": round(annual["Electricity:Facility"] - grouped_kwh, 1),
                      "cost": round(energy_cost - grouped_cost, 2)})
    return {
        "annual_kwh": {
            "total": annual["Electricity:Facility"],
            "heating": annual["Heating:Electricity"],
            "cooling": annual["Cooling:Electricity"],
            "fans": annual["Fans:Electricity"],
            "interior_lighting": annual["InteriorLights:Electricity"],
            "exterior_lighting": annual["ExteriorLights:Electricity"],
            "equipment": annual["InteriorEquipment:Electricity"],
            "water_heating": annual["WaterSystems:Electricity"],
        },
        "bill": {"energy": energy_cost, "fixed": fixed, "total": energy_cost + fixed,
                 "avg_price": energy_cost / annual["Electricity:Facility"] if annual["Electricity:Facility"] else 0},
        "breakdown": breakdown,
        "monthly": {k: [round(v, 2) for v in vals] for k, vals in monthly.items()},
    }


def comfort_metrics(series: dict, comfort: dict, occ: dict, start_dow: int = 6) -> dict:
    """Share of at-home awake hours whose zone air temperature sits inside the comfort range."""
    t_min, t_max = float(comfort["t_min"]), float(comfort["t_max"])
    inside = occupied = 0
    for i, t in enumerate(series["zone_temp"]):
        day_index = i // 24
        weekend = (start_dow + day_index) % 7 >= 5
        if occupancy_state(series["hour"][i] + 0.5, occ, weekend) != "awake":
            continue
        occupied += 1
        if t_min - 0.5 <= t <= t_max + 0.5:
            inside += 1
    return {"occupied_hours": occupied, "inside_hours": inside,
            "inside_share": inside / occupied if occupied else 1.0}


def daily_means(values: list[float]) -> list[float]:
    return [round(sum(values[d * 24:(d + 1) * 24]) / 24, 2) for d in range(365)]


# --------------------------------------------------------------------------------------
# Location, and flexible appliances under the same tariff
# --------------------------------------------------------------------------------------
def apply_orientation(idf: IDF, facing: str) -> int:
    """Rotate the prototype so the front wall (the model's south wall) faces the given compass point."""
    deg = ORIENTATION.get((facing or "south").lower(), 0)
    building = idf.find("Building")
    if building:
        building[0][2] = str(deg)
    return deg


def _day_values(idf: IDF, name: str) -> list[float]:
    found = idf.find("Schedule:Day:Hourly", name)
    if not found:
        raise ValueError(f"Schedule:Day:Hourly '{name}' is missing from the EnergyPlus model")
    return [float(v) for v in found[0][3:27]]


def _write_day(idf: IDF, name: str, values: list[float]) -> None:
    obj = idf.find("Schedule:Day:Hourly", name)[0]
    for i, v in enumerate(values):
        obj[3 + i] = _fmt(float(v))


def _rotate(values: list[float], shift: int) -> list[float]:
    shift %= 24
    return [values[(h - shift) % 24] for h in range(24)]


def _in_window(hour: int, start: int, end: int) -> bool:
    start, end = int(start) % 24, int(end) % 24
    if start == end:
        return True
    if start < end:
        return start <= hour < end
    return hour >= start or hour < end


def _year_clock(start_dow: int = 6) -> tuple[list[int], list[int], list[bool]]:
    months, hours, weekend = [], [], []
    day = 0
    for month, n_days in enumerate(DAYS_IN_MONTH, 1):
        for _ in range(n_days):
            is_weekend = (start_dow + day) % 7 >= 5
            for h in range(24):
                months.append(month)
                hours.append(h)
                weekend.append(is_weekend)
            day += 1
    return months, hours, weekend


def plan_appliances(idf: IDF, tariff: dict, settings: dict | None) -> list[dict]:
    """Choose one daily shift per appliance. Same tariff hours as the whole-house bill."""
    settings = settings or {}
    months, hours, weekend = _year_clock()
    prices = hourly_prices(tariff, months, hours)
    wd_price = [0.0] * 24
    we_price = [0.0] * 24
    for i, h in enumerate(hours):
        (we_price if weekend[i] else wd_price)[h] += prices[i]

    def annual_cost(wd: list[float], we: list[float], watts: float, shift: int) -> float:
        energy = 0.0
        for h in range(24):
            energy += wd[(h - shift) % 24] * wd_price[h] + we[(h - shift) % 24] * we_price[h]
        return watts / 1000.0 * energy

    plans = []
    washer_shift = 0
    washer_window = (0, 24)
    for spec in APPLIANCES:
        cfg = settings.get(spec["id"], {})
        enabled = bool(cfg.get("enabled", True))
        wd = _day_values(idf, spec["weekday"])
        we = wd if spec["weekend"] == spec["weekday"] else _day_values(idf, spec["weekend"])
        equip = idf.find("ElectricEquipment", spec["object"])
        watts = float(equip[0][5]) if equip and equip[0][5] else 0.0
        peak = max(range(24), key=lambda h: wd[h])
        if spec.get("follow") and cfg.get("follow_washer", True):
            shift = washer_shift if enabled else 0
        elif not enabled:
            shift = 0
        else:
            start, end = int(cfg.get("from", 0)), int(cfg.get("to", 24))
            allowed = [s for s in range(24) if _in_window((peak + s) % 24, start, end)] or [0]
            shift = min(allowed, key=lambda s: annual_cost(wd, we, watts, s))
        if spec["id"] == "clotheswasher":
            washer_shift = shift
            washer_window = (int(cfg.get("from", 0)), int(cfg.get("to", 24)))
        if spec.get("follow") and cfg.get("follow_washer", True):
            window_from, window_to = washer_window
        else:
            window_from, window_to = int(cfg.get("from", 0)), int(cfg.get("to", 24))
        names = [spec["weekday"], spec["weekend"], *spec["linked"]]
        plans.append({
            "id": spec["id"], "label": spec["label"], "enabled": enabled, "shift_hours": shift,
            "watts": round(watts, 1),
            "annual_kwh": round(watts * (sum(wd) * 261 + sum(we) * 104) / 1000.0, 1),
            "peak_before": peak, "peak_after": (peak + shift) % 24,
            "window_from": window_from, "window_to": window_to,
            "baseline_cost": round(annual_cost(wd, we, watts, 0), 2),
            "optimized_cost": round(annual_cost(wd, we, watts, shift), 2),
            "weekday_before": [round(v, 4) for v in wd],
            "weekday_after": [round(v, 4) for v in _rotate(wd, shift)],
            "schedules": names,
            "_profiles": {n: (_day_values(idf, n) if n != spec["weekday"] else wd) for n in dict.fromkeys(names)},
        })
    return plans


def apply_appliance_plan(idf: IDF, plans: list[dict]) -> None:
    written: set[str] = set()
    for plan in plans:
        for name, values in plan["_profiles"].items():
            if name in written:
                continue
            written.add(name)
            _write_day(idf, name, _rotate(values, plan["shift_hours"]))


def public_appliance_plan(plans: list[dict]) -> list[dict]:
    return [{k: v for k, v in p.items() if not k.startswith("_")} for p in plans]


# --------------------------------------------------------------------------------------
# Optimization driver
# --------------------------------------------------------------------------------------
def _frange(start: float, stop: float, step: float) -> list[float]:
    out, v = [], start
    while v <= stop + 1e-9:
        out.append(round(v, 2))
        v += step
    return out


def candidate_plan(comfort: dict) -> dict:
    t_min, t_max = float(comfort["t_min"]), float(comfort["t_max"])
    step = float(comfort.get("step", 1.0))
    deadband = max(step, 1.0)
    heat = _frange(t_min, t_max - deadband, step)
    cool = _frange(t_min + deadband, t_max, step)
    strategy = comfort.get("strategy", "fast")
    pairs: list[tuple[float, float]] = []
    if strategy == "full":
        pairs = [(h, c) for h in heat for c in cool if c - h >= deadband - 1e-9]
    else:
        pairs = [(h, t_max) for h in heat] + [(t_min, c) for c in cool]
        pairs = list(dict.fromkeys(pairs))
    return {"heat": heat, "cool": cool, "pairs": pairs, "deadband": deadband, "strategy": strategy,
            "estimated_runs": len(pairs) + 1 + (1 if strategy != "full" else 0),
            "workers": MAX_WORKERS, "seconds_per_run": 15}


def _tag(h: float, c: float) -> str:
    return f"h{h:g}_c{c:g}".replace(".", "p")


class Optimizer:
    def __init__(self, request: dict, job_dir: Path, progress):
        self.req = request
        self.job_dir = job_dir
        self.progress = progress  # callable(message, done, total)
        self.idf_path, self.epw_path = find_model_files()
        self.base_text = self.idf_path.read_text(encoding="utf-8", errors="ignore")

    # ---- model preparation -----------------------------------------------------------
    def _location_summary(self, info: dict) -> dict:
        loc = self.req.get("location") or {}
        place = (loc.get("place") or "Buffalo, NY").strip()
        local = any(k in place.lower() for k in ("buffalo", "niagara", "williamsville", "amherst", "tonawanda"))
        return {"place": place, "facing": info.get("facing", "south"), "north_axis": info.get("north_axis", 0),
                "weather": self.epw_path.name,
                "weather_matches_location": local,
                "note": ("" if local else
                         "The only weather file in this package is Buffalo Niagara International TMY3, so the "
                         "simulation uses Buffalo weather even though the address is elsewhere.")}

    def _base_idf(self) -> tuple[IDF, dict]:
        idf = IDF(self.base_text)
        facing = (self.req.get("location") or {}).get("facing", "south")
        info = {"model_area_m2": conditioned_floor_area(idf), "facing": facing,
                "north_axis": apply_orientation(idf, facing)}
        fp = self.req.get("floor_plan", {})
        if fp.get("scale_model") and fp.get("total_area_m2"):
            info["scaling"] = scale_footprint(idf, float(fp["total_area_m2"]))
        prepare_outputs(idf)
        return idf, info

    def _candidate_idf(self, heat_sp: float, cool_sp: float) -> tuple[str, dict]:
        idf, _ = self._base_idf()
        apply_lighting(idf, self.req.get("lighting", {}))
        apply_appliance_plan(idf, self.appliance_plans)
        profiles = thermostat_profiles(heat_sp, cool_sp, self.req["comfort"], self.req["occupant"])
        apply_thermostat(idf, profiles, heat_sp, cool_sp)
        return idf.to_text(), profiles

    # ---- execution -------------------------------------------------------------------
    def _run_many(self, jobs: dict[str, str], done_offset: int, total: int) -> dict[str, dict]:
        results: dict[str, dict] = {}
        done = done_offset
        with ThreadPoolExecutor(max_workers=MAX_WORKERS) as pool:
            futures = {pool.submit(run_energyplus, text, self.job_dir / tag, self.epw_path): tag
                       for tag, text in jobs.items()}
            for fut in as_completed(futures):
                tag = futures[fut]
                results[tag] = fut.result()
                done += 1
                self.progress(f"Finished {tag.replace('_', ' ')} ({results[tag]['elapsed_s']} s)", done, total)
        return results

    def run(self) -> dict:
        req = self.req
        comfort, occ, tariff = req["comfort"], req["occupant"], req["tariff"]
        plan = candidate_plan(comfort)
        if not plan["pairs"]:
            raise ValueError("Comfort range is too narrow for the chosen step. Widen it or use a finer step.")
        if len(plan["pairs"]) + 2 > MAX_RUNS:
            raise ValueError(f"{len(plan['pairs'])} candidate schedules exceed the limit of {MAX_RUNS - 2}. "
                             "Use a coarser step, a narrower range, or the fast strategy.")

        self.appliance_plans = plan_appliances(IDF(self.base_text), tariff, req.get("appliances"))
        moved = [p for p in self.appliance_plans if p["shift_hours"]]
        self.progress("Shifted " + (", ".join(f"{p['label'].lower()} by {p['shift_hours']} h" for p in moved) or "no appliances")
                      + " into the cheapest hours of your tariff", 0, plan["estimated_runs"])
        base_idf, info = self._base_idf()
        total = plan["estimated_runs"]
        self.progress("Preparing EnergyPlus input files", 0, total)

        jobs = {"baseline": base_idf.to_text()}
        profiles_by_tag = {}
        for h, c in plan["pairs"]:
            text, prof = self._candidate_idf(h, c)
            jobs[_tag(h, c)] = text
            profiles_by_tag[_tag(h, c)] = prof
        self.progress(f"Running {len(jobs)} EnergyPlus simulations on {MAX_WORKERS} workers", 0, total)
        results = self._run_many(jobs, 0, total)

        priced = {tag: price_run(series, tariff) for tag, series in results.items()}
        candidates = []
        for h, c in plan["pairs"]:
            tag = _tag(h, c)
            candidates.append({"tag": tag, "heat_sp": h, "cool_sp": c,
                               "bill": priced[tag]["bill"]["total"],
                               "heating_kwh": priced[tag]["annual_kwh"]["heating"],
                               "cooling_kwh": priced[tag]["annual_kwh"]["cooling"],
                               "total_kwh": priced[tag]["annual_kwh"]["total"]})

        # ---- pick the optimum -------------------------------------------------------
        if plan["strategy"] == "full":
            best = min(candidates, key=lambda x: x["bill"])
        else:
            t_min, t_max = float(comfort["t_min"]), float(comfort["t_max"])
            heat_runs = [x for x in candidates if abs(x["cool_sp"] - t_max) < 1e-9]
            cool_runs = [x for x in candidates if abs(x["heat_sp"] - t_min) < 1e-9]
            best_h = min(heat_runs, key=lambda x: x["bill"])["heat_sp"]
            best_c = min(cool_runs, key=lambda x: x["bill"])["cool_sp"]
            tag = _tag(best_h, best_c)
            if tag not in results:
                self.progress(f"Confirmation run for heating {best_h:g} °C / cooling {best_c:g} °C",
                              len(results), total)
                text, prof = self._candidate_idf(best_h, best_c)
                profiles_by_tag[tag] = prof
                results.update(self._run_many({tag: text}, len(results), total))
                priced[tag] = price_run(results[tag], tariff)
                candidates.append({"tag": tag, "heat_sp": best_h, "cool_sp": best_c,
                                   "bill": priced[tag]["bill"]["total"],
                                   "heating_kwh": priced[tag]["annual_kwh"]["heating"],
                                   "cooling_kwh": priced[tag]["annual_kwh"]["cooling"],
                                   "total_kwh": priced[tag]["annual_kwh"]["total"],
                                   "confirmation": True})
            best = min(candidates, key=lambda x: x["bill"])

        best_tag = best["tag"]
        best_series, base_series = results[best_tag], results["baseline"]
        best_priced, base_priced = priced[best_tag], priced["baseline"]
        savings = base_priced["bill"]["total"] - best_priced["bill"]["total"]

        self.progress("Assembling results", total, total)
        return {
            "model": {
                "idf": self.idf_path.name,
                "weather": self.epw_path.name,
                "conditioned_area_m2": round(info.get("scaling", {}).get("target_area_m2", info["model_area_m2"]), 1),
                "original_area_m2": round(info["model_area_m2"], 1),
                "scaling": info.get("scaling", {"scaled": False}),
                "runs": len(results),
                "workers": MAX_WORKERS,
                "energyplus": str(EP_EXE),
                "facing": info.get("facing", "south"),
                "north_axis": info.get("north_axis", 0),
            },
            "location": self._location_summary(info),
            "appliances": public_appliance_plan(self.appliance_plans),
            "plan": {k: v for k, v in plan.items() if k != "pairs"},
            "candidates": sorted(candidates, key=lambda x: (x["heat_sp"], x["cool_sp"])),
            "best": {
                **best,
                "profiles": profiles_by_tag[best_tag],
                "resolution": comfort["resolution"],
                "setback": float(comfort.get("setback", 0)) if comfort["resolution"] == "hourly" else 0.0,
                **best_priced,
                "comfort": comfort_metrics(best_series, comfort, occ),
                "daily_zone_temp": daily_means(best_series["zone_temp"]),
                "hourly_zone_temp": [round(v, 2) for v in best_series["zone_temp"]],
                "hourly_total_kwh": [round(v, 3) for v in best_series["Electricity:Facility"]],
            },
            "baseline": {
                **base_priced,
                "comfort": comfort_metrics(base_series, comfort, occ),
                "daily_zone_temp": daily_means(base_series["zone_temp"]),
                "hourly_zone_temp": [round(v, 2) for v in base_series["zone_temp"]],
                "hourly_total_kwh": [round(v, 3) for v in base_series["Electricity:Facility"]],
                "description": ("Same house and orientation, operated as delivered: heating setpoint "
                                "24.5–25.5 °C (Oct–Apr), cooling setpoint 20.5–21.5 °C (May–Sep), interior "
                                "lights at a constant 40% of installed power, and dishwasher, washer, dryer "
                                "and range on their original schedules."),
            },
            "savings": {"annual_usd": savings,
                        "share": savings / base_priced["bill"]["total"] if base_priced["bill"]["total"] else 0,
                        "heating_kwh": base_priced["annual_kwh"]["heating"] - best_priced["annual_kwh"]["heating"],
                        "cooling_kwh": base_priced["annual_kwh"]["cooling"] - best_priced["annual_kwh"]["cooling"],
                        "lighting_kwh": (base_priced["annual_kwh"]["interior_lighting"] + base_priced["annual_kwh"]["exterior_lighting"])
                                        - (best_priced["annual_kwh"]["interior_lighting"] + best_priced["annual_kwh"]["exterior_lighting"])},
            "outdoor_daily_temp": daily_means(base_series["outdoor_temp"]),
            "hourly_outdoor_temp": [round(v, 2) for v in base_series["outdoor_temp"]],
            "month_names": MONTH_NAMES,
        }


# --------------------------------------------------------------------------------------
# Job registry used by the HTTP server
# --------------------------------------------------------------------------------------
class JobStore:
    def __init__(self):
        self.jobs: dict[str, dict] = {}
        self.lock = threading.Lock()

    def create(self, request: dict) -> str:
        job_id = time.strftime("%Y%m%d-%H%M%S") + f"-{int(time.time() * 1000) % 1000:03d}"
        job = {"id": job_id, "status": "queued", "progress": {"done": 0, "total": 0, "message": "Queued"},
               "log": [], "result": None, "error": None, "started": time.time()}
        with self.lock:
            self.jobs[job_id] = job
        threading.Thread(target=self._run, args=(job_id, request), daemon=True).start()
        return job_id

    def get(self, job_id: str) -> dict | None:
        with self.lock:
            return self.jobs.get(job_id)

    def latest_result(self) -> dict | None:
        with self.lock:
            done = [j for j in self.jobs.values() if j.get("status") == "done" and j.get("result")]
            return done[-1]["result"] if done else None

    def _run(self, job_id: str, request: dict) -> None:
        job = self.get(job_id)
        job_dir = RUNS_DIR / job_id

        def progress(message: str, done: int, total: int):
            with self.lock:
                job["progress"] = {"done": done, "total": total, "message": message}
                job["log"].append(f"[{time.strftime('%H:%M:%S')}] {message}")

        try:
            job["status"] = "running"
            if not EP_EXE.exists():
                raise FileNotFoundError(f"EnergyPlus executable not found at {EP_EXE}. "
                                        "Set ENERGYPLUS_DIR or install EnergyPlus 26.1.")
            result = Optimizer(request, job_dir, progress).run()
            result["job_id"] = job_id
            result["elapsed_s"] = round(time.time() - job["started"], 1)
            with self.lock:
                job["result"] = result
                job["status"] = "done"
        except Exception as exc:  # surface everything to the UI
            with self.lock:
                job["status"] = "error"
                job["error"] = str(exc)
                job["log"].append(f"[{time.strftime('%H:%M:%S')}] ERROR: {exc}")
        finally:
            _prune_runs(keep=4)


def _prune_runs(keep: int) -> None:
    """Keep the most recent job folders only (EnergyPlus output is large)."""
    if not RUNS_DIR.exists():
        return
    dirs = sorted([d for d in RUNS_DIR.iterdir() if d.is_dir()], key=lambda d: d.stat().st_mtime, reverse=True)
    for d in dirs[keep:]:
        shutil.rmtree(d, ignore_errors=True)


def model_info() -> dict:
    idf_path, epw_path = find_model_files()
    idf = IDF(idf_path.read_text(encoding="utf-8", errors="ignore"))
    lights = [{"name": o[1], "watts": float(o[5]) if o[5] else 0.0} for o in idf.find("Lights")]
    return {
        "energyplus_dir": str(EP_DIR),
        "energyplus_found": EP_EXE.exists(),
        "idf": idf_path.name,
        "weather": epw_path.name,
        "conditioned_area_m2": round(conditioned_floor_area(idf), 1),
        "zone": LIVING_ZONE,
        "interior_lights": lights,
        "installed_interior_w": round(sum(l["watts"] for l in lights), 1),
        "workers": MAX_WORKERS,
        "heating_system": "Electric resistance furnace (Coil:Heating:Electric) with DX cooling and ERV",
        "baseline_thermostat": "Heating 24.5–25.5 °C (Oct–Apr), cooling 20.5–21.5 °C (May–Sep)",
        "baseline_lighting": "Interior lights at a constant 40 % of installed power",
    }
