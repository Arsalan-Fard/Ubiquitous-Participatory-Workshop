import { CONFIG } from '../static/js/config.js';
import { compute, convertToSegments, breakIntersections } from './visibility-polygon.esm.js';

mapboxgl.accessToken = CONFIG.accessToken;

const state = {
    viewCoord: [...CONFIG.center],
    maxDistanceMeters: 150
};

const emptyFeatureCollection = { type: 'FeatureCollection', features: [] };

const ui = {
    radiusInput: document.getElementById('radius-input'),
    radiusValue: document.getElementById('radius-value'),
    resetView: document.getElementById('reset-view')
};

ui.radiusValue.textContent = ui.radiusInput.value;

const map = new mapboxgl.Map({
    container: 'map',
    style: CONFIG.style,
    center: CONFIG.center,
    zoom: 16,
    pitch: 0,
    bearing: 0
});

let buildingLayerId = null;

ui.radiusInput.addEventListener('input', () => {
    state.maxDistanceMeters = Number(ui.radiusInput.value);
    ui.radiusValue.textContent = ui.radiusInput.value;
    updateIsovist();
});

ui.resetView.addEventListener('click', () => {
    state.viewCoord = [...CONFIG.center];
    updateIsovist();
});

map.on('load', () => {
    buildingLayerId = findBuildingLayerId(map);

    map.addSource('obstacles', {
        type: 'geojson',
        data: emptyFeatureCollection
    });

    map.addLayer({
        id: 'obstacles-fill',
        type: 'fill',
        source: 'obstacles',
        paint: {
            'fill-color': '#2b3a4a',
            'fill-opacity': 0.35
        }
    });

    map.addLayer({
        id: 'obstacles-line',
        type: 'line',
        source: 'obstacles',
        paint: {
            'line-color': '#0f1114',
            'line-width': 2
        }
    });

    map.addSource('isovist', {
        type: 'geojson',
        data: emptyFeatureCollection
    });

    map.addLayer({
        id: 'isovist-fill',
        type: 'fill',
        source: 'isovist',
        paint: {
            'fill-color': '#2aa4f4',
            'fill-opacity': 0.3
        }
    });

    map.addLayer({
        id: 'isovist-line',
        type: 'line',
        source: 'isovist',
        paint: {
            'line-color': '#2aa4f4',
            'line-width': 2
        }
    });

    map.addSource('viewpoint', {
        type: 'geojson',
        data: pointFeature(state.viewCoord)
    });

    map.addLayer({
        id: 'viewpoint-dot',
        type: 'circle',
        source: 'viewpoint',
        paint: {
            'circle-radius': 6,
            'circle-color': '#f4b400',
            'circle-stroke-color': '#1c1c1c',
            'circle-stroke-width': 2
        }
    });

    updateIsovist();

    map.on('click', event => {
        state.viewCoord = [event.lngLat.lng, event.lngLat.lat];
        updateIsovist();
    });

    map.on('moveend', () => {
        updateIsovist();
    });
});

function updateIsovist() {
    if (!map.isStyleLoaded()) {
        return;
    }

    const isovistSource = map.getSource('isovist');
    const viewpointSource = map.getSource('viewpoint');
    const obstaclesSource = map.getSource('obstacles');
    if (!isovistSource || !viewpointSource || !obstaclesSource) {
        return;
    }

    if (!buildingLayerId) {
        buildingLayerId = findBuildingLayerId(map);
    }

    const origin = map.project(state.viewCoord);
    const maxDistancePx = metersToPixels(state.maxDistanceMeters, state.viewCoord[1], map.getZoom());
    const obstacleData = collectObstacleData(origin, maxDistancePx);

    obstaclesSource.setData({
        type: 'FeatureCollection',
        features: obstacleData.features
    });

    const boundaryPolygon = buildBoundaryPolygon(origin, maxDistancePx);
    const polygons = [boundaryPolygon, ...obstacleData.polygons];
    const segments = breakIntersections(convertToSegments(polygons));
    const visibility = compute([origin.x, origin.y], segments);

    if (!visibility.length) {
        return;
    }

    const coordinates = visibility.map(point => {
        const lngLat = map.unproject([point[0], point[1]]);
        return [lngLat.lng, lngLat.lat];
    });
    coordinates.push(coordinates[0]);

    isovistSource.setData({
        type: 'Feature',
        geometry: {
            type: 'Polygon',
            coordinates: [coordinates]
        },
        properties: {}
    });

    viewpointSource.setData(pointFeature(state.viewCoord));
}

function findBuildingLayerId(mapInstance) {
    const layers = mapInstance.getStyle()?.layers || [];
    const bySourceLayer = layers.find(layer => layer['source-layer'] === 'building' && layer.type === 'fill')
        || layers.find(layer => layer['source-layer'] === 'building' && layer.type === 'fill-extrusion')
        || layers.find(layer => layer['source-layer'] === 'building');
    if (bySourceLayer) {
        return bySourceLayer.id;
    }
    const byId = layers.find(layer => layer.id && layer.id.toLowerCase().includes('building'));
    return byId ? byId.id : null;
}

function collectObstacleData(originPoint, radiusPx) {
    if (!buildingLayerId) {
        return { polygons: [], features: [] };
    }

    const bbox = [
        [originPoint.x - radiusPx, originPoint.y - radiusPx],
        [originPoint.x + radiusPx, originPoint.y + radiusPx]
    ];
    const rawFeatures = map.queryRenderedFeatures(bbox, { layers: [buildingLayerId] });
    const polygons = [];
    const features = [];
    let fallbackIndex = 0;

    rawFeatures.forEach(feature => {
        const geometry = feature.geometry;
        if (!geometry || (geometry.type !== 'Polygon' && geometry.type !== 'MultiPolygon')) {
            return;
        }

        const key = feature.id ?? feature.properties?.osm_id ?? feature.properties?.id;

        const projectedPolygons = geometryToPolygons(geometry, map);
        projectedPolygons.forEach(polygon => {
            if (polygon.length >= 3) {
                polygons.push(polygon);
            }
        });

        features.push({
            type: 'Feature',
            properties: {
                id: key ?? `building-${fallbackIndex++}`
            },
            geometry
        });
    });

    return { polygons, features };
}

function geometryToPolygons(geometry, mapInstance) {
    if (geometry.type === 'Polygon') {
        const ring = geometry.coordinates[0] || [];
        const projected = projectRing(ring, mapInstance);
        return projected.length >= 3 ? [projected] : [];
    }

    if (geometry.type === 'MultiPolygon') {
        const polygons = [];
        geometry.coordinates.forEach(polygon => {
            const ring = polygon[0] || [];
            const projected = projectRing(ring, mapInstance);
            if (projected.length >= 3) {
                polygons.push(projected);
            }
        });
        return polygons;
    }

    return [];
}

function projectRing(ring, mapInstance) {
    const points = ring.map(coord => {
        const projected = mapInstance.project(coord);
        return [projected.x, projected.y];
    });

    if (points.length > 1) {
        const first = points[0];
        const last = points[points.length - 1];
        if (first[0] === last[0] && first[1] === last[1]) {
            points.pop();
        }
    }

    return points;
}

function buildBoundaryPolygon(originPoint, radiusPx) {
    return [
        [originPoint.x - radiusPx, originPoint.y - radiusPx],
        [originPoint.x + radiusPx, originPoint.y - radiusPx],
        [originPoint.x + radiusPx, originPoint.y + radiusPx],
        [originPoint.x - radiusPx, originPoint.y + radiusPx]
    ];
}

function metersToPixels(meters, latitude, zoom) {
    const metersPerPixel = 156543.03392 * Math.cos(latitude * Math.PI / 180) / Math.pow(2, zoom);
    return meters / metersPerPixel;
}

function pointFeature(coord) {
    return {
        type: 'Feature',
        geometry: {
            type: 'Point',
            coordinates: coord
        },
        properties: {}
    };
}
