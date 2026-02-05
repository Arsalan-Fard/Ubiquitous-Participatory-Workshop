/**
 * Main application entry point
 * Coordinates all modules and handles frame processing
 */

import { getDom } from './dom.js';
import { startCameraStream, stopCameraStream, waitForVideoMetadata, startCameraById } from './camera.js';
import { initDetector } from './detector.js';
import { clearOverlay, drawDetections, drawSurface, drawStereoCalibPoints } from './render.js';
import { initUiSetup } from './uiSetup.js';
import { triangulatePoint } from './stereo.js';
import { clamp, saveNumberSetting, saveCustomCameraSources, waitForImageLoad } from './utils.js';
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

// Stereo calibration
import {
  setupStereoCalibButtonListeners,
  updateStereoUIVisibility,
  captureStereoCalibPoint,
  updateTouchIndicator,
  resetStereoCalibration
} from './stereoCalibration.js';

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
  filterPolylinesBySession
} from './stage4Drawing.js';

export function initApp() {
  // Initialize DOM and state
  var dom = getDom();
  state.dom = dom;

  state.overlayCtx = dom.overlay.getContext('2d');
  state.captureCanvas = document.createElement('canvas');
  state.captureCtx = state.captureCanvas.getContext('2d', { willReadFrequently: true });
  state.apriltagEnabled = true;
  dom.apriltagToggleEl.checked = true;

  // AprilTag-based surface calibration (Stage 2, single-camera)
  var apriltagSurfaceStableCount = 0;
  var apriltagSurfaceLastCorners = null;
  var apriltagSurfaceSmoothedCorners = null;

  var videoContainer = document.getElementById('videoContainer1');
  var videoContainer2 = document.getElementById('videoContainer2');

  initUiSetup({
    panelEl: dom.uiSetupPanelEl,
    overlayEl: dom.uiSetupOverlayEl,
    onNextStage: function () {
      if (state.stage === 3) setStage(4);
    }
  });

  // Event listeners
  dom.startBtn.addEventListener('click', startCamera);
  dom.nextBtn.addEventListener('click', onNextClicked);
  dom.backBtn.addEventListener('click', onBackClicked);
  dom.stopBtn.addEventListener('click', stopCamera);
  dom.viewToggleEl.addEventListener('change', onViewToggleChanged);

  dom.cameraCountSelectEl.addEventListener('change', function() {
    renderCameraDeviceSelects();
    var count = parseInt(dom.cameraCountSelectEl.value, 10);
    state.stereoMode = count === 2;
    updateStereoUIVisibility(videoContainer2);
  });

  dom.cameraAddBtnEl.addEventListener('click', function() {
    if (state.stage !== 1) return;
    openCameraSourceModal();
  });

  dom.cameraSourceCancelBtnEl.addEventListener('click', closeCameraSourceModal);
  dom.cameraSourceSaveBtnEl.addEventListener('click', saveCameraSourceFromModal);

  dom.cameraSourceModalEl.addEventListener('click', function(e) {
    if (e.target && e.target.classList && e.target.classList.contains('modal-backdrop')) {
      closeCameraSourceModal();
    }
  });

  dom.cameraSourceInputEl.addEventListener('keydown', function(e) {
    if (e.key === 'Escape') {
      e.preventDefault();
      closeCameraSourceModal();
    } else if (e.key === 'Enter') {
      e.preventDefault();
      saveCameraSourceFromModal();
    }
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

  // Stereo calibration
  setupStereoCalibButtonListeners(setError);

  // Hamburger menu
  state.viewToggleDockParent = dom.viewToggleContainerEl.parentNode;
  state.viewToggleDockNextSibling = dom.viewToggleContainerEl.nextSibling;

  document.addEventListener('keydown', function(e) {
    if (e.key !== 'Escape') return;
    if (state.stage4DrawMode) setStage4DrawMode(false);
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
  updateCameraSelectVisibility();
  renderCameraDeviceSelects();
  refreshAvailableCameras();
  closeCameraSourceModal();
  updateStereoUIVisibility(videoContainer2);

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

  dom.stereoCalibTagIdEl.value = String(Math.round(state.stereoCalibTagId));
  dom.stereoCalibTagIdEl.addEventListener('input', function () {
    var v = parseFloat(dom.stereoCalibTagIdEl.value);
    if (!isFinite(v)) return;
    state.stereoCalibTagId = clamp(Math.round(v), 0, 9999);
    dom.stereoCalibTagIdEl.value = String(state.stereoCalibTagId);
    saveNumberSetting('stereoCalibTagId', state.stereoCalibTagId);
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
    dom.shortestPathTagSelectEl,
    dom.panTagSelectEl,
    dom.zoomTagSelectEl,
    dom.eraserTagSelectEl,
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

  // Track all tag selects including dynamically added ones for geojson files
  var geojsonFileSelects = [];

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

  // GeoJSON file import
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

    sel.addEventListener('change', updateToolTagSelectsDisabled);
    geojsonFileSelects.push(sel);

    var removeBtn = document.createElement('button');
    removeBtn.className = 'tool-tag-controls__file-remove';
    removeBtn.type = 'button';
    removeBtn.textContent = '×';
    removeBtn.setAttribute('aria-label', 'Remove ' + file.name);
    removeBtn.addEventListener('click', function() {
      var idx = geojsonFileSelects.indexOf(sel);
      if (idx !== -1) geojsonFileSelects.splice(idx, 1);
      row.parentNode.removeChild(row);
      updateToolTagSelectsDisabled();
    });

    row.appendChild(nameSpan);
    row.appendChild(sel);
    row.appendChild(removeBtn);
    dom.geojsonFilesListEl.appendChild(row);

    updateToolTagSelectsDisabled();
  }

  // Map Session functionality
  var mapSessions = [];
  var mapSessionCounter = 0;
  var currentMapSessionIndex = -1;

  // Tool tag detection state (for edge-triggered actions)
  var toolTagInSurface = {}; // tagId -> boolean (was in surface last frame)

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
    currentMapSessionIndex++;
    if (currentMapSessionIndex >= mapSessions.length) {
      currentMapSessionIndex = 0; // Wrap around
    }
    activateMapSession(currentMapSessionIndex);
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

  // Check if a point (in camera coordinates) is within the calibrated surface
  function isPointInSurface(x, y) {
    if (!state.surfaceHomography) return false;
    var uv = applyHomography(state.surfaceHomography, x, y);
    if (!uv) return false;
    // Point is in surface if UV coordinates are between 0 and 1
    return uv.x >= 0 && uv.x <= 1 && uv.y >= 0 && uv.y <= 1;
  }

  // Process tool tags for edge-triggered actions (called each frame)
  function processToolTagActions(detections) {
    if (!detections || !Array.isArray(detections)) return;
    if (state.stage !== 3 && state.stage !== 4) return;
    if (state.viewMode !== 'map') return;

    // Build detection lookup by ID
    var detById = {};
    for (var i = 0; i < detections.length; i++) {
      var d = detections[i];
      if (!d || !d.center) continue;
      var id = typeof d.id === 'number' ? d.id : parseInt(d.id, 10);
      if (isFinite(id)) detById[id] = d;
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
    } else if (state.cameraReady && state.detectorLoading) {
      showLoading('Loading AprilTag detection...');
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
  }

  function updateBackState() {
    var visible = state.stage !== 1;
    dom.backBtn.classList.toggle('hidden', !visible);
    dom.backBtn.disabled = !visible;
  }

  function updateCameraSelectVisibility() {
    var visible = state.stage === 1;
    dom.cameraSelectRowEl.classList.toggle('hidden', !visible);
    if (!visible) closeCameraSourceModal();
  }

  // ============== Stage Management ==============

  function setStage(newStage) {
    state.stage = newStage;

    var titles = { 1: 'Camera Setup Stage 1/4', 2: 'Surface Setup Stage 2/4', 3: 'UI Setup Stage 3/4', 4: 'Stage 4/4' };
    dom.pageTitleEl.textContent = titles[newStage] || '';
    document.title = titles[newStage] || '';

    if (newStage === 2 || newStage === 3 || newStage === 4) {
      dom.apriltagToggleContainerEl.classList.add('hidden');
      dom.viewToggleContainerEl.classList.remove('hidden');
    } else {
      dom.apriltagToggleContainerEl.classList.remove('hidden');
      dom.viewToggleContainerEl.classList.add('hidden');
    }

    if (newStage === 2) {
      dom.surfaceButtonsEl.classList.toggle('hidden', state.stereoMode);
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
    updateStereoUIVisibility(videoContainer2);
    updateHamburgerMenuVisibility();
    updateBackState();
    updateCameraSelectVisibility();
  }

  function onNextClicked() {
    if (!state.cameraReady) return;
    if (state.stage === 1) { resetSurfaceCorners(); setStage(2); }
    else if (state.stage === 2) { clearArmedCorner(); setStage(3); }
    else if (state.stage === 3) { setStage(4); }
  }

  function onBackClicked() {
    if (!state.cameraReady) return;
    if (state.stage === 2) { setStage(1); }
    else if (state.stage === 3) { dom.viewToggleEl.checked = false; setStage(2); }
    else if (state.stage === 4) { dom.viewToggleEl.checked = true; setStage(3); }
  }

  function onViewToggleChanged() {
    if (state.stage !== 2 && state.stage !== 3 && state.stage !== 4) return;
    setViewMode(dom.viewToggleEl.checked ? 'map' : 'camera');
  }

  function setViewMode(mode) {
    state.viewMode = mode === 'map' ? 'map' : 'camera';

    if (state.viewMode === 'map') {
      dom.mapViewEl.classList.remove('hidden');
      dom.mapViewEl.setAttribute('aria-hidden', 'false');
      dom.viewToggleContainerEl.classList.add('toggle-floating');
      initMaptasticIfNeeded();
      initLeafletIfNeeded();
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

  function onApriltagToggleChanged() {
    // AprilTag detection is required (hand tracking removed).
    state.apriltagEnabled = true;
    dom.apriltagToggleEl.checked = true;
    loadDetectorIfNeeded();
  }

  // ============== UI Visibility ==============

  function updateUiSetupPanelVisibility() {
    var overlayVisible = (state.stage === 3 || state.stage === 4) && state.viewMode === 'map';
    var panelVisible = state.stage === 3 && state.viewMode === 'map';

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
    var visible = state.stage === 3 && state.viewMode === 'map';
    dom.trackingOffsetControlsEl.classList.toggle('hidden', !visible);
    dom.trackingOffsetControlsEl.setAttribute('aria-hidden', visible ? 'false' : 'true');
  }

  function updateToolTagControlsVisibility() {
    var visible = state.stage === 3 && state.viewMode === 'map';
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

  function loadDetectorIfNeeded() {
    if (!state.apriltagEnabled || state.detector || state.detectorLoading) return;
    state.detectorLoading = true;
    updateLoadingMessage();
    initDetector().then(function(d) {
      state.detector = d;
      state.detectorLoading = false;
      updateLoadingMessage();
    }, function(err) {
      console.error('Failed to initialize detector:', err);
      state.detectorLoading = false;
      updateLoadingMessage();
    });
  }

  async function startCamera() {
    try {
      dom.startBtn.disabled = true;
      setError('');
      state.cameraStarting = true;
      updateLoadingMessage();

      var selectedSource = getSelectedCameraSource();
      if (selectedSource && selectedSource.type === 'ip') {
        await startIpCamera(selectedSource.url);
        return;
      }

      stopIpCameraIfRunning();
      state.usingIpCamera = false;
      state.pixelReadBlockedNotified = false;
      dom.video.classList.remove('hidden');

      var selectedDeviceId = selectedSource && selectedSource.type === 'device' ? selectedSource.deviceId : null;
      var videoConstraints = { width: { ideal: 640 }, height: { ideal: 480 } };
      if (selectedDeviceId) {
        videoConstraints.deviceId = { exact: selectedDeviceId };
      } else {
        videoConstraints.facingMode = 'environment';
      }

      var stream = await startCameraStream(dom.video, { video: videoConstraints, audio: false });
      state.currentStream = stream;
      await waitForVideoMetadata(dom.video);

      dom.overlay.width = dom.video.videoWidth;
      dom.overlay.height = dom.video.videoHeight;
      state.captureCanvas.width = dom.video.videoWidth;
      state.captureCanvas.height = dom.video.videoHeight;

      setButtonsRunning(true);
      state.cameraStarting = false;
      state.cameraReady = true;
      updateLoadingMessage();
      setNextEnabled(true);

      loadDetectorIfNeeded();

      var cameraCount = parseInt(dom.cameraCountSelectEl.value, 10);
      state.stereoMode = cameraCount === 2;
      if (state.stereoMode) {
        var ok = await startSecondCamera();
        if (!ok) { setError('Failed to start second camera. Stereo mode disabled.'); state.stereoMode = false; }
      }
      updateStereoUIVisibility(videoContainer2);
      refreshAvailableCameras();
      startProcessing();
    } catch (err) {
      state.cameraStarting = false;
      state.cameraReady = false;
      updateLoadingMessage();
      dom.startBtn.disabled = false;
      setNextEnabled(false);
      console.error('Error accessing camera:', err);
      setError(cameraErrorMessage(err));
    }
  }

  function stopCamera() {
    pauseProcessing();
    stopIpCameraIfRunning();
    stopCameraStream(state.currentStream);
    state.currentStream = null;
    stopSecondCamera();
    dom.video.srcObject = null;
    dom.video.classList.remove('hidden');
    clearOverlay(state.overlayCtx, dom.overlay);
    updateApriltagHud(dom.apriltagHudEl, null, 0, 0);
    updateApriltagHud(dom.apriltagHud2El, null, 0, 0);
    state.cameraStarting = false;
    state.cameraReady = false;
    updateLoadingMessage();
    dom.startBtn.disabled = false;
    setNextEnabled(false);
    setStage(1);
    dom.viewToggleEl.checked = false;
    resetSurfaceCorners();
    resetStereoCalibration(videoContainer2);
    setButtonsRunning(false);
  }

  async function startSecondCamera() {
    var selectEl = dom.cameraDeviceSelectsEl.querySelector('select[data-camera-index="1"]');
    if (!selectEl) return false;
    var deviceId = selectEl.value;
    if (!deviceId || deviceId.startsWith('ip:')) return false;

    try {
      var video2 = document.getElementById('video2');
      if (!video2) return false;
      state.currentStream2 = await startCameraById(video2, deviceId, { width: 640, height: 480 });
      await waitForVideoMetadata(video2);

      state.captureCanvas2 = document.createElement('canvas');
      state.captureCanvas2.width = video2.videoWidth;
      state.captureCanvas2.height = video2.videoHeight;
      state.captureCtx2 = state.captureCanvas2.getContext('2d', { willReadFrequently: true });

      var overlay2 = document.getElementById('overlay2');
      if (overlay2) { overlay2.width = video2.videoWidth; overlay2.height = video2.videoHeight; }

      return true;
    } catch (err) {
      console.error('Failed to start second camera:', err);
      return false;
    }
  }

  function stopSecondCamera() {
    if (state.currentStream2) { stopCameraStream(state.currentStream2); state.currentStream2 = null; }
    state.captureCanvas2 = null;
    state.captureCtx2 = null;
  }

  async function startIpCamera(url) {
    stopCameraStream(state.currentStream);
    state.currentStream = null;
    state.usingIpCamera = true;
    state.pixelReadBlockedNotified = false;

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

    dom.video.classList.add('hidden');

    try {
      await waitForImageLoad(state.ipCameraImg, url);
    } catch (err) {
      state.cameraStarting = false;
      state.cameraReady = false;
      updateLoadingMessage();
      dom.startBtn.disabled = false;
      setNextEnabled(false);
      setError('Failed to load IP camera URL.');
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
    state.cameraStarting = false;
    state.cameraReady = true;
    updateLoadingMessage();
    setNextEnabled(true);

    loadDetectorIfNeeded();

    var cameraCount = parseInt(dom.cameraCountSelectEl.value, 10);
    state.stereoMode = cameraCount === 2;
    if (state.stereoMode) {
      var ok = await startSecondCamera();
      if (!ok) { setError('Failed to start second camera. Stereo mode disabled.'); state.stereoMode = false; }
    }
    updateStereoUIVisibility(videoContainer2);
    startProcessing();
  }

  function stopIpCameraIfRunning() {
    if (!state.usingIpCamera) return;
    state.usingIpCamera = false;
    if (state.ipCameraImg) { try { state.ipCameraImg.src = ''; } catch (e) {} }
  }

  function cameraErrorMessage(err) {
    if (!err || typeof err !== 'object') return 'Error accessing camera.';
    if (err.name === 'NotAllowedError') return 'Camera access denied. Please allow camera permissions.';
    if (err.name === 'NotFoundError') return 'No camera found on this device.';
    return 'Error accessing camera: ' + (err.message || String(err));
  }

  // ============== Camera Source UI ==============

  async function refreshAvailableCameras() {
    if (!navigator.mediaDevices || !navigator.mediaDevices.enumerateDevices) return;
    try {
      var devices = await navigator.mediaDevices.enumerateDevices();
      state.availableVideoDevices = devices.filter(function(d) { return d && d.kind === 'videoinput'; });
      renderCameraDeviceSelects();
    } catch (err) {
      console.warn('Failed to enumerate camera devices:', err);
    }
  }

  function getSelectedCameraSource() {
    var selectEl = dom.cameraDeviceSelectsEl.querySelector('select[data-camera-index="0"]');
    if (!selectEl) return null;
    var id = String(selectEl.value || '').trim();
    if (!id) return null;
    return id.startsWith('ip:') ? { type: 'ip', url: id.slice(3) } : { type: 'device', deviceId: id };
  }

  function renderCameraDeviceSelects() {
    var count = parseInt(dom.cameraCountSelectEl.value, 10);
    if (isNaN(count) || count < 0) count = 0;
    if (count > 2) count = 2;

    var previousValues = [];
    var existing = dom.cameraDeviceSelectsEl.querySelectorAll('select');
    for (var i = 0; i < existing.length; i++) previousValues[i] = existing[i].value;

    dom.cameraDeviceSelectsEl.textContent = '';

    for (var index = 0; index < count; index++) {
      var selectEl = document.createElement('select');
      selectEl.className = 'camera-select';
      selectEl.setAttribute('aria-label', 'Camera ' + (index + 1));
      selectEl.dataset.cameraIndex = String(index);

      var placeholder = document.createElement('option');
      placeholder.value = '';
      placeholder.textContent = 'Select camera...';
      selectEl.appendChild(placeholder);

      for (var d = 0; d < state.availableVideoDevices.length; d++) {
        var device = state.availableVideoDevices[d];
        var opt = document.createElement('option');
        opt.value = device.deviceId || '';
        opt.textContent = device.label || ('Camera ' + (d + 1));
        selectEl.appendChild(opt);
      }

      if (state.customCameraSources.length > 0) {
        var group = document.createElement('optgroup');
        group.label = 'IP camera sources';
        for (var s = 0; s < state.customCameraSources.length; s++) {
          var url = state.customCameraSources[s];
          var opt2 = document.createElement('option');
          opt2.value = 'ip:' + url;
          opt2.textContent = url;
          group.appendChild(opt2);
        }
        selectEl.appendChild(group);
      }

      if (previousValues[index]) selectEl.value = previousValues[index];
      else if (state.availableVideoDevices[index]) selectEl.value = state.availableVideoDevices[index].deviceId;

      dom.cameraDeviceSelectsEl.appendChild(selectEl);
    }
  }

  function openCameraSourceModal() {
    dom.cameraSourceInputEl.value = '';
    dom.cameraSourceModalEl.classList.remove('hidden');
    dom.cameraSourceModalEl.setAttribute('aria-hidden', 'false');
    setTimeout(function() { dom.cameraSourceInputEl.focus(); }, 0);
  }

  function closeCameraSourceModal() {
    dom.cameraSourceModalEl.classList.add('hidden');
    dom.cameraSourceModalEl.setAttribute('aria-hidden', 'true');
  }

  function saveCameraSourceFromModal() {
    var raw = String(dom.cameraSourceInputEl.value || '').trim();
    if (!raw) return;
    if (!raw.startsWith('http://') && !raw.startsWith('https://')) {
      setError('Camera source must start with http:// or https://');
      return;
    }
    if (state.customCameraSources.indexOf(raw) === -1) {
      state.customCameraSources.push(raw);
      saveCustomCameraSources(state.customCameraSources);
    }
    closeCameraSourceModal();
    renderCameraDeviceSelects();
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

  function getApriltagInnerCorner(det, cornerIndex) {
    // Get the inner corner of an AprilTag based on its position in the surface layout.
    // AprilTag corners order varies by library. We find the corner closest to the tag center
    // that is in the direction toward the surface center.
    //
    // For a 4-tag calibration setup, we want the corner pointing toward the surface center:
    // - Tag at top-left (cornerIndex 0): inner corner is toward bottom-right
    // - Tag at top-right (cornerIndex 1): inner corner is toward bottom-left
    // - Tag at bottom-right (cornerIndex 2): inner corner is toward top-left
    // - Tag at bottom-left (cornerIndex 3): inner corner is toward top-right
    if (!det || !Array.isArray(det.corners) || det.corners.length < 4) return null;

    // Calculate tag center from corners
    var cx = 0, cy = 0;
    for (var i = 0; i < 4; i++) {
      cx += det.corners[i].x;
      cy += det.corners[i].y;
    }
    cx /= 4;
    cy /= 4;

    // Determine which direction the inner corner should be relative to tag center
    // cornerIndex: 0=top-left tag, 1=top-right tag, 2=bottom-right tag, 3=bottom-left tag
    // Inner direction: 0->bottom-right, 1->bottom-left, 2->top-left, 3->top-right
    var dirX = (cornerIndex === 0 || cornerIndex === 3) ? 1 : -1;  // right for 0,3; left for 1,2
    var dirY = (cornerIndex === 0 || cornerIndex === 1) ? 1 : -1;  // down for 0,1; up for 2,3

    // Find the corner that is in the inner direction from the tag center
    var best = null;
    var bestScore = -Infinity;
    for (var j = 0; j < 4; j++) {
      var c = det.corners[j];
      var dx = c.x - cx;
      var dy = c.y - cy;
      var score = dx * dirX + dy * dirY;
      if (score > bestScore) {
        bestScore = score;
        best = c;
      }
    }

    return best ? { x: best.x, y: best.y } : null;
  }

  function getSurfaceCornerFromApriltags(detections, cornerIndex, width, height) {
    if (typeof cornerIndex !== 'number' || cornerIndex < 0 || cornerIndex > 3) return null;
    if (!width || !height) return null;

    // Convention: corner buttons 1-4 map to tags 1-4
    // 1: top-left, 2: top-right, 3: bottom-right, 4: bottom-left
    var tagId = cornerIndex + 1;
    var det = getApriltagDetectionById(detections, tagId);
    if (!det) return null;

    return getApriltagInnerCorner(det, cornerIndex);
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
    if (!state.apriltagEnabled || !state.lastApriltagDetections || state.lastApriltagDetections.length < 4) {
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

  async function processFrame() {
    if (!state.isProcessing) return;

    var width = state.captureCanvas.width;
    var height = state.captureCanvas.height;

    var frameSource = state.usingIpCamera && state.ipCameraImg ? state.ipCameraImg : dom.video;
    try {
      state.captureCtx.drawImage(frameSource, 0, 0, width, height);
    } catch (err) {
      state.animationId = requestAnimationFrame(processFrame);
      return;
    }

    var imageData = null;
    try {
      imageData = state.captureCtx.getImageData(0, 0, width, height);
    } catch (err) {
      if (!state.pixelReadBlockedNotified && state.usingIpCamera) {
        state.pixelReadBlockedNotified = true;
        setError('IP camera stream is visible, but pixel processing is blocked (CORS).');
      }
      state.animationId = requestAnimationFrame(processFrame);
      return;
    }

    if (state.viewMode === 'camera') {
      clearOverlay(state.overlayCtx, dom.overlay);
    }

    var imageData2 = null;
    if (state.stereoMode && state.captureCanvas2 && state.captureCtx2) {
      try {
        var video2 = document.getElementById('video2');
        if (video2 && video2.readyState >= 2) {
          var w2 = state.captureCanvas2.width;
          var h2 = state.captureCanvas2.height;
          state.captureCtx2.drawImage(video2, 0, 0, w2, h2);
          imageData2 = state.captureCtx2.getImageData(0, 0, w2, h2);
        }
      } catch (err) {
        console.error('Camera 2 frame read error:', err);
      }
    }

    var isSurfaceSetupCameraView = (state.stage === 2 || state.stage === 3) && state.viewMode === 'camera';

    // Surface-corner capture preview (AprilTags only)
    var surfacePreviewPoint = null;
    if (!state.stereoMode && state.stage === 2 && isSurfaceSetupCameraView && state.armedCornerIndex !== null && state.armedCornerCaptureRequested) {
      surfacePreviewPoint = getSurfaceCornerFromApriltags(state.lastApriltagDetections || [], state.armedCornerIndex, width, height);
    }

    // Single camera corner capture
    if (!state.stereoMode && state.stage === 2 && isSurfaceSetupCameraView && state.armedCornerCaptureRequested && state.armedCornerIndex !== null && surfacePreviewPoint) {
      state.surfaceCorners[state.armedCornerIndex] = { x: surfacePreviewPoint.x, y: surfacePreviewPoint.y };
      flashCornerButton(state.armedCornerIndex);
      clearArmedCorner();
      updateSurfaceButtonsUI();
      recomputeSurfaceHomographyIfReady();
    }

    // Stereo calibration preview points (use selected AprilTag ID)
    var stereoPreview1 = null;
    var stereoPreview2 = null;
    if (state.stereoMode) {
      var calibId = parseInt(state.stereoCalibTagId, 10);
      if (isFinite(calibId) && Array.isArray(state.lastApriltagDetections)) {
        for (var sp1 = 0; sp1 < state.lastApriltagDetections.length; sp1++) {
          var dd1 = state.lastApriltagDetections[sp1];
          if (!dd1 || !dd1.center) continue;
          var idd1 = typeof dd1.id === 'number' ? dd1.id : parseInt(dd1.id, 10);
          if (idd1 === calibId) { stereoPreview1 = { x: dd1.center.x, y: dd1.center.y }; break; }
        }
      }
      if (isFinite(calibId) && Array.isArray(state.lastApriltagDetections2)) {
        for (var sp2 = 0; sp2 < state.lastApriltagDetections2.length; sp2++) {
          var dd2 = state.lastApriltagDetections2[sp2];
          if (!dd2 || !dd2.center) continue;
          var idd2 = typeof dd2.id === 'number' ? dd2.id : parseInt(dd2.id, 10);
          if (idd2 === calibId) { stereoPreview2 = { x: dd2.center.x, y: dd2.center.y }; break; }
        }
      }
    }

    // Draw calibration overlays
    if (isSurfaceSetupCameraView) {
      if (state.stereoMode) {
        drawStereoCalibPoints(state.overlayCtx, state.stereoCalibrationPoints, 'camera1Pixel', {
          armedIndex: state.stereoArmedPointIndex,
          previewPoint: stereoPreview1
        });

        var overlay2 = document.getElementById('overlay2');
        if (overlay2) {
          var ctx2 = overlay2.getContext('2d');
          if (ctx2) {
            ctx2.clearRect(0, 0, overlay2.width, overlay2.height);
            drawStereoCalibPoints(ctx2, state.stereoCalibrationPoints, 'camera2Pixel', {
              armedIndex: state.stereoArmedPointIndex,
              previewPoint: stereoPreview2
            });
          }
        }
      } else {
        drawSurface(state.overlayCtx, state.surfaceCorners, {
          previewIndex: state.armedCornerIndex,
          previewPoint: state.armedCornerIndex !== null ? surfacePreviewPoint : null
        });
      }
    }

    // Map view (Stage 2, 3, and 4)
    var isMapViewWithHomography = (state.stage === 2 || state.stage === 3 || state.stage === 4) && state.viewMode === 'map';
    setMapFingerDotsVisible(false);

    // Gesture handling (dwell-to-click and pinch-to-drag for Stage 3 and 4)
    if ((state.stage === 3 || state.stage === 4) && state.viewMode === 'map') {
      var apriltagPoints = [];
      if (Array.isArray(state.stage3ParticipantTagIds)) {
        for (var t = 0; t < state.stage3ParticipantTagIds.length; t++) {
          var tagId = parseInt(state.stage3ParticipantTagIds[t], 10);
          if (!isFinite(tagId)) continue;
          var touchInfo = state.apriltagTouchById && state.apriltagTouchById[tagId] ? state.apriltagTouchById[tagId] : null;
          apriltagPoints.push({
            handId: String(tagId),
            isApriltag: true,
            tagId: tagId,
            isTouch: touchInfo ? !!touchInfo.isTouch : null
          });
        }
      }
      handleStage3Gestures(apriltagPoints);
    } else {
      resetStage3Gestures();
    }

    // AprilTag detection (keep latest results for map debug dots and AprilTag gestures)
    // Grayscale conversion moved to worker for better performance
    if (state.apriltagEnabled && state.detector) {
      try {
        // Use detectRGBA - grayscale conversion happens in worker thread
        var detections = await state.detector.detectRGBA(imageData.data, width, height);
        state.lastApriltagDetections = detections || [];

        // Stage 2: allow AprilTags 1-4 to define surface corners automatically (single camera).
        // Uses the tag corner closest to each image corner.
        if (!state.stereoMode && state.stage === 2 && state.viewMode === 'camera' && !state.armedCornerCaptureRequested) {
          var candidate = computeApriltagSurfaceCorners(state.lastApriltagDetections, width, height);
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
          updateApriltagHud(dom.apriltagHudEl, state.lastApriltagDetections, width, height);
          // Keep canvas drawing too (useful on platforms where it renders correctly).
          if (detections && detections.length > 0) {
            drawDetections(state.overlayCtx, detections);
          }
        } else {
          updateApriltagHud(dom.apriltagHudEl, null, width, height);
        }

        // Stereo AprilTags (camera 2 detections + optional touch sensing)
        if (state.stereoMode && imageData2) {
          try {
            // Use detectRGBA for camera 2 as well
            var detections2 = await state.detector.detectRGBA(imageData2.data, imageData2.width, imageData2.height);
            state.lastApriltagDetections2 = detections2 || [];
            if (state.viewMode === 'camera') {
              updateApriltagHud(dom.apriltagHud2El, state.lastApriltagDetections2, imageData2.width, imageData2.height);
            } else {
              updateApriltagHud(dom.apriltagHud2El, null, imageData2.width, imageData2.height);
            }

            var det1ById = {};
            for (var di1 = 0; di1 < (state.lastApriltagDetections || []).length; di1++) {
              var d1 = state.lastApriltagDetections[di1];
              if (!d1) continue;
              var id1 = typeof d1.id === 'number' ? d1.id : parseInt(d1.id, 10);
              if (!isFinite(id1) || !d1.center) continue;
              det1ById[id1] = d1;
            }

            var det2ById = {};
            for (var di2 = 0; di2 < (state.lastApriltagDetections2 || []).length; di2++) {
              var d2 = state.lastApriltagDetections2[di2];
              if (!d2) continue;
              var id2 = typeof d2.id === 'number' ? d2.id : parseInt(d2.id, 10);
              if (!isFinite(id2) || !d2.center) continue;
              det2ById[id2] = d2;
            }

            // Stage 2: capture stereo calibration points using the selected calibration tag ID.
            if (state.stage === 2 && state.stereoArmedPointIndex !== null) {
              var calibId = parseInt(state.stereoCalibTagId, 10);
              var ca = isFinite(calibId) ? (det1ById[calibId] || null) : null;
              var cb = isFinite(calibId) ? (det2ById[calibId] || null) : null;
              if (ca && cb) {
                captureStereoCalibPoint(ca.center, cb.center);
              }
            }

            // Stage 3/4: touch/hover classification for participant tags (requires calibration)
            if (state.stereoCalibrationReady && (state.stage === 3 || state.stage === 4) && Array.isArray(state.stage3ParticipantTagIds)) {
              var touchById = {};
              for (var ti = 0; ti < state.stage3ParticipantTagIds.length; ti++) {
                var tagId2 = parseInt(state.stage3ParticipantTagIds[ti], 10);
                if (!isFinite(tagId2)) continue;
                var a = det1ById[tagId2] || null;
                var b = det2ById[tagId2] || null;

                // Require both cameras for touch/hover; missing is treated as not-touch (cancels pinch).
                if (!a || !b) {
                  touchById[tagId2] = { isTouch: false, z: null };
                  continue;
                }

                var wp = triangulatePoint(state.stereoProjectionMatrix1, state.stereoProjectionMatrix2, a.center, b.center);
                if (!wp) {
                  touchById[tagId2] = { isTouch: false, z: null };
                  continue;
                }

                var isTouch = Math.abs(wp.z) < state.touchZThreshold;
                touchById[tagId2] = { isTouch: isTouch, z: wp.z };
              }
              state.apriltagTouchById = touchById;
            } else {
              state.apriltagTouchById = null;
            }
          } catch (err2) {
            state.apriltagTouchById = null;
            updateApriltagHud(dom.apriltagHud2El, null, imageData2 ? imageData2.width : 0, imageData2 ? imageData2.height : 0);
          }
        } else {
          state.lastApriltagDetections2 = null;
          state.apriltagTouchById = null;
          updateApriltagHud(dom.apriltagHud2El, null, imageData2 ? imageData2.width : 0, imageData2 ? imageData2.height : 0);
        }
      } catch (err) {
        console.error('AprilTag detection error:', err);
      }
    } else {
      if (state.viewMode === 'camera') {
        updateApriltagHud(dom.apriltagHudEl, null, width, height);
        updateApriltagHud(dom.apriltagHud2El, null, imageData2 ? imageData2.width : 0, imageData2 ? imageData2.height : 0);
      }
    }

    // Map AprilTag debug dots for configured participant IDs
    if (isMapViewWithHomography) {
      updateMapApriltagDots(state.lastApriltagDetections || []);
    } else {
      setMapApriltagDotsVisible(false);
    }

    // Process tool tag actions (next/back, etc.)
    processToolTagActions(state.lastApriltagDetections || []);

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

      // Apply tracking offset for participant tags (11-20) in screen coordinates
      if (tagId >= 11 && tagId <= 20) {
        x += state.apriltagTrackingOffsetX;
        y += state.apriltagTrackingOffsetY;
      }
      dot.style.transform = 'translate(' + (x - 7) + 'px, ' + (y - 7) + 'px)';
      dot.classList.remove('hidden');
      dot.dataset.tagId = String(tagId);
      anyVisible = true;
    }

    setMapApriltagDotsVisible(anyVisible);
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
