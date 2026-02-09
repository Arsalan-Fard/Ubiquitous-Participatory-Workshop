/**
 * Stage 4 drawing tool — MapLibre GL JS direct
 * - Draw strokes on map with finger
 * - Sticker cloning and dragging
 * - Multi-hand drawing support
 * All coordinates use [lng, lat] (GeoJSON / MapLibre native order).
 */

import { state } from './state.js';
import { normalizeTagId } from './utils.js';
import { compute, convertToSegments, breakIntersections } from '../../Isovist-VGA/visibility-polygon.esm.js';
import {
  addPolyline, addPolygon, addCircleMarker, removeMapLayer,
  updateLineCoords, updatePolygonCoords,
  createLayerGroup, addToGroup, removeFromGroup, clearGroup, eachInGroup,
  setPaintProp, nextId
} from './mapHelpers.js';

// --- Constants ---
var STROKE_GLOW_WEIGHT = 14;
var STROKE_GLOW_OPACITY = 0.25;
var STROKE_MAIN_WEIGHT = 7;
var STROKE_MAIN_OPACITY = 0.95;
var ROUTE_LINE_WEIGHT = 6;
var ROUTE_LINE_OPACITY = 0.95;
var ROUTE_MARKER_RADIUS = 7;
var ISOVIST_FILL_OPACITY = 0.22;
var ISOVIST_STROKE_OPACITY = 0.9;
var BUILDING_STROKE_WEIGHT = 1.4;
var BUILDING_FILL_OPACITY = 0.40;
var MIN_MOVE_DISTANCE_SQ = 4;
var LIVE_SIMPLIFY_MIN_DISTANCE_SQ = 9;
var LIVE_SIMPLIFY_COLLINEAR_SIN_THRESHOLD = 0.08;
var FINAL_SIMPLIFY_TOLERANCE_PX = 1.5;

var OSRM_ROUTE_BASE_URL = 'https://router.project-osrm.org/route/v1/driving/';
var ISOVIST_RADIUS_METERS = 180;
var ISOVIST_BOUNDARY_SIDES = 48;
var OSM_BUILDINGS_ENDPOINTS = [
  'https://overpass-api.de/api/interpreter',
  'https://overpass.kumi.systems/api/interpreter',
  'https://overpass.openstreetmap.ru/api/interpreter'
];
var BASE_TILES_SOURCE_ID = 'base-tiles';
var BASE_TILES_LAYER_ID = 'base-tiles';
var BASE_MAP_MODE_DEFAULT = 'default';
var BASE_MAP_MODE_MONO = 'mono';
var baseMapMode = BASE_MAP_MODE_DEFAULT;
var BASE_TILES_BY_MODE = {
  default: [
    'https://a.tile.openstreetmap.org/{z}/{x}/{y}.png',
    'https://b.tile.openstreetmap.org/{z}/{x}/{y}.png',
    'https://c.tile.openstreetmap.org/{z}/{x}/{y}.png'
  ],
  mono: [
    'https://a.basemaps.cartocdn.com/dark_nolabels/{z}/{x}/{y}.png',
    'https://b.basemaps.cartocdn.com/dark_nolabels/{z}/{x}/{y}.png',
    'https://c.basemaps.cartocdn.com/dark_nolabels/{z}/{x}/{y}.png',
    'https://d.basemaps.cartocdn.com/dark_nolabels/{z}/{x}/{y}.png'
  ]
};

// Multi-hand drawing state: keyed by pointerId
var handDrawStates = {};
var stickerSyncRafId = 0;
var nextStrokeId = 1;

var stage4RouteState = {
  start: null,
  end: null,
  startMarker: null,
  endMarker: null,
  routeLine: null,
  routeTooltip: null,
  requestId: 0
};

var stage4IsovistState = {
  originMarker: null,
  polygon: null
};

var stage4OsmBuildingsState = {
  fetchAbortController: null
};

// --- Client ↔ Map coordinate helpers (Maptastic-aware) ---

// Convert clientX/clientY to map [lng, lat], accounting for Maptastic transform
export function clientToLngLat(clientX, clientY) {
  if (!state.map) return null;
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
    var ll = state.map.unproject([local.x, local.y]);
    return [ll.lng, ll.lat];
  } catch (err) {
    return null;
  }
}

// Backward-compatible wrapper: convert pointer event to [lng, lat]
export function stage4LatLngFromPointerEvent(e) {
  return clientToLngLat(e.clientX, e.clientY);
}

// Backward-compatible wrapper: convert clientX/clientY to {lat, lng} object
// (used by sticker code that stores lat/lng in dataset)
export function stage4LatLngFromClientCoords(clientX, clientY) {
  var coord = clientToLngLat(clientX, clientY);
  if (!coord) return null;
  return { lat: coord[1], lng: coord[0] };
}

// Convert [lng, lat] to client coordinates, accounting for Maptastic transform
function lngLatToClient(lngLat) {
  if (!state.map) return null;
  var dom = state.dom;
  try {
    var pt = state.map.project(lngLat);
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

// --- Hand draw state management ---

function getHandDrawState(pointerId) {
  if (!handDrawStates[pointerId]) {
    handDrawStates[pointerId] = {
      color: null,
      isDrawing: false,
      lastContainerPt: null,
      activeStroke: null,
      buttonEl: null,
      triggerTagId: ''
    };
  }
  return handDrawStates[pointerId];
}

export function activateDrawingForPointer(pointerId, color, buttonEl) {
  var hs = getHandDrawState(pointerId);
  if (hs.buttonEl && hs.buttonEl !== buttonEl) {
    hs.buttonEl.classList.remove('ui-draw--active');
  }
  hs.color = color;
  hs.buttonEl = buttonEl || null;
  hs.triggerTagId = normalizeTagId(buttonEl && buttonEl.dataset ? buttonEl.dataset.triggerTagId : '');
  if (hs.buttonEl) {
    hs.buttonEl.classList.add('ui-draw--active');
  }
  updateDrawModeVisuals();
}

export function deactivateDrawingForPointer(pointerId) {
  var hs = handDrawStates[pointerId];
  if (hs) {
    if (hs.activeStroke) {
      finalizeStrokeGeometry(hs.activeStroke);
    }
    if (hs.isDrawing) {
      hs.isDrawing = false;
    }
    hs.activeStroke = null;
    if (hs.buttonEl) {
      hs.buttonEl.classList.remove('ui-draw--active');
    }
    delete handDrawStates[pointerId];
  }
  updateDrawModeVisuals();
}

export function isAnyDrawingActive() {
  for (var pid in handDrawStates) {
    if (handDrawStates[pid].color) return true;
  }
  return false;
}

export function getDrawColorForPointer(pointerId) {
  var hs = handDrawStates[pointerId];
  return hs ? hs.color : null;
}

export function getActiveDrawingPointerIds() {
  var ids = [];
  for (var pid in handDrawStates) {
    if (handDrawStates[pid].color) ids.push(parseInt(pid, 10));
  }
  return ids;
}

export function cleanupDrawingForMissingPointers(activePointerIds) {
  var activeSet = {};
  for (var i = 0; i < activePointerIds.length; i++) activeSet[activePointerIds[i]] = true;
  for (var pid in handDrawStates) {
    if (!activeSet[pid]) deactivateDrawingForPointer(parseInt(pid, 10));
  }
}

function updateDrawModeVisuals() {
  var anyActive = isAnyDrawingActive();
  var dom = state.dom;
  state.stage4DrawMode = anyActive;
  if (dom.leafletMapEl) {
    dom.leafletMapEl.classList.toggle('leaflet-map--draw-active', anyActive && state.stage === 4 && state.viewMode === 'map');
  }
  updateStage4MapInteractivity();
}

// --- Stroke creation helper (removes duplication) ---

function resolveBaseMapMode(mode) {
  return mode === BASE_MAP_MODE_MONO ? BASE_MAP_MODE_MONO : BASE_MAP_MODE_DEFAULT;
}

function getBaseTilesForMode(mode) {
  var resolved = resolveBaseMapMode(mode);
  var tiles = BASE_TILES_BY_MODE[resolved];
  return Array.isArray(tiles) && tiles.length > 0 ? tiles : BASE_TILES_BY_MODE.default;
}

function getBaseLayerPaintForMode(mode) {
  var resolved = resolveBaseMapMode(mode);
  if (resolved === BASE_MAP_MODE_MONO) {
    return {
      'raster-opacity': 1,
      'raster-brightness-min': 0.05,
      'raster-brightness-max': 0.75,
      'raster-contrast': 0.35,
      'raster-saturation': -0.15
    };
  }
  return { 'raster-opacity': 1 };
}

function applyBaseTilesToMap() {
  if (!state.map || !state.mapReady) return;
  var map = state.map;
  var beforeId = null;
  try {
    var style = map.getStyle();
    var layers = style && Array.isArray(style.layers) ? style.layers : [];
    for (var i = 0; i < layers.length; i++) {
      var lid = layers[i] && layers[i].id ? layers[i].id : '';
      if (lid && lid !== BASE_TILES_LAYER_ID) {
        beforeId = lid;
        break;
      }
    }
  } catch (e) { /* ignore */ }

  try {
    if (map.getLayer(BASE_TILES_LAYER_ID)) map.removeLayer(BASE_TILES_LAYER_ID);
  } catch (e1) { /* ignore */ }
  try {
    if (map.getSource(BASE_TILES_SOURCE_ID)) map.removeSource(BASE_TILES_SOURCE_ID);
  } catch (e2) { /* ignore */ }

  map.addSource(BASE_TILES_SOURCE_ID, {
    type: 'raster',
    tiles: getBaseTilesForMode(baseMapMode),
    tileSize: 256,
    maxzoom: 19
  });

  map.addLayer({
    id: BASE_TILES_LAYER_ID,
    type: 'raster',
    source: BASE_TILES_SOURCE_ID,
    paint: getBaseLayerPaintForMode(baseMapMode)
  }, beforeId || undefined);
}

export function setMapBaseMode(mode) {
  baseMapMode = resolveBaseMapMode(mode);
  applyBaseTilesToMap();
}

export function getMapBaseMode() {
  return baseMapMode;
}

function distanceSqPoints(a, b) {
  if (!a || !b) return Infinity;
  var dx = a.x - b.x;
  var dy = a.y - b.y;
  return dx * dx + dy * dy;
}

function isNearlyCollinear(a, b, c) {
  if (!a || !b || !c) return false;
  var abx = b.x - a.x;
  var aby = b.y - a.y;
  var bcx = c.x - b.x;
  var bcy = c.y - b.y;
  var abLen = Math.sqrt(abx * abx + aby * aby);
  var bcLen = Math.sqrt(bcx * bcx + bcy * bcy);
  if (abLen < 1e-6 || bcLen < 1e-6) return true;
  var crossSin = Math.abs(abx * bcy - aby * bcx) / (abLen * bcLen);
  var dot = abx * bcx + aby * bcy;
  return dot > 0 && crossSin < LIVE_SIMPLIFY_COLLINEAR_SIN_THRESHOLD;
}

function projectCoordsToMapPoints(coords, map) {
  if (!Array.isArray(coords)) return null;
  var points = [];
  for (var i = 0; i < coords.length; i++) {
    var pt = map.project(coords[i]);
    if (!pt || !isFinite(pt.x) || !isFinite(pt.y)) return null;
    points.push({ x: pt.x, y: pt.y });
  }
  return points;
}

function pointSegmentDistanceSq(point, a, b) {
  var abx = b.x - a.x;
  var aby = b.y - a.y;
  var apx = point.x - a.x;
  var apy = point.y - a.y;
  var abLenSq = abx * abx + aby * aby;
  if (abLenSq < 1e-9) return distanceSqPoints(point, a);
  var t = (apx * abx + apy * aby) / abLenSq;
  if (t < 0) t = 0;
  if (t > 1) t = 1;
  var cx = a.x + t * abx;
  var cy = a.y + t * aby;
  var dx = point.x - cx;
  var dy = point.y - cy;
  return dx * dx + dy * dy;
}

function simplifyCoordsRdpInPixels(rawCoords, map, tolerancePx) {
  if (!Array.isArray(rawCoords) || rawCoords.length < 3 || !map) return Array.isArray(rawCoords) ? rawCoords.slice() : [];
  var points = projectCoordsToMapPoints(rawCoords, map);
  if (!points || points.length !== rawCoords.length) return rawCoords.slice();

  var n = points.length;
  var keep = new Array(n);
  for (var i = 0; i < n; i++) keep[i] = false;
  keep[0] = true;
  keep[n - 1] = true;

  var tolSq = Math.max(0.01, tolerancePx * tolerancePx);
  var stack = [{ start: 0, end: n - 1 }];

  while (stack.length > 0) {
    var seg = stack.pop();
    var start = seg.start;
    var end = seg.end;
    var a = points[start];
    var b = points[end];

    var maxDistSq = -1;
    var maxIdx = -1;
    for (var j = start + 1; j < end; j++) {
      var dSq = pointSegmentDistanceSq(points[j], a, b);
      if (dSq > maxDistSq) {
        maxDistSq = dSq;
        maxIdx = j;
      }
    }

    if (maxIdx !== -1 && maxDistSq > tolSq) {
      keep[maxIdx] = true;
      if ((maxIdx - start) > 1) stack.push({ start: start, end: maxIdx });
      if ((end - maxIdx) > 1) stack.push({ start: maxIdx, end: end });
    }
  }

  var out = [];
  for (var k = 0; k < n; k++) {
    if (keep[k]) out.push(rawCoords[k]);
  }
  return out.length >= 2 ? out : rawCoords.slice();
}

function upsertLiveSimplifiedCoordinate(stroke, coord, coordPt) {
  if (!stroke || !coord || !coordPt) return;
  var liveCoords = stroke.liveCoords;
  var livePts = stroke.livePts;

  if (livePts.length !== liveCoords.length) {
    stroke.livePts = projectCoordsToMapPoints(liveCoords, state.map) || [];
    livePts = stroke.livePts;
  }

  if (livePts.length !== liveCoords.length) {
    liveCoords.push(coord);
    livePts.push({ x: coordPt.x, y: coordPt.y });
    return;
  }

  var len = liveCoords.length;

  if (len < 1) {
    liveCoords.push(coord);
    livePts.push({ x: coordPt.x, y: coordPt.y });
    return;
  }

  var lastPt = livePts[len - 1];
  if (distanceSqPoints(lastPt, coordPt) < LIVE_SIMPLIFY_MIN_DISTANCE_SQ) {
    liveCoords[len - 1] = coord;
    livePts[len - 1] = { x: coordPt.x, y: coordPt.y };
    return;
  }

  if (len >= 2 && isNearlyCollinear(livePts[len - 2], livePts[len - 1], coordPt)) {
    liveCoords[len - 1] = coord;
    livePts[len - 1] = { x: coordPt.x, y: coordPt.y };
    return;
  }

  liveCoords.push(coord);
  livePts.push({ x: coordPt.x, y: coordPt.y });
}

function finalizeStrokeGeometry(stroke) {
  if (!stroke || !stroke.ref || !stroke.ref.sourceId || !state.map) return;
  var raw = Array.isArray(stroke.rawCoords) ? stroke.rawCoords : [];
  if (raw.length < 1) return;

  var finalCoords = raw.length >= 3
    ? simplifyCoordsRdpInPixels(raw, state.map, FINAL_SIMPLIFY_TOLERANCE_PX)
    : raw.slice();

  if (!finalCoords || finalCoords.length < 1) finalCoords = raw.slice();
  stroke.liveCoords = finalCoords;
  stroke.livePts = projectCoordsToMapPoints(finalCoords, state.map) || [];
  updateLineCoords(state.map, stroke.ref.sourceId, finalCoords);
}

function createStrokeRef(coord, color, sessionId, triggerTagId) {
  var map = state.map;
  var strokeId = 'stroke_' + (nextStrokeId++);
  var baseId = nextId('stroke');
  var sourceId = baseId + '-src';
  var glowLayerId = baseId + '-gl';
  var mainLayerId = baseId + '-mn';

  map.addSource(sourceId, {
    type: 'geojson',
    data: { type: 'Feature', properties: {}, geometry: { type: 'LineString', coordinates: [coord] } }
  });

  map.addLayer({
    id: glowLayerId,
    type: 'line',
    source: sourceId,
    paint: {
      'line-color': color || '#2bb8ff',
      'line-width': STROKE_GLOW_WEIGHT,
      'line-opacity': STROKE_GLOW_OPACITY
    },
    layout: { 'line-cap': 'round', 'line-join': 'round' }
  });

  map.addLayer({
    id: mainLayerId,
    type: 'line',
    source: sourceId,
    paint: {
      'line-color': color || '#2bb8ff',
      'line-width': STROKE_MAIN_WEIGHT,
      'line-opacity': STROKE_MAIN_OPACITY
    },
    layout: { 'line-cap': 'round', 'line-join': 'round' }
  });

  var ref = {
    sourceId: sourceId,
    layerId: mainLayerId,
    fillLayerId: glowLayerId,
    glowLayerId: glowLayerId,
    sessionId: sessionId || '',
    triggerTagId: triggerTagId || '',
    strokeId: strokeId,
    isGlow: false
  };
  addToGroup(state.drawGroup, ref);
  return ref;
}

function appendCoordToStroke(stroke, coord, coordPt) {
  if (!stroke || !stroke.ref || !stroke.ref.sourceId || !coord || !coordPt || !state.map) return;
  stroke.rawCoords.push(coord);
  upsertLiveSimplifiedCoordinate(stroke, coord, coordPt);
  updateLineCoords(state.map, stroke.ref.sourceId, stroke.liveCoords);
}

function createStrokePair(coord, color, sessionId, triggerTagId) {
  var ref = createStrokeRef(coord, color, sessionId, triggerTagId);
  var pt = state.map.project(coord);
  var projPt = (pt && isFinite(pt.x) && isFinite(pt.y)) ? { x: pt.x, y: pt.y } : null;
  return {
    ref: ref,
    rawCoords: [coord],
    liveCoords: [coord],
    livePts: projPt ? [projPt] : []
  };
}

// --- Drawing event handlers ---

export function stage4PointerdownOnMap(e) {
  if (state.stage !== 4 || state.viewMode !== 'map') return;
  if (!state.map || !state.drawGroup) return;
  if (e.button !== 0) return;
  if (e.target && e.target.closest && e.target.closest('.hamburger-menu')) return;

  var pointerId = e.pointerId;
  var hs = handDrawStates[pointerId];
  if (!hs || !hs.color) return;

  var coord = clientToLngLat(e.clientX, e.clientY);
  if (!coord) return;

  e.preventDefault();
  e.stopPropagation();

  hs.isDrawing = true;
  hs.lastContainerPt = null;
  var stroke = createStrokePair(coord, hs.color, state.currentMapSessionId, hs.triggerTagId);
  hs.activeStroke = stroke;

  if (pointerId < 100) {
    var dom = state.dom;
    if (dom.leafletMapEl.setPointerCapture) {
      try { dom.leafletMapEl.setPointerCapture(pointerId); } catch (err) { /* ignore */ }
    }
  }
}

export function stage4PointermoveOnMap(e) {
  if (state.stage !== 4 || state.viewMode !== 'map') return;
  if (!state.map) return;

  var pointerId = e.pointerId;
  var hs = handDrawStates[pointerId];
  if (!hs || !hs.isDrawing || !hs.activeStroke) return;

  e.preventDefault();
  e.stopPropagation();

  var coord = clientToLngLat(e.clientX, e.clientY);
  if (!coord) return;

  var pt = state.map.project(coord);
  if (pt && hs.lastContainerPt) {
    var dx = pt.x - hs.lastContainerPt.x;
    var dy = pt.y - hs.lastContainerPt.y;
    if ((dx * dx + dy * dy) < MIN_MOVE_DISTANCE_SQ) return;
  }

  if (pt) hs.lastContainerPt = { x: pt.x, y: pt.y };
  appendCoordToStroke(hs.activeStroke, coord, pt);
}

export function stage4StopDrawing(e) {
  var pointerId = e.pointerId;
  var hs = handDrawStates[pointerId];
  if (!hs || !hs.isDrawing) return;

  hs.isDrawing = false;
  hs.lastContainerPt = null;
  if (hs.activeStroke) finalizeStrokeGeometry(hs.activeStroke);
  hs.activeStroke = null;

  if (pointerId < 100) {
    var dom = state.dom;
    if (dom.leafletMapEl && dom.leafletMapEl.releasePointerCapture) {
      try { dom.leafletMapEl.releasePointerCapture(pointerId); } catch (err) { /* ignore */ }
    }
  }
}

export function startDrawingAtPoint(pointerId, clientX, clientY) {
  if (state.stage !== 4 || state.viewMode !== 'map') return;
  if (!state.map || !state.drawGroup) return;

  var hs = handDrawStates[pointerId];
  if (!hs || !hs.color) return;

  var coord = clientToLngLat(clientX, clientY);
  if (!coord) return;

  hs.isDrawing = true;
  hs.lastContainerPt = null;
  var stroke = createStrokePair(coord, hs.color, state.currentMapSessionId, hs.triggerTagId);
  hs.activeStroke = stroke;
}

export function continueDrawingAtPoint(pointerId, clientX, clientY) {
  if (!state.map) return;
  var hs = handDrawStates[pointerId];
  if (!hs || !hs.isDrawing || !hs.activeStroke) return;

  var coord = clientToLngLat(clientX, clientY);
  if (!coord) return;

  var pt = state.map.project(coord);
  if (pt && hs.lastContainerPt) {
    var dx = pt.x - hs.lastContainerPt.x;
    var dy = pt.y - hs.lastContainerPt.y;
    if ((dx * dx + dy * dy) < MIN_MOVE_DISTANCE_SQ) return;
  }

  if (pt) hs.lastContainerPt = { x: pt.x, y: pt.y };
  appendCoordToStroke(hs.activeStroke, coord, pt);
}

export function stopDrawingForPointer(pointerId) {
  var hs = handDrawStates[pointerId];
  if (!hs) return;
  hs.isDrawing = false;
  hs.lastContainerPt = null;
  if (hs.activeStroke) finalizeStrokeGeometry(hs.activeStroke);
  hs.activeStroke = null;
}

export function setStage4DrawMode(enabled, color) {
  if (!enabled) {
    for (var pid in handDrawStates) {
      deactivateDrawingForPointer(parseInt(pid, 10));
    }
  }
  state.stage4DrawMode = !!enabled;
  if (color) state.stage4DrawColor = color;
  updateDrawModeVisuals();
}

export function updateStage4MapInteractivity() {
  if (!state.map) return;
  var anyDrawing = isAnyDrawingActive();
  if (state.stage === 4 && state.viewMode === 'map' && anyDrawing) {
    state.map.dragPan.disable();
    state.map.scrollZoom.disable();
    state.map.doubleClickZoom.disable();
    return;
  }
  state.map.dragPan.enable();
  state.map.scrollZoom.enable();
  state.map.doubleClickZoom.enable();
}

// --- Sticker sync ---

function shouldSyncStickers() {
  if (state.viewMode !== 'map') return false;
  if (state.stage !== 3 && state.stage !== 4) return false;
  if (!state.map || !state.dom) return false;
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
  if (el.classList.contains('ui-layer-square')) return null;
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
  var els = overlayEl.querySelectorAll('.ui-sticker-instance.ui-dot:not(.ui-layer-square), .ui-sticker-instance.ui-note');

  for (var i = 0; i < els.length; i++) {
    var el = els[i];
    if (!el || !el.dataset) continue;
    if (isStickerDragging(el)) continue;
    if (el.dataset.followPrimary === '1') continue;

    var lat = parseFloat(el.dataset.mapLat);
    var lng = parseFloat(el.dataset.mapLng);

    if (!isFinite(lat) || !isFinite(lng)) {
      var ll = bindStickerLatLngFromCurrentPosition(el);
      if (!ll) continue;
      lat = ll.lat;
      lng = ll.lng;
    }

    var client = lngLatToClient([lng, lat]);
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

// --- OSM Buildings ---

function buildOverpassBuildingQuery(south, west, north, east) {
  return '[out:json][timeout:20];(way["building"](' + south + ',' + west + ',' + north + ',' + east + ');relation["building"](' + south + ',' + west + ',' + north + ',' + east + '););out geom;';
}

function closeRingCoordinates(coords) {
  if (!Array.isArray(coords) || coords.length < 3) return null;
  var out = [];
  for (var i = 0; i < coords.length; i++) {
    var c = coords[i];
    if (!Array.isArray(c) || c.length < 2) continue;
    var lng = parseFloat(c[0]);
    var lat = parseFloat(c[1]);
    if (!isFinite(lat) || !isFinite(lng)) continue;
    out.push([lng, lat]);
  }
  if (out.length < 3) return null;
  var first = out[0];
  var last = out[out.length - 1];
  if (first[0] !== last[0] || first[1] !== last[1]) {
    out.push([first[0], first[1]]);
  }
  return out.length >= 4 ? out : null;
}

function wayElementToPolygonFeature(element) {
  if (!element || !Array.isArray(element.geometry)) return null;
  var ring = [];
  for (var i = 0; i < element.geometry.length; i++) {
    var pt = element.geometry[i];
    if (!pt) continue;
    ring.push([pt.lon, pt.lat]);
  }
  var closed = closeRingCoordinates(ring);
  if (!closed) return null;
  return {
    type: 'Feature',
    properties: { osmType: 'way', osmId: element.id || null },
    geometry: { type: 'Polygon', coordinates: [closed] }
  };
}

function relationElementToPolygonFeatures(element) {
  var features = [];
  if (!element || !Array.isArray(element.members)) return features;
  for (var i = 0; i < element.members.length; i++) {
    var member = element.members[i];
    if (!member || member.type !== 'way' || member.role === 'inner') continue;
    if (!Array.isArray(member.geometry)) continue;
    var ring = [];
    for (var j = 0; j < member.geometry.length; j++) {
      var pt = member.geometry[j];
      if (!pt) continue;
      ring.push([pt.lon, pt.lat]);
    }
    var closed = closeRingCoordinates(ring);
    if (!closed) continue;
    features.push({
      type: 'Feature',
      properties: { osmType: 'relation', osmId: element.id || null },
      geometry: { type: 'Polygon', coordinates: [closed] }
    });
  }
  return features;
}

function overpassElementsToGeoJSON(elements) {
  var features = [];
  if (!Array.isArray(elements)) return { type: 'FeatureCollection', features: features };
  for (var i = 0; i < elements.length; i++) {
    var el = elements[i];
    if (!el) continue;
    if (el.type === 'way') {
      var wayFeature = wayElementToPolygonFeature(el);
      if (wayFeature) features.push(wayFeature);
      continue;
    }
    if (el.type === 'relation') {
      var relationFeatures = relationElementToPolygonFeatures(el);
      for (var ri = 0; ri < relationFeatures.length; ri++) features.push(relationFeatures[ri]);
    }
  }
  return { type: 'FeatureCollection', features: features };
}

function fetchOverpassBuildingsWithFallback(queryText, signal) {
  var body = 'data=' + encodeURIComponent(queryText);
  function tryEndpoint(idx) {
    if (idx >= OSM_BUILDINGS_ENDPOINTS.length) {
      return Promise.reject(new Error('All Overpass endpoints failed'));
    }
    var endpoint = OSM_BUILDINGS_ENDPOINTS[idx];
    return fetch(endpoint, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded; charset=UTF-8' },
      body: body,
      cache: 'no-store',
      signal: signal
    }).then(function(resp) {
      if (!resp.ok) throw new Error('HTTP ' + resp.status + ' from ' + endpoint);
      return resp.json();
    }).catch(function(err) {
      if (signal && signal.aborted) throw err;
      return tryEndpoint(idx + 1);
    });
  }
  return tryEndpoint(0);
}

// Fetch OSM buildings for a specific bounding box (called only from VGA apply).
// Returns a Promise that resolves when buildings are loaded into buildingsGroup.
export function fetchBuildingsForBounds(south, west, north, east) {
  if (!state.map) return Promise.resolve();
  if (!state.buildingsGroup) state.buildingsGroup = createLayerGroup();

  var map = state.map;
  clearGroup(map, state.buildingsGroup);

  if (stage4OsmBuildingsState.fetchAbortController) {
    stage4OsmBuildingsState.fetchAbortController.abort();
  }
  var controller = (typeof AbortController !== 'undefined') ? new AbortController() : null;
  stage4OsmBuildingsState.fetchAbortController = controller;

  var query = buildOverpassBuildingQuery(south, west, north, east);
  return fetchOverpassBuildingsWithFallback(query, controller ? controller.signal : undefined).then(function(payload) {
    if (controller && controller.signal && controller.signal.aborted) return;
    var geojson = overpassElementsToGeoJSON(payload && payload.elements ? payload.elements : []);
    clearGroup(map, state.buildingsGroup);
    var features = geojson.features || [];
    for (var i = 0; i < features.length; i++) {
      var f = features[i];
      if (!f || !f.geometry || f.geometry.type !== 'Polygon') continue;
      var ref = addPolygon(map, f.geometry.coordinates, {
        color: '#34455a', weight: BUILDING_STROKE_WEIGHT, opacity: 0.95,
        fillColor: '#5f7288', fillOpacity: BUILDING_FILL_OPACITY, fill: true
      });
      ref.feature = f;
      addToGroup(state.buildingsGroup, ref);
    }
  }).catch(function(err) {
    if (controller && controller.signal && controller.signal.aborted) return;
    console.warn('Failed to load OSM building obstacles:', err);
  });
}

// --- Route (Shortest Path) ---

function clearStage4RouteLine() {
  if (stage4RouteState.routeLine) {
    removeFromGroup(state.map, state.routeGroup, stage4RouteState.routeLine);
    stage4RouteState.routeLine = null;
  }
  if (stage4RouteState.routeTooltip) {
    try { stage4RouteState.routeTooltip.remove(); } catch (e) { /* ignore */ }
    stage4RouteState.routeTooltip = null;
  }
}

function clearStage4RouteSelection() {
  clearStage4RouteLine();
  if (stage4RouteState.startMarker) {
    removeFromGroup(state.map, state.routeGroup, stage4RouteState.startMarker);
    stage4RouteState.startMarker = null;
  }
  if (stage4RouteState.endMarker) {
    removeFromGroup(state.map, state.routeGroup, stage4RouteState.endMarker);
    stage4RouteState.endMarker = null;
  }
  stage4RouteState.start = null;
  stage4RouteState.end = null;
}

export function clearStage4ShortestPath() {
  stage4RouteState.requestId++;
  clearStage4RouteSelection();
}

function upsertStage4RouteMarker(key, lngLat) {
  if (!state.routeGroup || !state.map) return;
  var markerKey = key + 'Marker';
  if (stage4RouteState[markerKey]) {
    removeFromGroup(state.map, state.routeGroup, stage4RouteState[markerKey]);
  }
  var fillColor = key === 'start' ? '#2ec27e' : '#ff5a5f';
  stage4RouteState[markerKey] = addCircleMarker(state.map, lngLat, {
    radius: ROUTE_MARKER_RADIUS, color: '#ffffff', weight: 2,
    fillColor: fillColor, fillOpacity: 1
  });
  addToGroup(state.routeGroup, stage4RouteState[markerKey]);
  stage4RouteState[key] = lngLat;
}

function buildOsrmRouteUrl(startLngLat, endLngLat) {
  if (!startLngLat || !endLngLat) return null;
  return OSRM_ROUTE_BASE_URL + startLngLat[0] + ',' + startLngLat[1] + ';' + endLngLat[0] + ',' + endLngLat[1] + '?overview=full&geometries=geojson&steps=false';
}

function renderStage4ShortestPath(routeCoords, distanceMeters, durationSeconds) {
  if (!state.routeGroup || !state.map) return;
  clearStage4RouteLine();
  if (!Array.isArray(routeCoords) || routeCoords.length < 2) return;

  stage4RouteState.routeLine = addPolyline(state.map, routeCoords, {
    color: '#ff2d55', weight: ROUTE_LINE_WEIGHT, opacity: ROUTE_LINE_OPACITY,
    lineCap: 'round', lineJoin: 'round'
  });
  addToGroup(state.routeGroup, stage4RouteState.routeLine);

  var distKm = isFinite(distanceMeters) ? (distanceMeters / 1000) : NaN;
  var durationMin = isFinite(durationSeconds) ? (durationSeconds / 60) : NaN;
  if (isFinite(distKm) && isFinite(durationMin) && stage4RouteState.end) {
    var routeSummary = distKm.toFixed(2) + ' km | ' + Math.round(durationMin) + ' min';
    try {
      stage4RouteState.routeTooltip = new window.maplibregl.Popup({
        closeButton: false, closeOnClick: false, offset: [0, -10]
      }).setLngLat(stage4RouteState.end).setText(routeSummary).addTo(state.map);
    } catch (e) { /* ignore */ }
  }
}

function requestStage4ShortestPath(startLngLat, endLngLat, requestId) {
  var url = buildOsrmRouteUrl(startLngLat, endLngLat);
  if (!url) return;

  fetch(url, { cache: 'no-store' }).then(function(resp) {
    if (!resp.ok) throw new Error('HTTP ' + resp.status);
    return resp.json();
  }).then(function(payload) {
    if (requestId !== stage4RouteState.requestId) return;
    if (!payload || payload.code !== 'Ok' || !Array.isArray(payload.routes) || payload.routes.length < 1) {
      throw new Error('No route found');
    }
    var firstRoute = payload.routes[0];
    var geometry = firstRoute && firstRoute.geometry ? firstRoute.geometry : null;
    var coords = geometry && Array.isArray(geometry.coordinates) ? geometry.coordinates : null;
    if (!coords || coords.length < 2) throw new Error('Invalid route geometry');

    // OSRM returns [lng, lat] (GeoJSON), use directly
    var routeCoords = [];
    for (var i = 0; i < coords.length; i++) {
      var pair = coords[i];
      if (!Array.isArray(pair) || pair.length < 2) continue;
      var lng = parseFloat(pair[0]);
      var lat = parseFloat(pair[1]);
      if (!isFinite(lat) || !isFinite(lng)) continue;
      routeCoords.push([lng, lat]);
    }
    if (routeCoords.length < 2) throw new Error('Route geometry is empty');

    renderStage4ShortestPath(routeCoords, firstRoute.distance, firstRoute.duration);
  }).catch(function(err) {
    if (requestId !== stage4RouteState.requestId) return;
    clearStage4RouteLine();
    console.warn('Stage 4 shortest-path request failed:', err);
  });
}

export function setStage4ShortestPathEndpoints(startLatLng, endLatLng) {
  // Accept {lat, lng} objects for backward compatibility with gesture code
  var startLngLat = startLatLng ? [startLatLng.lng, startLatLng.lat] : null;
  var endLngLat = endLatLng ? [endLatLng.lng, endLatLng.lat] : null;
  if (!startLngLat || !endLngLat) return;
  if (!state.map || !state.routeGroup) return;

  stage4RouteState.requestId++;
  clearStage4RouteSelection();
  upsertStage4RouteMarker('start', startLngLat);
  upsertStage4RouteMarker('end', endLngLat);
  requestStage4ShortestPath(startLngLat, endLngLat, stage4RouteState.requestId);
}

// --- Isovist ---

function clearStage4Isovist() {
  if (stage4IsovistState.polygon) {
    removeFromGroup(state.map, state.isovistGroup, stage4IsovistState.polygon);
    stage4IsovistState.polygon = null;
  }
  if (stage4IsovistState.originMarker) {
    removeFromGroup(state.map, state.isovistGroup, stage4IsovistState.originMarker);
    stage4IsovistState.originMarker = null;
  }
}

function metersToPixels(meters, latitude, zoom) {
  var metersPerPixel = 156543.03392 * Math.cos(latitude * Math.PI / 180) / Math.pow(2, zoom);
  if (!isFinite(metersPerPixel) || metersPerPixel <= 0) return 0;
  return meters / metersPerPixel;
}

// Project [lng, lat] coords to container pixel [x, y] for isovist geometry collection
function projectCoordsToContainer(coords) {
  if (!Array.isArray(coords) || coords.length < 1 || !state.map) return [];
  var projected = [];
  for (var i = 0; i < coords.length; i++) {
    var c = coords[i];
    if (!c || !isFinite(c[0]) || !isFinite(c[1])) continue;
    var pt = state.map.project(c);
    if (!pt || !isFinite(pt.x) || !isFinite(pt.y)) continue;
    var prev = projected.length > 0 ? projected[projected.length - 1] : null;
    if (prev) {
      var dx = pt.x - prev[0];
      var dy = pt.y - prev[1];
      if ((dx * dx + dy * dy) < 0.25) continue;
    }
    projected.push([pt.x, pt.y]);
  }
  if (projected.length > 1) {
    var first = projected[0];
    var last = projected[projected.length - 1];
    var fdx = first[0] - last[0];
    var fdy = first[1] - last[1];
    if ((fdx * fdx + fdy * fdy) < 0.25) projected.pop();
  }
  return projected;
}

function windowBbox(originPt, radiusPx) {
  return {
    minX: originPt.x - radiusPx, minY: originPt.y - radiusPx,
    maxX: originPt.x + radiusPx, maxY: originPt.y + radiusPx
  };
}

function segmentIntersectsWindow(a, b, win) {
  if (!a || !b || !win) return false;
  var minX = Math.min(a[0], b[0]);
  var minY = Math.min(a[1], b[1]);
  var maxX = Math.max(a[0], b[0]);
  var maxY = Math.max(a[1], b[1]);
  return !(maxX < win.minX || minX > win.maxX || maxY < win.minY || minY > win.maxY);
}

function polygonIntersectsWindow(points, win) {
  if (!Array.isArray(points) || points.length < 3 || !win) return false;
  var minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
  for (var i = 0; i < points.length; i++) {
    var p = points[i];
    minX = Math.min(minX, p[0]); minY = Math.min(minY, p[1]);
    maxX = Math.max(maxX, p[0]); maxY = Math.max(maxY, p[1]);
  }
  return !(maxX < win.minX || minX > win.maxX || maxY < win.minY || minY > win.maxY);
}

function appendGeometryFromCoords(coords, closeRing, polygons, segments, win) {
  if (!Array.isArray(coords) || coords.length < 2) return;
  var points = projectCoordsToContainer(coords);
  if (points.length < 2) return;

  if (closeRing && points.length >= 3 && polygonIntersectsWindow(points, win)) {
    polygons.push(points);
    return;
  }
  for (var i = 1; i < points.length; i++) {
    var a = points[i - 1];
    var b = points[i];
    if (!segmentIntersectsWindow(a, b, win)) continue;
    segments.push([[a[0], a[1]], [b[0], b[1]]]);
  }
}

// Collect isovist geometry from draw and buildings groups
function collectIsovistGeometry(originPt, radiusPx) {
  var polygons = [];
  var segments = [];
  if (!state.map) return { polygons: polygons, segments: segments };
  var win = windowBbox(originPt, radiusPx * 1.2);

  // Collect from draw strokes (line geometry)
  if (state.drawGroup) {
    eachInGroup(state.drawGroup, function(ref) {
      if (!ref || !ref.sourceId) return;
      try {
        var src = state.map.getSource(ref.sourceId);
        if (!src || !src._data) return;
        var geom = src._data.geometry;
        if (!geom) return;
        if (geom.type === 'LineString') {
          appendGeometryFromCoords(geom.coordinates, false, polygons, segments, win);
        }
      } catch (e) { /* ignore */ }
    });
  }

  // Collect from buildings (polygon geometry)
  if (state.buildingsGroup) {
    eachInGroup(state.buildingsGroup, function(ref) {
      if (!ref || !ref.sourceId) return;
      try {
        var src = state.map.getSource(ref.sourceId);
        if (!src || !src._data) return;
        var geom = src._data.geometry;
        if (!geom) return;
        if (geom.type === 'Polygon' && Array.isArray(geom.coordinates)) {
          for (var ri = 0; ri < geom.coordinates.length; ri++) {
            appendGeometryFromCoords(geom.coordinates[ri], true, polygons, segments, win);
          }
        }
      } catch (e) { /* ignore */ }
    });
  }

  return { polygons: polygons, segments: segments };
}

function buildBoundaryPolygon(originPt, radiusPx, sides) {
  var n = Math.max(8, Math.floor(sides || 24));
  var points = [];
  for (var i = 0; i < n; i++) {
    var a = (i / n) * Math.PI * 2;
    points.push([
      originPt.x + Math.cos(a) * radiusPx,
      originPt.y + Math.sin(a) * radiusPx
    ]);
  }
  return points;
}

function polygonAreaPx(points) {
  if (!Array.isArray(points) || points.length < 3) return 0;
  var sum = 0;
  for (var i = 0; i < points.length; i++) {
    var a = points[i];
    var b = points[(i + 1) % points.length];
    if (!a || !b) continue;
    sum += (a[0] * b[1]) - (b[0] * a[1]);
  }
  return Math.abs(sum) * 0.5;
}

function computeStage4IsovistResult(latlng) {
  if (!state.map) return null;
  // Accept {lat, lng} object
  var lat = latlng && isFinite(latlng.lat) ? latlng.lat : NaN;
  var lng = latlng && isFinite(latlng.lng) ? latlng.lng : NaN;
  if (!isFinite(lat) || !isFinite(lng)) return null;

  var originPt = state.map.project([lng, lat]);
  if (!originPt || !isFinite(originPt.x) || !isFinite(originPt.y)) return null;

  var radiusPx = metersToPixels(ISOVIST_RADIUS_METERS, lat, state.map.getZoom());
  if (!isFinite(radiusPx) || radiusPx <= 1) return null;

  var geom = collectIsovistGeometry(originPt, radiusPx);
  var boundaryPolygon = buildBoundaryPolygon(originPt, radiusPx, ISOVIST_BOUNDARY_SIDES);
  var polygons = [boundaryPolygon].concat(geom.polygons || []);
  var allSegments = convertToSegments(polygons);
  if (Array.isArray(geom.segments) && geom.segments.length > 0) {
    for (var si = 0; si < geom.segments.length; si++) allSegments.push(geom.segments[si]);
  }

  var visibility;
  try {
    visibility = compute([originPt.x, originPt.y], breakIntersections(allSegments));
  } catch (err) {
    return null;
  }
  if (!Array.isArray(visibility) || visibility.length < 3) return null;

  var polygonContainerPts = [];
  var polygonLngLats = [];
  for (var i = 0; i < visibility.length; i++) {
    var pt = visibility[i];
    if (!pt || pt.length < 2 || !isFinite(pt[0]) || !isFinite(pt[1])) continue;
    polygonContainerPts.push([pt[0], pt[1]]);
    var ll = state.map.unproject([pt[0], pt[1]]);
    polygonLngLats.push([ll.lng, ll.lat]);
  }
  if (polygonContainerPts.length < 3 || polygonLngLats.length < 3) return null;

  // Close the ring for polygon
  var first = polygonLngLats[0];
  var last = polygonLngLats[polygonLngLats.length - 1];
  if (first[0] !== last[0] || first[1] !== last[1]) {
    polygonLngLats.push([first[0], first[1]]);
  }

  var areaPx = polygonAreaPx(polygonContainerPts);
  var radiusAreaPx = Math.PI * radiusPx * radiusPx;
  var normalizedScore = radiusAreaPx > 0 ? (areaPx / radiusAreaPx) : 0;
  if (normalizedScore < 0) normalizedScore = 0;
  if (normalizedScore > 1) normalizedScore = 1;

  return {
    originLng: lng,
    originLat: lat,
    polygonLngLats: polygonLngLats,
    areaPx: areaPx,
    normalizedScore: normalizedScore
  };
}

function renderStage4IsovistAtLatLng(latlng) {
  if (!state.map || !state.isovistGroup) return;
  var result = computeStage4IsovistResult(latlng);
  if (!result) {
    clearStage4Isovist();
    return;
  }

  clearStage4Isovist();

  stage4IsovistState.polygon = addPolygon(state.map, [result.polygonLngLats], {
    color: '#0ea5a0', weight: 2, fillColor: '#14b8a6',
    fillOpacity: ISOVIST_FILL_OPACITY, opacity: ISOVIST_STROKE_OPACITY, fill: true
  });
  addToGroup(state.isovistGroup, stage4IsovistState.polygon);

  stage4IsovistState.originMarker = addCircleMarker(state.map, [result.originLng, result.originLat], {
    radius: 6, color: '#ffffff', weight: 2, fillColor: '#0ea5a0', fillOpacity: 1
  });
  addToGroup(state.isovistGroup, stage4IsovistState.originMarker);
}

export function setStage4IsovistOrigin(latlng) {
  renderStage4IsovistAtLatLng(latlng);
}

export function computeStage4IsovistScore(latlng) {
  var result = computeStage4IsovistResult(latlng);
  if (!result) return null;
  return { score: result.normalizedScore, areaPx: result.areaPx };
}

export function clearStage4IsovistOverlay() {
  clearStage4Isovist();
}

// --- Eraser ---

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

// Get coords from a draw group layer ref (read from source)
function getCoordsFromRef(ref) {
  if (!ref || !ref.sourceId || !state.map) return null;
  try {
    var src = state.map.getSource(ref.sourceId);
    if (!src || !src._data || !src._data.geometry) return null;
    return src._data.geometry.coordinates || null;
  } catch (e) { return null; }
}

export function eraseAtPoint(clientX, clientY, radiusPx, ownerTriggerTagId) {
  if (state.stage !== 4 || state.viewMode !== 'map') return;
  if (!state.map || !state.drawGroup || !state.dom) return;
  if (!isFinite(clientX) || !isFinite(clientY)) return;

  var radius = Math.max(2, isFinite(radiusPx) ? radiusPx : 16);
  var ownerTagId = normalizeTagId(ownerTriggerTagId);
  var pointerCoord = clientToLngLat(clientX, clientY);
  if (!pointerCoord) return;
  var pointerPt = state.map.project(pointerCoord);
  if (!pointerPt) return;

  var refsToRemove = [];
  var removeStrokeIds = {};

  eachInGroup(state.drawGroup, function(ref) {
    if (!ref || !ref.sourceId) return;
    if (ownerTagId) {
      var layerOwnerTagId = normalizeTagId(ref.triggerTagId);
      if (!layerOwnerTagId || layerOwnerTagId !== ownerTagId) return;
    }
    var coords = getCoordsFromRef(ref);
    if (!coords || coords.length < 1) return;

    var minDist = Infinity;
    if (coords.length === 1) {
      var onlyPt = state.map.project(coords[0]);
      if (onlyPt) {
        var odx = pointerPt.x - onlyPt.x;
        var ody = pointerPt.y - onlyPt.y;
        minDist = Math.sqrt(odx * odx + ody * ody);
      }
    } else {
      for (var i = 1; i < coords.length; i++) {
        var a = state.map.project(coords[i - 1]);
        var b = state.map.project(coords[i]);
        if (!a || !b) continue;
        var dist = distancePointToSegmentPx(pointerPt.x, pointerPt.y, a.x, a.y, b.x, b.y);
        if (dist < minDist) minDist = dist;
      }
    }

    if (minDist <= radius) {
      refsToRemove.push(ref);
      if (ref.strokeId) removeStrokeIds[String(ref.strokeId)] = true;
    }
  });

  // Backward compatibility: if older sessions created separate glow/main refs,
  // remove any sibling refs that share the same strokeId.
  if (Object.keys(removeStrokeIds).length > 0) {
    eachInGroup(state.drawGroup, function(ref) {
      if (!ref || !ref.strokeId) return;
      if (removeStrokeIds[String(ref.strokeId)]) {
        refsToRemove.push(ref);
      }
    });
  }

  // Deduplicate and remove
  var seen = {};
  for (var lr = 0; lr < refsToRemove.length; lr++) {
    var r = refsToRemove[lr];
    if (!r || seen[r.layerId]) continue;
    seen[r.layerId] = true;
    removeFromGroup(state.map, state.drawGroup, r);
  }

  // Also erase stickers
  var overlayEl = state.dom.uiSetupOverlayEl;
  if (!overlayEl) return;
  var stickerEls = overlayEl.querySelectorAll('.ui-sticker-instance.ui-dot:not(.ui-layer-square), .ui-sticker-instance.ui-note, .ui-sticker-instance.ui-draw');
  for (var si = 0; si < stickerEls.length; si++) {
    var el = stickerEls[si];
    if (ownerTagId) {
      var stickerOwnerTagId = normalizeTagId(el && el.dataset ? el.dataset.triggerTagId : '');
      if (!stickerOwnerTagId || stickerOwnerTagId !== ownerTagId) continue;
    }
    var rect = el.getBoundingClientRect();
    if (distancePointToRectPx(clientX, clientY, rect) <= radius) {
      if (el.parentNode) el.parentNode.removeChild(el);
    }
  }
}

// --- Session filter ---

export function filterPolylinesBySession(sessionId) {
  if (!state.drawGroup || !state.map) return;
  var activeSessionId = (sessionId === null || sessionId === undefined || String(sessionId).trim() === '')
    ? '' : String(sessionId).trim();

  eachInGroup(state.drawGroup, function(ref) {
    if (!ref || !ref.layerId) return;
    var layerSessionId = (ref.sessionId === null || ref.sessionId === undefined || String(ref.sessionId).trim() === '')
      ? '' : String(ref.sessionId).trim();

    var visible = (!activeSessionId || layerSessionId === activeSessionId);
    var mainOpacity = visible ? STROKE_MAIN_OPACITY : 0;
    var glowOpacity = visible ? STROKE_GLOW_OPACITY : 0;

    if (ref.glowLayerId) {
      setPaintProp(state.map, ref.layerId, 'line-opacity', mainOpacity);
      setPaintProp(state.map, ref.glowLayerId, 'line-opacity', glowOpacity);
      return;
    }

    // Backward compatibility for older refs that used one layer per stroke visual.
    var fallbackOpacity = ref.isGlow ? glowOpacity : mainOpacity;
    setPaintProp(state.map, ref.layerId, 'line-opacity', fallbackOpacity);
  });
}

// --- Map initialization ---

export function initLeafletIfNeeded() {
  var dom = state.dom;

  if (state.map) {
    state.map.resize();
    updateStickerMappingForCurrentView();
    return;
  }

  if (!window.maplibregl || !dom.leafletMapEl) {
    console.warn('MapLibre runtime not available; map view will be blank.');
    return;
  }

  state.map = new window.maplibregl.Map({
    container: dom.leafletMapEl,
    style: { version: 8, sources: {}, layers: [] },
    center: [2.2118, 48.7133],
    zoom: 15,
    attributionControl: false,
    dragRotate: false,
    touchPitch: false,
    pitchWithRotate: false
  });

  state.map.on('load', function() {
    state.mapReady = true;

    // Base tiles (supports runtime theme switching).
    applyBaseTilesToMap();

    // Layer groups
    state.buildingsGroup = createLayerGroup();
    state.drawGroup = createLayerGroup();
    state.routeGroup = createLayerGroup();
    state.isovistGroup = createLayerGroup();

    clearStage4ShortestPath();
    clearStage4Isovist();
  });

  state.map.resize();
  updateStickerMappingForCurrentView();
}

// --- Maptastic ---

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

// --- Sticker cloning ---

export function cloneSticker(templateEl) {
  if (!templateEl) return null;
  var type = templateEl.dataset && templateEl.dataset.uiType ? templateEl.dataset.uiType : null;
  if (type !== 'dot' && type !== 'draw' && type !== 'note') return null;

  var sessionId = state.currentMapSessionId;

  if (type === 'dot') {
    var dotEl = document.createElement('div');
    dotEl.className = 'ui-dot ui-sticker-instance';
    dotEl.dataset.uiType = 'dot';
    dotEl.dataset.color = templateEl.dataset && templateEl.dataset.color ? templateEl.dataset.color : (templateEl.style.background || '#2bb8ff');
    if (templateEl.dataset && templateEl.dataset.triggerTagId) {
      dotEl.dataset.triggerTagId = String(templateEl.dataset.triggerTagId);
    }
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
    noteEl.dataset.color = templateEl.dataset && templateEl.dataset.color ? templateEl.dataset.color : (templateEl.style.background || '#2bb8ff');
    if (templateEl.dataset && templateEl.dataset.triggerTagId) {
      noteEl.dataset.triggerTagId = String(templateEl.dataset.triggerTagId);
    }
    if (sessionId) noteEl.dataset.sessionId = String(sessionId);
    noteEl.style.background = noteEl.dataset.color;
    noteEl.style.left = templateEl.style.left || '0px';
    noteEl.style.top = templateEl.style.top || '0px';

    var iconEl = document.createElement('div');
    iconEl.className = 'ui-note__icon';
    iconEl.textContent = '📝';
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
  if (templateEl.dataset && templateEl.dataset.triggerTagId) {
    drawEl.dataset.triggerTagId = String(templateEl.dataset.triggerTagId);
  }
  if (sessionId) drawEl.dataset.sessionId = String(sessionId);
  drawEl.width = 24;
  drawEl.height = 24;
  drawEl.style.left = templateEl.style.left || '0px';
  drawEl.style.top = templateEl.style.top || '0px';

  try {
    var srcCanvas = templateEl;
    if (!srcCanvas || !srcCanvas.width || !srcCanvas.height || typeof srcCanvas.getContext !== 'function') {
      srcCanvas = templateEl.querySelector ? templateEl.querySelector('canvas') : null;
    }
    var ctx = drawEl.getContext('2d');
    if (ctx && srcCanvas && srcCanvas.width && srcCanvas.height) {
      ctx.drawImage(srcCanvas, 0, 0, drawEl.width, drawEl.height);
    }
  } catch (err) { /* ignore */ }

  templateEl.parentElement.appendChild(drawEl);
  return drawEl;
}

// --- Note sticker ---

function setupNoteSticker(noteEl) {
  noteEl.addEventListener('click', function (e) {
    if (state.stage !== 4) return;
    if (e.target.closest('.ui-note__form')) return;
    if (noteEl.dataset.expanded !== 'true') {
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

    textareaEl.addEventListener('click', function (e) { e.stopPropagation(); });
    textareaEl.addEventListener('keydown', function (e) {
      e.stopPropagation();
      if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); submitBtn.click(); }
      if (e.key === 'Escape') { collapseNoteSticker(noteEl); }
    });

    formEl.appendChild(textareaEl);
    formEl.appendChild(submitBtn);
    noteEl.appendChild(formEl);
    setTimeout(function () { textareaEl.focus(); }, 50);
  } else {
    var textarea = formEl.querySelector('.ui-note__textarea');
    if (textarea) {
      textarea.value = noteEl.dataset.noteText || '';
      setTimeout(function () { textarea.focus(); }, 50);
    }
  }
}

function collapseNoteSticker(noteEl, savedText) {
  noteEl.dataset.expanded = 'false';
  noteEl.classList.remove('ui-note--expanded');
  var iconEl = noteEl.querySelector('.ui-note__icon');
  if (iconEl && savedText) iconEl.textContent = '📝✓';
  var hasText = !!String(noteEl.dataset.noteText || '').trim();
  noteEl.classList.toggle('ui-note--sticker', hasText);
}

// --- Sticker drag ---

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

  var canCapture = pointerId < 100;
  if (canCapture && el.setPointerCapture) {
    try { el.setPointerCapture(pointerId); } catch (e) { canCapture = false; }
  }

  function onMove(e) {
    if (e.pointerId !== pointerId) return;
    e.preventDefault();
    el.style.left = (e.clientX - offsetX) + 'px';
    el.style.top = (e.clientY - offsetY) + 'px';
  }

  function onEnd(e) {
    if (e.pointerId !== pointerId) return;
    el.classList.remove(draggingClass);

    if (state.viewMode === 'map' && (state.stage === 3 || state.stage === 4) && el.classList.contains('ui-sticker-instance')) {
      bindStickerLatLngFromCurrentPosition(el);
      updateStickerMappingForCurrentView();
    }

    if (options.expandNoteOnDrop && el.classList.contains('ui-note') && el.classList.contains('ui-sticker-instance')) {
      setTimeout(function() { expandNoteSticker(el); }, 50);
    }

    if (canCapture && el.releasePointerCapture) {
      try { el.releasePointerCapture(pointerId); } catch (e) { /* ignore */ }
    }
    document.removeEventListener('pointermove', onMove, true);
    document.removeEventListener('pointerup', onEnd, true);
    document.removeEventListener('pointercancel', onEnd, true);
  }

  document.addEventListener('pointermove', onMove, true);
  document.addEventListener('pointerup', onEnd, true);
  document.addEventListener('pointercancel', onEnd, true);
}
