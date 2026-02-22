/**
 * Main application entry point
 * Coordinates all modules and handles frame processing
 */

import { getDom } from './dom.js';
import { stopCameraStream } from './camera.js';
import { clearOverlay, drawSurface, drawPlaneCalibrationGuide } from './render.js';
import { initUiSetup } from './uiSetup.js';
import { clamp, normalizeTagId, saveNumberSetting, waitForImageLoad } from './utils.js';
import { state } from './state.js';
import {
  addPolyline, addPolygon, addCircleMarker, addImageOverlay,
  createLayerGroup, addToGroup, clearGroup,
  updateSourceData
} from './mapHelpers.js';

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
  resetStage3Gestures,
  updateApriltagTriggerSelections,
  applyRemoteApriltagToolOverrides,
  applyRemoteApriltagNoteStateOverrides
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
  computeStage4IsovistScore,
  fetchBuildingsForBounds,
  setMapBaseMode
} from './stage4Drawing.js';

var BACKEND_CAMERA_FEED_URL = '/video_feed';
var BACKEND_APRILTAG_API_URL = '/api/apriltags';
var BACKEND_APRILTAG_STREAM_URL = '/api/apriltags/stream';
var BACKEND_WORKSHOP_SESSION_API_URL = '/api/workshop_session';
var BACKEND_WORKSHOPS_API_URL = '/api/workshops';
var BACKEND_APRILTAG_POLL_CAMERA_MS = 60;
var BACKEND_APRILTAG_POLL_MAP_MS = 40;
var BACKEND_APRILTAG_POLL_BACKOFF_BASE_MS = 250;
var BACKEND_APRILTAG_POLL_BACKOFF_MAX_MS = 5000;
var BACKEND_APRILTAG_STREAM_RECONNECT_BASE_MS = 500;
var BACKEND_APRILTAG_STREAM_RECONNECT_MAX_MS = 5000;
var MAP_TAG_MASK_HOLD_MS = 1000;
var APRILTAG_BLACKOUT_TOOL_SELECTOR = '.ui-note, .ui-draw, .ui-eraser, .ui-selection, .ui-layer-square';
var BLACKOUT_PULSE_INTERVAL_MS = 1000;
var BLACKOUT_PULSE_DURATION_MS = 100;
var BLACKOUT_PULSE_STORAGE_KEY = 'apriltagBlackoutPulseEnabled';
var MAP_MONO_STYLE_STORAGE_KEY = 'mapMonochromeStyleEnabled';
var PRIMARY_OFFSET_GRID_STORAGE_KEY = 'apriltagPrimaryOffsetGridV1';
var PHONE_CONNECT_DEFAULT_PATH = '/?mode=controller';
var PHONE_CONNECT_QR_ENDPOINT = 'https://api.qrserver.com/v1/create-qr-code/';
var PRIMARY_OFFSET_GRID_POINTS_UV = [
  { u: 0.0, v: 0.0 }, { u: 0.5, v: 0.0 }, { u: 1.0, v: 0.0 },
  { u: 0.0, v: 0.5 }, { u: 0.5, v: 0.5 }, { u: 1.0, v: 0.5 },
  { u: 0.0, v: 1.0 }, { u: 0.5, v: 1.0 }, { u: 1.0, v: 1.0 }
];
var apriltagPollInFlight = false;
var apriltagLastPollMs = 0;
var apriltagPollBackoffMs = 0;
var apriltagPollBlockedUntilMs = 0;
var apriltagBackendErrorNotified = false;
var apriltagBackoffNotified = false;
var apriltagEventSource = null;
var apriltagStreamState = 'idle'; // idle | connecting | open | backoff
var apriltagStreamReconnectMs = 0;
var apriltagStreamReconnectTimerId = 0;
var apriltagStreamBackoffNotified = false;
var apriltagLastStreamSeq = -1;
var backendFeedActive = false;
var blackoutPulseEnabled = false;
var blackoutPulseLastAtMs = 0;
var blackoutPulseUntilMs = 0;
var blackoutPulseNextAtMs = 0;
var blackoutPulseActive = false;
var blackoutOverlayEl = null;
var mapMonochromeStyleEnabled = false;

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
  var primaryOffsetCalibPointEls = [];

  var videoContainer = document.getElementById('videoContainer1');

  function hasCompletePrimaryOffsetGrid(grid) {
    if (!Array.isArray(grid) || grid.length !== 9) return false;
    for (var i = 0; i < grid.length; i++) {
      var p = grid[i];
      if (!p || !isFinite(p.ox) || !isFinite(p.oy)) return false;
    }
    return true;
  }

  function loadPrimaryOffsetGridFromStorage() {
    var raw = localStorage.getItem(PRIMARY_OFFSET_GRID_STORAGE_KEY);
    if (!raw) return null;
    var parsed = null;
    try {
      parsed = JSON.parse(raw);
    } catch (e) {
      return null;
    }
    return hasCompletePrimaryOffsetGrid(parsed) ? parsed : null;
  }

  function savePrimaryOffsetGridToStorage(grid) {
    if (!hasCompletePrimaryOffsetGrid(grid)) {
      localStorage.removeItem(PRIMARY_OFFSET_GRID_STORAGE_KEY);
      return;
    }
    localStorage.setItem(PRIMARY_OFFSET_GRID_STORAGE_KEY, JSON.stringify(grid));
  }

  function clearPrimaryOffsetGridFromStorage() {
    localStorage.removeItem(PRIMARY_OFFSET_GRID_STORAGE_KEY);
  }

  function updatePrimaryOffsetCalibrationStatus() {
    if (!dom.trackingOffset9ptStatusEl) return;
    if (state.apriltagPrimaryOffsetCalibActive) {
      dom.trackingOffset9ptStatusEl.textContent = 'Point ' + String(state.apriltagPrimaryOffsetCalibIndex + 1) + '/9';
      return;
    }
    dom.trackingOffset9ptStatusEl.textContent = hasCompletePrimaryOffsetGrid(state.apriltagPrimaryOffsetGrid)
      ? 'Calibrated (9/9)'
      : 'Not calibrated';
  }

  function setPrimaryOffsetCalibUiEnabled(active) {
    if (!dom.trackingOffset9ptBtnEl || !dom.trackingOffset9ptCaptureBtnEl) return;
    dom.trackingOffset9ptBtnEl.textContent = active ? 'Stop 9pt' : 'Start 9pt';
    dom.trackingOffset9ptCaptureBtnEl.disabled = !active;
    dom.trackingOffset9ptBtnEl.classList.toggle('tracking-offset-controls__action-btn--active', !!active);
  }

  state.apriltagPrimaryOffsetGrid = loadPrimaryOffsetGridFromStorage();
  state.apriltagPrimaryOffsetCalibActive = false;
  state.apriltagPrimaryOffsetCalibIndex = 0;

  // Dots and masks use screen-space coordinates from the surface homography.
  // They must live in mapView (not mapWarp) so Maptastic doesn't double-warp them.
  // UV from homography maps directly to physical screen position.
  if (dom.mapTagMasksEl && dom.mapViewEl && dom.mapTagMasksEl.parentNode !== dom.mapViewEl) {
    dom.mapViewEl.appendChild(dom.mapTagMasksEl);
  }
  if (dom.mapApriltagDotsEl && dom.mapViewEl && dom.mapApriltagDotsEl.parentNode !== dom.mapViewEl) {
    dom.mapViewEl.appendChild(dom.mapApriltagDotsEl);
  }
  if (dom.mapFingerDotsEl && dom.mapViewEl && dom.mapFingerDotsEl.parentNode !== dom.mapViewEl) {
    dom.mapViewEl.appendChild(dom.mapFingerDotsEl);
  }

  initUiSetup({
    panelEl: dom.uiSetupPanelEl,
    overlayEl: dom.uiSetupOverlayEl,
    actionsHostEl: dom.stage3ActionBarEl,
    getSetupExportData: buildMapSetupExportData,
    applySetupImportData: applyMapSetupImportData,
    onNextStage: function () {
      if (state.stage === 3) setStage(4);
    }
  });
  mountVgaButtonToActionBar();
  initBlackoutPulseToggle();
  initMapStyleToggle();
  initPhoneConnectPanel();

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
    triggerApriltagCalibration();
  });

  // Surface plane calibration button - toggles collection of tag 3D poses for touch detection
  dom.surfacePlaneBtn.addEventListener('click', function() {
    toggleSurfacePlaneCollection();
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

  // Stage 4 shortcut: press B to return to Stage 3.
  document.addEventListener('keydown', function(e) {
    if (resultsModeActive) return;
    if (state.stage !== 4) return;
    if (e.repeat) return;
    var key = String(e.key || '').toLowerCase();
    if (key !== 'b') return;

    var target = e.target;
    if (target) {
      var tag = String(target.tagName || '').toUpperCase();
      if (tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT' || target.isContentEditable) return;
      if (target.closest && target.closest('.ui-note__form')) return;
    }

    e.preventDefault();
    dom.viewToggleEl.checked = true;
    setStage(3);
  });

  function buildDefaultPhoneControllerUrl() {
    try {
      return new URL(PHONE_CONNECT_DEFAULT_PATH, window.location.href).toString();
    } catch (e) {
      return PHONE_CONNECT_DEFAULT_PATH;
    }
  }

  function normalizePhoneControllerUrl(rawValue) {
    var text = String(rawValue || '').trim();
    if (!text) return '';
    try {
      var parsed = new URL(text, window.location.href);
      var protocol = String(parsed.protocol || '').toLowerCase();
      if (protocol !== 'http:' && protocol !== 'https:') return '';
      return parsed.toString();
    } catch (e) {
      return '';
    }
  }

  function setPhoneConnectStatus(message, isError) {
    if (!dom.phoneConnectStatusEl) return;
    dom.phoneConnectStatusEl.textContent = message || '';
    dom.phoneConnectStatusEl.classList.toggle('phone-connect-panel__status--error', !!isError);
  }

  function copyPhoneControllerUrl(url) {
    if (!url) return Promise.reject(new Error('Invalid URL'));
    if (navigator.clipboard && typeof navigator.clipboard.writeText === 'function') {
      return navigator.clipboard.writeText(url);
    }
    return new Promise(function(resolve, reject) {
      var inputEl = document.createElement('input');
      inputEl.type = 'text';
      inputEl.value = url;
      inputEl.style.position = 'fixed';
      inputEl.style.left = '-9999px';
      inputEl.style.top = '-9999px';
      document.body.appendChild(inputEl);
      inputEl.focus();
      inputEl.select();
      var ok = false;
      try {
        ok = document.execCommand('copy');
      } catch (e) {
        ok = false;
      }
      if (inputEl.parentNode) inputEl.parentNode.removeChild(inputEl);
      if (ok) resolve();
      else reject(new Error('Copy failed'));
    });
  }

  function initPhoneConnectPanel() {
    if (!dom.phoneConnectPanelEl) return;
    if (!dom.phoneConnectUrlInputEl || !dom.phoneConnectGenerateBtnEl || !dom.phoneConnectQrImgEl || !dom.phoneConnectOpenLinkEl || !dom.phoneConnectCopyBtnEl) return;

    var userEditedUrl = false;

    function updateQrFromInput() {
      var normalizedUrl = normalizePhoneControllerUrl(dom.phoneConnectUrlInputEl.value);
      if (!normalizedUrl) {
        dom.phoneConnectOpenLinkEl.href = '#';
        dom.phoneConnectOpenLinkEl.textContent = '';
        dom.phoneConnectQrImgEl.removeAttribute('src');
        setPhoneConnectStatus('Enter a valid http/https URL.', true);
        return;
      }

      dom.phoneConnectUrlInputEl.value = normalizedUrl;
      dom.phoneConnectOpenLinkEl.href = normalizedUrl;
      dom.phoneConnectOpenLinkEl.textContent = normalizedUrl;
      setPhoneConnectStatus('Generating QR...', false);
      dom.phoneConnectQrImgEl.src = PHONE_CONNECT_QR_ENDPOINT + '?size=260x260&margin=10&data=' + encodeURIComponent(normalizedUrl) + '&t=' + Date.now();
    }

    dom.phoneConnectQrImgEl.addEventListener('load', function() {
      setPhoneConnectStatus('QR ready. Phones can scan this link.', false);
    });

    dom.phoneConnectQrImgEl.addEventListener('error', function() {
      setPhoneConnectStatus('QR image failed to load. Use the link text directly.', true);
    });

    dom.phoneConnectGenerateBtnEl.addEventListener('click', function() {
      updateQrFromInput();
    });

    dom.phoneConnectUrlInputEl.addEventListener('input', function() {
      userEditedUrl = true;
    });

    dom.phoneConnectCopyBtnEl.addEventListener('click', function() {
      var normalizedUrl = normalizePhoneControllerUrl(dom.phoneConnectUrlInputEl.value);
      if (!normalizedUrl) {
        setPhoneConnectStatus('Enter a valid URL before copying.', true);
        return;
      }
      copyPhoneControllerUrl(normalizedUrl).then(function() {
        setPhoneConnectStatus('Copied link to clipboard.', false);
      }).catch(function() {
        setPhoneConnectStatus('Could not copy link automatically.', true);
      });
    });

    dom.phoneConnectUrlInputEl.addEventListener('keydown', function(e) {
      if (e.key !== 'Enter') return;
      e.preventDefault();
      updateQrFromInput();
    });

    var defaultUrl = buildDefaultPhoneControllerUrl();
    dom.phoneConnectUrlInputEl.value = defaultUrl;
    updateQrFromInput();

    // Try to detect the LAN address that Flask prints as the second "Running on ...".
    fetch('/api/server_info', { cache: 'no-store' }).then(function(resp) {
      return resp.text().then(function(text) {
        if (!resp.ok) throw new Error('HTTP ' + resp.status);
        var body = null;
        try { body = text ? JSON.parse(text) : null; } catch (e) { body = null; }
        if (!body || body.ok !== true) throw new Error('invalid_response');
        return body;
      });
    }).then(function(info) {
      if (userEditedUrl) return;
      var suggested = String(info.suggestedControllerUrl || '').trim();
      if (!suggested) return;

      var current = normalizePhoneControllerUrl(dom.phoneConnectUrlInputEl.value);
      if (current && current !== defaultUrl) {
        // Respect existing values that don't look like localhost defaults.
        try {
          var parsed = new URL(current);
          var h = String(parsed.hostname || '').toLowerCase();
          if (h && h !== 'localhost' && h.indexOf('127.') !== 0) return;
        } catch (e) { }
      }

      dom.phoneConnectUrlInputEl.value = suggested;
      updateQrFromInput();
    }).catch(function() {
      // Ignore; fallback is window.location.href based default.
    });
  }

  // Global shortcut: press H to recapture the surface from AprilTags 1-4.
  // In Stage 3 VGA mode, H toggles red highlight on the hovered building instead.
  document.addEventListener('keydown', function(e) {
    if (resultsModeActive) return;
    if (e.repeat) return;
    var key = String(e.key || '').toLowerCase();
    if (key !== 'h') return;

    var target = e.target;
    if (target) {
      var tag = String(target.tagName || '').toUpperCase();
      if (tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT' || target.isContentEditable) return;
      if (target.closest && target.closest('.ui-note__form')) return;
    }

    if (state.stage === 3 && state.viewMode === 'map' && vgaModeActive) {
      e.preventDefault();
      toggleVgaHoveredBuildingHighlight();
      return;
    }

    e.preventDefault();
    triggerApriltagCalibration();
  });

  // Track mouse position globally for manual corner placement
  var lastMouseX = 0;
  var lastMouseY = 0;

  document.addEventListener('mousemove', function(e) {
    lastMouseX = e.clientX;
    lastMouseY = e.clientY;
    updateVgaHoverClientPointFromMouseEvent(e);
  });

  function trySetSurfaceCornerFromClientPoint(cornerIndex, clientX, clientY) {
    if (typeof cornerIndex !== 'number' || cornerIndex < 0 || cornerIndex > 3) return false;
    if (!isFinite(clientX) || !isFinite(clientY)) return false;

    var videoEl = state.usingIpCamera && state.ipCameraImg ? state.ipCameraImg : dom.video;
    if (!videoEl) return false;

    var rect = videoEl.getBoundingClientRect();
    if (!rect || !rect.width || !rect.height || !dom.overlay.width || !dom.overlay.height) return false;
    if (clientX < rect.left || clientX > rect.right || clientY < rect.top || clientY > rect.bottom) return false;

    var scaleX = dom.overlay.width / rect.width;
    var scaleY = dom.overlay.height / rect.height;
    var cornerX = (clientX - rect.left) * scaleX;
    var cornerY = (clientY - rect.top) * scaleY;

    state.surfaceCorners[cornerIndex] = { x: cornerX, y: cornerY };
    flashCornerButton(cornerIndex);
    updateSurfaceButtonsUI();
    recomputeSurfaceHomographyIfReady();
    return true;
  }

  // Keyboard shortcuts 1-4 to set surface corners from current mouse position.
  document.addEventListener('keydown', function(e) {
    // Only in stage 2, camera view
    if (state.stage !== 2) return;
    if (state.viewMode !== 'camera') return;
    if (e.repeat) return;

    var target = e.target;
    if (target) {
      var tag = String(target.tagName || '').toUpperCase();
      if (tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT' || target.isContentEditable) return;
      if (target.closest && target.closest('.ui-note__form')) return;
    }

    var cornerIndex = null;
    if (e.key === '1') cornerIndex = 0;
    else if (e.key === '2') cornerIndex = 1;
    else if (e.key === '3') cornerIndex = 2;
    else if (e.key === '4') cornerIndex = 3;

    if (cornerIndex === null) return;
    e.preventDefault();

    if (trySetSurfaceCornerFromClientPoint(cornerIndex, lastMouseX, lastMouseY)) return;

    // If mouse is not currently over video, arm this corner for the next click on camera view.
    armCorner(cornerIndex, setViewMode);
  });

  // Manual Stage 2 corner capture: click inside camera view while a corner button is armed.
  document.addEventListener('pointerdown', function(e) {
    if (state.stage !== 2) return;
    if (state.viewMode !== 'camera') return;
    if (!state.armedCornerCaptureRequested || state.armedCornerIndex === null) return;
    if (trySetSurfaceCornerFromClientPoint(state.armedCornerIndex, e.clientX, e.clientY)) {
      clearArmedCorner();
      updateSurfaceButtonsUI();
      e.preventDefault();
    }
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

    // Handle note stickers
    var stickerEl = e.target.closest('.ui-note');
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
    if (state.map) state.map.resize();
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

  // Stage 3 layer buttons spawn draggable 60px square stickers.
  var layerStickerColorsByName = {
    'Isovist': '#7e8794',
    'Shortest-path': '#7e8794',
    'Pan': '#7e8794',
    'Zoom': '#7e8794',
    'Next': '#7e8794',
    'Back': '#7e8794'
  };
  var layerNavVoteLatch = { next: false, back: false };
  var roadColorPalette = ['#ff5a5f', '#2bb8ff', '#2ec27e', '#f6c945', '#ff8a3d', '#9c6dff'];
  var importedRoadEntries = [];
  var importedRoadLayerCounter = 1;
  var roadLayersVisible = false;
  var roadVisibilityDirty = true;

  document.addEventListener('pointerdown', function(e) {
    if (state.stage !== 3 || state.viewMode !== 'map') return;
    if (!dom.uiSetupOverlayEl || dom.uiSetupOverlayEl.classList.contains('hidden')) return;
    if (!e.target || !e.target.closest) return;

    var layerBtnEl = e.target.closest('.tool-tag-controls__layer-btn');
    if (layerBtnEl && dom.toolTagControlsEl.contains(layerBtnEl)) {
      if (e.button !== 0) return;
      e.preventDefault();
      e.stopImmediatePropagation();
      var layerName = layerBtnEl.dataset && layerBtnEl.dataset.layerName ? String(layerBtnEl.dataset.layerName) : '';
      if (!layerName) return;
      var stickerEl = createLayerSticker(layerName, e.clientX, e.clientY);
      if (stickerEl) startStickerDrag(stickerEl, e);
      return;
    }

    var existingStickerEl = e.target.closest('.ui-layer-square');
    if (!existingStickerEl || !dom.uiSetupOverlayEl.contains(existingStickerEl)) return;
    if (e.button !== 0) return;
    e.preventDefault();
    e.stopImmediatePropagation();
    startStickerDrag(existingStickerEl, e);
  }, true);

  document.addEventListener('contextmenu', function(e) {
    if (state.stage !== 3) return;
    if (!e.target || !e.target.closest) return;
    var stickerEl = e.target.closest('.ui-layer-square');
    if (!stickerEl || !dom.uiSetupOverlayEl.contains(stickerEl)) return;
    e.preventDefault();
    if (stickerEl.parentNode) stickerEl.parentNode.removeChild(stickerEl);
  });

  function createLayerSticker(layerName, clientX, clientY) {
    if (!dom.uiSetupOverlayEl) return null;
    var name = String(layerName || '').trim();
    if (!name) return null;

    var stickerEl = document.createElement('div');
    stickerEl.className = 'ui-dot ui-sticker-instance ui-layer-square';
    stickerEl.dataset.uiType = 'layer-square';
    stickerEl.dataset.layerName = name;
    stickerEl.dataset.color = layerStickerColorsByName[name] || '#2bb8ff';
    if (state.currentMapSessionId !== null && state.currentMapSessionId !== undefined) {
      stickerEl.dataset.sessionId = String(state.currentMapSessionId);
    }
    stickerEl.style.background = stickerEl.dataset.color;
    stickerEl.style.left = (clientX - 45) + 'px';
    stickerEl.style.top = (clientY - 45) + 'px';

    var textEl = document.createElement('span');
    textEl.className = 'ui-layer-square__text';
    textEl.textContent = name;
    stickerEl.appendChild(textEl);

    dom.uiSetupOverlayEl.appendChild(stickerEl);
    return stickerEl;
  }

  function markRoadVisibilityDirty() {
    roadVisibilityDirty = true;
  }

  function getRoadEntryColor(entry) {
    return entry && entry.colorInput && entry.colorInput.value ? entry.colorInput.value : '#2bb8ff';
  }

  function setRoadLayerIdsVisibility(entry, visible) {
    if (!entry || !entry.roadLayerIds || !state.map) return;
    var ids = entry.roadLayerIds;
    var visibility = visible ? 'visible' : 'none';
    var keys = ['point', 'line', 'polygonFill', 'polygonStroke'];
    for (var i = 0; i < keys.length; i++) {
      var layerId = ids[keys[i]];
      if (!layerId) continue;
      try {
        if (state.map.getLayer(layerId)) {
          state.map.setLayoutProperty(layerId, 'visibility', visibility);
        }
      } catch (e) { /* ignore */ }
    }
  }

  function updateRoadLayerColor(entry) {
    if (!entry || !entry.roadLayerIds || !state.map) return;
    var color = getRoadEntryColor(entry);
    var ids = entry.roadLayerIds;
    try {
      if (ids.line && state.map.getLayer(ids.line)) {
        state.map.setPaintProperty(ids.line, 'line-color', color);
      }
      if (ids.point && state.map.getLayer(ids.point)) {
        state.map.setPaintProperty(ids.point, 'circle-color', color);
        state.map.setPaintProperty(ids.point, 'circle-stroke-color', color);
      }
      if (ids.polygonFill && state.map.getLayer(ids.polygonFill)) {
        state.map.setPaintProperty(ids.polygonFill, 'fill-color', color);
      }
      if (ids.polygonStroke && state.map.getLayer(ids.polygonStroke)) {
        state.map.setPaintProperty(ids.polygonStroke, 'line-color', color);
      }
    } catch (e) { /* ignore */ }
  }

  function removeRoadLayer(entry) {
    if (!entry) return;

    if (!state.map) {
      entry.roadSourceId = '';
      entry.roadLayerIds = null;
      return;
    }

    if (entry.roadLayerIds) {
      var ids = entry.roadLayerIds;
      var keys = ['point', 'line', 'polygonFill', 'polygonStroke'];
      for (var i = 0; i < keys.length; i++) {
        var layerId = ids[keys[i]];
        if (!layerId) continue;
        try {
          if (state.map.getLayer(layerId)) state.map.removeLayer(layerId);
        } catch (e1) { /* ignore */ }
      }
    }
    if (entry.roadSourceId) {
      try {
        if (state.map.getSource(entry.roadSourceId)) state.map.removeSource(entry.roadSourceId);
      } catch (e2) { /* ignore */ }
    }
    entry.roadSourceId = '';
    entry.roadLayerIds = null;
  }

  function ensureRoadLayerOnMap(entry) {
    if (!entry || entry.removed) return;
    if (!entry.geojsonData) return;
    if (!state.map || !state.mapReady) return;

    var color = getRoadEntryColor(entry);

    if (!entry.roadLayerIds || !entry.roadSourceId) {
      var sourceId = 'roads-' + String(importedRoadLayerCounter++) + '-src';
      var lineLayerId = sourceId + '-ln';
      var pointLayerId = sourceId + '-pt';
      var polygonFillLayerId = sourceId + '-pgf';
      var polygonStrokeLayerId = sourceId + '-pgl';

      state.map.addSource(sourceId, {
        type: 'geojson',
        data: entry.geojsonData
      });

      state.map.addLayer({
        id: polygonFillLayerId,
        type: 'fill',
        source: sourceId,
        filter: ['match', ['geometry-type'], ['Polygon', 'MultiPolygon'], true, false],
        paint: {
          'fill-color': color,
          'fill-opacity': 0.14
        }
      });

      state.map.addLayer({
        id: polygonStrokeLayerId,
        type: 'line',
        source: sourceId,
        filter: ['match', ['geometry-type'], ['Polygon', 'MultiPolygon'], true, false],
        paint: {
          'line-color': color,
          'line-width': 2,
          'line-opacity': 0.95
        },
        layout: {
          'line-cap': 'round',
          'line-join': 'round'
        }
      });

      state.map.addLayer({
        id: lineLayerId,
        type: 'line',
        source: sourceId,
        filter: ['match', ['geometry-type'], ['LineString', 'MultiLineString'], true, false],
        paint: {
          'line-color': color,
          'line-width': 3,
          'line-opacity': 0.95
        },
        layout: {
          'line-cap': 'round',
          'line-join': 'round'
        }
      });

      state.map.addLayer({
        id: pointLayerId,
        type: 'circle',
        source: sourceId,
        filter: ['==', ['geometry-type'], 'Point'],
        paint: {
          'circle-radius': 4,
          'circle-color': color,
          'circle-opacity': 0.95,
          'circle-stroke-color': color,
          'circle-stroke-width': 1,
          'circle-stroke-opacity': 0.95
        }
      });

      entry.roadSourceId = sourceId;
      entry.roadLayerIds = {
        point: pointLayerId,
        line: lineLayerId,
        polygonFill: polygonFillLayerId,
        polygonStroke: polygonStrokeLayerId
      };
    }

    updateRoadLayerColor(entry);
  }

  function computeRoadLayerBounds(entry) {
    if (!entry || !entry.geojsonData || !entry.geojsonData.features) return null;
    var minLng = Infinity, minLat = Infinity, maxLng = -Infinity, maxLat = -Infinity;
    var features = entry.geojsonData.features;
    function extendCoord(c) {
      if (!Array.isArray(c) || c.length < 2) return;
      if (c[0] < minLng) minLng = c[0];
      if (c[0] > maxLng) maxLng = c[0];
      if (c[1] < minLat) minLat = c[1];
      if (c[1] > maxLat) maxLat = c[1];
    }
    function extendCoords(arr) {
      if (!Array.isArray(arr)) return;
      for (var i = 0; i < arr.length; i++) {
        if (Array.isArray(arr[i]) && Array.isArray(arr[i][0])) extendCoords(arr[i]);
        else extendCoord(arr[i]);
      }
    }
    for (var i = 0; i < features.length; i++) {
      var geom = features[i] && features[i].geometry;
      if (!geom) continue;
      if (geom.type === 'Point') extendCoord(geom.coordinates);
      else extendCoords(geom.coordinates);
    }
    if (!isFinite(minLng) || !isFinite(minLat)) return null;
    return [[minLng, minLat], [maxLng, maxLat]];
  }

  function setRoadLayerVisible(entry, visible) {
    if (!entry || entry.removed || !state.map) return;

    if (visible) {
      ensureRoadLayerOnMap(entry);
      setRoadLayerIdsVisibility(entry, true);
    } else if (entry.roadLayerIds) {
      setRoadLayerIdsVisibility(entry, false);
    }

    if (!visible || !entry.roadLayerIds) {
      return;
    }

    if (!entry.hasFittedToBounds) {
      var bounds = computeRoadLayerBounds(entry);
      if (bounds) {
        state.map.fitBounds(bounds, { padding: 24, maxZoom: 18 });
      }
      entry.hasFittedToBounds = true;
    }
  }

  function updateRoadLayersVisibilityByTags() {
    if (!Array.isArray(importedRoadEntries) || importedRoadEntries.length < 1) {
      roadLayersVisible = false;
      roadVisibilityDirty = false;
      return;
    }

    var visible = state.viewMode === 'map' && (state.stage === 3 || state.stage === 4);
    if (visible && (!state.map || !state.mapReady)) {
      roadVisibilityDirty = true;
      return;
    }

    if (!roadVisibilityDirty && roadLayersVisible === visible) {
      return;
    }

    for (var ei = 0; ei < importedRoadEntries.length; ei++) {
      var entry = importedRoadEntries[ei];
      if (!entry || entry.removed) continue;
      setRoadLayerVisible(entry, visible);
    }
    roadLayersVisible = visible;
    roadVisibilityDirty = false;
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

  function isRoadFeatureCollection(data) {
    return !!(data && data.type === 'FeatureCollection' && Array.isArray(data.features));
  }

  function parseRoadGeojsonText(text) {
    var rawText = typeof text === 'string' ? text : '';
    if (rawText.charCodeAt(0) === 0xFEFF) rawText = rawText.slice(1);

    var parsed = null;
    try {
      parsed = JSON.parse(rawText);
    } catch (err) {
      throw new Error('Invalid JSON');
    }
    if (!isRoadFeatureCollection(parsed)) {
      throw new Error('Invalid roads GeoJSON');
    }
    return parsed;
  }

  function mountVgaButtonToActionBar() {
    if (!dom.vgaModeBtnEl || !dom.stage3ActionBarEl) return;
    var footerEl = dom.stage3ActionBarEl.querySelector('.ui-setup-footer');
    if (!footerEl) return;

    var previousItemEl = dom.vgaModeBtnEl.closest('.tool-tag-controls__item');
    dom.vgaModeBtnEl.classList.remove('tool-tag-controls__import-btn');
    dom.vgaModeBtnEl.classList.add('ui-setup-action-btn');
    dom.vgaModeBtnEl.textContent = 'VGA';
    footerEl.insertBefore(dom.vgaModeBtnEl, footerEl.firstChild);

    if (previousItemEl && previousItemEl.parentNode) {
      previousItemEl.parentNode.removeChild(previousItemEl);
    }
  }

  function loadBlackoutPulseSetting() {
    try {
      return localStorage.getItem(BLACKOUT_PULSE_STORAGE_KEY) === '1';
    } catch (err) {
      return false;
    }
  }

  function saveBlackoutPulseSetting(enabled) {
    try {
      localStorage.setItem(BLACKOUT_PULSE_STORAGE_KEY, enabled ? '1' : '0');
    } catch (err) { /* ignore */ }
  }

  function ensureBlackoutOverlay() {
    if (blackoutOverlayEl && blackoutOverlayEl.isConnected) return blackoutOverlayEl;
    blackoutOverlayEl = document.createElement('div');
    blackoutOverlayEl.id = 'blackoutPulseOverlay';
    blackoutOverlayEl.className = 'blackout-pulse-overlay';
    blackoutOverlayEl.setAttribute('aria-hidden', 'true');
    document.body.appendChild(blackoutOverlayEl);
    return blackoutOverlayEl;
  }

  function setBlackoutOverlayActive(active) {
    var overlay = ensureBlackoutOverlay();
    if (!overlay) return;
    blackoutPulseActive = !!active;
    overlay.classList.toggle('blackout-pulse-overlay--active', blackoutPulseActive);
    overlay.setAttribute('aria-hidden', blackoutPulseActive ? 'false' : 'true');
  }

  function resetBlackoutPulseState() {
    blackoutPulseLastAtMs = 0;
    blackoutPulseUntilMs = 0;
    blackoutPulseNextAtMs = 0;
    setBlackoutOverlayActive(false);
  }

  function updateBlackoutPulse(shouldPulse, nowMs) {
    var now = isFinite(nowMs) ? nowMs : performance.now();
    if (!blackoutPulseEnabled || !shouldPulse) {
      resetBlackoutPulseState();
      return;
    }

    if (blackoutPulseActive && now >= blackoutPulseUntilMs) {
      setBlackoutOverlayActive(false);
    }

    // Start a 1s countdown when condition becomes true; first blackout occurs at the end of that second.
    if (blackoutPulseNextAtMs <= 0) {
      blackoutPulseNextAtMs = now + BLACKOUT_PULSE_INTERVAL_MS;
      return;
    }

    if (!blackoutPulseActive && now >= blackoutPulseNextAtMs) {
      blackoutPulseLastAtMs = now;
      blackoutPulseUntilMs = now + BLACKOUT_PULSE_DURATION_MS;
      blackoutPulseNextAtMs = now + BLACKOUT_PULSE_INTERVAL_MS;
      setBlackoutOverlayActive(true);
    }
  }

  function getBlackoutToolType(toolEl) {
    if (!toolEl || !toolEl.classList) return '';
    var uiType = toolEl.dataset && toolEl.dataset.uiType ? String(toolEl.dataset.uiType) : '';
    if (uiType === 'draw' || uiType === 'note' || uiType === 'eraser' || uiType === 'selection' || uiType === 'layer-square') {
      return uiType;
    }
    if (toolEl.classList.contains('ui-selection')) return 'selection';
    if (toolEl.classList.contains('ui-eraser')) return 'eraser';
    if (toolEl.classList.contains('ui-draw')) return 'draw';
    if (toolEl.classList.contains('ui-note')) return 'note';
    if (toolEl.classList.contains('ui-layer-square')) return 'layer-square';
    return '';
  }

  function isBlackoutLayerActionTool(toolEl, toolType) {
    if (toolType !== 'layer-square' || !toolEl || !toolEl.dataset) return false;
    var layerName = String(toolEl.dataset.layerName || '').trim().toLowerCase();
    return layerName === 'next' || layerName === 'back' || layerName === 'pan' || layerName === 'zoom';
  }

  function findActivatingToolAtPoint(pointer, triggerTagId) {
    if (!pointer || !isFinite(pointer.x) || !isFinite(pointer.y)) return null;

    var offsets = [
      { dx: 0, dy: 0 },
      { dx: 16, dy: 0 }, { dx: -16, dy: 0 },
      { dx: 0, dy: 16 }, { dx: 0, dy: -16 },
      { dx: 12, dy: 12 }, { dx: -12, dy: 12 },
      { dx: 12, dy: -12 }, { dx: -12, dy: -12 }
    ];

    for (var i = 0; i < offsets.length; i++) {
      var ox = offsets[i].dx;
      var oy = offsets[i].dy;
      var target = document.elementFromPoint(pointer.x + ox, pointer.y + oy);
      if (!target || !target.closest) continue;
      var toolEl = target.closest(APRILTAG_BLACKOUT_TOOL_SELECTOR);
      if (!toolEl) continue;
      var toolType = getBlackoutToolType(toolEl);
      if (!toolType) continue;
      return toolEl;
    }
    return null;
  }

  function shouldPulseBlackoutForApriltagState(apriltagTriggerPoints, detectionById) {
    if (!blackoutPulseEnabled) return false;
    if (state.viewMode !== 'map') return false;
    if (state.stage !== 3 && state.stage !== 4) return false;
    if (vgaModeActive) return false;

    var triggerPoints = Array.isArray(apriltagTriggerPoints) ? apriltagTriggerPoints : [];
    for (var i = 0; i < triggerPoints.length; i++) {
      var point = triggerPoints[i];
      if (!point || !isFinite(point.x) || !isFinite(point.y)) continue;
      var primaryTagId = parseInt(point.handId, 10);
      if (!isFinite(primaryTagId)) continue;
      if (detectionById && detectionById[primaryTagId] && detectionById[primaryTagId].center) continue;
      if (findActivatingToolAtPoint({ x: point.x, y: point.y }, point.triggerTagId)) {
        return true;
      }
    }
    return false;
  }

  function initBlackoutPulseToggle() {
    blackoutPulseEnabled = loadBlackoutPulseSetting();
    ensureBlackoutOverlay();

    var toggleEl = document.getElementById('blackoutPulseToggle');
    if (!toggleEl) return;
    toggleEl.checked = blackoutPulseEnabled;
    toggleEl.addEventListener('change', function() {
      blackoutPulseEnabled = !!toggleEl.checked;
      saveBlackoutPulseSetting(blackoutPulseEnabled);
      if (!blackoutPulseEnabled) {
        resetBlackoutPulseState();
      }
    });
  }

  function loadMapMonochromeStyleSetting() {
    try {
      return localStorage.getItem(MAP_MONO_STYLE_STORAGE_KEY) === '1';
    } catch (err) {
      return false;
    }
  }

  function saveMapMonochromeStyleSetting(enabled) {
    try {
      localStorage.setItem(MAP_MONO_STYLE_STORAGE_KEY, enabled ? '1' : '0');
    } catch (err) { /* ignore */ }
  }

  function applyMapBaseModeFromToggle() {
    setMapBaseMode(mapMonochromeStyleEnabled ? 'mono' : 'default');
    if (vgaModeActive || hasAnyVgaBuildingHighlights()) {
      applyVgaBuildingHighlightPaintOverrides();
    }
  }

  function initMapStyleToggle() {
    mapMonochromeStyleEnabled = loadMapMonochromeStyleSetting();
    applyMapBaseModeFromToggle();

    var toggleEl = document.getElementById('mapMonochromeToggle');
    if (!toggleEl) return;
    toggleEl.checked = mapMonochromeStyleEnabled;
    toggleEl.addEventListener('change', function() {
      mapMonochromeStyleEnabled = !!toggleEl.checked;
      saveMapMonochromeStyleSetting(mapMonochromeStyleEnabled);
      applyMapBaseModeFromToggle();
    });
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

    var colorInput = document.createElement('input');
    colorInput.className = 'tool-tag-controls__file-color';
    colorInput.type = 'color';
    colorInput.value = roadColorPalette[importedRoadEntries.length % roadColorPalette.length];
    colorInput.setAttribute('aria-label', 'Pick display color for ' + file.name);
    row.dataset.roadColor = colorInput.value;
    var roadEntry = {
      fileName: file && file.name ? String(file.name) : 'roads.geojson',
      rowEl: row,
      colorInput: colorInput,
      roadSourceId: '',
      roadLayerIds: null,
      geojsonData: null,
      hasFittedToBounds: false,
      removed: false
    };
    importedRoadEntries.push(roadEntry);
    markRoadVisibilityDirty();

    colorInput.addEventListener('input', function() {
      row.dataset.roadColor = colorInput.value;
      updateRoadLayerColor(roadEntry);
    });

    var removeBtn = document.createElement('button');
    removeBtn.className = 'tool-tag-controls__file-remove';
    removeBtn.type = 'button';
    removeBtn.textContent = '×';
    removeBtn.setAttribute('aria-label', 'Remove ' + file.name);
    removeBtn.addEventListener('click', function() {
      rowRemoved = true;
      roadEntry.removed = true;
      removeRoadLayer(roadEntry);
      var roadIdx = importedRoadEntries.indexOf(roadEntry);
      if (roadIdx !== -1) importedRoadEntries.splice(roadIdx, 1);
      markRoadVisibilityDirty();
      row.parentNode.removeChild(row);
    });

    row.appendChild(nameSpan);
    row.appendChild(colorInput);
    row.appendChild(removeBtn);
    dom.geojsonFilesListEl.appendChild(row);

    readGeojsonFileText(file).then(function(text) {
      if (rowRemoved || roadEntry.removed) return;
      roadEntry.geojsonData = parseRoadGeojsonText(text);
      markRoadVisibilityDirty();
      updateRoadLayersVisibilityByTags();
      setError('');
    }).catch(function(err) {
      console.warn('Failed to load roads GeoJSON:', file.name, err);
      setError('Failed to load roads GeoJSON: ' + file.name);
    });

    return roadEntry;
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
  function getNextAvailableMapSessionId() {
    var used = {};
    for (var i = 0; i < mapSessions.length; i++) {
      var id = parseInt(mapSessions[i] && mapSessions[i].id, 10);
      if (!isFinite(id) || id < 1) continue;
      used[id] = true;
    }
    var candidate = 1;
    while (used[candidate]) candidate++;
    return candidate;
  }
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
  var vgaHoverClientPoint = null;
  var vgaBuildingLayerIds = [];
  var vgaHighlightedBuildingStateByKey = {};
  var VGA_BUILDING_HIGHLIGHT_STATE_KEY = 'manualBuildingHighlight';
  var VGA_BUILDING_HIGHLIGHT_COLOR = '#ff2d2d';
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
  var PAN_JITTER_PIXELS = 2.5;
  var PAN_MIN_UPDATE_INTERVAL_MS = 45;
  var PAN_MISSING_HOLD_MS = 850;
  var panTagRuntime = {
    configuredTagId: null,
    anchorMapLatLng: null,
    lastTagPoint: null,
    lastApplyAtMs: 0,
    missingSinceMs: 0
  };
  var ZOOM_PAIR_MIN_DISTANCE_METERS = 0.15;
  var ZOOM_PAIR_DEADBAND_RATIO = 0.07;
  var ZOOM_BASELINE_RANGE_UNITS = 1;
  var ZOOM_CONTROL_RANGE_PX = 90;
  var ZOOM_MIN_UPDATE_INTERVAL_MS = 160;
  var ZOOM_MISSING_HOLD_MS = 900;
  var ZOOM_TAG_MAX_EXTRAPOLATION = 1.5;
  var zoomTagRuntime = {
    baselineZoom: 0,
    baselineZoomReady: false,
    handBaselineById: {},
    guideByHandId: {},
    lastApplyAtMs: 0,
    missingSinceMs: 0
  };
  var zoomGuidesOverlayEl = null;

  // ---- Pinch-zoom via dedicated AprilTag pair (IDs 5 & 6) ----
  var PINCH_ZOOM_TAG_A = 5;
  var PINCH_ZOOM_TAG_B = 6;
  var PINCH_ZOOM_RANGE = 2.0;           // max zoom levels away from baseline (±2)
  var PINCH_ZOOM_DEADBAND = 0.04;       // ignore distance ratio changes smaller than this
  var PINCH_ZOOM_MIN_UPDATE_MS = 100;    // throttle zoom updates
  var PINCH_ZOOM_MISSING_HOLD_MS = 800;  // how long to hold zoom after tags disappear
  var pinchZoomRuntime = {
    baselineDistance: 0,   // pixel distance when both tags first seen
    baselineZoom: 0,       // map zoom level at baseline
    ready: false,          // true once baseline is captured
    lastApplyMs: 0,
    missingSinceMs: 0
  };

  function resetPinchZoomRuntime() {
    pinchZoomRuntime.ready = false;
    pinchZoomRuntime.baselineDistance = 0;
    pinchZoomRuntime.baselineZoom = 0;
    pinchZoomRuntime.lastApplyMs = 0;
    pinchZoomRuntime.missingSinceMs = 0;
  }

  /**
   * Process zoom using a dedicated pair of AprilTags (IDs 5 & 6).
   * Closer together → zoom in, farther apart → zoom out.
   * The distance change is mapped linearly to ±PINCH_ZOOM_RANGE zoom levels
   * from the baseline zoom captured on first simultaneous detection.
   * When tags reach their closest physical distance → +RANGE zoom in,
   * same distance apart → -RANGE zoom out.
   */
  function processPinchZoomTags(detectionById) {
    if (state.viewMode !== 'map' || (state.stage !== 3 && state.stage !== 4) || !state.map) {
      resetPinchZoomRuntime();
      return;
    }

    var detA = detectionById[PINCH_ZOOM_TAG_A];
    var detB = detectionById[PINCH_ZOOM_TAG_B];
    var hasA = detA && detA.center;
    var hasB = detB && detB.center;

    if (!hasA || !hasB) {
      // One or both tags missing
      var nowMs = performance.now();
      if (pinchZoomRuntime.ready) {
        if (!pinchZoomRuntime.missingSinceMs) pinchZoomRuntime.missingSinceMs = nowMs;
        if ((nowMs - pinchZoomRuntime.missingSinceMs) > PINCH_ZOOM_MISSING_HOLD_MS) {
          resetPinchZoomRuntime();
        }
      }
      return;
    }

    // Both tags visible — compute pixel distance between centers
    var dx = detA.center.x - detB.center.x;
    var dy = detA.center.y - detB.center.y;
    var currentDist = Math.sqrt(dx * dx + dy * dy);
    if (currentDist < 1) return; // tags overlapping, ignore

    var nowMs2 = performance.now();
    pinchZoomRuntime.missingSinceMs = 0;

    // Capture baseline on first simultaneous detection
    if (!pinchZoomRuntime.ready) {
      pinchZoomRuntime.baselineDistance = currentDist;
      var z = state.map.getZoom();
      pinchZoomRuntime.baselineZoom = isFinite(z) ? z : 0;
      pinchZoomRuntime.ready = true;
      pinchZoomRuntime.lastApplyMs = nowMs2;
      return;
    }

    // Throttle updates
    if ((nowMs2 - pinchZoomRuntime.lastApplyMs) < PINCH_ZOOM_MIN_UPDATE_MS) return;

    // Compute distance ratio relative to baseline.
    // ratio < 1 means tags are closer → zoom IN (positive delta)
    // ratio > 1 means tags are farther → zoom OUT (negative delta)
    var ratio = currentDist / pinchZoomRuntime.baselineDistance;
    var delta = 1 - ratio; // inverted: closer = positive, farther = negative
    if (Math.abs(delta) < PINCH_ZOOM_DEADBAND) return;

    // Clamp delta to ±1 so zoom change is within ±PINCH_ZOOM_RANGE
    delta = clamp(delta, -1, 1);

    var targetZoom = pinchZoomRuntime.baselineZoom + delta * PINCH_ZOOM_RANGE;

    // Clamp to map min/max zoom
    var minZoom = typeof state.map.getMinZoom === 'function' ? state.map.getMinZoom() : -Infinity;
    var maxZoom = typeof state.map.getMaxZoom === 'function' ? state.map.getMaxZoom() : Infinity;
    if (!isFinite(minZoom)) minZoom = -Infinity;
    if (!isFinite(maxZoom)) maxZoom = Infinity;
    targetZoom = clamp(targetZoom, minZoom, maxZoom);

    var currentZoom = state.map.getZoom();
    if (Math.abs(targetZoom - currentZoom) < 0.01) return;

    try {
      state.map.jumpTo({ zoom: targetZoom });
      pinchZoomRuntime.lastApplyMs = nowMs2;
    } catch (err) {
      // Ignore transient zoom errors.
    }
  }

  // ---- Dedicated pan tag (ID 7) ----
  var PAN_TAG_ID = 7;
  var PAN_TAG_JITTER_PX = 2.5;
  var PAN_TAG_MIN_UPDATE_MS = 45;
  var PAN_TAG_MISSING_HOLD_MS = 850;
  var panTagDedicatedRuntime = {
    lastPoint: null,   // { x, y } in map-local coords
    lastApplyMs: 0,
    missingSinceMs: 0
  };

  function resetPanTagDedicatedRuntime() {
    panTagDedicatedRuntime.lastPoint = null;
    panTagDedicatedRuntime.lastApplyMs = 0;
    panTagDedicatedRuntime.missingSinceMs = 0;
  }

  /**
   * Process pan using a dedicated AprilTag.
   * When the tag is visible on the projected surface, its movement
   * is translated into map panning (same behaviour as the existing pan tool).
   */
  function processPanTag(detectionById) {
    if (state.viewMode !== 'map' || (state.stage !== 3 && state.stage !== 4) || !state.map) {
      resetPanTagDedicatedRuntime();
      return;
    }

    var det = detectionById[PAN_TAG_ID];
    if (!det || !det.center) {
      var nowMs = performance.now();
      if (panTagDedicatedRuntime.lastPoint) {
        if (!panTagDedicatedRuntime.missingSinceMs) panTagDedicatedRuntime.missingSinceMs = nowMs;
        if ((nowMs - panTagDedicatedRuntime.missingSinceMs) > PAN_TAG_MISSING_HOLD_MS) {
          resetPanTagDedicatedRuntime();
        }
      }
      return;
    }

    // Project tag center to map-local coordinates
    if (!state.surfaceHomography) return;
    var mapRect = dom.mapWarpEl.getBoundingClientRect();
    var mapW = dom.mapViewEl.offsetWidth;
    var mapH = dom.mapViewEl.offsetHeight;
    if (!mapW || !mapH) return;

    var uv = applyHomography(state.surfaceHomography, det.center.x, det.center.y);
    if (!uv) return;
    // Allow slight extrapolation so tags near edges still work
    if (uv.x < -0.2 || uv.x > 1.2 || uv.y < -0.2 || uv.y > 1.2) return;

    var localX = uv.x * mapW;
    var localY = uv.y * mapH;
    var nowMs2 = performance.now();
    panTagDedicatedRuntime.missingSinceMs = 0;

    if (!panTagDedicatedRuntime.lastPoint) {
      panTagDedicatedRuntime.lastPoint = { x: localX, y: localY };
      panTagDedicatedRuntime.lastApplyMs = nowMs2;
      return;
    }

    var dx = localX - panTagDedicatedRuntime.lastPoint.x;
    var dy = localY - panTagDedicatedRuntime.lastPoint.y;
    var dist = Math.sqrt(dx * dx + dy * dy);
    if (dist < PAN_TAG_JITTER_PX) return;
    if ((nowMs2 - panTagDedicatedRuntime.lastApplyMs) < PAN_TAG_MIN_UPDATE_MS) return;

    try {
      state.map.panBy([-dx, -dy], { animate: false });
    } catch (err) {
      // Ignore transient pan errors.
    }
    panTagDedicatedRuntime.lastPoint = { x: localX, y: localY };
    panTagDedicatedRuntime.lastApplyMs = nowMs2;
  }

  // ---- Dedicated next/back navigation tags (IDs 8 & 9) ----
  // Triggered by entering the surface (homography UV in [0,1]).
  // To trigger again the tag must leave the surface first, then re-enter.
  // Simply losing detection (disappearing) does NOT count as leaving —
  // the tag must be explicitly seen outside the surface boundary.
  var NAV_NEXT_TAG_ID = 8;
  var NAV_BACK_TAG_ID = 9;
  var navTagState = {
    // Each tag tracks: 'outside' | 'inside' | 'unknown'
    // Transition: unknown→outside (seen outside) → inside (entered) = trigger
    // After trigger, stays 'inside' until seen outside again.
    nextTagPhase: 'unknown',  // 'unknown' | 'outside' | 'inside'
    backTagPhase: 'unknown'
  };

  function resetNavTagState() {
    navTagState.nextTagPhase = 'unknown';
    navTagState.backTagPhase = 'unknown';
  }

  /**
   * Check if a detection's center is within the calibrated surface.
   * Returns: 'inside' if UV is in [0,1], 'outside' if detected but outside, null if not detected.
   */
  function getTagSurfaceStatus(det) {
    if (!det || !det.center || !state.surfaceHomography) return null;
    var uv = applyHomography(state.surfaceHomography, det.center.x, det.center.y);
    if (!uv) return null;
    if (uv.x >= 0 && uv.x <= 1 && uv.y >= 0 && uv.y <= 1) return 'inside';
    return 'outside';
  }

  /**
   * Process navigation tags. A tag entering the surface triggers next/back.
   * To trigger again, the tag must be seen outside the surface first.
   * Losing detection (tag not visible at all) does NOT reset the state.
   */
  function processNavTags(detectionById) {
    if (state.viewMode !== 'map' || (state.stage !== 3 && state.stage !== 4)) {
      resetNavTagState();
      return;
    }

    // --- Next tag (ID 8) ---
    var nextStatus = getTagSurfaceStatus(detectionById[NAV_NEXT_TAG_ID]);
    if (nextStatus === 'outside') {
      // Tag is seen outside surface → arm for next trigger
      navTagState.nextTagPhase = 'outside';
    } else if (nextStatus === 'inside') {
      if (navTagState.nextTagPhase === 'outside') {
        // Transition from outside → inside = trigger next
        goToNextMapSession();
      }
      navTagState.nextTagPhase = 'inside';
    }
    // If nextStatus === null (not detected), keep current phase — don't reset

    // --- Back tag (ID 9) ---
    var backStatus = getTagSurfaceStatus(detectionById[NAV_BACK_TAG_ID]);
    if (backStatus === 'outside') {
      navTagState.backTagPhase = 'outside';
    } else if (backStatus === 'inside') {
      if (navTagState.backTagPhase === 'outside') {
        goToPrevMapSession();
      }
      navTagState.backTagPhase = 'inside';
    }
  }

  dom.mapSessionAddBtnEl.addEventListener('click', function(e) {
    e.preventDefault();
    e.stopPropagation();
    if (!state.map) return;

    var center = state.map.getCenter();
    var zoom = state.map.getZoom();
    var nextSessionId = getNextAvailableMapSessionId();
    mapSessionCounter = Math.max(mapSessionCounter, nextSessionId);

    var session = {
      id: nextSessionId,
      name: 'View ' + nextSessionId,
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
          if (state.currentMapSessionId !== null && String(state.currentMapSessionId) === String(sessionId)) {
            clearActiveMapSessionSelection();
            return;
          }
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
    updateMapSessionListHighlight();
  }

  function clearActiveMapSessionSelection() {
    state.currentMapSessionId = null;
    currentMapSessionIndex = -1;
    resetPanTagRuntime();
    resetZoomTagRuntime();
    filterElementsBySession(null);
    updateMapSessionListHighlight();
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
    var removedIndex = -1;
    for (var i = 0; i < mapSessions.length; i++) {
      if (mapSessions[i].id === sessionId) {
        removedIndex = i;
        mapSessions.splice(i, 1);
        break;
      }
    }
    if (removedIndex === -1) return;

    if (currentMapSessionIndex === removedIndex || (state.currentMapSessionId !== null && String(state.currentMapSessionId) === String(sessionId))) {
      currentMapSessionIndex = -1;
      state.currentMapSessionId = null;
    } else if (currentMapSessionIndex > removedIndex) {
      currentMapSessionIndex -= 1;
    }

    if (currentMapSessionIndex >= mapSessions.length) {
      currentMapSessionIndex = mapSessions.length - 1;
    }

    if (currentMapSessionIndex >= 0 && mapSessions[currentMapSessionIndex]) {
      state.currentMapSessionId = mapSessions[currentMapSessionIndex].id;
    } else {
      state.currentMapSessionId = null;
    }

    renderMapSessionList();
    filterElementsBySession(state.currentMapSessionId || null);
  }

  function goToNextMapSession() {
    if (mapSessions.length === 0) return;
    if (currentMapSessionIndex < 0) {
      activateMapSession(0);
      return;
    }
    if (currentMapSessionIndex >= mapSessions.length - 1) {
      if (state.stage === 4) finishWorkshopSession();
      return;
    }
    currentMapSessionIndex++;
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
      var els = dom.uiSetupOverlayEl.querySelectorAll('.ui-label, .ui-draw, .ui-note, .ui-eraser, .ui-selection, .ui-layer-square');
      for (var i = 0; i < els.length; i++) {
        var el = els[i];
        if (!el || !el.dataset) continue;
        if (el.classList.contains('ui-sticker-instance') && !el.classList.contains('ui-layer-square')) continue;

        var type = el.dataset.uiType || '';
        var left = parseFloat(el.style.left || '0');
        var top = parseFloat(el.style.top || '0');
        var rotationDeg = parseFloat(el.dataset.rotationDeg || '0');
        var layerName = '';
        if (type === 'layer-square') {
          layerName = String(el.dataset.layerName || '').trim();
          if (!layerName && el.querySelector) {
            var textEl = el.querySelector('.ui-layer-square__text');
            if (textEl) layerName = String(textEl.textContent || '').trim();
          }
        }
        var item = {
          type: type || 'unknown',
          x: isFinite(left) ? left : 0,
          y: isFinite(top) ? top : 0,
          rotationDeg: isFinite(rotationDeg) ? rotationDeg : 0,
          color: el.dataset.color || null,
          triggerTagId: el.dataset.triggerTagId || '',
          layerName: layerName,
          text: type === 'label' ? (el.textContent || '') : '',
          noteText: type === 'note' ? (el.dataset.noteText || '') : ''
        };
        setupItems.push(item);
      }
    }

    setupItems.sort(function(a, b) {
      var ak = [a.type, a.layerName, a.text, a.noteText, a.color, a.triggerTagId, a.x, a.y, a.rotationDeg].join('|');
      var bk = [b.type, b.layerName, b.text, b.noteText, b.color, b.triggerTagId, b.x, b.y, b.rotationDeg].join('|');
      if (ak < bk) return -1;
      if (ak > bk) return 1;
      return 0;
    });

    return {
      participantCount: state.stage3ParticipantCount || 0,
      participantPrimaryTagIds: Array.isArray(state.stage3ParticipantTagIds) ? state.stage3ParticipantTagIds.slice() : [],
      participantTriggerTagIds: Array.isArray(state.stage3ParticipantTriggerTagIds) ? state.stage3ParticipantTriggerTagIds.slice() : [],
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
    if (!state.map) return null;
    if (!resultsLayerGroup) {
      resultsLayerGroup = createLayerGroup();
    }
    return resultsLayerGroup;
  }

  function clearResultsLayerGroup() {
    if (!resultsLayerGroup) return;
    clearGroup(state.map, resultsLayerGroup);
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

  function escapeHtmlForPopup(text) {
    return String(text || '')
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;')
      .replace(/'/g, '&#39;');
  }

  function normalizeResultsMapViewId(raw) {
    if (raw === null || raw === undefined) return null;
    var text = String(raw).trim();
    return text ? text : null;
  }

  function filterResultsFeaturesForMapView(features, mapViewId) {
    var wanted = normalizeResultsMapViewId(mapViewId);
    var src = Array.isArray(features) ? features : [];
    var out = [];
    for (var i = 0; i < src.length; i++) {
      var feature = src[i];
      if (!feature || typeof feature !== 'object') continue;
      var props = feature.properties && typeof feature.properties === 'object' ? feature.properties : null;
      var featureMapViewId = normalizeResultsMapViewId(props ? props.mapViewId : null);
      if (featureMapViewId !== wanted) continue;
      out.push(feature);
    }
    return out;
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
    var mapViewId = normalizeResultsMapViewId(currentMapView.mapViewId);
    var rawFeatures = Array.isArray(currentMapView.features) ? currentMapView.features : [];
    var features = filterResultsFeaturesForMapView(rawFeatures, mapViewId);
    var mapViewName = currentMapView.mapViewName ? String(currentMapView.mapViewName) : ('View ' + String(resultsMapViewIndex + 1));
    var sessionCount = isFinite(currentMapView.sessionCount) ? Number(currentMapView.sessionCount) : 0;

    dom.resultsViewMetaEl.textContent =
      'Map view ' + String(resultsMapViewIndex + 1) + '/' + String(totalViews) +
      ': ' + mapViewName +
      ' | features: ' + String(features.length) +
      ' | sessions: ' + String(sessionCount);

    var group = ensureResultsLayerGroup();
    if (!group || !state.map || features.length < 1) return;

    var minLng = Infinity, minLat = Infinity, maxLng = -Infinity, maxLat = -Infinity;

    function extendBounds(coords) {
      for (var ci = 0; ci < coords.length; ci++) {
        var c = coords[ci];
        if (c[0] < minLng) minLng = c[0];
        if (c[0] > maxLng) maxLng = c[0];
        if (c[1] < minLat) minLat = c[1];
        if (c[1] > maxLat) maxLat = c[1];
      }
    }

    for (var fi = 0; fi < features.length; fi++) {
      var feature = features[fi];
      if (!feature || !feature.geometry) continue;
      var geomType = feature.geometry.type;
      var coords = feature.geometry.coordinates;
      var color = getResultsFeatureColor(feature);
      var ref = null;

      if (geomType === 'Point') {
        ref = addCircleMarker(state.map, coords, {
          radius: 7, color: '#111111', weight: 1, fillColor: color, fillOpacity: 0.95
        });
        extendBounds([coords]);
      } else if (geomType === 'LineString') {
        var sourceType = feature.properties ? feature.properties.sourceType : '';
        ref = addPolyline(state.map, coords, {
          color: color, weight: sourceType === 'drawing' ? 6 : 3, opacity: 0.95
        });
        extendBounds(coords);
      } else if (geomType === 'Polygon') {
        ref = addPolygon(state.map, coords, {
          color: color, weight: 3, opacity: 0.95
        });
        if (coords[0]) extendBounds(coords[0]);
      }

      if (ref) {
        // For annotation features, add a popup
        var props = feature.properties && typeof feature.properties === 'object' ? feature.properties : null;
        if (props && props.sourceType === 'annotation') {
          var noteText = String(props.noteText || '').trim();
          if (noteText && geomType === 'Point') {
            var popup = new window.maplibregl.Popup({ closeButton: true, maxWidth: '320px' })
              .setLngLat(coords)
              .setHTML('<div class="results-note-popup">' + escapeHtmlForPopup(noteText).replace(/\n/g, '<br>') + '</div>');
            ref._popup = popup;
            // Bind click to open popup
            state.map.on('click', ref.layerId, function(popupRef) {
              return function(ev) {
                if (popupRef._popup) popupRef._popup.addTo(state.map);
              };
            }(ref));
          }
        }
        addToGroup(group, ref);
      }
    }

    if (isFinite(minLng) && isFinite(minLat)) {
      state.map.fitBounds([[minLng, minLat], [maxLng, maxLat]], { padding: 36, maxZoom: 18 });
    }
  }

  function enterResultsMode(workshopId, payload) {
    initMaptasticIfNeeded();
    initLeafletIfNeeded();
    if (!state.map) {
      setError('Map is not available.');
      return;
    }

    resultsModeActive = true;
    resultsWorkshopId = String(workshopId || '').trim();
    resultsMapViews = Array.isArray(payload && payload.mapViews) ? payload.mapViews.slice() : [];
    resultsMapViewIndex = 0;

    setViewMode('map');
    // Hide live workshop drawings while browsing historical results.
    filterPolylinesBySession('__results_mode_hidden__');
    setResultsViewerVisible(true);
    dom.pageTitleEl.textContent = 'Workshop Results';
    document.title = 'Workshop Results';
    updateShowResultsButton();

    setTimeout(function() {
      if (state.map) state.map.resize();
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
    // Restore normal live drawing visibility after leaving results mode.
    filterPolylinesBySession(state.currentMapSessionId || null);

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

      // Export annotation and drawing sticker instances.
      if (dom.uiSetupOverlayEl) {
        var stickerEls = dom.uiSetupOverlayEl.querySelectorAll('.ui-sticker-instance.ui-note, .ui-sticker-instance.ui-draw');
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
              triggerTagId: el.dataset.triggerTagId || null,
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

      // Export drawings from draw group
      if (state.drawGroup && state.map) {
        var drawLayers = state.drawGroup.layers;
        for (var di = 0; di < drawLayers.length; di++) {
          var drawRef = drawLayers[di];
          if (!drawRef || !drawRef.sourceId) continue;

          var strokeId = drawRef.strokeId ? String(drawRef.strokeId) : '';
          if (strokeId) {
            if (exportedStrokeIds[strokeId]) continue;
            exportedStrokeIds[strokeId] = true;
          } else {
            // Skip glow layers (they have large weight)
            var refWeight = drawRef._weight;
            if (isFinite(refWeight) && refWeight > 10) continue;
          }

          try {
            var src = state.map.getSource(drawRef.sourceId);
            if (!src || !src._data) continue;
            var geom = src._data.geometry || (src._data.type === 'Feature' ? src._data.geometry : null);
            if (!geom || geom.type !== 'LineString') continue;
            var drawCoords = geom.coordinates;
            if (!drawCoords || drawCoords.length < 2) continue;

            var drawingViewInfo = getMapViewInfo(drawRef.sessionId || null);
            var drawColor = null;
            try {
              drawColor = state.map.getPaintProperty(drawRef.layerId, 'line-color');
            } catch (e) { /* ignore */ }
            var drawWeight = null;
            try {
              drawWeight = state.map.getPaintProperty(drawRef.layerId, 'line-width');
            } catch (e) { /* ignore */ }

            // Coords are [lng, lat] in MapLibre
            features.push({
              type: 'Feature',
              geometry: { type: 'LineString', coordinates: drawCoords },
              properties: {
                sourceType: 'drawing',
                color: drawColor || null,
                strokeWidth: isFinite(drawWeight) ? Number(drawWeight) : null,
                sessionId: drawRef.sessionId || null,
                mapViewId: drawingViewInfo.mapViewId,
                mapViewName: drawingViewInfo.mapViewName
              }
            });
          } catch (e) { /* ignore */ }
        }
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
    if (currentMapSessionIndex < 0) {
      activateMapSession(0);
      return;
    }
    if (currentMapSessionIndex <= 0) {
      currentMapSessionIndex = 0;
      return;
    }
    currentMapSessionIndex--;
    activateMapSession(currentMapSessionIndex);
  }

  function processLayerNavigationVotes(voteState) {
    if (state.viewMode !== 'map' || (state.stage !== 3 && state.stage !== 4) || vgaModeActive) {
      layerNavVoteLatch.next = false;
      layerNavVoteLatch.back = false;
      return;
    }

    var nextActive = !!(voteState && Array.isArray(voteState.nextHandIds) && voteState.nextHandIds.length > 0);
    var backActive = !!(voteState && Array.isArray(voteState.backHandIds) && voteState.backHandIds.length > 0);

    if (!nextActive) layerNavVoteLatch.next = false;
    if (!backActive) layerNavVoteLatch.back = false;

    if (nextActive && backActive) return;

    if (nextActive && !layerNavVoteLatch.next) {
      layerNavVoteLatch.next = true;
      goToNextMapSession();
      return;
    }
    if (backActive && !layerNavVoteLatch.back) {
      layerNavVoteLatch.back = true;
      goToPrevMapSession();
    }
  }

  function processLayerPanVotes(voteState, primaryPoints) {
    if (state.viewMode !== 'map' || (state.stage !== 3 && state.stage !== 4) || vgaModeActive || !state.map) {
      resetPanTagRuntime();
      return;
    }

    var activePanHandIds = voteState && Array.isArray(voteState.panHandIds) ? voteState.panHandIds : [];
    if (activePanHandIds.length < 1) {
      resetPanTagRuntime();
      return;
    }

    var activeByHandId = {};
    for (var hi = 0; hi < activePanHandIds.length; hi++) {
      var hid = String(activePanHandIds[hi] || '');
      if (!hid) continue;
      activeByHandId[hid] = true;
    }

    var mapRect = dom.mapWarpEl.getBoundingClientRect();
    var points = Array.isArray(primaryPoints) ? primaryPoints : [];
    var sumX = 0;
    var sumY = 0;
    var pointCount = 0;

    for (var pi = 0; pi < points.length; pi++) {
      var pt = points[pi];
      if (!pt || !activeByHandId[String(pt.handId || '')]) continue;
      if (!isFinite(pt.x) || !isFinite(pt.y)) continue;
      var cx = pt.x - mapRect.left;
      var cy = pt.y - mapRect.top;
      if (!isFinite(cx) || !isFinite(cy)) continue;
      sumX += cx;
      sumY += cy;
      pointCount++;
    }

    var nowMs = performance.now();
    if (pointCount < 1) {
      if (!panTagRuntime.missingSinceMs) panTagRuntime.missingSinceMs = nowMs;
      if ((nowMs - panTagRuntime.missingSinceMs) > PAN_MISSING_HOLD_MS) resetPanTagRuntime();
      return;
    }

    panTagRuntime.missingSinceMs = 0;
    var centerPoint = { x: sumX / pointCount, y: sumY / pointCount };

    if (!panTagRuntime.lastTagPoint) {
      panTagRuntime.lastTagPoint = centerPoint;
      panTagRuntime.lastApplyAtMs = nowMs;
      return;
    }

    var dx = centerPoint.x - panTagRuntime.lastTagPoint.x;
    var dy = centerPoint.y - panTagRuntime.lastTagPoint.y;
    var distance = Math.sqrt(dx * dx + dy * dy);
    if (distance < PAN_JITTER_PIXELS) return;
    if ((nowMs - panTagRuntime.lastApplyAtMs) < PAN_MIN_UPDATE_INTERVAL_MS) return;

    try {
      state.map.panBy([-dx, -dy], { animate: false });
    } catch (err) {
      // Ignore transient pan errors.
    }
    panTagRuntime.lastTagPoint = centerPoint;
    panTagRuntime.lastApplyAtMs = nowMs;
  }

  function processLayerZoomVotes(voteState, primaryPoints) {
    if (state.viewMode !== 'map' || (state.stage !== 3 && state.stage !== 4) || vgaModeActive || !state.map) {
      resetZoomTagRuntime();
      return;
    }

    var activeZoomHandIds = voteState && Array.isArray(voteState.zoomHandIds) ? voteState.zoomHandIds : [];
    if (activeZoomHandIds.length < 1) {
      resetZoomTagRuntime();
      return;
    }

    if (!zoomTagRuntime.baselineZoomReady) {
      var initialZoom = state.map.getZoom();
      if (!isFinite(initialZoom)) initialZoom = 0;
      zoomTagRuntime.baselineZoom = initialZoom;
      zoomTagRuntime.baselineZoomReady = true;
      zoomTagRuntime.lastApplyAtMs = 0;
    }

    var activeByHandId = {};
    for (var ai = 0; ai < activeZoomHandIds.length; ai++) {
      var activeHandId = String(activeZoomHandIds[ai] || '');
      if (!activeHandId) continue;
      activeByHandId[activeHandId] = true;
    }

    var baselineByHandId = zoomTagRuntime.handBaselineById || {};
    for (var knownHandId in baselineByHandId) {
      if (activeByHandId[knownHandId]) continue;
      delete baselineByHandId[knownHandId];
    }

    var mapRect = dom.mapWarpEl.getBoundingClientRect();
    var points = Array.isArray(primaryPoints) ? primaryPoints : [];
    var guideStates = [];
    var targetZoomSum = 0;
    var targetZoomCount = 0;
    var nowMs = performance.now();

    for (var pi = 0; pi < points.length; pi++) {
      var pt = points[pi];
      if (!pt || !activeByHandId[String(pt.handId || '')]) continue;
      if (!isFinite(pt.x) || !isFinite(pt.y)) continue;
      var localX = pt.x - mapRect.left;
      var localY = pt.y - mapRect.top;
      if (!isFinite(localX) || !isFinite(localY)) continue;

      var handId = String(pt.handId || '');
      if (!isFinite(baselineByHandId[handId])) baselineByHandId[handId] = localY;
      var baselineY = baselineByHandId[handId];

      var ratio = (baselineY - localY) / Math.max(1, ZOOM_CONTROL_RANGE_PX);
      if (Math.abs(ratio) < ZOOM_PAIR_DEADBAND_RATIO) ratio = 0;
      ratio = clamp(ratio, -1, 1);

      var targetZoom = zoomTagRuntime.baselineZoom + ratio * ZOOM_BASELINE_RANGE_UNITS;
      targetZoomSum += targetZoom;
      targetZoomCount++;

      guideStates.push({
        handId: handId,
        x: localX,
        baseY: baselineY
      });
    }

    zoomTagRuntime.handBaselineById = baselineByHandId;
    syncZoomGuides(guideStates);

    if (targetZoomCount < 1) {
      if (!zoomTagRuntime.missingSinceMs) zoomTagRuntime.missingSinceMs = nowMs;
      if ((nowMs - zoomTagRuntime.missingSinceMs) > ZOOM_MISSING_HOLD_MS) {
        zoomTagRuntime.handBaselineById = {};
      }
      return;
    }
    zoomTagRuntime.missingSinceMs = 0;

    if ((nowMs - zoomTagRuntime.lastApplyAtMs) < ZOOM_MIN_UPDATE_INTERVAL_MS) return;

    var targetZoomAvg = targetZoomSum / targetZoomCount;
    var minZoom = typeof state.map.getMinZoom === 'function' ? state.map.getMinZoom() : -Infinity;
    var maxZoom = typeof state.map.getMaxZoom === 'function' ? state.map.getMaxZoom() : Infinity;
    if (!isFinite(minZoom)) minZoom = -Infinity;
    if (!isFinite(maxZoom)) maxZoom = Infinity;
    targetZoomAvg = clamp(targetZoomAvg, minZoom, maxZoom);

    var currentZoom = state.map.getZoom();
    if (Math.abs(targetZoomAvg - currentZoom) < 0.01) return;

    try {
      state.map.jumpTo({ zoom: targetZoomAvg });
      zoomTagRuntime.lastApplyAtMs = nowMs;
    } catch (err) {
      // Ignore transient zoom errors.
    }
  }

  function activateMapSession(index) {
    if (index < 0 || index >= mapSessions.length) {
      clearActiveMapSessionSelection();
      return;
    }
    var session = mapSessions[index];
    if (!session) return;

    // Save current zoom to the outgoing session so it persists per-view
    if (currentMapSessionIndex >= 0 && currentMapSessionIndex < mapSessions.length && state.map) {
      var outgoing = mapSessions[currentMapSessionIndex];
      if (outgoing) {
        var curZoom = state.map.getZoom();
        if (isFinite(curZoom)) outgoing.zoom = curZoom;
      }
    }

    state.currentMapSessionId = session.id;
    currentMapSessionIndex = index;
    resetPanTagRuntime();
    resetZoomTagRuntime();
    // Re-baseline dedicated zoom tags so they adapt to the new view's zoom
    // (next frame will capture current tag distance + new view zoom as baseline)
    resetPinchZoomRuntime();

    if (state.map) {
      state.map.jumpTo({ center: [session.lng, session.lat], zoom: session.zoom });
    }

    filterElementsBySession(session.id);
    updateMapSessionListHighlight();
  }

  function filterElementsBySession(sessionId) {
    if (!dom.uiSetupOverlayEl) return;

    // Filter setup elements and sticker instances.
    var elements = dom.uiSetupOverlayEl.querySelectorAll('.ui-label, .ui-draw, .ui-note, .ui-eraser, .ui-selection, .ui-layer-square');
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

    // Filter polyline drawings by session
    filterPolylinesBySession(sessionId);
  }

  function updateMapSessionListHighlight() {
    var items = dom.mapSessionListEl.querySelectorAll('.map-session-item');
    var activeSessionId = state.currentMapSessionId !== null && state.currentMapSessionId !== undefined
      ? String(state.currentMapSessionId)
      : '';
    for (var i = 0; i < items.length; i++) {
      var item = items[i];
      var itemId = String(item.dataset.sessionId || '');
      var isActive = !!activeSessionId && itemId === activeSessionId;
      item.classList.toggle('map-session-item--active', isActive);
    }
  }

  function buildMapSetupExportData() {
    var roads = [];
    for (var i = 0; i < importedRoadEntries.length; i++) {
      var entry = importedRoadEntries[i];
      if (!entry || entry.removed || !isRoadFeatureCollection(entry.geojsonData)) continue;
      roads.push({
        fileName: entry.fileName || 'roads.geojson',
        color: entry.colorInput && entry.colorInput.value ? entry.colorInput.value : '#2bb8ff',
        geojsonData: entry.geojsonData,
        hasFittedToBounds: !!entry.hasFittedToBounds
      });
    }

    var mapViewEntries = [];
    for (var si = 0; si < mapSessions.length; si++) {
      var session = mapSessions[si];
      if (!session || !isFinite(session.id)) continue;
      mapViewEntries.push({
        id: session.id,
        name: session.name || ('View ' + String(session.id)),
        lat: isFinite(session.lat) ? Number(session.lat) : 0,
        lng: isFinite(session.lng) ? Number(session.lng) : 0,
        zoom: isFinite(session.zoom) ? Number(session.zoom) : 17
      });
    }

    return {
      version: 1,
      trackingOffset: {
        x: state.apriltagTrackingOffsetX,
        y: state.apriltagTrackingOffsetY,
        triggerX: state.apriltagTriggerTrackingOffsetX,
        triggerY: state.apriltagTriggerTrackingOffsetY,
        compressionPct: state.apriltagOffsetBottomCompressionPct,
        primaryOffsetGrid: hasCompletePrimaryOffsetGrid(state.apriltagPrimaryOffsetGrid)
          ? state.apriltagPrimaryOffsetGrid
          : null
      },
      mapViews: mapViewEntries,
      activeMapViewId: state.currentMapSessionId || null,
      roads: roads
    };
  }

  function clearImportedRoadEntries() {
    for (var i = 0; i < importedRoadEntries.length; i++) {
      var entry = importedRoadEntries[i];
      if (!entry) continue;
      entry.removed = true;
      removeRoadLayer(entry);
    }
    importedRoadEntries = [];
    roadLayersVisible = false;
    roadVisibilityDirty = false;
    dom.geojsonFilesListEl.textContent = '';
  }

  function parseImportedMapSession(raw, fallbackId) {
    var id = parseInt(raw && raw.id, 10);
    if (!isFinite(id) || id < 1) id = fallbackId;
    var lat = parseFloat(raw && raw.lat);
    var lng = parseFloat(raw && raw.lng);
    var zoom = parseFloat(raw && raw.zoom);
    return {
      id: id,
      name: (raw && raw.name) ? String(raw.name) : ('View ' + String(id)),
      lat: isFinite(lat) ? lat : 0,
      lng: isFinite(lng) ? lng : 0,
      zoom: isFinite(zoom) ? zoom : 17
    };
  }

  function applyMapSetupImportData(mapSetup) {
    if (!mapSetup || typeof mapSetup !== 'object') return;

    if (mapSetup.trackingOffset && typeof mapSetup.trackingOffset === 'object') {
      var importedX = clamp(parseFloat(mapSetup.trackingOffset.x), -500, 500);
      var importedY = clamp(parseFloat(mapSetup.trackingOffset.y), -500, 500);
      var importedTriggerX = clamp(parseFloat(mapSetup.trackingOffset.triggerX), -500, 500);
      var importedTriggerY = clamp(parseFloat(mapSetup.trackingOffset.triggerY), -500, 500);
      var importedCompressionPct = clamp(parseFloat(mapSetup.trackingOffset.compressionPct), 0, 60);
      if (!isFinite(importedX)) importedX = 0;
      if (!isFinite(importedY)) importedY = 0;
      if (!isFinite(importedTriggerX)) importedTriggerX = 0;
      if (!isFinite(importedTriggerY)) importedTriggerY = 0;
      if (!isFinite(importedCompressionPct)) importedCompressionPct = 0;
      state.apriltagTrackingOffsetX = importedX;
      state.apriltagTrackingOffsetY = importedY;
      state.apriltagTriggerTrackingOffsetX = importedTriggerX;
      state.apriltagTriggerTrackingOffsetY = importedTriggerY;
      state.apriltagOffsetBottomCompressionPct = importedCompressionPct;
      dom.trackingOffsetXSliderEl.value = String(Math.round(importedX));
      dom.trackingOffsetXValueEl.textContent = String(Math.round(importedX));
      dom.trackingOffsetYSliderEl.value = String(Math.round(importedY));
      dom.trackingOffsetYValueEl.textContent = String(Math.round(importedY));
      dom.trackingTriggerOffsetXSliderEl.value = String(Math.round(importedTriggerX));
      dom.trackingTriggerOffsetXValueEl.textContent = String(Math.round(importedTriggerX));
      dom.trackingTriggerOffsetYSliderEl.value = String(Math.round(importedTriggerY));
      dom.trackingTriggerOffsetYValueEl.textContent = String(Math.round(importedTriggerY));
      dom.trackingOffsetCompressionSliderEl.value = String(Math.round(importedCompressionPct));
      dom.trackingOffsetCompressionValueEl.textContent = String(Math.round(importedCompressionPct)) + '%';
      saveNumberSetting('apriltagTrackingOffsetX', state.apriltagTrackingOffsetX);
      saveNumberSetting('apriltagTrackingOffsetY', state.apriltagTrackingOffsetY);
      saveNumberSetting('apriltagTriggerTrackingOffsetX', state.apriltagTriggerTrackingOffsetX);
      saveNumberSetting('apriltagTriggerTrackingOffsetY', state.apriltagTriggerTrackingOffsetY);
      saveNumberSetting('apriltagOffsetBottomCompressionPct', state.apriltagOffsetBottomCompressionPct);

      var importedGrid = mapSetup.trackingOffset.primaryOffsetGrid;
      if (hasCompletePrimaryOffsetGrid(importedGrid)) {
        state.apriltagPrimaryOffsetGrid = importedGrid;
        savePrimaryOffsetGridToStorage(importedGrid);
      } else if (importedGrid === null) {
        state.apriltagPrimaryOffsetGrid = null;
        clearPrimaryOffsetGridFromStorage();
      }
      updatePrimaryOffsetCalibrationStatus();
    }

    clearImportedRoadEntries();

    var roads = Array.isArray(mapSetup.roads) ? mapSetup.roads : [];
    for (var ri = 0; ri < roads.length; ri++) {
      var road = roads[ri];
      if (!road || !isRoadFeatureCollection(road.geojsonData)) continue;

      var text = JSON.stringify(road.geojsonData);
      var pseudoFile = {
        name: road.fileName ? String(road.fileName) : ('roads-' + String(ri + 1) + '.geojson'),
        text: (function(rawText) {
          return function() { return Promise.resolve(rawText); };
        })(text)
      };

      var roadEntry = addGeojsonFileRow(pseudoFile);
      if (!roadEntry) continue;
      if (road.color) {
        roadEntry.colorInput.value = String(road.color);
        roadEntry.rowEl.dataset.roadColor = roadEntry.colorInput.value;
      }
      roadEntry.hasFittedToBounds = !!road.hasFittedToBounds;
    }

    mapSessions = [];
    mapSessionCounter = 0;
    currentMapSessionIndex = -1;
    state.currentMapSessionId = null;

    var importedMapViews = Array.isArray(mapSetup.mapViews) ? mapSetup.mapViews : [];
    var usedSessionIds = {};
    for (var si = 0; si < importedMapViews.length; si++) {
      var fallbackId = si + 1;
      var parsedSession = parseImportedMapSession(importedMapViews[si], fallbackId);
      while (usedSessionIds[String(parsedSession.id)]) {
        parsedSession.id++;
      }
      usedSessionIds[String(parsedSession.id)] = true;
      if (parsedSession.id > mapSessionCounter) mapSessionCounter = parsedSession.id;
      mapSessions.push(parsedSession);
    }
    renderMapSessionList();

    var activeMapViewId = parseInt(mapSetup.activeMapViewId, 10);
    var activeIndex = -1;
    if (isFinite(activeMapViewId)) {
      for (var ai = 0; ai < mapSessions.length; ai++) {
        if (mapSessions[ai].id === activeMapViewId) {
          activeIndex = ai;
          break;
        }
      }
    }
    if (activeIndex < 0 && mapSessions.length > 0) activeIndex = 0;
    if (activeIndex >= 0) activateMapSession(activeIndex);
    else filterElementsBySession(null);

    updateRoadLayersVisibilityByTags();
  }

  function setVgaPanelVisible(visible) {
    dom.vgaModePanelEl.classList.toggle('hidden', !visible);
    dom.vgaModePanelEl.setAttribute('aria-hidden', visible ? 'false' : 'true');
  }

  function ensureVgaLayers() {
    if (!state.map) return;
    if (!vgaSelectionLayer) {
      vgaSelectionLayer = createLayerGroup();
    }
    if (!vgaHeatmapLayer) {
      vgaHeatmapLayer = createLayerGroup();
    }
  }

  function clearVgaSelection() {
    vgaSelectedCorners = [];
    if (vgaSelectionLayer) clearGroup(state.map, vgaSelectionLayer);
    updateVgaPanelMeta();
  }

  function clearVgaHeatmap() {
    if (vgaHeatmapLayer) clearGroup(state.map, vgaHeatmapLayer);
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
    if (vgaMapClickBound || !state.map) return;
    state.map.on('click', onVgaMapClick);
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
    var shouldEnable = !!active && state.stage === 3 && state.viewMode === 'map' && !!state.map;
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
      applyVgaBuildingHighlightPaintOverrides();
      document.body.classList.add('vga-mode-active');
      setVgaPanelVisible(true);
      setVgaStatus('Ctrl+click four corners on the map. Hover a building and press H to toggle red highlight.');
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
    clearAllVgaBuildingHighlights();
    vgaHoverClientPoint = null;
    updateUiSetupPanelVisibility();
    updateEdgeGuidesVisibility();
    updateGestureControlsVisibility();
    updateTrackingOffsetControlsVisibility();
    updateToolTagControlsVisibility();
    updateHamburgerMenuVisibility();
  }

  function hasAnyVgaBuildingHighlights() {
    for (var key in vgaHighlightedBuildingStateByKey) {
      if (vgaHighlightedBuildingStateByKey[key]) return true;
    }
    return false;
  }

  function updateVgaHoverClientPointFromMouseEvent(e) {
    if (!e || !isFinite(e.clientX) || !isFinite(e.clientY)) return;
    if (state.stage !== 3 || state.viewMode !== 'map' || !state.map) return;
    vgaHoverClientPoint = { x: e.clientX, y: e.clientY };
  }

  function vgaClientToMapContainerPoint(clientX, clientY) {
    if (!state.map || !dom.mapViewEl || !dom.mapWarpEl) return null;
    if (!isFinite(clientX) || !isFinite(clientY)) return null;

    var mapViewRect = dom.mapViewEl.getBoundingClientRect();
    if (!mapViewRect || !mapViewRect.width || !mapViewRect.height) return null;

    var x = clientX - mapViewRect.left;
    var y = clientY - mapViewRect.top;
    if (x < 0 || x > mapViewRect.width || y < 0 || y > mapViewRect.height) return null;

    try {
      var transform = window.getComputedStyle(dom.mapWarpEl).transform;
      if (transform && transform !== 'none') {
        var m = new DOMMatrixReadOnly(transform);
        var inv = m.inverse();
        var local = new DOMPoint(x, y, 0, 1).matrixTransform(inv);
        if (local && typeof local.w === 'number' && local.w && local.w !== 1) {
          local = new DOMPoint(local.x / local.w, local.y / local.w, local.z / local.w, 1);
        }
        x = local.x;
        y = local.y;
      }
    } catch (err) { /* use unwarped coordinates as fallback */ }

    var mapContainer = state.map.getContainer();
    var w = mapContainer ? mapContainer.offsetWidth : 0;
    var h = mapContainer ? mapContainer.offsetHeight : 0;
    if (w > 0 && h > 0) {
      if (x < 0 || x > w || y < 0 || y > h) return null;
    }

    if (!isFinite(x) || !isFinite(y)) return null;
    return { x: x, y: y };
  }

  function isVgaBuildingLayer(layer) {
    if (!layer) return false;
    var type = String(layer.type || '').toLowerCase();
    if (type !== 'fill' && type !== 'fill-extrusion') return false;
    var sourceLayer = String((layer['source-layer'] || '')).toLowerCase();
    if (sourceLayer.indexOf('building') !== -1) return true;
    var id = String(layer.id || '').toLowerCase();
    return id.indexOf('building') !== -1;
  }

  function refreshVgaBuildingLayerIds() {
    vgaBuildingLayerIds = [];
    if (!state.map || !state.mapReady) return;
    var style = null;
    try {
      style = state.map.getStyle();
    } catch (e) {
      style = null;
    }
    var layers = style && Array.isArray(style.layers) ? style.layers : [];
    for (var i = 0; i < layers.length; i++) {
      var layer = layers[i];
      if (!isVgaBuildingLayer(layer)) continue;
      vgaBuildingLayerIds.push(layer.id);
    }
  }

  function unwrapVgaBuildingHighlightExpression(value) {
    if (!Array.isArray(value) || value.length < 4) return value;
    if (value[0] !== 'case') return value;
    var cond = value[1];
    if (!Array.isArray(cond) || cond.length < 3) return value;
    if (cond[0] !== 'boolean') return value;
    if (cond[2] !== false) return value;
    var featureStateExpr = cond[1];
    if (!Array.isArray(featureStateExpr) || featureStateExpr.length < 2) return value;
    if (featureStateExpr[0] !== 'feature-state') return value;
    if (featureStateExpr[1] !== VGA_BUILDING_HIGHLIGHT_STATE_KEY) return value;
    return value[3];
  }

  function applyVgaBuildingHighlightPaintOverrides() {
    if (!state.map || !state.mapReady) return;
    refreshVgaBuildingLayerIds();
    for (var i = 0; i < vgaBuildingLayerIds.length; i++) {
      var layerId = vgaBuildingLayerIds[i];
      var layer = null;
      try {
        layer = state.map.getLayer(layerId);
      } catch (e1) {
        layer = null;
      }
      if (!layer) continue;

      var type = String(layer.type || '').toLowerCase();
      var paintProp = '';
      if (type === 'fill-extrusion') paintProp = 'fill-extrusion-color';
      else if (type === 'fill') paintProp = 'fill-color';
      else continue;

      var currentValue;
      try {
        currentValue = state.map.getPaintProperty(layerId, paintProp);
      } catch (e2) {
        continue;
      }
      if (currentValue === undefined) continue;
      var baseValue = unwrapVgaBuildingHighlightExpression(currentValue);
      var nextValue = ['case', ['boolean', ['feature-state', VGA_BUILDING_HIGHLIGHT_STATE_KEY], false], VGA_BUILDING_HIGHLIGHT_COLOR, baseValue];
      try {
        state.map.setPaintProperty(layerId, paintProp, nextValue);
      } catch (e3) { /* ignore */ }
    }
  }

  function getVgaFeatureStateTarget(feature) {
    if (!feature) return null;
    var source = feature.source ? String(feature.source) : '';
    if (!source) return null;
    if (feature.id === null || feature.id === undefined || feature.id === '') return null;

    var target = {
      source: source,
      id: feature.id
    };
    var sourceLayer = '';
    if (feature.sourceLayer !== null && feature.sourceLayer !== undefined) {
      sourceLayer = String(feature.sourceLayer);
    } else if (feature.layer && feature.layer['source-layer'] !== null && feature.layer['source-layer'] !== undefined) {
      sourceLayer = String(feature.layer['source-layer']);
    }
    if (sourceLayer) target.sourceLayer = sourceLayer;
    return target;
  }

  function getVgaFeatureStateKey(target) {
    if (!target || !target.source) return '';
    if (target.id === null || target.id === undefined || target.id === '') return '';
    var sourceLayer = target.sourceLayer ? String(target.sourceLayer) : '';
    return String(target.source) + '|' + sourceLayer + '|' + String(target.id);
  }

  function setVgaBuildingFeatureState(target, highlighted) {
    if (!state.map || !target) return;
    try {
      var statePatch = {};
      statePatch[VGA_BUILDING_HIGHLIGHT_STATE_KEY] = !!highlighted;
      state.map.setFeatureState(target, statePatch);
    } catch (e) { /* ignore */ }
  }

  function clearAllVgaBuildingHighlights() {
    for (var key in vgaHighlightedBuildingStateByKey) {
      var target = vgaHighlightedBuildingStateByKey[key];
      if (!target) continue;
      setVgaBuildingFeatureState(target, false);
    }
    vgaHighlightedBuildingStateByKey = {};
  }

  function findVgaBuildingFeatureAtHoverPoint() {
    if (!state.map || !state.mapReady || !vgaHoverClientPoint) return null;
    var pt = vgaClientToMapContainerPoint(vgaHoverClientPoint.x, vgaHoverClientPoint.y);
    if (!pt) return null;

    refreshVgaBuildingLayerIds();
    var queryOptions = vgaBuildingLayerIds.length > 0 ? { layers: vgaBuildingLayerIds } : undefined;
    var features = [];
    try {
      features = queryOptions
        ? state.map.queryRenderedFeatures([pt.x, pt.y], queryOptions)
        : state.map.queryRenderedFeatures([pt.x, pt.y]);
    } catch (e) {
      features = [];
    }

    for (var i = 0; i < features.length; i++) {
      var feature = features[i];
      if (!feature || !isVgaBuildingLayer(feature.layer)) continue;
      var target = getVgaFeatureStateTarget(feature);
      if (!target) continue;
      return {
        target: target,
        key: getVgaFeatureStateKey(target)
      };
    }
    return null;
  }

  function toggleVgaHoveredBuildingHighlight() {
    if (!state.map || !state.mapReady) return;
    if (state.stage !== 3 || state.viewMode !== 'map' || !vgaModeActive) return;

    applyVgaBuildingHighlightPaintOverrides();
    var hit = findVgaBuildingFeatureAtHoverPoint();
    if (!hit || !hit.key) {
      setVgaStatus('No building under cursor. Move cursor over a building and press H.');
      return;
    }

    if (vgaHighlightedBuildingStateByKey[hit.key]) {
      setVgaBuildingFeatureState(hit.target, false);
      delete vgaHighlightedBuildingStateByKey[hit.key];
      setVgaStatus('Building highlight removed.');
      return;
    }

    setVgaBuildingFeatureState(hit.target, true);
    vgaHighlightedBuildingStateByKey[hit.key] = hit.target;
    setVgaStatus('Building highlighted in red.');
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
    if (!vgaSelectionLayer || !state.map) return;
    clearGroup(state.map, vgaSelectionLayer);

    for (var i = 0; i < vgaSelectedCorners.length; i++) {
      var p = vgaSelectedCorners[i];
      if (!p) continue;
      var markerRef = addCircleMarker(state.map, [p.lng, p.lat], {
        radius: 6,
        color: '#f59e0b',
        weight: 2,
        fillColor: '#f59e0b',
        fillOpacity: 0.95
      });
      addToGroup(vgaSelectionLayer, markerRef);
    }

    var ordered = orderLatLngsClockwise(vgaSelectedCorners);
    if (ordered.length >= 3) {
      var ring = [];
      for (var k = 0; k < ordered.length; k++) {
        ring.push([ordered[k].lng, ordered[k].lat]);
      }
      ring.push(ring[0]); // close ring
      var polyRef = addPolygon(state.map, [ring], {
        color: '#f59e0b',
        weight: 2,
        fillColor: '#f59e0b',
        fillOpacity: 0.08,
        opacity: 0.95
      });
      addToGroup(vgaSelectionLayer, polyRef);
    }
  }

  function onVgaMapClick(e) {
    if (!vgaModeActive || vgaApplying) return;
    if (state.stage !== 3 || state.viewMode !== 'map') return;
    if (!e || !e.lngLat) return;
    var originalEvent = e.originalEvent;
    var isCtrlClick = !!(originalEvent && (originalEvent.ctrlKey || originalEvent.metaKey));
    if (!isCtrlClick) return;
    if (originalEvent && typeof originalEvent.preventDefault === 'function') originalEvent.preventDefault();
    if (originalEvent && typeof originalEvent.stopPropagation === 'function') originalEvent.stopPropagation();

    var nextPoint = { lat: e.lngLat.lat, lng: e.lngLat.lng };
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
    if (!state.map) return null;
    if (!Array.isArray(corners) || corners.length < VGA_REQUIRED_POINTS) return null;

    var orderedCorners = orderLatLngsClockwise(corners);
    if (orderedCorners.length < 3) return null;

    var map = state.map;
    var polygonPoints = [];
    for (var i = 0; i < orderedCorners.length; i++) {
      var ll = orderedCorners[i];
      var pt = map.project([ll.lng, ll.lat]);
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
        var llSample = map.unproject([x, y]);
        var sample = llSample ? { lat: llSample.lat, lng: llSample.lng } : null;
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
    if (!vgaHeatmapLayer || !state.map) return;
    clearGroup(state.map, vgaHeatmapLayer);
    if (!Array.isArray(samples) || samples.length < 1) return;

    var map = state.map;
    var orderedCorners = orderLatLngsClockwise(vgaSelectedCorners);
    if (orderedCorners.length < 3) return;

    var polygonContainer = [];
    var minX = Infinity;
    var minY = Infinity;
    var maxX = -Infinity;
    var maxY = -Infinity;
    for (var ci = 0; ci < orderedCorners.length; ci++) {
      var c = orderedCorners[ci];
      var cpt = map.project([c.lng, c.lat]);
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
      var spt = map.project([sample.latlng.lng, sample.latlng.lat]);
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

    var nw = map.unproject([minX, minY]);
    var se = map.unproject([maxX, maxY]);
    var imgRef = addImageOverlay(state.map, outCanvas.toDataURL('image/png'),
      [[nw.lng, se.lat], [se.lng, nw.lat]], { opacity: 0.92 });
    addToGroup(vgaHeatmapLayer, imgRef);
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

    // Compute bounding box from the 4 selected corners
    var minLat = Infinity, maxLat = -Infinity, minLng = Infinity, maxLng = -Infinity;
    for (var ci = 0; ci < vgaSelectedCorners.length; ci++) {
      var c = vgaSelectedCorners[ci];
      if (!c) continue;
      if (c.lat < minLat) minLat = c.lat;
      if (c.lat > maxLat) maxLat = c.lat;
      if (c.lng < minLng) minLng = c.lng;
      if (c.lng > maxLng) maxLng = c.lng;
    }

    setVgaStatus('Fetching buildings...');

    // Fetch buildings only for the selected area, then compute isovist scores
    fetchBuildingsForBounds(minLat, minLng, maxLat, maxLng).then(function() {
      if (!vgaModeActive || applyRunId !== vgaApplyRunId) {
        vgaApplying = false;
        updateVgaPanelMeta();
        return;
      }

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
    }).catch(function(err) {
      console.warn('Building fetch failed during VGA:', err);
      setVgaStatus('Building fetch failed. Retrying may help.');
      vgaApplying = false;
      updateVgaPanelMeta();
    });
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

  function resetPanTagRuntime() {
    panTagRuntime.anchorMapLatLng = null;
    panTagRuntime.lastTagPoint = null;
    panTagRuntime.lastApplyAtMs = 0;
    panTagRuntime.missingSinceMs = 0;
  }

  function resetZoomTagRuntime() {
    zoomTagRuntime.baselineZoomReady = false;
    zoomTagRuntime.baselineZoom = 0;
    zoomTagRuntime.handBaselineById = {};
    zoomTagRuntime.lastApplyAtMs = 0;
    zoomTagRuntime.missingSinceMs = 0;
    clearZoomGuides();
  }

  function ensureZoomGuidesOverlay() {
    if (zoomGuidesOverlayEl && zoomGuidesOverlayEl.isConnected) return zoomGuidesOverlayEl;
    if (!dom.mapWarpEl) return null;
    zoomGuidesOverlayEl = document.createElement('div');
    zoomGuidesOverlayEl.className = 'map-zoom-guides';
    dom.mapWarpEl.appendChild(zoomGuidesOverlayEl);
    return zoomGuidesOverlayEl;
  }

  function ensureZoomGuideEl(handId) {
    var key = String(handId || '');
    if (!key) return null;
    var existing = zoomTagRuntime.guideByHandId && zoomTagRuntime.guideByHandId[key];
    if (existing && existing.isConnected) return existing;

    var overlay = ensureZoomGuidesOverlay();
    if (!overlay) return null;

    var guideEl = document.createElement('div');
    guideEl.className = 'map-zoom-guide';
    guideEl.dataset.handId = key;

    var lineEl = document.createElement('div');
    lineEl.className = 'map-zoom-guide__line';
    guideEl.appendChild(lineEl);

    var plusEl = document.createElement('div');
    plusEl.className = 'map-zoom-guide__plus';
    plusEl.textContent = '+';
    guideEl.appendChild(plusEl);

    var minusEl = document.createElement('div');
    minusEl.className = 'map-zoom-guide__minus';
    minusEl.textContent = '-';
    guideEl.appendChild(minusEl);

    overlay.appendChild(guideEl);
    if (!zoomTagRuntime.guideByHandId) zoomTagRuntime.guideByHandId = {};
    zoomTagRuntime.guideByHandId[key] = guideEl;
    return guideEl;
  }

  function clearZoomGuides() {
    var byHand = zoomTagRuntime.guideByHandId || {};
    for (var handId in byHand) {
      var el = byHand[handId];
      if (el && el.parentNode) el.parentNode.removeChild(el);
    }
    zoomTagRuntime.guideByHandId = {};
  }

  function syncZoomGuides(activeGuideStates) {
    var overlay = ensureZoomGuidesOverlay();
    if (!overlay) return;

    var states = Array.isArray(activeGuideStates) ? activeGuideStates : [];
    var keep = {};
    for (var i = 0; i < states.length; i++) {
      var st = states[i];
      if (!st || !st.handId || !isFinite(st.x) || !isFinite(st.baseY)) continue;
      var key = String(st.handId);
      keep[key] = true;
      var guideEl = ensureZoomGuideEl(key);
      if (!guideEl) continue;
      guideEl.style.left = st.x + 'px';
      guideEl.style.top = st.baseY + 'px';
      guideEl.style.setProperty('--zoom-guide-range', ZOOM_CONTROL_RANGE_PX + 'px');
      guideEl.classList.remove('hidden');
    }

    var byHand = zoomTagRuntime.guideByHandId || {};
    for (var handKey in byHand) {
      if (keep[handKey]) continue;
      var oldEl = byHand[handKey];
      if (oldEl && oldEl.parentNode) oldEl.parentNode.removeChild(oldEl);
      delete byHand[handKey];
    }
  }

  // Convert a detection's UV (screen-space) to mapWarp-local container coordinates.
  // The Maptastic perspective transform means screen UV ≠ mapWarp local coords,
  // so we must invert the Maptastic matrix to go from screen → mapWarp-local.
  function projectDetectionToMapContainerPoint(det, options) {
    options = options || {};
    if (!det || !det.center) return null;
    if (!state.surfaceHomography || !state.map) return null;

    var viewW = dom.mapViewEl.offsetWidth;
    var viewH = dom.mapViewEl.offsetHeight;
    if (!viewW || !viewH) return null;

    var uv = applyHomography(state.surfaceHomography, det.center.x, det.center.y);
    if (!uv) return null;
    var allowExtrapolation = !!options.allowExtrapolation;
    if (allowExtrapolation) {
      var maxExtrapolation = parseFloat(options.maxExtrapolation);
      if (!isFinite(maxExtrapolation) || maxExtrapolation < 0) maxExtrapolation = ZOOM_TAG_MAX_EXTRAPOLATION;
      if (uv.x < -maxExtrapolation || uv.x > (1 + maxExtrapolation) ||
          uv.y < -maxExtrapolation || uv.y > (1 + maxExtrapolation)) {
        return null;
      }
    } else if (uv.x < 0 || uv.x > 1 || uv.y < 0 || uv.y > 1) {
      return null;
    }

    // UV → screen-space pixel position
    var screenX = uv.x * viewW;
    var screenY = uv.y * viewH;

    // Invert the Maptastic warp to get mapWarp-local container coords
    try {
      var transform = window.getComputedStyle(dom.mapWarpEl).transform;
      if (transform && transform !== 'none') {
        var m = new DOMMatrixReadOnly(transform);
        var inv = m.inverse();
        var local = new DOMPoint(screenX, screenY, 0, 1).matrixTransform(inv);
        if (local && typeof local.w === 'number' && local.w && local.w !== 1) {
          local = new DOMPoint(local.x / local.w, local.y / local.w, local.z / local.w, 1);
        }
        screenX = local.x;
        screenY = local.y;
      }
    } catch (err) { /* use screen coords as fallback */ }

    if (!isFinite(screenX) || !isFinite(screenY)) return null;
    return { x: screenX, y: screenY };
  }

  function projectDetectionToMapLatLng(det, options) {
    var containerPt = projectDetectionToMapContainerPoint(det, options);
    if (!containerPt) return null;

    try {
      var ll = state.map.unproject([containerPt.x, containerPt.y]);
      return ll ? { lat: ll.lat, lng: ll.lng } : null;
    } catch (err) {
      return null;
    }
  }

  function applyPanAnchorToTagPoint(anchorLatLng, tagPoint) {
    if (!anchorLatLng || !tagPoint) return;
    if (!state.map) return;
    var map = state.map;
    var zoom = map.getZoom();
    if (!isFinite(zoom)) return;

    try {
      var anchorProjected = map.project([anchorLatLng.lng, anchorLatLng.lat]);
      var container = map.getContainer();
      var halfW = container.offsetWidth / 2;
      var halfH = container.offsetHeight / 2;
      var targetX = anchorProjected.x - tagPoint.x + halfW;
      var targetY = anchorProjected.y - tagPoint.y + halfH;
      var targetCenter = map.unproject([targetX, targetY]);
      map.jumpTo({ center: [targetCenter.lng, targetCenter.lat], zoom: zoom });
    } catch (err) {
      // Ignore transient projection errors.
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

  function collectShortestPathEndpointsForTagIds(detById, tagAId, tagBId, options) {
    options = options || {};
    if (!isFinite(tagAId) || !isFinite(tagBId) || tagAId === tagBId) return null;
    var detA = detById[tagAId];
    var detB = detById[tagBId];
    if (!detA || !detA.center || !detB || !detB.center) return null;
    if (options.requireInSurface !== false) {
      if (!isPointInSurface(detA.center.x, detA.center.y)) return null;
      if (!isPointInSurface(detB.center.x, detB.center.y)) return null;
    }

    var projectionOptions = options.projectionOptions || null;
    var pointA = projectDetectionToMapLatLng(detA, projectionOptions);
    var pointB = projectDetectionToMapLatLng(detB, projectionOptions);
    if (!pointA || !pointB) return null;
    return { a: pointA, b: pointB };
  }

  // Process tool tags for edge-triggered actions (called each frame)
  function processToolTagActions() {
    // Stage 3 layer tag tracking has been intentionally disabled.
    // Layer controls now use draggable sticker buttons in the panel.
  }

  function buildTagAxesMap(det, mapWidth, mapHeight) {
    if (!det || !Array.isArray(det.corners) || det.corners.length < 4 || !state.surfaceHomography) return null;
    var mappedCorners = [];
    for (var ci = 0; ci < 4; ci++) {
      var corner = det.corners[ci];
      if (!corner) continue;
      var mapped = applyHomography(state.surfaceHomography, corner.x, corner.y);
      mappedCorners[ci] = mapped || null;
    }

    function buildUnitVector(aIndex, bIndex) {
      var a = mappedCorners[aIndex];
      var b = mappedCorners[bIndex];
      if (!a || !b) return null;
      var vx = (b.x - a.x) * mapWidth;
      var vy = (b.y - a.y) * mapHeight;
      var len = Math.hypot(vx, vy);
      if (!isFinite(len) || len <= 1e-6) return null;
      return { x: vx / len, y: vy / len };
    }

    function mergeAlignedUnitVectors(vectors) {
      var base = null;
      var sumX = 0;
      var sumY = 0;
      for (var vi = 0; vi < vectors.length; vi++) {
        var vec = vectors[vi];
        if (!vec) continue;
        if (!base) {
          base = vec;
        } else {
          var dot = vec.x * base.x + vec.y * base.y;
          if (dot < 0) vec = { x: -vec.x, y: -vec.y };
        }
        sumX += vec.x;
        sumY += vec.y;
      }
      var mag = Math.hypot(sumX, sumY);
      if (!isFinite(mag) || mag <= 1e-6) return null;
      return { x: sumX / mag, y: sumY / mag };
    }

    var xAxis = mergeAlignedUnitVectors([
      buildUnitVector(0, 1),
      buildUnitVector(3, 2)
    ]);
    var yAxis = mergeAlignedUnitVectors([
      buildUnitVector(0, 3),
      buildUnitVector(1, 2)
    ]);
    if (!xAxis || !yAxis) return null;
    return { xAxis: xAxis, yAxis: yAxis };
  }

  function getPrimaryOffsetFromGrid(uv) {
    var grid = state.apriltagPrimaryOffsetGrid;
    if (!hasCompletePrimaryOffsetGrid(grid) || !uv) return null;
    var u = clamp(uv.x, 0, 1);
    var v = clamp(uv.y, 0, 1);
    var gx = u * 2.0;
    var gy = v * 2.0;
    var x0 = Math.floor(gx);
    var y0 = Math.floor(gy);
    if (x0 < 0) x0 = 0;
    if (y0 < 0) y0 = 0;
    if (x0 > 1) x0 = 1;
    if (y0 > 1) y0 = 1;
    var x1 = x0 + 1;
    var y1 = y0 + 1;
    var tx = gx - x0;
    var ty = gy - y0;
    function idx(ix, iy) { return iy * 3 + ix; }
    var p00 = grid[idx(x0, y0)];
    var p10 = grid[idx(x1, y0)];
    var p01 = grid[idx(x0, y1)];
    var p11 = grid[idx(x1, y1)];
    if (!p00 || !p10 || !p01 || !p11) return null;
    var oxTop = p00.ox + (p10.ox - p00.ox) * tx;
    var oxBot = p01.ox + (p11.ox - p01.ox) * tx;
    var oyTop = p00.oy + (p10.oy - p00.oy) * tx;
    var oyBot = p01.oy + (p11.oy - p01.oy) * tx;
    return {
      ox: oxTop + (oxBot - oxTop) * ty,
      oy: oyTop + (oyBot - oyTop) * ty
    };
  }

  function applyTrackedTagOffset(det, tagId, x, y, mapWidth, mapHeight, offsetMode, uv) {
    if (!offsetMode || !isFinite(tagId) || tagId < 10 || tagId > 30) {
      return { x: x, y: y };
    }

    var ox = offsetMode === 'trigger' ? state.apriltagTriggerTrackingOffsetX : state.apriltagTrackingOffsetX;
    var oy = offsetMode === 'trigger' ? state.apriltagTriggerTrackingOffsetY : state.apriltagTrackingOffsetY;

    if (offsetMode === 'primary') {
      var interp = getPrimaryOffsetFromGrid(uv);
      if (interp) {
        ox = interp.ox;
        oy = interp.oy;
      } else {
        var compressionPct = clamp(state.apriltagOffsetBottomCompressionPct, 0, 60);
        if (compressionPct > 0 && uv && isFinite(uv.y)) {
          var yNorm = clamp(uv.y, 0, 1);
          var compressionAtY = (compressionPct / 100) * yNorm;
          var scaleAtY = 1 - compressionAtY;
          ox *= scaleAtY;
          oy *= scaleAtY;
        }
      }
    }

    if (!ox && !oy) return { x: x, y: y };

    var axes = buildTagAxesMap(det, mapWidth, mapHeight);
    if (axes) {
      return {
        x: x + ox * axes.xAxis.x + oy * axes.yAxis.x,
        y: y + ox * axes.xAxis.y + oy * axes.yAxis.y
      };
    }
    return { x: x + ox, y: y + oy };
  }

  // Tracking offset sliders (for participant AprilTags 10-30)
  dom.trackingOffsetXSliderEl.value = String(Math.round(state.apriltagTrackingOffsetX));
  dom.trackingOffsetXValueEl.textContent = String(Math.round(state.apriltagTrackingOffsetX));
  dom.trackingOffsetXSliderEl.addEventListener('input', function() {
    var v = parseFloat(dom.trackingOffsetXSliderEl.value);
    if (!isFinite(v)) return;
    state.apriltagTrackingOffsetX = clamp(v, -500, 500);
    dom.trackingOffsetXValueEl.textContent = String(Math.round(state.apriltagTrackingOffsetX));
    saveNumberSetting('apriltagTrackingOffsetX', state.apriltagTrackingOffsetX);
  });

  dom.trackingOffsetYSliderEl.value = String(Math.round(state.apriltagTrackingOffsetY));
  dom.trackingOffsetYValueEl.textContent = String(Math.round(state.apriltagTrackingOffsetY));
  dom.trackingOffsetYSliderEl.addEventListener('input', function() {
    var v = parseFloat(dom.trackingOffsetYSliderEl.value);
    if (!isFinite(v)) return;
    state.apriltagTrackingOffsetY = clamp(v, -500, 500);
    dom.trackingOffsetYValueEl.textContent = String(Math.round(state.apriltagTrackingOffsetY));
    saveNumberSetting('apriltagTrackingOffsetY', state.apriltagTrackingOffsetY);
  });

  dom.trackingTriggerOffsetXSliderEl.value = String(Math.round(state.apriltagTriggerTrackingOffsetX));
  dom.trackingTriggerOffsetXValueEl.textContent = String(Math.round(state.apriltagTriggerTrackingOffsetX));
  dom.trackingTriggerOffsetXSliderEl.addEventListener('input', function() {
    var v = parseFloat(dom.trackingTriggerOffsetXSliderEl.value);
    if (!isFinite(v)) return;
    state.apriltagTriggerTrackingOffsetX = clamp(v, -500, 500);
    dom.trackingTriggerOffsetXValueEl.textContent = String(Math.round(state.apriltagTriggerTrackingOffsetX));
    saveNumberSetting('apriltagTriggerTrackingOffsetX', state.apriltagTriggerTrackingOffsetX);
  });

  dom.trackingTriggerOffsetYSliderEl.value = String(Math.round(state.apriltagTriggerTrackingOffsetY));
  dom.trackingTriggerOffsetYValueEl.textContent = String(Math.round(state.apriltagTriggerTrackingOffsetY));
  dom.trackingTriggerOffsetYSliderEl.addEventListener('input', function() {
    var v = parseFloat(dom.trackingTriggerOffsetYSliderEl.value);
    if (!isFinite(v)) return;
    state.apriltagTriggerTrackingOffsetY = clamp(v, -500, 500);
    dom.trackingTriggerOffsetYValueEl.textContent = String(Math.round(state.apriltagTriggerTrackingOffsetY));
    saveNumberSetting('apriltagTriggerTrackingOffsetY', state.apriltagTriggerTrackingOffsetY);
  });

  dom.trackingOffsetCompressionSliderEl.value = String(Math.round(state.apriltagOffsetBottomCompressionPct));
  dom.trackingOffsetCompressionValueEl.textContent = String(Math.round(state.apriltagOffsetBottomCompressionPct)) + '%';
  dom.trackingOffsetCompressionSliderEl.addEventListener('input', function() {
    var v = parseFloat(dom.trackingOffsetCompressionSliderEl.value);
    if (!isFinite(v)) return;
    state.apriltagOffsetBottomCompressionPct = clamp(v, 0, 60);
    dom.trackingOffsetCompressionValueEl.textContent = String(Math.round(state.apriltagOffsetBottomCompressionPct)) + '%';
    saveNumberSetting('apriltagOffsetBottomCompressionPct', state.apriltagOffsetBottomCompressionPct);
  });

  function clearPrimaryOffsetCalibOverlay() {
    for (var i = 0; i < primaryOffsetCalibPointEls.length; i++) {
      var el = primaryOffsetCalibPointEls[i];
      if (el && el.parentNode) el.parentNode.removeChild(el);
    }
    primaryOffsetCalibPointEls = [];
  }

  function renderPrimaryOffsetCalibOverlay() {
    clearPrimaryOffsetCalibOverlay();
    if (!state.apriltagPrimaryOffsetCalibActive) return;
    if (!dom.mapViewEl) return;
    var w = dom.mapViewEl.offsetWidth;
    var h = dom.mapViewEl.offsetHeight;
    if (!w || !h) return;
    for (var i = 0; i < PRIMARY_OFFSET_GRID_POINTS_UV.length; i++) {
      var p = PRIMARY_OFFSET_GRID_POINTS_UV[i];
      var el = document.createElement('div');
      el.className = 'tracking-offset-calib-point';
      if (i === state.apriltagPrimaryOffsetCalibIndex) {
        el.classList.add('tracking-offset-calib-point--active');
      } else if (Array.isArray(state.apriltagPrimaryOffsetGrid) && state.apriltagPrimaryOffsetGrid[i]) {
        el.classList.add('tracking-offset-calib-point--done');
      }
      el.style.left = String(p.u * w) + 'px';
      el.style.top = String(p.v * h) + 'px';
      el.textContent = String(i + 1);
      dom.mapViewEl.appendChild(el);
      primaryOffsetCalibPointEls.push(el);
    }
  }

  function findPrimaryCalibrationDetection() {
    var dets = Array.isArray(state.lastApriltagDetections) ? state.lastApriltagDetections : [];
    if (dets.length < 1) return null;
    var byId = {};
    for (var i = 0; i < dets.length; i++) {
      var d = dets[i];
      if (!d || !d.center) continue;
      var id = parseInt(d.id, 10);
      if (!isFinite(id)) continue;
      byId[id] = d;
    }
    if (Array.isArray(state.stage3ParticipantTagIds)) {
      for (var j = 0; j < state.stage3ParticipantTagIds.length; j++) {
        var pid = parseInt(state.stage3ParticipantTagIds[j], 10);
        if (!isFinite(pid)) continue;
        if (byId[pid]) return byId[pid];
      }
    }
    for (var k = 0; k < dets.length; k++) {
      var det = dets[k];
      var detId = parseInt(det && det.id, 10);
      if (!isFinite(detId) || detId < 10 || detId > 30) continue;
      if (det && det.center) return det;
    }
    return null;
  }

  function startPrimaryOffset9PointCalibration() {
    if (!state.surfaceHomography) {
      setError('Calibrate surface first (corners/homography) before 9-point offset.');
      return;
    }
    if (state.stage !== 3) {
      setError('Open Stage 3 map view before starting 9-point offset calibration.');
      return;
    }
    if (state.viewMode !== 'map') {
      dom.viewToggleEl.checked = true;
      setViewMode('map');
    }
    state.apriltagPrimaryOffsetCalibActive = true;
    state.apriltagPrimaryOffsetCalibIndex = 0;
    state.apriltagPrimaryOffsetGrid = new Array(9);
    setPrimaryOffsetCalibUiEnabled(true);
    updatePrimaryOffsetCalibrationStatus();
    renderPrimaryOffsetCalibOverlay();
    setError('9-point offset started. Put tool TIP on highlighted point and press S (or Capture).');
  }

  function stopPrimaryOffset9PointCalibration() {
    state.apriltagPrimaryOffsetCalibActive = false;
    state.apriltagPrimaryOffsetCalibIndex = 0;
    setPrimaryOffsetCalibUiEnabled(false);
    updatePrimaryOffsetCalibrationStatus();
    clearPrimaryOffsetCalibOverlay();
  }

  function clearPrimaryOffset9PointCalibration() {
    stopPrimaryOffset9PointCalibration();
    state.apriltagPrimaryOffsetGrid = null;
    clearPrimaryOffsetGridFromStorage();
    updatePrimaryOffsetCalibrationStatus();
    setError('Primary 9-point offset cleared.');
  }

  function capturePrimaryOffset9Point() {
    if (!state.apriltagPrimaryOffsetCalibActive) return;
    if (!state.surfaceHomography) {
      setError('Surface homography missing. Recalibrate surface first.');
      return;
    }
    var det = findPrimaryCalibrationDetection();
    if (!det || !det.center) {
      setError('No primary AprilTag detected. Show the primary tag and try again.');
      return;
    }
    var mapW = dom.mapViewEl ? dom.mapViewEl.offsetWidth : 0;
    var mapH = dom.mapViewEl ? dom.mapViewEl.offsetHeight : 0;
    if (!mapW || !mapH) {
      setError('Map view size unavailable. Try again.');
      return;
    }
    var uv = applyHomography(state.surfaceHomography, det.center.x, det.center.y);
    if (!uv) {
      setError('Could not project detected tag onto map. Try again.');
      return;
    }

    var pointIdx = state.apriltagPrimaryOffsetCalibIndex;
    var targetUv = PRIMARY_OFFSET_GRID_POINTS_UV[pointIdx];
    var currentX = uv.x * mapW;
    var currentY = uv.y * mapH;
    var targetX = targetUv.u * mapW;
    var targetY = targetUv.v * mapH;
    // We calibrate the tag-center correction vector (where the tag center should move),
    // so the stored local offset must point from target -> current in map space.
    var dx = currentX - targetX;
    var dy = currentY - targetY;

    var ox = dx;
    var oy = dy;
    var axes = buildTagAxesMap(det, mapW, mapH);
    if (axes) {
      ox = dx * axes.xAxis.x + dy * axes.xAxis.y;
      oy = dx * axes.yAxis.x + dy * axes.yAxis.y;
    }

    if (!Array.isArray(state.apriltagPrimaryOffsetGrid) || state.apriltagPrimaryOffsetGrid.length !== 9) {
      state.apriltagPrimaryOffsetGrid = new Array(9);
    }
    state.apriltagPrimaryOffsetGrid[pointIdx] = { ox: ox, oy: oy };

    if (pointIdx >= 8) {
      stopPrimaryOffset9PointCalibration();
      savePrimaryOffsetGridToStorage(state.apriltagPrimaryOffsetGrid);
      updatePrimaryOffsetCalibrationStatus();
      setError('9-point offset calibration complete. Primary offset now adapts across the full map.');
      return;
    }

    state.apriltagPrimaryOffsetCalibIndex = pointIdx + 1;
    updatePrimaryOffsetCalibrationStatus();
    renderPrimaryOffsetCalibOverlay();
    setError('Captured point ' + String(pointIdx + 1) + '/9. Move to point ' + String(state.apriltagPrimaryOffsetCalibIndex + 1) + ' and capture.');
  }

  dom.trackingOffset9ptBtnEl.addEventListener('click', function() {
    if (state.apriltagPrimaryOffsetCalibActive) stopPrimaryOffset9PointCalibration();
    else startPrimaryOffset9PointCalibration();
  });

  dom.trackingOffset9ptCaptureBtnEl.addEventListener('click', function() {
    capturePrimaryOffset9Point();
  });

  dom.trackingOffset9ptClearBtnEl.addEventListener('click', function() {
    clearPrimaryOffset9PointCalibration();
  });

  document.addEventListener('keydown', function(e) {
    if (!state.apriltagPrimaryOffsetCalibActive) return;
    if (e.repeat) return;
    var target = e.target;
    if (target) {
      var tag = String(target.tagName || '').toUpperCase();
      if (tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT' || target.isContentEditable) return;
    }
    var key = String(e.key || '').toLowerCase();
    if (key !== 's') return;
    e.preventDefault();
    capturePrimaryOffset9Point();
  });

  setPrimaryOffsetCalibUiEnabled(false);
  updatePrimaryOffsetCalibrationStatus();

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
    var enteringStage4 = (newStage === 4 && state.stage !== 4);
    if (enteringStage4 && mapSessions.length < 1) {
      setError('Add at least one map view before starting Stage 4.');
      window.alert('Add at least one map view before starting Stage 4.');
      return;
    }
    if (vgaModeActive && newStage !== 3) {
      setVgaMode(false);
    }
    if (state.apriltagPrimaryOffsetCalibActive && newStage !== 3) {
      stopPrimaryOffset9PointCalibration();
    }
    state.stage = newStage;

    var titles = { 1: 'Camera Setup Stage 1/4', 2: 'Surface Setup Stage 2/4', 3: 'UI Setup Stage 3/4', 4: 'Stage 4/4' };
    dom.pageTitleEl.textContent = titles[newStage] || '';
    document.title = titles[newStage] || '';

    if (newStage === 2 || newStage === 3) {
      dom.viewToggleContainerEl.classList.remove('hidden');
    } else {
      dom.viewToggleContainerEl.classList.add('hidden');
    }

    if (newStage === 2) {
      dom.surfaceButtonsEl.classList.remove('hidden');
      dom.viewToggleEl.checked = false;
      setViewMode('camera');
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

    if (enteringStage4 && mapSessions.length > 0) {
      var startIndex = 0;
      for (var si = 0; si < mapSessions.length; si++) {
        if (parseInt(mapSessions[si] && mapSessions[si].id, 10) === 1) {
          startIndex = si;
          break;
        }
      }
      activateMapSession(startIndex);
    }
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
    if (state.stage !== 2 && state.stage !== 3) return;
    setViewMode(dom.viewToggleEl.checked ? 'map' : 'camera');
  }

  function setViewMode(mode) {
    if (state.stage === 4 && mode !== 'map') {
      mode = 'map';
      dom.viewToggleEl.checked = true;
    }
    if (vgaModeActive && mode !== 'map') {
      setVgaMode(false);
    }
    state.viewMode = mode === 'map' ? 'map' : 'camera';

    if (state.viewMode === 'map') {
      document.body.classList.add('map-view-active');
      setBackendFeedActive(false);
      dom.mapViewEl.classList.remove('hidden');
      dom.mapViewEl.setAttribute('aria-hidden', 'false');
      dom.viewToggleContainerEl.classList.add('toggle-floating');
      initMaptasticIfNeeded();
      initLeafletIfNeeded();
      ensureVgaMapClickBinding();
      updateRoadLayersVisibilityByTags();
      updateUiSetupPanelVisibility();
      updateEdgeGuidesVisibility();
      updateGestureControlsVisibility();
      updateTrackingOffsetControlsVisibility();
      updateToolTagControlsVisibility();
      updateHamburgerMenuVisibility();
      if (state.map) state.map.resize();
      setStage4DrawMode(state.stage4DrawMode);
      updateStage4MapInteractivity();
      updateStickerMappingForCurrentView();
    } else {
      if (state.apriltagPrimaryOffsetCalibActive) {
        stopPrimaryOffset9PointCalibration();
      }
      document.body.classList.remove('map-view-active');
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

    updateStage3WorkspaceVisibility();
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
    updatePrimaryOffsetCalibrationStatus();
    updateStage3WorkspaceVisibility();
  }

  function updateToolTagControlsVisibility() {
    var visible = state.stage === 3 && state.viewMode === 'map' && !vgaModeActive;
    dom.toolTagControlsEl.classList.toggle('hidden', !visible);
    dom.toolTagControlsEl.setAttribute('aria-hidden', visible ? 'false' : 'true');
    updateStage3WorkspaceVisibility();
  }

  function updateStage3WorkspaceVisibility() {
    if (!dom.stage3WorkspacePanelEl) return;
    var visible = state.stage === 3 && state.viewMode === 'map' && !vgaModeActive;
    dom.stage3WorkspacePanelEl.classList.toggle('hidden', !visible);
    dom.stage3WorkspacePanelEl.setAttribute('aria-hidden', visible ? 'false' : 'true');
    if (dom.stage3ActionBarEl) {
      dom.stage3ActionBarEl.setAttribute('aria-hidden', visible ? 'false' : 'true');
    }
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

  function parseRetryAfterMs(retryAfterRaw, nowMs) {
    if (!retryAfterRaw) return 0;
    var text = String(retryAfterRaw).trim();
    if (!text) return 0;
    var seconds = Number(text);
    if (isFinite(seconds) && seconds > 0) return Math.round(seconds * 1000);
    var dateMs = Date.parse(text);
    if (!isFinite(dateMs)) return 0;
    return Math.max(0, dateMs - nowMs);
  }

  function applyApriltagPollBackoff(nowMs, retryAfterRaw, reason) {
    var retryAfterMs = parseRetryAfterMs(retryAfterRaw, nowMs);
    if (retryAfterMs > 0) {
      apriltagPollBackoffMs = Math.min(BACKEND_APRILTAG_POLL_BACKOFF_MAX_MS, retryAfterMs);
    } else {
      apriltagPollBackoffMs = apriltagPollBackoffMs > 0
        ? Math.min(BACKEND_APRILTAG_POLL_BACKOFF_MAX_MS, apriltagPollBackoffMs * 2)
        : BACKEND_APRILTAG_POLL_BACKOFF_BASE_MS;
    }
    apriltagPollBlockedUntilMs = nowMs + apriltagPollBackoffMs;
    if (!apriltagBackoffNotified) {
      console.warn('AprilTag API temporary failure (' + reason + '), backing off for', apriltagPollBackoffMs, 'ms');
      apriltagBackoffNotified = true;
    }
  }

  function applyApriltagPayload(payload, source) {
    if (!payload || !Array.isArray(payload.detections)) return;

    if (source === 'stream') {
      var seq = parseInt(payload.seq, 10);
      if (isFinite(seq)) {
        if (seq <= apriltagLastStreamSeq) return;
        apriltagLastStreamSeq = seq;
      }
    }

    state.lastApriltagDetections = payload.detections;

    // Populate touch info from backend 6DoF pose estimation.
    // Only overwrite when the backend actually provides isTouch data;
    // otherwise leave state.apriltagTouchById intact so the frontend
    // homography-based fallback (updateApriltagTouchByIdFromSize) is not clobbered.
    var has6DoFTouch = false;
    for (var di = 0; di < payload.detections.length; di++) {
      var det = payload.detections[di];
      if (typeof det.isTouch === 'boolean') {
        has6DoFTouch = true;
        break;
      }
    }
    if (has6DoFTouch) {
      var touchById = {};
      for (var di2 = 0; di2 < payload.detections.length; di2++) {
        var det2 = payload.detections[di2];
        if (typeof det2.isTouch === 'boolean') {
          touchById[det2.id] = { isTouch: det2.isTouch, surfaceDistance: det2.surfaceDistance || 0 };
        }
      }
      state.apriltagTouchById = touchById;
    }

    var remoteToolByTriggerTagId = {};
    var remoteNoteStateByTriggerTagId = {};
    if (payload.controller && payload.controller.activeToolByTriggerTagId && typeof payload.controller.activeToolByTriggerTagId === 'object') {
      for (var rawTriggerTagId in payload.controller.activeToolByTriggerTagId) {
        var parsedTriggerTagId = parseInt(rawTriggerTagId, 10);
        if (!isFinite(parsedTriggerTagId)) continue;
        if (parsedTriggerTagId < 1 || parsedTriggerTagId > 9999) continue;
        var toolType = String(payload.controller.activeToolByTriggerTagId[rawTriggerTagId] || '').trim().toLowerCase();
        if (!(toolType === 'draw' || toolType === 'eraser' || toolType === 'selection' || toolType === 'note')) continue;
        remoteToolByTriggerTagId[String(parsedTriggerTagId)] = toolType;
      }
    }
    if (payload.controller && payload.controller.remoteNoteStateByTriggerTagId && typeof payload.controller.remoteNoteStateByTriggerTagId === 'object') {
      for (var rawNoteTriggerTagId in payload.controller.remoteNoteStateByTriggerTagId) {
        var parsedNoteTriggerTagId = parseInt(rawNoteTriggerTagId, 10);
        if (!isFinite(parsedNoteTriggerTagId)) continue;
        if (parsedNoteTriggerTagId < 1 || parsedNoteTriggerTagId > 9999) continue;
        var notePayload = payload.controller.remoteNoteStateByTriggerTagId[rawNoteTriggerTagId];
        if (!notePayload || typeof notePayload !== 'object') continue;
        var noteText = String(notePayload.text || '');
        if (noteText.length > 500) noteText = noteText.slice(0, 500);
        var noteSessionActive = !!notePayload.sessionActive;
        var noteFinalizeTick = parseInt(notePayload.finalizeTick, 10);
        if (!isFinite(noteFinalizeTick) || noteFinalizeTick < 0) noteFinalizeTick = 0;
        remoteNoteStateByTriggerTagId[String(parsedNoteTriggerTagId)] = {
          text: noteText,
          sessionActive: noteSessionActive,
          finalizeTick: noteFinalizeTick
        };
      }
    }
    if (payload.controller && Array.isArray(payload.controller.activeDrawTriggerTagIds)) {
      for (var ci = 0; ci < payload.controller.activeDrawTriggerTagIds.length; ci++) {
        var fallbackTriggerTagId = parseInt(payload.controller.activeDrawTriggerTagIds[ci], 10);
        if (!isFinite(fallbackTriggerTagId)) continue;
        if (fallbackTriggerTagId < 1 || fallbackTriggerTagId > 9999) continue;
        if (!remoteToolByTriggerTagId[String(fallbackTriggerTagId)]) {
          remoteToolByTriggerTagId[String(fallbackTriggerTagId)] = 'draw';
        }
      }
    }
    state.remoteControllerToolByTriggerTagId = remoteToolByTriggerTagId;
    state.remoteControllerNoteStateByTriggerTagId = remoteNoteStateByTriggerTagId;
    var remoteDrawTriggerTagIds = [];
    for (var remoteTriggerTagId in remoteToolByTriggerTagId) {
      if (remoteToolByTriggerTagId[remoteTriggerTagId] !== 'draw') continue;
      remoteDrawTriggerTagIds.push(parseInt(remoteTriggerTagId, 10));
    }
    state.remoteControllerDrawTriggerTagIds = remoteDrawTriggerTagIds;

    // Extract per-trigger color from controller
    var remoteColorByTriggerTagId = {};
    if (payload.controller && payload.controller.colorByTriggerTagId && typeof payload.controller.colorByTriggerTagId === 'object') {
      for (var rawColorTriggerTagId in payload.controller.colorByTriggerTagId) {
        var parsedColorTriggerTagId = parseInt(rawColorTriggerTagId, 10);
        if (!isFinite(parsedColorTriggerTagId) || parsedColorTriggerTagId < 1 || parsedColorTriggerTagId > 9999) continue;
        var remoteColorVal = String(payload.controller.colorByTriggerTagId[rawColorTriggerTagId] || '').trim().toLowerCase();
        if (remoteColorVal) remoteColorByTriggerTagId[String(parsedColorTriggerTagId)] = remoteColorVal;
      }
    }
    state.remoteControllerColorByTriggerTagId = remoteColorByTriggerTagId;
    apriltagPollBackoffMs = 0;
    apriltagPollBlockedUntilMs = 0;
    apriltagBackoffNotified = false;

    if (payload.ok) {
      apriltagBackendErrorNotified = false;
    } else if (payload.error && !apriltagBackendErrorNotified) {
      setError('AprilTag backend error: ' + payload.error);
      apriltagBackendErrorNotified = true;
    }
  }

  function clearApriltagStreamReconnectTimer() {
    if (!apriltagStreamReconnectTimerId) return;
    clearTimeout(apriltagStreamReconnectTimerId);
    apriltagStreamReconnectTimerId = 0;
  }

  function closeApriltagStream(options) {
    options = options || {};
    clearApriltagStreamReconnectTimer();

    if (apriltagEventSource) {
      apriltagEventSource.onopen = null;
      apriltagEventSource.onmessage = null;
      apriltagEventSource.onerror = null;
      try { apriltagEventSource.close(); } catch (e) { /* ignore */ }
      apriltagEventSource = null;
    }

    apriltagStreamState = 'idle';
    apriltagStreamBackoffNotified = false;
    apriltagLastStreamSeq = -1;
    if (!options.keepReconnectBackoff) {
      apriltagStreamReconnectMs = 0;
    }
  }

  function scheduleApriltagStreamReconnect() {
    if (typeof EventSource === 'undefined') return;
    if (!state.cameraReady || !state.usingIpCamera) return;

    clearApriltagStreamReconnectTimer();
    apriltagStreamReconnectMs = apriltagStreamReconnectMs > 0
      ? Math.min(BACKEND_APRILTAG_STREAM_RECONNECT_MAX_MS, apriltagStreamReconnectMs * 2)
      : BACKEND_APRILTAG_STREAM_RECONNECT_BASE_MS;
    apriltagStreamState = 'backoff';

    var delayMs = apriltagStreamReconnectMs;
    apriltagStreamReconnectTimerId = setTimeout(function() {
      apriltagStreamReconnectTimerId = 0;
      connectApriltagStream();
    }, delayMs);
  }

  function connectApriltagStream() {
    if (typeof EventSource === 'undefined') return;
    if (!state.cameraReady || !state.usingIpCamera) return;
    if (apriltagEventSource || apriltagStreamState === 'open' || apriltagStreamState === 'connecting') return;

    clearApriltagStreamReconnectTimer();
    apriltagStreamState = 'connecting';
    var sep = BACKEND_APRILTAG_STREAM_URL.indexOf('?') === -1 ? '?' : '&';
    var streamUrl = BACKEND_APRILTAG_STREAM_URL + sep + 't=' + Date.now();
    var source = null;

    try {
      source = new EventSource(streamUrl);
    } catch (err) {
      console.warn('Failed to open AprilTag stream, falling back to polling:', err);
      scheduleApriltagStreamReconnect();
      return;
    }

    apriltagEventSource = source;

    source.onopen = function() {
      if (apriltagEventSource !== source) return;
      apriltagStreamState = 'open';
      apriltagStreamReconnectMs = 0;
      apriltagStreamBackoffNotified = false;
      apriltagBackoffNotified = false;
      apriltagPollBackoffMs = 0;
      apriltagPollBlockedUntilMs = 0;
    };

    source.onmessage = function(event) {
      if (apriltagEventSource !== source) return;
      if (!event || typeof event.data !== 'string' || !event.data) return;
      try {
        var payload = JSON.parse(event.data);
        applyApriltagPayload(payload, 'stream');
      } catch (err) {
        console.warn('Failed to parse AprilTag stream payload:', err);
      }
    };

    source.onerror = function() {
      if (apriltagEventSource !== source) return;
      closeApriltagStream({ keepReconnectBackoff: true });

      if (!state.cameraReady || !state.usingIpCamera) return;
      if (!apriltagStreamBackoffNotified) {
        console.warn('AprilTag stream disconnected; temporarily falling back to polling.');
        apriltagStreamBackoffNotified = true;
      }
      scheduleApriltagStreamReconnect();
    };
  }

  function pollBackendApriltagsMaybe() {
    if (apriltagStreamState === 'open') return;
    if (apriltagPollInFlight) return;
    var now = Date.now();
    if (apriltagPollBlockedUntilMs > now) return;
    var pollMs = state.viewMode === 'map' ? BACKEND_APRILTAG_POLL_MAP_MS : BACKEND_APRILTAG_POLL_CAMERA_MS;
    if ((now - apriltagLastPollMs) < pollMs) return;
    apriltagLastPollMs = now;
    apriltagPollInFlight = true;

    fetch(BACKEND_APRILTAG_API_URL, { cache: 'no-store' }).then(function(resp) {
      if (resp.status === 429 || resp.status === 408 || resp.status >= 500) {
        applyApriltagPollBackoff(Date.now(), resp.headers ? resp.headers.get('Retry-After') : '', 'HTTP ' + resp.status);
        return null;
      }
      if (!resp.ok) {
        applyApriltagPollBackoff(Date.now(), resp.headers ? resp.headers.get('Retry-After') : '', 'HTTP ' + resp.status);
        var httpErr = new Error('HTTP ' + resp.status);
        httpErr.apriltagBackoffApplied = true;
        throw httpErr;
      }
      return resp.json();
    }).then(function(payload) {
      if (!payload) return;
      applyApriltagPayload(payload, 'poll');
    }).catch(function(err) {
      if (!err || !err.apriltagBackoffApplied) {
        applyApriltagPollBackoff(Date.now(), '', 'network');
      }
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
    resetBlackoutPulseState();
    closeApriltagStream();
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
      closeApriltagStream();
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
    apriltagPollBackoffMs = 0;
    apriltagPollBlockedUntilMs = 0;
    apriltagBackendErrorNotified = false;
    apriltagBackoffNotified = false;
    apriltagStreamReconnectMs = 0;
    apriltagStreamBackoffNotified = false;
    apriltagLastStreamSeq = -1;
    connectApriltagStream();
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
    closeApriltagStream();
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
    resetBlackoutPulseState();
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

  function getApriltagTrackingPoint(det) {
    if (det && det.center && isFinite(det.center.x) && isFinite(det.center.y)) {
      return { x: det.center.x, y: det.center.y };
    }
    return getApriltagCenter(det);
  }

  function computeApriltagQuadAreaPx(corners) {
    if (!Array.isArray(corners) || corners.length < 4) return NaN;
    var area2 = 0;
    for (var i = 0; i < 4; i++) {
      var p1 = corners[i];
      var p2 = corners[(i + 1) % 4];
      if (!p1 || !p2) return NaN;
      area2 += (p1.x * p2.y) - (p2.x * p1.y);
    }
    return Math.abs(area2) * 0.5;
  }

  function cloneApriltagCornersPx(corners) {
    if (!Array.isArray(corners) || corners.length < 4) return null;
    var out = [];
    for (var i = 0; i < 4; i++) {
      var c = corners[i];
      if (!c || !isFinite(c.x) || !isFinite(c.y)) return null;
      out.push({ x: c.x, y: c.y });
    }
    return out;
  }

  function pickApriltagCornerForSurfaceCorner(corners, surfaceCornerIndex) {
    if (!Array.isArray(corners) || corners.length < 4) return null;
    if (typeof surfaceCornerIndex !== 'number' || surfaceCornerIndex < 0 || surfaceCornerIndex > 3) return null;

    // Surface corners are ordered as:
    // 0: top-left, 1: top-right, 2: bottom-right, 3: bottom-left
    var dirs = [
      { x: -1, y: -1 },
      { x: 1, y: -1 },
      { x: 1, y: 1 },
      { x: -1, y: 1 }
    ];
    var dir = dirs[surfaceCornerIndex];

    var best = null;
    var bestScore = -Infinity;
    for (var i = 0; i < 4; i++) {
      var c = corners[i];
      if (!c) continue;
      var score = c.x * dir.x + c.y * dir.y;
      if (score > bestScore) { bestScore = score; best = c; }
    }
    return best ? { x: best.x, y: best.y } : null;
  }

  // Capture on-surface tag corner pixels for touch calibration.
  // Tags 1-4 are placed on the surface during calibration, so their pixel
  // corners represent the "touching" reference size.
  function captureApriltagTouchCalibSamples(detections) {
    if (!detections) return;
    var sampleCorners = [null, null, null, null];
    var sampleAreas = [null, null, null, null];
    for (var i = 0; i < 4; i++) {
      var tagId = i + 1; // tags 1-4 correspond to corners 0-3
      var det = getApriltagDetectionById(detections, tagId);
      if (!det || !Array.isArray(det.corners) || det.corners.length < 4) continue;
      var cornersCopy = [];
      for (var k = 0; k < 4; k++) {
        var c = det.corners[k];
        cornersCopy.push(c ? { x: c.x, y: c.y } : null);
      }
      sampleCorners[i] = cornersCopy;
      sampleAreas[i] = computeApriltagQuadAreaPx(det.corners);
    }
    state.apriltagTouchCalibCornerSampleCornersPx = sampleCorners;
    state.apriltagTouchCalibCornerAreaPx = sampleAreas;
    // Reset derived UV sizes so they are recomputed with the new samples
    state.apriltagTouchCalibCornerUvSideLen = [null, null, null, null];
  }

  function areApriltagTouchCalibAreasReady() {
    var a = state.apriltagTouchCalibCornerAreaPx;
    if (!a || a.length !== 4) return false;
    for (var i = 0; i < 4; i++) {
      if (!isFinite(a[i]) || a[i] <= 0) return false;
    }
    return true;
  }

  function computeMeanQuadSideLen(points) {
    if (!Array.isArray(points) || points.length < 4) return NaN;
    var sum = 0;
    for (var i = 0; i < 4; i++) {
      var p1 = points[i];
      var p2 = points[(i + 1) % 4];
      if (!p1 || !p2 || !isFinite(p1.x) || !isFinite(p1.y) || !isFinite(p2.x) || !isFinite(p2.y)) return NaN;
      var dx = p1.x - p2.x;
      var dy = p1.y - p2.y;
      sum += Math.sqrt(dx * dx + dy * dy);
    }
    return sum / 4;
  }

  function areApriltagTouchCalibUvSizesReady() {
    var a = state.apriltagTouchCalibCornerUvSideLen;
    if (!a || a.length !== 4) return false;
    for (var i = 0; i < 4; i++) {
      if (!isFinite(a[i]) || a[i] <= 0) return false;
    }
    return true;
  }

  function maybeUpdateApriltagTouchCalibUvSizes() {
    if (!state.surfaceHomography) return;
    if (areApriltagTouchCalibUvSizesReady()) return;
    var samples = state.apriltagTouchCalibCornerSampleCornersPx;
    if (!samples || samples.length !== 4) return;

    if (!state.apriltagTouchCalibCornerUvSideLen || state.apriltagTouchCalibCornerUvSideLen.length !== 4) {
      state.apriltagTouchCalibCornerUvSideLen = [null, null, null, null];
    }

    for (var i = 0; i < 4; i++) {
      if (isFinite(state.apriltagTouchCalibCornerUvSideLen[i]) && state.apriltagTouchCalibCornerUvSideLen[i] > 0) continue;
      var cornersPx = samples[i];
      if (!Array.isArray(cornersPx) || cornersPx.length < 4) continue;
      var uvCorners = [];
      for (var k = 0; k < 4; k++) {
        var c = cornersPx[k];
        var mapped = c ? applyHomography(state.surfaceHomography, c.x, c.y) : null;
        uvCorners.push(mapped);
      }
      var sideLen = computeMeanQuadSideLen(uvCorners);
      if (isFinite(sideLen) && sideLen > 0) state.apriltagTouchCalibCornerUvSideLen[i] = sideLen;
    }
  }

  function getExpectedApriltagUvSideLenAtUv(uv) {
    if (!uv || !isFinite(uv.x) || !isFinite(uv.y)) return null;
    maybeUpdateApriltagTouchCalibUvSizes();
    if (!areApriltagTouchCalibUvSizesReady()) return null;

    var a = state.apriltagTouchCalibCornerUvSideLen;
    var u = uv.x; var v = uv.y;
    if (u < 0) u = 0; else if (u > 1) u = 1;
    if (v < 0) v = 0; else if (v > 1) v = 1;

    // Bilinear interpolation over the surface:
    // a[0]=TL, a[1]=TR, a[2]=BR, a[3]=BL
    var top = a[0] + (a[1] - a[0]) * u;
    var bottom = a[3] + (a[2] - a[3]) * u;
    var expected = top + (bottom - top) * v;
    return (isFinite(expected) && expected > 0) ? expected : null;
  }

  function getExpectedApriltagAreaPxAtUv(uv) {
    if (!uv || !isFinite(uv.x) || !isFinite(uv.y)) return null;
    if (!areApriltagTouchCalibAreasReady()) return null;

    var a = state.apriltagTouchCalibCornerAreaPx;
    var u = uv.x; var v = uv.y;
    if (u < 0) u = 0; else if (u > 1) u = 1;
    if (v < 0) v = 0; else if (v > 1) v = 1;

    // Bilinear interpolation over the surface:
    // a[0]=TL, a[1]=TR, a[2]=BR, a[3]=BL
    var top = a[0] + (a[1] - a[0]) * u;
    var bottom = a[3] + (a[2] - a[3]) * u;
    var expected = top + (bottom - top) * v;
    return (isFinite(expected) && expected > 0) ? expected : null;
  }

  function computeUvQuadSquareError(uvCorners) {
    if (!Array.isArray(uvCorners) || uvCorners.length < 4) return NaN;
    for (var i = 0; i < 4; i++) {
      var p = uvCorners[i];
      if (!p || !isFinite(p.x) || !isFinite(p.y)) return NaN;
    }

    function dist(a, b) {
      var dx = a.x - b.x;
      var dy = a.y - b.y;
      return Math.sqrt(dx * dx + dy * dy);
    }

    var p0 = uvCorners[0], p1 = uvCorners[1], p2 = uvCorners[2], p3 = uvCorners[3];
    var s0 = dist(p0, p1);
    var s1 = dist(p1, p2);
    var s2 = dist(p2, p3);
    var s3 = dist(p3, p0);
    var minS = Math.min(s0, s1, s2, s3);
    var maxS = Math.max(s0, s1, s2, s3);
    if (!minS || !isFinite(minS) || !isFinite(maxS)) return NaN;
    var sideRatio = (maxS / minS) - 1;

    var d0 = dist(p0, p2);
    var d1 = dist(p1, p3);
    var minD = Math.min(d0, d1);
    var maxD = Math.max(d0, d1);
    if (!minD || !isFinite(minD) || !isFinite(maxD)) return NaN;
    var diagRatio = (maxD / minD) - 1;

    var maxAbsCos = 0;
    for (var vi = 0; vi < 4; vi++) {
      var prev = uvCorners[(vi + 3) % 4];
      var cur = uvCorners[vi];
      var next = uvCorners[(vi + 1) % 4];
      var v1x = prev.x - cur.x;
      var v1y = prev.y - cur.y;
      var v2x = next.x - cur.x;
      var v2y = next.y - cur.y;
      var n1 = Math.sqrt(v1x * v1x + v1y * v1y);
      var n2 = Math.sqrt(v2x * v2x + v2y * v2y);
      if (!n1 || !n2) return NaN;
      var cos = (v1x * v2x + v1y * v2y) / (n1 * n2);
      if (!isFinite(cos)) return NaN;
      var absCos = Math.abs(cos);
      if (absCos > maxAbsCos) maxAbsCos = absCos;
    }

    return Math.max(sideRatio, diagRatio, maxAbsCos);
  }

  function updateApriltagTouchByIdFromSize(nowMs, detections, detectionById) {
    if (!state.surfaceHomography) return;
    maybeUpdateApriltagTouchCalibUvSizes();
    if (!areApriltagTouchCalibUvSizesReady()) {
      // Don't block interactions until calibration is complete;
      // leave any existing touch state (e.g. from 6DoF backend) intact.
      return;
    }

    var hoverSideRatio = parseFloat(state.apriltagTouchHoverUvSideRatio);
    var touchSideRatio = parseFloat(state.apriltagTouchTouchUvSideRatio);
    var maxUvSquareError = parseFloat(state.apriltagTouchMaxUvSquareError);

    if (!isFinite(hoverSideRatio) || hoverSideRatio <= 1) hoverSideRatio = 1.12;
    if (!isFinite(touchSideRatio) || touchSideRatio <= 1 || touchSideRatio > hoverSideRatio) touchSideRatio = Math.min(hoverSideRatio, 1.06);
    if (!isFinite(maxUvSquareError) || maxUvSquareError < 0) maxUvSquareError = 0.1;

    if (!state.apriltagTouchById || typeof state.apriltagTouchById !== 'object') {
      state.apriltagTouchById = {};
    }

    for (var idStr in detectionById) {
      if (!Object.prototype.hasOwnProperty.call(detectionById, idStr)) continue;
      var tagId = parseInt(idStr, 10);
      if (!isFinite(tagId)) continue;
      var det = detectionById[idStr];
      if (!det || !Array.isArray(det.corners) || det.corners.length < 4) continue;

      var center = det.center && isFinite(det.center.x) && isFinite(det.center.y) ? det.center : getApriltagCenter(det);
      if (!center) continue;

      var uv = applyHomography(state.surfaceHomography, center.x, center.y);
      var expectedUvSideLen = getExpectedApriltagUvSideLenAtUv(uv);
      if (!expectedUvSideLen) continue;

      var uvCorners = [];
      for (var k = 0; k < 4; k++) {
        var c = det.corners[k];
        uvCorners.push(c ? applyHomography(state.surfaceHomography, c.x, c.y) : null);
      }
      var observedUvSideLen = computeMeanQuadSideLen(uvCorners);
      if (!isFinite(observedUvSideLen) || observedUvSideLen <= 0) continue;

      var uvSideRatio = observedUvSideLen / expectedUvSideLen;
      if (!isFinite(uvSideRatio)) continue;

      var observedAreaPx = computeApriltagQuadAreaPx(det.corners);

      // Distortion in surface UV space; high values indicate tilt/off-plane.
      var uvSquareError = computeUvQuadSquareError(uvCorners);

      var info = state.apriltagTouchById[tagId];
      if (!info || typeof info !== 'object') info = state.apriltagTouchById[tagId] = {};

      if (typeof info.isTouch !== 'boolean') info.isTouch = true;
      if (!isFinite(info.baselineUvSquareError)) info.baselineUvSquareError = NaN;

      // Instant touch/hover with hysteresis:
      // - Strong UV skew => hovering (tilt/off-plane)
      // - Larger-than-expected UV size => hovering (closer to camera)
      // - Smaller => touching
      // - Between => keep previous value to avoid flicker
      if (maxUvSquareError > 0 && isFinite(uvSquareError) && uvSquareError > maxUvSquareError) {
        info.isTouch = false;
      }
      else if (uvSideRatio > hoverSideRatio) {
        info.isTouch = false;
      }
      else if (uvSideRatio < touchSideRatio) {
        info.isTouch = true;
      }

      // Learn a baseline UV "squareness" when the tag is touching, then treat
      // increased distortion as tilt/off-plane. This avoids overly strict
      // absolute thresholds that can disable drawing entirely.
      if (info.isTouch && isFinite(uvSquareError)) {
        if (!isFinite(info.baselineUvSquareError)) {
          info.baselineUvSquareError = uvSquareError;
        } else {
          info.baselineUvSquareError = info.baselineUvSquareError * 0.9 + uvSquareError * 0.1;
        }
      }
      if (maxUvSquareError > 0 && info.isTouch && isFinite(uvSquareError) && isFinite(info.baselineUvSquareError)) {
        if ((uvSquareError - info.baselineUvSquareError) > maxUvSquareError) {
          info.isTouch = false;
        }
      }

      // Touch diagnostics
      info.lastSeenMs = nowMs;
      info.observedAreaPx = observedAreaPx;
      info.uv = uv;
      info.uvSquareError = uvSquareError;
      info.expectedUvSideLen = expectedUvSideLen;
      info.observedUvSideLen = observedUvSideLen;
      info.uvSideRatio = uvSideRatio;
    }

    // Cleanup stale entries to avoid unbounded growth
    var ttlMs = 5000;
    for (var key in state.apriltagTouchById) {
      if (!Object.prototype.hasOwnProperty.call(state.apriltagTouchById, key)) continue;
      var entry = state.apriltagTouchById[key];
      if (!entry || !isFinite(entry.lastSeenMs) || (nowMs - entry.lastSeenMs) > ttlMs) {
        delete state.apriltagTouchById[key];
      }
    }
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

    // Capture tag corner pixels for touch calibration (tags are on surface now)
    captureApriltagTouchCalibSamples(state.lastApriltagDetections);

    // Flash all corner buttons to indicate success
    for (var i = 0; i < 4; i++) {
      flashCornerButton(i);
    }

    setError('');
  }

  // --- Surface plane calibration (6DoF touch detection) ---
  var surfacePlaneCollecting = false;
  var surfacePlaneDone = false;
  var surfacePlanePoints = [];
  var surfacePlaneCollectedPixels = [];  // 2D pixel positions for overlay visualization
  var surfacePlaneCollectInterval = null;
  var SURFACE_PLANE_COLLECT_MS = 500; // sample every 500ms
  var SURFACE_PLANE_MIN_POINTS = 3;

  function toggleSurfacePlaneCollection() {
    if (surfacePlaneCollecting) {
      stopSurfacePlaneCollection();
    } else {
      startSurfacePlaneCollection();
    }
  }

  function startSurfacePlaneCollection() {
    surfacePlaneCollecting = true;
    surfacePlaneDone = false;
    surfacePlanePoints = [];
    surfacePlaneCollectedPixels = [];
    dom.surfacePlaneBtn.classList.add('collecting');
    dom.surfacePlaneBtn.textContent = '0 pts';
    setError('Move tag slowly along the dashed path. Click "Plane" again when done.');

    surfacePlaneCollectInterval = setInterval(function() {
      if (!state.lastApriltagDetections) return;
      for (var i = 0; i < state.lastApriltagDetections.length; i++) {
        var det = state.lastApriltagDetections[i];
        if (det.pose && typeof det.pose.x === 'number') {
          surfacePlanePoints.push({ x: det.pose.x, y: det.pose.y, z: det.pose.z });
          // Also store the 2D pixel center for overlay dots
          if (det.center) {
            surfacePlaneCollectedPixels.push({ x: det.center.x, y: det.center.y });
          }
        }
      }
      dom.surfacePlaneBtn.textContent = surfacePlanePoints.length + ' pts';
    }, SURFACE_PLANE_COLLECT_MS);
  }

  function stopSurfacePlaneCollection() {
    surfacePlaneCollecting = false;
    clearInterval(surfacePlaneCollectInterval);
    surfacePlaneCollectInterval = null;
    dom.surfacePlaneBtn.classList.remove('collecting');
    dom.surfacePlaneBtn.textContent = 'Plane';

    if (surfacePlanePoints.length < SURFACE_PLANE_MIN_POINTS) {
      setError('Need at least ' + SURFACE_PLANE_MIN_POINTS + ' points. Got ' + surfacePlanePoints.length + '. Make sure pose data is available (camera calibration required).');
      return;
    }

    fetch('/api/surface_plane', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ points: surfacePlanePoints })
    }).then(function(resp) { return resp.json(); })
      .then(function(data) {
        if (data.ok) {
          setError('');
          surfacePlaneDone = true;
          console.log('Surface plane calibrated with ' + surfacePlanePoints.length + ' points:', data.plane);
          dom.surfacePlaneBtn.textContent = 'Plane ✓';
        } else {
          setError('Surface plane calibration failed: ' + (data.error || 'unknown'));
        }
      }).catch(function(err) {
        setError('Surface plane calibration request failed: ' + err);
      });
  }

  function processFrame() {
    if (!state.isProcessing) return;

    var nowMs = performance.now();
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

    // Surface-corner capture preview
    var surfacePreviewPoint = null;

    // Draw calibration overlays
    if (isSurfaceSetupCameraView) {
      drawSurface(state.overlayCtx, state.surfaceCorners, {
        previewIndex: state.armedCornerIndex,
        previewPoint: state.armedCornerIndex !== null ? surfacePreviewPoint : null
      });

      // Draw plane calibration guide path when all 4 corners are set
      var allCornersSet = state.surfaceCorners && state.surfaceCorners.length === 4 &&
        state.surfaceCorners[0] && state.surfaceCorners[1] && state.surfaceCorners[2] && state.surfaceCorners[3];
      if (allCornersSet && (surfacePlaneCollecting || !surfacePlaneDone)) {
        drawPlaneCalibrationGuide(state.overlayCtx, state.surfaceCorners, {
          collecting: surfacePlaneCollecting,
          collectedPoints: surfacePlaneCollectedPixels
        });
      }
    }

    // Map view (Stage 2, 3, and 4)
    var isMapViewWithHomography = (state.stage === 2 || state.stage === 3 || state.stage === 4) && state.viewMode === 'map';
    var detections = Array.isArray(state.lastApriltagDetections) ? state.lastApriltagDetections : [];
    var detectionById = {};
    for (var di = 0; di < detections.length; di++) {
      var det = detections[di];
      if (!det) continue;
      var detId = typeof det.id === 'number' ? det.id : parseInt(det.id, 10);
      if (!isFinite(detId)) continue;
      detectionById[detId] = det;
    }

    updateApriltagTouchByIdFromSize(nowMs, detections, detectionById);

    // Gesture handling (dwell-to-click and pinch-to-drag for Stage 3 and 4)
    if ((state.stage === 3 || state.stage === 4) && state.viewMode === 'map' && !vgaModeActive) {
      var apriltagPoints = [];
      var apriltagTriggerPoints = [];
      var viewRect = dom.mapViewEl.getBoundingClientRect();
      var mapW = dom.mapViewEl.offsetWidth;
      var mapH = dom.mapViewEl.offsetHeight;
      var canProjectToMap = !!state.surfaceHomography && mapW > 0 && mapH > 0;
      var maxExtrapolation = 1.5;

      function projectTagDetectionToMap(detByTag, tagId, offsetMode) {
        if (!detByTag || !canProjectToMap) return null;
        var sourcePoint = getApriltagTrackingPoint(detByTag);
        if (!sourcePoint) return null;
        var uv = applyHomography(state.surfaceHomography, sourcePoint.x, sourcePoint.y);
        if (!uv || uv.x < -maxExtrapolation || uv.x > 1 + maxExtrapolation || uv.y < -maxExtrapolation || uv.y > 1 + maxExtrapolation) {
          return null;
        }

        var x = viewRect.left + uv.x * mapW;
        var y = viewRect.top + uv.y * mapH;
        return applyTrackedTagOffset(detByTag, tagId, x, y, mapW, mapH, offsetMode, uv);
      }

      if (Array.isArray(state.stage3ParticipantTagIds)) {
        for (var t = 0; t < state.stage3ParticipantTagIds.length; t++) {
          var primaryTagId = parseInt(state.stage3ParticipantTagIds[t], 10);
          var triggerTagId = Array.isArray(state.stage3ParticipantTriggerTagIds) ? parseInt(state.stage3ParticipantTriggerTagIds[t], 10) : NaN;

          if (isFinite(primaryTagId)) {
            var primaryDet = detectionById[primaryTagId];
            if (primaryDet && primaryDet.center) {
              var touchInfo = state.apriltagTouchById && state.apriltagTouchById[primaryTagId] ? state.apriltagTouchById[primaryTagId] : null;
              var point = {
                handId: String(primaryTagId),
                isApriltag: true,
                tagId: primaryTagId,
                isTouch: touchInfo ? !!touchInfo.isTouch : null
              };

              var projectedPrimaryCenter = projectTagDetectionToMap(primaryDet, primaryTagId, null);
              if (projectedPrimaryCenter) {
                point.primaryCenterX = projectedPrimaryCenter.x;
                point.primaryCenterY = projectedPrimaryCenter.y;
              }

              var projectedPrimary = projectTagDetectionToMap(primaryDet, primaryTagId, 'primary');
              if (projectedPrimary) {
                point.x = projectedPrimary.x;
                point.y = projectedPrimary.y;
              }
              apriltagPoints.push(point);
            }
          }

          if (isFinite(primaryTagId) && isFinite(triggerTagId)) {
            var triggerDet = detectionById[triggerTagId];
            var projectedTrigger = projectTagDetectionToMap(triggerDet, triggerTagId, 'trigger');
            if (projectedTrigger) {
              apriltagTriggerPoints.push({
                handId: String(primaryTagId),
                triggerTagId: triggerTagId,
                x: projectedTrigger.x,
                y: projectedTrigger.y
              });
            }
          }
        }
      }

      var shouldPulseBlackout = shouldPulseBlackoutForApriltagState(apriltagTriggerPoints, detectionById);
      updateBlackoutPulse(shouldPulseBlackout, nowMs);

      var layerNavVoteState = updateApriltagTriggerSelections(apriltagTriggerPoints, apriltagPoints);
      processLayerNavigationVotes(layerNavVoteState);
      processLayerPanVotes(layerNavVoteState, apriltagPoints);
      processLayerZoomVotes(layerNavVoteState, apriltagPoints);
      processPinchZoomTags(detectionById);
      processPanTag(detectionById);
      processNavTags(detectionById);
      applyRemoteApriltagToolOverrides(state.remoteControllerToolByTriggerTagId);
      applyRemoteApriltagNoteStateOverrides(state.remoteControllerNoteStateByTriggerTagId);
      handleStage3Gestures(apriltagPoints);
    } else {
      updateBlackoutPulse(false, nowMs);
      processLayerNavigationVotes(null);
      processLayerPanVotes(null, null);
      processLayerZoomVotes(null, null);
      resetPinchZoomRuntime();
      resetPanTagDedicatedRuntime();
      resetNavTagState();
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
            // Capture tag corner pixels for touch calibration (tags are on surface)
            captureApriltagTouchCalibSamples(detections);
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
    // Note: apriltagTouchById is now populated from backend 6DoF pose data in applyApriltagPayload

    // Map AprilTag debug dots for configured participant IDs
    if (isMapViewWithHomography) {
      if (state.apriltagPrimaryOffsetCalibActive) renderPrimaryOffsetCalibOverlay();
      updateMapApriltagDots(state.lastApriltagDetections || []);
      updateMapTagMasks(state.lastApriltagDetections || []);
    } else {
      clearPrimaryOffsetCalibOverlay();
      setMapApriltagDotsVisible(false);
      updateMapTagMasks([]);
    }

    // Process tool tag actions (next/back, etc.)
    processToolTagActions();
    updateRoadLayersVisibilityByTags();

    state.animationId = requestAnimationFrame(processFrame);
  }

  function setMapApriltagDotsVisible(visible) {
    if (!dom.mapApriltagDotsEl) return;
    dom.mapApriltagDotsEl.classList.toggle('hidden', !visible);
    dom.mapApriltagDotsEl.setAttribute('aria-hidden', visible ? 'false' : 'true');
  }

  function updateMapApriltagDots(detections) {
    if (!dom.mapApriltagDotsEl) { return; }
    if (!state.surfaceHomography) { setMapApriltagDotsVisible(false); return; }

    var w = dom.mapViewEl.offsetWidth;
    var h = dom.mapViewEl.offsetHeight;
    if (!w || !h) { setMapApriltagDotsVisible(false); return; }

    var primaryTagIds = Array.isArray(state.stage3ParticipantTagIds) ? state.stage3ParticipantTagIds : [];
    var triggerTagIds = Array.isArray(state.stage3ParticipantTriggerTagIds) ? state.stage3ParticipantTriggerTagIds : [];
    var dotSpecs = [];
    var pi;
    for (pi = 0; pi < primaryTagIds.length; pi++) {
      var primaryTagId = parseInt(primaryTagIds[pi], 10);
      if (!isFinite(primaryTagId)) continue;
      dotSpecs.push({ tagId: primaryTagId, role: 'primary' });
    }
    for (pi = 0; pi < triggerTagIds.length; pi++) {
      var triggerTagId = parseInt(triggerTagIds[pi], 10);
      if (!isFinite(triggerTagId)) continue;
      dotSpecs.push({ tagId: triggerTagId, role: 'trigger' });
    }
    if (dotSpecs.length < 1) { setMapApriltagDotsVisible(false); return; }

    var required = dotSpecs.length;
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
      var spec = dotSpecs[j];
      var tagId = spec.tagId;
      var role = spec.role;
      var dot = dom.mapApriltagDotsEl.children[j];
      var det = isFinite(tagId) ? detById[tagId] : null;

      dot.className = role === 'trigger' ? 'map-finger-dot map-finger-dot--trigger' : 'map-finger-dot map-finger-dot--primary';

      if (!det) {
        dot.classList.add('hidden');
        continue;
      }

      var sourcePoint = getApriltagTrackingPoint(det);
      if (!sourcePoint) {
        dot.classList.add('hidden');
        continue;
      }

      var uv = applyHomography(state.surfaceHomography, sourcePoint.x, sourcePoint.y);
      if (!uv || uv.x < -maxExtrapolation || uv.x > 1 + maxExtrapolation || uv.y < -maxExtrapolation || uv.y > 1 + maxExtrapolation) {
        dot.classList.add('hidden');
        continue;
      }

      var x = uv.x * w;
      var y = uv.y * h;
      var projected = applyTrackedTagOffset(det, tagId, x, y, w, h, role === 'trigger' ? 'trigger' : 'primary', uv);
      x = projected.x;
      y = projected.y;
      dot.style.transform = 'translate(' + (x - 7) + 'px, ' + (y - 7) + 'px)';
      dot.classList.remove('hidden');
      dot.dataset.tagId = String(tagId);
      dot.dataset.tagRole = role;
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

    var w = dom.mapViewEl.offsetWidth;
    var h = dom.mapViewEl.offsetHeight;
    if (!w || !h) {
      dom.mapTagMasksEl.innerHTML = '';
      return;
    }

    // Use canvas to draw per-tag fade masks.
    var canvas = dom.mapTagMasksEl.querySelector('canvas');
    if (!canvas) {
      canvas = document.createElement('canvas');
      canvas.style.cssText = 'position:absolute;inset:0;width:100%;height:100%;pointer-events:none;';
      dom.mapTagMasksEl.appendChild(canvas);
    }
    if (canvas.width !== w) canvas.width = w;
    if (canvas.height !== h) canvas.height = h;
    var ctx = canvas.getContext('2d');
    if (!ctx) {
      dom.mapTagMasksEl.innerHTML = '';
      return;
    }

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

    function getScaledCorners(corners, cx, cy, scale) {
      var out = [];
      for (var i = 0; i < 4; i++) {
        out.push({
          x: cx + (corners[i].x - cx) * scale,
          y: cy + (corners[i].y - cy) * scale
        });
      }
      return out;
    }

    function addPolygonPath(pathCorners) {
      if (!pathCorners || pathCorners.length < 4) return;
      ctx.moveTo(pathCorners[0].x, pathCorners[0].y);
      for (var pi = 1; pi < pathCorners.length; pi++) {
        ctx.lineTo(pathCorners[pi].x, pathCorners[pi].y);
      }
      ctx.closePath();
    }

    var fadeStartScale = 0.7;   // Fully black until 70% of tag size from center
    var fadeEndScale = 1.7;     // Fade reaches transparent at 170%
    var fadeSteps = 10;         // More steps = smoother fade

    ctx.clearRect(0, 0, w, h);

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

        // Solid center area (0% -> 70%)
        var innerSolid = getScaledCorners(screenCorners, cx, cy, fadeStartScale);
        ctx.beginPath();
        addPolygonPath(innerSolid);
        ctx.fillStyle = 'rgba(0, 0, 0, 1)';
        ctx.fill();

        // Faded ring (70% -> 170%)
        for (var step = 0; step < fadeSteps; step++) {
          var t0 = step / fadeSteps;
          var t1 = (step + 1) / fadeSteps;
          var s0 = fadeStartScale + (fadeEndScale - fadeStartScale) * t0;
          var s1 = fadeStartScale + (fadeEndScale - fadeStartScale) * t1;
          var a = Math.max(0, 1 - t1);

          var inner = getScaledCorners(screenCorners, cx, cy, s0);
          var outer = getScaledCorners(screenCorners, cx, cy, s1);

          ctx.beginPath();
          addPolygonPath(outer);
          addPolygonPath(inner);
          ctx.fillStyle = 'rgba(0, 0, 0, ' + a.toFixed(3) + ')';
          ctx.fill('evenodd');
        }
    }
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
