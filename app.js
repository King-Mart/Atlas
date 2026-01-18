// --- UI toggles (safe even before data loads) ---
const toggleRoutes = document.getElementById("toggleRoutes");
const toggleLabels = document.getElementById("toggleLabels");
const playBtn = document.getElementById("playBtn");
const slider = document.getElementById("time");
const label = document.getElementById("label");
const conflictsDiv = document.getElementById("conflicts");
const conflictCountEl = document.getElementById("conflictCount");

// Dataset
function getDatasetUrl() {
  const params = new URLSearchParams(window.location.search);
  return params.get("data") || "canadian_flights_50.json";
}
const DATA_URL = getDatasetUrl();
const datasetEl = document.getElementById("dataset");
if (datasetEl) datasetEl.textContent = DATA_URL;

// --- Cesium setup ---
Cesium.Ion.defaultAccessToken =
  "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJqdGkiOiIyMDI2Y2IzYy03ZjUxLTQ5ZTktODJhNC05MDI0ODU1ZGNlNjQiLCJpZCI6MzgwMTg5LCJpYXQiOjE3Njg2ODMwNDJ9.F_Pm6dyTK-icbqdsz7e9IiO2oHVOftbWVtp3D4AZnM0";

// Use Ion world imagery (stable + pretty). If it fails for some reason, swap to OSM.
const viewer = new Cesium.Viewer("cesiumContainer", {
  animation: true,
  timeline: true,
  baseLayerPicker: true,
  imageryProvider: new Cesium.IonImageryProvider({ assetId: 2 }), // Ion World Imagery
  terrainProvider: new Cesium.EllipsoidTerrainProvider(),
  geocoder: true,
  homeButton: true,
  sceneModePicker: true,
  navigationHelpButton: true,
  infoBox: false,
  selectionIndicator: true,
});

viewer.scene.globe.show = true;
viewer.scene.skyAtmosphere.show = true;
viewer.scene.globe.enableLighting = true;

viewer.camera.setView({
  destination: Cesium.Cartesian3.fromDegrees(-96, 56, 4_000_000),
});

// --- Data from prompt ---
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
  CYXE: [52.17, -106.7],
};

const HSEP_NM = 5;
const VSEP_FT = 2000;

// Entities tracking
let flightObjs = []; // { f, ptsLL, altM, routeEntity, planeEntity, planeEntityTop }
let conflictLineEntities = [];

// --- Helpers ---
function parseCoord(s) {
  const dir = s.slice(-1).toUpperCase();
  const val = parseFloat(s.slice(0, -1));
  const sign = dir === "S" || dir === "W" ? -1 : 1;
  return sign * val;
}

function parseRoute(routeStr) {
  if (!routeStr || !routeStr.trim()) return [];
  return routeStr
    .trim()
    .split(/\s+/)
    .map((tok) => {
      const [a, b] = tok.split("/");
      return [parseCoord(a), parseCoord(b)];
    });
}

function haversineNm(a, b) {
  const toRad = (d) => (d * Math.PI) / 180;
  const R_km = 6371;
  const [lat1, lon1] = a,
    [lat2, lon2] = b;
  const dLat = toRad(lat2 - lat1);
  const dLon = toRad(lon2 - lon1);
  const s1 = toRad(lat1),
    s2 = toRad(lat2);
  const h =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(s1) * Math.cos(s2) * Math.sin(dLon / 2) ** 2;
  const c = 2 * Math.asin(Math.min(1, Math.sqrt(h)));
  return R_km * c * 0.5399568;
}

function geodesicInterpolateLL(aLL, bLL, frac) {
  const start = Cesium.Cartographic.fromDegrees(aLL[1], aLL[0]);
  const end = Cesium.Cartographic.fromDegrees(bLL[1], bLL[0]);
  const g = new Cesium.EllipsoidGeodesic(start, end);
  const c = g.interpolateUsingFraction(frac, new Cesium.Cartographic());
  return [Cesium.Math.toDegrees(c.latitude), Cesium.Math.toDegrees(c.longitude)];
}

function buildPointsForFlight(f) {
  const dep = AIRPORTS[f["departure airport"]];
  const arr = AIRPORTS[f["arrival airport"]];
  if (!dep || !arr) return null;
  const mid = parseRoute(f.route);
  return [dep, ...mid, arr]; // [lat,lon]
}

function altitudeMetersFor(f) {
  const ft = Number(f.altitude || 0);
  return ft * 0.3048;
}

function llToCartesian(lat, lon, altMeters) {
  return Cesium.Cartesian3.fromDegrees(lon, lat, altMeters);
}

// returns [lat,lon] or null if not active
function positionAt(points, depUnix, speedKnots, tUnix) {
  const elapsed = tUnix - depUnix;
  if (elapsed < 0) return null;

  let dist = elapsed * (speedKnots / 3600); // nm

  let total = 0;
  for (let i = 0; i < points.length - 1; i++) {
    total += haversineNm(points[i], points[i + 1]);
  }
  if (dist >= total) return null;

  for (let i = 0; i < points.length - 1; i++) {
    const leg = haversineNm(points[i], points[i + 1]);
    if (leg <= 0) continue;
    if (dist <= leg) {
      const f = dist / leg;
      return geodesicInterpolateLL(points[i], points[i + 1], f);
    }
    dist -= leg;
  }
  return null;
}

// --- Rendering ---
function clearConflictLines() {
  for (const e of conflictLineEntities) viewer.entities.remove(e);
  conflictLineEntities = [];
}

function applyToggles() {
  for (const o of flightObjs) {
    const active = o.planeEntity.show === true;
    if (toggleRoutes) o.routeEntity.show = toggleRoutes.checked && active;
    if (toggleLabels) o.planeEntityTop.label.show = toggleLabels.checked && active;
  }
}

if (toggleRoutes) toggleRoutes.addEventListener("change", applyToggles);
if (toggleLabels) toggleLabels.addEventListener("change", applyToggles);

function renderFlights(flights) {
  flightObjs = [];

  for (const f of flights) {
    const ptsLL = buildPointsForFlight(f);
    if (!ptsLL || ptsLL.length < 2) continue;

    const altM = altitudeMetersFor(f);
    const positions = ptsLL.map(([lat, lon]) => llToCartesian(lat, lon, altM));

    const routeEntity = viewer.entities.add({
      show: false,
      polyline: {
        positions,
        width: 2,
        material: Cesium.Color.CYAN.withAlpha(0.25),
        arcType: Cesium.ArcType.GEODESIC,
      },
    });

    // outline (bigger, dark)
    const planeEntity = viewer.entities.add({
      show: false,
      position: positions[0],
      billboard: {
        image: "plane.png",
        width: 40,
        height: 40,
        color: Cesium.Color.BLACK.withAlpha(0.7),
        disableDepthTestDistance: Number.POSITIVE_INFINITY,
      },
    });

    // top (smaller, bright)
    const planeEntityTop = viewer.entities.add({
      show: false,
      position: positions[0],
      billboard: {
        image: "plane.png",
        width: 28,
        height: 28,
        color: Cesium.Color.YELLOW,
        disableDepthTestDistance: Number.POSITIVE_INFINITY,
      },
      label: {
        text: f.ACID || "",
        font: "12px sans-serif",
        pixelOffset: new Cesium.Cartesian2(18, -18),
        fillColor: Cesium.Color.WHITE,
        outlineColor: Cesium.Color.BLACK,
        outlineWidth: 4,
        style: Cesium.LabelStyle.FILL_AND_OUTLINE,
        show: false,
        disableDepthTestDistance: Number.POSITIVE_INFINITY,
      },
    });

    flightObjs.push({ f, ptsLL, altM, routeEntity, planeEntity, planeEntityTop });
  }

  viewer.camera.flyTo({
    destination: Cesium.Cartesian3.fromDegrees(-96, 56, 2_500_000),
  });
}

function computeSnapshot(tUnix) {
  const snap = [];

  for (const o of flightObjs) {
    const pLL = positionAt(
      o.ptsLL,
      o.f["departure time"],
      o.f["aircraft speed"],
      tUnix
    );

    // inactive -> hide everything
    if (!pLL) {
      o.planeEntity.show = false;
      o.planeEntityTop.show = false;
      o.routeEntity.show = false;
      continue;
    }

    // active -> show plane(s)
    const pos = llToCartesian(pLL[0], pLL[1], o.altM);

    o.planeEntity.show = true;
    o.planeEntityTop.show = true;
    o.planeEntity.position = pos;
    o.planeEntityTop.position = pos;

    // route visibility from toggle
    if (toggleRoutes) o.routeEntity.show = toggleRoutes.checked;
    else o.routeEntity.show = true;

    // label visibility from toggle
    if (toggleLabels) o.planeEntityTop.label.show = toggleLabels.checked;
    else o.planeEntityTop.label.show = false;

    // default plane color each frame
    o.planeEntityTop.billboard.color = Cesium.Color.YELLOW;

    snap.push({
      obj: o,
      latlon: pLL,
      alt: Number(o.f.altitude || 0),
      pos,
    });
  }

  return snap;
}

function detectConflictsAtTime(tUnix) {
  const snap = computeSnapshot(tUnix);

  const conflicts = [];
  for (let i = 0; i < snap.length; i++) {
    for (let j = i + 1; j < snap.length; j++) {
      const a = snap[i],
        b = snap[j];
      const h = haversineNm(a.latlon, b.latlon);
      if (h >= HSEP_NM) continue;
      const v = Math.abs(a.alt - b.alt);
      if (v >= VSEP_FT) continue;
      conflicts.push({ a, b, h_nm: h, v_ft: v });
    }
  }

  // highlight conflicts
  for (const c of conflicts) {
    c.a.obj.planeEntityTop.billboard.color = Cesium.Color.RED;
    c.b.obj.planeEntityTop.billboard.color = Cesium.Color.RED;
    if (toggleLabels) {
      c.a.obj.planeEntityTop.label.show = true;
      c.b.obj.planeEntityTop.label.show = true;
    }
  }

  return conflicts;
}

function renderConflicts(conflicts) {
  clearConflictLines();

  conflictsDiv.innerHTML = "";
  conflictCountEl.textContent = String(conflicts.length);

  if (!conflicts.length) {
    conflictsDiv.innerHTML =
      `<div style="font-size:12px;color:#666;margin-top:8px;">No loss-of-separation at this time.</div>`;
    return;
  }

  for (const c of conflicts) {
    const line = viewer.entities.add({
      polyline: {
        positions: [c.a.pos, c.b.pos],
        material: Cesium.Color.RED.withAlpha(0.6),
        width: 2,
        arcType: Cesium.ArcType.GEODESIC,
      },
    });
    conflictLineEntities.push(line);

    const el = document.createElement("div");
    el.className = "row";
    el.innerHTML = `
      <div style="font-weight:600;">${c.a.obj.f.ACID} vs ${c.b.obj.f.ACID}</div>
      <div>H: ${c.h_nm.toFixed(2)} NM | V: ${Math.round(c.v_ft)} ft</div>
    `;
    el.onclick = () => {
      const mid = Cesium.Cartesian3.midpoint(
        c.a.pos,
        c.b.pos,
        new Cesium.Cartesian3()
      );
      viewer.camera.flyTo({
        destination: Cesium.Cartesian3.multiplyByScalar(
          mid,
          1.15,
          new Cesium.Cartesian3()
        ),
      });
    };
    conflictsDiv.appendChild(el);
  }
}

// --- Update loop ---
let updateFn = null;

function setTimeBoundsFromFlights(flights) {
  const times = flights.map((f) => f["departure time"]).filter(Number.isFinite);
  const minT = Math.min(...times);
  const maxT = Math.max(...times) + 6 * 3600;

  slider.min = String(minT);
  slider.max = String(maxT);
  slider.step = "60";
  slider.value = String(minT);
}

function update() {
  const t = parseInt(slider.value, 10);
  label.textContent = `UTC: ${new Date(t * 1000).toISOString()}`;

  const conflicts = detectConflictsAtTime(t);
  renderConflicts(conflicts);

  applyToggles();
}
updateFn = update;

// --- Autoplay ---
let playing = false;
let timer = null;

function step() {
  const t = parseInt(slider.value, 10);
  const next = t + 60;
  if (next > parseInt(slider.max, 10)) {
    playing = false;
    playBtn.textContent = "▶ Play";
    clearInterval(timer);
    timer = null;
    return;
  }
  slider.value = String(next);
  updateFn();
}

if (playBtn) {
  playBtn.onclick = () => {
    playing = !playing;
    playBtn.textContent = playing ? "⏸ Pause" : "▶ Play";
    if (playing) timer = setInterval(step, 80);
    else {
      clearInterval(timer);
      timer = null;
    }
  };
}

// --- Load data ---
fetch(DATA_URL)
  .then((r) => {
    if (!r.ok) throw new Error("Fetch failed " + r.status);
    return r.json();
  })
  .then((flights) => {
    renderFlights(flights);
    setTimeBoundsFromFlights(flights);

    slider.addEventListener("input", updateFn);
    updateFn();
  })
  .catch((err) => {
    console.error(err);
    label.textContent = "Error: " + err.message;
  });
