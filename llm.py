"""Local energy advisor backed by Qwen2.5-1.5B-Instruct (Apache-2.0).

The GGUF weights are downloaded once into ./models and run on this computer with
llama-cpp. No prompts or results leave the machine.
"""
from __future__ import annotations

import re
import threading
import urllib.request
from pathlib import Path

ROOT = Path(__file__).resolve().parent
MODEL_DIR = ROOT / "models"
MODEL_PATH = MODEL_DIR / "qwen2.5-1.5b-instruct-q4_k_m.gguf"
MODEL_URL = ("https://huggingface.co/Qwen/Qwen2.5-1.5B-Instruct-GGUF/resolve/main/"
             "qwen2.5-1.5b-instruct-q4_k_m.gguf")
MIN_BYTES = 800_000_000

_lock = threading.Lock()
_status = {"state": "missing", "progress": 0.0, "bytes": 0, "total": 0, "error": None,
           "model": "Qwen2.5-1.5B-Instruct", "file": MODEL_PATH.name, "license": "Apache-2.0"}
_llm = None
_llm_lock = threading.Lock()


def _ready_file() -> bool:
    return MODEL_PATH.exists() and MODEL_PATH.stat().st_size >= MIN_BYTES


def status() -> dict:
    with _lock:
        if _ready_file() and _status["state"] not in ("downloading", "loading"):
            size = MODEL_PATH.stat().st_size
            _status["state"] = "ready"
            _status["bytes"] = size
            _status["total"] = size or _status["total"]
            _status["progress"] = 1.0
        return dict(_status)


def start_download() -> dict:
    with _lock:
        if _ready_file():
            size = MODEL_PATH.stat().st_size
            _status.update(state="ready", progress=1.0, bytes=size, total=size, error=None)
            return dict(_status)
        if _status["state"] == "downloading":
            return dict(_status)
        _status.update(state="downloading", progress=0.0, bytes=0, total=0, error=None)
    threading.Thread(target=_download, daemon=True).start()
    return status()


def _download() -> None:
    MODEL_DIR.mkdir(exist_ok=True)
    partial = MODEL_PATH.with_suffix(".gguf.part")
    try:
        req = urllib.request.Request(MODEL_URL, headers={"User-Agent": "personal-energy-optimizer"})
        with urllib.request.urlopen(req, timeout=60) as response, partial.open("wb") as out:
            total = int(response.headers.get("Content-Length") or 0)
            done = 0
            while True:
                chunk = response.read(1024 * 256)
                if not chunk:
                    break
                out.write(chunk)
                done += len(chunk)
                with _lock:
                    _status["bytes"] = done
                    _status["total"] = total
                    _status["progress"] = (done / total) if total else 0
        partial.replace(MODEL_PATH)
        with _lock:
            _status.update(state="ready", progress=1.0, bytes=MODEL_PATH.stat().st_size, error=None)
    except Exception as exc:
        partial.unlink(missing_ok=True)
        with _lock:
            _status.update(state="error", error=str(exc))


def _engine():
    global _llm
    with _llm_lock:
        if _llm is None:
            with _lock:
                _status["state"] = "loading"
            from llama_cpp import Llama
            _llm = Llama(model_path=str(MODEL_PATH), n_ctx=4096, n_threads=8, n_gpu_layers=0, verbose=False)
            with _lock:
                _status["state"] = "ready"
        return _llm


def summarize(result: dict) -> str:
    """Compact, number-faithful brief the advisor is allowed to rely on."""
    loc = result.get("location") or {}
    best, base = result["best"], result["baseline"]
    lines = [
        f"Home: {loc.get('place', 'Buffalo, NY')}. Front faces {loc.get('facing', 'south')}. "
        f"Weather file: {loc.get('weather', 'Buffalo TMY3')}. {loc.get('note', '')}",
        f"Conditioned floor area: {result['model'].get('conditioned_area_m2')} m2.",
        f"One annual electricity bill, priced hour by hour (heating, cooling, lighting, appliances and everything else together).",
        f"Optimized bill: ${best['bill']['total']:.0f} ({best['annual_kwh']['total']:.0f} kWh). "
        f"Baseline bill, same house run as delivered: ${base['bill']['total']:.0f} ({base['annual_kwh']['total']:.0f} kWh). "
        f"Savings: ${result['savings']['annual_usd']:.0f} ({result['savings']['share'] * 100:.1f}%).",
        f"Heating energy: {best['annual_kwh']['heating']:.0f} kWh (baseline {base['annual_kwh']['heating']:.0f}). "
        f"Cooling energy: {best['annual_kwh']['cooling']:.0f} kWh (baseline {base['annual_kwh']['cooling']:.0f}).",
        "Bill by end use, optimized vs baseline, same tariff:",
    ]
    base_rows = {row["key"]: row for row in base.get("breakdown", [])}
    for row in best.get("breakdown", []):
        was = base_rows.get(row["key"], {})
        lines.append(f"- {row['label']}: ${row['cost']:.0f} / {row['kwh']:.0f} kWh "
                     f"(baseline ${was.get('cost', 0):.0f} / {was.get('kwh', 0):.0f} kWh)")
    prof = best["profiles"]["weekday"]
    awake = [(h, prof["heating"][h], prof["cooling"][h]) for h in range(24) if prof["state"][h] == "awake"]
    lines.append(f"Thermostat while home and awake: heat {best['heat_sp']} C, cool {best['cool_sp']} C. "
                 f"Resolution: {best.get('resolution')}. Setback: {best.get('setback')} C "
                 f"while asleep or away. Weekday awake hours sample: "
                 + ", ".join(f"{h:02d}:00 heat {ht} / cool {cl}" for h, ht, cl in awake[:4]) + ".")
    lines.append(f"Share of awake-at-home hours inside the comfort range: {best['comfort']['inside_share'] * 100:.0f}%.")
    for app in result.get("appliances", []):
        lines.append(f"Appliance {app['label']}: {'shifted later by ' + str(app['shift_hours']) + ' h' if app['shift_hours'] else 'kept on the original schedule'}. "
                     f"Busiest hour {app['peak_before']:02d}:00 -> {app['peak_after']:02d}:00. "
                     f"Allowed window {app['window_from']:02d}:00-{app['window_to']:02d}:00. "
                     f"Tariff-only cost ${app['baseline_cost']:.0f} -> ${app['optimized_cost']:.0f}.")
    lines.append("Lighting follows the WattWise occupant schedule and is inside the lighting line of the bill above, "
                 "not a separate account. The baseline is the EnergyPlus model as delivered.")
    return "\n".join(lines)


def _add(bucket: set[float], value, places: int = 1) -> None:
    try:
        number = float(value)
    except (TypeError, ValueError):
        return
    bucket.add(number)
    bucket.add(round(number))
    bucket.add(round(number, places))


def _fact_sheet(result: dict) -> dict[str, set[float]]:
    """Figures the advisor may quote, kept apart so 15 hours cannot pass as 15 C."""
    money, kwh, percent, temp = {0.0}, {0.0}, set(), set()

    def take_run(run: dict) -> None:
        bill = run.get("bill") or {}
        _add(money, bill.get("total"), 2)
        _add(money, bill.get("energy"), 2)
        _add(money, bill.get("fixed"), 2)
        for key, value in (run.get("annual_kwh") or {}).items():
            if isinstance(value, (int, float)):
                _add(kwh, value)
        for row in run.get("breakdown") or []:
            _add(money, row.get("cost"), 2)
            _add(kwh, row.get("kwh"))

    best = result.get("best") or {}
    base = result.get("baseline") or {}
    take_run(best)
    take_run(base)
    savings = result.get("savings") or {}
    _add(money, savings.get("annual_usd"), 2)
    if savings.get("share") is not None:
        _add(percent, float(savings["share"]) * 100, 1)
    comfort = (best.get("comfort") or {}).get("inside_share")
    if comfort is not None:
        _add(percent, float(comfort) * 100, 1)
    heat = float(best.get("heat_sp") or 0)
    cool = float(best.get("cool_sp") or 0)
    setback = float(best.get("setback") or 0)
    for celsius in (heat, cool, setback, heat - setback, cool + setback):
        _add(temp, celsius, 1)
        _add(temp, celsius * 9 / 5 + 32, 1)
    for day in (best.get("profiles") or {}).values():
        for key in ("heating", "cooling"):
            for value in day.get(key) or []:
                _add(temp, value, 1)
                _add(temp, float(value) * 9 / 5 + 32, 1)
    for app in result.get("appliances") or []:
        _add(money, app.get("baseline_cost"), 2)
        _add(money, app.get("optimized_cost"), 2)
        _add(kwh, app.get("annual_kwh"))
    return {"money": money, "kwh": kwh, "percent": percent, "temp": temp}


def _close(value: float, allowed: set[float], tolerance: float) -> bool:
    return any(abs(value - item) <= tolerance for item in allowed)


_MONEY = re.compile(r"\$\s*(\d{1,3}(?:,\d{3})+|\d+)(?:\.(\d{1,2}))?")
_KWH = re.compile(r"(\d{1,3}(?:,\d{3})+|\d+)(?:\.(\d+))?\s*kWh", re.I)
_PERCENT = re.compile(r"(\d+(?:\.\d+)?)\s*(?:%|percent)", re.I)
_TEMP = re.compile(r"(\d+(?:\.\d+)?)\s*°?\s*([CFcf])\b")
_CLOCK = re.compile(r"\b(\d{1,2})(?::(\d{2}))?\s*(a\.?m\.?|p\.?m\.?)?\b", re.I)
_APPLIANCE_WORDS = (
    ("dishwasher", ("dishwasher",)),
    ("washer", ("clothes washer", "washer")),
    ("dryer", ("dryer",)),
    ("range", ("range", "oven", "stove")),
)


def _clock_hour(match: re.Match) -> int | None:
    hour = int(match.group(1))
    minute = match.group(2)
    meridiem = (match.group(3) or "").lower().replace(".", "")
    if minute is not None and int(minute) != 0:
        return None
    if meridiem:
        if not 1 <= hour <= 12:
            return None
        hour = hour % 12
        if meridiem == "pm":
            hour += 12
        return hour
    if match.group(2) is not None and 0 <= hour <= 23:
        return hour
    return None


def unsupported_claims(text: str, result: dict) -> list[str]:
    """Dollar, kWh, percent and temperature claims that are not in the simulation brief."""
    sheet = _fact_sheet(result)
    bad = []
    for match in _MONEY.finditer(text):
        value = float(match.group(1).replace(",", "") + ("." + match.group(2) if match.group(2) else ""))
        if not _close(value, sheet["money"], 1):
            bad.append(match.group(0).strip())
    for match in _KWH.finditer(text):
        value = float(match.group(1).replace(",", "") + ("." + match.group(2) if match.group(2) else ""))
        if not _close(value, sheet["kwh"], 1):
            bad.append(match.group(0).strip())
    for match in _PERCENT.finditer(text):
        if not _close(float(match.group(1)), sheet["percent"], 0.2):
            bad.append(match.group(0).strip())
    for match in _TEMP.finditer(text):
        if not _close(float(match.group(1)), sheet["temp"], 0.6):
            bad.append(match.group(0).strip())
    for app in result.get("appliances") or []:
        label = app["label"].lower()
        words = next((words for name, words in _APPLIANCE_WORDS if name in label), ())
        if not words:
            continue
        recommended = int(app["peak_after"])
        for sentence in re.split(r"(?<=[.!?])\s+", text):
            low = sentence.lower()
            if not any(re.search(rf"\b{re.escape(word)}\b", low) for word in words):
                continue
            if not re.search(r"\b(run|start|schedule|busiest|peak|set)\b", low):
                continue
            if re.search(r"\bfrom\b.+\bto\b", low):
                continue
            for clock in _CLOCK.finditer(sentence):
                hour = _clock_hour(clock)
                if hour is None or hour == recommended:
                    continue
                window = {int(app["window_from"]), int(app["window_to"]) % 24}
                if hour in window:
                    continue
                bad.append(f"{clock.group(0).strip()} for the {app['label'].lower()}")
    return bad


def _clock_label(hour: int) -> str:
    hour = int(hour) % 24
    suffix = "AM" if hour < 12 else "PM"
    shown = hour % 12 or 12
    return f"{shown}:00 {suffix}"


def _asks(question: str, words: tuple[str, ...]) -> bool:
    return any(re.search(rf"\b{re.escape(word)}\b", question) for word in words)


def grounded_reply(question: str, result: dict) -> str:
    """Plain answer built only from brief figures, used when the model invents numbers."""
    best, base = result["best"], result["baseline"]
    q = question.lower()
    parts = []

    def line(key: str) -> str:
        rows = {row["key"]: row for row in best.get("breakdown", [])}
        base_rows = {row["key"]: row for row in base.get("breakdown", [])}
        row, was = rows.get(key, {}), base_rows.get(key, {})
        return (f"{row.get('label', key)} is ${row.get('cost', 0):.0f} and {row.get('kwh', 0):.0f} kWh "
                f"after optimization (baseline ${was.get('cost', 0):.0f} and {was.get('kwh', 0):.0f} kWh).")

    if _asks(q, ("light", "lighting", "lamp", "lamps")):
        parts.append(line("lighting") + " That lighting is already inside the one annual bill, not a separate account.")
    if _asks(q, ("heating",)):
        parts.append(line("heating"))
    if _asks(q, ("cooling",)):
        parts.append(line("cooling"))
    if _asks(q, ("thermostat", "setpoint", "setpoints", "setback", "temperature")):
        setback = float(best.get("setback") or 0)
        if best.get("resolution") == "hourly" and setback:
            parts.append(
                f"While you are home and awake, heat to {best['heat_sp']:.0f} C and cool to {best['cool_sp']:.0f} C. "
                f"While asleep or away, heating drops by {setback:.0f} C, to {best['heat_sp'] - setback:.0f} C, "
                f"and cooling rises to {best['cool_sp'] + setback:.0f} C."
            )
        else:
            parts.append(f"Hold heating at {best['heat_sp']:.0f} C and cooling at {best['cool_sp']:.0f} C all day.")
    if _asks(q, ("dish", "dishwasher", "washer", "dryer", "laundry", "range", "oven", "appliance", "appliances", "cook", "cooking")):
        bits = []
        for app in result.get("appliances") or []:
            if not app.get("shift_hours"):
                bits.append(f"Leave the {app['label'].lower()} on its original schedule, busiest at {_clock_label(app['peak_after'])}.")
            else:
                bits.append(
                    f"Run the {app['label'].lower()} so its busiest hour is {_clock_label(app['peak_after'])} "
                    f"(it was {_clock_label(app['peak_before'])}). "
                    f"That line of the bill is ${app['optimized_cost']:.0f}, down from ${app['baseline_cost']:.0f}."
                )
        if bits:
            parts.append(" ".join(bits))
    if not parts or _asks(q, ("bill", "save", "saving", "savings", "cost", "total")):
        parts.insert(0,
            f"The optimized annual bill is ${best['bill']['total']:.0f} ({best['annual_kwh']['total']:.0f} kWh), "
            f"compared with ${base['bill']['total']:.0f} ({base['annual_kwh']['total']:.0f} kWh) before. "
            f"That is ${result['savings']['annual_usd']:.0f} saved, {result['savings']['share'] * 100:.1f}%."
        )
    return " ".join(parts).replace("*", "").strip()


def answer(question: str, result: dict | None, history: list[dict]) -> str:
    if not _ready_file():
        raise RuntimeError("The local model is not on this computer yet. Download it from the advisor page.")
    if not result:
        raise RuntimeError("Run an optimization first so the advisor has your bill, thermostat and appliance plan.")
    system = ("You are the energy advisor for one household. Use only the simulation brief below. "
              "Explain in plain English what to do: thermostat settings by time of day, when to run the "
              "dishwasher, washer, dryer and range, and how lighting is already included in the same bill. "
              "Every dollar, kWh, percent and temperature you write is checked against the brief. "
              "If a figure is not in the brief, leave it out. Do not round a figure to a different number. "
              "If the brief does not contain the answer, say so. Keep the reply under 180 words. "
              "Do not use asterisks.\n\nSIMULATION BRIEF\n" + summarize(result))
    messages = [{"role": "system", "content": system}]
    for turn in history[-6:]:
        if turn.get("role") in ("user", "assistant") and turn.get("content"):
            messages.append({"role": turn["role"], "content": str(turn["content"])[:2000]})
    messages.append({"role": "user", "content": question[:2000]})
    draft = _complete(messages, 0.2)
    if not unsupported_claims(draft, result):
        return draft
    messages.append({"role": "assistant", "content": draft})
    messages.append({"role": "user", "content":
                     "Fact check failed. Rewrite the answer using only figures printed in the simulation brief. "
                     "Drop every dollar, kWh, percent, temperature and clock time that the brief does not contain. "
                     "Do not use asterisks."})
    revised = _complete(messages, 0.0)
    if not unsupported_claims(revised, result):
        return revised
    return grounded_reply(question, result)


def _complete(messages: list[dict], temperature: float) -> str:
    reply = _engine().create_chat_completion(messages=messages, max_tokens=420, temperature=temperature)
    return reply["choices"][0]["message"]["content"].replace("*", "").strip()
