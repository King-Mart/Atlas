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
  return params.get("data") || "datasets/canadian_flights_1000.json";
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

// app.js - Store selected conflict globally
let selectedConflict = null;
let selectedConflictTime = null;

// Update showSuggestion function
function showSuggestion(conflict, tUnix) {
  if (!suggestionPanel || !suggestionBody) return;
  
  // Store for later use
  selectedConflict = conflict;
  selectedConflictTime = tUnix;
  
  const a = conflict.a.obj.f;
  const b = conflict.b.obj.f;
  const timeStr = new Date(tUnix * 1000).toISOString();

  // Basic conflict info
  suggestionBody.innerHTML = `
    <div style="font-weight:700;">${a.ACID || 'Flight A'} ↔ ${b.ACID || 'Flight B'}</div>
    <div style="font-size:12px;color:#ddd;">UTC ${timeStr}</div>
    <div style="margin-top:6px;font-size:13px;">Horizontal separation: ${conflict.h_nm.toFixed(2)} NM (limit ${HSEP_NM} NM)</div>
    <div style="font-size:13px;">Vertical separation: ${Math.round(conflict.v_ft)} ft (limit ${VSEP_FT} ft)</div>
    <div style="margin-top:6px;font-size:13px;">Altitudes: ${(a.altitude || '?')} ft vs ${(b.altitude || '?')} ft</div>
    <div style="font-size:13px;">Routes: ${(a['departure airport'] || '?')} → ${(a['arrival airport'] || '?')} | ${(b['departure airport'] || '?')} → ${(b['arrival airport'] || '?')}</div>
    <div style="margin-top:10px;border-top:1px solid #444;padding-top:10px;">
      <div style="font-weight:600;margin-bottom:8px;">AI Resolution Options:</div>
      <div id="aiSuggestions" style="font-size:13px;color:#ccc;">Analyzing conflict...</div>
    </div>
  `;

  suggestionPanel.style.display = 'block';

  // Generate and display AI suggestions
  generateAndDisplaySuggestions(conflict);
}

// Generate suggestions for the conflict
async function generateAndDisplaySuggestions(conflict) {
  const suggestionsDiv = document.getElementById('aiSuggestions');
  
  // Show loading
  suggestionsDiv.innerHTML = '<div style="color:#888;font-style:italic;">Analyzing conflict...</div>';
  
  try {
    // Get AI suggestions (using your existing AI system or fallback)
    const suggestions = await getAISuggestionsForConflict(conflict);
    renderAISuggestions(suggestions, conflict);
  } catch (error) {
    console.error('Error generating suggestions:', error);
    suggestionsDiv.innerHTML = '<div style="color:#f44336;">Error generating suggestions</div>';
  }
}

// Get AI suggestions (adapt to your existing AI system)
async function getAISuggestionsForConflict(conflict) {
  // Use your existing AI system or create simple rules
  return generateRuleBasedSuggestions(conflict);
}

// Render suggestions with apply buttons
function renderAISuggestions(suggestions, conflict) {
  const suggestionsDiv = document.getElementById('aiSuggestions');
  
  if (!suggestions || suggestions.length === 0) {
    suggestionsDiv.innerHTML = '<div style="color:#888;font-style:italic;">No suggestions available</div>';
    return;
  }
  
  let html = '';
  suggestions.forEach((suggestion, index) => {
    const impactColor = getImpactColor(suggestion.impact);
    html += `
      <div class="ai-suggestion" style="margin:10px 0;padding:10px;background:rgba(255,255,255,0.05);border-radius:6px;border-left:4px solid ${impactColor};">
        <div style="display:flex; justify-content:space-between; align-items:flex-start;">
          <div style="flex:1;">
            <div style="font-weight:500;color:#4fc3f7;margin-bottom:4px;">${suggestion.action}</div>
            <div style="font-size:12px;color:#bbb;margin-bottom:6px;">${suggestion.description}</div>
            <div style="display:flex; gap:8px; align-items:center;">
              <span style="background:${impactColor};padding:2px 8px;border-radius:3px;font-size:11px;color:white;">
                ${suggestion.impact} IMPACT
              </span>
              <span style="font-size:11px;color:#aaa;">
                Confidence: ${(suggestion.confidence * 100).toFixed(0)}%
              </span>
            </div>
          </div>
          <button onclick="applySuggestion(${index})" 
                  style="margin-left:10px;padding:6px 12px;background:#4caf50;border:none;border-radius:4px;color:white;cursor:pointer;font-size:12px;white-space:nowrap;">
            Apply
          </button>
        </div>
      </div>
    `;
  });
  
  suggestionsDiv.innerHTML = html;
}

// Simple rule-based suggestions (fallback if AI not available)
function generateRuleBasedSuggestions(conflict) {
  const a = conflict.a.obj.f;
  const b = conflict.b.obj.f;
  const suggestions = [];
  
  // Get time of conflict
  const conflictTime = selectedConflictTime || Date.now() / 1000;
  
  // Calculate position along route to determine best action
  const aProgress = calculateFlightProgress(a, conflictTime);
  const bProgress = calculateFlightProgress(b, conflictTime);
  
  // Determine which flight is more flexible to change
  const aIsEarly = aProgress < 0.5;
  const bIsEarly = bProgress < 0.5;
  const aIsCargo = a.is_cargo;
  const bIsCargo = b.is_cargo;
  
  // Rule 1: Altitude adjustment (most common, lowest impact)
  if (conflict.v_ft < VSEP_FT) {
    const higherFlight = a.altitude > b.altitude ? a : b;
    const lowerFlight = a.altitude > b.altitude ? b : a;
    const neededSeparation = VSEP_FT - conflict.v_ft;
    
    suggestions.push({
      type: 'altitude',
      target: lowerFlight.ACID,
      action: `Increase ${lowerFlight.ACID} altitude by ${neededSeparation} ft`,
      newAltitude: lowerFlight.altitude + neededSeparation + 1000,
      description: `Climb ${lowerFlight.ACID} to ${lowerFlight.altitude + neededSeparation + 1000} ft for vertical separation`,
      confidence: 0.85,
      impact: 'LOW'
    });
    
    suggestions.push({
      type: 'altitude',
      target: higherFlight.ACID,
      action: `Increase ${higherFlight.ACID} altitude by ${neededSeparation} ft`,
      newAltitude: higherFlight.altitude + neededSeparation + 1000,
      description: `Climb ${higherFlight.ACID} for additional safety margin`,
      confidence: 0.75,
      impact: 'LOW'
    });
  }
  
  // Rule 2: Speed adjustment (medium impact)
  if (conflict.h_nm < HSEP_NM) {
    // Check which flight can more easily adjust speed
    const adjustFlight = aIsCargo ? a : b; // Prefer adjusting cargo over passenger
    const speedAdjustment = 20; // knots
    
    suggestions.push({
      type: 'speed',
      target: adjustFlight.ACID,
      action: `Reduce ${adjustFlight.ACID} speed by ${speedAdjustment} knots`,
      newSpeed: adjustFlight['aircraft speed'] - speedAdjustment,
      description: `Slow ${adjustFlight.ACID} to create temporal separation`,
      confidence: 0.70,
      impact: 'MEDIUM'
    });
  }
  
  // Rule 3: Small route deviation (for horizontal conflicts)
  if (conflict.h_nm < HSEP_NM && conflict.v_ft >= VSEP_FT) {
    suggestions.push({
      type: 'route',
      target: a.ACID,
      action: `Add minor waypoint offset for ${a.ACID}`,
      newRoute: generateOffsetRoute(a.route),
      description: 'Small lateral deviation of 5-10 NM to increase horizontal separation',
      confidence: 0.65,
      impact: 'MEDIUM'
    });
  }
  
  // Rule 4: Time delay (last resort, high impact)
  if ((aIsEarly || bIsEarly) && (aIsCargo || bIsCargo)) {
    // Only suggest delays for cargo flights in early stages
    const delayFlight = aIsCargo ? a : b;
    const delayMinutes = 5;
    
    suggestions.push({
      type: 'time',
      target: delayFlight.ACID,
      action: `Delay ${delayFlight.ACID} by ${delayMinutes} minutes`,
      newDepartureTime: delayFlight['departure time'] + (delayMinutes * 60),
      description: `Delay ${delayFlight.ACID} departure to avoid temporal overlap`,
      confidence: 0.90,
      impact: 'HIGH'
    });
  }
  
  return suggestions;
}

// Helper to calculate flight progress (0-1)
function calculateFlightProgress(flight, currentTime) {
  const elapsed = currentTime - flight['departure time'];
  if (elapsed < 0) return 0;
  
  // Estimate total flight time (simplified)
  const estimatedFlightTime = 2 * 3600; // Assume 2 hours
  return Math.min(elapsed / estimatedFlightTime, 1);
}

// Generate an offset route
function generateOffsetRoute(routeStr) {
  if (!routeStr || !routeStr.trim()) return '';
  
  const waypoints = routeStr.trim().split(/\s+/);
  if (waypoints.length === 0) return '';
  
  // Add a small offset to the first waypoint
  const firstWp = waypoints[0];
  const parts = firstWp.split('/');
  if (parts.length !== 2) return routeStr;
  
  // Add small offset (0.1 degrees ≈ 6 NM)
  const lat = parseCoord(parts[0]);
  const lon = parseCoord(parts[1]);
  const offsetLat = lat + 0.1;
  const offsetLon = lon + 0.1;
  
  const newFirstWp = `${Math.abs(offsetLat).toFixed(2)}${offsetLat >= 0 ? 'N' : 'S'}/${Math.abs(offsetLon).toFixed(2)}${offsetLon >= 0 ? 'E' : 'W'}`;
  waypoints[0] = newFirstWp;
  
  return waypoints.join(' ');
}

// Impact color coding
function getImpactColor(impact) {
  switch(impact) {
    case 'LOW': return '#8bc34a'; // Green
    case 'MEDIUM': return '#ff9800'; // Orange
    case 'HIGH': return '#f44336'; // Red
    default: return '#666';
  }
}

// New function to get AI suggestions
async function getAISuggestions(conflict, tUnix) {
  const suggestionsDiv = document.getElementById('aiSuggestions');
  
  try {
    // Try server-side AI first
    const suggestions = await fetchAISuggestions(conflict, tUnix);
    renderAISuggestions(suggestions, conflict);
  } catch (error) {
    console.warn('Server AI failed, using client-side rules');
    // Fallback to client-side rule-based suggestions
    const fallbackSuggestions = generateRuleBasedSuggestions(conflict);
    renderAISuggestions(fallbackSuggestions, conflict);
  }
}

// Server AI call
async function fetchAISuggestions(conflict, tUnix) {
  try {
    // Use relative path for compatibility with both local dev and Vercel
    const apiBase = window.location.hostname === 'localhost' 
      ? 'http://localhost:3000' 
      : window.location.origin;
    
    const response = await fetch(`${apiBase}/api/ai-suggestions`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        conflict: {
          flightA: conflict.a.obj.f,
          flightB: conflict.b.obj.f,
          h_nm: conflict.h_nm,
          v_ft: conflict.v_ft,
          time: tUnix
        },
        allFlights: flightObjs.map(f => f.f)
      })
    });
    
    if (!response.ok) throw new Error('Server error');
    return await response.json();
  } catch (error) {
    throw error; // Re-throw to trigger fallback
  }
}

// Client-side rule-based suggestions (fallback)
function generateRuleBasedSuggestions(conflict) {
  const a = conflict.a.obj.f;
  const b = conflict.b.obj.f;
  const suggestions = [];
  
  // Rule 1: Altitude adjustment
  if (conflict.v_ft < VSEP_FT) {
    const altDiff = Math.abs(a.altitude - b.altitude);
    const targetAlt = Math.max(a.altitude, b.altitude) + VSEP_FT;
    
    suggestions.push({
      id: 'alt_adj_1',
      type: 'altitude',
      target: a.altitude < b.altitude ? a.ACID : b.ACID,
      action: `Increase altitude by ${VSEP_FT - altDiff} ft`,
      newAltitude: targetAlt,
      confidence: 0.8,
      impact: 'LOW',
      description: 'Vertical separation is the primary issue. Adjusting altitude is safest.'
    });
  }
  
  // Rule 2: Speed adjustment
  suggestions.push({
    id: 'speed_adj_1',
    type: 'speed',
    target: a.ACID,
    action: `Reduce speed by 20 knots`,
    newSpeed: a['aircraft speed'] * 0.95,
    confidence: 0.6,
    impact: 'MEDIUM',
    description: 'Slowing flight allows temporal separation'
  });
  
  // Rule 3: Minor route deviation
  suggestions.push({
    id: 'route_dev_1',
    type: 'route',
    target: a.ACID,
    action: 'Add minor waypoint offset',
    newRoute: generateOffsetRoute(a.route),
    confidence: 0.7,
    impact: 'LOW',
    description: 'Small lateral deviation provides horizontal separation'
  });
  
  // Rule 4: Time delay (least preferred)
  suggestions.push({
    id: 'time_delay_1',
    type: 'time',
    target: a.ACID,
    action: 'Delay departure by 5 minutes',
    newDepartureTime: a['departure time'] + 300,
    confidence: 0.9,
    impact: 'HIGH',
    description: 'Temporal separation avoids conflict but causes delay'
  });
  
  return suggestions;
}

// Render suggestions with apply buttons
function renderAISuggestions(suggestions, conflict) {
  const suggestionsDiv = document.getElementById('aiSuggestions');
  
  if (!suggestions || suggestions.length === 0) {
    suggestionsDiv.innerHTML = '<div style="color:#888;font-style:italic;">No AI suggestions available</div>';
    return;
  }
  
  let html = '';
  suggestions.forEach((suggestion, index) => {
    html += `
      <div class="ai-suggestion" style="margin:8px 0;padding:8px;background:rgba(255,255,255,0.05);border-radius:6px;">
        <div style="font-weight:500;color:#4fc3f7;">${suggestion.description}</div>
        <div style="font-size:12px;margin:4px 0;color:#bbb;">
          <span style="background:${getImpactColor(suggestion.impact)};padding:2px 6px;border-radius:3px;font-size:10px;">
            ${suggestion.impact} IMPACT
          </span>
          <span style="margin-left:8px;">Confidence: ${(suggestion.confidence * 100).toFixed(0)}%</span>
        </div>
        <button onclick="applySuggestion(${index})" 
                style="margin-top:6px;padding:4px 12px;background:#4caf50;border:none;border-radius:4px;color:white;cursor:pointer;font-size:12px;">
          Apply This Solution
        </button>
      </div>
    `;
  });
  
  suggestionsDiv.innerHTML = html;
}

function getImpactColor(impact) {
  switch(impact) {
    case 'LOW': return '#8bc34a';
    case 'MEDIUM': return '#ff9800';
    case 'HIGH': return '#f44336';
    default: return '#666';
  }
}

// Apply suggestion to JSON data
async function applySuggestion(suggestionId, index) {
  const conflict = getSelectedConflict(); // You'll need to track selected conflict
  const suggestions = await getSuggestionsForConflict(conflict);
  const suggestion = suggestions[index];
  
  // Apply the edit
  edits[suggestion.target] = edits[suggestion.target] || {};
  
  switch(suggestion.type) {
    case 'altitude':
      edits[suggestion.target].altitude_delta_ft = 
        (edits[suggestion.target].altitude_delta_ft || 0) + 
        (suggestion.newAltitude - getFlight(suggestion.target).altitude);
      break;
    case 'time':
      edits[suggestion.target].departure_time_delta = 
        (edits[suggestion.target].departure_time_delta || 0) + 
        (suggestion.newDepartureTime - getFlight(suggestion.target)['departure time']);
      break;
    case 'speed':
      // Note: Speed edits need to be tracked differently
      console.warn('Speed adjustment not yet implemented in edits system');
      break;
    case 'route':
      console.warn('Route adjustment not yet implemented in edits system');
      break;
  }
  
  // Update UI
  renderEditsPanel();
  updateFn();
  
  // Show confirmation
  showNotification(`Applied suggestion to ${suggestion.target}`);
}

// Helper function to get flight by ACID
function getFlight(acid) {
  return flightObjs.find(f => f.f.ACID === acid)?.f;
}

if (suggestionClose) suggestionClose.onclick = hideSuggestion;
if (suggestionHandle) suggestionHandle.addEventListener('mousedown', onDragStart);

// app.js - Updated renderEditsPanel
function renderEditsPanel() {
  if (!editsPanel) return;
  
  editsPanel.innerHTML = '';
  
  // Header
  const header = document.createElement('div');
  header.innerHTML = `<div style="font-weight:600;margin-bottom:8px;">Applied Modifications (Visual Only)</div>
                     <div style="font-size:11px;color:#666;margin-bottom:12px;">Changes are temporary and don't modify source data</div>`;
  editsPanel.appendChild(header);
  
  // Show applied edits
  const appliedFlights = Object.keys(edits).filter(acid => 
    Object.values(edits[acid]).some(val => val !== 0 && val !== undefined && val !== '')
  );
  
  if (appliedFlights.length === 0) {
    const emptyMsg = document.createElement('div');
    emptyMsg.className = 'muted';
    emptyMsg.textContent = 'No modifications applied yet';
    editsPanel.appendChild(emptyMsg);
  } else {
    appliedFlights.forEach(acid => {
      const edit = edits[acid];
      const flightObj = flightObjs.find(f => f.f.ACID === acid);
      
      const el = document.createElement('div');
      el.className = 'row';
      el.style.cssText = 'padding:8px;margin:6px 0;border:1px solid #ddd;border-radius:6px;';
      
      let editText = '';
      if (edit.altitude_delta_ft) {
        editText += `Altitude: ${edit.altitude_delta_ft > 0 ? '+' : ''}${edit.altitude_delta_ft} ft<br>`;
      }
      if (edit.departure_time_delta) {
        editText += `Time: ${edit.departure_time_delta > 0 ? '+' : ''}${edit.departure_time_delta/60} min<br>`;
      }
      if (edit.speed_delta_kts) {
        editText += `Speed: ${edit.speed_delta_kts > 0 ? '+' : ''}${edit.speed_delta_kts} kts<br>`;
      }
      if (edit.route_modification) {
        editText += `Route modified<br>`;
      }
      
      el.innerHTML = `
        <div style="display:flex; justify-content:space-between; align-items:center;">
          <div>
            <div style="font-weight:600;font-size:13px;">${acid}</div>
            <div style="font-size:11px;color:#444;">${editText}</div>
          </div>
          <div>
            <button onclick="undoFlightEdit('${acid}')" 
                    style="padding:4px 10px;font-size:11px;background:#ff9800;color:white;border:none;border-radius:4px;cursor:pointer;">
              Undo
            </button>
          </div>
        </div>
      `;
      
      editsPanel.appendChild(el);
    });
  }
  
  // Add reset all button if there are edits
  if (appliedFlights.length > 0) {
    const resetDiv = document.createElement('div');
    resetDiv.style.marginTop = '12px';
    resetDiv.innerHTML = `
      <button onclick="resetAllVisualEdits()" 
              style="width:100%;padding:8px;background:#f44336;color:white;border:none;border-radius:4px;cursor:pointer;font-size:12px;">
        Reset All Visual Changes
      </button>
    `;
    editsPanel.appendChild(resetDiv);
  }
}

// Undo a single flight's edits
function undoFlightEdit(acid) {
  const flightObj = flightObjs.find(f => f.f.ACID === acid);
  if (!flightObj) return;
  
  // Restore original values
  if (flightObj.originalValues) {
    flightObj.f.altitude = flightObj.originalValues.altitude;
    flightObj.f['departure time'] = flightObj.originalValues.departureTime;
    flightObj.f['aircraft speed'] = flightObj.originalValues.speed;
    flightObj.f.route = flightObj.originalValues.route;
    
    // Reset altitude in meters
    flightObj.altM = flightObj.originalValues.altitude * 0.3048;
    
    // Reset visual properties
    flightObj.planeEntityTop.billboard.color = Cesium.Color.YELLOW;
    flightObj.aiModified = false;
    
    // Rebuild route if needed
    if (flightObj.originalValues.route) {
      const ptsLL = buildPointsForFlight(flightObj.f);
      if (ptsLL && ptsLL.length >= 2) {
        const positions = ptsLL.map(([lat, lon]) => llToCartesian(lat, lon, flightObj.altM));
        flightObj.routeEntity.polyline.positions = positions;
      }
    }
  }
  
  // Remove from edits
  delete edits[acid];
  delete flightObj.originalValues;
  
  // Update everything
  renderEditsPanel();
  updateFn();
  
  showNotification(`Undone changes to ${acid}`, 'success');
}

// Reset all visual edits
function resetAllVisualEdits() {
  if (confirm('Reset all visual changes? This will undo all modifications.')) {
    flightObjs.forEach(obj => {
      if (obj.originalValues) {
        undoFlightEdit(obj.f.ACID);
      }
    });
    
    // Clear all edits
    edits = {};
    suggestedEdits = {};
    
    renderEditsPanel();
    updateFn();
    
    showNotification('All visual changes reset', 'success');
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
  { label: "Lives are at risk", tOffsetMin: 55, camera: { lon:-78.03, lat:45.88, h:900000 } },
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


// app.js - Apply suggestion (VISUAL CHANGES ONLY)
async function applySuggestion(suggestionIndex) {
  if (!selectedConflict) {
    showNotification('No conflict selected', 'error');
    return;
  }
  
  // Get suggestions for current conflict
  const suggestions = await getAISuggestionsForConflict(selectedConflict);
  const suggestion = suggestions[suggestionIndex];
  
  if (!suggestion) {
    showNotification('Invalid suggestion', 'error');
    return;
  }
  
  // Find the flight object to modify
  const flightObj = flightObjs.find(f => f.f.ACID === suggestion.target);
  if (!flightObj) {
    showNotification(`Flight ${suggestion.target} not found`, 'error');
    return;
  }
  
  // Store original values before modification (for undo)
  if (!flightObj.originalValues) {
    flightObj.originalValues = {
      altitude: flightObj.f.altitude,
      departureTime: flightObj.f['departure time'],
      speed: flightObj.f['aircraft speed'],
      route: flightObj.f.route
    };
  }
  
  // Apply the suggestion to the EDIT object (not original data!)
  edits[suggestion.target] = edits[suggestion.target] || {};
  
  switch(suggestion.type) {
    case 'altitude':
      // Calculate the delta from original
      const originalAlt = flightObj.originalValues.altitude;
      edits[suggestion.target].altitude_delta_ft = suggestion.newAltitude - originalAlt;
      
      // Update visualization (temporary)
      flightObj.f.altitude = suggestion.newAltitude;
      flightObj.altM = suggestion.newAltitude * 0.3048; // Update meters for 3D
      
      // Update flight color to indicate modified
      flightObj.planeEntityTop.billboard.color = Cesium.Color.fromCssColorString('#00ff00'); // Green
      break;
      
    case 'time':
      const originalTime = flightObj.originalValues.departureTime;
      edits[suggestion.target].departure_time_delta = suggestion.newDepartureTime - originalTime;
      
      flightObj.f['departure time'] = suggestion.newDepartureTime;
      flightObj.planeEntityTop.billboard.color = Cesium.Color.fromCssColorString('#ff9900'); // Orange
      break;
      
    case 'speed':
      const originalSpeed = flightObj.originalValues.speed;
      edits[suggestion.target].speed_delta_kts = suggestion.newSpeed - originalSpeed;
      
      flightObj.f['aircraft speed'] = suggestion.newSpeed;
      flightObj.planeEntityTop.billboard.color = Cesium.Color.fromCssColorString('#ffff00'); // Yellow
      break;
      
    case 'route':
      const originalRoute = flightObj.originalValues.route;
      edits[suggestion.target].route_modification = suggestion.newRoute;
      
      flightObj.f.route = suggestion.newRoute;
      
      // Need to rebuild the route visualization
      const ptsLL = buildPointsForFlight(flightObj.f);
      if (ptsLL && ptsLL.length >= 2) {
        const altM = flightObj.altM;
        const positions = ptsLL.map(([lat, lon]) => llToCartesian(lat, lon, altM));
        flightObj.routeEntity.polyline.positions = positions;
      }
      
      flightObj.planeEntityTop.billboard.color = Cesium.Color.fromCssColorString('#0099ff'); // Blue
      break;
  }
  
  // Mark as AI-modified
  flightObj.aiModified = true;
  flightObj.modificationType = suggestion.type;
  
  // Force a complete re-render
  updateFn();
  
  // Update edits panel
  renderEditsPanel();
  
  // Show success notification
  showNotification(`✓ Applied: ${suggestion.action}`, 'success');
  
  // Close suggestion panel after applying
  hideSuggestion();
  
  // Debug: Verify original data is unchanged
  verifyOriginalDataIntegrity();
}

// Verify original data is unchanged (for debugging)
function verifyOriginalDataIntegrity() {
  console.group('Data Integrity Check');
  
  flightObjs.forEach(obj => {
    const flightId = obj.f.ACID;
    const baseFlight = flightsBase.find(f => f.ACID === flightId);
    
    if (baseFlight) {
      // Check if original values match
      if (obj.originalValues) {
        console.log(`Flight ${flightId}:`);
        console.log(`  Original altitude: ${baseFlight.altitude} ft`);
        console.log(`  Current altitude: ${obj.f.altitude} ft`);
        console.log(`  Delta: ${edits[flightId]?.altitude_delta_ft || 0} ft`);
        console.log(`  Visual only: ${obj.f.altitude !== baseFlight.altitude ? 'YES' : 'NO'}`);
      }
    }
  });
  
  console.groupEnd();
}

// Add undo functionality for individual flights
function addUndoButtonToEdits() {
  // This will be called from renderEditsPanel
}

// Show notification
function showNotification(message, type = 'info') {
  // Create or use existing notification system
  const notification = document.createElement('div');
  notification.textContent = message;
  notification.style.cssText = `
    position: fixed;
    top: 20px;
    right: 20px;
    padding: 12px 20px;
    background: ${type === 'error' ? '#f44336' : type === 'success' ? '#4caf50' : '#2196f3'};
    color: white;
    border-radius: 6px;
    z-index: 1000;
    font-family: system-ui;
    animation: slideIn 0.3s ease;
  `;
  
  document.body.appendChild(notification);
  
  setTimeout(() => {
    notification.style.animation = 'slideOut 0.3s ease';
    setTimeout(() => notification.remove(), 300);
  }, 3000);
  
  // Add CSS animations if not present
  if (!document.getElementById('notification-styles')) {
    const style = document.createElement('style');
    style.id = 'notification-styles';
    style.textContent = `
      @keyframes slideIn {
        from { transform: translateX(100%); opacity: 0; }
        to { transform: translateX(0); opacity: 1; }
      }
      @keyframes slideOut {
        from { transform: translateX(0); opacity: 1; }
        to { transform: translateX(100%); opacity: 0; }
      }
    `;
    document.head.appendChild(style);
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

// app.js - Add after DOM loads
document.addEventListener('DOMContentLoaded', () => {
  // Make applySuggestion globally available
  window.applySuggestion = applySuggestion;
  window.undoFlightEdit = undoFlightEdit;
  window.resetAllVisualEdits = resetAllVisualEdits;
  
  // Initialize
  if (optimizeBtn) {
    optimizeBtn.onclick = async () => {
      // Your existing optimize code
    };
  }
});
