// Transit Widget — Capitol Hill Station, Seattle
// Uses OneBusAway Puget Sound API

const OBA_BASE = "https://api.pugetsound.onebusaway.org/api/where";
const OBA_KEY = "TEST";
const REFRESH_INTERVAL = 30_000;
const MINUTES_AFTER = 60;

const STOPS = {
  rail: [
    { id: "40_99610", label: "Capitol Hill — Southbound" },
    { id: "40_99603", label: "Capitol Hill — Northbound" },
  ],
  bus: [
    { id: "1_11180", label: "Broadway E & E John St — NB" },
    { id: "1_11050", label: "Broadway E & E Thomas St — SB" },
    { id: "1_29270", label: "E John St & Broadway E — EB" },
    { id: "1_29262", label: "E John St & Broadway E — WB" },
    { id: "1_11060", label: "Broadway & E Denny Way — SB" },
  ],
  streetcar: [
    { id: "1_11175", label: "Broadway And Denny" },
  ],
};

const MODE_ICONS = {
  rail: "train",
  bus: "directions_bus",
  streetcar: "tram",
};

const MODE_LABELS = {
  rail: "Light Rail",
  bus: "Bus",
  streetcar: "Streetcar",
};

// GTFS route_type 0 covers both light rail and streetcar.
// Distinguish by agency: Sound Transit (40) = light rail, others = streetcar.
function classifyRoute(routeType, agencyId) {
  if (routeType === 0) return agencyId === "40" ? "rail" : "streetcar";
  if (routeType === 1 || routeType === 2) return "rail";
  return "bus";
}

// Fetch arrivals for a single stop
async function fetchArrivals(stopId) {
  const url = `${OBA_BASE}/arrivals-and-departures-for-stop/${stopId}.json?key=${OBA_KEY}&minutesBefore=0&minutesAfter=${MINUTES_AFTER}`;
  const res = await fetch(url);
  if (!res.ok) throw new Error(`API error ${res.status}`);
  const json = await res.json();
  const entry = json.data.entry;
  const refs = json.data.references;
  const routeMap = {};
  for (const r of refs.routes || []) routeMap[r.id] = r;

  return entry.arrivalsAndDepartures.map((a) => {
    const route = routeMap[a.routeId] || {};
    const predicted = a.predictedDepartureTime || a.predictedArrivalTime;
    const scheduled = a.scheduledDepartureTime || a.scheduledArrivalTime;
    const isLive = predicted > 0;
    const arrivalMs = isLive ? predicted : scheduled;

    let shortName = route.shortName || route.id || "?";
    // Clean up streetcar names — remove "Streetcar" since the section label covers it
    shortName = shortName.replace(/\s*Streetcar$/i, "");

    return {
      routeShort: shortName,
      routeLong: route.longName || "",
      headsign: a.tripHeadsign || route.longName || "",
      arrivalMs,
      isLive,
      routeType: route.type,
      mode: classifyRoute(route.type, route.agencyId),
      routeColor: route.color ? `#${route.color}` : null,
      routeTextColor: route.textColor ? `#${route.textColor}` : null,
      stopId,
    };
  });
}

async function fetchAll() {
  const allStopIds = [
    ...STOPS.rail, ...STOPS.bus, ...STOPS.streetcar,
  ].map((s) => s.id);

  const results = await Promise.allSettled(
    allStopIds.map((id) => fetchArrivals(id))
  );

  const departures = [];
  for (const r of results) {
    if (r.status === "fulfilled") departures.push(...r.value);
  }

  const seen = new Set();
  const unique = [];
  for (const d of departures) {
    const key = `${d.routeShort}-${d.headsign}-${d.arrivalMs}`;
    if (!seen.has(key)) {
      seen.add(key);
      unique.push(d);
    }
  }

  unique.sort((a, b) => a.arrivalMs - b.arrivalMs);
  return unique;
}

// Render helpers
function formatEta(arrivalMs) {
  const diffMs = arrivalMs - Date.now();
  const mins = Math.round(diffMs / 60_000);
  if (mins <= 0) return { text: "NOW", isNow: true };
  return { text: `${mins}`, isNow: false };
}

function getStatus(dep) {
  const eta = formatEta(dep.arrivalMs);
  if (eta.isNow) return "arriving";
  if (dep.isLive) return "live";
  return "scheduled";
}

function renderCard(dep) {
  const eta = formatEta(dep.arrivalMs);
  const modeLabel = MODE_LABELS[dep.mode] || dep.mode;

  const badgeAttr = dep.routeColor
    ? `class="route-badge" style="background:${dep.routeColor};color:${dep.routeTextColor || '#fff'}"`
    : `class="route-badge"`;

  // ETA: live icon for live, "Scheduled" text for scheduled, green NOW for arriving
  const liveIndicator = eta.isNow
    ? ""
    : dep.isLive
      ? '<span class="material-icons live-icon">rss_feed</span>'
      : '<span class="sched-label">Scheduled</span>';
  const etaNum = eta.isNow
    ? '<span class="eta-num now">NOW</span>'
    : dep.isLive
      ? `<span class="eta-num">${eta.text}</span>`
      : `<span class="eta-num sched">${eta.text}</span>`;
  const etaUnit = eta.isNow ? "" : '<span class="eta-unit">min</span>';

  return `
    <div class="dep-card">
      <div class="card-info">
        <div class="badge-row">
          <div ${badgeAttr}>${dep.routeShort}</div>
          <span class="mode-label">${modeLabel.toUpperCase()}</span>
        </div>
        <div class="dest-wrap"><div class="dest">${dep.headsign}</div></div>
      </div>
      <div class="eta-area">
        ${liveIndicator}
        ${etaNum}
        ${etaUnit}
      </div>
    </div>`;
}

function renderSection(containerId, deps) {
  const el = document.getElementById(containerId);
  if (!deps.length) {
    el.innerHTML = '<div class="no-data">No upcoming departures</div>';
    return;
  }

  const style = getComputedStyle(el);
  const padL = parseFloat(style.paddingLeft) || 16;
  const padR = parseFloat(style.paddingRight) || 16;
  const padT = parseFloat(style.paddingTop) || 4;
  const padB = parseFloat(style.paddingBottom) || 12;
  const gap = parseFloat(style.gap) || 8;

  const availW = el.clientWidth - padL - padR;
  const availH = el.clientHeight - padT - padB;
  const cardW = 280;
  const cardH = 100;

  const cols = Math.max(1, Math.floor((availW + gap) / (cardW + gap)));
  const rows = Math.max(1, Math.floor((availH + gap) / (cardH + gap)));
  const maxCards = cols * rows;

  el.innerHTML = deps.slice(0, maxCards).map(renderCard).join("");
}

function updateClock() {
  const now = new Date();
  document.getElementById("clock").textContent = now.toLocaleTimeString("en-US", {
    hour: "2-digit",
    minute: "2-digit",
    hour12: true,
  });
}

// Cache last successful data per mode
const lastData = { rail: [], bus: [], streetcar: [] };

async function update() {
  const dot = document.getElementById("updateDot");
  try {
    const deps = await fetchAll();
    const rail = deps.filter((d) => d.mode === "rail");
    const bus = deps.filter((d) => d.mode === "bus");
    const streetcar = deps.filter((d) => d.mode === "streetcar");

    // Only update cache if we got data; preserve previous otherwise
    if (rail.length) lastData.rail = rail;
    if (bus.length) lastData.bus = bus;
    if (streetcar.length) lastData.streetcar = streetcar;

    renderSection("rail-departures", lastData.rail);
    renderSection("bus-departures", lastData.bus);
    renderSection("streetcar-departures", lastData.streetcar);

    // Always show all 3 sections — never hide
    dot.classList.remove("error");
    document.getElementById("lastUpdate").textContent =
      `Updated ${new Date().toLocaleTimeString("en-US", { hour: "2-digit", minute: "2-digit", second: "2-digit" })}`;
  } catch (err) {
    console.error("Update failed:", err);
    dot.classList.add("error");
    // On error, re-render from cache so display doesn't go blank
    renderSection("rail-departures", lastData.rail);
    renderSection("bus-departures", lastData.bus);
    renderSection("streetcar-departures", lastData.streetcar);
  }
}

// Boot
updateClock();
setInterval(updateClock, 1000);
update();
setInterval(update, REFRESH_INTERVAL);

// Recalculate card count on resize
let resizeTimer;
window.addEventListener("resize", () => {
  clearTimeout(resizeTimer);
  resizeTimer = setTimeout(() => {
    renderSection("rail-departures", lastData.rail);
    renderSection("bus-departures", lastData.bus);
    renderSection("streetcar-departures", lastData.streetcar);
  }, 200);
});
