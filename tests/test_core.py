from __future__ import annotations

import base64
import tempfile
import unittest
from datetime import datetime, timezone
from pathlib import Path
from unittest.mock import patch

from turbli_gps.projections import project
from turbli_gps.server import TurbliApp, file_sha256
from turbli_gps.transforms import Transform


class TransformTests(unittest.TestCase):
    def test_transform_rotation_scale_and_drag(self) -> None:
        transform = Transform(x=10, y=20, scale=2, rotation=90)
        x, y = transform.apply(3, 0)
        self.assertAlmostEqual(x, 10)
        self.assertAlmostEqual(y, 26)
        dragged = transform.compose_drag(5, -7)
        self.assertEqual(dragged.x, 15)
        self.assertEqual(dragged.y, 13)


class ProjectionTests(unittest.TestCase):
    def test_projection_names_return_finite_points(self) -> None:
        for name in ("equirectangular", "web_mercator", "usa_albers"):
            x, y = project(name, -122.4194, 37.7749)
            self.assertIsInstance(x, float)
            self.assertIsInstance(y, float)

    def test_unknown_projection_raises(self) -> None:
        with self.assertRaises(ValueError):
            project("bad", 0, 0)


class PersistenceTests(unittest.TestCase):
    def test_upload_hash_and_alignment_bank(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            app = TurbliApp(Path(tmp))
            raw = b"fake-png-bytes"
            data_url = "data:image/png;base64," + base64.b64encode(raw).decode("ascii")
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

    def test_direct_turbli_fetch_builds_url_and_caches_source(self) -> None:
        class FakeHeaders:
            def get_content_type(self) -> str:
                return "image/jpeg"

        class FakeResponse:
            headers = FakeHeaders()

            def __enter__(self) -> "FakeResponse":
                return self

            def __exit__(self, *args: object) -> None:
                return None

            def read(self) -> bytes:
                return b"jpeg"

        with tempfile.TemporaryDirectory() as tmp:
            app = TurbliApp(Path(tmp))
            with patch("urllib.request.urlopen", return_value=FakeResponse()) as mocked:
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

    def test_latest_turbli_fetch_uses_recent_available_slot(self) -> None:
        class FakeHeaders:
            def get_content_type(self) -> str:
                return "image/jpeg"

        class FakeResponse:
            status = 200
            headers = FakeHeaders()

            def __enter__(self) -> "FakeResponse":
                return self

            def __exit__(self, *args: object) -> None:
                return None

            def read(self) -> bytes:
                return b"jpeg"

        with tempfile.TemporaryDirectory() as tmp:
            app = TurbliApp(Path(tmp))
            now = datetime(2026, 6, 2, 15, 32, tzinfo=timezone.utc)

            def fake_urlopen(request, *args, **kwargs):
                if request.get_method() == "HEAD":
                    return FakeResponse()
                return FakeResponse()

            with patch("urllib.request.urlopen", side_effect=fake_urlopen) as mocked:
                source = app.fetch_turbli_image({"latest": True}, now=now)
            first_request = mocked.call_args_list[0].args[0]
            self.assertEqual(
                first_request.full_url,
                "https://turbli.com/databases/GTG_20260602_12/figures/CAT_003_33000_us.jpg",
            )
            self.assertEqual(source["forecastTime"], "2026-06-02T15:00:00Z")
            cached = app.fetch_turbli_image({"latest": True}, now=now)
            self.assertTrue(cached["cacheHit"])


if __name__ == "__main__":
    unittest.main()
