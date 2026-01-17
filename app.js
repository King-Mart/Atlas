const AIRPORTS = {
  CYYZ: [43.68, -79.63],
  CYVR: [49.19, -123.18],
  CYUL: [45.47, -73.74],
};

function parseCoord(s) {
  const dir = s.slice(-1);
  const val = parseFloat(s.slice(0, -1));
  return (dir === 'S' || dir === 'W') ? -val : val;
}

function parseRoute(r) {
  return r.split(/\s+/).map(p => {
    const [a,b] = p.split('/');
    return [parseCoord(a), parseCoord(b)];
  });
}

function haversineNm(a, b) {
  const R = 6371;
  const toRad = d => d*Math.PI/180;
  const dLat = toRad(b[0]-a[0]);
  const dLon = toRad(b[1]-a[1]);
  const s1 = toRad(a[0]);
  const s2 = toRad(b[0]);
  const h = Math.sin(dLat/2)**2 + Math.cos(s1)*Math.cos(s2)*Math.sin(dLon/2)**2;
  return 2*R*Math.asin(Math.sqrt(h))*0.5399568;
}

function positionAt(points, dep, speed, t) {
  const elapsed = t - dep;
  if (elapsed < 0) return null;
  let d = elapsed * (speed/3600);
  for (let i=0;i<points.length-1;i++) {
    const leg = haversineNm(points[i], points[i+1]);
    if (d <= leg) {
      const f = d/leg;
      return [
        points[i][0] + (points[i+1][0]-points[i][0])*f,
        points[i][1] + (points[i+1][1]-points[i][1])*f
      ];
    }
    d -= leg;
  }
  return points[points.length-1];
}

fetch('flights.json').then(r=>r.json()).then(flights => {
  const map = L.map('map').setView([50, -95], 4);
  L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png').addTo(map);

  const layers = flights.map(f => {
    const pts = [AIRPORTS[f['departure airport']], ...parseRoute(f.route), AIRPORTS[f['arrival airport']]];
    const poly = L.polyline(pts).addTo(map);
    const m = L.circleMarker(pts[0], {radius:4}).addTo(map);
    return {f, pts, m};
  });

  const slider = document.getElementById('time');
  const times = flights.map(f=>f['departure time']);
  slider.min = Math.min(...times);
  slider.max = Math.max(...times) + 6*3600;
  slider.value = slider.min;

  function update() {
    const t = parseInt(slider.value);
    document.getElementById('label').textContent = new Date(t*1000).toISOString();
    layers.forEach(o => {
      const p = positionAt(o.pts, o.f['departure time'], o.f['aircraft speed'], t);
      if (!p) o.m.setStyle({opacity:0});
      else { o.m.setStyle({opacity:1}); o.m.setLatLng(p); }
    });
  }
  slider.oninput = update;
  update();
});
