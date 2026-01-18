// === uOttawaHack8 Trajectory Insight (3D MVP) ===
// Notes:
// - Uses CesiumJS to render synthetic planned flights.
// - Shows ONLY active flights at current time (planes + optional routes/labels).
// - Detects loss-of-separation at each timestep using: H<5NM AND V<2000ft.
// - Autoplay drives the time slider.

Cesium.Ion.defaultAccessToken = "YOUR_CESIUM_ION_TOKEN_HERE"; // optional for some imagery sources

// ---------- UI ----------
const toggleRoutes = document.getElementById("toggleRoutes");
const toggleLabels = document.getElementById("toggleLabels");
const slider = document.getElementById("time");
const labelEl = document.getElementById("label");
const playBtn = document.getElementById("playBtn");
const conflictsDiv = document.getElementById("conflicts");
const conflictCountEl = document.getElementById("conflictCount");
const datasetEl = document.getElementById("dataset");

// ---------- Data source ----------
function getDatasetUrl() {
  const params = new URLSearchParams(window.location.search);
  return params.get("data") || "canadian_flights_50.json";
}
const DATA_URL = getDatasetUrl();
datasetEl.textContent = DATA_URL;

// ---------- Cesium viewer ----------
const viewer = new Cesium.Viewer("cesiumContainer", {
  animation: true,
  timeline: true,
  baseLayerPicker: true,
  geocoder: true,
  homeButton: true,
  sceneModePicker: true,
  navigationHelpButton: true,
  infoBox: false,
  selectionIndicator: false,
});
viewer.scene.globe.enableLighting = false;

// Initial camera view: Canada-ish
viewer.camera.setView({
  destination: Cesium.Cartesian3.fromDegrees(-96, 56, 3_500_000)
});

// ---------- Reference data ----------
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

// ---------- Helpers ----------
function parseCoord(s) {
  // "49.97N" or "110.935W"
  const dir = s.slice(-1).toUpperCase();
  const val = parseFloat(s.slice(0, -1));
  const sign = (dir === "S" || dir === "W") ? -1 : 1;
  return sign * val;
}

function parseRoute(routeStr) {
  if (!routeStr || !routeStr.trim()) return [];
  return routeStr.trim().split(/\s+/).map(tok => {
    const [a, b] = tok.split("/");
    return [parseCoord(a), parseCoord(b)]; // [lat, lon]
  });
}

function haversineNm(aLL, bLL) {
  const toRad = d => d * Math.PI / 180;
  const R_km = 6371;
  const [lat1, lon1] = aLL, [lat2, lon2] = bLL;
  const dLat = toRad(lat2 - lat1);
  const dLon = toRad(lon2 - lon1);
  const s1 = toRad(lat1), s2 = toRad(lat2);
  const h = Math.sin(dLat/2)**2 + Math.cos(s1)*Math.cos(s2)*Math.sin(dLon/2)**2;
  const c = 2 * Math.asin(Math.min(1, Math.sqrt(h)));
  return (R_km * c) * 0.5399568; // km->nm
}

function geodesicInterpolateLL(aLL, bLL, frac) {
  // returns [lat, lon]
  const start = Cesium.Cartographic.fromDegrees(aLL[1], aLL[0]);
  const end   = Cesium.Cartographic.fromDegrees(bLL[1], bLL[0]);
  const g = new Cesium.EllipsoidGeodesic(start, end);
  const c = g.interpolateUsingFraction(frac, new Cesium.Cartographic());
  return [Cesium.Math.toDegrees(c.latitude), Cesium.Math.toDegrees(c.longitude)];
}

function llToCartesian(lat, lon, altMeters) {
  return Cesium.Cartesian3.fromDegrees(lon, lat, altMeters);
}

function altitudeMetersFor(f) {
  const ft = Number(f.altitude || 0);
  return ft * 0.3048;
}

function buildPointsForFlight(f) {
  const dep = AIRPORTS[f["departure airport"]];
  const arr = AIRPORTS[f["arrival airport"]];
  if (!dep || !arr) return null;
  const mid = parseRoute(f.route);
  return [dep, ...mid, arr]; // array of [lat, lon]
}

function totalRouteNm(pointsLL) {
  let total = 0;
  for (let i = 0; i < pointsLL.length - 1; i++) total += haversineNm(pointsLL[i], pointsLL[i + 1]);
  return total;
}

// Returns [lat, lon] if active at tUnix, else null.
// Uses constant speed and piecewise legs.
function positionAt(pointsLL, depUnix, speedKnots, tUnix) {
  const elapsed = tUnix - depUnix;
  if (elapsed < 0) return null;

  let distNm = elapsed * (speedKnots / 3600); // nm traveled

  const totalNm = totalRouteNm(pointsLL);
  if (distNm >= totalNm) return null; // inactive after arrival

  for (let i = 0; i < pointsLL.length - 1; i++) {
    const legNm = haversineNm(pointsLL[i], pointsLL[i + 1]);
    if (legNm <= 0) continue;
    if (distNm <= legNm) {
      const f = distNm / legNm;
      return geodesicInterpolateLL(pointsLL[i], pointsLL[i + 1], f);
    }
    distNm -= legNm;
  }
  return null;
}

// ---------- Rendering state ----------
const HSEP_NM = 5;
const VSEP_FT = 2000;

let flightObjs = []; // each: {f, ptsLL, altM, routeEntity, planeOutline, planeTop}
let conflictLineEntities = [];
let latestConflicts = [];

function clearConflictLines() {
  for (const e of conflictLineEntities) viewer.entities.remove(e);
  conflictLineEntities = [];
}

// Main toggles application (called from update)
function applyToggles() {
  const routesOn = !toggleRoutes || toggleRoutes.checked;
  const labelsOn = !!toggleLabels && toggleLabels.checked;

  const camHeight = viewer.camera.positionCartographic.height;
  const allowLabels = camHeight < 1_200_000; // hide labels when zoomed far out

  for (const o of flightObjs) {
    const active = o.planeTop.show;
    o.routeEntity.show = routesOn && active;
    o.planeTop.label.show = labelsOn && active && allowLabels;
  }
}

if (toggleRoutes) toggleRoutes.addEventListener("change", () => applyToggles());
if (toggleLabels) toggleLabels.addEventListener("change", () => applyToggles());
viewer.camera.changed.addEventListener(() => applyToggles());

// Build entities
function renderFlights(flights) {
  flightObjs = [];
  let rendered = 0, skipped = 0;

  for (const f of flights) {
    const ptsLL = buildPointsForFlight(f);
    if (!ptsLL || ptsLL.length < 2) { skipped++; continue; }

    const altM = altitudeMetersFor(f);
    const positions = ptsLL.map(([lat, lon]) => llToCartesian(lat, lon, altM));

    const routeEntity = viewer.entities.add({
      show: false,
      polyline: {
        positions,
        width: 2,
        material: Cesium.Color.CYAN.withAlpha(0.12),
        arcType: Cesium.ArcType.GEODESIC
      }
    });

    // outline billboard (behind)
    const planeOutline = viewer.entities.add({
      show: false,
      position: positions[0],
      billboard: {
        image: "plane.png",
        width: 34,
        height: 34,
        color: Cesium.Color.BLACK.withAlpha(0.60),
        disableDepthTestDistance: Number.POSITIVE_INFINITY,
        horizontalOrigin: Cesium.HorizontalOrigin.CENTER,
        verticalOrigin: Cesium.VerticalOrigin.CENTER
      }
    });

    // top billboard (actual plane)
    const planeTop = viewer.entities.add({
      show: false,
      position: positions[0],
      billboard: {
        image: "plane.png",
        width: 24,
        height: 24,
        color: Cesium.Color.YELLOW,
        disableDepthTestDistance: Number.POSITIVE_INFINITY,
        horizontalOrigin: Cesium.HorizontalOrigin.CENTER,
        verticalOrigin: Cesium.VerticalOrigin.CENTER
      },
      label: {
        text: f.ACID || "",
        font: "12px sans-serif",
        pixelOffset: new Cesium.Cartesian2(14, -14),
        fillColor: Cesium.Color.WHITE,
        outlineColor: Cesium.Color.BLACK,
        outlineWidth: 4,
        style: Cesium.LabelStyle.FILL_AND_OUTLINE,
        show: false,
        disableDepthTestDistance: Number.POSITIVE_INFINITY
      }
    });

    flightObjs.push({ f, ptsLL, altM, routeEntity, planeOutline, planeTop });
    rendered++;
  }

  console.log("[3D] Rendered:", rendered, "skipped:", skipped);

  viewer.camera.flyTo({
    destination: Cesium.Cartesian3.fromDegrees(-96, 56, 2_500_000.0)
  });
}

function computeSnapshot(tUnix) {
  const snap = [];

  for (const o of flightObjs) {
    const pLL = positionAt(o.ptsLL, o.f["departure time"], o.f["aircraft speed"], tUnix);

    if (!pLL) {
      // inactive -> hide
      o.planeOutline.show = false;
      o.planeTop.show = false;
      o.routeEntity.show = false;
      continue;
    }

    // active -> show and update
    const cart = llToCartesian(pLL[0], pLL[1], o.altM);
    o.planeOutline.show = true;
    o.planeTop.show = true;
    o.planeOutline.position = cart;
    o.planeTop.position = cart;

    // baseline style (may be overridden by conflict highlight)
    o.planeTop.billboard.color = Cesium.Color.YELLOW;
    o.planeOutline.billboard.color = Cesium.Color.BLACK.withAlpha(0.60);

    snap.push({
      obj: o,
      latlon: pLL,
      alt_ft: Number(o.f.altitude || 0),
      pos: cart
    });
  }

  applyToggles();
  return snap;
}

function detectConflictsAtTime(tUnix) {
  const snap = computeSnapshot(tUnix);
  const conflicts = [];

  // O(n^2) is fine for a few hundred flights; if you go 1000+ you can grid-bucket later.
  for (let i = 0; i < snap.length; i++) {
    for (let j = i + 1; j < snap.length; j++) {
      const a = snap[i], b = snap[j];
      const h = haversineNm(a.latlon, b.latlon);
      if (h >= HSEP_NM) continue;
      const v = Math.abs(a.alt_ft - b.alt_ft);
      if (v >= VSEP_FT) continue;
      conflicts.push({ a, b, h_nm: h, v_ft: v });
    }
  }

  return conflicts;
}

function renderConflicts(conflicts) {
  latestConflicts = conflicts;
  clearConflictLines();

  conflictsDiv.innerHTML = "";
  conflictCountEl.textContent = String(conflicts.length);

  if (!conflicts.length) {
    conflictsDiv.innerHTML = `<div class="muted" style="margin-top:8px;">No loss-of-separation at this time.</div>`;
    return;
  }

  // Highlight involved aircraft + draw connecting lines
  for (const c of conflicts) {
    c.a.obj.planeTop.billboard.color = Cesium.Color.RED;
    c.b.obj.planeTop.billboard.color = Cesium.Color.RED;

    const line = viewer.entities.add({
      polyline: {
        positions: [c.a.pos, c.b.pos],
        width: 2,
        material: Cesium.Color.RED.withAlpha(0.55),
        arcType: Cesium.ArcType.GEODESIC
      }
    });
    conflictLineEntities.push(line);

    const el = document.createElement("div");
    el.className = "row";
    el.innerHTML = `
      <div style="font-weight:600;">${c.a.obj.f.ACID} vs ${c.b.obj.f.ACID}</div>
      <div>H: ${c.h_nm.toFixed(2)} NM | V: ${Math.round(c.v_ft)} ft</div>
    `;
    el.onclick = () => {
      // fly camera near midpoint
      const mid = Cesium.Cartesian3.midpoint(c.a.pos, c.b.pos, new Cesium.Cartesian3());
      viewer.camera.flyTo({
        destination: Cesium.Cartesian3.multiplyByScalar(mid, 1.15, new Cesium.Cartesian3()),
        duration: 0.8
      });
    };
    conflictsDiv.appendChild(el);
  }

  applyToggles();
}

// ---------- Time slider + autoplay ----------
let playing = false;
let timer = null;

function stopAutoplay() {
  playing = false;
  if (playBtn) playBtn.textContent = "▶ Play";
  if (timer) { clearInterval(timer); timer = null; }
}

function startAutoplay(stepSeconds = 60, intervalMs = 80) {
  if (!slider) return;
  playing = true;
  if (playBtn) playBtn.textContent = "⏸ Pause";
  if (timer) clearInterval(timer);

  timer = setInterval(() => {
    const t = parseInt(slider.value, 10);
    const next = t + stepSeconds;
    if (next > parseInt(slider.max, 10)) {
      stopAutoplay();
      return;
    }
    slider.value = String(next);
    update();
  }, intervalMs);
}

function update() {
  const t = parseInt(slider.value, 10);
  if (labelEl) labelEl.textContent = `UTC: ${new Date(t * 1000).toISOString()}`;

  const conflicts = detectConflictsAtTime(t);
  renderConflicts(conflicts);
}

// Wire UI events
if (slider) slider.addEventListener("input", () => { stopAutoplay(); update(); });

if (playBtn) {
  playBtn.addEventListener("click", () => {
    if (!playing) startAutoplay(60, 80);
    else stopAutoplay();
  });
}

// ---------- Load data ----------
fetch(DATA_URL)
  .then(r => { if (!r.ok) throw new Error("Fetch failed " + r.status); return r.json(); })
  .then(flights => {
    renderFlights(flights);

    const times = flights.map(f => f["departure time"]).filter(Number.isFinite);
    const minT = Math.min(...times);
    const maxT = Math.max(...times) + 6 * 3600;

    slider.min = String(minT);
    slider.max = String(maxT);
    slider.step = "60";
    slider.value = String(minT);

    update();
  })
  .catch(err => {
    console.error(err);
    if (labelEl) labelEl.textContent = "Error: " + err.message;
  });
