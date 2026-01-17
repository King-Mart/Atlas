function getDatasetUrl() {
  const params = new URLSearchParams(window.location.search);
  // Default is 250 flights
  return params.get("data") || "canadian_flights_1000.json";
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

    const { slider, label } = ensureControlsExist();

    const map = L.map("map", {
      renderer: L.canvas(),
      preferCanvas: true,
    }).setView([56, -96], 4);

    L.tileLayer("https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png", {
      maxZoom: 10,
    }).addTo(map);

    let skipped = 0;

    const layers = [];
    for (const f of flights) {
      let pts = null;
      try {
        pts = buildPointsForFlight(f);
      } catch (e) {
        pts = null;
      }
      if (!pts) {
        skipped++;
        continue;
      }

      const poly = L.polyline(pts, { weight: 2, opacity: 0.35 }).addTo(map);
      poly.bindTooltip(
        `${f.ACID} ${f["departure airport"]}→${f["arrival airport"]}<br>` +
        `FL${Math.round((f.altitude || 0) / 100)} @ ${(f["aircraft speed"] || 0)}kt`
      );

      const m = L.circleMarker(pts[0], { radius: 3, opacity: 0.9 }).addTo(map);
      layers.push({ f, pts, m });
    }

    console.log(`[Trajectory] Rendered: ${layers.length} flights, skipped: ${skipped}`);

    if (layers.length > 0) {
      // Fit map to data bounds for "something shows" guarantee
      const allLatLngs = layers.flatMap((o) => o.pts);
      map.fitBounds(allLatLngs, { padding: [20, 20] });
    }

    const times = layers.map((o) => o.f["departure time"]).filter((x) => Number.isFinite(x));
    const minT = Math.min(...times);
    const maxT = Math.max(...times) + 6 * 3600;

    slider.min = String(minT);
    slider.max = String(maxT);
    slider.step = "60";
    slider.value = String(minT);

    function update() {
      const t = parseInt(slider.value, 10);
      label.textContent = `UTC: ${new Date(t * 1000).toISOString()}`;

      layers.forEach((o) => {
        const p = positionAt(o.pts, o.f["departure time"], o.f["aircraft speed"], t);
        if (!p) {
          o.m.setStyle({ opacity: 0 });
        } else {
          o.m.setStyle({ opacity: 0.9 });
          o.m.setLatLng(p);
        }
      });
    }

    slider.addEventListener("input", update);
    update();
  })
  .catch((err) => {
    console.error("[Trajectory] Fatal error:", err);
    // Optional: show error on the page
    const el = document.getElementById("label");
    if (el) el.textContent = `Error: ${err.message}`;
  });
