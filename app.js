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
  return params.get("data") || "canadian_flights_1000.json";
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

// Analytics / scenario state
let flightsBase = []; // raw flights loaded
let edits = {}; // ACID -> { departure_time_delta: seconds, altitude_delta_ft }
let suggestedEdits = {}; // results from optimizer (not applied until user clicks)

// UI nodes
const hotspotsDiv = document.getElementById('hotspots');
const airportLoadDiv = document.getElementById('airportLoad');
const optimizeBtn = document.getElementById('optimizeBtn');
const editsPanel = document.getElementById('editsPanel');
const clearEditsBtn = document.getElementById('clearEditsBtn');
const applyAllBtn = document.getElementById('applyAllBtn');
const suggestionPanel = document.getElementById('suggestion');
const suggestionBody = document.getElementById('suggestionBody');
const suggestionClose = document.getElementById('suggestionClose');
const suggestionHandle = document.getElementById('suggestionHandle');

let dragActive = false;
let dragStartX = 0;
let dragStartY = 0;
let panelStartX = 0;
let panelStartY = 0;

function onDragMove(e) {
  if (!dragActive || !suggestionPanel) return;
  const dx = e.clientX - dragStartX;
  const dy = e.clientY - dragStartY;
  suggestionPanel.style.left = `${panelStartX + dx}px`;
  suggestionPanel.style.top = `${panelStartY + dy}px`;
}

function onDragEnd() {
  dragActive = false;
  document.removeEventListener('mousemove', onDragMove);
  document.removeEventListener('mouseup', onDragEnd);
}

function onDragStart(e) {
  if (!suggestionPanel) return;
  const rect = suggestionPanel.getBoundingClientRect();
  panelStartX = rect.left;
  panelStartY = rect.top;
  dragStartX = e.clientX;
  dragStartY = e.clientY;
  // switch to left/top based positioning for dragging
  suggestionPanel.style.right = '';
  suggestionPanel.style.bottom = '';
  suggestionPanel.style.left = `${panelStartX}px`;
  suggestionPanel.style.top = `${panelStartY}px`;
  dragActive = true;
  document.addEventListener('mousemove', onDragMove);
  document.addEventListener('mouseup', onDragEnd);
  e.preventDefault();
}

function hideSuggestion() {
  if (suggestionPanel) suggestionPanel.style.display = 'none';
}

function showSuggestion(conflict, tUnix) {
  if (!suggestionPanel || !suggestionBody) return;
  const a = conflict.a.obj.f;
  const b = conflict.b.obj.f;
  const timeStr = new Date(tUnix * 1000).toISOString();

  suggestionBody.innerHTML = `
    <div style="font-weight:700;">${a.ACID || 'Flight A'} ↔ ${b.ACID || 'Flight B'}</div>
    <div style="font-size:12px;color:#ddd;">UTC ${timeStr}</div>
    <div style="margin-top:6px;font-size:13px;">Horizontal separation: ${conflict.h_nm.toFixed(2)} NM (limit ${HSEP_NM} NM)</div>
    <div style="font-size:13px;">Vertical separation: ${Math.round(conflict.v_ft)} ft (limit ${VSEP_FT} ft)</div>
    <div style="margin-top:6px;font-size:13px;">Altitudes: ${(a.altitude || '?')} ft vs ${(b.altitude || '?')} ft</div>
    <div style="font-size:13px;">Routes: ${(a['departure airport'] || '?')} → ${(a['arrival airport'] || '?')} | ${(b['departure airport'] || '?')} → ${(b['arrival airport'] || '?')}</div>
  `;

  suggestionPanel.style.display = 'block';
}

if (suggestionClose) suggestionClose.onclick = hideSuggestion;
if (suggestionHandle) suggestionHandle.addEventListener('mousedown', onDragStart);


// Inverse of projectKm() using the SAME lat0 as projectKm
function unprojectKm(x, y, lat0 = 56) {
  const toDeg = r => r * 180 / Math.PI;
  const lat0Rad = lat0 * Math.PI / 180;

  const lat = toDeg(y / R_KM);
  const lon = toDeg(x / (Math.cos(lat0Rad) * R_KM));
  return [lat, lon];
}

function renderEditsPanel() {
  editsPanel.innerHTML = '';
  // Suggestions
  const hSugg = document.createElement('div');
  hSugg.style.marginBottom = '6px';
  hSugg.innerHTML = `<div style="font-weight:600;">Suggested edits</div>`;
  editsPanel.appendChild(hSugg);
  if (!Object.keys(suggestedEdits).length) {
    const el = document.createElement('div'); el.className='muted'; el.textContent='No suggestions'; editsPanel.appendChild(el);
  } else {
    for (const ac of Object.keys(suggestedEdits)) {
      const s = suggestedEdits[ac];
      const el = document.createElement('div'); el.className='row';
      el.innerHTML = `<div style="font-weight:600;">${ac}</div>
        <div style="font-size:12px;color:#444;">${s.departure_time_delta ? 'Delay: ' + (s.departure_time_delta/60)+' min' : ''} ${s.altitude_delta_ft ? 'Alt: ' + s.altitude_delta_ft + ' ft' : ''}</div>`;
      const applyBtn = document.createElement('button'); applyBtn.textContent='Apply'; applyBtn.style.marginLeft='6px';
      applyBtn.onclick = () => { edits[ac] = Object.assign({}, edits[ac]||{}, s); suggestedEdits = {}; renderEditsPanel(); updateFn(); };
      el.appendChild(applyBtn);
      editsPanel.appendChild(el);
    }
  }

  // Applied edits
  const hApplied = document.createElement('div');
  hApplied.style.marginTop = '8px';
  hApplied.innerHTML = `<div style="font-weight:600;">Applied edits</div>`;
  editsPanel.appendChild(hApplied);
  if (!Object.keys(edits).length) {
    const el = document.createElement('div'); el.className='muted'; el.textContent='No applied edits'; editsPanel.appendChild(el);
  } else {
    for (const ac of Object.keys(edits)) {
      const s = edits[ac];
      const el = document.createElement('div'); el.className='row';
      el.innerHTML = `<div style="font-weight:600;">${ac}</div>
        <div style="font-size:12px;color:#444;">${s.departure_time_delta ? 'Delay: ' + (s.departure_time_delta/60)+' min' : ''} ${s.altitude_delta_ft ? 'Alt: ' + s.altitude_delta_ft + ' ft' : ''}</div>`;
      const undoBtn = document.createElement('button'); undoBtn.textContent='Undo'; undoBtn.style.marginLeft='6px';
      undoBtn.onclick = () => { delete edits[ac]; renderEditsPanel(); updateFn(); };
      el.appendChild(undoBtn);
      editsPanel.appendChild(el);
    }
  }
}

if (clearEditsBtn) clearEditsBtn.onclick = () => { edits = {}; suggestedEdits = {}; renderEditsPanel(); updateFn(); };
if (applyAllBtn) applyAllBtn.onclick = () => { edits = Object.assign({}, edits, suggestedEdits); suggestedEdits = {}; renderEditsPanel(); updateFn(); };



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

  // total distance
  let total = 0;
  for (let i = 0; i < points.length - 1; i++) total += haversineNm(points[i], points[i + 1]);

  if (dist >= total) return null; // ✅ inactive after arrival (fixes airport pileups)

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
  return null;
}

const AIRPORT_RADIUS_NM = 15;

function nearAnyAirport(latlon) {
  for (const code in AIRPORTS) {
    const a = AIRPORTS[code];
    if (haversineNm(latlon, a) <= AIRPORT_RADIUS_NM) return true;
  }
  return false;
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
    const edit = edits[o.f.ACID] || {};
    const dep = o.f["departure time"] + (edit.departure_time_delta || 0);
    const altFtDelta = edit.altitude_delta_ft || 0;

    const pLL = positionAt(
      o.ptsLL,
      dep,
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
    const altM = o.altM + altFtDelta * 0.3048;
    const pos = llToCartesian(pLL[0], pLL[1], altM);

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
      alt: Number(o.f.altitude || 0) + altFtDelta,
      pos,
    });
  }

  return snap;
}
let hotspotEntities = [];

function clearHotspots(viewer) {
  for (const e of hotspotEntities) viewer.entities.remove(e);
  hotspotEntities = [];
}

function renderHotspots(viewer, snapshot) {
  clearHotspots(viewer);

  // bin size (degrees)
  const BIN = 2.0;
  const bins = new Map();

  for (const s of snapshot) {
    const lat = s.latlon[0], lon = s.latlon[1];
    const keyLat = Math.floor(lat / BIN) * BIN;
    const keyLon = Math.floor(lon / BIN) * BIN;
    const key = `${keyLat},${keyLon}`;
    bins.set(key, (bins.get(key) || 0) + 1);
  }

  // top bins
  const top = [...bins.entries()]
    .map(([k, count]) => ({ k, count }))
    .sort((a,b) => b.count - a.count)
    .slice(0, 8);

  for (const { k, count } of top) {
    const [lat, lon] = k.split(",").map(Number);
    const height = 20000 * count; // meters (tweak)
    const pos = Cesium.Cartesian3.fromDegrees(lon + BIN/2, lat + BIN/2, height/2);

    const e = viewer.entities.add({
      position: pos,
      box: {
        dimensions: new Cesium.Cartesian3(150000, 150000, height),
        material: Cesium.Color.ORANGE.withAlpha(0.35),
        outline: true,
        outlineColor: Cesium.Color.ORANGE.withAlpha(0.8)
      },
      label: {
        text: `${count}`,
        font: "14px sans-serif",
        fillColor: Cesium.Color.WHITE,
        outlineColor: Cesium.Color.BLACK,
        outlineWidth: 3,
        style: Cesium.LabelStyle.FILL_AND_OUTLINE,
        pixelOffset: new Cesium.Cartesian2(0, -20),
        disableDepthTestDistance: Number.POSITIVE_INFINITY
      }
    });
    hotspotEntities.push(e);
  }
}
const DEMO = [
  { label: "Morning push: departures ramp up", tOffsetMin: 0, camera: { lon:-79.63, lat:43.68, h:2500000 } },
  { label: "Hotspot corridor forms (Ontario)", tOffsetMin: 35, camera: { lon:-84.0, lat:46.0, h:1800000 } },
  { label: "Loss-of-separation detected", tOffsetMin: 55, camera: { lon:-78.03, lat:45.88, h:900000 } },
  { label: "Apply fix: delay one flight +5 min", tOffsetMin: 60, action: "applyFix" },
  { label: "After: conflict resolved", tOffsetMin: 65, camera: { lon:-78.03, lat:45.88, h:900000 } },
];

let demoTimer = null;

function fly(camera) {
  viewer.camera.flyTo({
    destination: Cesium.Cartesian3.fromDegrees(camera.lon, camera.lat, camera.h),
    duration: 1.2
  });
}

function setNarration(text) {
  const el = document.getElementById("narration");
  if (el) el.textContent = text;
}

function runDemo(baseUnix) {
  let i = 0;
  clearInterval(demoTimer);
  demoTimer = setInterval(() => {
    if (i >= DEMO.length) { clearInterval(demoTimer); demoTimer = null; return; }
    const step = DEMO[i++];

    setNarration(step.label);
    const t = baseUnix + step.tOffsetMin * 60;
    slider.value = String(t);
    update();

    if (step.camera) fly(step.camera);

    if (step.action === "applyFix") {
      // simplest demo fix: shift one known flight by +5 min
      // (you can choose the first conflicted flight instead)
      const target = flightObjs.find(o => (o.f.ACID || "").includes("ACA"));
      if (target) target.f["departure time"] += 5 * 60;
    }
  }, 1800);
}


function detectConflictsAtTime(tUnix) {
  const snap = computeSnapshot(tUnix);
  renderHotspots(viewer, snap);

  const conflicts = [];
  for (let i = 0; i < snap.length; i++) {
    for (let j = i + 1; j < snap.length; j++) {
      const a = snap[i],
      b = snap[j];
      if (nearAnyAirport(a.latlon) || nearAnyAirport(b.latlon)) continue;

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
  hideSuggestion();

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
      showSuggestion(c, parseInt(slider.value, 10));
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

function refreshAnalyticsPanels(tUnix) {
  if (!window.Analytics || !flightsBase.length) return;
  // hotspots for next hour
  const tEnd = tUnix + 3600;
  const hotspots = Analytics.computeHotspots3D(flightsBase, tUnix, tEnd, { cellNm: 25, cellFt: 2000, timeBucketSec: 300, airports: AIRPORTS });

  hotspotsDiv.innerHTML = '';
  if (!hotspots.length) {
    hotspotsDiv.innerHTML = '<div class="muted">No hotspots in next hour.</div>';
  } else {
    for (const h of hotspots.slice(0,8)) {
      const el = document.createElement('div');
      el.className = 'row';
      el.innerHTML = `<div style="font-weight:600;">Score ${h.score} — ${h.traffic_count} flights</div>
        <div style="font-size:12px;color:#444;">Time: ${new Date(h.t*1000).toISOString().slice(11,16)} | Flights: ${h.flights.join(', ')}</div>`;
      el.onclick = () => {
        // zoom to approximate cell center by averaging flight positions at that time
        const t = h.t;
        const snaps = Analytics.simulatePositions(flightsBase, t, edits, AIRPORTS);
        const those = snaps.filter(s => h.flights.includes(s.f.ACID));
        if (those.length) {
          const avgLat = those.reduce((s,a)=>s+a.latlon[0],0)/those.length;
          const avgLon = those.reduce((s,a)=>s+a.latlon[1],0)/those.length;
          viewer.camera.flyTo({ destination: Cesium.Cartesian3.fromDegrees(avgLon, avgLat, 200000) });
        }
      };
      hotspotsDiv.appendChild(el);
    }
  }

  // airport load: window +/- 15min
  const apLoads = Analytics.computeAirportLoad(flightsBase, tUnix-900, tUnix+900, 900);
  airportLoadDiv.innerHTML = '';
  // compute top windows by ops
  const rows = [];
  for (const ap of Object.keys(apLoads)) {
    for (const w of apLoads[ap]) {
      rows.push({ ap, windowStart: w.windowStart, ops: w.deps + w.arrs, deps: w.deps, arrs: w.arrs });
    }
  }
  rows.sort((a,b)=>b.ops - a.ops);
  for (const r of rows.slice(0,6)) {
    const el = document.createElement('div');
    el.className = 'row';
    el.innerHTML = `<div style="font-weight:600;">${r.ap} — ${r.ops} ops</div>
      <div style="font-size:12px;color:#444;">Deps: ${r.deps} | Arrs: ${r.arrs} | ${new Date(r.windowStart*1000).toISOString().slice(11,16)}</div>`;
    el.onclick = () => {
      const coords = AIRPORTS[r.ap];
      if (coords) viewer.camera.flyTo({ destination: Cesium.Cartesian3.fromDegrees(coords[1], coords[0], 150000) });
    };
    airportLoadDiv.appendChild(el);
  }
}

function update() {
  const t = parseInt(slider.value, 10);
  label.textContent = `UTC: ${new Date(t * 1000).toISOString()}`;

  const conflicts = detectConflictsAtTime(t);
  renderConflicts(conflicts);

  applyToggles();

  // refresh analytics panels
  refreshAnalyticsPanels(t);
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
    flightsBase = flights;
    renderFlights(flights);
    setTimeBoundsFromFlights(flights);

    slider.addEventListener("input", updateFn);
    updateFn();

    if (optimizeBtn) {
      optimizeBtn.onclick = async () => {
        optimizeBtn.disabled = true;
        optimizeBtn.textContent = 'Optimizing...';
        try {
          const res = await Analytics.optimizeSchedule(flightsBase, { K: 30, airports: AIRPORTS });
          edits = res.edits || {};
          // show quick summary
          hotspotsDiv.innerHTML = `<div style="font-weight:600;">Optimization complete</div>
            <div class="muted">Conflicts: ${res.baseMetrics.conflicts} → ${res.finalMetrics.conflicts}</div>
            <div class="muted">Avg delay (min): ${((res.finalMetrics.total_delay_minutes||0)/Object.keys(res.edits||{}).length||0).toFixed(2)}</div>`;
          // re-render frame
          updateFn();
        } catch (e) {
          console.error(e);
          alert('Optimization failed: ' + e.message);
        } finally {
          optimizeBtn.disabled = false;
          optimizeBtn.textContent = 'Optimize (K=30)';
        }
      };
    }
  })
  .catch((err) => {
    console.error(err);
    label.textContent = "Error: " + err.message;
  });
demoBtn.onclick = () => runDemo(parseInt(slider.min, 10));
