from __future__ import annotations

import json
import os
import tempfile
from pathlib import Path
from typing import Any


class JsonStore:
    def __init__(self, path: Path):
        self.path = path
        self.path.parent.mkdir(parents=True, exist_ok=True)

    def read(self, default: Any) -> Any:
        try:
            with self.path.open("r", encoding="utf-8") as handle:
                return json.load(handle)
        except FileNotFoundError:
            return default
        except json.JSONDecodeError:
            return default

    def write(self, value: Any) -> None:
        self.path.parent.mkdir(parents=True, exist_ok=True)
        fd, tmp_name = tempfile.mkstemp(
            prefix=f".{self.path.name}.",
            suffix=".tmp",
            dir=str(self.path.parent),
        )
        try:
            with os.fdopen(fd, "w", encoding="utf-8") as handle:
                json.dump(value, handle, indent=2, sort_keys=True)
                handle.write("\n")
            os.replace(tmp_name, self.path)
        finally:
            if os.path.exists(tmp_name):
                os.unlink(tmp_name)


class AppStorage:
    def __init__(self, root: Path):
        self.root = root
        self.data_dir = root / "data"
        self.uploads_dir = self.data_dir / "uploads"
        self.transforms = JsonStore(self.data_dir / "transforms.json")
        self.sources = JsonStore(self.data_dir / "sources.json")
        self.uploads_dir.mkdir(parents=True, exist_ok=True)

    def read_transforms(self) -> dict[str, Any]:
        return self.transforms.read({"families": {}, "uploads": {}})

    def write_transforms(self, value: dict[str, Any]) -> None:
        value.setdefault("families", {})
        value.setdefault("uploads", {})
        self.transforms.write(value)

    def read_sources(self) -> dict[str, Any]:
        return self.sources.read({"activeSourceId": None, "sources": {}})

    def write_sources(self, value: dict[str, Any]) -> None:
        value.setdefault("sources", {})
        self.sources.write(value)
