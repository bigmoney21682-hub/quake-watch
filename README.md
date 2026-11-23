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
| Solar flux F10.7, GOES X-ray (flare class), running a-index | NOAA SWPC | 1 min to daily |
| Earth-signal audio (optional, e.g. EPD Laboratories ELF/VLF) | URL you paste into Settings | live |
| Earthquakes within radius of central FL | USGS FDSN event API | live |

## How the index works

Each local signal (telluric |E|, TEC anomaly, Z/H ratio) gets a robust z-score (median/MAD) against its trailing 7 days. The **precursor index** is the RMS of those z-scores. When Kp ≥ 5 or Dst ≤ −50 nT the level becomes `storm`, because the sun is driving the disturbance and it isn't a local signal. Levels: `baseline` (not enough history) → `quiet` → `watch` (≥ ⅔ threshold) → `elevated` (≥ threshold, default 3; sends a notification).

## Forecasts and scoring

Two things open a **forecast window** (default: M2.5+ within 800 km in the next 7 days):

1. The precursor index turns `elevated`, meaning the telluric, ionospheric and ULF signals have all moved off their baselines while space weather is quiet.
2. A solar/seismic coincidence: solar input is rising (an M-class flare or larger in 24 h, F10.7 ≥ 20% above its 30-day median, or Kp ≥ 5) while quakes inside the radius run at ≥ 2× their 30-day rate.

Each forecast sends a notification, is logged, and is scored automatically against USGS as a **hit** or **miss**. The Events tab compares the hit rate with the chance of a quake by luck alone, a Poisson estimate from the last 5 years of USGS counts (about 14% per 7-day window at the default settings). The method only earns trust if it beats that rate over many forecasts.

## Background alerts on iPhone (ntfy)

iOS gives Home Screen apps no background time, so a GitHub Actions workflow (`.github/workflows/collector.yml`) runs the same `js/core.js` every 15 minutes in Node (`collector/run.mjs`) and pushes each alert to an [ntfy](https://ntfy.sh) topic. History is carried between runs in the Actions cache.

1. Install the **ntfy** app on the phone and subscribe to the topic stored in the repo secret `NTFY_TOPIC`. Anyone who knows the topic name can read it, so keep it unguessable.
2. Send a test from Actions → Background alerts → Run workflow → tick *Only send a test notification*.
3. Optional: change thresholds with a repo variable `QW_SETTINGS`, e.g. `{"forecastMag":3,"radiusKm":1000}`.

GitHub turns off scheduled workflows in a public repo after 60 days without commits. Re-enable it from the Actions tab if that happens.

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
