from __future__ import annotations

import argparse
import base64
import hashlib
import json
import mimetypes
import re
import ssl
import time
import urllib.error
import urllib.request
from datetime import datetime, timedelta, timezone
from http import HTTPStatus
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from urllib.parse import urlparse

from .storage import AppStorage

ROOT = Path(__file__).resolve().parents[1]
STATIC = ROOT / "static"


def utc_iso(epoch: float | None = None) -> str:
    value = time.time() if epoch is None else epoch
    return datetime.fromtimestamp(value, tz=timezone.utc).isoformat()


def file_sha256(data: bytes) -> str:
    return hashlib.sha256(data).hexdigest()


def safe_name(name: str) -> str:
    cleaned = "".join(ch if ch.isalnum() or ch in "._-" else "_" for ch in name)
    return cleaned.strip("._") or "upload.bin"


def compact_utc(value: datetime) -> str:
    return value.astimezone(timezone.utc).isoformat().replace("+00:00", "Z")


def previous_run(now: datetime) -> datetime:
    utc_now = now.astimezone(timezone.utc).replace(minute=0, second=0, microsecond=0)
    return utc_now.replace(hour=(utc_now.hour // 6) * 6)


def next_forecast_hour(now: datetime, run_dt: datetime) -> int:
    elapsed_hours = (now - run_dt).total_seconds() / 3600
    rounded = int((elapsed_hours + 2.999) // 3) * 3
    return min(48, max(6, rounded))


class TurbliApp:
    def __init__(self, root: Path = ROOT):
        self.root = root
        self.static = root / "static"
        self.storage = AppStorage(root)

    def read_state(self) -> dict:
        return {
            "sources": self.storage.read_sources(),
            "transforms": self.storage.read_transforms(),
        }

    def save_transform(self, payload: dict) -> dict:
        source_id = payload.get("sourceId")
        family = payload.get("family")
        file_hash = payload.get("fileHash")
        transform = payload.get("transform") or {}
        if not isinstance(transform, dict):
            raise ValueError("transform must be an object")
        bank = self.storage.read_transforms()
        if family:
            bank.setdefault("families", {})[family] = transform
        if source_id:
            bank.setdefault("sources", {})[source_id] = transform
        if file_hash:
            bank.setdefault("uploads", {})[file_hash] = transform
        self.storage.write_transforms(bank)
        return bank

    def upload_image(self, payload: dict) -> dict:
        data_url = payload.get("dataUrl", "")
        name = safe_name(str(payload.get("name") or "upload.png"))
        if "," in data_url:
            _, encoded = data_url.split(",", 1)
        else:
            encoded = data_url
        raw = base64.b64decode(encoded)
        digest = file_sha256(raw)
        ext = Path(name).suffix or ".png"
        out_path = self.storage.uploads_dir / f"{digest}{ext}"
        out_path.write_bytes(raw)
        source = {
            "id": f"user_upload:{digest}",
            "family": "user_upload",
            "kind": "user_upload",
            "name": name,
            "fileHash": digest,
            "url": f"/uploads/{out_path.name}",
            "createdAt": utc_iso(),
        }
        sources = self.storage.read_sources()
        sources.setdefault("sources", {})[source["id"]] = source
        sources["activeSourceId"] = source["id"]
        self.storage.write_sources(sources)
        return source

    def fetch_turbli_image(self, payload: dict, now: datetime | None = None) -> dict:
        date = str(payload.get("date") or "")
        run = str(payload.get("run") or "").zfill(2)
        hour = str(payload.get("hour") or "").zfill(3)
        region = str(payload.get("region") or "us").lower()
        try:
            altitude_feet = int(payload.get("altitudeFeet") or 33000)
        except (TypeError, ValueError):
            raise ValueError("altitudeFeet must be an integer")
        force = bool(payload.get("force"))
        if payload.get("latest"):
            return self.fetch_latest_turbli_image(altitude_feet, region, force, now)
        if not re.fullmatch(r"\d{8}", date):
            raise ValueError("date must be YYYYMMDD")
        if run not in {"00", "06", "12", "18"}:
            raise ValueError("run must be one of 00, 06, 12, or 18")
        if not re.fullmatch(r"\d{3}", hour) or int(hour) % 3 != 0:
            raise ValueError("hour must be a 3-hour increment like 006")
        if altitude_feet < 3000 or altitude_feet > 60000 or altitude_feet % 3000 != 0:
            raise ValueError("altitudeFeet must be a 3000 ft increment")
        if not re.fullmatch(r"[a-z0-9_-]{2,16}", region):
            raise ValueError("region must contain only letters, numbers, underscores, or dashes")

        filename = f"CAT_{hour}_{altitude_feet}_{region}.jpg"
        database = f"GTG_{date}_{run}"
        remote_url = f"https://turbli.com/databases/{database}/figures/{filename}"
        source_id = self.turbli_source_id(date, run, hour, altitude_feet, region)
        sources = self.storage.read_sources()
        existing = sources.get("sources", {}).get(source_id)
        if existing and not force:
            if existing["url"].startswith("https://") or (self.storage.uploads_dir / Path(existing["url"]).name).exists():
                sources["activeSourceId"] = source_id
                self.storage.write_sources(sources)
                return {**existing, "cacheHit": True}

        request = urllib.request.Request(
            remote_url,
            headers={"User-Agent": "Mozilla/5.0 TurbliGPS/0.1"},
        )
        try:
            with urllib.request.urlopen(request, timeout=30) as response:
                content_type = response.headers.get_content_type()
                raw = response.read()
        except urllib.error.HTTPError as exc:
            if exc.code == 403:
                return self.save_remote_turbli_source(
                    source_id=source_id,
                    filename=filename,
                    remote_url=remote_url,
                    date=date,
                    run=run,
                    hour=hour,
                    altitude_feet=altitude_feet,
                    region=region,
                    reason="remote server blocked local fetch",
                )
            raise ValueError(f"failed to fetch Turbli image: {exc}") from exc
        except urllib.error.URLError as exc:
            reason = getattr(exc, "reason", None)
            if not isinstance(reason, ssl.SSLCertVerificationError):
                raise ValueError(f"failed to fetch Turbli image: {exc}") from exc
            context = ssl._create_unverified_context()
            try:
                with urllib.request.urlopen(request, timeout=30, context=context) as response:
                    content_type = response.headers.get_content_type()
                    raw = response.read()
            except urllib.error.HTTPError as retry_exc:
                if retry_exc.code == 403:
                    return self.save_remote_turbli_source(
                        source_id=source_id,
                        filename=filename,
                        remote_url=remote_url,
                        date=date,
                        run=run,
                        hour=hour,
                        altitude_feet=altitude_feet,
                        region=region,
                        reason="remote server blocked local fetch",
                    )
                raise ValueError(f"failed to fetch Turbli image: {retry_exc}") from retry_exc
        except Exception as exc:
            raise ValueError(f"failed to fetch Turbli image: {exc}") from exc
        if content_type not in {"image/jpeg", "image/jpg"}:
            raise ValueError(f"Turbli returned {content_type}, not a JPEG")
        digest = file_sha256(raw)
        out_path = self.storage.uploads_dir / f"{digest}.jpg"
        out_path.write_bytes(raw)
        run_dt = datetime.strptime(f"{date}{run}", "%Y%m%d%H").replace(tzinfo=timezone.utc)
        forecast_dt = run_dt + timedelta(hours=int(hour))
        source = {
            "id": source_id,
            "family": f"turbli_direct:{region}",
            "kind": "turbli_direct",
            "name": filename,
            "fileHash": digest,
            "url": f"/uploads/{out_path.name}",
            "remoteUrl": remote_url,
            "scrapeEpoch": time.time(),
            "scrapeTime": utc_iso(),
            "forecastTime": compact_utc(forecast_dt),
            "altitudeText": f"{altitude_feet:,} ft",
            "cacheHit": False,
            "turbli": {
                "date": date,
                "run": run,
                "hour": hour,
                "altitudeFeet": altitude_feet,
                "region": region,
                "database": database,
            },
        }
        sources.setdefault("sources", {})[source_id] = source
        sources["activeSourceId"] = source_id
        self.storage.write_sources(sources)
        return source

    def fetch_latest_turbli_image(
        self,
        altitude_feet: int,
        region: str,
        force: bool = False,
        now: datetime | None = None,
    ) -> dict:
        errors = []
        for date, run, hour in self.recent_turbli_slots(altitude_feet, region, now):
            try:
                return self.fetch_turbli_image({
                    "date": date,
                    "run": run,
                    "hour": hour,
                    "altitudeFeet": altitude_feet,
                    "region": region,
                    "force": force,
                })
            except ValueError as exc:
                errors.append(str(exc))
        detail = errors[-1] if errors else "no candidate slots"
        raise ValueError(f"could not fetch a recent Turbli image: {detail}")

    def save_remote_turbli_source(
        self,
        source_id: str,
        filename: str,
        remote_url: str,
        date: str,
        run: str,
        hour: str,
        altitude_feet: int,
        region: str,
        reason: str,
    ) -> dict:
        run_dt = datetime.strptime(f"{date}{run}", "%Y%m%d%H").replace(tzinfo=timezone.utc)
        source = {
            "id": source_id,
            "family": f"turbli_direct:{region}",
            "kind": "turbli_remote",
            "name": filename,
            "fileHash": file_sha256(remote_url.encode("utf-8")),
            "url": remote_url,
            "remoteUrl": remote_url,
            "scrapeEpoch": time.time(),
            "scrapeTime": utc_iso(),
            "forecastTime": compact_utc(run_dt + timedelta(hours=int(hour))),
            "altitudeText": f"{altitude_feet:,} ft",
            "cacheHit": False,
            "fetchNote": reason,
            "turbli": {
                "date": date,
                "run": run,
                "hour": hour,
                "altitudeFeet": altitude_feet,
                "region": region,
                "database": f"GTG_{date}_{run}",
            },
        }
        sources = self.storage.read_sources()
        sources.setdefault("sources", {})[source_id] = source
        sources["activeSourceId"] = source_id
        self.storage.write_sources(sources)
        return source

    def recent_turbli_slots(
        self,
        altitude_feet: int = 33000,
        region: str = "us",
        now: datetime | None = None,
    ):
        current = now or datetime.now(timezone.utc)
        start = previous_run(current)
        for run_index in range(0, 8):
            run_dt = start - timedelta(hours=run_index * 6)
            first_hour = next_forecast_hour(current, run_dt)
            for forecast_hour in range(first_hour, 49, 3):
                date = run_dt.strftime("%Y%m%d")
                run = f"{run_dt.hour:02d}"
                hour = f"{forecast_hour:03d}"
                if self.has_cached_turbli_source(date, run, hour, altitude_feet, region):
                    yield date, run, hour
        for run_index in range(0, 8):
            run_dt = start - timedelta(hours=run_index * 6)
            first_hour = next_forecast_hour(current, run_dt)
            for forecast_hour in range(first_hour, 49, 3):
                yield run_dt.strftime("%Y%m%d"), f"{run_dt.hour:02d}", f"{forecast_hour:03d}"

    def turbli_source_id(self, date: str, run: str, hour: str, altitude_feet: int, region: str) -> str:
        return f"turbli_direct:GTG_{date}_{run}:{hour}:{altitude_feet}:{region}"

    def has_cached_turbli_source(self, date: str, run: str, hour: str, altitude_feet: int, region: str) -> bool:
        sources = self.storage.read_sources().get("sources", {})
        existing = sources.get(self.turbli_source_id(date, run, hour, altitude_feet, region))
        return bool(existing and (self.storage.uploads_dir / Path(existing["url"]).name).exists())


APP = TurbliApp()


class Handler(BaseHTTPRequestHandler):
    server_version = "TurbliGPS/0.1"

    def log_message(self, fmt: str, *args) -> None:
        print(f"{self.address_string()} - {fmt % args}")

    def send_json(self, value: object, status: HTTPStatus = HTTPStatus.OK, head_only: bool = False) -> None:
        raw = json.dumps(value, indent=2).encode("utf-8")
        self.send_response(status)
        self.send_header("Content-Type", "application/json; charset=utf-8")
        self.send_header("Content-Length", str(len(raw)))
        self.end_headers()
        if not head_only:
            self.wfile.write(raw)

    def read_json(self) -> dict:
        length = int(self.headers.get("Content-Length", "0") or 0)
        if length == 0:
            return {}
        return json.loads(self.rfile.read(length).decode("utf-8"))

    def do_GET(self) -> None:
        parsed = urlparse(self.path)
        if parsed.path == "/api/state":
            self.send_json(APP.read_state())
            return
        self.serve_file(parsed.path)

    def do_HEAD(self) -> None:
        parsed = urlparse(self.path)
        if parsed.path == "/api/state":
            self.send_json(APP.read_state(), head_only=True)
            return
        self.serve_file(parsed.path, head_only=True)

    def do_POST(self) -> None:
        parsed = urlparse(self.path)
        try:
            payload = self.read_json()
            if parsed.path == "/api/upload":
                self.send_json(APP.upload_image(payload), HTTPStatus.CREATED)
            elif parsed.path == "/api/transform":
                self.send_json(APP.save_transform(payload))
            elif parsed.path == "/api/turbli/fetch":
                self.send_json(APP.fetch_turbli_image(payload), HTTPStatus.CREATED)
            else:
                self.send_json({"error": "not found"}, HTTPStatus.NOT_FOUND)
        except Exception as exc:
            self.send_json({"error": str(exc)}, HTTPStatus.BAD_REQUEST)

    def serve_file(self, path: str, head_only: bool = False) -> None:
        if path in ("", "/"):
            path = "/index.html"
        if path.startswith("/uploads/"):
            candidate = (APP.storage.uploads_dir / path.removeprefix("/uploads/")).resolve()
            if not str(candidate).startswith(str(APP.storage.uploads_dir.resolve())):
                self.send_error(HTTPStatus.FORBIDDEN)
                return
        else:
            candidate = (APP.static / path.lstrip("/")).resolve()
            if not str(candidate).startswith(str(APP.static.resolve())):
                self.send_error(HTTPStatus.FORBIDDEN)
                return
        if not candidate.exists() or not candidate.is_file():
            self.send_error(HTTPStatus.NOT_FOUND)
            return
        content_type = mimetypes.guess_type(str(candidate))[0] or "application/octet-stream"
        raw = candidate.read_bytes()
        self.send_response(HTTPStatus.OK)
        self.send_header("Content-Type", content_type)
        self.send_header("Cache-Control", "no-store")
        self.send_header("Content-Length", str(len(raw)))
        self.end_headers()
        if not head_only:
            self.wfile.write(raw)


def main() -> None:
    parser = argparse.ArgumentParser(description="Run the Turbli GPS local web app.")
    parser.add_argument("--host", default="127.0.0.1")
    parser.add_argument("--port", type=int, default=8765)
    args = parser.parse_args()
    server = ThreadingHTTPServer((args.host, args.port), Handler)
    print(f"Turbli GPS listening at http://{args.host}:{args.port}")
    server.serve_forever()


if __name__ == "__main__":
    main()
