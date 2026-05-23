# NextUp Transit — Dev Setup

## Start the local server

```bash
cd projects/transit-widget/Main
node server.js
```

Server runs on **http://localhost:8080**

## Pages

| URL | Description |
|---|---|
| http://localhost:8080/home.html | Main transit app |
| http://localhost:8080/route-config.html | Route data admin (inspect, re-fetch, edit) |

## What the server does

- Serves all static files (HTML, JS, CSS, JSON)
- API: `GET /api/routes-data` — read route data
- API: `POST /api/routes-data` — write full route data
- API: `PATCH /api/routes-data/:routeId` — update one route
- API: `GET /api/gtfs/shape/:agencyId/:routeId/:directionId` — fetch shape from GTFS (uses parsers)
- API: `POST /api/gtfs/refresh/:agencyId` — force re-download GTFS feed

## Deploy to production

The main app is fully static — no server needed. Upload these files to any static host:

```
home.html
style.css
home.js
route-detail.js
transit-api.js
transit-store.js
transit-logic.js
app-state.js
routes-data.json
stations/seattle.json
```

The route-config page and server.js are dev tools only — don't deploy them.

## Re-fetch route shapes

1. Start the server
2. Open http://localhost:8080/route-config.html
3. Click "Re-fetch All" or select a route and click "Re-fetch Selected"
4. Shapes are fetched from official GTFS feeds (KC Metro, Sound Transit) using the parser system
