function getDatasetUrl() {
  const params = new URLSearchParams(window.location.search);
  // Default is 250 flights
  return params.get("data") || "canadian_flights_250.json";
}

const DATA_URL = getDatasetUrl();

// FULL airport list from the prompt (lat, lon)
const AIRPORTS = {
  CYYZ: [43.68, -79.63],
  CYVR: [49.19, -123.18],
  CYUL: [45.47, -73.74],
  CYYC: [51.11, -114.02],
  CYOW: [45.32, -75.67],
  CYWG: [49.91, -97.24],
  CYHZ: [44.88, -63.51],
  CYEG: [53.31, -113.58],
  CYQB: [46.79, -71.39],
  CYYJ: [48.65, -123.43],
  CYYT: [47.62, -52.75],
  CYXE: [52.17, -106.70],
};

function parseCoord(s) {
  // accepts "49.97N" "110.935W"
  if (!s || s.length < 2) throw new Error("Bad coord: " + s);
  const dir = s.slice(-1).toUpperCase();
  const val = parseFloat(s.slice(0, -1));
  if (Number.isNaN(val)) throw new Error("Bad coord number: " + s);
  const sign = (dir === "S" || dir === "W") ? -1 : 1;
  return sign * val;
}

function parseRoute(routeStr) {
  if (!routeStr || !routeStr.trim()) return [];
  const tokens = routeStr.trim().split(/\s+/);
  const pts = [];
  for (const tok of tokens) {
    const [a, b] = tok.split("/");
    if (!a || !b) continue; // skip bad token
    pts.push([parseCoord(a), parseCoord(b)]);
  }
  return pts;
}

// Haversine distance in nautical miles
function haversineNm(a, b) {
  const [lat1, lon1] = a;
  const [lat2, lon2] = b;
  const R_km = 6371;

  const toRad = (d) => d * Math.PI / 180;
  const dLat = toRad(lat2 - lat1);
  const dLon = toRad(lon2 - lon1);
  const s1 = toRad(lat1);
  const s2 = toRad(lat2);

  const h =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(s1) * Math.cos(s2) * Math.sin(dLon / 2) ** 2;

  const c = 2 * Math.asin(Math.min(1, Math.sqrt(h)));
  const distKm = R_km * c;
  return distKm * 0.5399568;
}

function routeDistanceNm(points) {
  let d = 0;
  for (let i = 0; i < points.length - 1; i++) {
    d += haversineNm(points[i], points[i + 1]);
  }
  return d;
}

function positionAt(points, depUnix, speedKnots, tUnix) {
  const elapsed = tUnix - depUnix;
  if (elapsed < 0) return null;

  const speedNmPerSec = speedKnots / 3600;
  let dist = elapsed * speedNmPerSec;

  for (let i = 0; i < points.length - 1; i++) {
    const leg = haversineNm(points[i], points[i + 1]);
    if (leg <= 0) continue;

    if (dist <= leg) {
      const f = dist / leg;
      return [
        points[i][0] + (points[i + 1][0] - points[i][0]) * f,
        points[i][1] + (points[i + 1][1] - points[i][1]) * f,
      ];
    }
    dist -= leg;
  }
  return points[points.length - 1];
}

function buildPointsForFlight(f) {
  const depCode = f["departure airport"];
  const arrCode = f["arrival airport"];
  const dep = AIRPORTS[depCode];
  const arr = AIRPORTS[arrCode];
  if (!dep || !arr) return null;

  const mid = parseRoute(f.route);
  // Need at least dep + arr to draw something
  return [dep, ...mid, arr];
}

function ensureControlsExist() {
  const slider = document.getElementById("time");
  const label = document.getElementById("label");
  if (!slider || !label) {
    throw new Error("Missing #time slider or #label in index.html");
  }
  return { slider, label };
}

fetch(DATA_URL)
  .then((r) => {
    if (!r.ok) throw new Error(`Failed to fetch ${DATA_URL}: HTTP ${r.status}`);
    return r.json();
  })
  .then((flights) => {
    console.log(`[Trajectory] Loaded dataset: ${DATA_URL} (${flights.length} flights)`);

const slider = document.getElementById("time");
const label = document.getElementById("label");
const conflictsDiv = document.getElementById("conflicts");
const conflictCountEl = document.getElementById("conflictCount");
const hotspotsToggle = document.getElementById("hotspotsToggle");

if (!slider || !label || !conflictsDiv || !conflictCountEl) {
  throw new Error("Missing UI elements (#time, #label, #conflicts, #conflictCount). Check index.html.");
}

const map = L.map("map", { renderer: L.canvas(), preferCanvas: true })
  .setView([56, -96], 4);

L.tileLayer("https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png", { maxZoom: 10 }).addTo(map);

// ---------- Build drawable flights ----------
let skipped = 0;
const layers = [];

for (const f of flights) {
  let pts = null;
  try {
    const dep = AIRPORTS[f["departure airport"]];
    const arr = AIRPORTS[f["arrival airport"]];
    if (!dep || !arr) throw new Error("Unknown airport");
    const mid = parseRoute(f.route);
    pts = [dep, ...mid, arr];
    if (pts.length < 2) throw new Error("Too few points");
  } catch (e) {
    skipped++;
    continue;
  }

  // route polyline (thin/transparent to handle scale)
  const poly = L.polyline(pts, { weight: 2, opacity: 0.25 }).addTo(map);
  poly.bindTooltip(
    `${f.ACID} ${f["departure airport"]}→${f["arrival airport"]}<br>` +
    `Alt ${f.altitude} ft @ ${f["aircraft speed"]} kt`
  );

  // aircraft marker
  const m = L.circleMarker(pts[0], { radius: 3, opacity: 0.9 }).addTo(map);

  // Precompute route distance and estimated arrival time (exclude arrived flights from active snapshots)
  const totalDistNm = routeDistanceNm(pts);
  const speedNmPerSec = (f["aircraft speed"] ?? 0) / 3600;
  // If speed is not positive, mark arrivalTime as departure (treat as arrived) to avoid lingering active markers
  const arrivalTime = f["departure time"] + (speedNmPerSec > 0 ? (totalDistNm / speedNmPerSec) : 0);

  layers.push({ f, pts, poly, m, totalDistNm, arrivalTime });
}

console.log(`[Trajectory] Rendered: ${layers.length} flights, skipped: ${skipped}`);

if (layers.length > 0) {
  const allLatLngs = layers.flatMap(o => o.pts);
  map.fitBounds(allLatLngs, { padding: [20, 20] });
}

// ---------- Slider bounds ----------
const times = layers.map(o => o.f["departure time"]).filter(Number.isFinite);
const minT = Math.min(...times);
const maxT = Math.max(...times) + 6 * 3600;

slider.min = String(minT);
slider.max = String(maxT);
slider.step = "60";
slider.value = String(minT);

// ---------- Conflict + hotspot layers ----------
let conflictLines = []; // Leaflet polyline objects
let hotspotRects = [];  // Leaflet rectangles

function clearConflictLines() {
  for (const l of conflictLines) map.removeLayer(l);
  conflictLines = [];
}

function clearHotspots() {
  for (const r of hotspotRects) map.removeLayer(r);
  hotspotRects = [];
}

// Horizontal separation threshold: 5 NM
const HSEP_NM = 5;
// Vertical separation threshold: 2000 ft
const VSEP_FT = 2000;

// Compute a (cheap) active flight position snapshot at time t
function computeSnapshot(tUnix) {
  const snap = [];
  for (const o of layers) {
    const depUnix = o.f["departure time"];
    if (tUnix < depUnix) continue; // not departed yet
    // Exclude flights that have arrived at their final airport to avoid flagging landed aircraft as conflicts
    if (typeof o.arrivalTime === 'number' && tUnix >= o.arrivalTime) continue;
    const p = positionAt(o.pts, depUnix, o.f["aircraft speed"], tUnix);
    if (!p) continue;
    snap.push({
      obj: o,
      latlon: p,
      alt: o.f.altitude ?? 0
    });
  }
  return snap;
}

// Build conflicts list for current time t
function detectConflictsAtTime(tUnix) {
  const snap = computeSnapshot(tUnix);

  // Reset marker styles (default)
  for (const o of layers) {
    o.m.setStyle({ opacity: 0 }); // hidden unless active
    o.m.setRadius(3);
    o.m.setStyle({ fillOpacity: 0.8, opacity: 0.9 });
  }

  // Show active aircraft markers
  for (const s of snap) {
    s.obj.m.setStyle({ opacity: 0.9 });
    s.obj.m.setLatLng(s.latlon);
  }

  const conflicts = [];
  const n = snap.length;

  // O(n^2) pairwise check — OK for ~1000 flights at a single time slice
  for (let i = 0; i < n; i++) {
    for (let j = i + 1; j < n; j++) {
      const a = snap[i], b = snap[j];
      const h = haversineNm(a.latlon, b.latlon);
      if (h >= HSEP_NM) continue;

      const v = Math.abs((a.alt ?? 0) - (b.alt ?? 0));
      if (v >= VSEP_FT) continue;

      conflicts.push({
        a: a.obj,
        b: b.obj,
        h_nm: h,
        v_ft: v
      });
    }
  }

  return { snap, conflicts };
}

// Render conflicts: red markers + red lines + right panel list
function renderConflicts(tUnix, conflicts) {
  clearConflictLines();
  conflictsDiv.innerHTML = "";

  conflictCountEl.textContent = `${conflicts.length}`;

  if (conflicts.length === 0) {
    conflictsDiv.innerHTML = `<div style="font-size:12px; color:#666;">No loss-of-separation at this time.</div>`;
    return;
  }

  // Highlight involved aircraft (red and slightly larger)
  const involved = new Set();
  for (const c of conflicts) {
    involved.add(c.a.f.ACID);
    involved.add(c.b.f.ACID);
  }

  for (const o of layers) {
    if (!o.m.options) continue;
    if (involved.has(o.f.ACID)) {
      o.m.setStyle({ color: "#c00", fillColor: "#c00", opacity: 1, fillOpacity: 0.9 });
      o.m.setRadius(5);
    } else {
      // neutral active aircraft stay small and gray-ish
      // (Leaflet default stroke is blue if you don’t set it; keep it subtle)
      o.m.setStyle({ color: "#333", fillColor: "#333" });
      o.m.setRadius(3);
    }
  }

  // Draw red lines between conflicts and list them
  for (const c of conflicts) {
    const aPos = c.a.m.getLatLng();
    const bPos = c.b.m.getLatLng();

    const line = L.polyline([aPos, bPos], { color: "#c00", weight: 2, opacity: 0.9 }).addTo(map);
    conflictLines.push(line);

    const el = document.createElement("div");
    el.style.border = "1px solid #eee";
    el.style.borderRadius = "10px";
    el.style.padding = "8px";
    el.style.cursor = "pointer";
    el.style.background = "#fff";

    const aId = c.a.f.ACID;
    const bId = c.b.f.ACID;
    el.innerHTML = `
      <div style="font-weight:600;">${aId} vs ${bId}</div>
      <div style="font-size:12px; color:#555;">
        H: ${c.h_nm.toFixed(2)} NM &nbsp;|&nbsp; V: ${Math.round(c.v_ft)} ft
      </div>
      <div style="font-size:12px; color:#777; margin-top:4px;">
        ${c.a.f["departure airport"]}→${c.a.f["arrival airport"]} &nbsp; / &nbsp;
        ${c.b.f["departure airport"]}→${c.b.f["arrival airport"]}
      </div>
    `;

    el.onclick = () => {
      // Zoom to the conflict
      const bounds = L.latLngBounds([aPos, bPos]).pad(0.5);
      map.fitBounds(bounds);
    };

    conflictsDiv.appendChild(el);
  }
}

// Hotspot grid overlay at time t (simple density)
function renderHotspots(tUnix) {
  clearHotspots();
  if (!hotspotsToggle || !hotspotsToggle.checked) return;

  const snap = computeSnapshot(tUnix);

  // grid size in degrees (tune: smaller = more detailed, heavier)
  const cell = 1.0; // 1 degree grid
  const counts = new Map();

  function keyFor(lat, lon) {
    const gx = Math.floor(lon / cell);
    const gy = Math.floor(lat / cell);
    return `${gy},${gx}`;
  }

  for (const s of snap) {
    const [lat, lon] = s.latlon;
    const k = keyFor(lat, lon);
    counts.set(k, (counts.get(k) || 0) + 1);
  }

  // draw rectangles for cells with density >= 3
  for (const [k, c] of counts.entries()) {
    if (c < 3) continue;

    const [gy, gx] = k.split(",").map(Number);
    const lat0 = gy * cell;
    const lon0 = gx * cell;
    const lat1 = lat0 + cell;
    const lon1 = lon0 + cell;

    // opacity based on density (cap)
    const op = Math.min(0.6, 0.15 + c * 0.05);

    const rect = L.rectangle([[lat0, lon0], [lat1, lon1]], {
      color: "#f80",
      weight: 1,
      opacity: 0.6,
      fillOpacity: op
    }).addTo(map);

    hotspotRects.push(rect);
  }
}

// ---------- Main update loop ----------
function update() {
  const t = parseInt(slider.value, 10);
  label.textContent = `UTC: ${new Date(t * 1000).toISOString()}`;

  const { conflicts } = detectConflictsAtTime(t);
  renderConflicts(t, conflicts);
  renderHotspots(t);
}

slider.addEventListener("input", update);
if (hotspotsToggle) hotspotsToggle.addEventListener("change", update);
update();

  })
  .catch((err) => {
    console.error("[Trajectory] Fatal error:", err);
    // Optional: show error on the page
    const el = document.getElementById("label");
    if (el) el.textContent = `Error: ${err.message}`;
  });
