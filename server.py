"""Local web server for the Personal Building Energy Optimizer.

Run:  python server.py            (opens http://127.0.0.1:8765 in your browser)
Requires: Python 3.10+ and a local EnergyPlus 26.1 install
          (default C:\\EnergyPlusV26-1-0, override with ENERGYPLUS_DIR).
          The advisor also needs llama-cpp-python. See README.md.
"""
from __future__ import annotations

import json
import mimetypes
import sys
import threading
import webbrowser
from http.server import SimpleHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from urllib.parse import urlparse

import llm
import optimizer

ROOT = Path(__file__).resolve().parent
STATIC = ROOT / "static"
HOST, PORT = "127.0.0.1", 8765
JOBS = optimizer.JobStore()


class Handler(SimpleHTTPRequestHandler):
    def __init__(self, *args, **kwargs):
        super().__init__(*args, directory=str(STATIC), **kwargs)

    # ---- helpers ---------------------------------------------------------------------
    def _json(self, payload, status: int = 200) -> None:
        body = json.dumps(payload).encode("utf-8")
        self.send_response(status)
        self.send_header("Content-Type", "application/json; charset=utf-8")
        self.send_header("Content-Length", str(len(body)))
        self.send_header("Cache-Control", "no-store")
        self.end_headers()
        self.wfile.write(body)

    def _read_json(self) -> dict:
        length = int(self.headers.get("Content-Length", "0"))
        raw = self.rfile.read(length) if length else b"{}"
        return json.loads(raw.decode("utf-8") or "{}")

    def log_message(self, fmt, *args):  # quieter console
        if "/api/jobs/" not in (args[0] if args else ""):
            sys.stdout.write("%s - %s\n" % (self.address_string(), fmt % args))

    # ---- routing ---------------------------------------------------------------------
    def do_GET(self):
        path = urlparse(self.path).path
        if path == "/api/model":
            try:
                return self._json(optimizer.model_info())
            except Exception as exc:
                return self._json({"error": str(exc)}, 500)
        if path == "/api/llm":
            return self._json(llm.status())
        if path == "/api/plan":
            return self._json({"error": "use POST"}, 405)
        if path.startswith("/api/jobs/"):
            job = JOBS.get(path.split("/")[3])
            if not job:
                return self._json({"error": "unknown job"}, 404)
            return self._json({k: job[k] for k in ("id", "status", "progress", "log", "error", "result")})
        if path == "/":
            self.path = "/index.html"
        return super().do_GET()

    def do_POST(self):
        path = urlparse(self.path).path
        try:
            data = self._read_json()
        except json.JSONDecodeError:
            return self._json({"error": "invalid JSON"}, 400)
        if path == "/api/plan":
            try:
                plan = optimizer.candidate_plan(data.get("comfort", {}))
                plan.pop("pairs", None)
                return self._json(plan)
            except Exception as exc:
                return self._json({"error": str(exc)}, 400)
        if path == "/api/llm/download":
            return self._json(llm.start_download(), 202)
        if path == "/api/chat":
            question = (data.get("message") or "").strip()
            if not question:
                return self._json({"error": "type a question first"}, 400)
            try:
                reply = llm.answer(question, JOBS.latest_result(), data.get("history") or [])
                return self._json({"reply": reply})
            except Exception as exc:
                return self._json({"error": str(exc)}, 400)
        if path == "/api/optimize":
            missing = [k for k in ("occupant", "tariff", "comfort", "lighting") if k not in data]
            if missing:
                return self._json({"error": f"missing fields: {', '.join(missing)}"}, 400)
            job_id = JOBS.create(data)
            return self._json({"job_id": job_id}, 202)
        return self._json({"error": "not found"}, 404)

    def end_headers(self):
        if self.path.endswith((".html", ".js", ".css")):
            self.send_header("Cache-Control", "no-store")
        super().end_headers()

    def guess_type(self, path):
        ctype = super().guess_type(path)
        if ctype in ("application/javascript", "text/javascript", "text/css", "text/html"):
            ctype += "; charset=utf-8"
        return ctype


def main() -> None:
    mimetypes.add_type("application/javascript", ".js")
    optimizer.RUNS_DIR.mkdir(exist_ok=True)
    server = ThreadingHTTPServer((HOST, PORT), Handler)
    url = f"http://{HOST}:{PORT}/"
    print(f"Personal Building Energy Optimizer running at {url}")
    print(f"EnergyPlus: {optimizer.EP_EXE} ({'found' if optimizer.EP_EXE.exists() else 'NOT FOUND'})")
    print(f"Model folder: {optimizer.MODEL_DIR}")
    print(f"Advisor model: {llm.MODEL_PATH} ({'ready' if llm.status()['state'] == 'ready' else 'downloading'})")
    llm.start_download()
    if "--no-browser" not in sys.argv:
        threading.Timer(0.8, lambda: webbrowser.open(url)).start()
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        pass
    finally:
        server.server_close()


if __name__ == "__main__":
    main()
