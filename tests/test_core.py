from __future__ import annotations

import base64
import io
import tempfile
import unittest
import urllib.error
from datetime import datetime, timezone
from pathlib import Path
from unittest.mock import patch

from turbli_gps.server import (
    TurbliApp,
    compact_utc,
    file_sha256,
    next_forecast_hour,
    previous_run,
    safe_name,
    local_iso,
)
from turbli_gps.storage import JsonStore
from turbli_gps.transforms import Transform


# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------

def _fake_jpeg_response(data: bytes = b"jpeg"):
    class FakeHeaders:
        def get_content_type(self) -> str:
            return "image/jpeg"

    class FakeResponse:
        headers = FakeHeaders()

        def __enter__(self):
            return self

        def __exit__(self, *args):
            pass

        def read(self) -> bytes:
            return data

    return FakeResponse()


def _make_data_url(raw: bytes) -> str:
    return "data:image/png;base64," + base64.b64encode(raw).decode("ascii")


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

    def test_next_forecast_hour_minimum_6(self):
        run_dt = datetime(2026, 6, 2, 12, 0, tzinfo=timezone.utc)
        now = datetime(2026, 6, 2, 12, 30, tzinfo=timezone.utc)
        self.assertEqual(next_forecast_hour(now, run_dt), 6)

    def test_next_forecast_hour_rounds_up_to_3h(self):
        run_dt = datetime(2026, 6, 2, 12, 0, tzinfo=timezone.utc)
        now = datetime(2026, 6, 2, 14, 0, tzinfo=timezone.utc)
        # elapsed = 2h → rounds up to next 3h = 3, but minimum is 6
        self.assertEqual(next_forecast_hour(now, run_dt), 6)

    def test_next_forecast_hour_capped_at_48(self):
        run_dt = datetime(2026, 6, 1, 0, 0, tzinfo=timezone.utc)
        now = datetime(2026, 6, 3, 0, 0, tzinfo=timezone.utc)
        self.assertEqual(next_forecast_hour(now, run_dt), 48)

    def test_next_forecast_hour_mid_range(self):
        run_dt = datetime(2026, 6, 2, 0, 0, tzinfo=timezone.utc)
        now = datetime(2026, 6, 2, 13, 0, tzinfo=timezone.utc)
        # elapsed = 13h → ceil to next 3h multiple = 15
        self.assertEqual(next_forecast_hour(now, run_dt), 15)


# ---------------------------------------------------------------------------
# Transform tests
# ---------------------------------------------------------------------------

class TransformTests(unittest.TestCase):
    def test_transform_rotation_scale_and_drag(self) -> None:
        transform = Transform(x=10, y=20, scale=2, rotation=90)
        x, y = transform.apply(3, 0)
        self.assertAlmostEqual(x, 10)
        self.assertAlmostEqual(y, 26)
        dragged = transform.compose_drag(5, -7)
        self.assertEqual(dragged.x, 15)
        self.assertEqual(dragged.y, 13)

    def test_from_dict_defaults(self):
        t = Transform.from_dict({})
        self.assertEqual(t.x, 0.0)
        self.assertEqual(t.y, 0.0)
        self.assertEqual(t.scale, 1.0)
        self.assertEqual(t.rotation, 0.0)

    def test_from_dict_values(self):
        t = Transform.from_dict({"x": 5, "y": -3, "scale": 2.5, "rotation": 45})
        self.assertEqual(t.x, 5.0)
        self.assertEqual(t.y, -3.0)
        self.assertEqual(t.scale, 2.5)
        self.assertEqual(t.rotation, 45.0)

    def test_from_dict_clamps_negative_scale(self):
        t = Transform.from_dict({"scale": -1})
        self.assertEqual(t.scale, 0.01)

    def test_from_dict_clamps_zero_scale(self):
        t = Transform.from_dict({"scale": 0})
        self.assertEqual(t.scale, 0.01)

    def test_as_dict_roundtrip(self):
        t = Transform(x=1.5, y=-2.0, scale=3.0, rotation=90.0)
        self.assertEqual(t, Transform.from_dict(t.as_dict()))

    def test_apply_identity(self):
        t = Transform()
        self.assertAlmostEqual(t.apply(3, 4)[0], 3)
        self.assertAlmostEqual(t.apply(3, 4)[1], 4)

    def test_compose_drag_immutable(self):
        original = Transform(x=0, y=0, scale=1, rotation=0)
        dragged = original.compose_drag(10, 20)
        self.assertEqual(original.x, 0)
        self.assertEqual(dragged.x, 10)
        self.assertEqual(dragged.y, 20)


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
            source = app.upload_image({"name": "x.png", "dataUrl": encoded})
            self.assertEqual(source["fileHash"], file_sha256(raw))

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
                source = app.fetch_turbli_image({
                    "date": "20260602",
                    "run": "00",
                    "hour": "006",
                    "altitudeFeet": 33000,
                    "region": "us",
                })
            request = mocked.call_args.args[0]
            self.assertEqual(
                request.full_url,
                "https://turbli.com/databases/GTG_20260602_00/figures/CAT_006_33000_us.jpg",
            )
            self.assertEqual(source["forecastTime"], "2026-06-02T06:00:00Z")
            self.assertEqual(source["altitudeText"], "33,000 ft")
            cached = app.fetch_turbli_image({
                "date": "20260602",
                "run": "00",
                "hour": "006",
                "altitudeFeet": 33000,
                "region": "us",
            })
            self.assertTrue(cached["cacheHit"])

    def test_fetch_turbli_invalid_date(self):
        with tempfile.TemporaryDirectory() as tmp:
            app = TurbliApp(Path(tmp))
            with self.assertRaises(ValueError, msg="date must be YYYYMMDD"):
                app.fetch_turbli_image({"date": "2026-06-02", "run": "00", "hour": "006", "altitudeFeet": 33000, "region": "us"})

    def test_fetch_turbli_invalid_run(self):
        with tempfile.TemporaryDirectory() as tmp:
            app = TurbliApp(Path(tmp))
            with self.assertRaises(ValueError):
                app.fetch_turbli_image({"date": "20260602", "run": "03", "hour": "006", "altitudeFeet": 33000, "region": "us"})

    def test_fetch_turbli_invalid_hour(self):
        with tempfile.TemporaryDirectory() as tmp:
            app = TurbliApp(Path(tmp))
            with self.assertRaises(ValueError):
                app.fetch_turbli_image({"date": "20260602", "run": "00", "hour": "007", "altitudeFeet": 33000, "region": "us"})

    def test_fetch_turbli_invalid_altitude(self):
        with tempfile.TemporaryDirectory() as tmp:
            app = TurbliApp(Path(tmp))
            with self.assertRaises(ValueError):
                app.fetch_turbli_image({"date": "20260602", "run": "00", "hour": "006", "altitudeFeet": 1000, "region": "us"})

    def test_fetch_turbli_invalid_region(self):
        with tempfile.TemporaryDirectory() as tmp:
            app = TurbliApp(Path(tmp))
            with self.assertRaises(ValueError):
                app.fetch_turbli_image({"date": "20260602", "run": "00", "hour": "006", "altitudeFeet": 33000, "region": "us/eu"})

    def test_fetch_turbli_non_jpeg_content_type_raises(self):
        class FakeHeaders:
            def get_content_type(self):
                return "text/html"

        class FakeResponse:
            headers = FakeHeaders()

            def __enter__(self):
                return self

            def __exit__(self, *args):
                pass

            def read(self):
                return b"<html>"

        with tempfile.TemporaryDirectory() as tmp:
            app = TurbliApp(Path(tmp))
            with patch("urllib.request.urlopen", return_value=FakeResponse()):
                with self.assertRaises(ValueError, msg="not a JPEG"):
                    app.fetch_turbli_image({
                        "date": "20260602", "run": "00", "hour": "006",
                        "altitudeFeet": 33000, "region": "us",
                    })

    def test_fetch_turbli_http_403_raises_without_saving_remote_source(self):
        with tempfile.TemporaryDirectory() as tmp:
            app = TurbliApp(Path(tmp))
            err = urllib.error.HTTPError(url="x", code=403, msg="Forbidden", hdrs={}, fp=io.BytesIO())
            with patch("urllib.request.urlopen", side_effect=err):
                with self.assertRaisesRegex(ValueError, "HTTP 403"):
                    app.fetch_turbli_image({
                        "date": "20260602", "run": "00", "hour": "006",
                        "altitudeFeet": 33000, "region": "us",
                    })
            err.close()
            self.assertEqual(app.storage.read_sources().get("sources"), {})

    def test_has_cached_turbli_source_false_when_file_missing(self):
        with tempfile.TemporaryDirectory() as tmp:
            app = TurbliApp(Path(tmp))
            result = app.has_cached_turbli_source("20260602", "00", "006", 33000, "us")
            self.assertFalse(result)

    def test_has_cached_turbli_source_true_after_fetch(self):
        with tempfile.TemporaryDirectory() as tmp:
            app = TurbliApp(Path(tmp))
            with patch("urllib.request.urlopen", return_value=_fake_jpeg_response()):
                app.fetch_turbli_image({
                    "date": "20260602", "run": "00", "hour": "006",
                    "altitudeFeet": 33000, "region": "us",
                })
            self.assertTrue(app.has_cached_turbli_source("20260602", "00", "006", 33000, "us"))

    def test_stale_remote_turbli_source_is_not_reused_as_cache_hit(self):
        with tempfile.TemporaryDirectory() as tmp:
            app = TurbliApp(Path(tmp))
            source_id = app.turbli_source_id("20260602", "00", "006", 33000, "us")
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
                source = app.fetch_turbli_image({
                    "date": "20260602", "run": "00", "hour": "006",
                    "altitudeFeet": 33000, "region": "us",
                })
            self.assertFalse(source["cacheHit"])
            self.assertEqual(len(mocked.call_args_list), 1)
            self.assertTrue(source["url"].startswith("/uploads/"))

    def test_recent_turbli_slots_cached_slot_yielded_first(self):
        with tempfile.TemporaryDirectory() as tmp:
            app = TurbliApp(Path(tmp))
            now = datetime(2026, 6, 2, 15, 0, tzinfo=timezone.utc)
            with patch("urllib.request.urlopen", return_value=_fake_jpeg_response()):
                app.fetch_turbli_image({
                    "date": "20260602", "run": "12", "hour": "006",
                    "altitudeFeet": 33000, "region": "us",
                })
            slots = list(app.recent_turbli_slots(33000, "us", now))
            # first yielded slot should be the cached one
            self.assertEqual(slots[0], ("20260602", "12", "006"))

    def test_latest_turbli_fetch_uses_recent_available_slot(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            app = TurbliApp(Path(tmp))
            now = datetime(2026, 6, 2, 15, 32, tzinfo=timezone.utc)

            def fake_urlopen(request, *args, **kwargs):
                return _fake_jpeg_response()

            with patch("urllib.request.urlopen", side_effect=fake_urlopen) as mocked:
                source = app.fetch_turbli_image({"latest": True}, now=now)
            first_request = mocked.call_args_list[0].args[0]
            self.assertEqual(
                first_request.full_url,
                "https://turbli.com/databases/GTG_20260602_12/figures/CAT_006_33000_us.jpg",
            )
            self.assertEqual(source["forecastTime"], "2026-06-02T18:00:00Z")
            cached = app.fetch_turbli_image({"latest": True}, now=now)
            self.assertTrue(cached["cacheHit"])

    def test_latest_turbli_fetch_with_target_hour(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            app = TurbliApp(Path(tmp))
            now = datetime(2026, 6, 2, 15, 32, tzinfo=timezone.utc)
            with patch("urllib.request.urlopen", return_value=_fake_jpeg_response()) as mocked:
                source = app.fetch_turbli_image({"latest": True, "hour": "009"}, now=now)
            first_request = mocked.call_args_list[0].args[0]
            self.assertEqual(
                first_request.full_url,
                "https://turbli.com/databases/GTG_20260602_12/figures/CAT_009_33000_us.jpg",
            )

    def test_latest_turbli_fetch_raises_when_all_slots_fail(self):
        with tempfile.TemporaryDirectory() as tmp:
            app = TurbliApp(Path(tmp))
            now = datetime(2026, 6, 2, 15, 0, tzinfo=timezone.utc)
            err = urllib.error.URLError("connection refused")
            with patch("urllib.request.urlopen", side_effect=err):
                with self.assertRaises(ValueError, msg="could not fetch"):
                    app.fetch_turbli_image({"latest": True}, now=now)


if __name__ == "__main__":
    unittest.main()
