# NextUp Transit — Changelog

## v6.3 (2026-06-01)

### NOW Pill Heartbeat Animation
- Redesigned NOW pill animation from smooth pulse to heartbeat style
- Goal: match the animation to the 1s live data fetch stagger interval so DOM rebuilds during initial load appear as intentional beats rather than glitches
- Iterated through multiple keyframe specs to find the right feel:
  - `0%:1 → 50%:0.3 → 100%:0.3` (15s) — too slow, looked like single pulse then dead
  - `0%:1 → 50%:0.3` (3s, ease-in-out) — smooth sine wave, too gentle/uniform
  - `0%:1 → 80%:0.2 → 100%:1` (1s) — heartbeat shape but snap-back felt unnatural
  - `0%:1 → 70%:0.8 → 100%:0.3` (1s) — very close, good beat emphasis
  - `0%:1 → 60%:0.8 → 100%:0.2` (1s) — deeper dim, more pronounced
  - **`0%:1 → 60%:0.7 → 100%:0.2` (1s, ease-in-out) — FINAL** ✓
- Final animation: bright beat at 0%, slow fade to 0.7 at 60%, drops to 0.2 at 100%, then snaps back to 1 on next cycle = the "thump"
- Duration matches the 1s stop fetch stagger — each data refresh coincides with a natural beat

### FLIP Animation — Initial Load Fix
- Cards now animate smoothly during initial boot and location switching (not just during 15s refresh)
- Moved FLIP logic directly into `renderFromCache()` — runs on every full DOM rebuild
- Records old card positions before innerHTML rebuild, animates cards to new positions
- Uses double `requestAnimationFrame` for reliable paint-before-transition
- New cards appear in place; existing cards that moved position slide smoothly (0.4s ease)

### Location Dropdown Fix
- Dropdown no longer opens empty during initial load
- Added guard: menu won't open until STATIONS is populated (boot complete)
- Calls `renderLocationMenu()` fresh on every open to ensure content is always current

### Light Rail Brand Colors at Custom Locations
- Added `COLOR_OVERRIDES` map: normalizes outdated OBA API colors → updated brand colors
- 1 Line: `#28813F` → `#3DAE2B` (Sound Transit brand green)
- 2 Line: `#007CAD` → `#00A0DF` (Sound Transit brand blue)
- Applied in both live fetch and schedule fetch paths — works for all locations

### Shuttle Route Support
- New `shuttle` classify mode for KC Metro routes with non-numeric names
- Trailhead Direct, Waterfront Shuttle, Metro Match Day Shuttle etc. now display correctly
- Badge: bus icon (Material Symbols) instead of overflowing text
- Tag: "KC Shuttle"
- Route name flows into direction/headsign text area

### "What's New" Modal — Version-Gated
- Replaced one-time `nextup_onboarded` flag with version-based `nextup_last_seen_version`
- `RELEASE_NOTES` array in JS — dynamic rendering, no static HTML
- Shows latest unread release note on boot (returning users see changelog, new users see tips)
- Future releases: add entry to array + bump `APP_VERSION`

### Bug Tracking
- Logged 8 issues to steering file, resolved 7 in this session
- Remaining: #2 — Bottom sheet drag not working on mobile (iOS Safari)

## v6.2 (2026-05-23)

### Route Data
- Fixed all route polylines using official GTFS data from KC Metro and Sound Transit
- Built GTFS parser system (`parsers/`) that maps shapes to OBA directions via stop ID matching
- Fixed Route 49: separated limited service direction, removed snow route stops
- Fixed Light Rail Lines 1 & 2: replaced bad OBA polylines with official GTFS shapes
- Fixed direction-to-shape mapping for routes with shared corridors (10, 11, 12)
- Fixed RapidRide G: split into 2 directions at 1st Ave
- Fixed 40+ reversed polylines so each direction's shape starts at its first stop
- Added all ST Express routes (510-596) and Community Transit routes to route ID map
- Fixed Swift Orange/Blue route IDs (were placeholder strings, now correct OBA IDs)

### Route Config Admin Page
- New `route-config.html` — admin page for inspecting and managing route data
- Route list with search, agency filter chips, color bars
- Map view with direction toggle (show all / direction 0 / direction 1)
- Off-route stops shown as grey dashed dots with connecting dashed line
- Re-fetch button uses GTFS parser (stop ID matching, not geographic guessing)

### Detail Panel UI
- Badge card: horizontal layout matching M3 info card style (route circle + tag + direction)
- Bottom sheet header: two lines (direction name + "Next from [stop]")
- Route line: 12px weight, tone 80 for passed, tone 40 for upcoming
- Stop dots: sit inside the line (10px dots in 14px line)
- Stop list: vertical spine with continuous background line (no gaps)
- Current stop: larger dot (18px) with white ring, bold 18px text
- Passed stops: grey dots, grey line, collapsible with indicator
- Colors adapt per route using M3 tonal palette

### Map Zoom (v2 Center Focus Grid)
- GPS + nearest stop fit in one quadrant of center 50% area
- Zoom determined by GPS-to-nearest-stop distance + 4 upcoming stops visible
- Pan to position GPS+nearest into best quadrant
- No more unnecessary zoom-outs

### Bug Fixes
- Fixed scroll accidentally triggering card tap on mobile (10px movement threshold)
- Fixed Community Transit routes showing "KC Bus" tag (now "Community Transit")
- Fixed streetcar tonal palette (was magenta, now orange matching #F47836)
- Fixed Safari/iOS "Could not load route shape" (wrong route IDs for Swift/ST Express)
- Added store version gate (v3) — forces cache clear on update
- Fixed creation modal map to respect light/dark theme

### Infrastructure
- `server.js` — Node.js dev server with API for route data management
- GTFS parser system with per-agency parsers (KC Metro, Sound Transit)
- Auto-start hook for dev server
- Format Text Figma plugin skill

---

## v5.7 (previous)
- Custom locations (add/delete/switch)
- Pin routes (long-press)
- Default home station
- Progressive rendering + FLIP animation
- Schedule-based ETAs
- Route detail panel (Phase 1-3)

---

## Issues Encountered & Solutions

| Issue | Root Cause | Solution |
|---|---|---|
| Route polylines had loops/circles | OBA returns multiple overlapping segments; OSRM car routing for fallback | Use official GTFS shapes from transit agencies |
| Light rail zigzag lines | OBA polyline follows bus-like street routing | GTFS `shapes.txt` has exact rail alignment |
| Both directions show same line | GTFS matching assigned same shape to both | Stop ID matching via `stop_times.txt` |
| Direction 0 line on Direction 1 dots | Polyline orientation reversed | Check polyline start vs first stop, reverse if needed |
| Scroll triggers card tap on mobile | `touchend` fires without checking movement | Track `touchstart` Y, ignore if moved >10px |
| CT routes show "KC Bus" | Classify function had no agency 29 check | Added `agencyId === "29"` → "Community Transit" |
| Safari "Could not load" | Route ID map had placeholder IDs | Fixed to actual OBA IDs (29_703, 40_512, etc.) |
| Old cached data persists | localStorage TransitStore not cleared | Store version gate — bump version to force clear |
