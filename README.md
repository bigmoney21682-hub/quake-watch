# Quake Watch Florida

An installable PWA that logs telluric, ionospheric and geomagnetic signals over Florida, scores them against their own baselines, and alerts on anomalies and on real earthquakes nearby. It's an experimental monitor inspired by Eric Dollard's electrical view of the Earth, **not** a validated earthquake predictor.

## Data sources (all public, CORS-enabled, no API keys)

| Signal | Source | Cadence |
|---|---|---|
| Telluric / geoelectric field Ex, Ey, \|E\| (FL grid mean) | NOAA SWPC `US-Canada-1D` geoelectric model | 1 min |
| Ionospheric TEC + TEC anomaly (FL grid mean) | NOAA SWPC GloTEC | 10 min |
| Geomagnetic H, Z | USGS Geomagnetism, BSL (Stennis, MS) by default | 1 min |
| ULF Z/H polarization ratio | derived from H, Z (60-min rolling std of 1-min diffs) | 30 min |
| Kp, Dst, solar wind speed, IMF Bz | NOAA SWPC | 1 min to 3 h |
| Earthquakes within radius of central FL | USGS FDSN event API | live |

## How the index works

Each local signal (telluric |E|, TEC anomaly, Z/H ratio) gets a robust z-score (median/MAD) against its trailing 7 days. The **precursor index** is the RMS of those z-scores. When Kp ≥ 5 or Dst ≤ −50 nT the level becomes `storm`, because the sun is driving the disturbance and it isn't a local signal. Levels: `baseline` (not enough history) → `quiet` → `watch` (≥ ⅔ threshold) → `elevated` (≥ threshold, default 3; sends a notification).

## Run locally

```sh
python3 -m http.server 8765
# open http://localhost:8765
```

## Deploy

A PWA has to be served over HTTPS. Any static host works (GitHub Pages, Netlify, Cloudflare Pages). There's no build step: upload the folder as it is.

## Files

- `js/core.js`: sources, IndexedDB history, analysis. Shared by the page and the service worker.
- `js/app.js`: UI, charts (uPlot), settings, export/import.
- `sw.js`: offline shell, periodic background sync, notifications.

## Limits

- History is stored only on the device (IndexedDB). Export it from Settings to keep it or move it.
- Background collection relies on Periodic Background Sync, which only installed Chrome/Edge PWAs support. The browser chooses the cadence, often hours apart. iOS collects only while the app is open. For a continuous 24/7 log, run a small server-side collector (see next steps).
- The "telluric" series is NOAA's *modeled* geoelectric field. No real-time public electrode (telluric) station exists in Florida.
