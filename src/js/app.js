/**
 * Main application entry point
 * Coordinates all modules and handles frame processing
 */

import { getDom } from './dom.js';
import { stopCameraStream } from './camera.js';
import { clearOverlay, drawSurface } from './render.js';
import { initUiSetup } from './uiSetup.js';
import { clamp, saveNumberSetting, waitForImageLoad } from './utils.js';
import { state } from './state.js';

// Surface calibration
import {
  resetSurfaceCorners,
  recomputeSurfaceHomographyIfReady,
  clearArmedCorner,
  armCorner,
  flashCornerButton,
  updateSurfaceButtonsUI,
  setMapFingerDotsVisible,
  applyHomography
} from './surfaceCalibration.js';

// Gesture controls
import {
  handleStage3Gestures,
  resetStage3Gestures
} from './gestureControls.js';

// Stage 4 drawing
import {
  stage4PointerdownOnMap,
  stage4PointermoveOnMap,
  stage4StopDrawing,
  setStage4DrawMode,
  updateStage4MapInteractivity,
  initLeafletIfNeeded,
  initMaptasticIfNeeded,
  updateStickerMappingForCurrentView,
  cloneSticker,
  startStickerDrag,
  filterPolylinesBySession,
  setStage4ShortestPathEndpoints,
  clearStage4ShortestPath,
  setStage4IsovistOrigin,
  clearStage4IsovistOverlay,
  computeStage4IsovistScore
} from './stage4Drawing.js';

var BACKEND_CAMERA_FEED_URL = '/video_feed';
var BACKEND_APRILTAG_API_URL = '/api/apriltags';
var BACKEND_WORKSHOP_SESSION_API_URL = '/api/workshop_session';
var BACKEND_WORKSHOPS_API_URL = '/api/workshops';
var BACKEND_APRILTAG_POLL_CAMERA_MS = 60;
var BACKEND_APRILTAG_POLL_MAP_MS = 16;
var MAP_TAG_MASK_HOLD_MS = 500;
var apriltagPollInFlight = false;
var apriltagLastPollMs = 0;
var apriltagBackendErrorNotified = false;
var backendFeedActive = false;

export function initApp() {
  // Initialize DOM and state
  var dom = getDom();
  state.dom = dom;

  state.overlayCtx = dom.overlay.getContext('2d');
  state.captureCanvas = document.createElement('canvas');
  state.captureCtx = state.captureCanvas.getContext('2d', { willReadFrequently: true });

  // AprilTag-based surface calibration (Stage 2, single-camera)
  var apriltagSurfaceStableCount = 0;
  var apriltagSurfaceLastCorners = null;
  var apriltagSurfaceSmoothedCorners = null;
  var mapTagMaskCacheById = {};

  var videoContainer = document.getElementById('videoContainer1');

  initUiSetup({
    panelEl: dom.uiSetupPanelEl,
    overlayEl: dom.uiSetupOverlayEl,
    onNextStage: function () {
      if (state.stage === 3) setStage(4);
    }
  });

  // Event listeners
  dom.startBtn.addEventListener('click', startCamera);
  dom.showResultsBtn.addEventListener('click', onShowResultsClicked);
  dom.nextBtn.addEventListener('click', onNextClicked);
  dom.backBtn.addEventListener('click', onBackClicked);
  dom.stopBtn.addEventListener('click', stopCamera);
  dom.viewToggleEl.addEventListener('change', onViewToggleChanged);
  dom.resultsCancelBtnEl.addEventListener('click', closeResultsModal);
  dom.resultsModalBackdropEl.addEventListener('click', closeResultsModal);
  dom.resultsOpenBtnEl.addEventListener('click', onResultsOpenClicked);
  dom.resultsPrevBtnEl.addEventListener('click', showPrevResultsMapView);
  dom.resultsNextBtnEl.addEventListener('click', showNextResultsMapView);
  dom.resultsExitBtnEl.addEventListener('click', exitResultsMode);
  dom.vgaModeBtnEl.addEventListener('click', onVgaModeBtnClicked);
  dom.vgaApplyBtnEl.addEventListener('click', onVgaApplyClicked);
  dom.vgaBackBtnEl.addEventListener('click', function() {
    setVgaMode(false);
  });

  // Surface corner buttons
  dom.surfaceBtn1.addEventListener('click', function() { armCorner(0, setViewMode); });
  dom.surfaceBtn2.addEventListener('click', function() { armCorner(1, setViewMode); });
  dom.surfaceBtn3.addEventListener('click', function() { armCorner(2, setViewMode); });
  dom.surfaceBtn4.addEventListener('click', function() { armCorner(3, setViewMode); });

  // AprilTag calibration button - captures all 4 corners at once from visible AprilTags
  dom.apriltagCalibBtn.addEventListener('click', function() {
    if (state.stage !== 2) return;
    if (state.viewMode !== 'camera') {
      dom.viewToggleEl.checked = false;
      setViewMode('camera');
    }
    triggerApriltagCalibration();
  });

  // Hamburger menu
  state.viewToggleDockParent = dom.viewToggleContainerEl.parentNode;
  state.viewToggleDockNextSibling = dom.viewToggleContainerEl.nextSibling;

  document.addEventListener('keydown', function(e) {
    if (e.key !== 'Escape') return;
    if (vgaModeActive) {
      setVgaMode(false);
      return;
    }
    if (resultsModeActive) {
      exitResultsMode();
      return;
    }
    if (state.stage4DrawMode) setStage4DrawMode(false);
  });

  // Track mouse position globally for manual corner placement
  var lastMouseX = 0;
  var lastMouseY = 0;

  document.addEventListener('mousemove', function(e) {
    lastMouseX = e.clientX;
    lastMouseY = e.clientY;
  });

  // Keyboard shortcuts 1-4 to set surface corners at mouse position
  document.addEventListener('keydown', function(e) {
    // Only in stage 2, camera view
    if (state.stage !== 2) return;
    if (state.viewMode !== 'camera') return;

    var cornerIndex = null;
    if (e.key === '1') cornerIndex = 0;
    else if (e.key === '2') cornerIndex = 1;
    else if (e.key === '3') cornerIndex = 2;
    else if (e.key === '4') cornerIndex = 3;

    if (cornerIndex === null) return;

    // Get video element bounds
    var videoEl = state.usingIpCamera && state.ipCameraImg ? state.ipCameraImg : dom.video;
    var rect = videoEl.getBoundingClientRect();

    // Check if mouse is within the video area
    if (lastMouseX < rect.left || lastMouseX > rect.right ||
        lastMouseY < rect.top || lastMouseY > rect.bottom) {
      return;
    }

    // Check dimensions are valid
    if (!rect.width || !rect.height || !dom.overlay.width || !dom.overlay.height) return;

    e.preventDefault();

    // Convert mouse position to video/canvas pixel coordinates
    var scaleX = dom.overlay.width / rect.width;
    var scaleY = dom.overlay.height / rect.height;
    var cornerX = (lastMouseX - rect.left) * scaleX;
    var cornerY = (lastMouseY - rect.top) * scaleY;

    // Set the corner at the current mouse position
    state.surfaceCorners[cornerIndex] = { x: cornerX, y: cornerY };
    flashCornerButton(cornerIndex);
    updateSurfaceButtonsUI();
    recomputeSurfaceHomographyIfReady();
  });

  // Stage 4 sticker dragging
  document.addEventListener('pointerdown', function(e) {
    if (state.stage !== 4 || state.viewMode !== 'map') return;
    if (!dom.uiSetupOverlayEl || dom.uiSetupOverlayEl.classList.contains('hidden')) return;
    if (!e.target || !e.target.closest) return;

    var drawTemplateEl = e.target.closest('.ui-draw');
    if (drawTemplateEl && dom.uiSetupOverlayEl.contains(drawTemplateEl) && !drawTemplateEl.classList.contains('ui-sticker-instance')) {
      if (e.button !== 0) return;
      e.preventDefault();
      e.stopImmediatePropagation();
      var color = (drawTemplateEl.dataset && drawTemplateEl.dataset.color) ? drawTemplateEl.dataset.color : state.stage4DrawColor;
      var same = state.stage4DrawMode && state.stage4DrawColor === color;
      state.stage4DrawColor = color;
      setStage4DrawMode(!same);
      return;
    }

    // Handle dot and note stickers
    var stickerEl = e.target.closest('.ui-dot, .ui-note');
    if (!stickerEl || !dom.uiSetupOverlayEl.contains(stickerEl)) return;
    if (e.button !== 0) return;

    // Don't start drag if clicking inside expanded note form
    if (stickerEl.classList.contains('ui-note') && e.target.closest('.ui-note__form')) return;

    e.preventDefault();
    e.stopImmediatePropagation();

    var isInstance = stickerEl.classList.contains('ui-sticker-instance');
    var downX = e.clientX;
    var downY = e.clientY;
    var pointerId = e.pointerId;
    var moved = false;
    var dragStarted = false;

    function cleanup() {
      document.removeEventListener('pointermove', onMove, true);
      document.removeEventListener('pointerup', onUp, true);
      document.removeEventListener('pointercancel', onUp, true);
    }

    function onMove(ev) {
      if (ev.pointerId !== pointerId) return;
      var dx = ev.clientX - downX;
      var dy = ev.clientY - downY;
      if (!moved && Math.sqrt(dx * dx + dy * dy) >= 6) moved = true;
      if (!moved || dragStarted) return;
      dragStarted = true;
      cleanup();
      var dragEl = isInstance ? stickerEl : cloneSticker(stickerEl);
      if (dragEl) startStickerDrag(dragEl, e);
    }

    function onUp(ev) {
      if (ev.pointerId !== pointerId) return;
      cleanup();
    }

    document.addEventListener('pointermove', onMove, true);
    document.addEventListener('pointerup', onUp, true);
    document.addEventListener('pointercancel', onUp, true);
  }, true);

  window.addEventListener('resize', function() {
    if (state.leafletMap) state.leafletMap.invalidateSize();
  });

  // Stage 4 drawing event listeners
  dom.leafletMapEl.addEventListener('pointerdown', stage4PointerdownOnMap);
  dom.leafletMapEl.addEventListener('pointermove', stage4PointermoveOnMap);
  dom.leafletMapEl.addEventListener('pointerup', stage4StopDrawing);
  dom.leafletMapEl.addEventListener('pointercancel', stage4StopDrawing);

  // Initialize UI
  setStage(1);
  setViewMode('camera');
  setNextEnabled(false);
  updateSurfaceButtonsUI();
  updateUiSetupPanelVisibility();
  updateEdgeGuidesVisibility();
  updateGestureControlsVisibility();
  updateTrackingOffsetControlsVisibility();
  updateToolTagControlsVisibility();
  updateHamburgerMenuVisibility();
  updateBackState();
  updateShowResultsButton();
  setResultsViewerVisible(false);
  closeResultsModal();
  setVgaPanelVisible(false);

  // Gesture control sliders
  dom.holdStillThresholdSliderEl.value = String(Math.round(state.holdStillThresholdPx));
  dom.holdStillThresholdValueEl.textContent = String(Math.round(state.holdStillThresholdPx));
  dom.holdStillThresholdSliderEl.addEventListener('input', function() {
    var v = parseFloat(dom.holdStillThresholdSliderEl.value);
    if (!isFinite(v)) return;
    state.holdStillThresholdPx = clamp(v, 2, 80);
    dom.holdStillThresholdValueEl.textContent = String(Math.round(state.holdStillThresholdPx));
    saveNumberSetting('holdStillThresholdPx', state.holdStillThresholdPx);
  });

  dom.dwellTimeSliderEl.value = String((state.dwellClickMs / 1000).toFixed(1));
  dom.dwellTimeValueEl.textContent = (state.dwellClickMs / 1000).toFixed(1);
  dom.dwellTimeSliderEl.addEventListener('input', function() {
    var v = parseFloat(dom.dwellTimeSliderEl.value);
    if (!isFinite(v)) return;
    state.dwellClickMs = clamp(v, 0.25, 8.0) * 1000;
    dom.dwellTimeValueEl.textContent = (state.dwellClickMs / 1000).toFixed(1);
    saveNumberSetting('dwellClickMs', state.dwellClickMs);
  });

  dom.pinchHoldTimeSliderEl.value = String((state.pinchHoldMs / 1000).toFixed(1));
  dom.pinchHoldTimeValueEl.textContent = (state.pinchHoldMs / 1000).toFixed(1);
  dom.pinchHoldTimeSliderEl.addEventListener('input', function() {
    var v = parseFloat(dom.pinchHoldTimeSliderEl.value);
    if (!isFinite(v)) return;
    state.pinchHoldMs = clamp(v, 0.25, 8.0) * 1000;
    dom.pinchHoldTimeValueEl.textContent = (state.pinchHoldMs / 1000).toFixed(1);
    saveNumberSetting('pinchHoldMs', state.pinchHoldMs);
  });

  dom.apriltagMoveWindowSliderEl.value = String(Math.round(state.apriltagSuddenMoveWindowMs));
  dom.apriltagMoveWindowValueEl.textContent = String(Math.round(state.apriltagSuddenMoveWindowMs));
  dom.apriltagMoveWindowSliderEl.addEventListener('input', function() {
    var v = parseFloat(dom.apriltagMoveWindowSliderEl.value);
    if (!isFinite(v)) return;
    state.apriltagSuddenMoveWindowMs = clamp(v, 50, 1000);
    dom.apriltagMoveWindowValueEl.textContent = String(Math.round(state.apriltagSuddenMoveWindowMs));
    saveNumberSetting('apriltagSuddenMoveWindowMs', state.apriltagSuddenMoveWindowMs);
  });

  dom.apriltagMoveDistanceSliderEl.value = String(Math.round(state.apriltagSuddenMoveThresholdPx));
  dom.apriltagMoveDistanceValueEl.textContent = String(Math.round(state.apriltagSuddenMoveThresholdPx));
  dom.apriltagMoveDistanceSliderEl.addEventListener('input', function() {
    var v = parseFloat(dom.apriltagMoveDistanceSliderEl.value);
    if (!isFinite(v)) return;
    state.apriltagSuddenMoveThresholdPx = clamp(v, 10, 300);
    dom.apriltagMoveDistanceValueEl.textContent = String(Math.round(state.apriltagSuddenMoveThresholdPx));
    saveNumberSetting('apriltagSuddenMoveThresholdPx', state.apriltagSuddenMoveThresholdPx);
  });

  dom.strokeStopDelaySliderEl.value = String(Math.round(state.strokeStopDelayMs));
  dom.strokeStopDelayValueEl.textContent = String(Math.round(state.strokeStopDelayMs));
  dom.strokeStopDelaySliderEl.addEventListener('input', function() {
    var v = parseFloat(dom.strokeStopDelaySliderEl.value);
    if (!isFinite(v)) return;
    state.strokeStopDelayMs = clamp(v, 0, 500);
    dom.strokeStopDelayValueEl.textContent = String(Math.round(state.strokeStopDelayMs));
    saveNumberSetting('strokeStopDelayMs', state.strokeStopDelayMs);
  });

  dom.pointerLostTimeoutSliderEl.value = String(Math.round(state.pointerLostTimeoutMs));
  dom.pointerLostTimeoutValueEl.textContent = String(Math.round(state.pointerLostTimeoutMs));
  dom.pointerLostTimeoutSliderEl.addEventListener('input', function() {
    var v = parseFloat(dom.pointerLostTimeoutSliderEl.value);
    if (!isFinite(v)) return;
    state.pointerLostTimeoutMs = clamp(v, 0, 1000);
    dom.pointerLostTimeoutValueEl.textContent = String(Math.round(state.pointerLostTimeoutMs));
    saveNumberSetting('pointerLostTimeoutMs', state.pointerLostTimeoutMs);
  });

  dom.drawingDeselectTimeoutSliderEl.value = String(Math.round(state.drawingDeselectTimeoutMs));
  dom.drawingDeselectTimeoutValueEl.textContent = String(Math.round(state.drawingDeselectTimeoutMs));
  dom.drawingDeselectTimeoutSliderEl.addEventListener('input', function() {
    var v = parseFloat(dom.drawingDeselectTimeoutSliderEl.value);
    if (!isFinite(v)) return;
    state.drawingDeselectTimeoutMs = clamp(v, 500, 10000);
    dom.drawingDeselectTimeoutValueEl.textContent = String(Math.round(state.drawingDeselectTimeoutMs));
    saveNumberSetting('drawingDeselectTimeoutMs', state.drawingDeselectTimeoutMs);
  });

  // Populate tool tag selects with AprilTags 21-40
  var toolTagSelects = [
    dom.isovistTagSelectEl,
    dom.shortestPathTagASelectEl,
    dom.shortestPathTagBSelectEl,
    dom.panTagSelectEl,
    dom.zoomTagSelectEl,
    dom.nextTagSelectEl,
    dom.backTagSelectEl
  ];
  for (var si = 0; si < toolTagSelects.length; si++) {
    var sel = toolTagSelects[si];
    for (var tagNum = 21; tagNum <= 40; tagNum++) {
      var opt = document.createElement('option');
      opt.value = String(tagNum);
      opt.textContent = String(tagNum);
      sel.appendChild(opt);
    }
  }

  // Track all tag selects including dynamically added ones for roads files
  var geojsonFileSelects = [];
  var roadColorPalette = ['#ff5a5f', '#2bb8ff', '#2ec27e', '#f6c945', '#ff8a3d', '#9c6dff'];
  var importedRoadEntries = [];

  function removeRoadLayer(entry) {
    if (!entry || !entry.roadLayer || !state.leafletMap) return;
    if (typeof state.leafletMap.hasLayer === 'function' && state.leafletMap.hasLayer(entry.roadLayer)) {
      state.leafletMap.removeLayer(entry.roadLayer);
    }
    entry.roadLayer = null;
  }

  function ensureRoadLayerOnMap(entry) {
    if (!entry || entry.removed) return;
    if (!entry.geojsonData) return;
    if (!state.leafletGlobal || !state.leafletMap) return;

    var L = state.leafletGlobal;
    var color = entry.colorInput && entry.colorInput.value ? entry.colorInput.value : '#2bb8ff';

    if (!entry.roadLayer) {
      entry.roadLayer = L.geoJSON(entry.geojsonData, {
        pointToLayer: function(feature, latlng) {
          return L.circleMarker(latlng, {
            radius: 4,
            color: color,
            weight: 1,
            fillColor: color,
            fillOpacity: 0.95,
            opacity: 0.95
          });
        },
        style: function() {
          return {
            color: color,
            weight: 3,
            opacity: 0.95
          };
        }
      });
    } else if (typeof entry.roadLayer.setStyle === 'function') {
      entry.roadLayer.setStyle({ color: color, fillColor: color });
    }
  }

  function setRoadLayerVisible(entry, visible) {
    if (!entry || entry.removed || !state.leafletMap) return;

    if (!visible) {
      if (entry.roadLayer && typeof state.leafletMap.hasLayer === 'function' && state.leafletMap.hasLayer(entry.roadLayer)) {
        state.leafletMap.removeLayer(entry.roadLayer);
      }
      return;
    }

    ensureRoadLayerOnMap(entry);
    if (!entry.roadLayer) return;

    if (typeof state.leafletMap.hasLayer !== 'function' || !state.leafletMap.hasLayer(entry.roadLayer)) {
      entry.roadLayer.addTo(state.leafletMap);
    }

    if (!entry.hasFittedToBounds && typeof entry.roadLayer.getBounds === 'function') {
      var bounds = entry.roadLayer.getBounds();
      if (bounds && typeof bounds.isValid === 'function' && bounds.isValid()) {
        state.leafletMap.fitBounds(bounds, { padding: [24, 24], maxZoom: 18 });
      }
      entry.hasFittedToBounds = true;
    }
  }

  function updateRoadLayersVisibilityByTags(detections) {
    if (!Array.isArray(importedRoadEntries) || importedRoadEntries.length < 1) return;

    var shouldEvaluateTags = state.viewMode === 'map' && (state.stage === 3 || state.stage === 4) && !!state.surfaceHomography;
    var detById = {};
    if (Array.isArray(detections)) {
      for (var i = 0; i < detections.length; i++) {
        var d = detections[i];
        if (!d || !d.center) continue;
        var id = typeof d.id === 'number' ? d.id : parseInt(d.id, 10);
        if (isFinite(id)) detById[id] = d;
      }
    }

    for (var ei = 0; ei < importedRoadEntries.length; ei++) {
      var entry = importedRoadEntries[ei];
      if (!entry || entry.removed) continue;
      if (!shouldEvaluateTags) {
        setRoadLayerVisible(entry, false);
        continue;
      }

      var tagId = entry.tagSelect && entry.tagSelect.value ? parseInt(entry.tagSelect.value, 10) : NaN;
      if (!isFinite(tagId)) {
        setRoadLayerVisible(entry, false);
        continue;
      }

      var det = detById[tagId];
      var inSurface = !!(det && det.center && isPointInSurface(det.center.x, det.center.y));
      setRoadLayerVisible(entry, inSurface);
    }
  }

  function readGeojsonFileText(file) {
    if (file && typeof file.text === 'function') {
      return file.text();
    }

    return new Promise(function(resolve, reject) {
      if (typeof FileReader === 'undefined') {
        reject(new Error('FileReader not supported'));
        return;
      }
      var reader = new FileReader();
      reader.onload = function() {
        resolve(typeof reader.result === 'string' ? reader.result : '');
      };
      reader.onerror = function() {
        reject(new Error('Failed to read file'));
      };
      reader.readAsText(file);
    });
  }

  // Update disabled state of options when selection changes
  function updateToolTagSelectsDisabled() {
    var allSelects = toolTagSelects.concat(geojsonFileSelects);
    var selectedValues = [];
    for (var i = 0; i < allSelects.length; i++) {
      var val = allSelects[i].value;
      if (val) selectedValues.push(val);
    }
    for (var i = 0; i < allSelects.length; i++) {
      var sel = allSelects[i];
      var options = sel.querySelectorAll('option');
      for (var j = 0; j < options.length; j++) {
        var opt = options[j];
        if (!opt.value) continue; // Skip "None" option
        var isSelectedElsewhere = selectedValues.indexOf(opt.value) !== -1 && sel.value !== opt.value;
        opt.disabled = isSelectedElsewhere;
      }
    }
  }

  for (var si = 0; si < toolTagSelects.length; si++) {
    toolTagSelects[si].addEventListener('change', updateToolTagSelectsDisabled);
  }

  // Roads GeoJSON file import
  dom.geojsonImportBtnEl.addEventListener('click', function(e) {
    e.preventDefault();
    e.stopPropagation();
    dom.geojsonFileInputEl.click();
  });

  dom.geojsonFileInputEl.addEventListener('change', function(e) {
    e.preventDefault();
    e.stopPropagation();
    var files = e.target.files;
    if (!files || files.length === 0) return;

    for (var i = 0; i < files.length; i++) {
      var file = files[i];
      addGeojsonFileRow(file);
    }

    // Reset input so same file can be selected again
    dom.geojsonFileInputEl.value = '';
  });

  function addGeojsonFileRow(file) {
    var row = document.createElement('div');
    row.className = 'tool-tag-controls__file-row';
    var rowRemoved = false;

    var nameSpan = document.createElement('span');
    nameSpan.className = 'tool-tag-controls__file-name';
    nameSpan.textContent = file.name;
    nameSpan.title = file.name;

    var sel = document.createElement('select');
    sel.className = 'tool-tag-controls__select';
    sel.setAttribute('aria-label', 'Select AprilTag for ' + file.name);

    var noneOpt = document.createElement('option');
    noneOpt.value = '';
    noneOpt.textContent = 'None';
    sel.appendChild(noneOpt);

    for (var tagNum = 21; tagNum <= 40; tagNum++) {
      var opt = document.createElement('option');
      opt.value = String(tagNum);
      opt.textContent = String(tagNum);
      sel.appendChild(opt);
    }

    sel.addEventListener('change', function() {
      updateToolTagSelectsDisabled();
      updateRoadLayersVisibilityByTags(state.lastApriltagDetections || []);
    });
    geojsonFileSelects.push(sel);

    var colorInput = document.createElement('input');
    colorInput.className = 'tool-tag-controls__file-color';
    colorInput.type = 'color';
    colorInput.value = roadColorPalette[(geojsonFileSelects.length - 1) % roadColorPalette.length];
    colorInput.setAttribute('aria-label', 'Pick display color for ' + file.name);
    row.dataset.roadColor = colorInput.value;
    var roadEntry = {
      fileName: file && file.name ? String(file.name) : 'roads.geojson',
      rowEl: row,
      tagSelect: sel,
      colorInput: colorInput,
      roadLayer: null,
      geojsonData: null,
      hasFittedToBounds: false,
      removed: false
    };
    importedRoadEntries.push(roadEntry);

    colorInput.addEventListener('input', function() {
      row.dataset.roadColor = colorInput.value;
      ensureRoadLayerOnMap(roadEntry);
      updateRoadLayersVisibilityByTags(state.lastApriltagDetections || []);
    });

    var removeBtn = document.createElement('button');
    removeBtn.className = 'tool-tag-controls__file-remove';
    removeBtn.type = 'button';
    removeBtn.textContent = '×';
    removeBtn.setAttribute('aria-label', 'Remove ' + file.name);
    removeBtn.addEventListener('click', function() {
      var idx = geojsonFileSelects.indexOf(sel);
      if (idx !== -1) geojsonFileSelects.splice(idx, 1);
      rowRemoved = true;
      roadEntry.removed = true;
      removeRoadLayer(roadEntry);
      var roadIdx = importedRoadEntries.indexOf(roadEntry);
      if (roadIdx !== -1) importedRoadEntries.splice(roadIdx, 1);
      row.parentNode.removeChild(row);
      updateToolTagSelectsDisabled();
    });

    row.appendChild(nameSpan);
    row.appendChild(sel);
    row.appendChild(colorInput);
    row.appendChild(removeBtn);
    dom.geojsonFilesListEl.appendChild(row);

    readGeojsonFileText(file).then(function(text) {
      if (rowRemoved || roadEntry.removed) return;
      var rawText = typeof text === 'string' ? text : '';
      if (rawText.charCodeAt(0) === 0xFEFF) rawText = rawText.slice(1);

      var parsed = null;
      try {
        parsed = JSON.parse(rawText);
      } catch (err) {
        throw new Error('Invalid JSON');
      }

      if (!parsed || parsed.type !== 'FeatureCollection' || !Array.isArray(parsed.features)) {
        throw new Error('Invalid roads GeoJSON');
      }

      roadEntry.geojsonData = parsed;
      updateRoadLayersVisibilityByTags(state.lastApriltagDetections || []);
      setError('');
    }).catch(function(err) {
      console.warn('Failed to load roads GeoJSON:', file.name, err);
      setError('Failed to load roads GeoJSON: ' + file.name);
    });

    updateToolTagSelectsDisabled();
  }

  // Map Session functionality
  var mapSessions = [];
  var mapSessionCounter = 0;
  var currentMapSessionIndex = -1;
  var workshopFinishInProgress = false;
  var resultsModeActive = false;
  var resultsWorkshopId = '';
  var resultsMapViews = [];
  var resultsMapViewIndex = 0;
  var resultsLayerGroup = null;
  var VGA_REQUIRED_POINTS = 4;
  var VGA_TARGET_SAMPLE_COUNT = 260;
  var VGA_MAX_SAMPLE_COUNT = 420;
  var vgaModeActive = false;
  var vgaApplying = false;
  var vgaApplyRunId = 0;
  var vgaMapClickBound = false;
  var vgaSelectedCorners = [];
  var vgaSelectionLayer = null;
  var vgaHeatmapLayer = null;
  var vgaHeatPointRadiusPx = 10;
  updateVgaPanelMeta();

  // Tool tag detection state (for edge-triggered actions)
  var toolTagInSurface = {}; // tagId -> boolean (was in surface last frame)
  var ISOVIST_JITTER_METERS = 2;
  var ISOVIST_MIN_UPDATE_INTERVAL_MS = 220;
  var ISOVIST_MISSING_HOLD_MS = 700;
  var isovistTagRuntime = {
    configuredTagId: null,
    lastOrigin: null,
    lastUpdateAtMs: 0,
    missingSinceMs: 0
  };

  var SHORTEST_PATH_JITTER_METERS = 3;
  var SHORTEST_PATH_MIN_REQUEST_INTERVAL_MS = 1200;
  var SHORTEST_PATH_MISSING_HOLD_MS = 800;
  var shortestPathTagRuntime = {
    configuredTagAId: null,
    configuredTagBId: null,
    lastEndpointA: null,
    lastEndpointB: null,
    lastRequestAtMs: 0,
    missingSinceMs: 0
  };

  dom.mapSessionAddBtnEl.addEventListener('click', function(e) {
    e.preventDefault();
    e.stopPropagation();
    if (!state.leafletMap) return;

    var center = state.leafletMap.getCenter();
    var zoom = state.leafletMap.getZoom();
    mapSessionCounter++;

    var session = {
      id: mapSessionCounter,
      name: 'View ' + mapSessionCounter,
      lat: center.lat,
      lng: center.lng,
      zoom: zoom
    };

    mapSessions.push(session);
    renderMapSessionList();
    // Activate the newly created session
    activateMapSession(mapSessions.length - 1);
  });

  function renderMapSessionList() {
    dom.mapSessionListEl.textContent = '';

    for (var i = 0; i < mapSessions.length; i++) {
      var session = mapSessions[i];
      var item = document.createElement('div');
      item.className = 'map-session-item';
      item.dataset.sessionId = String(session.id);

      var nameSpan = document.createElement('span');
      nameSpan.className = 'map-session-item__name';
      nameSpan.textContent = session.name;

      var deleteBtn = document.createElement('button');
      deleteBtn.className = 'map-session-item__delete';
      deleteBtn.type = 'button';
      deleteBtn.textContent = '×';
      deleteBtn.setAttribute('aria-label', 'Delete ' + session.name);

      (function(sessionId) {
        item.addEventListener('click', function(e) {
          if (e.target === deleteBtn) return;
          restoreMapSession(sessionId);
        });

        deleteBtn.addEventListener('click', function(e) {
          e.preventDefault();
          e.stopPropagation();
          deleteMapSession(sessionId);
        });
      })(session.id);

      item.appendChild(nameSpan);
      item.appendChild(deleteBtn);
      dom.mapSessionListEl.appendChild(item);
    }
  }

  function restoreMapSession(sessionId) {
    for (var i = 0; i < mapSessions.length; i++) {
      if (mapSessions[i].id === sessionId) {
        activateMapSession(i);
        return;
      }
    }
  }

  function deleteMapSession(sessionId) {
    for (var i = 0; i < mapSessions.length; i++) {
      if (mapSessions[i].id === sessionId) {
        mapSessions.splice(i, 1);
        break;
      }
    }
    // Adjust current index if needed
    if (currentMapSessionIndex >= mapSessions.length) {
      currentMapSessionIndex = mapSessions.length - 1;
    }
    renderMapSessionList();
  }

  function goToNextMapSession() {
    if (mapSessions.length === 0) return;
    if (state.stage === 4 && currentMapSessionIndex >= 0 && currentMapSessionIndex >= mapSessions.length - 1) {
      finishWorkshopSession();
      return;
    }
    currentMapSessionIndex++;
    if (currentMapSessionIndex >= mapSessions.length) {
      currentMapSessionIndex = 0; // Wrap around
    }
    activateMapSession(currentMapSessionIndex);
  }

  function showWorkshopFinishedPopup(extraMessage) {
    var base = 'Workshop/survey is finished. Thank you for your participation.';
    var extra = String(extraMessage || '').trim();
    window.alert(extra ? (base + '\n\n' + extra) : base);
  }

  function finishWorkshopSession() {
    if (workshopFinishInProgress) return;
    workshopFinishInProgress = true;
    dom.nextBtn.disabled = true;

    exportWorkshopInputsGeoJSON().then(function(result) {
      if (result && result.saved && result.sessionFile) {
        showWorkshopFinishedPopup('Saved to: ' + String(result.sessionFile));
        return;
      }
      var errorText = result && result.error ? String(result.error) : 'Unknown error';
      showWorkshopFinishedPopup('Warning: failed to save workshop directory on backend.\n' +
        'Please run this UI from the project backend (`python app.py`) and retry.\n' +
        'Error: ' + errorText);
    }).finally(function() {
      workshopFinishInProgress = false;
      dom.nextBtn.disabled = false;
    });
  }

  function flattenLatLngsForGeoJson(latlngs, out) {
    if (!Array.isArray(latlngs)) return;
    for (var i = 0; i < latlngs.length; i++) {
      var v = latlngs[i];
      if (!v) continue;
      if (Array.isArray(v)) {
        flattenLatLngsForGeoJson(v, out);
        continue;
      }
      if (typeof v.lat === 'number' && typeof v.lng === 'number') {
        out.push(v);
      }
    }
  }

  function downloadGeoJsonFile(featureCollection, filename) {
    var text = JSON.stringify(featureCollection, null, 2);
    var blob = new Blob([text], { type: 'application/geo+json' });
    var url = URL.createObjectURL(blob);
    var a = document.createElement('a');
    a.href = url;
    a.download = filename;
    document.body.appendChild(a);
    a.click();
    a.remove();
    setTimeout(function() { URL.revokeObjectURL(url); }, 0);
  }

  function stableStringify(value) {
    if (value === null) return 'null';
    if (typeof value === 'number') {
      if (!isFinite(value)) return 'null';
      return String(value);
    }
    if (typeof value === 'boolean') return value ? 'true' : 'false';
    if (typeof value === 'string') return JSON.stringify(value);
    if (Array.isArray(value)) {
      var arrParts = [];
      for (var ai = 0; ai < value.length; ai++) {
        arrParts.push(stableStringify(value[ai]));
      }
      return '[' + arrParts.join(',') + ']';
    }
    if (typeof value === 'object') {
      var keys = Object.keys(value).sort();
      var objParts = [];
      for (var ki = 0; ki < keys.length; ki++) {
        var k = keys[ki];
        objParts.push(JSON.stringify(k) + ':' + stableStringify(value[k]));
      }
      return '{' + objParts.join(',') + '}';
    }
    return 'null';
  }

  function fnv1aHashHex(text) {
    var hash = 0x811c9dc5;
    for (var i = 0; i < text.length; i++) {
      hash ^= text.charCodeAt(i);
      hash = (hash * 0x01000193) >>> 0;
    }
    return ('00000000' + hash.toString(16)).slice(-8);
  }

  function collectWorkshopSetupDefinition() {
    var setupItems = [];
    if (dom.uiSetupOverlayEl) {
      var els = dom.uiSetupOverlayEl.querySelectorAll('.ui-label, .ui-dot, .ui-draw, .ui-note, .ui-eraser');
      for (var i = 0; i < els.length; i++) {
        var el = els[i];
        if (!el || !el.dataset || el.classList.contains('ui-sticker-instance')) continue;

        var type = el.dataset.uiType || '';
        var left = parseFloat(el.style.left || '0');
        var top = parseFloat(el.style.top || '0');
        var rotationDeg = parseFloat(el.dataset.rotationDeg || '0');
        var item = {
          type: type || 'unknown',
          x: isFinite(left) ? left : 0,
          y: isFinite(top) ? top : 0,
          rotationDeg: isFinite(rotationDeg) ? rotationDeg : 0,
          color: el.dataset.color || null,
          text: type === 'label' ? (el.textContent || '') : '',
          noteText: type === 'note' ? (el.dataset.noteText || '') : ''
        };
        setupItems.push(item);
      }
    }

    setupItems.sort(function(a, b) {
      var ak = [a.type, a.text, a.noteText, a.color, a.x, a.y, a.rotationDeg].join('|');
      var bk = [b.type, b.text, b.noteText, b.color, b.x, b.y, b.rotationDeg].join('|');
      if (ak < bk) return -1;
      if (ak > bk) return 1;
      return 0;
    });

    return {
      participantCount: state.stage3ParticipantCount || 0,
      participantPrimaryTagIds: Array.isArray(state.stage3ParticipantTagIds) ? state.stage3ParticipantTagIds.slice() : [],
      participantTriggerTagIds: Array.isArray(state.stage3ParticipantTriggerTagIds) ? state.stage3ParticipantTriggerTagIds.slice() : [],
      toolTagBindings: {
        isovist: dom.isovistTagSelectEl.value || null,
        shortestPathA: dom.shortestPathTagASelectEl.value || null,
        shortestPathB: dom.shortestPathTagBSelectEl.value || null,
        pan: dom.panTagSelectEl.value || null,
        zoom: dom.zoomTagSelectEl.value || null,
        next: dom.nextTagSelectEl.value || null,
        back: dom.backTagSelectEl.value || null
      },
      setupItems: setupItems
    };
  }

  function buildWorkshopIdFromSetup(setupDefinition) {
    var normalized = stableStringify(setupDefinition || {});
    return 'workshop-' + fnv1aHashHex(normalized);
  }

  function saveWorkshopSessionToBackend(workshopId, featureCollection, setupDefinition) {
    return fetch(BACKEND_WORKSHOP_SESSION_API_URL, {
      method: 'POST',
      cache: 'no-store',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        workshopId: workshopId,
        setupDefinition: setupDefinition,
        geojson: featureCollection
      })
    }).then(function(resp) {
      return resp.text().then(function(bodyText) {
        var payload = null;
        try {
          payload = bodyText ? JSON.parse(bodyText) : null;
        } catch (e) {
          payload = null;
        }
        if (!resp.ok || !payload || payload.ok === false) {
          var detail = payload && payload.error ? payload.error : ('HTTP ' + resp.status + ' ' + (resp.statusText || ''));
          throw new Error(detail);
        }
        return payload;
      });
    });
  }

  function buildWorkshopResultsApiUrl(workshopId) {
    return BACKEND_WORKSHOPS_API_URL + '/' + encodeURIComponent(workshopId) + '/results';
  }

  function setResultsModalError(text) {
    var message = String(text || '').trim();
    dom.resultsErrorEl.textContent = message;
    dom.resultsErrorEl.classList.toggle('hidden', !message);
  }

  function setResultsViewerVisible(visible) {
    dom.resultsViewerControlsEl.classList.toggle('hidden', !visible);
    dom.resultsViewerControlsEl.setAttribute('aria-hidden', visible ? 'false' : 'true');
  }

  function openResultsModal() {
    dom.resultsModalEl.classList.remove('hidden');
    dom.resultsModalEl.setAttribute('aria-hidden', 'false');
  }

  function closeResultsModal() {
    dom.resultsModalEl.classList.add('hidden');
    dom.resultsModalEl.setAttribute('aria-hidden', 'true');
    setResultsModalError('');
  }

  function updateResultsWorkshopSelect(workshops) {
    dom.resultsWorkshopSelectEl.textContent = '';
    var items = Array.isArray(workshops) ? workshops : [];
    for (var i = 0; i < items.length; i++) {
      var workshop = items[i];
      if (!workshop || !workshop.workshopId) continue;
      var option = document.createElement('option');
      option.value = String(workshop.workshopId);
      option.textContent = String(workshop.directory || workshop.workshopId) + ' (' + String(workshop.sessionCount || 0) + ' sessions)';
      dom.resultsWorkshopSelectEl.appendChild(option);
    }
  }

  function onShowResultsClicked() {
    if (resultsModeActive) return;
    if (state.stage !== 1 || state.cameraReady || state.cameraStarting) return;

    setError('');
    setResultsModalError('');
    openResultsModal();

    dom.resultsWorkshopSelectEl.disabled = true;
    dom.resultsOpenBtnEl.disabled = true;
    dom.resultsWorkshopSelectEl.textContent = '';
    var loadingOption = document.createElement('option');
    loadingOption.value = '';
    loadingOption.textContent = 'Loading workshops...';
    dom.resultsWorkshopSelectEl.appendChild(loadingOption);

    fetch(BACKEND_WORKSHOPS_API_URL, { cache: 'no-store' }).then(function(resp) {
      return resp.json().then(function(payload) {
        if (!resp.ok || !payload || payload.ok === false) {
          var detail = payload && payload.error ? payload.error : ('HTTP ' + resp.status);
          throw new Error(detail);
        }
        return payload;
      });
    }).then(function(payload) {
      var workshops = Array.isArray(payload.workshops) ? payload.workshops : [];
      updateResultsWorkshopSelect(workshops);
      dom.resultsWorkshopSelectEl.disabled = workshops.length === 0;
      dom.resultsOpenBtnEl.disabled = workshops.length === 0;
      if (!workshops.length) {
        setResultsModalError('No workshop directories found in workshops/.');
      }
    }).catch(function(err) {
      console.warn('Failed to list workshops:', err);
      updateResultsWorkshopSelect([]);
      dom.resultsWorkshopSelectEl.disabled = true;
      dom.resultsOpenBtnEl.disabled = true;
      setResultsModalError('Failed to load workshop directories.');
    });
  }

  function onResultsOpenClicked() {
    if (resultsModeActive) return;
    var workshopId = String(dom.resultsWorkshopSelectEl.value || '').trim();
    if (!workshopId) {
      setResultsModalError('Please select a workshop directory.');
      return;
    }

    dom.resultsOpenBtnEl.disabled = true;
    setResultsModalError('');

    fetch(buildWorkshopResultsApiUrl(workshopId), { cache: 'no-store' }).then(function(resp) {
      return resp.json().then(function(payload) {
        if (!resp.ok || !payload || payload.ok === false) {
          var detail = payload && payload.error ? payload.error : ('HTTP ' + resp.status);
          throw new Error(detail);
        }
        return payload;
      });
    }).then(function(payload) {
      closeResultsModal();
      enterResultsMode(workshopId, payload);
    }).catch(function(err) {
      console.warn('Failed to load workshop results:', err);
      setResultsModalError('Failed to load workshop results.');
      dom.resultsOpenBtnEl.disabled = false;
    });
  }

  function ensureResultsLayerGroup() {
    if (!state.leafletMap || !state.leafletGlobal) return null;
    if (!resultsLayerGroup) {
      resultsLayerGroup = state.leafletGlobal.layerGroup().addTo(state.leafletMap);
    }
    return resultsLayerGroup;
  }

  function clearResultsLayerGroup() {
    if (!resultsLayerGroup) return;
    if (typeof resultsLayerGroup.clearLayers === 'function') {
      resultsLayerGroup.clearLayers();
    }
  }

  function getResultsFeatureColor(feature) {
    var props = feature && feature.properties ? feature.properties : {};
    if (props && typeof props.color === 'string' && props.color.trim()) {
      return props.color;
    }
    if (props && props.sourceType === 'annotation') return '#ffc857';
    if (props && props.sourceType === 'drawing') return '#2bb8ff';
    return '#ff3b30';
  }

  function renderResultsMapView() {
    if (!resultsModeActive) return;

    var totalViews = resultsMapViews.length;
    dom.resultsViewTitleEl.textContent = 'Workshop: ' + resultsWorkshopId;
    dom.resultsPrevBtnEl.disabled = totalViews < 2;
    dom.resultsNextBtnEl.disabled = totalViews < 2;

    clearResultsLayerGroup();

    if (totalViews < 1) {
      dom.resultsViewMetaEl.textContent = 'No map views with saved inputs.';
      return;
    }

    if (resultsMapViewIndex >= totalViews) resultsMapViewIndex = 0;
    if (resultsMapViewIndex < 0) resultsMapViewIndex = totalViews - 1;

    var currentMapView = resultsMapViews[resultsMapViewIndex] || {};
    var features = Array.isArray(currentMapView.features) ? currentMapView.features : [];
    var mapViewName = currentMapView.mapViewName ? String(currentMapView.mapViewName) : ('View ' + String(resultsMapViewIndex + 1));
    var sessionCount = isFinite(currentMapView.sessionCount) ? Number(currentMapView.sessionCount) : 0;

    dom.resultsViewMetaEl.textContent =
      'Map view ' + String(resultsMapViewIndex + 1) + '/' + String(totalViews) +
      ': ' + mapViewName +
      ' | features: ' + String(features.length) +
      ' | sessions: ' + String(sessionCount);

    var group = ensureResultsLayerGroup();
    if (!group || !state.leafletGlobal || !state.leafletMap || features.length < 1) return;

    var L = state.leafletGlobal;
    var geoLayer = L.geoJSON(
      { type: 'FeatureCollection', features: features },
      {
        pointToLayer: function(feature, latlng) {
          var color = getResultsFeatureColor(feature);
          return L.circleMarker(latlng, {
            radius: 7,
            color: '#111111',
            weight: 1,
            fillColor: color,
            fillOpacity: 0.95
          });
        },
        style: function(feature) {
          var color = getResultsFeatureColor(feature);
          var sourceType = feature && feature.properties ? feature.properties.sourceType : '';
          return {
            color: color,
            weight: sourceType === 'drawing' ? 6 : 3,
            opacity: 0.95
          };
        }
      }
    );

    group.addLayer(geoLayer);

    if (typeof geoLayer.getBounds === 'function') {
      var bounds = geoLayer.getBounds();
      if (bounds && typeof bounds.isValid === 'function' && bounds.isValid()) {
        state.leafletMap.fitBounds(bounds, { padding: [36, 36], maxZoom: 18 });
      }
    }
  }

  function enterResultsMode(workshopId, payload) {
    initMaptasticIfNeeded();
    initLeafletIfNeeded();
    if (!state.leafletMap || !state.leafletGlobal) {
      setError('Map is not available.');
      return;
    }

    resultsModeActive = true;
    resultsWorkshopId = String(workshopId || '').trim();
    resultsMapViews = Array.isArray(payload && payload.mapViews) ? payload.mapViews.slice() : [];
    resultsMapViewIndex = 0;

    setViewMode('map');
    setResultsViewerVisible(true);
    dom.pageTitleEl.textContent = 'Workshop Results';
    document.title = 'Workshop Results';
    updateShowResultsButton();

    setTimeout(function() {
      if (state.leafletMap) state.leafletMap.invalidateSize();
      renderResultsMapView();
    }, 0);
  }

  function exitResultsMode() {
    if (!resultsModeActive) return;
    resultsModeActive = false;
    resultsWorkshopId = '';
    resultsMapViews = [];
    resultsMapViewIndex = 0;
    clearResultsLayerGroup();
    setResultsViewerVisible(false);

    setStage(state.stage);
    setButtonsRunning(!!state.cameraReady);
    updateShowResultsButton();
  }

  function showNextResultsMapView() {
    if (!resultsModeActive || resultsMapViews.length < 2) return;
    resultsMapViewIndex++;
    if (resultsMapViewIndex >= resultsMapViews.length) resultsMapViewIndex = 0;
    renderResultsMapView();
  }

  function showPrevResultsMapView() {
    if (!resultsModeActive || resultsMapViews.length < 2) return;
    resultsMapViewIndex--;
    if (resultsMapViewIndex < 0) resultsMapViewIndex = resultsMapViews.length - 1;
    renderResultsMapView();
  }

  function exportWorkshopInputsGeoJSON() {
    try {
      var features = [];
      var exportedStrokeIds = {};
      var mapSessionById = {};
      for (var ms = 0; ms < mapSessions.length; ms++) {
        var s = mapSessions[ms];
        if (!s || !isFinite(s.id)) continue;
        mapSessionById[String(s.id)] = s;
      }

      function getMapViewInfo(sessionIdRaw) {
        var id = (sessionIdRaw === null || sessionIdRaw === undefined || String(sessionIdRaw) === '') ? null : String(sessionIdRaw);
        var session = id ? mapSessionById[id] : null;
        return {
          mapViewId: id,
          mapViewName: session ? session.name : (id ? ('View ' + id) : 'Unassigned')
        };
      }

      // Export sticker inputs (dot / annotation / draw sticker instances)
      if (dom.uiSetupOverlayEl) {
        var stickerEls = dom.uiSetupOverlayEl.querySelectorAll('.ui-sticker-instance.ui-dot, .ui-sticker-instance.ui-note, .ui-sticker-instance.ui-draw');
        for (var i = 0; i < stickerEls.length; i++) {
          var el = stickerEls[i];
          var lat = parseFloat(el.dataset.mapLat || '');
          var lng = parseFloat(el.dataset.mapLng || '');
          if (!isFinite(lat) || !isFinite(lng)) continue;

          var type = el.dataset.uiType || '';
          var viewInfo = getMapViewInfo(el.dataset.sessionId || null);
          var props = {
            sourceType: type === 'note' ? 'annotation' : 'sticker',
            itemType: type || 'unknown',
            color: el.dataset.color || null,
            noteText: type === 'note' ? (el.dataset.noteText || '') : '',
            sessionId: el.dataset.sessionId || null,
            mapViewId: viewInfo.mapViewId,
            mapViewName: viewInfo.mapViewName
          };

          features.push({
            type: 'Feature',
            geometry: { type: 'Point', coordinates: [lng, lat] },
            properties: props
          });
        }
      }

      // Export drawings from Leaflet draw layer
      if (state.stage4DrawLayer && typeof state.stage4DrawLayer.eachLayer === 'function') {
        state.stage4DrawLayer.eachLayer(function(layer) {
          if (!layer || typeof layer.getLatLngs !== 'function') return;

          var strokeId = layer.strokeId ? String(layer.strokeId) : '';
          if (strokeId) {
            if (exportedStrokeIds[strokeId]) return;
            exportedStrokeIds[strokeId] = true;
          } else {
            // Old strokes may not have strokeId; avoid glow duplicates by skipping thick glow layers.
            var weightLegacy = layer.options && isFinite(layer.options.weight) ? Number(layer.options.weight) : 0;
            if (weightLegacy > 10) return;
          }

          var flat = [];
          flattenLatLngsForGeoJson(layer.getLatLngs(), flat);
          if (flat.length < 2) return;

          var coords = [];
          for (var li = 0; li < flat.length; li++) {
            coords.push([flat[li].lng, flat[li].lat]);
          }

          var drawingViewInfo = getMapViewInfo(layer.sessionId || null);

          features.push({
            type: 'Feature',
            geometry: { type: 'LineString', coordinates: coords },
            properties: {
              sourceType: 'drawing',
              color: layer.options && layer.options.color ? layer.options.color : null,
              strokeWidth: layer.options && isFinite(layer.options.weight) ? Number(layer.options.weight) : null,
              sessionId: layer.sessionId || null,
              mapViewId: drawingViewInfo.mapViewId,
              mapViewName: drawingViewInfo.mapViewName
            }
          });
        });
      }

      var byMapView = {};
      for (var fi = 0; fi < features.length; fi++) {
        var f = features[fi];
        if (!f || !f.properties) continue;
        var key = f.properties.mapViewId !== null && f.properties.mapViewId !== undefined ? String(f.properties.mapViewId) : 'unassigned';
        if (!byMapView[key]) {
          byMapView[key] = {
            mapViewId: f.properties.mapViewId || null,
            mapViewName: f.properties.mapViewName || 'Unassigned',
            featureCount: 0,
            stickersCount: 0,
            annotationsCount: 0,
            drawingsCount: 0
          };
        }
        byMapView[key].featureCount++;
        if (f.properties.sourceType === 'drawing') byMapView[key].drawingsCount++;
        else if (f.properties.sourceType === 'annotation') byMapView[key].annotationsCount++;
        else byMapView[key].stickersCount++;
      }

      var mapViewSummaries = [];
      for (var mvKey in byMapView) {
        mapViewSummaries.push(byMapView[mvKey]);
      }

      var featureCollection = {
        type: 'FeatureCollection',
        properties: {
          exportedAt: new Date().toISOString(),
          appStage: state.stage,
          mapViewCount: mapSessions.length,
          mapViews: mapViewSummaries
        },
        features: features
      };

      var setupDefinition = collectWorkshopSetupDefinition();
      var workshopId = buildWorkshopIdFromSetup(setupDefinition);
      featureCollection.properties.workshopId = workshopId;

      var iso = new Date().toISOString().replace(/[:.]/g, '-');
      downloadGeoJsonFile(featureCollection, workshopId + '-session-' + iso + '.geojson');

      return saveWorkshopSessionToBackend(workshopId, featureCollection, setupDefinition).then(function(payload) {
        if (payload && payload.sessionFile) {
          console.info('Workshop session saved:', payload.sessionFile);
        }
        return {
          saved: true,
          workshopId: workshopId,
          sessionFile: payload && payload.sessionFile ? String(payload.sessionFile) : ''
        };
      }).catch(function(err) {
        console.warn('Failed to save workshop session on backend:', err);
        var message = err && err.message ? err.message : String(err || 'Unknown error');
        setError('Failed to save workshop session on backend: ' + message);
        return {
          saved: false,
          workshopId: workshopId,
          error: message
        };
      });
    } catch (err) {
      console.error('Failed to export workshop GeoJSON:', err);
      var message = err && err.message ? err.message : String(err || 'Unknown error');
      setError('Failed to export workshop GeoJSON: ' + message);
      return Promise.resolve({
        saved: false,
        workshopId: '',
        error: message
      });
    }
  }

  function goToPrevMapSession() {
    if (mapSessions.length === 0) return;
    currentMapSessionIndex--;
    if (currentMapSessionIndex < 0) {
      currentMapSessionIndex = mapSessions.length - 1; // Wrap around
    }
    activateMapSession(currentMapSessionIndex);
  }

  function activateMapSession(index) {
    if (index < 0 || index >= mapSessions.length) {
      state.currentMapSessionId = null;
      filterElementsBySession(null);
      return;
    }
    var session = mapSessions[index];
    if (!session) return;

    state.currentMapSessionId = session.id;
    currentMapSessionIndex = index;

    if (state.leafletMap) {
      state.leafletMap.setView([session.lat, session.lng], session.zoom);
    }

    filterElementsBySession(session.id);
    updateMapSessionListHighlight();
  }

  function filterElementsBySession(sessionId) {
    if (!dom.uiSetupOverlayEl) return;

    // Filter sticker instances and labels
    var elements = dom.uiSetupOverlayEl.querySelectorAll('.ui-sticker-instance, .ui-label');
    for (var i = 0; i < elements.length; i++) {
      var el = elements[i];
      var elSessionId = el.dataset.sessionId;

      if (!sessionId) {
        // No active session - show all elements
        el.classList.remove('hidden');
      } else if (elSessionId === String(sessionId)) {
        // Element belongs to current session - show it
        el.classList.remove('hidden');
      } else if (elSessionId) {
        // Element belongs to different session - hide it
        el.classList.add('hidden');
      } else {
        // Element has no session (created before sessions) - show it
        el.classList.remove('hidden');
      }
    }

    // Filter Leaflet polyline drawings
    filterPolylinesBySession(sessionId);
  }

  function updateMapSessionListHighlight() {
    var items = dom.mapSessionListEl.querySelectorAll('.map-session-item');
    for (var i = 0; i < items.length; i++) {
      var item = items[i];
      var itemId = parseInt(item.dataset.sessionId, 10);
      var isActive = mapSessions[currentMapSessionIndex] && mapSessions[currentMapSessionIndex].id === itemId;
      item.classList.toggle('map-session-item--active', isActive);
    }
  }

  function setVgaPanelVisible(visible) {
    dom.vgaModePanelEl.classList.toggle('hidden', !visible);
    dom.vgaModePanelEl.setAttribute('aria-hidden', visible ? 'false' : 'true');
  }

  function ensureVgaLayers() {
    if (!state.leafletMap || !state.leafletGlobal) return;
    var L = state.leafletGlobal;
    if (!vgaSelectionLayer) {
      vgaSelectionLayer = L.layerGroup().addTo(state.leafletMap);
      vgaSelectionLayer._skipIsovistGeometry = true;
    }
    if (!vgaHeatmapLayer) {
      vgaHeatmapLayer = L.layerGroup().addTo(state.leafletMap);
      vgaHeatmapLayer._skipIsovistGeometry = true;
    }
  }

  function clearLeafletLayer(layer) {
    if (!layer || typeof layer.clearLayers !== 'function') return;
    layer.clearLayers();
  }

  function clearVgaSelection() {
    vgaSelectedCorners = [];
    clearLeafletLayer(vgaSelectionLayer);
    updateVgaPanelMeta();
  }

  function clearVgaHeatmap() {
    clearLeafletLayer(vgaHeatmapLayer);
    vgaHeatPointRadiusPx = 10;
  }

  function setVgaStatus(text) {
    dom.vgaStatusEl.textContent = String(text || '');
  }

  function updateVgaPanelMeta() {
    dom.vgaPointCountEl.textContent = String(vgaSelectedCorners.length) + '/' + String(VGA_REQUIRED_POINTS);
    var canApply = vgaModeActive && !vgaApplying && vgaSelectedCorners.length === VGA_REQUIRED_POINTS;
    dom.vgaApplyBtnEl.disabled = !canApply;
    dom.vgaApplyBtnEl.textContent = vgaApplying ? 'Applying...' : 'Apply';
  }

  function ensureVgaMapClickBinding() {
    if (vgaMapClickBound || !state.leafletMap) return;
    state.leafletMap.on('click', onVgaMapClick);
    vgaMapClickBound = true;
  }

  function onVgaModeBtnClicked() {
    if (resultsModeActive) return;
    if (state.stage !== 3) return;
    if (state.viewMode !== 'map') {
      dom.viewToggleEl.checked = true;
      setViewMode('map');
    }
    setVgaMode(true);
  }

  function setVgaMode(active) {
    var shouldEnable = !!active && state.stage === 3 && state.viewMode === 'map' && !!state.leafletMap;
    if (!shouldEnable && !vgaModeActive) {
      document.body.classList.remove('vga-mode-active');
      setVgaPanelVisible(false);
      return;
    }

    if (shouldEnable) {
      ensureVgaLayers();
      ensureVgaMapClickBinding();
      vgaModeActive = true;
      vgaApplying = false;
      vgaApplyRunId++;
      clearVgaSelection();
      clearVgaHeatmap();
      document.body.classList.add('vga-mode-active');
      setVgaPanelVisible(true);
      setVgaStatus('Ctrl+click four corners on the map.');
      updateVgaPanelMeta();
      resetStage3Gestures();
      updateUiSetupPanelVisibility();
      updateTrackingOffsetControlsVisibility();
      updateToolTagControlsVisibility();
      updateHamburgerMenuVisibility();
      return;
    }

    vgaModeActive = false;
    vgaApplying = false;
    vgaApplyRunId++;
    document.body.classList.remove('vga-mode-active');
    setVgaPanelVisible(false);
    clearVgaSelection();
    clearVgaHeatmap();
    updateUiSetupPanelVisibility();
    updateEdgeGuidesVisibility();
    updateGestureControlsVisibility();
    updateTrackingOffsetControlsVisibility();
    updateToolTagControlsVisibility();
    updateHamburgerMenuVisibility();
  }

  function cloneLatLngForVga(latlng) {
    return cloneShortestPathLatLng(latlng);
  }

  function orderLatLngsClockwise(points) {
    if (!Array.isArray(points) || points.length < 3) return [];
    var sumLat = 0;
    var sumLng = 0;
    var count = 0;
    for (var i = 0; i < points.length; i++) {
      var p = cloneLatLngForVga(points[i]);
      if (!p) continue;
      sumLat += p.lat;
      sumLng += p.lng;
      count++;
    }
    if (count < 3) return [];
    var cLat = sumLat / count;
    var cLng = sumLng / count;
    var sorted = [];
    for (var j = 0; j < points.length; j++) {
      var sp = cloneLatLngForVga(points[j]);
      if (!sp) continue;
      sorted.push(sp);
    }
    sorted.sort(function(a, b) {
      var aa = Math.atan2(a.lat - cLat, a.lng - cLng);
      var bb = Math.atan2(b.lat - cLat, b.lng - cLng);
      return aa - bb;
    });
    return sorted;
  }

  function redrawVgaSelectionOverlay() {
    if (!vgaSelectionLayer || !state.leafletGlobal) return;
    clearLeafletLayer(vgaSelectionLayer);
    var L = state.leafletGlobal;

    for (var i = 0; i < vgaSelectedCorners.length; i++) {
      var p = vgaSelectedCorners[i];
      if (!p) continue;
      var marker = L.circleMarker([p.lat, p.lng], {
        radius: 6,
        color: '#f59e0b',
        weight: 2,
        fillColor: '#f59e0b',
        fillOpacity: 0.95,
        interactive: false
      });
      marker._skipIsovistGeometry = true;
      marker.addTo(vgaSelectionLayer);
    }

    var ordered = orderLatLngsClockwise(vgaSelectedCorners);
    if (ordered.length >= 3) {
      var polygonLatLngs = [];
      for (var k = 0; k < ordered.length; k++) {
        polygonLatLngs.push([ordered[k].lat, ordered[k].lng]);
      }
      var poly = L.polygon(polygonLatLngs, {
        color: '#f59e0b',
        weight: 2,
        fillColor: '#f59e0b',
        fillOpacity: 0.08,
        opacity: 0.95,
        interactive: false
      });
      poly._skipIsovistGeometry = true;
      poly.addTo(vgaSelectionLayer);
    }
  }

  function onVgaMapClick(e) {
    if (!vgaModeActive || vgaApplying) return;
    if (state.stage !== 3 || state.viewMode !== 'map') return;
    if (!e || !e.latlng) return;
    var originalEvent = e.originalEvent;
    var isCtrlClick = !!(originalEvent && (originalEvent.ctrlKey || originalEvent.metaKey));
    if (!isCtrlClick) return;
    if (originalEvent && typeof originalEvent.preventDefault === 'function') originalEvent.preventDefault();
    if (originalEvent && typeof originalEvent.stopPropagation === 'function') originalEvent.stopPropagation();

    var nextPoint = cloneLatLngForVga(e.latlng);
    if (!nextPoint) return;

    if (vgaSelectedCorners.length >= VGA_REQUIRED_POINTS) {
      clearVgaSelection();
      clearVgaHeatmap();
      setVgaStatus('Selection reset. Ctrl+click four corners again.');
    }

    vgaSelectedCorners.push(nextPoint);
    redrawVgaSelectionOverlay();
    if (vgaSelectedCorners.length < VGA_REQUIRED_POINTS) {
      setVgaStatus('Point ' + String(vgaSelectedCorners.length) + ' selected.');
    } else {
      setVgaStatus('4 points selected. Click Apply.');
    }
    updateVgaPanelMeta();
  }

  function pointInsidePolygon(x, y, polygonPoints) {
    if (!Array.isArray(polygonPoints) || polygonPoints.length < 3) return false;
    var inside = false;
    for (var i = 0, j = polygonPoints.length - 1; i < polygonPoints.length; j = i++) {
      var xi = polygonPoints[i][0];
      var yi = polygonPoints[i][1];
      var xj = polygonPoints[j][0];
      var yj = polygonPoints[j][1];
      var intersect = ((yi > y) !== (yj > y)) && (x < ((xj - xi) * (y - yi) / ((yj - yi) || 1e-9) + xi));
      if (intersect) inside = !inside;
    }
    return inside;
  }

  function buildVgaSamplesFromCorners(corners) {
    if (!state.leafletMap || !state.leafletGlobal) return null;
    if (!Array.isArray(corners) || corners.length < VGA_REQUIRED_POINTS) return null;

    var orderedCorners = orderLatLngsClockwise(corners);
    if (orderedCorners.length < 3) return null;

    var map = state.leafletMap;
    var L = state.leafletGlobal;
    var polygonPoints = [];
    for (var i = 0; i < orderedCorners.length; i++) {
      var ll = orderedCorners[i];
      var pt = map.latLngToContainerPoint([ll.lat, ll.lng]);
      if (!pt || !isFinite(pt.x) || !isFinite(pt.y)) continue;
      polygonPoints.push([pt.x, pt.y]);
    }
    if (polygonPoints.length < 3) return null;

    var minX = Infinity;
    var minY = Infinity;
    var maxX = -Infinity;
    var maxY = -Infinity;
    for (var pi = 0; pi < polygonPoints.length; pi++) {
      var p = polygonPoints[pi];
      minX = Math.min(minX, p[0]);
      minY = Math.min(minY, p[1]);
      maxX = Math.max(maxX, p[0]);
      maxY = Math.max(maxY, p[1]);
    }

    var width = maxX - minX;
    var height = maxY - minY;
    if (!isFinite(width) || !isFinite(height) || width <= 2 || height <= 2) return null;

    var area = width * height;
    var stepPx = clamp(Math.sqrt(area / VGA_TARGET_SAMPLE_COUNT), 12, 34);
    var samples = [];
    for (var y = minY + stepPx * 0.5; y <= maxY; y += stepPx) {
      for (var x = minX + stepPx * 0.5; x <= maxX; x += stepPx) {
        if (!pointInsidePolygon(x, y, polygonPoints)) continue;
        var llSample = map.containerPointToLatLng(L.point(x, y));
        var sample = cloneLatLngForVga(llSample);
        if (sample) samples.push(sample);
      }
    }

    if (samples.length > VGA_MAX_SAMPLE_COUNT) {
      var reduced = [];
      var stride = samples.length / VGA_MAX_SAMPLE_COUNT;
      for (var si = 0; si < VGA_MAX_SAMPLE_COUNT; si++) {
        reduced.push(samples[Math.floor(si * stride)]);
      }
      samples = reduced;
    }

    return {
      samples: samples,
      stepPx: stepPx
    };
  }

  function hslToRgb(h, s, l) {
    var hh = h;
    while (hh < 0) hh += 360;
    while (hh >= 360) hh -= 360;
    var c = (1 - Math.abs(2 * l - 1)) * s;
    var hp = hh / 60;
    var x = c * (1 - Math.abs((hp % 2) - 1));
    var r1 = 0;
    var g1 = 0;
    var b1 = 0;

    if (hp < 1) { r1 = c; g1 = x; b1 = 0; }
    else if (hp < 2) { r1 = x; g1 = c; b1 = 0; }
    else if (hp < 3) { r1 = 0; g1 = c; b1 = x; }
    else if (hp < 4) { r1 = 0; g1 = x; b1 = c; }
    else if (hp < 5) { r1 = x; g1 = 0; b1 = c; }
    else { r1 = c; g1 = 0; b1 = x; }

    var m = l - c / 2;
    return [
      Math.round((r1 + m) * 255),
      Math.round((g1 + m) * 255),
      Math.round((b1 + m) * 255)
    ];
  }

  function vgaHeatColorRgb(t) {
    var normalized = clamp(t, 0, 1);
    var hue = (1 - normalized) * 240;
    return hslToRgb(hue, 0.88, 0.52);
  }

  function drawVgaHeatmap(samples, stepPx) {
    if (!vgaHeatmapLayer || !state.leafletGlobal || !state.leafletMap) return;
    clearLeafletLayer(vgaHeatmapLayer);
    if (!Array.isArray(samples) || samples.length < 1) return;

    var L = state.leafletGlobal;
    var map = state.leafletMap;
    var orderedCorners = orderLatLngsClockwise(vgaSelectedCorners);
    if (orderedCorners.length < 3) return;

    var polygonContainer = [];
    var minX = Infinity;
    var minY = Infinity;
    var maxX = -Infinity;
    var maxY = -Infinity;
    for (var ci = 0; ci < orderedCorners.length; ci++) {
      var c = orderedCorners[ci];
      var cpt = map.latLngToContainerPoint([c.lat, c.lng]);
      if (!cpt || !isFinite(cpt.x) || !isFinite(cpt.y)) continue;
      polygonContainer.push([cpt.x, cpt.y]);
      minX = Math.min(minX, cpt.x);
      minY = Math.min(minY, cpt.y);
      maxX = Math.max(maxX, cpt.x);
      maxY = Math.max(maxY, cpt.y);
    }
    if (polygonContainer.length < 3) return;

    var width = maxX - minX;
    var height = maxY - minY;
    if (!isFinite(width) || !isFinite(height) || width < 6 || height < 6) return;

    var longest = Math.max(width, height);
    var scale = clamp(260 / longest, 0.18, 0.6);
    var gridW = Math.max(64, Math.round(width * scale));
    var gridH = Math.max(64, Math.round(height * scale));

    var minScore = Infinity;
    var maxScore = -Infinity;
    for (var i = 0; i < samples.length; i++) {
      var s0 = samples[i];
      if (!s0 || !isFinite(s0.score)) continue;
      minScore = Math.min(minScore, s0.score);
      maxScore = Math.max(maxScore, s0.score);
    }
    if (!isFinite(minScore) || !isFinite(maxScore)) return;

    var sampleGrid = [];
    for (var si = 0; si < samples.length; si++) {
      var sample = samples[si];
      if (!sample || !sample.latlng) continue;
      var spt = map.latLngToContainerPoint([sample.latlng.lat, sample.latlng.lng]);
      if (!spt || !isFinite(spt.x) || !isFinite(spt.y)) continue;
      var rawScore = isFinite(sample.score) ? sample.score : minScore;
      var normScore = (maxScore > minScore) ? ((rawScore - minScore) / (maxScore - minScore)) : 0.5;
      sampleGrid.push({
        x: (spt.x - minX) * scale,
        y: (spt.y - minY) * scale,
        score: clamp(normScore, 0, 1)
      });
    }
    if (sampleGrid.length < 1) return;

    var polygonGrid = [];
    for (var pg = 0; pg < polygonContainer.length; pg++) {
      polygonGrid.push([
        (polygonContainer[pg][0] - minX) * scale,
        (polygonContainer[pg][1] - minY) * scale
      ]);
    }

    var accWeight = new Float32Array(gridW * gridH);
    var accScore = new Float32Array(gridW * gridH);
    var kernelRadius = clamp(stepPx * scale * 2.05, 3.8, 18);
    var radiusSq = kernelRadius * kernelRadius;
    var sigma = Math.max(1.4, kernelRadius * 0.55);
    var gaussDen = 2 * sigma * sigma;
    var kernelMax = Math.ceil(kernelRadius);
    vgaHeatPointRadiusPx = kernelRadius / Math.max(scale, 1e-6);

    for (var k = 0; k < sampleGrid.length; k++) {
      var sp = sampleGrid[k];
      var x0 = Math.max(0, Math.floor(sp.x - kernelMax));
      var x1 = Math.min(gridW - 1, Math.ceil(sp.x + kernelMax));
      var y0 = Math.max(0, Math.floor(sp.y - kernelMax));
      var y1 = Math.min(gridH - 1, Math.ceil(sp.y + kernelMax));

      for (var gy = y0; gy <= y1; gy++) {
        var dy = gy - sp.y;
        for (var gx = x0; gx <= x1; gx++) {
          var dx = gx - sp.x;
          var d2 = dx * dx + dy * dy;
          if (d2 > radiusSq) continue;
          var w = Math.exp(-d2 / gaussDen);
          var idx = gy * gridW + gx;
          accWeight[idx] += w;
          accScore[idx] += w * sp.score;
        }
      }
    }

    var gridCanvas = document.createElement('canvas');
    gridCanvas.width = gridW;
    gridCanvas.height = gridH;
    var gridCtx = gridCanvas.getContext('2d');
    if (!gridCtx) return;
    var img = gridCtx.createImageData(gridW, gridH);
    var px = img.data;

    for (var y = 0; y < gridH; y++) {
      for (var x = 0; x < gridW; x++) {
        if (!pointInsidePolygon(x + 0.5, y + 0.5, polygonGrid)) continue;
        var gi = y * gridW + x;
        var weight = accWeight[gi];
        if (!(weight > 1e-5)) continue;
        var value = clamp(accScore[gi] / weight, 0, 1);
        var rgb = vgaHeatColorRgb(value);
        var di = gi * 4;
        px[di] = rgb[0];
        px[di + 1] = rgb[1];
        px[di + 2] = rgb[2];
        px[di + 3] = 188;
      }
    }
    gridCtx.putImageData(img, 0, 0);

    var outW = Math.max(4, Math.round(width));
    var outH = Math.max(4, Math.round(height));
    var outCanvas = document.createElement('canvas');
    outCanvas.width = outW;
    outCanvas.height = outH;
    var outCtx = outCanvas.getContext('2d');
    if (!outCtx) return;

    outCtx.imageSmoothingEnabled = true;
    outCtx.drawImage(gridCanvas, 0, 0, outW, outH);

    if (typeof outCtx.filter === 'string') {
      outCtx.filter = 'blur(1.2px)';
      outCtx.drawImage(outCanvas, 0, 0);
      outCtx.filter = 'none';
    }

    outCtx.globalCompositeOperation = 'destination-in';
    outCtx.beginPath();
    for (var pc = 0; pc < polygonContainer.length; pc++) {
      var relX = polygonContainer[pc][0] - minX;
      var relY = polygonContainer[pc][1] - minY;
      if (pc === 0) outCtx.moveTo(relX, relY);
      else outCtx.lineTo(relX, relY);
    }
    outCtx.closePath();
    outCtx.fillStyle = '#000';
    outCtx.fill();
    outCtx.globalCompositeOperation = 'source-over';

    var nw = map.containerPointToLatLng(L.point(minX, minY));
    var se = map.containerPointToLatLng(L.point(maxX, maxY));
    var overlay = L.imageOverlay(outCanvas.toDataURL('image/png'), L.latLngBounds(nw, se), {
      opacity: 0.92,
      interactive: false
    });
    overlay._skipIsovistGeometry = true;
    overlay.addTo(vgaHeatmapLayer);
  }

  function runVgaApply() {
    var sampleInfo = buildVgaSamplesFromCorners(vgaSelectedCorners);
    if (!sampleInfo || !Array.isArray(sampleInfo.samples) || sampleInfo.samples.length < 1) {
      setVgaStatus('Selection is too small. Ctrl+click 4 wider corners.');
      return;
    }

    vgaApplying = true;
    var applyRunId = ++vgaApplyRunId;
    updateVgaPanelMeta();
    clearVgaHeatmap();

    var total = sampleInfo.samples.length;
    var scored = [];
    var i = 0;

    function processChunk() {
      if (!vgaModeActive || applyRunId !== vgaApplyRunId) {
        vgaApplying = false;
        updateVgaPanelMeta();
        return;
      }

      var chunkEnd = Math.min(i + 6, total);
      for (; i < chunkEnd; i++) {
        var sampleLatLng = sampleInfo.samples[i];
        var scoreInfo = computeStage4IsovistScore(sampleLatLng);
        var score = (scoreInfo && isFinite(scoreInfo.score)) ? scoreInfo.score : 0;
        scored.push({ latlng: sampleLatLng, score: score });
      }

      setVgaStatus('Computing VGA: ' + String(i) + '/' + String(total));
      if (i < total) {
        setTimeout(processChunk, 0);
        return;
      }

      drawVgaHeatmap(scored, sampleInfo.stepPx);
      vgaApplying = false;
      updateVgaPanelMeta();
      setVgaStatus('VGA heatmap ready (' + String(scored.length) + ' samples).');
    }

    processChunk();
  }

  function onVgaApplyClicked() {
    if (!vgaModeActive || vgaApplying) return;
    if (vgaSelectedCorners.length !== VGA_REQUIRED_POINTS) return;
    runVgaApply();
  }

  // Check if a point (in camera coordinates) is within the calibrated surface
  function isPointInSurface(x, y) {
    if (!state.surfaceHomography) return false;
    var uv = applyHomography(state.surfaceHomography, x, y);
    if (!uv) return false;
    // Point is in surface if UV coordinates are between 0 and 1
    return uv.x >= 0 && uv.x <= 1 && uv.y >= 0 && uv.y <= 1;
  }

  function cloneShortestPathLatLng(latlng) {
    if (!latlng) return null;
    var lat = typeof latlng.lat === 'number' ? latlng.lat : parseFloat(latlng.lat);
    var lng = typeof latlng.lng === 'number' ? latlng.lng : parseFloat(latlng.lng);
    if (!isFinite(lat) || !isFinite(lng)) return null;
    return { lat: lat, lng: lng };
  }

  function shortestPathDistanceMeters(a, b) {
    if (!a || !b) return Infinity;
    var lat1 = a.lat * Math.PI / 180;
    var lat2 = b.lat * Math.PI / 180;
    var dLat = (b.lat - a.lat) * Math.PI / 180;
    var dLng = (b.lng - a.lng) * Math.PI / 180;
    var sinLat = Math.sin(dLat / 2);
    var sinLng = Math.sin(dLng / 2);
    var hav = sinLat * sinLat + Math.cos(lat1) * Math.cos(lat2) * sinLng * sinLng;
    var c = 2 * Math.atan2(Math.sqrt(hav), Math.sqrt(Math.max(0, 1 - hav)));
    return 6371000 * c;
  }

  function resetShortestPathTagRuntime(clearRoute) {
    shortestPathTagRuntime.lastEndpointA = null;
    shortestPathTagRuntime.lastEndpointB = null;
    shortestPathTagRuntime.lastRequestAtMs = 0;
    shortestPathTagRuntime.missingSinceMs = 0;
    if (clearRoute) clearStage4ShortestPath();
  }

  function projectDetectionToMapLatLng(det) {
    if (!det || !det.center) return null;
    if (!state.surfaceHomography || !state.leafletMap) return null;

    var mapW = dom.mapWarpEl.offsetWidth;
    var mapH = dom.mapWarpEl.offsetHeight;
    if (!mapW || !mapH) return null;

    var uv = applyHomography(state.surfaceHomography, det.center.x, det.center.y);
    if (!uv) return null;
    if (uv.x < 0 || uv.x > 1 || uv.y < 0 || uv.y > 1) return null;

    var containerX = uv.x * mapW;
    var containerY = uv.y * mapH;
    var pt = state.leafletGlobal && state.leafletGlobal.point
      ? state.leafletGlobal.point(containerX, containerY)
      : { x: containerX, y: containerY };

    try {
      return cloneShortestPathLatLng(state.leafletMap.containerPointToLatLng(pt));
    } catch (err) {
      return null;
    }
  }

  function resetIsovistTagRuntime(clearOverlay) {
    isovistTagRuntime.lastOrigin = null;
    isovistTagRuntime.lastUpdateAtMs = 0;
    isovistTagRuntime.missingSinceMs = 0;
    if (clearOverlay) clearStage4IsovistOverlay();
  }

  function collectIsovistOriginForTagId(detById, tagId) {
    if (!isFinite(tagId)) return null;
    var det = detById[tagId];
    if (!det || !det.center) return null;
    if (!isPointInSurface(det.center.x, det.center.y)) return null;
    return projectDetectionToMapLatLng(det);
  }

  function collectShortestPathEndpointsForTagIds(detById, tagAId, tagBId) {
    if (!isFinite(tagAId) || !isFinite(tagBId) || tagAId === tagBId) return null;
    var detA = detById[tagAId];
    var detB = detById[tagBId];
    if (!detA || !detA.center || !detB || !detB.center) return null;
    if (!isPointInSurface(detA.center.x, detA.center.y)) return null;
    if (!isPointInSurface(detB.center.x, detB.center.y)) return null;

    var pointA = projectDetectionToMapLatLng(detA);
    var pointB = projectDetectionToMapLatLng(detB);
    if (!pointA || !pointB) return null;
    return { a: pointA, b: pointB };
  }

  // Process tool tags for edge-triggered actions (called each frame)
  function processToolTagActions(detections) {
    if (!detections || !Array.isArray(detections)) return;
    if (state.stage !== 3 && state.stage !== 4) return;
    if (state.viewMode !== 'map') return;
    if (state.stage === 3 && vgaModeActive) return;

    // Build detection lookup by ID
    var detById = {};
    for (var i = 0; i < detections.length; i++) {
      var d = detections[i];
      if (!d || !d.center) continue;
      var id = typeof d.id === 'number' ? d.id : parseInt(d.id, 10);
      if (isFinite(id)) detById[id] = d;
    }

    // Stage 4: drive isovist from configured Isovist tag.
    if (state.stage === 4) {
      var isovistTagId = dom.isovistTagSelectEl.value ? parseInt(dom.isovistTagSelectEl.value, 10) : null;
      if (!isFinite(isovistTagId)) {
        if (isovistTagRuntime.configuredTagId !== null || isovistTagRuntime.lastOrigin) {
          isovistTagRuntime.configuredTagId = null;
          resetIsovistTagRuntime(true);
        }
      } else {
        if (isovistTagRuntime.configuredTagId !== isovistTagId) {
          isovistTagRuntime.configuredTagId = isovistTagId;
          resetIsovistTagRuntime(true);
        }

        var isovistNowMs = performance.now();
        var isovistOrigin = collectIsovistOriginForTagId(detById, isovistTagId);
        if (!isovistOrigin) {
          if (!isovistTagRuntime.missingSinceMs) {
            isovistTagRuntime.missingSinceMs = isovistNowMs;
          }
          if (isovistTagRuntime.lastOrigin &&
              (isovistNowMs - isovistTagRuntime.missingSinceMs) >= ISOVIST_MISSING_HOLD_MS) {
            resetIsovistTagRuntime(true);
            isovistTagRuntime.configuredTagId = isovistTagId;
          }
        } else {
          isovistTagRuntime.missingSinceMs = 0;
          var isovistFirst = !isovistTagRuntime.lastOrigin;
          var isovistMoved = shortestPathDistanceMeters(isovistOrigin, isovistTagRuntime.lastOrigin);
          var isovistIntervalOk = (isovistNowMs - isovistTagRuntime.lastUpdateAtMs) >= ISOVIST_MIN_UPDATE_INTERVAL_MS;
          if (isovistFirst || (isovistMoved >= ISOVIST_JITTER_METERS && isovistIntervalOk)) {
            setStage4IsovistOrigin(isovistOrigin);
            isovistTagRuntime.lastOrigin = cloneShortestPathLatLng(isovistOrigin);
            isovistTagRuntime.lastUpdateAtMs = isovistNowMs;
          }
        }
      }
    } else if (isovistTagRuntime.configuredTagId !== null || isovistTagRuntime.lastOrigin) {
      isovistTagRuntime.configuredTagId = null;
      resetIsovistTagRuntime(true);
    }

    // Process shortest-path tags in Stage 3 and Stage 4.
    if (state.stage === 3 || state.stage === 4) {
      var shortestPathTagAId = dom.shortestPathTagASelectEl.value ? parseInt(dom.shortestPathTagASelectEl.value, 10) : null;
      var shortestPathTagBId = dom.shortestPathTagBSelectEl.value ? parseInt(dom.shortestPathTagBSelectEl.value, 10) : null;
      var shortestPathPairValid = isFinite(shortestPathTagAId) && isFinite(shortestPathTagBId) && shortestPathTagAId !== shortestPathTagBId;

      if (!shortestPathPairValid) {
        if (shortestPathTagRuntime.configuredTagAId !== null ||
            shortestPathTagRuntime.configuredTagBId !== null ||
            shortestPathTagRuntime.lastEndpointA ||
            shortestPathTagRuntime.lastEndpointB) {
          shortestPathTagRuntime.configuredTagAId = null;
          shortestPathTagRuntime.configuredTagBId = null;
          resetShortestPathTagRuntime(true);
        }
      } else {
        if (shortestPathTagRuntime.configuredTagAId !== shortestPathTagAId ||
            shortestPathTagRuntime.configuredTagBId !== shortestPathTagBId) {
          shortestPathTagRuntime.configuredTagAId = shortestPathTagAId;
          shortestPathTagRuntime.configuredTagBId = shortestPathTagBId;
          resetShortestPathTagRuntime(true);
        }

        var nowMs = performance.now();
        var endpoints = collectShortestPathEndpointsForTagIds(detById, shortestPathTagAId, shortestPathTagBId);
        if (!endpoints) {
          if (!shortestPathTagRuntime.missingSinceMs) {
            shortestPathTagRuntime.missingSinceMs = nowMs;
          }
          if (shortestPathTagRuntime.lastEndpointA &&
              shortestPathTagRuntime.lastEndpointB &&
              (nowMs - shortestPathTagRuntime.missingSinceMs) >= SHORTEST_PATH_MISSING_HOLD_MS) {
            resetShortestPathTagRuntime(true);
            shortestPathTagRuntime.configuredTagAId = shortestPathTagAId;
            shortestPathTagRuntime.configuredTagBId = shortestPathTagBId;
          }
        } else {
          shortestPathTagRuntime.missingSinceMs = 0;

          var firstRequest = !shortestPathTagRuntime.lastEndpointA || !shortestPathTagRuntime.lastEndpointB;
          var movedA = shortestPathDistanceMeters(endpoints.a, shortestPathTagRuntime.lastEndpointA);
          var movedB = shortestPathDistanceMeters(endpoints.b, shortestPathTagRuntime.lastEndpointB);
          var movedEnough = movedA >= SHORTEST_PATH_JITTER_METERS || movedB >= SHORTEST_PATH_JITTER_METERS;
          var intervalOk = (nowMs - shortestPathTagRuntime.lastRequestAtMs) >= SHORTEST_PATH_MIN_REQUEST_INTERVAL_MS;

          if (firstRequest || (movedEnough && intervalOk)) {
            setStage4ShortestPathEndpoints(endpoints.a, endpoints.b);
            shortestPathTagRuntime.lastEndpointA = cloneShortestPathLatLng(endpoints.a);
            shortestPathTagRuntime.lastEndpointB = cloneShortestPathLatLng(endpoints.b);
            shortestPathTagRuntime.lastRequestAtMs = nowMs;
          }
        }
      }
    }

    // Get selected tag IDs for next/back
    var nextTagId = dom.nextTagSelectEl.value ? parseInt(dom.nextTagSelectEl.value, 10) : null;
    var backTagId = dom.backTagSelectEl.value ? parseInt(dom.backTagSelectEl.value, 10) : null;

    // Process Next tag
    if (nextTagId && isFinite(nextTagId)) {
      var nextDet = detById[nextTagId];
      var nextInSurface = nextDet ? isPointInSurface(nextDet.center.x, nextDet.center.y) : false;
      var nextWasInSurface = !!toolTagInSurface[nextTagId];

      // Edge trigger: just entered surface
      if (nextInSurface && !nextWasInSurface) {
        goToNextMapSession();
      }

      toolTagInSurface[nextTagId] = nextInSurface;
    }

    // Process Back tag
    if (backTagId && isFinite(backTagId)) {
      var backDet = detById[backTagId];
      var backInSurface = backDet ? isPointInSurface(backDet.center.x, backDet.center.y) : false;
      var backWasInSurface = !!toolTagInSurface[backTagId];

      // Edge trigger: just entered surface
      if (backInSurface && !backWasInSurface) {
        goToPrevMapSession();
      }

      toolTagInSurface[backTagId] = backInSurface;
    }
  }

  // Tracking offset sliders (for AprilTags 11-20)
  dom.trackingOffsetXSliderEl.value = String(Math.round(state.apriltagTrackingOffsetX));
  dom.trackingOffsetXValueEl.textContent = String(Math.round(state.apriltagTrackingOffsetX));
  dom.trackingOffsetXSliderEl.addEventListener('input', function() {
    var v = parseFloat(dom.trackingOffsetXSliderEl.value);
    if (!isFinite(v)) return;
    state.apriltagTrackingOffsetX = clamp(v, -200, 200);
    dom.trackingOffsetXValueEl.textContent = String(Math.round(state.apriltagTrackingOffsetX));
    saveNumberSetting('apriltagTrackingOffsetX', state.apriltagTrackingOffsetX);
  });

  dom.trackingOffsetYSliderEl.value = String(Math.round(state.apriltagTrackingOffsetY));
  dom.trackingOffsetYValueEl.textContent = String(Math.round(state.apriltagTrackingOffsetY));
  dom.trackingOffsetYSliderEl.addEventListener('input', function() {
    var v = parseFloat(dom.trackingOffsetYSliderEl.value);
    if (!isFinite(v)) return;
    state.apriltagTrackingOffsetY = clamp(v, -200, 200);
    dom.trackingOffsetYValueEl.textContent = String(Math.round(state.apriltagTrackingOffsetY));
    saveNumberSetting('apriltagTrackingOffsetY', state.apriltagTrackingOffsetY);
  });

  // ============== Helper Functions ==============

  function showLoading(message) {
    if (message) dom.loadingEl.textContent = message;
    dom.loadingEl.classList.remove('hidden');
  }

  function hideLoading() {
    dom.loadingEl.classList.add('hidden');
  }

  function updateLoadingMessage() {
    if (state.cameraStarting) {
      showLoading('Starting camera...');
    } else {
      hideLoading();
    }
  }

  function setNextEnabled(enabled) {
    dom.nextBtn.disabled = !enabled;
  }

  function setError(text) {
    dom.errorEl.textContent = text;
  }

  function setButtonsRunning(isRunning) {
    dom.startBtn.style.display = isRunning ? 'none' : 'inline-block';
    dom.stopBtn.style.display = isRunning ? 'inline-block' : 'none';
    updateShowResultsButton();
  }

  function updateBackState() {
    var visible = state.stage !== 1;
    dom.backBtn.classList.toggle('hidden', !visible);
    dom.backBtn.disabled = !visible;
  }

  function updateShowResultsButton() {
    var visible = state.stage === 1 && !state.cameraReady && !state.cameraStarting && !resultsModeActive;
    dom.showResultsBtn.style.display = visible ? 'inline-block' : 'none';
    dom.showResultsBtn.disabled = !visible;
  }

  // ============== Stage Management ==============

  function setStage(newStage) {
    if (vgaModeActive && newStage !== 3) {
      setVgaMode(false);
    }
    state.stage = newStage;

    var titles = { 1: 'Camera Setup Stage 1/4', 2: 'Surface Setup Stage 2/4', 3: 'UI Setup Stage 3/4', 4: 'Stage 4/4' };
    dom.pageTitleEl.textContent = titles[newStage] || '';
    document.title = titles[newStage] || '';

    if (newStage === 2 || newStage === 3 || newStage === 4) {
      dom.viewToggleContainerEl.classList.remove('hidden');
    } else {
      dom.viewToggleContainerEl.classList.add('hidden');
    }

    if (newStage === 2) {
      dom.surfaceButtonsEl.classList.remove('hidden');
      setViewMode(dom.viewToggleEl.checked ? 'map' : 'camera');
    } else if (newStage === 3 || newStage === 4) {
      dom.surfaceButtonsEl.classList.add('hidden');
      dom.viewToggleEl.checked = true;
      setViewMode('map');
    } else {
      dom.surfaceButtonsEl.classList.add('hidden');
      setViewMode('camera');
    }

    updateUiSetupPanelVisibility();
    updateEdgeGuidesVisibility();
    updateGestureControlsVisibility();
    updateTrackingOffsetControlsVisibility();
    updateToolTagControlsVisibility();
    updateHamburgerMenuVisibility();
    updateBackState();
    updateShowResultsButton();
  }

  function onNextClicked() {
    if (resultsModeActive) return;
    if (!state.cameraReady) return;
    if (state.stage === 1) { resetSurfaceCorners(); setStage(2); }
    else if (state.stage === 2) { clearArmedCorner(); setStage(3); }
    else if (state.stage === 3) { setStage(4); }
  }

  function onBackClicked() {
    if (resultsModeActive) return;
    if (!state.cameraReady) return;
    if (state.stage === 2) { setStage(1); }
    else if (state.stage === 3) { dom.viewToggleEl.checked = false; setStage(2); }
    else if (state.stage === 4) { dom.viewToggleEl.checked = true; setStage(3); }
  }

  function onViewToggleChanged() {
    if (resultsModeActive) return;
    if (state.stage !== 2 && state.stage !== 3 && state.stage !== 4) return;
    setViewMode(dom.viewToggleEl.checked ? 'map' : 'camera');
  }

  function setViewMode(mode) {
    if (vgaModeActive && mode !== 'map') {
      setVgaMode(false);
    }
    state.viewMode = mode === 'map' ? 'map' : 'camera';

    if (state.viewMode === 'map') {
      setBackendFeedActive(false);
      dom.mapViewEl.classList.remove('hidden');
      dom.mapViewEl.setAttribute('aria-hidden', 'false');
      dom.viewToggleContainerEl.classList.add('toggle-floating');
      initMaptasticIfNeeded();
      initLeafletIfNeeded();
      ensureVgaMapClickBinding();
      updateRoadLayersVisibilityByTags(state.lastApriltagDetections || []);
      updateUiSetupPanelVisibility();
      updateEdgeGuidesVisibility();
      updateGestureControlsVisibility();
      updateTrackingOffsetControlsVisibility();
      updateToolTagControlsVisibility();
      updateHamburgerMenuVisibility();
      if (state.leafletMap) state.leafletMap.invalidateSize();
      setStage4DrawMode(state.stage4DrawMode);
      updateStage4MapInteractivity();
      updateStickerMappingForCurrentView();
    } else {
      setBackendFeedActive(true);
      dom.mapViewEl.classList.add('hidden');
      dom.mapViewEl.setAttribute('aria-hidden', 'true');
      dom.viewToggleContainerEl.classList.add('toggle-floating');
      setMapFingerDotsVisible(false);
      updateUiSetupPanelVisibility();
      updateEdgeGuidesVisibility();
      updateGestureControlsVisibility();
      updateTrackingOffsetControlsVisibility();
      updateToolTagControlsVisibility();
      updateHamburgerMenuVisibility();
      setStage4DrawMode(false);
      updateStage4MapInteractivity();
      updateStickerMappingForCurrentView();
      resetStage3Gestures();
      resumeProcessingIfReady();
    }
  }

  // ============== UI Visibility ==============

  function updateUiSetupPanelVisibility() {
    var overlayVisible = (state.stage === 3 || state.stage === 4) && state.viewMode === 'map' && !vgaModeActive;
    var panelVisible = state.stage === 3 && state.viewMode === 'map' && !vgaModeActive;

    dom.uiSetupOverlayEl.classList.toggle('hidden', !overlayVisible);
    dom.uiSetupOverlayEl.setAttribute('aria-hidden', overlayVisible ? 'false' : 'true');
    dom.uiSetupOverlayEl.classList.toggle('ui-setup-overlay--locked', state.stage === 4);

    dom.uiSetupPanelEl.classList.toggle('hidden', !panelVisible);
    dom.uiSetupPanelEl.setAttribute('aria-hidden', panelVisible ? 'false' : 'true');

    dom.mapSessionPanelEl.classList.toggle('hidden', !panelVisible);
    dom.mapSessionPanelEl.setAttribute('aria-hidden', panelVisible ? 'false' : 'true');

    if (!overlayVisible) resetStage3Gestures();
  }

  function updateEdgeGuidesVisibility() {
    var visible = state.stage === 2 && state.viewMode === 'camera';
    dom.edgeGuidesEl.classList.toggle('hidden', !visible);
    dom.edgeGuidesEl.setAttribute('aria-hidden', visible ? 'false' : 'true');
  }

  function updateGestureControlsVisibility() {
    var visible = state.stage === 3 && state.viewMode === 'camera';
    dom.gestureControlsEl.classList.toggle('hidden', !visible);
    dom.gestureControlsEl.setAttribute('aria-hidden', visible ? 'false' : 'true');
  }

  function updateTrackingOffsetControlsVisibility() {
    var visible = state.stage === 3 && state.viewMode === 'map' && !vgaModeActive;
    dom.trackingOffsetControlsEl.classList.toggle('hidden', !visible);
    dom.trackingOffsetControlsEl.setAttribute('aria-hidden', visible ? 'false' : 'true');
  }

  function updateToolTagControlsVisibility() {
    var visible = state.stage === 3 && state.viewMode === 'map' && !vgaModeActive;
    dom.toolTagControlsEl.classList.toggle('hidden', !visible);
    dom.toolTagControlsEl.setAttribute('aria-hidden', visible ? 'false' : 'true');
  }

  function updateHamburgerMenuVisibility() {
    // Hamburger menu removed; keep DOM hidden and ensure view toggle is in its original place.
    if (dom.hamburgerMenuEl) {
      dom.hamburgerMenuEl.classList.add('hidden');
      dom.hamburgerMenuEl.setAttribute('aria-hidden', 'true');
    }
    setHamburgerOpen(false);
    undockViewToggle();

    // Avoid sticky drawing mode outside Stage 4.
    if (state.stage !== 4 && state.stage4DrawMode) {
      setStage4DrawMode(false);
      updateStage4MapInteractivity();
    }
  }

  function dockViewToggle() {
    if (!dom.hamburgerContentEl || dom.viewToggleContainerEl.parentNode === dom.hamburgerContentEl) return;
    dom.hamburgerContentEl.appendChild(dom.viewToggleContainerEl);
    dom.viewToggleContainerEl.classList.add('hidden');
    dom.viewToggleContainerEl.setAttribute('aria-hidden', 'true');
  }

  function undockViewToggle() {
    if (!state.viewToggleDockParent || dom.viewToggleContainerEl.parentNode !== dom.hamburgerContentEl) return;
    state.viewToggleDockParent.insertBefore(dom.viewToggleContainerEl, state.viewToggleDockNextSibling);
  }

  function setHamburgerOpen(open) {
    state.hamburgerOpen = !!open;
    dom.hamburgerBtnEl.setAttribute('aria-expanded', state.hamburgerOpen ? 'true' : 'false');
    dom.hamburgerPanelEl.classList.toggle('hidden', !state.hamburgerOpen);
    dom.hamburgerPanelEl.setAttribute('aria-hidden', state.hamburgerOpen ? 'false' : 'true');
  }

  // ============== Camera Management ==============

  function pollBackendApriltagsMaybe() {
    if (apriltagPollInFlight) return;
    var now = Date.now();
    var pollMs = state.viewMode === 'map' ? BACKEND_APRILTAG_POLL_MAP_MS : BACKEND_APRILTAG_POLL_CAMERA_MS;
    if ((now - apriltagLastPollMs) < pollMs) return;
    apriltagLastPollMs = now;
    apriltagPollInFlight = true;

    fetch(BACKEND_APRILTAG_API_URL, { cache: 'no-store' }).then(function(resp) {
      if (!resp.ok) throw new Error('HTTP ' + resp.status);
      return resp.json();
    }).then(function(payload) {
      if (!payload || !Array.isArray(payload.detections)) return;
      state.lastApriltagDetections = payload.detections;
      if (payload.ok) {
        apriltagBackendErrorNotified = false;
      } else if (payload.error && !apriltagBackendErrorNotified) {
        setError('AprilTag backend error: ' + payload.error);
        apriltagBackendErrorNotified = true;
      }
    }).catch(function(err) {
      console.warn('AprilTag backend fetch failed:', err);
      if (!apriltagBackendErrorNotified) {
        setError('Cannot reach backend AprilTag API.');
        apriltagBackendErrorNotified = true;
      }
    }).finally(function() {
      apriltagPollInFlight = false;
    });
  }

  async function startCamera() {
    try {
      dom.startBtn.disabled = true;
      setError('');
      state.cameraStarting = true;
      updateLoadingMessage();
      updateShowResultsButton();
      await startIpCamera();
    } catch (err) {
      state.cameraStarting = false;
      state.cameraReady = false;
      updateLoadingMessage();
      dom.startBtn.disabled = false;
      updateShowResultsButton();
      setNextEnabled(false);
      console.error('Error starting backend camera feed:', err);
      setError('Error starting backend camera feed.');
    }
  }

  function stopCamera() {
    pauseProcessing();
    stopIpCameraIfRunning();
    stopCameraStream(state.currentStream);
    state.currentStream = null;
    dom.video.srcObject = null;
    dom.video.classList.add('hidden');
    clearOverlay(state.overlayCtx, dom.overlay);
    updateApriltagHud(dom.apriltagHudEl, null, 0, 0);
    state.lastApriltagDetections = [];
    state.cameraStarting = false;
    state.cameraReady = false;
    updateLoadingMessage();
    dom.startBtn.disabled = false;
    setNextEnabled(false);
    setStage(1);
    dom.viewToggleEl.checked = false;
    resetSurfaceCorners();
    setButtonsRunning(false);
  }

  async function startIpCamera(url) {
    stopCameraStream(state.currentStream);
    state.currentStream = null;
    state.usingIpCamera = true;

    if (!state.ipCameraImg) {
      state.ipCameraImg = document.createElement('img');
      state.ipCameraImg.alt = 'IP camera';
      state.ipCameraImg.id = 'ipCameraImage';
      state.ipCameraImg.decoding = 'async';
      state.ipCameraImg.loading = 'eager';
      state.ipCameraImg.style.cssText = 'width:100%;height:auto;border-radius:8px;background:#000;display:block';
      state.ipCameraImg.crossOrigin = 'anonymous';
      videoContainer.insertBefore(state.ipCameraImg, dom.overlay);
    }
    state.ipCameraImg.style.display = state.viewMode === 'camera' ? 'block' : 'none';

    dom.video.classList.add('hidden');

    try {
      await waitForImageLoad(state.ipCameraImg, buildBackendFeedUrl(url || BACKEND_CAMERA_FEED_URL));
    } catch (err) {
      backendFeedActive = false;
      state.cameraStarting = false;
      state.cameraReady = false;
      updateLoadingMessage();
      dom.startBtn.disabled = false;
      updateShowResultsButton();
      setNextEnabled(false);
      setError('Failed to load backend camera feed.');
      return;
    }

    var w = state.ipCameraImg.naturalWidth || 640;
    var h = state.ipCameraImg.naturalHeight || 480;

    dom.overlay.width = w;
    dom.overlay.height = h;
    state.captureCanvas.width = w;
    state.captureCanvas.height = h;
    dom.overlay.style.height = 'auto';
    dom.overlay.style.aspectRatio = w + ' / ' + h;

    setButtonsRunning(true);
    backendFeedActive = true;
    state.cameraStarting = false;
    state.cameraReady = true;
    updateLoadingMessage();
    setNextEnabled(true);

    state.lastApriltagDetections = [];
    apriltagLastPollMs = 0;
    apriltagPollInFlight = false;
    apriltagBackendErrorNotified = false;
    startProcessing();
  }

  function buildBackendFeedUrl(baseUrl) {
    var sep = baseUrl.indexOf('?') === -1 ? '?' : '&';
    return baseUrl + sep + 't=' + Date.now();
  }

  function setBackendFeedActive(active) {
    if (!state.usingIpCamera || !state.ipCameraImg || !state.cameraReady) return;
    if (active) {
      state.ipCameraImg.style.display = 'block';
      if (!backendFeedActive) {
        state.ipCameraImg.src = buildBackendFeedUrl(BACKEND_CAMERA_FEED_URL);
        backendFeedActive = true;
      }
      return;
    }

    if (backendFeedActive) {
      try { state.ipCameraImg.src = ''; } catch (e) {}
      backendFeedActive = false;
    }
    state.ipCameraImg.style.display = 'none';
  }

  function stopIpCameraIfRunning() {
    if (!state.usingIpCamera) return;
    state.usingIpCamera = false;
    backendFeedActive = false;
    if (state.ipCameraImg) {
      try { state.ipCameraImg.src = ''; } catch (e) {}
      state.ipCameraImg.style.display = 'none';
    }
  }

  // ============== Frame Processing ==============

  function pauseProcessing() {
    state.isProcessing = false;
    if (state.animationId) { cancelAnimationFrame(state.animationId); state.animationId = null; }
  }

  function resumeProcessingIfReady() {
    if (!state.cameraReady || state.viewMode !== 'camera' || state.isProcessing) return;
    startProcessing();
  }

  function startProcessing() {
    state.isProcessing = true;
    processFrame();
  }

  function getApriltagDetectionById(detections, tagId) {
    if (!Array.isArray(detections) || !detections.length) return null;
    var wanted = parseInt(tagId, 10);
    if (!isFinite(wanted)) return null;

    for (var i = 0; i < detections.length; i++) {
      var d = detections[i];
      if (!d) continue;
      var id = typeof d.id === 'number' ? d.id : parseInt(d.id, 10);
      if (id === wanted) return d;
    }
    return null;
  }

  function getApriltagCenter(det) {
    // Get the center of an AprilTag from its corners
    if (!det || !Array.isArray(det.corners) || det.corners.length < 4) return null;

    // Calculate tag center from corners
    var cx = 0, cy = 0;
    for (var i = 0; i < 4; i++) {
      cx += det.corners[i].x;
      cy += det.corners[i].y;
    }
    cx /= 4;
    cy /= 4;

    return { x: cx, y: cy };
  }

  function getSurfaceCornerFromApriltags(detections, cornerIndex, width, height) {
    if (typeof cornerIndex !== 'number' || cornerIndex < 0 || cornerIndex > 3) return null;
    if (!width || !height) return null;

    // Convention: corner buttons 1-4 map to tags 1-4
    // 1: top-left, 2: top-right, 3: bottom-right, 4: bottom-left
    var tagId = cornerIndex + 1;
    var det = getApriltagDetectionById(detections, tagId);
    if (!det) return null;

    // Use the center of the tag as the surface corner
    return getApriltagCenter(det);
  }

  function computeApriltagSurfaceCorners(detections, width, height) {
    var corners = [null, null, null, null];
    for (var i = 0; i < 4; i++) {
      corners[i] = getSurfaceCornerFromApriltags(detections, i, width, height);
      if (!corners[i]) return null;
    }
    return corners;
  }

  function cornersAreClose(a, b, tolPx) {
    if (!a || !b || a.length !== 4 || b.length !== 4) return false;
    var tol2 = (tolPx || 6) * (tolPx || 6);
    for (var i = 0; i < 4; i++) {
      if (!a[i] || !b[i]) return false;
      var dx = a[i].x - b[i].x;
      var dy = a[i].y - b[i].y;
      if (dx * dx + dy * dy > tol2) return false;
    }
    return true;
  }

  function cloneCorners(corners) {
    var out = [null, null, null, null];
    if (!corners || corners.length !== 4) return out;
    for (var i = 0; i < 4; i++) {
      var c = corners[i];
      out[i] = c ? { x: c.x, y: c.y } : null;
    }
    return out;
  }

  function triggerApriltagCalibration() {
    // Capture all 4 corners at once from the currently visible AprilTags (IDs 1-4)
    if (!state.lastApriltagDetections || state.lastApriltagDetections.length < 4) {
      setError('AprilTag calibration requires all 4 tags (IDs 1-4) to be visible.');
      return;
    }

    var width = state.captureCanvas.width;
    var height = state.captureCanvas.height;
    var corners = computeApriltagSurfaceCorners(state.lastApriltagDetections, width, height);

    if (!corners) {
      setError('Could not detect all 4 AprilTags. Make sure tags 1-4 are visible.');
      return;
    }

    // Apply the captured corners
    state.surfaceCorners = corners;
    updateSurfaceButtonsUI();
    recomputeSurfaceHomographyIfReady();

    // Flash all corner buttons to indicate success
    for (var i = 0; i < 4; i++) {
      flashCornerButton(i);
    }

    setError('');
  }

  function processFrame() {
    if (!state.isProcessing) return;

    var width = state.captureCanvas.width;
    var height = state.captureCanvas.height;

    if (state.viewMode === 'camera') {
      var frameSource = state.usingIpCamera && state.ipCameraImg ? state.ipCameraImg : dom.video;
      try {
        state.captureCtx.drawImage(frameSource, 0, 0, width, height);
      } catch (err) {
        state.animationId = requestAnimationFrame(processFrame);
        return;
      }
    }

    if (state.viewMode === 'camera') {
      clearOverlay(state.overlayCtx, dom.overlay);
    }
    pollBackendApriltagsMaybe();

    var isSurfaceSetupCameraView = (state.stage === 2 || state.stage === 3) && state.viewMode === 'camera';

    // Surface-corner capture preview (AprilTags only)
    var surfacePreviewPoint = null;
    if (state.stage === 2 && isSurfaceSetupCameraView && state.armedCornerIndex !== null && state.armedCornerCaptureRequested) {
      surfacePreviewPoint = getSurfaceCornerFromApriltags(state.lastApriltagDetections || [], state.armedCornerIndex, width, height);
    }

    // Single camera corner capture
    if (state.stage === 2 && isSurfaceSetupCameraView && state.armedCornerCaptureRequested && state.armedCornerIndex !== null && surfacePreviewPoint) {
      state.surfaceCorners[state.armedCornerIndex] = { x: surfacePreviewPoint.x, y: surfacePreviewPoint.y };
      flashCornerButton(state.armedCornerIndex);
      clearArmedCorner();
      updateSurfaceButtonsUI();
      recomputeSurfaceHomographyIfReady();
    }

    // Draw calibration overlays
    if (isSurfaceSetupCameraView) {
      drawSurface(state.overlayCtx, state.surfaceCorners, {
        previewIndex: state.armedCornerIndex,
        previewPoint: state.armedCornerIndex !== null ? surfacePreviewPoint : null
      });
    }

    // Map view (Stage 2, 3, and 4)
    var isMapViewWithHomography = (state.stage === 2 || state.stage === 3 || state.stage === 4) && state.viewMode === 'map';
    setMapFingerDotsVisible(false);
    var detections = Array.isArray(state.lastApriltagDetections) ? state.lastApriltagDetections : [];
    var detectionVisibleById = {};
    var detectionById = {};
    for (var di = 0; di < detections.length; di++) {
      var det = detections[di];
      if (!det) continue;
      var detId = typeof det.id === 'number' ? det.id : parseInt(det.id, 10);
      if (!isFinite(detId)) continue;
      detectionVisibleById[detId] = true;
      detectionById[detId] = det;
    }

    // Gesture handling (dwell-to-click and pinch-to-drag for Stage 3 and 4)
    if ((state.stage === 3 || state.stage === 4) && state.viewMode === 'map' && !vgaModeActive) {
      var apriltagPoints = [];
      var secondaryVisibleByPrimaryTag = {};
      var emittedTagIds = {};
      var mapRect = dom.mapWarpEl.getBoundingClientRect();
      var mapW = dom.mapWarpEl.offsetWidth;
      var mapH = dom.mapWarpEl.offsetHeight;
      var canProjectToMap = !!state.surfaceHomography && mapW > 0 && mapH > 0;
      var maxExtrapolation = 1.5;
      if (Array.isArray(state.stage3ParticipantTagIds)) {
        for (var t = 0; t < state.stage3ParticipantTagIds.length; t++) {
          var primaryTagId = parseInt(state.stage3ParticipantTagIds[t], 10);
          var triggerTagId = Array.isArray(state.stage3ParticipantTriggerTagIds) ? parseInt(state.stage3ParticipantTriggerTagIds[t], 10) : NaN;

          if (isFinite(primaryTagId)) {
            secondaryVisibleByPrimaryTag[String(primaryTagId)] = isFinite(triggerTagId) ? !!detectionVisibleById[triggerTagId] : false;
          }
          if (isFinite(triggerTagId)) {
            secondaryVisibleByPrimaryTag[String(triggerTagId)] = isFinite(primaryTagId) ? !!detectionVisibleById[primaryTagId] : false;
          }

          var pairTagIds = [primaryTagId, triggerTagId];
          for (var pi = 0; pi < pairTagIds.length; pi++) {
            var tagId = pairTagIds[pi];
            if (!isFinite(tagId)) continue;
            if (emittedTagIds[tagId]) continue;
            emittedTagIds[tagId] = true;

            var detByTag = detectionById[tagId];
            if (!detByTag || !detByTag.center) continue;

            var touchInfo = state.apriltagTouchById && state.apriltagTouchById[tagId] ? state.apriltagTouchById[tagId] : null;
            var point = {
              handId: String(tagId),
              isApriltag: true,
              tagId: tagId,
              triggerTagVisible: !!secondaryVisibleByPrimaryTag[String(tagId)],
              isTouch: touchInfo ? !!touchInfo.isTouch : null
            };

            if (canProjectToMap) {
              var uv = applyHomography(state.surfaceHomography, detByTag.center.x, detByTag.center.y);
              if (uv && uv.x >= -maxExtrapolation && uv.x <= 1 + maxExtrapolation && uv.y >= -maxExtrapolation && uv.y <= 1 + maxExtrapolation) {
                var x = mapRect.left + uv.x * mapW;
                var y = mapRect.top + uv.y * mapH;

                if (tagId >= 11 && tagId <= 20) {
                  var ox = state.apriltagTrackingOffsetX;
                  var oy = state.apriltagTrackingOffsetY;
                  if (detByTag.corners && detByTag.corners.length >= 4 && (ox !== 0 || oy !== 0)) {
                    var c0 = applyHomography(state.surfaceHomography, detByTag.corners[0].x, detByTag.corners[0].y);
                    var c1 = applyHomography(state.surfaceHomography, detByTag.corners[1].x, detByTag.corners[1].y);
                    if (c0 && c1) {
                      var angle = Math.atan2((c1.y - c0.y) * mapH, (c1.x - c0.x) * mapW);
                      var cosA = Math.cos(angle);
                      var sinA = Math.sin(angle);
                      x += ox * cosA - oy * sinA;
                      y += ox * sinA + oy * cosA;
                    } else {
                      x += ox;
                      y += oy;
                    }
                  } else {
                    x += ox;
                    y += oy;
                  }
                }

                point.x = x;
                point.y = y;
              }
            }

            apriltagPoints.push(point);
          }
        }
      }
      state.stage3SecondaryVisibleByPrimaryTag = secondaryVisibleByPrimaryTag;
      handleStage3Gestures(apriltagPoints);
    } else {
      state.stage3SecondaryVisibleByPrimaryTag = {};
      resetStage3Gestures();
    }

    // Stage 2: allow AprilTags 1-4 to define surface corners automatically (single camera).
    // Uses the tag corner closest to each image corner.
    if (state.stage === 2 && state.viewMode === 'camera' && !state.armedCornerCaptureRequested) {
      var candidate = computeApriltagSurfaceCorners(detections, width, height);
      if (candidate) {
        if (!cornersAreClose(candidate, apriltagSurfaceLastCorners, 6)) {
          apriltagSurfaceStableCount = 1;
          apriltagSurfaceLastCorners = candidate;
        } else {
          apriltagSurfaceStableCount++;
        }

        if (apriltagSurfaceStableCount >= 3) {
          // Smooth to reduce jitter, but keep corners "attached" to tags while visible.
          var alpha = 0.35;
          if (!apriltagSurfaceSmoothedCorners) {
            apriltagSurfaceSmoothedCorners = cloneCorners(candidate);
          } else {
            for (var si = 0; si < 4; si++) {
              if (!apriltagSurfaceSmoothedCorners[si] || !candidate[si]) continue;
              apriltagSurfaceSmoothedCorners[si].x = apriltagSurfaceSmoothedCorners[si].x + alpha * (candidate[si].x - apriltagSurfaceSmoothedCorners[si].x);
              apriltagSurfaceSmoothedCorners[si].y = apriltagSurfaceSmoothedCorners[si].y + alpha * (candidate[si].y - apriltagSurfaceSmoothedCorners[si].y);
            }
          }

          var nextCorners = cloneCorners(apriltagSurfaceSmoothedCorners);
          var needsApply = !areSurfaceCornersReady() || !cornersAreClose(nextCorners, state.surfaceCorners, 2);
          if (needsApply) {
            state.surfaceCorners = nextCorners;
            updateSurfaceButtonsUI();
            recomputeSurfaceHomographyIfReady();
          }
        }
      } else {
        apriltagSurfaceStableCount = 0;
        apriltagSurfaceLastCorners = null;
        apriltagSurfaceSmoothedCorners = null;
      }
    }

    if (state.viewMode === 'camera') {
      updateApriltagHud(dom.apriltagHudEl, detections, width, height);
    } else {
      updateApriltagHud(dom.apriltagHudEl, null, width, height);
    }
    state.apriltagTouchById = null;

    // Map AprilTag debug dots for configured participant IDs
    if (isMapViewWithHomography) {
      updateMapApriltagDots(state.lastApriltagDetections || []);
      updateMapTagMasks(state.lastApriltagDetections || []);
    } else {
      setMapApriltagDotsVisible(false);
      updateMapTagMasks([]);
    }

    // Process tool tag actions (next/back, etc.)
    processToolTagActions(state.lastApriltagDetections || []);
    updateRoadLayersVisibilityByTags(state.lastApriltagDetections || []);

    state.animationId = requestAnimationFrame(processFrame);
  }

  function updateMapFingerDots(cameraPoints) {
    if (!state.surfaceHomography) { setMapFingerDotsVisible(false); return; }

    var w = dom.mapWarpEl.offsetWidth;
    var h = dom.mapWarpEl.offsetHeight;
    if (!w || !h) { setMapFingerDotsVisible(false); return; }

    var required = cameraPoints.length;
    while (dom.mapFingerDotsEl.children.length < required) {
      var dotEl = document.createElement('div');
      dotEl.className = 'map-finger-dot';
      dom.mapFingerDotsEl.appendChild(dotEl);
    }
    while (dom.mapFingerDotsEl.children.length > required) {
      dom.mapFingerDotsEl.removeChild(dom.mapFingerDotsEl.lastChild);
    }

    var anyVisible = false;
    // Allow extrapolation beyond surface bounds to reach UI outside maptastic
    // Limit to reasonable range to avoid dots going too far off screen
    var maxExtrapolation = 1.5; // Allow up to 150% beyond surface in any direction

    for (var i = 0; i < required; i++) {
      var point = cameraPoints[i];
      var dotEl = dom.mapFingerDotsEl.children[i];
      var uv = applyHomography(state.surfaceHomography, point.x, point.y);

      if (!uv || uv.x < -maxExtrapolation || uv.x > 1 + maxExtrapolation || uv.y < -maxExtrapolation || uv.y > 1 + maxExtrapolation) {
        dotEl.classList.add('hidden');
        continue;
      }

      // Don't clamp - allow extrapolation beyond maptastic bounds
      var x = uv.x * w;
      var y = uv.y * h;

      dotEl.style.transform = 'translate(' + (x - 7) + 'px, ' + (y - 7) + 'px)';
      dotEl.classList.remove('hidden');
      // Store handId on the DOM element for gesture tracking
      dotEl.dataset.handId = point.handId || ('hand' + i);
      anyVisible = true;
    }

    setMapFingerDotsVisible(anyVisible);
  }

  function setMapApriltagDotsVisible(visible) {
    if (!dom.mapApriltagDotsEl) return;
    dom.mapApriltagDotsEl.classList.toggle('hidden', !visible);
    dom.mapApriltagDotsEl.setAttribute('aria-hidden', visible ? 'false' : 'true');
  }

  function updateMapApriltagDots(detections) {
    if (!dom.mapApriltagDotsEl) { return; }
    if (!state.surfaceHomography) { setMapApriltagDotsVisible(false); return; }
    if (!Array.isArray(state.stage3ParticipantTagIds) || state.stage3ParticipantTagIds.length < 1) { setMapApriltagDotsVisible(false); return; }

    var w = dom.mapWarpEl.offsetWidth;
    var h = dom.mapWarpEl.offsetHeight;
    if (!w || !h) { setMapApriltagDotsVisible(false); return; }

    var required = state.stage3ParticipantTagIds.length;
    while (dom.mapApriltagDotsEl.children.length < required) {
      var dotEl = document.createElement('div');
      dotEl.className = 'map-finger-dot';
      dom.mapApriltagDotsEl.appendChild(dotEl);
    }
    while (dom.mapApriltagDotsEl.children.length > required) {
      dom.mapApriltagDotsEl.removeChild(dom.mapApriltagDotsEl.lastChild);
    }

    // Index detections by id for quick lookup
    var detById = {};
    if (Array.isArray(detections)) {
      for (var i = 0; i < detections.length; i++) {
        var d = detections[i];
        if (!d) continue;
        var id = typeof d.id === 'number' ? d.id : parseInt(d.id, 10);
        if (!isFinite(id)) continue;
        detById[id] = d;
      }
    }

    var anyVisible = false;
    var maxExtrapolation = 1.5;

    for (var j = 0; j < required; j++) {
      var tagId = parseInt(state.stage3ParticipantTagIds[j], 10);
      var dot = dom.mapApriltagDotsEl.children[j];
      var det = isFinite(tagId) ? detById[tagId] : null;

      if (!det || !det.center) {
        dot.classList.add('hidden');
        continue;
      }

      var uv = applyHomography(state.surfaceHomography, det.center.x, det.center.y);
      if (!uv || uv.x < -maxExtrapolation || uv.x > 1 + maxExtrapolation || uv.y < -maxExtrapolation || uv.y > 1 + maxExtrapolation) {
        dot.classList.add('hidden');
        continue;
      }

      var x = uv.x * w;
      var y = uv.y * h;

      // Apply tracking offset for participant tags (11-20) rotated by tag angle
      if (tagId >= 11 && tagId <= 20) {
        var ox = state.apriltagTrackingOffsetX;
        var oy = state.apriltagTrackingOffsetY;
        // Compute tag rotation angle in screen space from two adjacent corners
        if (det.corners && det.corners.length >= 4 && (ox !== 0 || oy !== 0)) {
          var c0 = applyHomography(state.surfaceHomography, det.corners[0].x, det.corners[0].y);
          var c1 = applyHomography(state.surfaceHomography, det.corners[1].x, det.corners[1].y);
          if (c0 && c1) {
            var angle = Math.atan2((c1.y - c0.y) * h, (c1.x - c0.x) * w);
            var cosA = Math.cos(angle);
            var sinA = Math.sin(angle);
            x += ox * cosA - oy * sinA;
            y += ox * sinA + oy * cosA;
          } else {
            x += ox;
            y += oy;
          }
        } else {
          x += ox;
          y += oy;
        }
      }
      dot.style.transform = 'translate(' + (x - 7) + 'px, ' + (y - 7) + 'px)';
      dot.classList.remove('hidden');
      dot.dataset.tagId = String(tagId);
      anyVisible = true;
    }

    setMapApriltagDotsVisible(anyVisible);
  }

  // Update black masks over detected AprilTag positions in the projected map view
  function updateMapTagMasks(detections) {
    if (!dom.mapTagMasksEl) return;
    if (!state.surfaceHomography) {
      dom.mapTagMasksEl.innerHTML = '';
      return;
    }

    var w = dom.mapWarpEl.offsetWidth;
    var h = dom.mapWarpEl.offsetHeight;
    if (!w || !h) {
      dom.mapTagMasksEl.innerHTML = '';
      return;
    }

    // Use SVG for the masks
    var svg = dom.mapTagMasksEl.querySelector('svg');
    if (!svg) {
      svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
      svg.style.cssText = 'position:absolute;inset:0;width:100%;height:100%;pointer-events:none;';
      dom.mapTagMasksEl.appendChild(svg);
    }
    svg.setAttribute('viewBox', '0 0 ' + w + ' ' + h);
    svg.setAttribute('preserveAspectRatio', 'none');

    var nowMs = performance.now();
    if (Array.isArray(detections)) {
      for (var di = 0; di < detections.length; di++) {
        var det = detections[di];
        if (!det || !det.corners || det.corners.length < 4) continue;
        var detId = typeof det.id === 'number' ? det.id : parseInt(det.id, 10);
        if (!isFinite(detId)) continue;

        var cachedCorners = [];
        for (var ci = 0; ci < 4; ci++) {
          var c = det.corners[ci];
          if (!c) continue;
          cachedCorners.push({ x: c.x, y: c.y });
        }
        if (cachedCorners.length < 4) continue;

        mapTagMaskCacheById[String(detId)] = {
          corners: cachedCorners,
          lastSeenMs: nowMs
        };
      }
    }

    for (var key in mapTagMaskCacheById) {
      var entry = mapTagMaskCacheById[key];
      if (!entry || (nowMs - entry.lastSeenMs) > MAP_TAG_MASK_HOLD_MS) {
        delete mapTagMaskCacheById[key];
      }
    }

    var polygons = [];
    var tagScale = 1.4; // Make detected tag masks 40% larger

    // Draw masks for all tags seen recently (hold for MAP_TAG_MASK_HOLD_MS)
    for (var cacheKey in mapTagMaskCacheById) {
      var cached = mapTagMaskCacheById[cacheKey];
      if (!cached || !cached.corners || cached.corners.length < 4) continue;

        var screenCorners = [];
        var allValid = true;
        for (var j = 0; j < 4; j++) {
          var uv = applyHomography(state.surfaceHomography, cached.corners[j].x, cached.corners[j].y);
          if (!uv) { allValid = false; break; }
          screenCorners.push({ x: uv.x * w, y: uv.y * h });
        }
        if (!allValid) continue;

        // Calculate center in screen coordinates
        var cx = (screenCorners[0].x + screenCorners[1].x + screenCorners[2].x + screenCorners[3].x) / 4;
        var cy = (screenCorners[0].y + screenCorners[1].y + screenCorners[2].y + screenCorners[3].y) / 4;

        // Scale corners outward from center
        var points = [];
        for (var k = 0; k < 4; k++) {
          var sx = cx + (screenCorners[k].x - cx) * tagScale;
          var sy = cy + (screenCorners[k].y - cy) * tagScale;
          points.push(sx + ',' + sy);
        }

        polygons.push('<polygon points="' + points.join(' ') + '" fill="#000000"/>');
    }

    svg.innerHTML = polygons.join('');
  }

  function updateApriltagHud(containerEl, detections, w, h) {
    if (!containerEl) return;

    var visible = state.viewMode === 'camera' && state.cameraReady && Array.isArray(detections) && detections.length > 0 && w > 0 && h > 0;
    containerEl.classList.toggle('hidden', !visible);
    containerEl.setAttribute('aria-hidden', visible ? 'false' : 'true');

    if (!visible) {
      containerEl.textContent = '';
      return;
    }

    // Render as SVG so it overlays video reliably (canvas overlays can be flaky on some platforms).
    var svg = containerEl.querySelector('svg');
    if (!svg) {
      svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
      containerEl.textContent = '';
      containerEl.appendChild(svg);
    }

    svg.setAttribute('viewBox', '0 0 ' + w + ' ' + h);
    svg.setAttribute('preserveAspectRatio', 'none');

    var parts = [];
    for (var i = 0; i < detections.length; i++) {
      var d = detections[i];
      if (!d || !d.corners || d.corners.length < 4 || !d.center) continue;

      var c = d.corners;
      var path = 'M ' + c[0].x + ' ' + c[0].y +
        ' L ' + c[1].x + ' ' + c[1].y +
        ' L ' + c[2].x + ' ' + c[2].y +
        ' L ' + c[3].x + ' ' + c[3].y + ' Z';

      parts.push('<path d="' + path + '" fill="none" stroke="#00ff00" stroke-width="3"/>');
      for (var j = 0; j < c.length; j++) {
        parts.push('<circle cx="' + c[j].x + '" cy="' + c[j].y + '" r="5" fill="#ff0000"/>');
      }

      var id = (typeof d.id === 'number') ? d.id : String(d.id || '');
      parts.push('<text x="' + d.center.x + '" y="' + d.center.y + '" text-anchor="middle" dominant-baseline="middle" font-size="24" font-weight="700" fill="#00ff00">ID: ' + id + '</text>');
    }

    svg.innerHTML = parts.join('');
  }
}
