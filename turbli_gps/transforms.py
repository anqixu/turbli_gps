from __future__ import annotations

import math
from dataclasses import dataclass


@dataclass(frozen=True)
class Transform:
    x: float = 0.0
    y: float = 0.0
    scale: float = 1.0
    rotation: float = 0.0

    @classmethod
    def from_dict(cls, data: dict) -> "Transform":
        return cls(
            x=float(data.get("x", 0.0)),
            y=float(data.get("y", 0.0)),
            scale=max(0.01, float(data.get("scale", 1.0))),
            rotation=float(data.get("rotation", 0.0)),
        )

    def as_dict(self) -> dict[str, float]:
        return {
            "x": self.x,
            "y": self.y,
            "scale": self.scale,
            "rotation": self.rotation,
        }

    def apply(self, px: float, py: float) -> tuple[float, float]:
        radians = math.radians(self.rotation)
        scaled_x = px * self.scale
        scaled_y = py * self.scale
        return (
            scaled_x * math.cos(radians) - scaled_y * math.sin(radians) + self.x,
            scaled_x * math.sin(radians) + scaled_y * math.cos(radians) + self.y,
        )

    def compose_drag(self, dx: float, dy: float) -> "Transform":
        return Transform(
            x=self.x + dx,
            y=self.y + dy,
            scale=self.scale,
            rotation=self.rotation,
        )
