/**
 * Stage 4 drawing tool
 * - Draw strokes on Leaflet map with finger
 * - Sticker cloning and dragging
 */

import { state } from './state.js';

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

// Handle pointer down to start drawing
export function stage4PointerdownOnMap(e) {
  if (!state.stage4DrawMode) return;
  if (state.stage !== 4 || state.viewMode !== 'map') return;
  if (!state.leafletMap || !state.stage4DrawLayer || !state.leafletGlobal) return;
  if (e.button !== 0) return;
  if (e.target && e.target.closest && e.target.closest('.hamburger-menu')) return;

  var latlng = stage4LatLngFromPointerEvent(e);
  if (!latlng) return;

  e.preventDefault();
  e.stopPropagation();

  state.stage4IsDrawing = true;
  state.stage4LastDrawContainerPt = null;
  var latlngs = [latlng];

  var L = state.leafletGlobal;
  var glow = L.polyline(latlngs, {
    color: state.stage4DrawColor,
    weight: 14,
    opacity: 0.25,
    lineCap: 'round',
    lineJoin: 'round',
    interactive: false
  }).addTo(state.stage4DrawLayer);

  var main = L.polyline(latlngs, {
    color: state.stage4DrawColor,
    weight: 7,
    opacity: 0.95,
    lineCap: 'round',
    lineJoin: 'round',
    interactive: false
  }).addTo(state.stage4DrawLayer);

  state.stage4ActiveStroke = { latlngs: latlngs, glow: glow, main: main };

  var dom = state.dom;
  if (dom.leafletMapEl.setPointerCapture) dom.leafletMapEl.setPointerCapture(e.pointerId);
}

// Handle pointer move to continue drawing
export function stage4PointermoveOnMap(e) {
  if (!state.stage4DrawMode) return;
  if (!state.stage4IsDrawing || !state.stage4ActiveStroke) return;
  if (!state.leafletMap) return;

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

  if (pt && state.stage4LastDrawContainerPt) {
    var dx = pt.x - state.stage4LastDrawContainerPt.x;
    var dy = pt.y - state.stage4LastDrawContainerPt.y;
    if ((dx * dx + dy * dy) < 4) return;
  }

  var latlng = stage4LatLngFromPointerEvent(e);
  if (!latlng) return;

  if (pt) state.stage4LastDrawContainerPt = pt;
  state.stage4ActiveStroke.latlngs.push(latlng);

  if (state.stage4ActiveStroke.glow) state.stage4ActiveStroke.glow.setLatLngs(state.stage4ActiveStroke.latlngs);
  if (state.stage4ActiveStroke.main) state.stage4ActiveStroke.main.setLatLngs(state.stage4ActiveStroke.latlngs);
}

// Handle pointer up to stop drawing
export function stage4StopDrawing(e) {
  if (!state.stage4IsDrawing) return;
  state.stage4IsDrawing = false;
  state.stage4LastDrawContainerPt = null;
  state.stage4ActiveStroke = null;

  var dom = state.dom;
  if (dom.leafletMapEl.releasePointerCapture) dom.leafletMapEl.releasePointerCapture(e.pointerId);
}

// Set draw mode on/off
export function setStage4DrawMode(enabled) {
  state.stage4DrawMode = !!enabled;
  state.stage4IsDrawing = false;
  state.stage4LastDrawContainerPt = null;
  state.stage4ActiveStroke = null;

  var active = state.stage4DrawMode && state.stage === 4 && state.viewMode === 'map';
  var dom = state.dom;
  if (dom.leafletMapEl) {
    dom.leafletMapEl.classList.toggle('leaflet-map--draw-active', active);
  }
  updateStage4MapInteractivity();
}

// Enable/disable Leaflet interactivity based on draw mode
export function updateStage4MapInteractivity() {
  if (!state.leafletMap) return;

  if (state.stage === 4 && state.viewMode === 'map' && state.stage4DrawMode) {
    if (state.leafletMap.dragging) state.leafletMap.dragging.disable();
    if (state.leafletMap.scrollWheelZoom) state.leafletMap.scrollWheelZoom.disable();
    if (state.leafletMap.doubleClickZoom) state.leafletMap.doubleClickZoom.disable();
    return;
  }

  if (state.leafletMap.dragging) state.leafletMap.dragging.enable();
  if (state.leafletMap.scrollWheelZoom) state.leafletMap.scrollWheelZoom.enable();
  if (state.leafletMap.doubleClickZoom) state.leafletMap.doubleClickZoom.enable();
}

// Initialize Leaflet map if not already done
export function initLeafletIfNeeded() {
  var dom = state.dom;

  if (state.leafletMap) {
    if (state.leafletMap) state.leafletMap.invalidateSize();
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
    inertia: true
  });

  state.leafletMap.setView([37.76, -122.44], 12);

  state.leafletTileLayer = L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png', {
    maxZoom: 19,
    crossOrigin: true
  });
  state.leafletTileLayer.addTo(state.leafletMap);

  if (typeof L !== 'undefined') {
    state.stage4DrawLayer = L.layerGroup().addTo(state.leafletMap);
  }

  if (state.leafletMap) state.leafletMap.invalidateSize();
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
    dom.mapHintEl.classList.remove('hidden');
    dom.mapHintEl.setAttribute('aria-hidden', 'false');
  } catch (err) {
    console.error('Failed to initialize Maptastic:', err);
  }
}

// Clone a sticker element
export function cloneSticker(templateEl) {
  if (!templateEl) return null;
  var type = templateEl.dataset && templateEl.dataset.uiType ? templateEl.dataset.uiType : null;
  if (type !== 'dot' && type !== 'draw') return null;

  if (type === 'dot') {
    var dotEl = document.createElement('div');
    dotEl.className = 'ui-dot ui-sticker-instance';
    dotEl.dataset.uiType = 'dot';
    dotEl.dataset.color = templateEl.dataset && templateEl.dataset.color ? templateEl.dataset.color : (templateEl.style.background || '#ff3b30');
    dotEl.style.background = dotEl.dataset.color;
    dotEl.style.left = templateEl.style.left || '0px';
    dotEl.style.top = templateEl.style.top || '0px';
    templateEl.parentElement.appendChild(dotEl);
    return dotEl;
  }

  var drawEl = document.createElement('canvas');
  drawEl.className = 'ui-draw ui-sticker-instance';
  drawEl.dataset.uiType = 'draw';
  drawEl.dataset.color = templateEl.dataset && templateEl.dataset.color ? templateEl.dataset.color : '#2bb8ff';
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

// Start dragging a sticker
export function startStickerDrag(el, startEvent) {
  if (!el || !startEvent) return;
  var draggingClass = el.classList.contains('ui-dot') ? 'ui-dot--dragging' : 'ui-draw--dragging';

  var rect = el.getBoundingClientRect();
  var offsetX = startEvent.clientX - rect.left;
  var offsetY = startEvent.clientY - rect.top;
  var pointerId = startEvent.pointerId;

  el.classList.add(draggingClass);
  if (el.setPointerCapture) el.setPointerCapture(pointerId);

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
    if (el.releasePointerCapture) el.releasePointerCapture(pointerId);
    document.removeEventListener('pointermove', onMove, true);
    document.removeEventListener('pointerup', onEnd, true);
    document.removeEventListener('pointercancel', onEnd, true);
  }

  document.addEventListener('pointermove', onMove, true);
  document.addEventListener('pointerup', onEnd, true);
  document.addEventListener('pointercancel', onEnd, true);
}
