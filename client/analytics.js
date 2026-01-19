// analytics.js
// Lightweight analytics for hotspots, airport load, and a simple greedy optimizer.
// Exposes functions on window.Analytics for use by app.js.
(function () {
  const NM_TO_KM = 1.852;
  const R_km = 6371;

  function toRad(d) { return (d * Math.PI) / 180; }

  function haversineNm(a, b) {
    const toRad = (d) => (d * Math.PI) / 180;
    const [lat1, lon1] = a, [lat2, lon2] = b;
    const dLat = toRad(lat2 - lat1);
    const dLon = toRad(lon2 - lon1);
    const s1 = toRad(lat1), s2 = toRad(lat2);
    const h = Math.sin(dLat/2)**2 + Math.cos(s1)*Math.cos(s2)*Math.sin(dLon/2)**2;
    const c = 2 * Math.asin(Math.min(1, Math.sqrt(h)));
    return R_km * c * 0.5399568; // nm
  }

  // Geodesic interpolation using Cesium for better positional agreement
  function geodesicInterpolateLL(aLL, bLL, frac) {
    if (typeof Cesium === 'undefined') {
      // fallback to simple linear interp
      return [aLL[0] + (bLL[0] - aLL[0]) * frac, aLL[1] + (bLL[1] - aLL[1]) * frac];
    }
    const start = Cesium.Cartographic.fromDegrees(aLL[1], aLL[0]);
    const end = Cesium.Cartographic.fromDegrees(bLL[1], bLL[0]);
    const g = new Cesium.EllipsoidGeodesic(start, end);
    const c = g.interpolateUsingFraction(frac, new Cesium.Cartographic());
    return [Cesium.Math.toDegrees(c.latitude), Cesium.Math.toDegrees(c.longitude)];
  }

  function parseCoord(s) {
    // like '43.68N' or '79.63W'
    if (!s) return NaN;
    const dir = s.slice(-1).toUpperCase();
    const val = parseFloat(s.slice(0, -1));
    const sign = dir === 'S' || dir === 'W' ? -1 : 1;
    return sign * val;
  }

  function buildPointsForFlight(f, airports) {
    const dep = airports[f['departure airport']];
    const arr = airports[f['arrival airport']];
    if (!dep || !arr) return null;
    const mid = (f.route || '').trim()
      ? f.route.trim().split(/\s+/).map(tok => {
          const [a, b] = tok.split('/');
          return [parseCoord(a), parseCoord(b)];
        })
      : [];
    return [dep, ...mid, arr];
  }

  // Position along route at elapsed seconds, same formula as app.js (speed in knots)
  function positionAt(points, depUnix, speedKnots, tUnix) {
    const elapsed = tUnix - depUnix;
    if (elapsed < 0) return null;
    let dist = elapsed * (speedKnots / 3600); // nm
    let total = 0;
    for (let i = 0; i < points.length - 1; i++) total += haversineNm(points[i], points[i+1]);
    if (dist >= total) return null;
    for (let i = 0; i < points.length - 1; i++) {
      const leg = haversineNm(points[i], points[i+1]);
      if (leg <= 0) continue;
      if (dist <= leg) {
        const f = dist / leg;
        return geodesicInterpolateLL(points[i], points[i+1], f);
      }
      dist -= leg;
    }
    return null;
  }

  function projectKm(lat, lon) {
    // equirectangular approx centered at lat0=56
    const lat0 = 56 * Math.PI/180;
    const x = lon * Math.cos(lat0) * (Math.PI/180) * R_km;
    const y = lat * (Math.PI/180) * R_km;
    return [x, y];
  }

  // simulatePositions: returns array of { f, latlon, alt_ft, tUnix }
  function simulatePositions(flights, tUnix, edits = {}, airports) {
    const snap = [];
    for (const f of flights) {
      const pts = buildPointsForFlight(f, airports);
      if (!pts) continue;
      const edit = edits[f.ACID] || {};
      const dep = (f['departure time'] || 0) + (edit.departure_time_delta || 0);
      const alt_ft = Number(f.altitude || 0) + (edit.altitude_delta_ft || 0);
      const p = positionAt(pts, dep, f['aircraft speed'], tUnix);
      if (!p) continue;
      snap.push({ f, latlon: p, alt_ft, tUnix });
    }
    return snap;
  }

  function detectConflicts(snap, hSepNm = 5, vSepFt = 2000) {
    const conflicts = [];
    for (let i =0;i<snap.length;i++){
      for (let j=i+1;j<snap.length;j++){
        const a = snap[i], b = snap[j];
        const h = haversineNm(a.latlon, b.latlon);
        if (h >= hSepNm) continue;
        const v = Math.abs(a.alt_ft - b.alt_ft);
        if (v >= vSepFt) continue;
        conflicts.push({ a, b, h_nm: h, v_ft: v, tUnix: a.tUnix });
      }
    }
    return conflicts;
  }

  function computeAirportLoad(flights, tStart, tEnd, window=900) {
    // returns { airport: [{windowStart, deps, arrs, ops, busy}] }
    const res = {};
    const airportsSeen = new Set();
    for (const f of flights) {
      airportsSeen.add(f['departure airport']);
      airportsSeen.add(f['arrival airport']);
    }
    const airports = Array.from(airportsSeen).filter(Boolean);
    const windows = [];
    for (let wStart = tStart; wStart <= tEnd; wStart += window) windows.push(wStart);

    for (const ap of airports) res[ap] = windows.map((ws) => ({ windowStart: ws, deps: 0, arrs: 0, ops: 0 }));

    // count
    for (const f of flights) {
      const dep = f['departure time'];
      const arr = f['arrival time'] || (dep + 3600);
      for (const ap of airports) {
        for (const w of res[ap]) {
          if (dep >= w.windowStart && dep < w.windowStart + window && f['departure airport'] === ap) w.deps++;
          if (arr >= w.windowStart && arr < w.windowStart + window && f['arrival airport'] === ap) w.arrs++;
          w.ops = w.deps + w.arrs;
        }
      }
    }

    // find threshold = 95th percentile of ops across all windows
    const allOps = [];
    for (const ap of airports) for (const w of res[ap]) allOps.push(w.ops);
    allOps.sort((a,b)=>a-b);
    const idx = Math.max(0, Math.floor(allOps.length * 0.95) - 1);
    const threshold = allOps.length ? allOps[idx] : Infinity;

    for (const ap of airports) {
      for (const w of res[ap]) {
        w.busy = w.ops >= threshold && w.ops > 0;
      }
    }
    return res;
  }

  function computeHotspots3D(flights, tStart, tEnd, opts = {}) {
    // options: cellNm=25, cellFt=2000, timeBucketSec=300, airports map, edits
    const cellNm = opts.cellNm || 25;
    const cellFt = opts.cellFt || 2000;
    const timeBucketSec = opts.timeBucketSec || 300;
    const airports = opts.airports;

    const cellKm = cellNm * NM_TO_KM;
    const buckets = new Map(); // key -> { t, ix, iy, iz, snaps: [] }

    // iterate over time buckets, simulate positions (respecting edits if provided)
    for (let t = tStart; t <= tEnd; t += timeBucketSec) {
      const snaps = simulatePositions(flights, t, opts.edits || {}, airports);
      for (const s of snaps) {
        const [x, y] = projectKm(s.latlon[0], s.latlon[1]);
        const ix = Math.floor(x / cellKm);
        const iy = Math.floor(y / cellKm);
        const iz = Math.floor(s.alt_ft / cellFt);
        const key = `${t}|${ix}|${iy}|${iz}`;
        if (!buckets.has(key)) buckets.set(key, { t, ix, iy, iz, snaps: [] });
        buckets.get(key).snaps.push(s);
      }
    }

    const res = [];
    for (const [k, b] of buckets.entries()) {
      const traffic_count = b.snaps.length;
      // compute pairwise conflicts within cell using real distances
      let conflict_count = 0;
      const flightsSet = new Set();
      const flows = new Set();
      for (let i = 0; i < b.snaps.length; i++) {
        flightsSet.add(b.snaps[i].f.ACID);
        for (let j = i + 1; j < b.snaps.length; j++) {
          const a = b.snaps[i];
          const c = b.snaps[j];
          const h = haversineNm(a.latlon, c.latlon);
          const v = Math.abs(a.alt_ft - c.alt_ft);
          if (h < 5 && v < 2000) conflict_count++;
        }
        flows.add(`${b.snaps[i].f['departure airport']}->${b.snaps[i].f['arrival airport']}`);
      }
      const score = traffic_count + 3 * conflict_count;
      // confidence: fraction of time buckets in range where this same cell had traffic >= traffic_count
      let repeat = 0, total = 0;
      for (const [k2, b2] of buckets.entries()) {
        total++;
        if (b2.ix === b.ix && b2.iy === b.iy && b2.iz === b.iz && b2.snaps.length >= traffic_count) repeat++;
      }
      const confidence = total ? repeat / total : 0;
      res.push({ key: k, t: b.t, ix: b.ix, iy: b.iy, iz: b.iz, traffic_count, conflict_count, flow_count: flows.size, score, flights: Array.from(flightsSet), confidence });
    }

    res.sort((a, b) => b.score - a.score);
    return res;
  }

  function scoreScenario(metrics, weights) {
    // metrics: { conflicts, hotspots, total_delay_minutes, alt_change_ft }
    const W = Object.assign({A:1000,B:50,C:1,D:0.1}, weights || {});
    return W.A * (metrics.conflicts || 0) + W.B * (metrics.hotspots || 0) + W.C * (metrics.total_delay_minutes || 0) + W.D * (Math.abs(metrics.alt_change_ft || 0));
  }

  // Simple greedy optimizer
  async function optimizeSchedule(flights, opts = {}) {
    // opts: K iterations, airports map, timeStart, timeEnd, timeBucketSec
    const K = opts.K || 30;
    const airports = opts.airports;
    const timeStart = opts.timeStart || Math.min(...flights.map(f=>f['departure time']));
    const timeEnd = opts.timeEnd || Math.max(...flights.map(f=> (f['arrival time']|| f['departure time']+3600)));
    const timeBucketSec = opts.timeBucketSec || 300;

    // initial edits empty
    const edits = {};

    function computeMetrics(editsLocal) {
      // compute total conflicts across time buckets (coarse: sample every bucket)
      let totalConflicts = 0;
      let hotspots = 0;
      for (let t = timeStart; t <= timeEnd; t += timeBucketSec) {
        const snap = simulatePositions(flights, t, editsLocal, airports);
        const conf = detectConflicts(snap);
        totalConflicts += conf.length;
        // hotspots: number of buckets with traffic > threshold (say > 6)
        const hs = snap.length > 6 ? 1 : 0;
        hotspots += hs;
      }
      let total_delay = 0;
      for (const ac of Object.keys(editsLocal)) {
        total_delay += (editsLocal[ac].departure_time_delta || 0)/60.0;
      }
      const alt_change = Object.values(editsLocal).reduce((s,e)=>s + Math.abs(e.altitude_delta_ft || 0), 0);
      return { conflicts: totalConflicts, hotspots, total_delay_minutes: total_delay, alt_change_ft: alt_change };
    }

    let baseMetrics = computeMetrics({});
    let currentBestScore = scoreScenario(baseMetrics, opts.weights);

    // Greedy loop
    for (let iter = 0; iter < K; iter++) {
      // find worst hotspot bucket
      const hotspots = computeHotspots3D(flights, timeStart, timeEnd, {cellNm: opts.cellNm || 25, cellFt: opts.cellFt || 2000, timeBucketSec, airports});
      if (!hotspots.length) break;
      const worst = hotspots[0];
      const candidateFlights = worst.flights.slice(0, 8); // limit tried flights
      let improved = false;
      let bestLocal = null;

      // For each flight try small set of edits
      for (const acid of candidateFlights) {
        const baseFlight = flights.find(f=>f.ACID===acid);
        if (!baseFlight) continue;
        const candidates = [];
        // time shifts +5,+10,+15 minutes
        for (const mins of [5,10,15]) candidates.push({ departure_time_delta: mins*60 });
        // altitude shifts +/-2000
        candidates.push({ altitude_delta_ft: 2000 });
        candidates.push({ altitude_delta_ft: -2000 });

        for (const c of candidates) {
          const trial = JSON.parse(JSON.stringify(edits));
          trial[acid] = Object.assign({}, trial[acid] || {}, c);
          const m = computeMetrics(trial);
          const s = scoreScenario(m, opts.weights);
          if (s < currentBestScore) {
            if (!bestLocal || s < bestLocal.score) bestLocal = { score: s, edits: trial, metrics: m, change: {acid, c} };
          }
        }
      }

      if (bestLocal) {
        // accept
        Object.assign(edits, bestLocal.edits);
        currentBestScore = bestLocal.score;
        improved = true;
      }
      if (!improved) break;
    }

    const finalMetrics = computeMetrics(edits);
    return { edits, baseMetrics, finalMetrics };
  }

  window.Analytics = {
    simulatePositions,
    detectConflicts,
    computeAirportLoad,
    computeHotspots3D,
    scoreScenario,
    optimizeSchedule,
    _internal: { haversineNm }
  };
})();
