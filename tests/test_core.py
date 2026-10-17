from __future__ import annotations

import base64
import io
import json
import tempfile
import unittest
import urllib.error
from datetime import datetime, timezone
from pathlib import Path
from unittest.mock import patch

from turbli_gps.server import (
    TurbliApp,
    TurbliFrame,
    compact_utc,
    file_sha256,
    guessed_frames,
    local_iso,
    parse_map_page,
    previous_run,
    safe_name,
)
from turbli_gps.storage import JsonStore

# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------

def _fake_jpeg_response(data: bytes = b"jpeg", content_type: str = "image/jpeg"):
    """Fake urlopen response; Turbli sends chunked bodies without Content-Length."""

    class FakeHeaders:
        def get_content_type(self) -> str:
            return content_type

        def get(self, name, default=None):
            return default

    class FakeResponse:
        headers = FakeHeaders()

        def __enter__(self):
            # The same fake may be returned by several urlopen calls.
            self.body = io.BytesIO(data)
            return self

        def __exit__(self, *args):
            pass

        def read(self, size: int = -1) -> bytes:
            return self.body.read(size)

    return FakeResponse()


def _make_data_url(raw: bytes) -> str:
    return "data:image/png;base64," + base64.b64encode(raw).decode("ascii")


def _http_error(code: int, body: bytes = b"", headers: dict | None = None) -> urllib.error.HTTPError:
    return urllib.error.HTTPError(url="x", code=code, msg="err", hdrs=headers or {}, fp=io.BytesIO(body))


DIRECT = {"date": "20260602", "run": "00", "hour": "006", "altitudeFeet": 33000, "region": "us"}


def _router(routes: dict):
    """Fake urlopen: first route whose key is in the URL wins; anything else is a JPEG."""

    def fake_urlopen(request, *args, **kwargs):
        for fragment, response in routes.items():
            if fragment in request.full_url:
                if isinstance(response, Exception):
                    raise response
                return response
        return _fake_jpeg_response()

    return fake_urlopen


DIRECT = {"date": "20260602", "run": "00", "hour": "006", "altitudeFeet": 33000, "region": "us"}
ORIGIN_403 = b"<title>Error 403 - turbli</title>"
CLOUDFLARE_403 = b"<title>Attention Required! | Cloudflare</title> error code: 1010"


def _router(routes: dict):
    """Fake urlopen: the first route whose key is in the URL answers, otherwise a JPEG.

    Route values are factories so each call gets a fresh response or exception.
    """

    def fake_urlopen(request, *args, **kwargs):
        for fragment, make in routes.items():
            if fragment in request.full_url:
                response = make()
                if isinstance(response, Exception):
                    raise response
                return response
        return _fake_jpeg_response()

    return fake_urlopen


def _flightaware_page(flight: dict | None) -> bytes:
    """A FlightAware flight page reduced to its trackpollBootstrap script."""
    flights = {"DLH490-1": flight} if flight else {"INVALID-1": {"unknown": True}}
    return f"<script>var trackpollBootstrap = {json.dumps({'flights': flights})};</script>".encode()


def _flightaware_flight(status: str, track: list | None, route: str = "SEA") -> dict:
    return {
        "ident": "DLH490",
        "iataIdent": "LH490",
        "flightStatus": status,
        "origin": {"iata": "FRA", "icao": "EDDF", "friendlyLocation": "Frankfurt", "coord": [8.57, 50.03]},
        "destination": {"iata": "SEA", "icao": "KSEA", "friendlyLocation": "Seattle, WA", "coord": [-122.31, 47.45]},
        "gateDepartureTimes": {"scheduled": 1792399500, "estimated": None, "actual": 1792140300 if track else None},
        "flightPlan": {"route": route},
        "waypoints": [[8.57, 50.03], [-30.0, 62.0], [-122.31, 47.45]],
        "track": [{"coord": coord, "alt": 350} for coord in track] if track else None,
        "activityLog": {
            "flights": [
                {"flightStatus": "", "links": {"permanent": "/live/flight/DLH490/history/20261018/0855Z/EDDF/KSEA"}},
                {"flightStatus": "arrived", "links": {"permanent": "/live/flight/DLH490/history/20261016/0855Z/EDDF/KSEA"}},
            ]
        },
    }


# Trimmed copy of the frame list on https://turbli.com/maps/us-turbulence-map/:
# the page repeats the list inside its own substring() call.
_FRAMES = "['/databases/GTG_20261013_06/figures/CAT_006', '/databases/GTG_20261013_06/figures/CAT_009']"
MAP_PAGE = f"""
<script type="text/javascript">
    var imagesPathGTG = ("{_FRAMES}").substring(1, ("{_FRAMES}").length - 1).split(",");
    var hours = ("[0, 3]").replace(/ /g,'').replace("[",'').replace("]",'').split(",");
    var altitudes_ft = ("[39000, 36000, 33000, 30000, 25000, 20000, 15000]").replace(/ /g,'');
</script>
"""


# ---------------------------------------------------------------------------
# Pure-function tests
# ---------------------------------------------------------------------------

class UtilTests(unittest.TestCase):
    def test_file_sha256_hex_digest(self):
        digest = file_sha256(b"hello")
        self.assertEqual(len(digest), 64)
        self.assertEqual(digest, file_sha256(b"hello"))
        self.assertNotEqual(digest, file_sha256(b"world"))

    def test_local_iso_returns_iso_string(self):
        result = local_iso(1770000000.0)
        self.assertIn("2026", result)
        self.assertIn("T", result)

    def test_compact_utc_replaces_offset(self):
        dt = datetime(2026, 6, 2, 12, 0, tzinfo=timezone.utc)
        self.assertEqual(compact_utc(dt), "2026-06-02T12:00:00Z")

    def test_safe_name_strips_bad_chars(self):
        self.assertEqual(safe_name("foo bar.jpg"), "foo_bar.jpg")
        self.assertEqual(safe_name(""), "upload.bin")
        self.assertEqual(safe_name("..."), "upload.bin")
        self.assertEqual(safe_name("a/b\\c"), "a_b_c")

    def test_previous_run_rounds_to_6h_boundary(self):
        now = datetime(2026, 6, 2, 15, 30, tzinfo=timezone.utc)
        run = previous_run(now)
        self.assertEqual(run.hour, 12)
        self.assertEqual(run.minute, 0)
        self.assertEqual(run.second, 0)

    def test_previous_run_at_boundary(self):
        now = datetime(2026, 6, 2, 18, 0, tzinfo=timezone.utc)
        run = previous_run(now)
        self.assertEqual(run.hour, 18)

    def test_frame_valid_time_counts_from_six_hours_before_run_label(self):
        # Turbli publishes GTG_..._06 around 04:15Z and labels its CAT_006 frame "Now".
        frame = TurbliFrame("20261013", "06", "009")
        self.assertEqual(compact_utc(frame.valid_time), "2026-10-13T09:00:00Z")
        self.assertEqual(frame.database, "GTG_20261013_06")

    def test_parse_map_page(self):
        catalog = parse_map_page(MAP_PAGE)
        self.assertEqual(
            catalog.frames,
            [TurbliFrame("20261013", "06", "006"), TurbliFrame("20261013", "06", "009")],
        )
        self.assertIn(25000, catalog.altitudes_ft)
        self.assertIsNone(parse_map_page("<html>no frames</html>"))

    def test_guessed_frames_start_with_the_next_run_label(self):
        # 05:00Z: the 06 label is usually already out and the 00 label already purged.
        now = datetime(2026, 10, 13, 5, 0, tzinfo=timezone.utc)
        self.assertEqual(
            list(guessed_frames(now, lead_hours=0)),
            [
                TurbliFrame("20261013", "06", "006"),
                TurbliFrame("20261013", "00", "009"),
                TurbliFrame("20261012", "18", "015"),
            ],
        )
        self.assertEqual(next(guessed_frames(now, lead_hours=9)).hour, "015")


# ---------------------------------------------------------------------------
# JsonStore tests
# ---------------------------------------------------------------------------

class JsonStoreTests(unittest.TestCase):
    def test_read_missing_file_returns_default(self):
        with tempfile.TemporaryDirectory() as tmp:
            store = JsonStore(Path(tmp) / "missing.json")
            self.assertEqual(store.read({"a": 1}), {"a": 1})

    def test_read_corrupted_file_returns_default(self):
        with tempfile.TemporaryDirectory() as tmp:
            path = Path(tmp) / "bad.json"
            path.write_text("not json", encoding="utf-8")
            store = JsonStore(path)
            self.assertEqual(store.read([]), [])

    def test_write_then_read(self):
        with tempfile.TemporaryDirectory() as tmp:
            store = JsonStore(Path(tmp) / "data.json")
            store.write({"key": "value", "num": 42})
            self.assertEqual(store.read({}), {"key": "value", "num": 42})

    def test_write_is_atomic(self):
        with tempfile.TemporaryDirectory() as tmp:
            store = JsonStore(Path(tmp) / "data.json")
            store.write({"v": 1})
            store.write({"v": 2})
            self.assertEqual(store.read({})["v"], 2)
            # no leftover .tmp files
            self.assertEqual(list(Path(tmp).glob("*.tmp")), [])


# ---------------------------------------------------------------------------
# Persistence / server tests
# ---------------------------------------------------------------------------

class PersistenceTests(unittest.TestCase):
    def test_upload_hash_and_alignment_bank(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            app = TurbliApp(Path(tmp))
            raw = b"fake-png-bytes"
            data_url = _make_data_url(raw)
            source = app.upload_image({"name": "example.png", "dataUrl": data_url})
            self.assertEqual(source["fileHash"], file_sha256(raw))
            self.assertTrue((Path(tmp) / "data" / "uploads" / f"{source['fileHash']}.png").exists())
            transforms = app.save_transform({
                "sourceId": source["id"],
                "family": source["family"],
                "fileHash": source["fileHash"],
                "transform": {"x": 12, "y": -4, "scale": 1.4, "rotation": 11},
            })
            self.assertEqual(transforms["uploads"][source["fileHash"]]["scale"], 1.4)
            self.assertEqual(transforms["families"]["user_upload"]["rotation"], 11)

    def test_upload_empty_data_url_raises(self):
        with tempfile.TemporaryDirectory() as tmp:
            app = TurbliApp(Path(tmp))
            with self.assertRaises(ValueError, msg="dataUrl is required"):
                app.upload_image({"name": "x.png", "dataUrl": ""})

    def test_upload_data_url_without_comma(self):
        with tempfile.TemporaryDirectory() as tmp:
            app = TurbliApp(Path(tmp))
            raw = b"fake-png-bytes"
            encoded = base64.b64encode(raw).decode("ascii")
            source = app.upload_image({"name": "x.html", "dataUrl": encoded})
            self.assertEqual(source["fileHash"], file_sha256(raw))
            # Uploads are served from our origin, so only image extensions are kept.
            self.assertTrue(source["url"].endswith(".png"))

    def test_upload_empty_body_raises(self):
        with tempfile.TemporaryDirectory() as tmp:
            app = TurbliApp(Path(tmp))
            data_url = _make_data_url(b"")  # results in empty raw after decode
            with self.assertRaises(ValueError):
                app.upload_image({"name": "x.png", "dataUrl": data_url})

    def test_save_transform_source_only(self):
        with tempfile.TemporaryDirectory() as tmp:
            app = TurbliApp(Path(tmp))
            result = app.save_transform({
                "sourceId": "test:abc",
                "transform": {"x": 1, "y": 2, "scale": 1.1, "rotation": 0},
            })
            self.assertEqual(result["sources"]["test:abc"]["x"], 1)
            self.assertEqual(result.get("families"), {})

    def test_save_transform_non_dict_raises(self):
        with tempfile.TemporaryDirectory() as tmp:
            app = TurbliApp(Path(tmp))
            with self.assertRaises(ValueError):
                app.save_transform({"sourceId": "x", "transform": "bad"})

    def test_read_state_structure(self):
        with tempfile.TemporaryDirectory() as tmp:
            app = TurbliApp(Path(tmp))
            state = app.read_state()
            self.assertIn("sources", state)
            self.assertIn("transforms", state)

    def test_direct_turbli_fetch_builds_url_and_caches_source(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            app = TurbliApp(Path(tmp))
            with patch("urllib.request.urlopen", return_value=_fake_jpeg_response()) as mocked:
                source = app.fetch_turbli_image(DIRECT)
                cached = app.fetch_turbli_image(DIRECT)
            self.assertEqual(mocked.call_count, 1)
            self.assertEqual(
                mocked.call_args.args[0].full_url,
                "https://turbli.com/databases/GTG_20260602_00/figures/CAT_006_33000_us.jpg",
            )
            self.assertEqual(source["forecastTime"], "2026-06-02T00:00:00Z")
            self.assertEqual(source["altitudeText"], "33,000 ft")
            self.assertTrue(cached["cacheHit"])
            self.assertTrue(app.has_cached_turbli_source(TurbliFrame("20260602", "00", "006"), 33000, "us"))

    def test_fetch_turbli_rejects_invalid_parameters(self):
        with tempfile.TemporaryDirectory() as tmp:
            app = TurbliApp(Path(tmp))
            for override in (
                {"date": "2026-06-02"},
                {"run": "03"},
                {"hour": "007"},
                {"altitudeFeet": 33500},
                {"region": "us/eu"},
                {"region": "asia"},
            ):
                with self.subTest(override=override), self.assertRaises(ValueError):
                    app.fetch_turbli_image({**DIRECT, **override})

    def test_fetch_turbli_failures_do_not_save_a_source(self):
        failures = {
            "not a JPEG": lambda: _fake_jpeg_response(b"<html>", "text/html"),
            "HTTP 403": lambda: _http_error(403, ORIGIN_403),
            "Cloudflare": lambda: _http_error(403, CLOUDFLARE_403),
        }
        for message, response in failures.items():
            with self.subTest(message=message), tempfile.TemporaryDirectory() as tmp:
                app = TurbliApp(Path(tmp))
                with (
                    patch("urllib.request.urlopen", side_effect=_router({"turbli.com": response})),
                    self.assertRaisesRegex(ValueError, message),
                ):
                    app.fetch_turbli_image(DIRECT)
                self.assertEqual(app.storage.read_sources().get("sources"), {})

    def test_stale_remote_turbli_source_is_not_reused_as_cache_hit(self):
        with tempfile.TemporaryDirectory() as tmp:
            app = TurbliApp(Path(tmp))
            source_id = app.turbli_source_id(TurbliFrame("20260602", "00", "006"), 33000, "us")
            app.storage.write_sources({
                "activeSourceId": source_id,
                "sources": {
                    source_id: {
                        "id": source_id,
                        "family": "turbli_direct:us",
                        "kind": "turbli_remote",
                        "name": "CAT_006_33000_us.jpg",
                        "fileHash": "remote",
                        "url": "https://turbli.com/databases/GTG_20260602_00/figures/CAT_006_33000_us.jpg",
                    },
                },
            })
            with patch("urllib.request.urlopen", return_value=_fake_jpeg_response()) as mocked:
                source = app.fetch_turbli_image(DIRECT)
            self.assertFalse(source["cacheHit"])
            self.assertEqual(mocked.call_count, 1)
            self.assertTrue(source["url"].startswith("/uploads/"))

    def test_latest_fetch_reads_current_run_from_map_page(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            app = TurbliApp(Path(tmp))
            routes = {"/maps/us-turbulence-map/": lambda: _fake_jpeg_response(MAP_PAGE.encode(), "text/html")}
            with patch("urllib.request.urlopen", side_effect=_router(routes)) as mocked:
                source = app.fetch_turbli_image({"latest": True, "altitudeFeet": 25000})
                ahead = app.fetch_turbli_image({"latest": True, "altitudeFeet": 25000, "leadHours": 3})
                cached = app.fetch_turbli_image({"latest": True, "altitudeFeet": 25000})
                with self.assertRaisesRegex(ValueError, "not published"):
                    app.fetch_turbli_image({"latest": True, "altitudeFeet": 34000})
            self.assertEqual(
                [call.args[0].full_url for call in mocked.call_args_list],
                [
                    "https://turbli.com/maps/us-turbulence-map/",
                    "https://turbli.com/databases/GTG_20261013_06/figures/CAT_006_25000_us.jpg",
                    "https://turbli.com/databases/GTG_20261013_06/figures/CAT_009_25000_us.jpg",
                ],
            )
            self.assertEqual(source["forecastTime"], "2026-10-13T06:00:00Z")
            self.assertEqual(ahead["turbli"]["hour"], "009")
            self.assertTrue(cached["cacheHit"])

    def test_latest_fetch_without_map_page_skips_unpublished_runs(self):
        with tempfile.TemporaryDirectory() as tmp:
            app = TurbliApp(Path(tmp))
            now = datetime(2026, 10, 13, 5, 0, tzinfo=timezone.utc)
            routes = {
                "/maps/": lambda: urllib.error.URLError("page down"),
                "GTG_20261013_06": lambda: _http_error(403, ORIGIN_403),
            }
            with patch("urllib.request.urlopen", side_effect=_router(routes)) as mocked:
                source = app.fetch_turbli_image({"latest": True}, now=now)
            self.assertEqual(source["id"], "turbli_direct:GTG_20261013_00:009:33000:us")
            self.assertEqual(mocked.call_count, 3)

    def test_latest_fetch_stops_at_cloudflare_block(self):
        with tempfile.TemporaryDirectory() as tmp:
            app = TurbliApp(Path(tmp))
            routes = {"turbli.com": lambda: _http_error(403, CLOUDFLARE_403)}
            with (
                patch("urllib.request.urlopen", side_effect=_router(routes)) as mocked,
                self.assertRaisesRegex(ValueError, "Cloudflare"),
            ):
                app.fetch_turbli_image({"latest": True})
            self.assertEqual(mocked.call_count, 2)


def _grid_response(lead_hours: int = 0):
    """Fake get_forecast_hour/ body: a 2 x 3 grid at two altitudes, south row first."""
    lat = [[-90.0, -90.0, -90.0], [-89.0, -89.0, -89.0]]
    lon = [[-180.0, -179.0, -178.0], [-180.0, -179.0, -178.0]]
    body = {
        "lon": lon,
        "lat": lat,
        f"cat_{lead_hours}_33000": [[0.0, 12.4, 40.0], [3.0, float("nan"), 300.0]],
        f"cat_{lead_hours}_36000": [[1.0, 1.0, 1.0], [1.0, 1.0, 1.0]],
    }
    return _fake_jpeg_response(json.dumps(body).encode(), "text/html")


class GridAndRouteTests(unittest.TestCase):
    def test_grid_fetch_stores_every_altitude_and_reuses_them(self):
        with tempfile.TemporaryDirectory() as tmp:
            app = TurbliApp(Path(tmp))
            routes = {
                "/maps/us-turbulence-map/": lambda: _fake_jpeg_response(MAP_PAGE.encode(), "text/html"),
                "get_forecast_hour": lambda: _grid_response(3),
            }
            with patch("urllib.request.urlopen", side_effect=_router(routes)) as mocked:
                source = app.fetch_turbli_grid({"altitudeFeet": 33000, "leadHours": 3})
                other_altitude = app.fetch_turbli_grid({"altitudeFeet": 36000, "leadHours": 3})
            grid_request = mocked.call_args_list[1].args[0]
            self.assertEqual(mocked.call_count, 2)
            self.assertEqual(grid_request.get_method(), "POST")
            self.assertEqual(grid_request.data, b"hour=3&file_name=009")
            self.assertEqual(source["kind"], "turbli_grid")
            self.assertEqual(source["forecastTime"], "2026-10-13T09:00:00Z")
            self.assertFalse(source["cacheHit"])
            self.assertTrue(other_altitude["cacheHit"])
            grid = json.loads((app.storage.grids_dir / Path(source["url"]).name).read_text())
            self.assertEqual(
                {key: grid[key] for key in ("lat0", "lon0", "step", "rows", "cols")},
                {"lat0": -90.0, "lon0": -180.0, "step": 1.0, "rows": 2, "cols": 3},
            )
            # EDR x 100, rounded and clamped to a byte; missing values become 0.
            self.assertEqual(list(base64.b64decode(grid["values"])), [0, 12, 40, 3, 0, 255])
            self.assertEqual(app.read_state()["sources"]["activeSourceId"], other_altitude["id"])
            # Progress reports the last download; its size becomes the next estimate.
            progress = app.read_progress()
            self.assertEqual(progress["label"], "Downloading Turbli grid")
            self.assertGreater(progress["received"], 0)
            self.assertIsNone(progress["total"])
            self.assertEqual(app.expected_sizes["Downloading Turbli grid"], progress["received"])

    def test_route_resolves_airports_and_caches_the_list(self):
        airports = (
            "Seattle#Seattle Tacoma International Airport#SEA#KSEA#47.447943#-122.310276#1000,"
            "Munich#Munich Airport, Franz Josef Strauss#MUC#EDDM#48.353802#11.7861#1000"
        )
        with tempfile.TemporaryDirectory() as tmp:
            app = TurbliApp(Path(tmp))
            routes = {"getAirports": lambda: _fake_jpeg_response(airports.encode(), "text/html")}
            with patch("urllib.request.urlopen", side_effect=_router(routes)) as mocked:
                route = app.resolve_route({"route": " sea - muc "})
                self.assertEqual(TurbliApp(Path(tmp)).resolve_route({"route": "MUC SEA"})["from"]["code"], "MUC")
                with self.assertRaisesRegex(ValueError, "XXX"):
                    app.resolve_route({"route": "SEA-XXX"})
            self.assertEqual(mocked.call_count, 1)
            self.assertEqual(route["from"], {"code": "SEA", "name": "Seattle", "lat": 47.447943, "lon": -122.310276})
            self.assertEqual(route["to"]["code"], "MUC")


    def test_flight_maps_iata_number_and_adds_previous_track_before_departure(self):
        search = {
            "data": [
                {"ident": "B-6123", "major_airline": "0", "might_be_a_tail": True},
                {"ident": "DLH490", "major_airline": "1", "might_be_a_tail": False},
            ]
        }
        upcoming = _flightaware_flight("", None)
        previous = _flightaware_flight("arrived", [[8.6, 50.0], [-20.0, 64.0], [-122.3, 47.4]])
        with tempfile.TemporaryDirectory() as tmp:
            app = TurbliApp(Path(tmp))
            routes = {
                "omnisearch": lambda: _fake_jpeg_response(json.dumps(search).encode(), "application/json"),
                "/history/20261016/": lambda: _fake_jpeg_response(_flightaware_page(previous), "text/html"),
                "/live/flight/DLH490": lambda: _fake_jpeg_response(_flightaware_page(upcoming), "text/html"),
            }
            with patch("urllib.request.urlopen", side_effect=_router(routes)) as mocked:
                flight = app.resolve_flight({"flight": " lh-490 "})
            urls = [call.args[0].full_url for call in mocked.call_args_list]
        self.assertIn("searchterm=LH490", urls[0])
        self.assertTrue(urls[1].endswith("/live/flight/DLH490"))
        self.assertIn("/history/20261016/", urls[2])
        self.assertEqual((flight["ident"], flight["iataIdent"], flight["status"]), ("DLH490", "LH490", "scheduled"))
        self.assertEqual(flight["from"], {"code": "FRA", "name": "Frankfurt", "lat": 50.03, "lon": 8.57})
        self.assertEqual(flight["to"]["code"], "SEA")
        self.assertFalse(flight["filedRoute"])
        self.assertEqual(flight["departure"], 1792399500)
        self.assertEqual(flight["previousDeparture"], 1792140300)
        self.assertEqual(sorted(flight["paths"]), ["planned", "previous"])
        self.assertEqual(flight["paths"]["previous"][1], [-20.0, 64.0])

    def test_flight_in_the_air_uses_its_own_track(self):
        airborne = _flightaware_flight("airborne", [[8.6, 50.0], [0.0, 55.0]], route="GNNRR3 ALCOA 3800N/14000W")
        with tempfile.TemporaryDirectory() as tmp:
            app = TurbliApp(Path(tmp))
            routes = {
                # A failed search falls back to the ident as typed.
                "omnisearch": lambda: _http_error(500),
                "/live/flight/DLH490": lambda: _fake_jpeg_response(_flightaware_page(airborne), "text/html"),
            }
            with patch("urllib.request.urlopen", side_effect=_router(routes)) as mocked:
                flight = app.resolve_flight({"flight": "DLH490"})
            self.assertEqual(mocked.call_count, 2)
        self.assertTrue(flight["filedRoute"])
        self.assertEqual(sorted(flight["paths"]), ["planned", "track"])

    def test_flight_rejects_bad_numbers_and_unknown_flights(self):
        with tempfile.TemporaryDirectory() as tmp:
            app = TurbliApp(Path(tmp))
            with self.assertRaisesRegex(ValueError, "like LH490"):
                app.resolve_flight({"flight": "SEA-MUC"})
            routes = {
                "omnisearch": lambda: _fake_jpeg_response(b'{"data": []}', "application/json"),
                "/live/flight/": lambda: _fake_jpeg_response(_flightaware_page(None), "text/html"),
            }
            with patch("urllib.request.urlopen", side_effect=_router(routes)):
                with self.assertRaisesRegex(ValueError, "no recent or upcoming flight XX9999"):
                    app.resolve_flight({"flight": "XX9999"})
            routes = {"flightaware": lambda: _http_error(403, b"<title>Just a moment...</title>")}
            with patch("urllib.request.urlopen", side_effect=_router(routes)):
                with self.assertRaisesRegex(ValueError, "FlightAware blocked the request"):
                    app.resolve_flight({"flight": "LH490"})


if __name__ == "__main__":
    unittest.main()
