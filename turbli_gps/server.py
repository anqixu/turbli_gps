from __future__ import annotations

import argparse
import base64
import hashlib
import json
import logging
import math
import mimetypes
import re
import ssl
import threading
import time
import urllib.error
import urllib.parse
import urllib.request
from collections.abc import Callable, Iterator
from dataclasses import dataclass
from datetime import datetime, timedelta, timezone
from http import HTTPStatus
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from urllib.parse import urlparse

from .storage import AppStorage

logger = logging.getLogger(__name__)

ROOT = Path(__file__).resolve().parents[1]
STATIC = ROOT / "static"
MAX_BODY_BYTES = 50 * 1024 * 1024
IMAGE_EXTENSIONS = {".png", ".jpg", ".jpeg", ".gif", ".webp", ".bmp"}

TURBLI_BASE_URL = "https://turbli.com"
TURBLI_REGIONS = ("us", "europe", "world")
# Altitudes offered by turbli.com's map pages; used when the page cannot be read.
TURBLI_ALTITUDES_FT = (15000, 20000, 25000, 30000, 33000, 36000, 39000)
TURBLI_FIRST_HOUR = 6
TURBLI_LAST_HOUR = 36
# Cloudflare's browser integrity check rejects requests without a browser-like
# User-Agent (error 1010); this one passes while still naming the app.
TURBLI_USER_AGENT = "Mozilla/5.0 TurbliGPS/0.1"
TURBLI_TIMEOUT_SECONDS = 30
READ_CHUNK_BYTES = 64 * 1024
CATALOG_TTL_SECONDS = 600
# turbli.com publishes run GTG_<date>_<HH> about two hours before HH:00Z and
# labels its CAT_006 frame "Now", so forecast hours count from HH:00Z - 6 h.
RUN_LABEL_LEAD = timedelta(hours=6)

# The interactive map's data endpoint: one forecast hour of the global 1-degree
# grid, all altitudes, as EDR x 100. file_name is the run's CAT hour, e.g. 009.
TURBLI_GRID_URL = f"{TURBLI_BASE_URL}/maps/interactive-turbulence-map/get_forecast_hour/"
TURBLI_AIRPORTS_URL = f"{TURBLI_BASE_URL}/getAirports/"
# The page that lists the current run; any region's page names the same run.
GRID_CATALOG_REGION = "us"

AIRPORT_RE = re.compile(r"(?:^|,)([^#,]*)#[^#]*#([A-Z0-9]{3})#[A-Z0-9]*#(-?\d+(?:\.\d+)?)#(-?\d+(?:\.\d+)?)#")
MAP_PAGE_FRAME_RE = re.compile(r"/databases/GTG_(\d{8})_(\d{2})/figures/CAT_(\d{3})")
MAP_PAGE_ALTITUDES_RE = re.compile(r"altitudes_ft\s*=\s*\(\"\[([\d,\s]+)\]\"\)")
CLOUDFLARE_BLOCK_MARKERS = (b"Attention Required! | Cloudflare", b"Just a moment...", b"error code: 10")


def local_iso(epoch: float | None = None) -> str:
    value = time.time() if epoch is None else epoch
    return datetime.fromtimestamp(value).astimezone().isoformat()


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


@dataclass(frozen=True)
class TurbliFrame:
    """One forecast frame of a Turbli run, independent of altitude and region."""

    date: str  # Run label date, YYYYMMDD.
    run: str  # Run label hour: 00, 06, 12 or 18.
    hour: str  # Forecast hour, zero-padded to three digits.

    @classmethod
    def from_label(cls, label: datetime, hour: int) -> TurbliFrame:
        return cls(label.strftime("%Y%m%d"), f"{label.hour:02d}", f"{hour:03d}")

    @property
    def label_time(self) -> datetime:
        return datetime.strptime(f"{self.date}{self.run}", "%Y%m%d%H").replace(tzinfo=timezone.utc)

    @property
    def valid_time(self) -> datetime:
        return self.label_time - RUN_LABEL_LEAD + timedelta(hours=int(self.hour))

    @property
    def database(self) -> str:
        return f"GTG_{self.date}_{self.run}"

    def filename(self, altitude_feet: int, region: str) -> str:
        return f"CAT_{self.hour}_{altitude_feet}_{region}.jpg"

    def remote_url(self, altitude_feet: int, region: str) -> str:
        return f"{TURBLI_BASE_URL}/databases/{self.database}/figures/{self.filename(altitude_feet, region)}"


@dataclass(frozen=True)
class TurbliCatalog:
    """What a turbli.com map page currently offers; frames[0] is the "Now" frame."""

    frames: list[TurbliFrame]
    altitudes_ft: tuple[int, ...]


@dataclass(frozen=True)
class CachedCatalog:
    fetched_at: float  # time.monotonic() of the page fetch.
    catalog: TurbliCatalog


@dataclass(frozen=True)
class HttpBody:
    content_type: str
    data: bytes


class TurbliFetchError(ValueError):
    def __init__(self, message: str, blocked: bool = False):
        super().__init__(message)
        self.blocked = blocked


def parse_map_page(html: str) -> TurbliCatalog | None:
    """Reads the current run's frames and altitudes from a turbli.com map page."""
    frames = [TurbliFrame(*match) for match in MAP_PAGE_FRAME_RE.findall(html)]
    # The page repeats its frame list, so keep the first occurrence of each.
    frames = list(dict.fromkeys(frames))
    if not frames:
        return None
    altitudes = MAP_PAGE_ALTITUDES_RE.search(html)
    altitudes_ft = (
        tuple(sorted(int(value) for value in altitudes.group(1).split(",")))
        if altitudes
        else TURBLI_ALTITUDES_FT
    )
    return TurbliCatalog(frames, altitudes_ft)


def guessed_frames(now: datetime, lead_hours: int) -> Iterator[TurbliFrame]:
    """Yields the likely "Now + lead" frame of the newest run labels, newest first.

    turbli.com keeps only its current run, and that run's label is up to six
    hours ahead of the clock, so the next label is tried before the current one.
    """
    label = previous_run(now) + timedelta(hours=6)
    for _ in range(3):
        elapsed_hours = (now - (label - RUN_LABEL_LEAD)).total_seconds() / 3600
        hour = max(TURBLI_FIRST_HOUR, int(elapsed_hours // 3) * 3) + lead_hours
        if hour <= TURBLI_LAST_HOUR:
            yield TurbliFrame.from_label(label, hour)
        label -= timedelta(hours=6)


def describe_http_error(exc: urllib.error.HTTPError) -> TurbliFetchError:
    try:
        body = exc.read(4096) or b""
    except (OSError, ValueError):
        body = b""
    headers = exc.headers or {}
    blocked = exc.code == 429 or bool(headers.get("cf-mitigated")) or any(m in body for m in CLOUDFLARE_BLOCK_MARKERS)
    if blocked:
        return TurbliFetchError(
            f"Turbli's Cloudflare bot check blocked the request (HTTP {exc.code}); "
            "open turbli.com in the browser and paste the map image instead",
            blocked=True,
        )
    reason = f" {exc.reason}" if getattr(exc, "reason", None) else ""
    return TurbliFetchError(f"failed to fetch Turbli image: HTTP {exc.code}{reason}")


ProgressCallback = Callable[[int, int | None], None]  # (bytes received, Content-Length or None)


def _read_url(
    request: urllib.request.Request,
    context: ssl.SSLContext | None = None,
    on_progress: ProgressCallback | None = None,
) -> HttpBody:
    with urllib.request.urlopen(request, timeout=TURBLI_TIMEOUT_SECONDS, context=context) as response:
        total = int(response.headers.get("Content-Length") or 0) or None
        chunks = []
        received = 0
        while chunk := response.read(READ_CHUNK_BYTES):
            chunks.append(chunk)
            received += len(chunk)
            if on_progress:
                on_progress(received, total)
        return HttpBody(response.headers.get_content_type(), b"".join(chunks))


def http_get(url: str, form: dict | None = None, on_progress: ProgressCallback | None = None) -> HttpBody:
    """GETs url, or POSTs form as application/x-www-form-urlencoded when given."""
    data = urllib.parse.urlencode(form).encode("ascii") if form is not None else None
    request = urllib.request.Request(url, data=data, headers={"User-Agent": TURBLI_USER_AGENT})
    try:
        try:
            return _read_url(request, on_progress=on_progress)
        except urllib.error.URLError as exc:
            if not isinstance(getattr(exc, "reason", None), ssl.SSLCertVerificationError):
                raise
            # Some networks re-sign TLS; a public forecast image is not worth failing over.
            logger.warning("TLS verification failed for %s; retrying without verification", url)
            return _read_url(request, ssl._create_unverified_context(), on_progress)
    except urllib.error.HTTPError as exc:
        raise describe_http_error(exc) from exc
    except (urllib.error.URLError, OSError) as exc:
        raise TurbliFetchError(f"offline or network error: {exc}") from exc


def encode_grid(body: dict, altitude_key_suffix: str) -> dict:
    """Packs one altitude of a get_forecast_hour/ response into a compact grid.

    The response holds (rows, cols) arrays: lat (south row first), lon (west
    column first), and cat_<lead>_<altitude> values in EDR x 100. Values become
    one byte each, row-major, base64 encoded.
    """
    lat, lon = body["lat"], body["lon"]
    key = next((key for key in body if key.startswith("cat_") and key.endswith(altitude_key_suffix)), None)
    if key is None:
        raise TurbliFetchError(f"Turbli grid has no {altitude_key_suffix.strip('_')} ft data")
    values = bytearray()
    for row in body[key]:
        for value in row:
            number = float(value) if value is not None else 0.0
            values.append(0 if math.isnan(number) else min(255, max(0, round(number))))
    return {
        "lat0": float(lat[0][0]),
        "lon0": float(lon[0][0]),
        "step": float(lat[1][0]) - float(lat[0][0]),
        "rows": len(lat),
        "cols": len(lat[0]),
        "values": base64.b64encode(bytes(values)).decode("ascii"),
    }


def parse_airports(text: str) -> dict[str, dict]:
    """Parses getAirports/ (City#Name#IATA#ICAO#lat#lon#n, comma separated)."""
    return {
        code: {"code": code, "name": city.strip(), "lat": float(lat), "lon": float(lon)}
        for city, code, lat, lon in AIRPORT_RE.findall(text)
    }


def parse_altitude(value: object) -> int:
    try:
        altitude_feet = int(value or 33000)
    except (TypeError, ValueError):
        raise ValueError("altitudeFeet must be an integer")
    if not 1000 <= altitude_feet <= 60000 or altitude_feet % 1000:
        raise ValueError("altitudeFeet must be a 1000 ft increment")
    return altitude_feet


def parse_lead_hours(value: object) -> int:
    try:
        lead_hours = int(value or 0)
    except (TypeError, ValueError):
        raise ValueError("leadHours must be an integer")
    if not 0 <= lead_hours <= TURBLI_LAST_HOUR - TURBLI_FIRST_HOUR or lead_hours % 3:
        raise ValueError("leadHours must be a 3-hour step between 0 and 30")
    return lead_hours


class TurbliApp:
    def __init__(self, root: Path = ROOT):
        self.root = root
        self.static = root / "static"
        self.storage = AppStorage(root)
        # Serialises read-modify-write of the JSON stores across server threads.
        self._lock = threading.RLock()
        self._catalogs: dict[str, CachedCatalog] = {}
        # The download in flight, for the browser to poll. Turbli sends chunked
        # bodies without Content-Length, so the last size of each kind of
        # download serves as the estimate for the next one.
        self.progress: dict = {"label": None, "received": 0, "total": None, "estimate": None}
        self.expected_sizes: dict[str, int] = {}

    def read_progress(self) -> dict:
        return dict(self.progress)

    def tracked_get(self, label: str, url: str, form: dict | None = None) -> HttpBody:
        """http_get that publishes its progress under label."""
        self.progress = {"label": label, "received": 0, "total": None, "estimate": self.expected_sizes.get(label)}

        def on_progress(received: int, total: int | None) -> None:
            self.progress = {**self.progress, "received": received, "total": total}

        body = http_get(url, form, on_progress)
        self.expected_sizes[label] = len(body.data)
        return body

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
        with self._lock:
            bank = self.storage.read_transforms()
            if family:
                bank.setdefault("families", {})[family] = transform
            if source_id:
                bank.setdefault("sources", {})[source_id] = transform
            if file_hash:
                bank.setdefault("uploads", {})[file_hash] = transform
            self.storage.write_transforms(bank)
        return bank

    def activate_source(self, source: dict) -> None:
        with self._lock:
            sources = self.storage.read_sources()
            sources.setdefault("sources", {})[source["id"]] = source
            sources["activeSourceId"] = source["id"]
            self.storage.write_sources(sources)

    def upload_image(self, payload: dict) -> dict:
        data_url = payload.get("dataUrl", "")
        if not data_url:
            raise ValueError("dataUrl is required")
        name = safe_name(str(payload.get("name") or "upload.png"))
        encoded = data_url.split(",", 1)[-1]
        raw = base64.b64decode(encoded)
        if not raw:
            raise ValueError("uploaded image is empty")
        digest = file_sha256(raw)
        ext = Path(name).suffix.lower()
        if ext not in IMAGE_EXTENSIONS:
            ext = ".png"
        out_path = self.storage.uploads_dir / f"{digest}{ext}"
        out_path.write_bytes(raw)
        source = {
            "id": f"user_upload:{digest}",
            "family": "user_upload",
            "kind": "user_upload",
            "name": name,
            "fileHash": digest,
            "url": f"/uploads/{out_path.name}",
            "createdAt": local_iso(),
        }
        self.activate_source(source)
        return source

    def fetch_turbli_image(self, payload: dict, now: datetime | None = None) -> dict:
        region = str(payload.get("region") or "us").lower()
        if region not in TURBLI_REGIONS:
            raise ValueError(f"region must be one of {', '.join(TURBLI_REGIONS)}")
        altitude_feet = parse_altitude(payload.get("altitudeFeet"))
        force = bool(payload.get("force"))
        if payload.get("latest"):
            lead_hours = parse_lead_hours(payload.get("leadHours"))
            return self.fetch_latest_turbli_image(altitude_feet, region, force, now, lead_hours)

        date = str(payload.get("date") or "")
        run = str(payload.get("run") or "").zfill(2)
        hour = str(payload.get("hour") or "").zfill(3)
        if not re.fullmatch(r"\d{8}", date):
            raise ValueError("date must be YYYYMMDD")
        if run not in {"00", "06", "12", "18"}:
            raise ValueError("run must be one of 00, 06, 12, or 18")
        if not re.fullmatch(r"\d{3}", hour) or int(hour) % 3 != 0:
            raise ValueError("hour must be a 3-hour increment like 006")
        return self.download_frame(TurbliFrame(date, run, hour), altitude_feet, region, force)

    def fetch_latest_turbli_image(
        self,
        altitude_feet: int,
        region: str,
        force: bool = False,
        now: datetime | None = None,
        lead_hours: int = 0,
    ) -> dict:
        frames = self.latest_frame_candidates(altitude_feet, region, now, lead_hours)
        return self.first_available(frames, lambda frame: self.download_frame(frame, altitude_feet, region, force))

    def fetch_turbli_grid(self, payload: dict, now: datetime | None = None) -> dict:
        altitude_feet = parse_altitude(payload.get("altitudeFeet"))
        lead_hours = parse_lead_hours(payload.get("leadHours"))
        force = bool(payload.get("force"))
        frames = self.latest_frame_candidates(altitude_feet, GRID_CATALOG_REGION, now, lead_hours)
        return self.first_available(frames, lambda frame: self.download_grid(frame, altitude_feet, lead_hours, force))

    def first_available(self, frames: Iterator[TurbliFrame], download) -> dict:
        """Returns download(frame) for the first frame Turbli serves."""
        errors = []
        for frame in frames:
            try:
                return download(frame)
            except TurbliFetchError as exc:
                errors.append(f"{frame.database} CAT_{frame.hour}: {exc}")
                if exc.blocked:
                    break
        detail = "; ".join(errors) or "no candidate frames"
        raise ValueError(f"could not fetch recent Turbli data: {detail}")

    def latest_frame_candidates(
        self,
        altitude_feet: int,
        region: str,
        now: datetime | None,
        lead_hours: int,
    ) -> Iterator[TurbliFrame]:
        """Yields the "Now + lead" frame from turbli.com's map page, then guesses."""
        seen = set()
        catalog = self.map_catalog(region)
        if catalog:
            if altitude_feet not in catalog.altitudes_ft:
                offered = ", ".join(str(value) for value in catalog.altitudes_ft)
                raise ValueError(f"Turbli has not published {altitude_feet} ft; it offers {offered}")
            index = lead_hours // 3
            if index < len(catalog.frames):
                seen.add(catalog.frames[index])
                yield catalog.frames[index]
        for frame in guessed_frames(now or datetime.now(timezone.utc), lead_hours):
            if frame not in seen:
                yield frame

    def map_catalog(self, region: str) -> TurbliCatalog | None:
        """Returns the region's current frame list, re-reading the page every few minutes."""
        cached = self._catalogs.get(region)
        if cached and time.monotonic() - cached.fetched_at < CATALOG_TTL_SECONDS:
            return cached.catalog
        url = f"{TURBLI_BASE_URL}/maps/{region}-turbulence-map/"
        try:
            page = self.tracked_get("Reading Turbli's current run", url)
        except TurbliFetchError as exc:
            logger.warning("Could not read %s: %s", url, exc)
            return None
        catalog = parse_map_page(page.data.decode("utf-8", errors="replace"))
        if catalog is None:
            logger.warning("No Turbli frames found on %s; guessing the current run", url)
            return None
        self._catalogs[region] = CachedCatalog(time.monotonic(), catalog)
        return catalog

    def download_frame(self, frame: TurbliFrame, altitude_feet: int, region: str, force: bool = False) -> dict:
        source_id = self.turbli_source_id(frame, altitude_feet, region)
        existing = self.storage.read_sources().get("sources", {}).get(source_id)
        if existing and not force and self.upload_exists(existing):
            self.activate_source(existing)
            return {**existing, "cacheHit": True}

        remote_url = frame.remote_url(altitude_feet, region)
        body = self.tracked_get("Downloading Turbli image", remote_url)
        if body.content_type not in {"image/jpeg", "image/jpg"}:
            raise TurbliFetchError(f"Turbli returned {body.content_type}, not a JPEG")
        digest = file_sha256(body.data)
        out_path = self.storage.uploads_dir / f"{digest}.jpg"
        out_path.write_bytes(body.data)
        source = {
            "id": source_id,
            "family": f"turbli_direct:{region}",
            "kind": "turbli_direct",
            "name": frame.filename(altitude_feet, region),
            "fileHash": digest,
            "url": f"/uploads/{out_path.name}",
            "remoteUrl": remote_url,
            "scrapeEpoch": time.time(),
            "scrapeTime": local_iso(),
            "forecastTime": compact_utc(frame.valid_time),
            "altitudeText": f"{altitude_feet:,} ft",
            "turbli": {
                "date": frame.date,
                "run": frame.run,
                "hour": frame.hour,
                "altitudeFeet": altitude_feet,
                "region": region,
                "database": frame.database,
            },
        }
        self.activate_source(source)
        return {**source, "cacheHit": False}

    def download_grid(self, frame: TurbliFrame, altitude_feet: int, lead_hours: int, force: bool = False) -> dict:
        """Downloads one forecast hour of the global grid and stores every altitude."""

        def grid_source(altitude: int) -> dict:
            name = f"{frame.database}_CAT_{frame.hour}_{altitude}.json"
            return {
                "id": f"turbli_grid:{frame.database}:{frame.hour}:{altitude}",
                "family": "turbli_grid",
                "kind": "turbli_grid",
                "name": f"{frame.database} CAT_{frame.hour} grid",
                "url": f"/grids/{name}",
                "remoteUrl": TURBLI_GRID_URL,
                "scrapeEpoch": time.time(),
                "scrapeTime": local_iso(),
                "forecastTime": compact_utc(frame.valid_time),
                "altitudeText": f"{altitude:,} ft",
                "turbli": {
                    "date": frame.date,
                    "run": frame.run,
                    "hour": frame.hour,
                    "leadHours": lead_hours,
                    "altitudeFeet": altitude,
                    "database": frame.database,
                },
            }

        source = grid_source(altitude_feet)
        existing = self.storage.read_sources().get("sources", {}).get(source["id"])
        if not force and self.upload_exists(existing or source):
            source = existing or source
            self.activate_source(source)
            return {**source, "cacheHit": True}

        body = self.tracked_get("Downloading Turbli grid", TURBLI_GRID_URL, {"hour": lead_hours, "file_name": frame.hour})
        try:
            data = json.loads(body.data)
        except ValueError as exc:
            raise TurbliFetchError(f"Turbli returned {body.content_type} that is not grid JSON") from exc
        altitudes = sorted({int(key.rsplit("_", 1)[1]) for key in data if key.startswith("cat_")})
        if altitude_feet not in altitudes:
            raise TurbliFetchError(f"Turbli grid has no {altitude_feet} ft data")
        for altitude in altitudes:
            grid = encode_grid(data, f"_{altitude}")
            path = self.storage.grids_dir / Path(grid_source(altitude)["url"]).name
            path.write_text(json.dumps(grid), encoding="utf-8")
        self.activate_source(source)
        return {**source, "cacheHit": False}

    def resolve_route(self, payload: dict) -> dict:
        """Resolves "SEA-MUC" (any separator) to the two airports' names and positions."""
        codes = re.findall(r"[A-Za-z0-9]{3}", str(payload.get("route") or ""))
        if len(codes) != 2:
            raise ValueError("route must name two IATA airport codes, like SEA-MUC")
        airports = self.airports()
        missing = [code.upper() for code in codes if code.upper() not in airports]
        if missing:
            raise ValueError(f"unknown airport code: {', '.join(missing)}")
        return {"from": airports[codes[0].upper()], "to": airports[codes[1].upper()]}

    def airports(self) -> dict[str, dict]:
        """Turbli's airport list, downloaded once and kept under data/."""
        with self._lock:
            cached = self.storage.airports.read({})
            if cached:
                return cached
            body = self.tracked_get("Downloading Turbli airport list", TURBLI_AIRPORTS_URL)
            airports = parse_airports(body.data.decode("utf-8", errors="replace"))
            if not airports:
                raise ValueError("Turbli's airport list was empty or unreadable")
            self.storage.airports.write(airports)
            return airports

    def turbli_source_id(self, frame: TurbliFrame, altitude_feet: int, region: str) -> str:
        return f"turbli_direct:{frame.database}:{frame.hour}:{altitude_feet}:{region}"

    def stored_file(self, url: str) -> Path | None:
        """Maps a /uploads/ or /grids/ URL to its file under data/."""
        for prefix, directory in (("/uploads/", self.storage.uploads_dir), ("/grids/", self.storage.grids_dir)):
            if url.startswith(prefix):
                return directory / Path(url).name
        return None

    def upload_exists(self, source: dict) -> bool:
        path = self.stored_file(source.get("url", ""))
        return bool(path and path.exists())

    def has_cached_turbli_source(self, frame: TurbliFrame, altitude_feet: int, region: str) -> bool:
        existing = self.storage.read_sources().get("sources", {}).get(self.turbli_source_id(frame, altitude_feet, region))
        return bool(existing and self.upload_exists(existing))


APP = TurbliApp()


class Handler(BaseHTTPRequestHandler):
    server_version = "TurbliGPS/0.1"

    def log_message(self, fmt: str, *args) -> None:
        logger.info("%s - %s", self.address_string(), fmt % args)

    def send_json(self, value: object, status: HTTPStatus = HTTPStatus.OK, head_only: bool = False) -> None:
        raw = json.dumps(value).encode("utf-8")
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
        if length > MAX_BODY_BYTES:
            raise ValueError(f"request body too large ({length} bytes)")
        return json.loads(self.rfile.read(length).decode("utf-8"))

    def do_GET(self) -> None:
        self.handle_get()

    def do_HEAD(self) -> None:
        self.handle_get(head_only=True)

    def handle_get(self, head_only: bool = False) -> None:
        path = urlparse(self.path).path
        if path == "/api/state":
            self.send_json(APP.read_state(), head_only=head_only)
            return
        if path == "/api/progress":
            self.send_json(APP.read_progress(), head_only=head_only)
            return
        self.serve_file(path, head_only)

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
            elif parsed.path == "/api/turbli/grid":
                self.send_json(APP.fetch_turbli_grid(payload), HTTPStatus.CREATED)
            elif parsed.path == "/api/route":
                self.send_json(APP.resolve_route(payload))
            else:
                self.send_json({"error": "not found"}, HTTPStatus.NOT_FOUND)
        except Exception as exc:
            self.send_json({"error": str(exc)}, HTTPStatus.BAD_REQUEST)

    def serve_file(self, path: str, head_only: bool = False) -> None:
        if path in ("", "/"):
            path = "/index.html"
        stored = next(
            (
                (directory, prefix)
                for prefix, directory in (("/uploads/", APP.storage.uploads_dir), ("/grids/", APP.storage.grids_dir))
                if path.startswith(prefix)
            ),
            None,
        )
        if stored:
            root = stored[0].resolve()
            relative = path.removeprefix(stored[1])
            # Uploads are named by content hash and grids by run and hour, so they never change.
            cache_control = "public, max-age=31536000, immutable"
        else:
            root = APP.static.resolve()
            relative = path.lstrip("/")
            cache_control = "no-store"
        candidate = (root / relative).resolve()
        if not candidate.is_relative_to(root):
            self.send_error(HTTPStatus.FORBIDDEN)
            return
        if not candidate.is_file():
            self.send_error(HTTPStatus.NOT_FOUND)
            return
        content_type = mimetypes.guess_type(str(candidate))[0] or "application/octet-stream"
        raw = candidate.read_bytes()
        self.send_response(HTTPStatus.OK)
        self.send_header("Content-Type", content_type)
        self.send_header("Cache-Control", cache_control)
        self.send_header("Content-Length", str(len(raw)))
        self.end_headers()
        if not head_only:
            self.wfile.write(raw)


def main() -> None:
    parser = argparse.ArgumentParser(description="Run the Turbli GPS local web app.")
    parser.add_argument("--host", default="127.0.0.1")
    parser.add_argument("--port", type=int, default=8765)
    args = parser.parse_args()
    logging.basicConfig(level=logging.INFO, format="%(asctime)s %(levelname)s %(message)s")
    server = ThreadingHTTPServer((args.host, args.port), Handler)
    logger.info("Turbli GPS listening at http://%s:%s", args.host, args.port)
    server.serve_forever()


if __name__ == "__main__":
    main()
