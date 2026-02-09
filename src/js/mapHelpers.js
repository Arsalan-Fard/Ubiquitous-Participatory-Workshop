/**
 * Lightweight MapLibre GL JS helpers.
 * Replaces the 1,092-line Leaflet compatibility adapter with direct MapLibre calls.
 * All coordinates use [lng, lat] (GeoJSON / MapLibre native order).
 */

var _nextId = 1;

export function nextId(prefix) {
  return (prefix || 'ml') + '-' + (_nextId++);
}

// --- Polyline ---

export function addPolyline(map, coords, opts) {
  opts = opts || {};
  var id = nextId('line');
  var sourceId = id + '-src';
  var layerId = id + '-ln';
  map.addSource(sourceId, {
    type: 'geojson',
    data: { type: 'Feature', properties: {}, geometry: { type: 'LineString', coordinates: coords } }
  });
  map.addLayer({
    id: layerId,
    type: 'line',
    source: sourceId,
    paint: {
      'line-color': opts.color || '#2bb8ff',
      'line-width': isFinite(opts.weight) ? opts.weight : 3,
      'line-opacity': isFinite(opts.opacity) ? opts.opacity : 1
    },
    layout: {
      'line-cap': opts.lineCap || 'round',
      'line-join': opts.lineJoin || 'round'
    }
  });
  return { sourceId: sourceId, layerId: layerId };
}

// --- Polygon ---

export function addPolygon(map, coords, opts) {
  opts = opts || {};
  var id = nextId('poly');
  var sourceId = id + '-src';
  var lineLayerId = id + '-ln';
  var fillLayerId = id + '-fl';
  map.addSource(sourceId, {
    type: 'geojson',
    data: { type: 'Feature', properties: {}, geometry: { type: 'Polygon', coordinates: coords } }
  });
  if (opts.fill !== false) {
    map.addLayer({
      id: fillLayerId,
      type: 'fill',
      source: sourceId,
      paint: {
        'fill-color': opts.fillColor || opts.color || '#2bb8ff',
        'fill-opacity': isFinite(opts.fillOpacity) ? opts.fillOpacity : 0.2
      }
    });
  }
  map.addLayer({
    id: lineLayerId,
    type: 'line',
    source: sourceId,
    paint: {
      'line-color': opts.color || '#2bb8ff',
      'line-width': isFinite(opts.weight) ? opts.weight : 3,
      'line-opacity': isFinite(opts.opacity) ? opts.opacity : 1
    },
    layout: {
      'line-cap': opts.lineCap || 'butt',
      'line-join': opts.lineJoin || 'miter'
    }
  });
  return { sourceId: sourceId, layerId: lineLayerId, fillLayerId: opts.fill !== false ? fillLayerId : null };
}

// --- Circle Marker ---

export function addCircleMarker(map, lngLat, opts) {
  opts = opts || {};
  var id = nextId('circ');
  var sourceId = id + '-src';
  var layerId = id + '-cl';
  map.addSource(sourceId, {
    type: 'geojson',
    data: { type: 'Feature', properties: {}, geometry: { type: 'Point', coordinates: lngLat } }
  });
  map.addLayer({
    id: layerId,
    type: 'circle',
    source: sourceId,
    paint: {
      'circle-radius': isFinite(opts.radius) ? opts.radius : 6,
      'circle-color': opts.fillColor || opts.color || '#2bb8ff',
      'circle-opacity': isFinite(opts.fillOpacity) ? opts.fillOpacity : 1,
      'circle-stroke-color': opts.color || '#ffffff',
      'circle-stroke-width': isFinite(opts.weight) ? opts.weight : 1,
      'circle-stroke-opacity': isFinite(opts.opacity) ? opts.opacity : 1
    }
  });
  return { sourceId: sourceId, layerId: layerId };
}

// --- Image Overlay ---

export function addImageOverlay(map, url, bounds, opts) {
  opts = opts || {};
  var id = nextId('img');
  var sourceId = id + '-src';
  var layerId = id + '-rl';
  // bounds: [[west, south], [east, north]]
  var west = bounds[0][0], south = bounds[0][1], east = bounds[1][0], north = bounds[1][1];
  map.addSource(sourceId, {
    type: 'image',
    url: url,
    coordinates: [[west, north], [east, north], [east, south], [west, south]]
  });
  map.addLayer({
    id: layerId,
    type: 'raster',
    source: sourceId,
    paint: { 'raster-opacity': isFinite(opts.opacity) ? opts.opacity : 1 }
  });
  return { sourceId: sourceId, layerId: layerId };
}

// --- Source Data Update ---

export function updateSourceData(map, sourceId, geojson) {
  try {
    var src = map.getSource(sourceId);
    if (src && typeof src.setData === 'function') src.setData(geojson);
  } catch (e) { /* ignore */ }
}

export function updateLineCoords(map, sourceId, coords) {
  updateSourceData(map, sourceId, {
    type: 'Feature', properties: {},
    geometry: { type: 'LineString', coordinates: coords }
  });
}

export function updatePolygonCoords(map, sourceId, coords) {
  updateSourceData(map, sourceId, {
    type: 'Feature', properties: {},
    geometry: { type: 'Polygon', coordinates: coords }
  });
}

export function updatePointCoord(map, sourceId, lngLat) {
  updateSourceData(map, sourceId, {
    type: 'Feature', properties: {},
    geometry: { type: 'Point', coordinates: lngLat }
  });
}

// --- Remove Layer ---

export function removeMapLayer(map, ref) {
  if (!ref || !map) return;
  try {
    if (ref.fillLayerId && map.getLayer(ref.fillLayerId)) map.removeLayer(ref.fillLayerId);
    if (ref.layerId && map.getLayer(ref.layerId)) map.removeLayer(ref.layerId);
    if (ref.sourceId && map.getSource(ref.sourceId)) map.removeSource(ref.sourceId);
  } catch (e) { /* ignore */ }
}

// --- Layer Group (plain object + array) ---

export function createLayerGroup() {
  return { layers: [] };
}

export function addToGroup(group, ref) {
  if (group && ref) group.layers.push(ref);
}

export function removeFromGroup(map, group, ref) {
  if (!group || !ref) return;
  var idx = group.layers.indexOf(ref);
  if (idx !== -1) group.layers.splice(idx, 1);
  removeMapLayer(map, ref);
}

export function clearGroup(map, group) {
  if (!group) return;
  for (var i = 0; i < group.layers.length; i++) {
    removeMapLayer(map, group.layers[i]);
  }
  group.layers = [];
}

export function eachInGroup(group, cb) {
  if (!group) return;
  var copy = group.layers.slice();
  for (var i = 0; i < copy.length; i++) cb(copy[i]);
}

// --- Set paint property helper ---

export function setPaintProp(map, layerId, prop, value) {
  try {
    if (map.getLayer(layerId)) map.setPaintProperty(layerId, prop, value);
  } catch (e) { /* ignore */ }
}
