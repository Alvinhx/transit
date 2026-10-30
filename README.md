# NextUp Transit

Real-time transit departures for Seattle. See what's near you on a live map, pick a station, and get live ETAs, route shapes, and vehicle positions.

**[Open App →](https://alvinhx.github.io)**

---

## What's New in v7

A ground-up, map-first redesign (promoted from the former `main-next` rebuild).

### 🗺️ See what's around you
A live map of what's moving nearby, with a draggable bottom sheet of upcoming departures.

### 🔀 Nearby & Station modes
Flip between **Nearby** (what's around your location right now) and **Station** (a specific station's board) with one tap.

### 📍 Consistent times
Nearby departures are grouped by your closest stop, so the board always matches the route's detail page.

### 📌 Pin your routes
Long-press any card to pin it to the top.

---

## Features

- **Live ETAs** — real-time departures from OneBusAway, refreshed every 20s
- **Nearby mode** — a map of the stops around you with grouped, distance-sorted departures
- **Station mode** — a fixed station board; pick any station (selecting it sets it as your default)
- **Route detail** — route shape, all stops, live vehicle positions, and your location on the map
- **Pin routes** — long-press to keep your most-used routes at the top
- **Custom locations** — add any transit stop by GPS
- **Schedule fallback** — shows scheduled times when live data isn't available, and caches a full day so the board loads instantly
- **Dark / Light / Auto theme** — follows your system preference

## Supported transit

| Agency | Modes |
|---|---|
| King County Metro | Bus, RapidRide |
| Sound Transit | Link Light Rail (1 & 2 Line), ST Express |
| Community Transit | Local bus, Swift BRT |
| Seattle Streetcar | First Hill, South Lake Union |

## Stations

- Capitol Hill
- Lynnwood City Center
- Denny & Westlake
- + custom locations via GPS

---

## Running locally

v7 is a **static app** — it talks to the OneBusAway API directly from the browser, so the server only serves files (no backend/API).

```bash
cd projects/live-transit/prod/Main
node server.js            # serves http://localhost:8080  (pass a port arg to override)
```

Then open http://localhost:8080.

### Map tiles

The basemap uses [CARTO Basemaps](https://carto.com/basemaps), which require a free API key. The key is set in `lib/app-state.js` (`CARTO_KEY`) and appended to the tile URL. If the map shows an "API KEY REQUIRED" watermark, the key is missing or invalid — request a new one at [carto.com/basemaps/apikey](https://carto.com/basemaps/apikey/).

---

## Refreshing route data

Route shapes and stops are pre-generated into `routes-data.json` (loaded at boot). Regenerate it whenever routes change (e.g. a seasonal service change):

```bash
cd projects/live-transit/prod/Main
node scripts/build-routes-data.js        # OBA + OSRM → routes-data.json (~5–10 min)
```

The script is standalone (no server needed) and writes `routes-data.json` in place.

> **Note:** the older interactive route-config editor and its GTFS parsers are **not** part of v7 (which is static). They live in the retired v6 app at `../Main-v6/` (`route-config.html` + `/api` server + `parsers/`) if you ever need per-route GTFS re-fetching.

## Route Explorer (debug)

A read-only browser for all route data — useful for sanity-checking shapes and stops:

```
http://localhost:8080/route-explorer.html
```

Filter by agency, search, select a route to see its shape + stops on the map and a detail breakdown. It reads the same static `routes-data.json` the app uses (view-only — no editing).

---

## Project layout

```
Main/                      ← this app (v7)
├── index.html             — entry; boots the app shell
├── server.js              — static dev server (port 8080)
├── base.css, main-next.css— styles
├── routes-data.json       — pre-generated route shapes + stops
├── stations/seattle.json  — station catalogue + OBA base/key
├── lib/                   — data layer + UI atoms (app-state, transit-*, stop-feed, ui/)
├── pages/                 — home, station, detail, alerts, station-picker, app shell
├── templates/             — map+sheet, list page, mode toggle
├── scripts/               — build-routes-data.js (data regenerator)
└── route-explorer.html    — read-only route-data browser

Main-v6/                   ← retired v6 app (list-based UI + GTFS toolchain), kept for data regen
```
