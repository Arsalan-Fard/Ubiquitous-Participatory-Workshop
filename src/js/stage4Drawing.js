/**
 * Stage 4 drawing tool
 * - Draw strokes on Leaflet map with finger
 * - Sticker cloning and dragging
 * - Multi-hand drawing support
 */

import { state } from './state.js';

// Multi-hand drawing state: keyed by pointerId
// Each entry: { color, isDrawing, lastContainerPt, activeStroke, buttonEl }
var handDrawStates = {};

// Sticker mapping sync loop (Stage 3/4 map view)
var stickerSyncRafId = 0;
var nextStrokeId = 1;

// Get or create drawing state for a pointer
function getHandDrawState(pointerId) {
  if (!handDrawStates[pointerId]) {
    handDrawStates[pointerId] = {
      color: null,
      isDrawing: false,
      lastContainerPt: null,
      activeStroke: null,
      buttonEl: null
    };
  }
  return handDrawStates[pointerId];
}

// Activate drawing mode for a specific pointer/hand
export function activateDrawingForPointer(pointerId, color, buttonEl) {
  var hs = getHandDrawState(pointerId);

  // Remove active class from previous button if different
  if (hs.buttonEl && hs.buttonEl !== buttonEl) {
    hs.buttonEl.classList.remove('ui-draw--active');
  }

  hs.color = color;
  hs.buttonEl = buttonEl || null;

  // Add active class to the new button
  if (hs.buttonEl) {
    hs.buttonEl.classList.add('ui-draw--active');
  }

  updateDrawModeVisuals();
}

// Deactivate drawing mode for a specific pointer/hand
export function deactivateDrawingForPointer(pointerId) {
  var hs = handDrawStates[pointerId];
  if (hs) {
    if (hs.isDrawing) {
      hs.isDrawing = false;
      hs.activeStroke = null;
    }
    // Remove active class from button
    if (hs.buttonEl) {
      hs.buttonEl.classList.remove('ui-draw--active');
    }
    delete handDrawStates[pointerId];
  }
  updateDrawModeVisuals();
}

// Check if any hand has drawing active
export function isAnyDrawingActive() {
  for (var pid in handDrawStates) {
    if (handDrawStates[pid].color) return true;
  }
  return false;
}

// Get the drawing color for a pointer (or null if not drawing)
export function getDrawColorForPointer(pointerId) {
  var hs = handDrawStates[pointerId];
  return hs ? hs.color : null;
}

// Get all active drawing pointer IDs
export function getActiveDrawingPointerIds() {
  var ids = [];
  for (var pid in handDrawStates) {
    if (handDrawStates[pid].color) {
      ids.push(parseInt(pid, 10));
    }
  }
  return ids;
}

// Clean up drawing states for pointers that no longer exist
export function cleanupDrawingForMissingPointers(activePointerIds) {
  var activeSet = {};
  for (var i = 0; i < activePointerIds.length; i++) {
    activeSet[activePointerIds[i]] = true;
  }

  for (var pid in handDrawStates) {
    if (!activeSet[pid]) {
      deactivateDrawingForPointer(parseInt(pid, 10));
    }
  }
}

// Update visuals based on drawing state
function updateDrawModeVisuals() {
  var anyActive = isAnyDrawingActive();
  var dom = state.dom;

  // Legacy state for backward compatibility
  state.stage4DrawMode = anyActive;

  if (dom.leafletMapEl) {
    dom.leafletMapEl.classList.toggle('leaflet-map--draw-active', anyActive && state.stage === 4 && state.viewMode === 'map');
  }

  updateStage4MapInteractivity();
}

// Convert pointer event to Leaflet lat/lng accounting for Maptastic transform
export function stage4LatLngFromPointerEvent(e) {
  if (!state.leafletMap) return null;
  var dom = state.dom;

  try {
    var baseRect = dom.mapViewEl.getBoundingClientRect();
    var x = e.clientX - baseRect.left;
    var y = e.clientY - baseRect.top;

    var transform = window.getComputedStyle(dom.mapWarpEl).transform;
    var m = (transform && transform !== 'none') ? new DOMMatrixReadOnly(transform) : new DOMMatrixReadOnly();
    var inv = m.inverse();
    var local = new DOMPoint(x, y, 0, 1).matrixTransform(inv);

    if (local && typeof local.w === 'number' && local.w && local.w !== 1) {
      local = new DOMPoint(local.x / local.w, local.y / local.w, local.z / local.w, 1);
    }

    var pt = state.leafletGlobal && state.leafletGlobal.point ? state.leafletGlobal.point(local.x, local.y) : { x: local.x, y: local.y };
    return state.leafletMap.containerPointToLatLng(pt);
  } catch (err) {
    return null;
  }
}

// Convert clientX/clientY to Leaflet lat/lng
export function stage4LatLngFromClientCoords(clientX, clientY) {
  if (!state.leafletMap) return null;
  var dom = state.dom;

  try {
    var baseRect = dom.mapViewEl.getBoundingClientRect();
    var x = clientX - baseRect.left;
    var y = clientY - baseRect.top;

    var transform = window.getComputedStyle(dom.mapWarpEl).transform;
    var m = (transform && transform !== 'none') ? new DOMMatrixReadOnly(transform) : new DOMMatrixReadOnly();
    var inv = m.inverse();
    var local = new DOMPoint(x, y, 0, 1).matrixTransform(inv);

    if (local && typeof local.w === 'number' && local.w && local.w !== 1) {
      local = new DOMPoint(local.x / local.w, local.y / local.w, local.z / local.w, 1);
    }

    var pt = state.leafletGlobal && state.leafletGlobal.point ? state.leafletGlobal.point(local.x, local.y) : { x: local.x, y: local.y };
    return state.leafletMap.containerPointToLatLng(pt);
  } catch (err) {
    return null;
  }
}

function stage4ClientCoordsFromLatLng(lat, lng) {
  if (!state.leafletMap) return null;
  var dom = state.dom;

  try {
    var ll = (state.leafletGlobal && state.leafletGlobal.latLng) ? state.leafletGlobal.latLng(lat, lng) : { lat: lat, lng: lng };
    var pt = state.leafletMap.latLngToContainerPoint(ll);

    var baseRect = dom.mapViewEl.getBoundingClientRect();
    var transform = window.getComputedStyle(dom.mapWarpEl).transform;
    var m = (transform && transform !== 'none') ? new DOMMatrixReadOnly(transform) : new DOMMatrixReadOnly();
    var warped = new DOMPoint(pt.x, pt.y, 0, 1).matrixTransform(m);

    if (warped && typeof warped.w === 'number' && warped.w && warped.w !== 1) {
      warped = new DOMPoint(warped.x / warped.w, warped.y / warped.w, warped.z / warped.w, 1);
    }

    return { x: baseRect.left + warped.x, y: baseRect.top + warped.y };
  } catch (err) {
    return null;
  }
}

function shouldSyncStickers() {
  if (state.viewMode !== 'map') return false;
  if (state.stage !== 3 && state.stage !== 4) return false;
  if (!state.leafletMap || !state.dom) return false;
  if (!state.dom.uiSetupOverlayEl || state.dom.uiSetupOverlayEl.classList.contains('hidden')) return false;
  if (!state.dom.mapViewEl || !state.dom.mapWarpEl) return false;
  return true;
}

function isStickerDragging(el) {
  if (!el || !el.classList) return false;
  return el.classList.contains('ui-dot--dragging') || el.classList.contains('ui-note--dragging') || el.classList.contains('ui-draw--dragging');
}

export function bindStickerLatLngFromCurrentPosition(el) {
  if (!el || !el.dataset) return null;
  if (!(el.classList.contains('ui-dot') || el.classList.contains('ui-note'))) return null;
  if (!el.classList.contains('ui-sticker-instance')) return null;

  var rect = el.getBoundingClientRect();
  var cx = rect.left + rect.width / 2;
  var cy = rect.top + rect.height / 2;
  var latlng = stage4LatLngFromClientCoords(cx, cy);
  if (!latlng) return null;

  el.dataset.mapLat = String(latlng.lat);
  el.dataset.mapLng = String(latlng.lng);
  return latlng;
}

function syncMappedStickersNow() {
  if (!shouldSyncStickers()) return;

  var overlayEl = state.dom.uiSetupOverlayEl;
  var els = overlayEl.querySelectorAll('.ui-sticker-instance.ui-dot, .ui-sticker-instance.ui-note');

  for (var i = 0; i < els.length; i++) {
    var el = els[i];
    if (!el || !el.dataset) continue;
    if (isStickerDragging(el)) continue;

    var lat = parseFloat(el.dataset.mapLat);
    var lng = parseFloat(el.dataset.mapLng);

    if (!isFinite(lat) || !isFinite(lng)) {
      var ll = bindStickerLatLngFromCurrentPosition(el);
      if (!ll) continue;
      lat = ll.lat;
      lng = ll.lng;
    }

    var client = stage4ClientCoordsFromLatLng(lat, lng);
    if (!client) continue;

    var w = el.offsetWidth || 0;
    var h = el.offsetHeight || 0;
    el.style.left = (client.x - w / 2) + 'px';
    el.style.top = (client.y - h / 2) + 'px';
  }
}

function stickerSyncTick() {
  stickerSyncRafId = 0;
  if (!shouldSyncStickers()) return;
  syncMappedStickersNow();
  stickerSyncRafId = requestAnimationFrame(stickerSyncTick);
}

export function updateStickerMappingForCurrentView() {
  if (shouldSyncStickers()) {
    if (!stickerSyncRafId) stickerSyncRafId = requestAnimationFrame(stickerSyncTick);
    return;
  }

  if (stickerSyncRafId) {
    cancelAnimationFrame(stickerSyncRafId);
    stickerSyncRafId = 0;
  }
}

// Handle pointer down to start drawing (multi-hand)
export function stage4PointerdownOnMap(e) {
  if (state.stage !== 4 || state.viewMode !== 'map') return;
  if (!state.leafletMap || !state.stage4DrawLayer || !state.leafletGlobal) return;
  if (e.button !== 0) return;
  if (e.target && e.target.closest && e.target.closest('.hamburger-menu')) return;

  var pointerId = e.pointerId;
  var hs = handDrawStates[pointerId];

  // Only start drawing if this pointer has drawing activated
  if (!hs || !hs.color) return;

  var latlng = stage4LatLngFromPointerEvent(e);
  if (!latlng) return;

  e.preventDefault();
  e.stopPropagation();

  hs.isDrawing = true;
  hs.lastContainerPt = null;
  var latlngs = [latlng];
  var strokeId = 'stroke_' + (nextStrokeId++);

  var L = state.leafletGlobal;
  var glow = L.polyline(latlngs, {
    color: hs.color,
    weight: 14,
    opacity: 0.25,
    lineCap: 'round',
    lineJoin: 'round',
    interactive: false
  }).addTo(state.stage4DrawLayer);

  var main = L.polyline(latlngs, {
    color: hs.color,
    weight: 7,
    opacity: 0.95,
    lineCap: 'round',
    lineJoin: 'round',
    interactive: false
  }).addTo(state.stage4DrawLayer);

  // Tag polylines with session ID
  var sessionId = state.currentMapSessionId;
  if (sessionId) {
    glow.sessionId = sessionId;
    main.sessionId = sessionId;
  }
  glow.strokeId = strokeId;
  main.strokeId = strokeId;

  hs.activeStroke = { latlngs: latlngs, glow: glow, main: main };

  // Don't capture synthetic pointers
  if (pointerId < 100) {
    var dom = state.dom;
    if (dom.leafletMapEl.setPointerCapture) {
      try {
        dom.leafletMapEl.setPointerCapture(pointerId);
      } catch (err) { /* ignore */ }
    }
  }
}

// Handle pointer move to continue drawing (multi-hand)
export function stage4PointermoveOnMap(e) {
  if (state.stage !== 4 || state.viewMode !== 'map') return;
  if (!state.leafletMap) return;

  var pointerId = e.pointerId;
  var hs = handDrawStates[pointerId];

  if (!hs || !hs.isDrawing || !hs.activeStroke) return;

  e.preventDefault();
  e.stopPropagation();

  var pt;
  try {
    var ll = stage4LatLngFromPointerEvent(e);
    if (ll) {
      pt = state.leafletMap.latLngToContainerPoint(ll);
    } else {
      pt = null;
    }
  } catch (err) {
    pt = null;
  }

  if (pt && hs.lastContainerPt) {
    var dx = pt.x - hs.lastContainerPt.x;
    var dy = pt.y - hs.lastContainerPt.y;
    if ((dx * dx + dy * dy) < 4) return;
  }

  var latlng = stage4LatLngFromPointerEvent(e);
  if (!latlng) return;

  if (pt) hs.lastContainerPt = pt;
  hs.activeStroke.latlngs.push(latlng);

  if (hs.activeStroke.glow) hs.activeStroke.glow.setLatLngs(hs.activeStroke.latlngs);
  if (hs.activeStroke.main) hs.activeStroke.main.setLatLngs(hs.activeStroke.latlngs);
}

// Handle pointer up to stop drawing (multi-hand)
export function stage4StopDrawing(e) {
  var pointerId = e.pointerId;
  var hs = handDrawStates[pointerId];

  if (!hs || !hs.isDrawing) return;

  hs.isDrawing = false;
  hs.lastContainerPt = null;
  hs.activeStroke = null;

  if (pointerId < 100) {
    var dom = state.dom;
    if (dom.leafletMapEl && dom.leafletMapEl.releasePointerCapture) {
      try {
        dom.leafletMapEl.releasePointerCapture(pointerId);
      } catch (err) { /* ignore */ }
    }
  }
}

// Start drawing for a hand at given coordinates (called from gesture system)
export function startDrawingAtPoint(pointerId, clientX, clientY) {
  if (state.stage !== 4 || state.viewMode !== 'map') return;
  if (!state.leafletMap || !state.stage4DrawLayer || !state.leafletGlobal) return;

  var hs = handDrawStates[pointerId];
  if (!hs || !hs.color) return;

  var latlng = stage4LatLngFromClientCoords(clientX, clientY);
  if (!latlng) return;

  hs.isDrawing = true;
  hs.lastContainerPt = null;
  var latlngs = [latlng];
  var strokeId = 'stroke_' + (nextStrokeId++);

  var L = state.leafletGlobal;
  var glow = L.polyline(latlngs, {
    color: hs.color,
    weight: 14,
    opacity: 0.25,
    lineCap: 'round',
    lineJoin: 'round',
    interactive: false
  }).addTo(state.stage4DrawLayer);

  var main = L.polyline(latlngs, {
    color: hs.color,
    weight: 7,
    opacity: 0.95,
    lineCap: 'round',
    lineJoin: 'round',
    interactive: false
  }).addTo(state.stage4DrawLayer);

  // Tag polylines with session ID
  var sessionId = state.currentMapSessionId;
  if (sessionId) {
    glow.sessionId = sessionId;
    main.sessionId = sessionId;
  }
  glow.strokeId = strokeId;
  main.strokeId = strokeId;

  hs.activeStroke = { latlngs: latlngs, glow: glow, main: main };
}

function distancePointToSegmentPx(px, py, x1, y1, x2, y2) {
  var dx = x2 - x1;
  var dy = y2 - y1;
  if (dx === 0 && dy === 0) {
    var ddx = px - x1;
    var ddy = py - y1;
    return Math.sqrt(ddx * ddx + ddy * ddy);
  }
  var t = ((px - x1) * dx + (py - y1) * dy) / (dx * dx + dy * dy);
  if (t < 0) t = 0;
  if (t > 1) t = 1;
  var cx = x1 + t * dx;
  var cy = y1 + t * dy;
  var ex = px - cx;
  var ey = py - cy;
  return Math.sqrt(ex * ex + ey * ey);
}

function distancePointToRectPx(px, py, rect) {
  var nx = Math.max(rect.left, Math.min(px, rect.right));
  var ny = Math.max(rect.top, Math.min(py, rect.bottom));
  var dx = px - nx;
  var dy = py - ny;
  return Math.sqrt(dx * dx + dy * dy);
}

function flattenLatLngs(latlngs, out) {
  if (!Array.isArray(latlngs)) return;
  for (var i = 0; i < latlngs.length; i++) {
    var v = latlngs[i];
    if (!v) continue;
    if (Array.isArray(v)) {
      flattenLatLngs(v, out);
      continue;
    }
    if (typeof v.lat === 'number' && typeof v.lng === 'number') {
      out.push(v);
    }
  }
}

export function eraseAtPoint(clientX, clientY, radiusPx) {
  if (state.stage !== 4 || state.viewMode !== 'map') return;
  if (!state.leafletMap || !state.stage4DrawLayer || !state.dom) return;
  if (!isFinite(clientX) || !isFinite(clientY)) return;

  var radius = Math.max(2, isFinite(radiusPx) ? radiusPx : 16);
  var pointerLatLng = stage4LatLngFromClientCoords(clientX, clientY);
  if (!pointerLatLng) return;
  var pointerPt = state.leafletMap.latLngToContainerPoint(pointerLatLng);
  if (!pointerPt) return;

  var layersToRemove = [];
  var removeStrokeIds = {};
  state.stage4DrawLayer.eachLayer(function(layer) {
    if (!layer || typeof layer.getLatLngs !== 'function') return;
    var raw = layer.getLatLngs();
    if (!raw) return;
    var flat = [];
    flattenLatLngs(raw, flat);
    if (flat.length < 1) return;

    var minDist = Infinity;
    if (flat.length === 1) {
      var onlyPt = state.leafletMap.latLngToContainerPoint(flat[0]);
      if (onlyPt) {
        var odx = pointerPt.x - onlyPt.x;
        var ody = pointerPt.y - onlyPt.y;
        minDist = Math.sqrt(odx * odx + ody * ody);
      }
    } else {
      for (var i = 1; i < flat.length; i++) {
        var a = state.leafletMap.latLngToContainerPoint(flat[i - 1]);
        var b = state.leafletMap.latLngToContainerPoint(flat[i]);
        if (!a || !b) continue;
        var dist = distancePointToSegmentPx(pointerPt.x, pointerPt.y, a.x, a.y, b.x, b.y);
        if (dist < minDist) minDist = dist;
      }
    }

    if (minDist <= radius) {
      layersToRemove.push(layer);
      if (layer.strokeId) {
        removeStrokeIds[String(layer.strokeId)] = true;
      }
    }
  });

  if (Object.keys(removeStrokeIds).length > 0) {
    state.stage4DrawLayer.eachLayer(function(layer) {
      if (!layer || !layer.strokeId) return;
      if (removeStrokeIds[String(layer.strokeId)]) {
        layersToRemove.push(layer);
      }
    });
  }

  var uniqueLayers = [];
  for (var li = 0; li < layersToRemove.length; li++) {
    if (uniqueLayers.indexOf(layersToRemove[li]) === -1) {
      uniqueLayers.push(layersToRemove[li]);
    }
  }
  for (var lr = 0; lr < uniqueLayers.length; lr++) {
    try {
      state.stage4DrawLayer.removeLayer(uniqueLayers[lr]);
    } catch (e) { /* ignore */ }
  }

  var overlayEl = state.dom.uiSetupOverlayEl;
  if (!overlayEl) return;
  var stickerEls = overlayEl.querySelectorAll('.ui-sticker-instance.ui-dot, .ui-sticker-instance.ui-note, .ui-sticker-instance.ui-draw');
  for (var si = 0; si < stickerEls.length; si++) {
    var el = stickerEls[si];
    var rect = el.getBoundingClientRect();
    if (distancePointToRectPx(clientX, clientY, rect) <= radius) {
      if (el.parentNode) el.parentNode.removeChild(el);
    }
  }
}

// Continue drawing for a hand at given coordinates
export function continueDrawingAtPoint(pointerId, clientX, clientY) {
  if (!state.leafletMap) return;

  var hs = handDrawStates[pointerId];
  if (!hs || !hs.isDrawing || !hs.activeStroke) return;

  var latlng = stage4LatLngFromClientCoords(clientX, clientY);
  if (!latlng) return;

  var pt;
  try {
    pt = state.leafletMap.latLngToContainerPoint(latlng);
  } catch (err) {
    pt = null;
  }

  if (pt && hs.lastContainerPt) {
    var dx = pt.x - hs.lastContainerPt.x;
    var dy = pt.y - hs.lastContainerPt.y;
    if ((dx * dx + dy * dy) < 4) return;
  }

  if (pt) hs.lastContainerPt = pt;
  hs.activeStroke.latlngs.push(latlng);

  if (hs.activeStroke.glow) hs.activeStroke.glow.setLatLngs(hs.activeStroke.latlngs);
  if (hs.activeStroke.main) hs.activeStroke.main.setLatLngs(hs.activeStroke.latlngs);
}

// Stop drawing for a hand
export function stopDrawingForPointer(pointerId) {
  var hs = handDrawStates[pointerId];
  if (!hs) return;

  hs.isDrawing = false;
  hs.lastContainerPt = null;
  hs.activeStroke = null;
}

// Legacy function - set draw mode for all (backward compatibility)
export function setStage4DrawMode(enabled, color) {
  if (!enabled) {
    // Disable all drawing
    for (var pid in handDrawStates) {
      deactivateDrawingForPointer(parseInt(pid, 10));
    }
  }
  state.stage4DrawMode = !!enabled;
  if (color) state.stage4DrawColor = color;

  updateDrawModeVisuals();
}

// Enable/disable Leaflet interactivity based on draw mode
export function updateStage4MapInteractivity() {
  if (!state.leafletMap) return;

  var anyDrawing = isAnyDrawingActive();

  if (state.stage === 4 && state.viewMode === 'map' && anyDrawing) {
    if (state.leafletMap.dragging) state.leafletMap.dragging.disable();
    if (state.leafletMap.scrollWheelZoom) state.leafletMap.scrollWheelZoom.disable();
    if (state.leafletMap.doubleClickZoom) state.leafletMap.doubleClickZoom.disable();
    return;
  }

  // Enable map panning for mouse interactions
  if (state.leafletMap.dragging) state.leafletMap.dragging.enable();
  if (state.leafletMap.scrollWheelZoom) state.leafletMap.scrollWheelZoom.enable();
  if (state.leafletMap.doubleClickZoom) state.leafletMap.doubleClickZoom.enable();
}

// Initialize Leaflet map if not already done
export function initLeafletIfNeeded() {
  var dom = state.dom;

  if (state.leafletMap) {
    if (state.leafletMap) state.leafletMap.invalidateSize();
    updateStickerMappingForCurrentView();
    return;
  }

  state.leafletGlobal = window.L;
  var L = state.leafletGlobal;
  if (!L || !dom.leafletMapEl) {
    console.warn('Leaflet not available; map view will be blank.');
    return;
  }

  state.leafletMap = L.map(dom.leafletMapEl, {
    zoomControl: false,
    attributionControl: false,
    inertia: true,
    dragging: true
  });

  // IP Paris campus, Palaiseau
  state.leafletMap.setView([48.7133, 2.2118], 15);

  state.leafletTileLayer = L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png', {
    maxZoom: 19,
    crossOrigin: true
  });
  state.leafletTileLayer.addTo(state.leafletMap);

  if (typeof L !== 'undefined') {
    state.stage4DrawLayer = L.layerGroup().addTo(state.leafletMap);
  }

  if (state.leafletMap) state.leafletMap.invalidateSize();
  updateStickerMappingForCurrentView();
}

// Initialize Maptastic for corner dragging
export function initMaptasticIfNeeded() {
  if (state.maptasticInitialized) return;
  state.maptasticInitialized = true;

  var dom = state.dom;
  var maptasticGlobal = window.maptastic;
  if (!maptasticGlobal || !maptasticGlobal.Maptastic) {
    console.warn('Maptastic library not loaded; map corner editing is unavailable.');
    return;
  }

  try {
    new maptasticGlobal.Maptastic(dom.mapWarpEl.id);
  } catch (err) {
    console.error('Failed to initialize Maptastic:', err);
  }
}

// Clone a sticker element
export function cloneSticker(templateEl) {
  if (!templateEl) return null;
  var type = templateEl.dataset && templateEl.dataset.uiType ? templateEl.dataset.uiType : null;
  if (type !== 'dot' && type !== 'draw' && type !== 'note') return null;

  // Get current session ID for tagging
  var sessionId = state.currentMapSessionId;

  if (type === 'dot') {
    var dotEl = document.createElement('div');
    dotEl.className = 'ui-dot ui-sticker-instance';
    dotEl.dataset.uiType = 'dot';
    dotEl.dataset.color = templateEl.dataset && templateEl.dataset.color ? templateEl.dataset.color : (templateEl.style.background || '#ff3b30');
    if (sessionId) dotEl.dataset.sessionId = String(sessionId);
    dotEl.style.background = dotEl.dataset.color;
    dotEl.style.left = templateEl.style.left || '0px';
    dotEl.style.top = templateEl.style.top || '0px';
    templateEl.parentElement.appendChild(dotEl);
    return dotEl;
  }

  if (type === 'note') {
    var noteEl = document.createElement('div');
    noteEl.className = 'ui-note ui-sticker-instance';
    noteEl.dataset.uiType = 'note';
    noteEl.dataset.expanded = 'false';
    noteEl.dataset.noteText = (templateEl.dataset && templateEl.dataset.noteText) ? templateEl.dataset.noteText : '';
    noteEl.dataset.color = templateEl.dataset && templateEl.dataset.color ? templateEl.dataset.color : (templateEl.style.background || '#ffc857');
    if (sessionId) noteEl.dataset.sessionId = String(sessionId);
    noteEl.style.background = noteEl.dataset.color;
    noteEl.style.left = templateEl.style.left || '0px';
    noteEl.style.top = templateEl.style.top || '0px';

    var iconEl = document.createElement('div');
    iconEl.className = 'ui-note__icon';
    iconEl.textContent = '📝';
    // Preserve template icon state (e.g. a "saved" checkmark) when cloning.
    var templateIconEl = templateEl.querySelector ? templateEl.querySelector('.ui-note__icon') : null;
    if (templateIconEl && templateIconEl.textContent) iconEl.textContent = templateIconEl.textContent;
    noteEl.appendChild(iconEl);

    noteEl.classList.toggle('ui-note--sticker', !!String(noteEl.dataset.noteText || '').trim());

    templateEl.parentElement.appendChild(noteEl);
    setupNoteSticker(noteEl);
    return noteEl;
  }

  var drawEl = document.createElement('canvas');
  drawEl.className = 'ui-draw ui-sticker-instance';
  drawEl.dataset.uiType = 'draw';
  drawEl.dataset.color = templateEl.dataset && templateEl.dataset.color ? templateEl.dataset.color : '#2bb8ff';
  if (sessionId) drawEl.dataset.sessionId = String(sessionId);
  drawEl.width = 24;
  drawEl.height = 24;
  drawEl.style.left = templateEl.style.left || '0px';
  drawEl.style.top = templateEl.style.top || '0px';

  try {
    var srcCanvas = templateEl;
    var ctx = drawEl.getContext('2d');
    if (ctx && srcCanvas && srcCanvas.width && srcCanvas.height) {
      ctx.drawImage(srcCanvas, 0, 0, drawEl.width, drawEl.height);
    }
  } catch (err) { /* ignore */ }

  templateEl.parentElement.appendChild(drawEl);
  return drawEl;
}

// Setup note sticker interaction for Stage 4
function setupNoteSticker(noteEl) {
  noteEl.addEventListener('click', function (e) {
    if (state.stage !== 4) return;
    if (e.target.closest('.ui-note__form')) return;

    var isExpanded = noteEl.dataset.expanded === 'true';
    if (!isExpanded) {
      expandNoteSticker(noteEl);
    }
  });
}

function expandNoteSticker(noteEl) {
  if (noteEl.dataset.expanded === 'true') return;
  noteEl.classList.remove('ui-note--sticker');
  noteEl.dataset.expanded = 'true';
  noteEl.classList.add('ui-note--expanded');

  var formEl = noteEl.querySelector('.ui-note__form');
  if (!formEl) {
    formEl = document.createElement('div');
    formEl.className = 'ui-note__form';

    var textareaEl = document.createElement('textarea');
    textareaEl.className = 'ui-note__textarea';
    textareaEl.placeholder = 'Enter your note...';
    textareaEl.rows = 3;

    var submitBtn = document.createElement('button');
    submitBtn.className = 'ui-note__submit';
    submitBtn.type = 'button';
    submitBtn.textContent = 'Save';

    submitBtn.addEventListener('click', function (e) {
      e.stopPropagation();
      var text = textareaEl.value.trim();
      if (text) {
        noteEl.dataset.noteText = text;
        collapseNoteSticker(noteEl, text);
      }
    });

    textareaEl.addEventListener('click', function (e) {
      e.stopPropagation();
    });

    textareaEl.addEventListener('keydown', function (e) {
      e.stopPropagation();
      if (e.key === 'Enter' && !e.shiftKey) {
        e.preventDefault();
        submitBtn.click();
      }
      if (e.key === 'Escape') {
        collapseNoteSticker(noteEl);
      }
    });

    formEl.appendChild(textareaEl);
    formEl.appendChild(submitBtn);
    noteEl.appendChild(formEl);

    setTimeout(function () {
      textareaEl.focus();
    }, 50);
  } else {
    var textarea = formEl.querySelector('.ui-note__textarea');
    if (textarea) {
      textarea.value = noteEl.dataset.noteText || '';
      setTimeout(function () {
        textarea.focus();
      }, 50);
    }
  }
}

function collapseNoteSticker(noteEl, savedText) {
  noteEl.dataset.expanded = 'false';
  noteEl.classList.remove('ui-note--expanded');

  var iconEl = noteEl.querySelector('.ui-note__icon');
  if (iconEl && savedText) {
    iconEl.textContent = '📝✓';
  }

  var hasText = !!String(noteEl.dataset.noteText || '').trim();
  noteEl.classList.toggle('ui-note--sticker', hasText);
}

// Filter polylines by session ID
export function filterPolylinesBySession(sessionId) {
  if (!state.stage4DrawLayer) return;

  state.stage4DrawLayer.eachLayer(function(layer) {
    // Check if this is a polyline with a sessionId property
    if (!layer.setStyle) return; // Not a polyline

    var layerSessionId = layer.sessionId;

    if (!sessionId) {
      // No active session - show all polylines
      layer.setStyle({ opacity: layer._originalOpacity || (layer.options.weight === 14 ? 0.25 : 0.95) });
    } else if (layerSessionId === sessionId) {
      // Polyline belongs to current session - show it
      layer.setStyle({ opacity: layer._originalOpacity || (layer.options.weight === 14 ? 0.25 : 0.95) });
    } else if (layerSessionId) {
      // Polyline belongs to different session - hide it
      if (!layer._originalOpacity) {
        layer._originalOpacity = layer.options.opacity;
      }
      layer.setStyle({ opacity: 0 });
    } else {
      // Polyline has no session (created before sessions) - show it
      layer.setStyle({ opacity: layer._originalOpacity || (layer.options.weight === 14 ? 0.25 : 0.95) });
    }
  });
}

// Start dragging a sticker
// Options: { expandNoteOnDrop: boolean } - if true, expand note sticker after dropping
export function startStickerDrag(el, startEvent, options) {
  if (!el || !startEvent) return;
  options = options || {};
  var draggingClass = 'ui-dot--dragging';
  if (el.classList.contains('ui-draw')) draggingClass = 'ui-draw--dragging';
  if (el.classList.contains('ui-note')) draggingClass = 'ui-note--dragging';

  var rect = el.getBoundingClientRect();
  var offsetX = startEvent.clientX - rect.left;
  var offsetY = startEvent.clientY - rect.top;
  var pointerId = startEvent.pointerId;

  el.classList.add(draggingClass);

  // Only capture pointer if it's a real browser pointer (ID < 100)
  // Synthetic pointers from gesture system use IDs >= 100
  var canCapture = pointerId < 100;
  if (canCapture && el.setPointerCapture) {
    try {
      el.setPointerCapture(pointerId);
    } catch (e) {
      canCapture = false;
    }
  }

  function onMove(e) {
    if (e.pointerId !== pointerId) return;
    e.preventDefault();
    var left = e.clientX - offsetX;
    var top = e.clientY - offsetY;
    el.style.left = left + 'px';
    el.style.top = top + 'px';
  }

  function onEnd(e) {
    if (e.pointerId !== pointerId) return;
    el.classList.remove(draggingClass);

    // Bind to map coordinates once dropped so it stays anchored like drawings.
    if (state.viewMode === 'map' && (state.stage === 3 || state.stage === 4) && el.classList.contains('ui-sticker-instance')) {
      bindStickerLatLngFromCurrentPosition(el);
      updateStickerMappingForCurrentView();
    }

    // Auto-expand note stickers after dropping (for newly cloned notes)
    if (options.expandNoteOnDrop && el.classList.contains('ui-note') && el.classList.contains('ui-sticker-instance')) {
      setTimeout(function() {
        expandNoteSticker(el);
      }, 50);
    }

    if (canCapture && el.releasePointerCapture) {
      try {
        el.releasePointerCapture(pointerId);
      } catch (e) { /* ignore */ }
    }
    document.removeEventListener('pointermove', onMove, true);
    document.removeEventListener('pointerup', onEnd, true);
    document.removeEventListener('pointercancel', onEnd, true);
  }

  document.addEventListener('pointermove', onMove, true);
  document.addEventListener('pointerup', onEnd, true);
  document.addEventListener('pointercancel', onEnd, true);
}
