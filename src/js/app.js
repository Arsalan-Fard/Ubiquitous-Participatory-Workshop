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
  filterPolylinesBySession
} from './stage4Drawing.js';

var BACKEND_CAMERA_FEED_URL = '/video_feed';
var BACKEND_APRILTAG_API_URL = '/api/apriltags';
var BACKEND_APRILTAG_POLL_CAMERA_MS = 60;
var BACKEND_APRILTAG_POLL_MAP_MS = 16;
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
  dom.nextBtn.addEventListener('click', onNextClicked);
  dom.backBtn.addEventListener('click', onBackClicked);
  dom.stopBtn.addEventListener('click', stopCamera);
  dom.viewToggleEl.addEventListener('change', onViewToggleChanged);

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

  // ============== Stage Management ==============

  function setStage(newStage) {
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
      setBackendFeedActive(false);
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
      await startIpCamera();
    } catch (err) {
      state.cameraStarting = false;
      state.cameraReady = false;
      updateLoadingMessage();
      dom.startBtn.disabled = false;
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
    if ((state.stage === 3 || state.stage === 4) && state.viewMode === 'map') {
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

    var polygons = [];
    var tagScale = 1.4; // Make detected tag masks 40% larger

    // Draw masks for all detected tags
    if (Array.isArray(detections)) {
      for (var di = 0; di < detections.length; di++) {
        var det = detections[di];
        if (!det || !det.corners || det.corners.length < 4 || !det.center) continue;

        // Transform all 4 corners of the tag
        var screenCorners = [];
        var allValid = true;
        for (var j = 0; j < 4; j++) {
          var uv = applyHomography(state.surfaceHomography, det.corners[j].x, det.corners[j].y);
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
