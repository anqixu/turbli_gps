# Turbli GPS

A dependency-light local web app for aligning Turbli turbulence forecast images over a GPS-aware US state map.

## Features

- Browser GPS watch with copyable latitude/longitude, altitude, and accuracy display.
- US state outline map with Web Mercator, equirectangular, and USA Albers projections.
- Turbli image overlay with drag, scale, rotation, paste, drop, and file upload support.
- One-click cloud fetch for the latest available Turbli US CAT map at 33,000 ft.
- Local source and alignment persistence by image hash, source, and source family.
- No external packages required for the server or browser client.

## Run

```bash
python3 server.py --host 127.0.0.1 --port 8765
```

Open `http://127.0.0.1:8765`.

## Controls

- Cloud: fetches the latest available Turbli US CAT forecast at 33,000 ft.
- Compass: starts or stops browser GPS tracking.
- Reset: returns the map view to its default position.
- Image: toggles between aligning the image and moving the map view.
- Clipboard: opens image upload; pasted or dropped images also work.
- Hamburger: expands or collapses the control pane.

## Data

Runtime data is written under `data/` and is intentionally ignored by git:

- `data/uploads/` stores uploaded or fetched images.
- `data/sources.json` tracks available image sources.
- `data/transforms.json` stores overlay alignments.

The app does not need secrets or API keys. Browser geolocation is handled in the browser and is not sent to any third-party service by this app.

## Tests

```bash
python3 -m unittest discover -s tests -p 'test_*.py'
python3 -m py_compile server.py turbli_gps/*.py
node --check static/app.js
```
