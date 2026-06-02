from __future__ import annotations

import math

EARTH_RADIUS_M = 6_378_137.0
ALBERS_PHI1 = math.radians(29.5)
ALBERS_PHI2 = math.radians(45.5)
ALBERS_LAT0 = math.radians(37.5)
ALBERS_LON0 = math.radians(-96.0)


def equirectangular(lon: float, lat: float) -> tuple[float, float]:
    return lon, lat


def web_mercator(lon: float, lat: float) -> tuple[float, float]:
    clamped_lat = max(-85.05112878, min(85.05112878, lat))
    x = EARTH_RADIUS_M * math.radians(lon)
    y = EARTH_RADIUS_M * math.log(math.tan(math.pi / 4 + math.radians(clamped_lat) / 2))
    return x, y


def usa_albers(lon: float, lat: float) -> tuple[float, float]:
    phi = math.radians(lat)
    lam = math.radians(lon)
    n = 0.5 * (math.sin(ALBERS_PHI1) + math.sin(ALBERS_PHI2))
    c = math.cos(ALBERS_PHI1) ** 2 + 2 * n * math.sin(ALBERS_PHI1)
    rho = math.sqrt(max(0.0, c - 2 * n * math.sin(phi))) / n
    rho0 = math.sqrt(max(0.0, c - 2 * n * math.sin(ALBERS_LAT0))) / n
    theta = n * (lam - ALBERS_LON0)
    return rho * math.sin(theta), rho0 - rho * math.cos(theta)


def project(name: str, lon: float, lat: float) -> tuple[float, float]:
    if name == "equirectangular":
        return equirectangular(lon, lat)
    if name == "web_mercator":
        return web_mercator(lon, lat)
    if name == "usa_albers":
        return usa_albers(lon, lat)
    raise ValueError(f"unknown projection: {name}")
