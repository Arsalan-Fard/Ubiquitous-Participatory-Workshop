import { getDom } from './dom.js';
import { startCameraStream, stopCameraStream, waitForVideoMetadata, startCameraById } from './camera.js';
import { initDetector } from './detector.js';
import { initHandDetector } from './handDetector.js';
import { rgbaToGrayscale } from './grayscale.js';
import { clearOverlay, drawDetections, drawSurface, drawStereoCalibPoints } from './render.js';
import { initUiSetup } from './uiSetup.js';
import {
  computeProjectionMatrix,
  triangulatePoint,
  computeAverageReprojectionError
} from './stereo.js';

export function initApp() {
  var dom = getDom();

  var overlayCtx = dom.overlay.getContext('2d');
  if (!overlayCtx) throw new Error('Failed to get overlay canvas 2D context');

  var captureCanvas = document.createElement('canvas');
  var captureCtx = captureCanvas.getContext('2d', { willReadFrequently: true });
  if (!captureCtx) throw new Error('Failed to get capture canvas 2D context');

  var currentStream = null;
  var detector = null;
  var detectorLoading = false;
  var handDetector = null;
  var handDetectorReady = false;
  var cameraReady = false;
  var cameraStarting = false;
  var stage = 1;
  var isProcessing = false;
  var animationId = null;
  var apriltagEnabled = dom.apriltagToggleEl.checked;
  var viewMode = 'camera';
  var maptasticInitialized = false;
  var surfaceCorners = [null, null, null, null];
  var armedCornerIndex = null;
  var armedCornerTimeoutId = null;
  var armedCornerCaptureRequested = false;
  var lastIndexTipPoint = null;
  var lastIndexTipPoints = null;
  var lastIndexTipTimeMs = 0;
  var surfaceHomography = null;
  var availableVideoDevices = [];
  var customCameraSources = loadCustomCameraSources();
  var ipCameraImg = null;
  var usingIpCamera = false;
  var pixelReadBlockedNotified = false;

  // Stage 3 gesture controls (map view)
  var pinchDistanceThresholdPx = loadNumberSetting('pinchDistanceThresholdPx', 45, 10, 120);
  var holdStillThresholdPx = loadNumberSetting('holdStillThresholdPx', 14, 2, 80);
  var dwellClickMs = loadNumberSetting('dwellClickMs', 3000, 250, 8000);
  var pinchHoldMs = loadNumberSetting('pinchHoldMs', 3000, 250, 8000);
  var PINCH_RATIO_THRESHOLD = 0.35;

  var dwellAnchor = null; // {x,y} in viewport coords
  var dwellStartMs = 0;
  var dwellFired = false;

  var pinchStartMs = 0;
  var pinchAnchor = null; // {x,y} in viewport coords
  var dragActive = false;
  var dragTarget = null;
  var dragPointerId = 1;
  var lastPointerViewport = null; // {x,y}
  var crossOriginClickWarned = false;
  var mapFingerCursorProgressCircleEl = null;
  var hamburgerOpen = false;
  var viewToggleDockParent = null;
  var viewToggleDockNextSibling = null;

  // Stage 4 drawing tool
  var stage4DrawMode = false;
  var stage4DrawColor = '#2bb8ff';
  var stage4IsDrawing = false;
  var stage4LastDrawContainerPt = null; // Leaflet container point, for throttling
  var stage4ActiveStroke = null; // { latlngs: [], glow: L.Polyline, main: L.Polyline }
  var stage4DrawLayer = null; // L.LayerGroup
  var leafletGlobal = null;
  var leafletMap = null;
  var leafletTileLayer = null;

  // Stereo calibration state
  var stereoMode = false;
  var stereoCalibrationPoints = [];  // Array of 12 calibration points
  var stereoProjectionMatrix1 = null;
  var stereoProjectionMatrix2 = null;
  var stereoCalibrationReady = false;
  var stereoArmedPointIndex = null;
  var stereoArmedTimeoutId = null;
  var touchZThreshold = 0.05;  // Z values below this are considered "touch"

  // Second camera state
  var currentStream2 = null;
  var handDetector2 = null;
  var handDetectorReady2 = false;
  var captureCanvas2 = null;
  var captureCtx2 = null;

  // World positions for 12 calibration points (two-level calibration)
  // Note: Z values are in normalized units (relative to surface width/height)
  // Change ELEVATED_Z to match your spacer height (0.1 = 10cm if surface is ~1m)
  var ELEVATED_Z = 0.1;  // 10cm spacer height
  var STEREO_WORLD_POSITIONS = [
    // Surface level (Z=0): 8 points
    { x: 0, y: 0, z: 0 },      // 1: Top-left corner
    { x: 1, y: 0, z: 0 },      // 2: Top-right corner
    { x: 1, y: 1, z: 0 },      // 3: Bottom-right corner
    { x: 0, y: 1, z: 0 },      // 4: Bottom-left corner
    { x: 0.5, y: 0, z: 0 },    // 5: Top edge midpoint
    { x: 1, y: 0.5, z: 0 },    // 6: Right edge midpoint
    { x: 0.5, y: 1, z: 0 },    // 7: Bottom edge midpoint
    { x: 0, y: 0.5, z: 0 },    // 8: Left edge midpoint
    // Elevated level: 4 points (change ELEVATED_Z above to adjust)
    { x: 0, y: 0, z: ELEVATED_Z },    // 9: Top-left corner, elevated
    { x: 1, y: 0, z: ELEVATED_Z },    // 10: Top-right corner, elevated
    { x: 1, y: 1, z: ELEVATED_Z },    // 11: Bottom-right corner, elevated
    { x: 0, y: 1, z: ELEVATED_Z },    // 12: Bottom-left corner, elevated
  ];

  var videoContainer = document.getElementById('videoContainer1');
  var videoContainer2 = document.getElementById('videoContainer2');
  initHandDetector({ videoContainer: videoContainer }).then(function (h) {
    handDetector = h;
    handDetectorReady = true;
    updateLoadingMessage();
  });

  initUiSetup({ panelEl: dom.uiSetupPanelEl, overlayEl: dom.uiSetupOverlayEl });

  dom.startBtn.addEventListener('click', startCamera);
  dom.nextBtn.addEventListener('click', onNextClicked);
  dom.backBtn.addEventListener('click', onBackClicked);
  dom.stopBtn.addEventListener('click', stopCamera);
  dom.apriltagToggleEl.addEventListener('change', onApriltagToggleChanged);
  dom.viewToggleEl.addEventListener('change', onViewToggleChanged);
  dom.cameraCountSelectEl.addEventListener('change', function () {
    renderCameraDeviceSelects();
  });
  dom.cameraAddBtnEl.addEventListener('click', function () {
    if (stage !== 1) return;
    openCameraSourceModal();
  });
  dom.cameraSourceCancelBtnEl.addEventListener('click', function () {
    closeCameraSourceModal();
  });
  dom.cameraSourceSaveBtnEl.addEventListener('click', function () {
    saveCameraSourceFromModal();
  });
  dom.cameraSourceModalEl.addEventListener('click', function (e) {
    if (e.target && e.target.classList && e.target.classList.contains('modal-backdrop')) {
      closeCameraSourceModal();
    }
  });
  dom.cameraSourceInputEl.addEventListener('keydown', function (e) {
    if (e.key === 'Escape') {
      e.preventDefault();
      closeCameraSourceModal();
      return;
    }

    if (e.key === 'Enter') {
      e.preventDefault();
      saveCameraSourceFromModal();
    }
  });
  dom.surfaceBtn1.addEventListener('click', function () {
    armCorner(0);
  });
  dom.surfaceBtn2.addEventListener('click', function () {
    armCorner(1);
  });
  dom.surfaceBtn3.addEventListener('click', function () {
    armCorner(2);
  });
  dom.surfaceBtn4.addEventListener('click', function () {
    armCorner(3);
  });

  // Stereo calibration button listeners
  setupStereoCalibButtonListeners();

  // Camera count change listener for stereo mode
  dom.cameraCountSelectEl.addEventListener('change', function () {
    var count = parseInt(dom.cameraCountSelectEl.value, 10);
    stereoMode = count === 2;
    updateStereoUIVisibility();
  });

  viewToggleDockParent = dom.viewToggleContainerEl.parentNode;
  viewToggleDockNextSibling = dom.viewToggleContainerEl.nextSibling;

  dom.hamburgerBtnEl.addEventListener('click', function () {
    setHamburgerOpen(!hamburgerOpen);
  });

  document.addEventListener('keydown', function (e) {
    if (e.key !== 'Escape') return;
    if (hamburgerOpen) setHamburgerOpen(false);
    if (stage4DrawMode) setStage4DrawMode(false);
  });

  // Stage 4 sticker placement: dragging a sticker clones it (template stays put).
  document.addEventListener('pointerdown', function (e) {
    if (stage !== 4) return;
    if (viewMode !== 'map') return;
    if (!dom.uiSetupOverlayEl || dom.uiSetupOverlayEl.classList.contains('hidden')) return;
    if (!e.target || !e.target.closest) return;

    // Dot stickers can be cloned/dragged. Draw stickers are tools (click to enter draw mode).
    var drawTemplateEl = e.target.closest('.ui-draw');
    if (drawTemplateEl && dom.uiSetupOverlayEl.contains(drawTemplateEl) && !drawTemplateEl.classList.contains('ui-sticker-instance')) {
      if (e.button !== 0) return;
      e.preventDefault();
      e.stopImmediatePropagation();

      var color = (drawTemplateEl.dataset && drawTemplateEl.dataset.color) ? drawTemplateEl.dataset.color : stage4DrawColor;
      var same = stage4DrawMode && stage4DrawColor === color;
      stage4DrawColor = color;
      setStage4DrawMode(!same);
      return;
    }

    var stickerEl = e.target.closest('.ui-dot');
    if (!stickerEl) return;
    if (!dom.uiSetupOverlayEl.contains(stickerEl)) return;
    if (e.button !== 0) return;

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
      if (!dragEl) return;
      startStickerDrag(dragEl, e);
    }

    function onUp(ev) {
      if (ev.pointerId !== pointerId) return;
      cleanup();
      if (dragStarted) return;
    }

    document.addEventListener('pointermove', onMove, true);
    document.addEventListener('pointerup', onUp, true);
    document.addEventListener('pointercancel', onUp, true);
  }, true);

  window.addEventListener('resize', function () {
    if (leafletMap) {
      try { leafletMap.invalidateSize(); } catch {}
    }
  });

  function stage4LatLngFromPointerEvent(e) {
    if (!leafletMap) return null;
    try { return leafletMap.mouseEventToLatLng(e); } catch {}
    try {
      var pt = leafletMap.mouseEventToContainerPoint(e);
      return leafletMap.containerPointToLatLng(pt);
    } catch {}
    return null;
  }

  function stage4PointerdownOnMap(e) {
    if (!stage4DrawMode) return;
    if (stage !== 4 || viewMode !== 'map') return;
    if (!leafletMap || !stage4DrawLayer || !leafletGlobal) return;
    if (e.button !== 0) return;
    if (e.target && e.target.closest && e.target.closest('.hamburger-menu')) return;

    var latlng = stage4LatLngFromPointerEvent(e);
    if (!latlng) return;

    e.preventDefault();
    e.stopPropagation();

    stage4IsDrawing = true;
    stage4LastDrawContainerPt = null;
    var latlngs = [latlng];

    var glow = leafletGlobal.polyline(latlngs, {
      color: stage4DrawColor,
      weight: 14,
      opacity: 0.25,
      lineCap: 'round',
      lineJoin: 'round',
      interactive: false
    }).addTo(stage4DrawLayer);

    var main = leafletGlobal.polyline(latlngs, {
      color: stage4DrawColor,
      weight: 7,
      opacity: 0.95,
      lineCap: 'round',
      lineJoin: 'round',
      interactive: false
    }).addTo(stage4DrawLayer);

    stage4ActiveStroke = { latlngs: latlngs, glow: glow, main: main };
    try { dom.leafletMapEl.setPointerCapture(e.pointerId); } catch {}
  }

  function stage4PointermoveOnMap(e) {
    if (!stage4DrawMode) return;
    if (!stage4IsDrawing || !stage4ActiveStroke) return;
    if (!leafletMap) return;

    e.preventDefault();
    e.stopPropagation();

    var pt;
    try { pt = leafletMap.mouseEventToContainerPoint(e); } catch { pt = null; }
    if (pt && stage4LastDrawContainerPt) {
      var dx = pt.x - stage4LastDrawContainerPt.x;
      var dy = pt.y - stage4LastDrawContainerPt.y;
      if ((dx * dx + dy * dy) < 4) return; // ~2px
    }

    var latlng = stage4LatLngFromPointerEvent(e);
    if (!latlng) return;

    if (pt) stage4LastDrawContainerPt = pt;
    stage4ActiveStroke.latlngs.push(latlng);
    try { stage4ActiveStroke.glow.setLatLngs(stage4ActiveStroke.latlngs); } catch {}
    try { stage4ActiveStroke.main.setLatLngs(stage4ActiveStroke.latlngs); } catch {}
  }

  function stage4StopDrawing(e) {
    if (!stage4IsDrawing) return;
    stage4IsDrawing = false;
    stage4LastDrawContainerPt = null;
    stage4ActiveStroke = null;
    try { dom.leafletMapEl.releasePointerCapture(e.pointerId); } catch {}
  }

  dom.leafletMapEl.addEventListener('pointerdown', stage4PointerdownOnMap);
  dom.leafletMapEl.addEventListener('pointermove', stage4PointermoveOnMap);
  dom.leafletMapEl.addEventListener('pointerup', stage4StopDrawing);
  dom.leafletMapEl.addEventListener('pointercancel', stage4StopDrawing);

  setStage(1);
  setViewMode('camera');
  setNextEnabled(false);
  updateSurfaceButtonsUI();
  updateUiSetupPanelVisibility();
  updateEdgeGuidesVisibility();
  updateGestureControlsVisibility();
  updateHamburgerMenuVisibility();
  updateBackState();
  updateCameraSelectVisibility();
  renderCameraDeviceSelects();
  refreshAvailableCameras();
  closeCameraSourceModal();
  updateStereoUIVisibility();

  dom.pinchThresholdSliderEl.value = String(Math.round(pinchDistanceThresholdPx));
  dom.pinchThresholdValueEl.textContent = String(Math.round(pinchDistanceThresholdPx));
  dom.pinchThresholdSliderEl.addEventListener('input', function () {
    var v = parseFloat(dom.pinchThresholdSliderEl.value);
    if (!isFinite(v)) return;
    pinchDistanceThresholdPx = clamp(v, 10, 120);
    dom.pinchThresholdValueEl.textContent = String(Math.round(pinchDistanceThresholdPx));
    saveNumberSetting('pinchDistanceThresholdPx', pinchDistanceThresholdPx);
  });

  dom.holdStillThresholdSliderEl.value = String(Math.round(holdStillThresholdPx));
  dom.holdStillThresholdValueEl.textContent = String(Math.round(holdStillThresholdPx));
  dom.holdStillThresholdSliderEl.addEventListener('input', function () {
    var v = parseFloat(dom.holdStillThresholdSliderEl.value);
    if (!isFinite(v)) return;
    holdStillThresholdPx = clamp(v, 2, 80);
    dom.holdStillThresholdValueEl.textContent = String(Math.round(holdStillThresholdPx));
    saveNumberSetting('holdStillThresholdPx', holdStillThresholdPx);
  });

  dom.dwellTimeSliderEl.value = String((dwellClickMs / 1000).toFixed(1));
  dom.dwellTimeValueEl.textContent = (dwellClickMs / 1000).toFixed(1);
  dom.dwellTimeSliderEl.addEventListener('input', function () {
    var v = parseFloat(dom.dwellTimeSliderEl.value);
    if (!isFinite(v)) return;
    // Slider is seconds; store ms.
    dwellClickMs = clamp(v, 0.25, 8.0) * 1000;
    dom.dwellTimeValueEl.textContent = (dwellClickMs / 1000).toFixed(1);
    saveNumberSetting('dwellClickMs', dwellClickMs);
  });

  dom.pinchHoldTimeSliderEl.value = String((pinchHoldMs / 1000).toFixed(1));
  dom.pinchHoldTimeValueEl.textContent = (pinchHoldMs / 1000).toFixed(1);
  dom.pinchHoldTimeSliderEl.addEventListener('input', function () {
    var v = parseFloat(dom.pinchHoldTimeSliderEl.value);
    if (!isFinite(v)) return;
    pinchHoldMs = clamp(v, 0.25, 8.0) * 1000;
    dom.pinchHoldTimeValueEl.textContent = (pinchHoldMs / 1000).toFixed(1);
    saveNumberSetting('pinchHoldMs', pinchHoldMs);
  });

  function initMaptasticIfNeeded() {
    if (maptasticInitialized) return;
    maptasticInitialized = true;

    var maptasticGlobal = window.maptastic;
    if (!maptasticGlobal || !maptasticGlobal.Maptastic) {
      console.warn('Maptastic library not loaded; map corner editing is unavailable.');
      return;
    }

    try {
      // Maptastic binds global key controls (Shift+Space) and draggable corners.
      new maptasticGlobal.Maptastic(dom.mapWarpEl.id);
      dom.mapHintEl.classList.remove('hidden');
      dom.mapHintEl.setAttribute('aria-hidden', 'false');
    } catch (err) {
      console.error('Failed to initialize Maptastic:', err);
    }
  }

  function showLoading(message) {
    if (message) dom.loadingEl.textContent = message;
    dom.loadingEl.classList.remove('hidden');
  }

  function hideLoading() {
    dom.loadingEl.classList.add('hidden');
  }

  function updateLoadingMessage() {
    if (cameraStarting) {
      showLoading('Starting camera...');
      return;
    }

    if (cameraReady && !handDetectorReady) {
      showLoading('Loading hand detection...');
      return;
    }

    hideLoading();
  }

  function setNextEnabled(enabled) {
    dom.nextBtn.disabled = !enabled;
  }

  function setStage(newStage) {
    stage = newStage;

    var titleText = 'Camera Setup Stage 1/4';
    if (stage === 2) titleText = 'Surface Setup Stage 2/4';
    if (stage === 3) titleText = 'UI Setup Stage 3/4';
    if (stage === 4) titleText = 'Stage 4/4';

    dom.pageTitleEl.textContent = titleText;
    document.title = titleText;

    if (stage === 2 || stage === 3) {
      dom.apriltagToggleContainerEl.classList.add('hidden');
      dom.viewToggleContainerEl.classList.remove('hidden');
    } else if (stage === 4) {
      dom.apriltagToggleContainerEl.classList.add('hidden');
      dom.viewToggleContainerEl.classList.add('hidden');
    } else {
      dom.apriltagToggleContainerEl.classList.remove('hidden');
      dom.viewToggleContainerEl.classList.add('hidden');
    }

    if (stage === 2) {
      // Show surface buttons only in non-stereo mode
      if (!stereoMode) {
        dom.surfaceButtonsEl.classList.remove('hidden');
      } else {
        dom.surfaceButtonsEl.classList.add('hidden');
      }
      setViewMode(dom.viewToggleEl.checked ? 'map' : 'camera');
    } else if (stage === 3) {
      dom.surfaceButtonsEl.classList.add('hidden');
      dom.viewToggleEl.checked = true;
      setViewMode('map');
    } else if (stage === 4) {
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
    updateStereoUIVisibility();
    updateHamburgerMenuVisibility();
    updateBackState();
    updateCameraSelectVisibility();
  }

  function onNextClicked() {
    if (!cameraReady) return;

    if (stage === 1) {
      goToSurfaceSetup();
      return;
    }

    if (stage === 2) {
      goToUiSetup();
      return;
    }

    if (stage === 3) {
      setStage(4);
      return;
    }
  }

  function onBackClicked() {
    if (!cameraReady) return;

    if (stage === 2) {
      setStage(1);
      return;
    }

    if (stage === 3) {
      // Surface setup should default back to camera view.
      dom.viewToggleEl.checked = false;
      setStage(2);
      return;
    }

    if (stage === 4) {
      dom.viewToggleEl.checked = true;
      setStage(3);
      return;
    }
  }

  function goToSurfaceSetup() {
    if (!cameraReady) return;
    dom.viewToggleEl.checked = false;
    resetSurfaceCorners();
    setStage(2);
  }

  function goToUiSetup() {
    if (!cameraReady) return;
    clearArmedCorner();
    dom.viewToggleEl.checked = true;
    setStage(3);
  }

  function onViewToggleChanged() {
    if (stage !== 2 && stage !== 3 && stage !== 4) return;
    setViewMode(dom.viewToggleEl.checked ? 'map' : 'camera');
  }

  function setViewMode(mode) {
    viewMode = mode === 'map' ? 'map' : 'camera';

    if (viewMode === 'map') {
      dom.mapViewEl.classList.remove('hidden');
      dom.mapViewEl.setAttribute('aria-hidden', 'false');
      if (stage !== 4) {
        dom.viewToggleContainerEl.classList.add('toggle-floating');
      } else {
        dom.viewToggleContainerEl.classList.remove('toggle-floating');
      }
      initMaptasticIfNeeded();
      initLeafletIfNeeded();
      // Keep processing running so we can track the index fingertip and project it onto the map.
      updateUiSetupPanelVisibility();
      updateEdgeGuidesVisibility();
      updateGestureControlsVisibility();
      updateHamburgerMenuVisibility();
      if (leafletMap) {
        try { leafletMap.invalidateSize(); } catch {}
      }
      // Re-apply current draw mode (only activates in stage 4 map view).
      setStage4DrawMode(stage4DrawMode);
      updateStage4MapInteractivity();
      return;
    }

    dom.mapViewEl.classList.add('hidden');
    dom.mapViewEl.setAttribute('aria-hidden', 'true');
    dom.viewToggleContainerEl.classList.remove('toggle-floating');
    setMapFingerDotsVisible(false);
    updateUiSetupPanelVisibility();
    updateEdgeGuidesVisibility();
    updateGestureControlsVisibility();
    updateHamburgerMenuVisibility();
    setStage4DrawMode(false);
    updateStage4MapInteractivity();
    resetStage3Gestures();
    resumeProcessingIfReady();
  }

  function initLeafletIfNeeded() {
    if (leafletMap) {
      try { leafletMap.invalidateSize(); } catch {}
      return;
    }

    leafletGlobal = window.L;
    var L = leafletGlobal;
    if (!L || !dom.leafletMapEl) {
      console.warn('Leaflet not available; map view will be blank.');
      return;
    }

    leafletMap = L.map(dom.leafletMapEl, {
      zoomControl: false,
      attributionControl: false,
      inertia: true
    });

    // Default view roughly matching the previous embedded bbox.
    leafletMap.setView([37.76, -122.44], 12);

    leafletTileLayer = L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png', {
      maxZoom: 19,
      crossOrigin: true
    });
    leafletTileLayer.addTo(leafletMap);

    try { stage4DrawLayer = L.layerGroup().addTo(leafletMap); } catch {}

    try { leafletMap.invalidateSize(); } catch {}
  }

  function updateHamburgerMenuVisibility() {
    var visible = stage === 4;
    dom.hamburgerMenuEl.classList.toggle('hidden', !visible);
    dom.hamburgerMenuEl.setAttribute('aria-hidden', visible ? 'false' : 'true');

    if (!visible) {
      setHamburgerOpen(false);
      undockViewToggle();
      setStage4DrawMode(false);
      updateStage4MapInteractivity();
      return;
    }

    dockViewToggle();
    if (!hamburgerOpen) {
      dom.viewToggleContainerEl.classList.add('hidden');
      dom.viewToggleContainerEl.setAttribute('aria-hidden', 'true');
    }
    updateStage4MapInteractivity();
  }

  function dockViewToggle() {
    if (!dom.hamburgerContentEl) return;
    if (dom.viewToggleContainerEl.parentNode === dom.hamburgerContentEl) return;
    dom.hamburgerContentEl.appendChild(dom.viewToggleContainerEl);
    dom.viewToggleContainerEl.classList.add('hidden');
    dom.viewToggleContainerEl.setAttribute('aria-hidden', 'true');
  }

  function undockViewToggle() {
    if (!viewToggleDockParent) return;
    if (dom.viewToggleContainerEl.parentNode !== dom.hamburgerContentEl) return;
    viewToggleDockParent.insertBefore(dom.viewToggleContainerEl, viewToggleDockNextSibling);
  }

  function setHamburgerOpen(open) {
    hamburgerOpen = !!open;
    dom.hamburgerBtnEl.setAttribute('aria-expanded', hamburgerOpen ? 'true' : 'false');
    dom.hamburgerPanelEl.classList.toggle('hidden', !hamburgerOpen);
    dom.hamburgerPanelEl.setAttribute('aria-hidden', hamburgerOpen ? 'false' : 'true');

    if (stage === 4) {
      dom.viewToggleContainerEl.classList.toggle('hidden', !hamburgerOpen);
      dom.viewToggleContainerEl.setAttribute('aria-hidden', hamburgerOpen ? 'false' : 'true');
    }
  }

  function setStage4DrawMode(enabled) {
    stage4DrawMode = !!enabled;
    stage4IsDrawing = false;
    stage4LastDrawContainerPt = null;
    stage4ActiveStroke = null;

    var active = stage4DrawMode && stage === 4 && viewMode === 'map';
    if (dom.leafletMapEl) {
      dom.leafletMapEl.classList.toggle('leaflet-map--draw-active', active);
    }
    updateStage4MapInteractivity();
  }

  function updateStage4MapInteractivity() {
    // Leaflet is same-page; keep it interactive by default.
    // If we need to disable map interaction while drawing, do it here.
    if (!leafletMap) return;

    if (stage === 4 && viewMode === 'map' && stage4DrawMode) {
      try { leafletMap.dragging.disable(); } catch {}
      try { leafletMap.scrollWheelZoom.disable(); } catch {}
      try { leafletMap.doubleClickZoom.disable(); } catch {}
      return;
    }

    try { leafletMap.dragging.enable(); } catch {}
    try { leafletMap.scrollWheelZoom.enable(); } catch {}
    try { leafletMap.doubleClickZoom.enable(); } catch {}
  }

  function updateEdgeGuidesVisibility() {
    var visible = stage === 2 && viewMode === 'camera';
    if (visible) {
      dom.edgeGuidesEl.classList.remove('hidden');
      dom.edgeGuidesEl.setAttribute('aria-hidden', 'false');
      return;
    }

    dom.edgeGuidesEl.classList.add('hidden');
    dom.edgeGuidesEl.setAttribute('aria-hidden', 'true');
  }

  function updateGestureControlsVisibility() {
    var visible = stage === 3 && viewMode === 'camera';
    if (visible) {
      dom.gestureControlsEl.classList.remove('hidden');
      dom.gestureControlsEl.setAttribute('aria-hidden', 'false');
      return;
    }

    dom.gestureControlsEl.classList.add('hidden');
    dom.gestureControlsEl.setAttribute('aria-hidden', 'true');
  }

  function pauseProcessing() {
    isProcessing = false;
    if (animationId) {
      cancelAnimationFrame(animationId);
      animationId = null;
    }
  }

  function resumeProcessingIfReady() {
    if (!cameraReady) return;
    if (viewMode !== 'camera') return;
    if (isProcessing) return;
    startProcessing();
  }

  function onApriltagToggleChanged() {
    apriltagEnabled = dom.apriltagToggleEl.checked;

    if (!apriltagEnabled) {
      clearOverlay(overlayCtx, dom.overlay);
      return;
    }

    loadDetectorIfNeeded();
  }

  function resetSurfaceCorners() {
    surfaceCorners = [null, null, null, null];
    surfaceHomography = null;
    clearArmedCorner();
    updateSurfaceButtonsUI();
    setMapFingerDotsVisible(false);
  }

  function setMapFingerDotsVisible(visible) {
    if (visible) {
      dom.mapFingerDotsEl.classList.remove('hidden');
      dom.mapFingerDotsEl.setAttribute('aria-hidden', 'false');
      return;
    }

    dom.mapFingerDotsEl.classList.add('hidden');
    dom.mapFingerDotsEl.setAttribute('aria-hidden', 'true');
    dom.mapFingerDotsEl.textContent = '';
  }

  function updateUiSetupPanelVisibility() {
    var overlayVisible = (stage === 3 || stage === 4) && viewMode === 'map';
    var panelVisible = stage === 3 && viewMode === 'map';

    dom.uiSetupOverlayEl.classList.toggle('hidden', !overlayVisible);
    dom.uiSetupOverlayEl.setAttribute('aria-hidden', overlayVisible ? 'false' : 'true');
    dom.uiSetupOverlayEl.classList.toggle('ui-setup-overlay--locked', stage === 4);

    dom.uiSetupPanelEl.classList.toggle('hidden', !panelVisible);
    dom.uiSetupPanelEl.setAttribute('aria-hidden', panelVisible ? 'false' : 'true');

    if (!overlayVisible) resetStage3Gestures();
  }

  function areSurfaceCornersReady() {
    return !!(surfaceCorners[0] && surfaceCorners[1] && surfaceCorners[2] && surfaceCorners[3]);
  }

  function recomputeSurfaceHomographyIfReady() {
    if (!areSurfaceCornersReady()) {
      surfaceHomography = null;
      return;
    }

    surfaceHomography = computeHomography(surfaceCorners, [
      { x: 0, y: 0 },
      { x: 1, y: 0 },
      { x: 1, y: 1 },
      { x: 0, y: 1 },
    ]);

    if (!surfaceHomography) {
      console.warn('Surface homography could not be computed (degenerate corners).');
    }
  }

  function recomputeSurfaceHomographyFromStereoIfReady() {
    if (!stereoMode) return;

    var corners1 = [];
    for (var i = 0; i < 4; i++) {
      var pt = stereoCalibrationPoints[i];
      if (!pt || !pt.camera1Pixel) {
        surfaceHomography = null;
        return;
      }
      corners1.push({ x: pt.camera1Pixel.x, y: pt.camera1Pixel.y });
    }

    surfaceHomography = computeHomography(corners1, [
      { x: 0, y: 0 },
      { x: 1, y: 0 },
      { x: 1, y: 1 },
      { x: 0, y: 1 },
    ]);

    if (!surfaceHomography) {
      console.warn('Stereo surface homography could not be computed (degenerate corners).');
    }
  }

  function clearArmedCorner() {
    armedCornerIndex = null;
    armedCornerCaptureRequested = false;
    if (armedCornerTimeoutId) {
      clearTimeout(armedCornerTimeoutId);
      armedCornerTimeoutId = null;
    }
  }

  function armCorner(index) {
    if (stage !== 2) return;

    if (viewMode !== 'camera') {
      dom.viewToggleEl.checked = false;
      setViewMode('camera');
    }

    armedCornerIndex = index;
    armedCornerCaptureRequested = true;
    updateSurfaceButtonsUI();

    if (armedCornerTimeoutId) clearTimeout(armedCornerTimeoutId);
    armedCornerTimeoutId = setTimeout(function () {
      clearArmedCorner();
      updateSurfaceButtonsUI();
    }, 2500);
  }

  function flashCornerButton(index) {
    var el = null;
    if (index === 0) el = dom.surfaceBtn1;
    if (index === 1) el = dom.surfaceBtn2;
    if (index === 2) el = dom.surfaceBtn3;
    if (index === 3) el = dom.surfaceBtn4;
    if (!el) return;

    el.classList.add('surface-btn--flash');
    setTimeout(function () {
      el.classList.remove('surface-btn--flash');
    }, 220);
  }

  function updateSurfaceButtonsUI() {
    dom.surfaceBtn1.classList.toggle('surface-btn--set', !!surfaceCorners[0]);
    dom.surfaceBtn2.classList.toggle('surface-btn--set', !!surfaceCorners[1]);
    dom.surfaceBtn3.classList.toggle('surface-btn--set', !!surfaceCorners[2]);
    dom.surfaceBtn4.classList.toggle('surface-btn--set', !!surfaceCorners[3]);

    dom.surfaceBtn1.classList.toggle('surface-btn--armed', armedCornerIndex === 0);
    dom.surfaceBtn2.classList.toggle('surface-btn--armed', armedCornerIndex === 1);
    dom.surfaceBtn3.classList.toggle('surface-btn--armed', armedCornerIndex === 2);
    dom.surfaceBtn4.classList.toggle('surface-btn--armed', armedCornerIndex === 3);
  }

  // ============== Stereo Calibration Functions ==============

  function setupStereoCalibButtonListeners() {
    for (var i = 1; i <= 12; i++) {
      (function (index) {
        var btn = document.getElementById('stereoCalibBtn' + index);
        if (btn) {
          btn.addEventListener('click', function () {
            armStereoCalibPoint(index - 1);
          });
        }
      })(i);
    }

    var computeBtn = document.getElementById('stereoComputeBtn');
    if (computeBtn) {
      computeBtn.addEventListener('click', computeStereoCalibration);
    }
  }

  function updateStereoUIVisibility() {
    var stereoCalibBtns = document.getElementById('stereoCalibButtons');
    var touchIndicator = document.getElementById('touchIndicator');

    if (stereoMode) {
      // Show second camera container
      if (videoContainer2) {
        videoContainer2.classList.remove('hidden');
      }
      // Show stereo calibration buttons in stage 2
      if (stereoCalibBtns && stage === 2) {
        stereoCalibBtns.classList.remove('hidden');
      }
      // Hide single-camera surface buttons in stereo mode
      dom.surfaceButtonsEl.classList.add('hidden');
      recomputeSurfaceHomographyFromStereoIfReady();
    } else {
      // Hide second camera container
      if (videoContainer2) {
        videoContainer2.classList.add('hidden');
      }
      // Hide stereo calibration buttons
      if (stereoCalibBtns) {
        stereoCalibBtns.classList.add('hidden');
      }
      // Hide touch indicator
      if (touchIndicator) {
        touchIndicator.classList.add('hidden');
      }
      recomputeSurfaceHomographyIfReady();
    }

    // Show touch indicator only if stereo calibration is ready
    if (touchIndicator) {
      if (stereoMode && stereoCalibrationReady) {
        touchIndicator.classList.remove('hidden');
      } else {
        touchIndicator.classList.add('hidden');
      }
    }
  }

  function armStereoCalibPoint(index) {
    if (stage !== 2) return;
    if (!stereoMode) return;

    if (viewMode !== 'camera') {
      dom.viewToggleEl.checked = false;
      setViewMode('camera');
    }

    stereoArmedPointIndex = index;
    updateStereoCalibButtonsUI();

    if (stereoArmedTimeoutId) clearTimeout(stereoArmedTimeoutId);
    stereoArmedTimeoutId = setTimeout(function () {
      clearStereoArmedPoint();
      updateStereoCalibButtonsUI();
    }, 3000);
  }

  function clearStereoArmedPoint() {
    stereoArmedPointIndex = null;
    if (stereoArmedTimeoutId) {
      clearTimeout(stereoArmedTimeoutId);
      stereoArmedTimeoutId = null;
    }
  }

  function flashStereoCalibButton(index) {
    var btn = document.getElementById('stereoCalibBtn' + (index + 1));
    if (!btn) return;

    btn.classList.add('stereo-calib-btn--flash');
    setTimeout(function () {
      btn.classList.remove('stereo-calib-btn--flash');
    }, 220);
  }

  function updateStereoCalibButtonsUI() {
    for (var i = 0; i < 12; i++) {
      var btn = document.getElementById('stereoCalibBtn' + (i + 1));
      if (!btn) continue;

      var isSet = stereoCalibrationPoints[i] &&
                  stereoCalibrationPoints[i].camera1Pixel &&
                  stereoCalibrationPoints[i].camera2Pixel;
      var isArmed = stereoArmedPointIndex === i;

      btn.classList.toggle('stereo-calib-btn--set', !!isSet);
      btn.classList.toggle('stereo-calib-btn--armed', isArmed);
    }

    // Update compute button state
    var computeBtn = document.getElementById('stereoComputeBtn');
    if (computeBtn) {
      var validCount = countValidStereoPoints();
      computeBtn.disabled = validCount < 6;
      computeBtn.textContent = 'Compute (' + validCount + '/12)';
    }

    // Update status
    var statusEl = document.getElementById('stereoCalibStatus');
    if (statusEl) {
      if (stereoCalibrationReady) {
        statusEl.textContent = 'Calibrated!';
        statusEl.className = 'stereo-calib-status stereo-calib-status--success';
      } else if (stereoArmedPointIndex !== null) {
        statusEl.textContent = 'Touch point ' + (stereoArmedPointIndex + 1) + ' with both cameras seeing your finger...';
        statusEl.className = 'stereo-calib-status stereo-calib-status--armed';
      } else {
        statusEl.textContent = '';
        statusEl.className = 'stereo-calib-status';
      }
    }
  }

  function countValidStereoPoints() {
    var count = 0;
    for (var i = 0; i < stereoCalibrationPoints.length; i++) {
      var pt = stereoCalibrationPoints[i];
      if (pt && pt.camera1Pixel && pt.camera2Pixel) {
        count++;
      }
    }
    return count;
  }

  function captureStereoCalibPoint(fingertip1, fingertip2) {
    if (stereoArmedPointIndex === null) return;
    if (!fingertip1 || !fingertip2) return;

    var index = stereoArmedPointIndex;
    stereoCalibrationPoints[index] = {
      index: index,
      worldPos: STEREO_WORLD_POSITIONS[index],
      camera1Pixel: { x: fingertip1.x, y: fingertip1.y },
      camera2Pixel: { x: fingertip2.x, y: fingertip2.y },
      timestamp: Date.now()
    };

    flashStereoCalibButton(index);
    clearStereoArmedPoint();
    updateStereoCalibButtonsUI();
    // Enable stage 3 map finger dot once the 4 surface corners (points 1-4) exist.
    recomputeSurfaceHomographyFromStereoIfReady();
  }

  function computeStereoCalibration() {
    var validPoints = [];
    for (var i = 0; i < stereoCalibrationPoints.length; i++) {
      var pt = stereoCalibrationPoints[i];
      if (pt && pt.worldPos && pt.camera1Pixel && pt.camera2Pixel) {
        validPoints.push(pt);
      }
    }

    if (validPoints.length < 6) {
      setError('Need at least 6 calibration points for stereo calibration. Currently have ' + validPoints.length + '.');
      return;
    }

    var worldPoints = validPoints.map(function (p) { return p.worldPos; });
    var imagePoints1 = validPoints.map(function (p) { return p.camera1Pixel; });
    var imagePoints2 = validPoints.map(function (p) { return p.camera2Pixel; });

    stereoProjectionMatrix1 = computeProjectionMatrix(worldPoints, imagePoints1);
    stereoProjectionMatrix2 = computeProjectionMatrix(worldPoints, imagePoints2);

    if (!stereoProjectionMatrix1 || !stereoProjectionMatrix2) {
      setError('Failed to compute projection matrices. Check calibration points are not collinear.');
      stereoCalibrationReady = false;
      updateStereoUIVisibility();
      return;
    }

    // Validate with reprojection error
    var avgError = computeAverageReprojectionError(
      stereoProjectionMatrix1,
      stereoProjectionMatrix2,
      validPoints
    );

    if (avgError > 15) {
      setError('High reprojection error (' + avgError.toFixed(1) + 'px). Consider recalibrating.');
      // Still mark as ready but warn
    }

    stereoCalibrationReady = true;
    setError('');
    updateStereoCalibButtonsUI();
    updateStereoUIVisibility();

    console.log('Stereo calibration complete. Avg reprojection error:', avgError.toFixed(2), 'px');
  }

  function updateTouchIndicator(worldPoint) {
    var touchIndicator = document.getElementById('touchIndicator');
    var touchStatus = document.getElementById('touchStatus');
    var touchZ = document.getElementById('touchZ');

    if (!touchIndicator || !touchStatus || !touchZ) return;

    var z = worldPoint.z;
    var isTouch = Math.abs(z) < touchZThreshold;

    touchStatus.textContent = isTouch ? 'TOUCH' : 'HOVER';
    touchStatus.classList.toggle('touch-status--touch', isTouch);
    touchStatus.classList.toggle('touch-status--hover', !isTouch);
    touchZ.textContent = 'Z: ' + z.toFixed(3);
  }

  function resetStereoCalibration() {
    stereoCalibrationPoints = [];
    stereoProjectionMatrix1 = null;
    stereoProjectionMatrix2 = null;
    stereoCalibrationReady = false;
    surfaceHomography = null;
    clearStereoArmedPoint();
    updateStereoCalibButtonsUI();
    updateStereoUIVisibility();
    setMapFingerDotsVisible(false);
  }

  // ============== Second Camera Functions ==============

  async function startSecondCamera() {
    var selectEl = dom.cameraDeviceSelectsEl.querySelector('select[data-camera-index="1"]');
    if (!selectEl) return false;

    var deviceId = selectEl.value;
    if (!deviceId || deviceId.startsWith('ip:')) {
      console.warn('Second camera: IP cameras not yet supported for stereo mode');
      return false;
    }

    try {
      // Create video element for camera 2 if needed
      var video2 = document.getElementById('video2');
      if (!video2) return false;

      currentStream2 = await startCameraById(video2, deviceId, {
        width: 640,
        height: 480
      });

      await waitForVideoMetadata(video2);

      // Create capture canvas for camera 2
      captureCanvas2 = document.createElement('canvas');
      captureCanvas2.width = video2.videoWidth;
      captureCanvas2.height = video2.videoHeight;
      captureCtx2 = captureCanvas2.getContext('2d', { willReadFrequently: true });

      // Set overlay size
      var overlay2 = document.getElementById('overlay2');
      if (overlay2) {
        overlay2.width = video2.videoWidth;
        overlay2.height = video2.videoHeight;
      }

      // Initialize second hand detector
      handDetector2 = await initHandDetector({
        videoContainer: videoContainer2,
        instanceId: 'camera2'
      });
      handDetectorReady2 = !!handDetector2;

      console.log('Second camera started successfully');
      return true;
    } catch (err) {
      console.error('Failed to start second camera:', err);
      return false;
    }
  }

  function stopSecondCamera() {
    if (currentStream2) {
      stopCameraStream(currentStream2);
      currentStream2 = null;
    }

    if (handDetector2 && handDetector2.destroy) {
      handDetector2.destroy();
      handDetector2 = null;
      handDetectorReady2 = false;
    }

    captureCanvas2 = null;
    captureCtx2 = null;
  }

  function loadDetectorIfNeeded() {
    if (!apriltagEnabled) return;
    if (detector) return;
    if (detectorLoading) return;

    detectorLoading = true;
    initDetector()
      .then(
        function (d) {
          detector = d;
          detectorLoading = false;
        },
        function (err) {
          console.error('Failed to initialize detector:', err);
          detectorLoading = false;
        },
      );
  }

  async function startCamera() {
    try {
      dom.startBtn.disabled = true;
      setError('');
      cameraStarting = true;
      updateLoadingMessage();

      var selectedSource = getSelectedCameraSource();
      if (selectedSource && selectedSource.type === 'ip') {
        await startIpCamera(selectedSource.url);
        return;
      }

      stopIpCameraIfRunning();
      usingIpCamera = false;
      pixelReadBlockedNotified = false;
      dom.video.classList.remove('hidden');

      var selectedDeviceId = selectedSource && selectedSource.type === 'device' ? selectedSource.deviceId : null;
      var videoConstraints = {
        width: { ideal: 640 },
        height: { ideal: 480 },
      };
      if (selectedDeviceId) {
        videoConstraints.deviceId = { exact: selectedDeviceId };
      } else {
        videoConstraints.facingMode = 'environment';
      }

      var stream = await startCameraStream(dom.video, {
        video: {
          deviceId: videoConstraints.deviceId,
          facingMode: videoConstraints.facingMode,
          width: videoConstraints.width,
          height: videoConstraints.height,
        },
        audio: false,
      });

      currentStream = stream;

      await waitForVideoMetadata(dom.video);

      dom.overlay.width = dom.video.videoWidth;
      dom.overlay.height = dom.video.videoHeight;
      captureCanvas.width = dom.video.videoWidth;
      captureCanvas.height = dom.video.videoHeight;

      setButtonsRunning(true);
      cameraStarting = false;
      cameraReady = true;
      updateLoadingMessage();
      setNextEnabled(true);

      if (apriltagEnabled) {
        loadDetectorIfNeeded();
      }

      // Start second camera if in stereo mode
      var cameraCount = parseInt(dom.cameraCountSelectEl.value, 10);
      stereoMode = cameraCount === 2;
      if (stereoMode) {
        var secondCameraOk = await startSecondCamera();
        if (!secondCameraOk) {
          setError('Failed to start second camera. Stereo mode disabled.');
          stereoMode = false;
        }
      }
      updateStereoUIVisibility();

      refreshAvailableCameras();
      startProcessing();
    } catch (err) {
      cameraStarting = false;
      cameraReady = false;
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
    stopCameraStream(currentStream);
    currentStream = null;

    // Stop second camera if running
    stopSecondCamera();

    dom.video.srcObject = null;
    dom.video.classList.remove('hidden');
    clearOverlay(overlayCtx, dom.overlay);
    cameraStarting = false;
    cameraReady = false;
    updateLoadingMessage();
    dom.startBtn.disabled = false;
    setNextEnabled(false);
    setStage(1);
    dom.viewToggleEl.checked = false;
    resetSurfaceCorners();
    resetStereoCalibration();

    setButtonsRunning(false);
  }

  function startProcessing() {
    isProcessing = true;
    processFrame();
  }

  async function processFrame() {
    if (!isProcessing) return;

    var width = captureCanvas.width;
    var height = captureCanvas.height;

    var frameSource = usingIpCamera && ipCameraImg ? ipCameraImg : dom.video;
    try {
      captureCtx.drawImage(frameSource, 0, 0, width, height);
    } catch (err) {
      animationId = requestAnimationFrame(processFrame);
      return;
    }

    var imageData = null;
    try {
      imageData = captureCtx.getImageData(0, 0, width, height);
    } catch (err) {
      if (!pixelReadBlockedNotified && usingIpCamera) {
        pixelReadBlockedNotified = true;
        setError('IP camera stream is visible, but pixel processing is blocked (CORS). Use a same-origin proxy or a camera stream with CORS enabled.');
      }
      animationId = requestAnimationFrame(processFrame);
      return;
    }

    var shouldRenderOverlay = viewMode === 'camera';
    if (shouldRenderOverlay) {
      clearOverlay(overlayCtx, dom.overlay);
    }

    var hands = [];
    var hands2 = [];

    // Hand detection for camera 1 (hand skeleton drawing happens in iframe)
    if (handDetector) {
      try {
        hands = (await handDetector.detect(imageData.data, width, height)) || [];
      } catch (err) {
        console.error('Hand detection error (camera 1):', err);
        hands = [];
      }
    }

    // Hand detection for camera 2 (stereo mode)
    var fingertip2 = null;
    if (stereoMode && handDetector2 && captureCanvas2 && captureCtx2) {
      try {
        var video2 = document.getElementById('video2');
        if (video2 && video2.readyState >= 2) {
          var w2 = captureCanvas2.width;
          var h2 = captureCanvas2.height;
          captureCtx2.drawImage(video2, 0, 0, w2, h2);
          var imageData2 = captureCtx2.getImageData(0, 0, w2, h2);
          hands2 = (await handDetector2.detect(imageData2.data, w2, h2)) || [];

          // Extract fingertip from camera 2
          if (hands2 && hands2.length > 0) {
            for (var j = 0; j < hands2.length; j++) {
              var hand2 = hands2[j];
              if (hand2 && hand2.landmarks && hand2.landmarks.length > 8) {
                var tip2 = hand2.landmarks[8];
                fingertip2 = { x: tip2.x, y: tip2.y };
                break;
              }
            }
          }
        }
      } catch (err) {
        console.error('Hand detection error (camera 2):', err);
        hands2 = [];
      }
    }

    var indexTipPoint = null;
    var indexTipPoints = [];

    if (hands && hands.length > 0) {
      for (var i = 0; i < hands.length; i++) {
        var hand = hands[i];
        if (!hand || !hand.landmarks || hand.landmarks.length <= 8) continue;
        var tip = hand.landmarks[8];
        var pinchDistance = typeof hand.pinchDistance === 'number' ? hand.pinchDistance : null;
        var handScale = null;
        if (hand.landmarks.length > 17) {
          // Palm width proxy: index MCP (5) to pinky MCP (17)
          var lm5 = hand.landmarks[5];
          var lm17 = hand.landmarks[17];
          if (lm5 && lm17) {
            var dxs = lm5.x - lm17.x;
            var dys = lm5.y - lm17.y;
            handScale = Math.sqrt(dxs * dxs + dys * dys);
          }
        }

        if (!handScale && hand.landmarks.length > 9) {
          // Fallback: wrist (0) to middle MCP (9)
          var lm0 = hand.landmarks[0];
          var lm9 = hand.landmarks[9];
          if (lm0 && lm9) {
            var dxs2 = lm0.x - lm9.x;
            var dys2 = lm0.y - lm9.y;
            handScale = Math.sqrt(dxs2 * dxs2 + dys2 * dys2);
          }
        }

        var pinchRatio = (pinchDistance !== null && handScale && handScale > 1e-6)
          ? pinchDistance / handScale
          : null;

        indexTipPoints.push({
          x: tip.x,
          y: tip.y,
          pinchDistance: pinchDistance,
          pinchRatio: pinchRatio,
          handedness: hand.handedness || null
        });
      }

      if (indexTipPoints.length > 0) {
        indexTipPoint = indexTipPoints[0];
        lastIndexTipPoint = indexTipPoint;
        lastIndexTipPoints = indexTipPoints;
        lastIndexTipTimeMs = performance.now();
      }
    }

    var isSurfaceSetupCameraView = (stage === 2 || stage === 3) && viewMode === 'camera';
    var usableIndexTipPoint = null;
    var usableIndexTipPoints = null;
    if (indexTipPoint) {
      usableIndexTipPoint = indexTipPoint;
      usableIndexTipPoints = indexTipPoints;
    } else if (lastIndexTipPoints && performance.now() - lastIndexTipTimeMs < 150) {
      usableIndexTipPoints = lastIndexTipPoints;
      usableIndexTipPoint = lastIndexTipPoint;
    }

    // Single camera corner capture (non-stereo mode)
    if (
      !stereoMode &&
      isSurfaceSetupCameraView &&
      armedCornerCaptureRequested &&
      armedCornerIndex !== null &&
      usableIndexTipPoint
    ) {
      surfaceCorners[armedCornerIndex] = usableIndexTipPoint;
      flashCornerButton(armedCornerIndex);
      clearArmedCorner();
      updateSurfaceButtonsUI();
      recomputeSurfaceHomographyIfReady();
    }

    // Stereo calibration capture
    if (
      stereoMode &&
      isSurfaceSetupCameraView &&
      stereoArmedPointIndex !== null &&
      usableIndexTipPoint &&
      fingertip2
    ) {
      captureStereoCalibPoint(usableIndexTipPoint, fingertip2);
    }

    // Stereo triangulation for touch detection (runtime)
    if (
      stereoMode &&
      stereoCalibrationReady &&
      usableIndexTipPoint &&
      fingertip2
    ) {
      var worldPoint = triangulatePoint(
        stereoProjectionMatrix1,
        stereoProjectionMatrix2,
        usableIndexTipPoint,
        fingertip2
      );
      if (worldPoint) {
        updateTouchIndicator(worldPoint);
      }
    }

    if (isSurfaceSetupCameraView) {
      if (stereoMode) {
        // Draw stereo calibration points on camera 1
        drawStereoCalibPoints(overlayCtx, stereoCalibrationPoints, 'camera1Pixel', {
          armedIndex: stereoArmedPointIndex,
          previewPoint: usableIndexTipPoint
        });

        // Draw stereo calibration points on camera 2
        var overlay2 = document.getElementById('overlay2');
        if (overlay2) {
          var ctx2 = overlay2.getContext('2d');
          if (ctx2) {
            ctx2.clearRect(0, 0, overlay2.width, overlay2.height);
            drawStereoCalibPoints(ctx2, stereoCalibrationPoints, 'camera2Pixel', {
              armedIndex: stereoArmedPointIndex,
              previewPoint: fingertip2
            });
          }
        }
      } else {
        // Single camera mode - draw surface corners
        drawSurface(overlayCtx, surfaceCorners, {
          previewIndex: armedCornerIndex,
          previewPoint: armedCornerIndex !== null ? usableIndexTipPoint : null,
        });
      }
    }

    var isSurfaceSetupMapView = (stage === 2 || stage === 3) && viewMode === 'map';
    if (isSurfaceSetupMapView && surfaceHomography && usableIndexTipPoints && usableIndexTipPoints.length > 0) {
      updateMapFingerDots(usableIndexTipPoints);
    } else {
      setMapFingerDotsVisible(false);
    }

    if (stage === 3 && viewMode === 'map') {
      handleStage3Gestures(usableIndexTipPoints);
    } else {
      resetStage3Gestures();
    }

    // AprilTag detection
    if (apriltagEnabled && detector && shouldRenderOverlay) {
      try {
        var grayscale = rgbaToGrayscale(imageData);
        var detections = await detector.detect(grayscale, width, height);

        if (detections && detections.length > 0) {
          drawDetections(overlayCtx, detections);
        }
      } catch (err) {
        console.error('AprilTag detection error:', err);
      }
    }

    animationId = requestAnimationFrame(processFrame);
  }

  function getPrimaryMapPointerViewportPoint() {
    if (!dom.mapFingerDotsEl || dom.mapFingerDotsEl.classList.contains('hidden')) return null;
    if (!dom.mapFingerDotsEl.children || dom.mapFingerDotsEl.children.length < 1) return null;

    var dotEl = dom.mapFingerDotsEl.children[0];
    if (!dotEl || dotEl.classList.contains('hidden')) return null;

    var rect = dotEl.getBoundingClientRect();
    return { x: rect.left + rect.width / 2, y: rect.top + rect.height / 2 };
  }

  function handleStage3Gestures(usableIndexTipPoints) {
    var pointer = getPrimaryMapPointerViewportPoint();
    updateStage3Cursor(pointer);
    if (!pointer) {
      setStage3CursorProgress(0, null);
      if (dragActive) endDrag(lastPointerViewport || pointer);
      resetGestureTimers();
      return;
    }

    lastPointerViewport = pointer;

    var primary = usableIndexTipPoints && usableIndexTipPoints.length > 0 ? usableIndexTipPoints[0] : null;
    var pinchDistance = primary && typeof primary.pinchDistance === 'number' ? primary.pinchDistance : null;
    var pinchRatio = primary && typeof primary.pinchRatio === 'number' ? primary.pinchRatio : null;
    var isPinching = false;
    if (pinchDistance !== null) {
      isPinching = pinchDistance <= pinchDistanceThresholdPx;
    } else if (pinchRatio !== null) {
      isPinching = pinchRatio <= PINCH_RATIO_THRESHOLD;
    }

    var nowMs = performance.now();

    // Pinch-to-drag (arm by holding pinch)
    if (isPinching) {
      dwellStartMs = 0;
      dwellAnchor = null;
      dwellFired = false;

      if (!pinchAnchor || distance(pointer, pinchAnchor) > holdStillThresholdPx) {
        pinchAnchor = pointer;
        pinchStartMs = nowMs;
      } else if (!pinchStartMs) {
        pinchStartMs = nowMs;
      }

      var pinchProgress = Math.min(1, (nowMs - pinchStartMs) / pinchHoldMs);
      setStage3CursorProgress(dragActive ? 1 : pinchProgress, dragActive ? 'drag' : 'pinch');

      if (!dragActive && nowMs - pinchStartMs >= pinchHoldMs) {
        startDrag(pointer);
      }

      if (dragActive) {
        continueDrag(pointer);
      }
      return;
    }

    pinchStartMs = 0;
    pinchAnchor = null;
    setStage3CursorProgress(0, null);
    if (dragActive) {
      endDrag(pointer);
      return;
    }

    // Dwell-to-click
    if (!dwellAnchor || distance(pointer, dwellAnchor) > holdStillThresholdPx) {
      dwellAnchor = pointer;
      dwellStartMs = nowMs;
      dwellFired = false;
      setStage3CursorProgress(0, null);
      return;
    }

    if (!dwellFired && dwellStartMs) {
      var dwellProgress = Math.min(1, (nowMs - dwellStartMs) / dwellClickMs);
      setStage3CursorProgress(dwellProgress, 'dwell');
    }

    if (!dwellFired && dwellStartMs && nowMs - dwellStartMs >= dwellClickMs) {
      dispatchClickAt(pointer);
      dwellFired = true;
      setStage3CursorProgress(0, null);
    }
  }

  function resetGestureTimers() {
    dwellAnchor = null;
    dwellStartMs = 0;
    dwellFired = false;
    pinchStartMs = 0;
    pinchAnchor = null;
  }

  function resetStage3Gestures() {
    if (dragActive) endDrag(lastPointerViewport);
    updateStage3Cursor(null);
    setStage3CursorProgress(0, null);
    resetGestureTimers();
    lastPointerViewport = null;
  }

  function getMapFingerCursorProgressCircleEl() {
    if (mapFingerCursorProgressCircleEl) return mapFingerCursorProgressCircleEl;
    if (!dom.mapFingerCursorEl) return null;
    mapFingerCursorProgressCircleEl = dom.mapFingerCursorEl.querySelector('.map-finger-cursor__progress');
    return mapFingerCursorProgressCircleEl;
  }

  function setStage3CursorProgress(progress01, mode) {
    if (!dom.mapFingerCursorEl) return;
    var circle = getMapFingerCursorProgressCircleEl();
    if (!circle) return;

    var p = Math.max(0, Math.min(1, progress01 || 0));
    var dashOffset = 100 - p * 100;
    circle.style.strokeDashoffset = String(dashOffset);

    dom.mapFingerCursorEl.classList.remove('map-finger-cursor--dwell');
    dom.mapFingerCursorEl.classList.remove('map-finger-cursor--pinch');
    dom.mapFingerCursorEl.classList.remove('map-finger-cursor--drag');

    if (mode === 'dwell') dom.mapFingerCursorEl.classList.add('map-finger-cursor--dwell');
    if (mode === 'pinch') dom.mapFingerCursorEl.classList.add('map-finger-cursor--pinch');
    if (mode === 'drag') dom.mapFingerCursorEl.classList.add('map-finger-cursor--drag');
  }

  function updateStage3Cursor(pointer) {
    if (!dom.mapFingerCursorEl) return;

    var visible = stage === 3 && viewMode === 'map' && !!pointer;
    if (!visible) {
      dom.mapFingerCursorEl.classList.add('hidden');
      dom.mapFingerCursorEl.setAttribute('aria-hidden', 'true');
      dom.mapFingerCursorEl.style.transform = 'translate(-9999px, -9999px)';
      return;
    }

    dom.mapFingerCursorEl.classList.remove('hidden');
    dom.mapFingerCursorEl.setAttribute('aria-hidden', 'false');

    // Cursor is 36px; center it.
    dom.mapFingerCursorEl.style.transform = 'translate(' + (pointer.x - 18) + 'px, ' + (pointer.y - 18) + 'px)';
  }

  function startDrag(pointer) {
    var hit = getEventTargetAt(pointer);
    dragTarget = hit.target || document.body;
    dragPointerId = 1;
    dragActive = true;

    dispatchPointerMouse(dragTarget, 'pointerdown', 'mousedown', pointer, {
      pointerId: dragPointerId,
      buttons: 1,
      button: 0
    });
  }

  function continueDrag(pointer) {
    if (!dragTarget) dragTarget = document.body;
    dispatchPointerMouse(dragTarget, 'pointermove', 'mousemove', pointer, {
      pointerId: dragPointerId,
      buttons: 1,
      button: 0
    });
  }

  function endDrag(pointer) {
    var pos = pointer || lastPointerViewport;
    if (!dragTarget || !pos) {
      dragActive = false;
      dragTarget = null;
      return;
    }

    dispatchPointerMouse(dragTarget, 'pointerup', 'mouseup', pos, {
      pointerId: dragPointerId,
      buttons: 0,
      button: 0
    });

    dragActive = false;
    dragTarget = null;
  }

  function dispatchClickAt(pointer) {
    var hit = getEventTargetAt(pointer);
    var target = hit.target || document.body;

    dispatchPointerMouse(target, 'pointerdown', 'mousedown', pointer, { pointerId: 1, buttons: 1, button: 0 });
    dispatchPointerMouse(target, 'pointerup', 'mouseup', pointer, { pointerId: 1, buttons: 0, button: 0 });

    try {
      target.dispatchEvent(new MouseEvent('click', {
        bubbles: true,
        cancelable: true,
        view: window,
        clientX: pointer.x,
        clientY: pointer.y,
        button: 0
      }));
    } catch {}
  }

  function getEventTargetAt(pointer) {
    var el = document.elementFromPoint(pointer.x, pointer.y);
    if (!el) return { target: document.body };

    if (el.tagName === 'IFRAME') {
      try {
        var iframe = el;
        var rect = iframe.getBoundingClientRect();
        var innerX = pointer.x - rect.left;
        var innerY = pointer.y - rect.top;
        var doc = iframe.contentWindow && iframe.contentWindow.document;
        if (doc && typeof doc.elementFromPoint === 'function') {
          var innerTarget = doc.elementFromPoint(innerX, innerY);
          if (innerTarget) return { target: innerTarget };
        }
      } catch (err) {
        if (!crossOriginClickWarned) {
          crossOriginClickWarned = true;
          console.warn('Gesture click/drag: iframe appears cross-origin; cannot dispatch events into its document.');
        }
      }
      return { target: el };
    }

    return { target: el };
  }

  function dispatchPointerMouse(target, pointerType, mouseType, pointer, options) {
    options = options || {};
    var pointerId = typeof options.pointerId === 'number' ? options.pointerId : 1;
    var buttons = typeof options.buttons === 'number' ? options.buttons : 0;
    var button = typeof options.button === 'number' ? options.button : 0;

    try {
      target.dispatchEvent(new PointerEvent(pointerType, {
        bubbles: true,
        cancelable: true,
        view: window,
        clientX: pointer.x,
        clientY: pointer.y,
        pointerId: pointerId,
        pointerType: 'mouse',
        isPrimary: true,
        buttons: buttons,
        button: button
      }));
    } catch {}

    try {
      target.dispatchEvent(new MouseEvent(mouseType, {
        bubbles: true,
        cancelable: true,
        view: window,
        clientX: pointer.x,
        clientY: pointer.y,
        buttons: buttons,
        button: button
      }));
    } catch {}
  }

  function distance(a, b) {
    var dx = a.x - b.x;
    var dy = a.y - b.y;
    return Math.sqrt(dx * dx + dy * dy);
  }

  function setButtonsRunning(isRunning) {
    if (isRunning) {
      dom.startBtn.style.display = 'none';
      dom.stopBtn.style.display = 'inline-block';
    } else {
      dom.startBtn.style.display = 'inline-block';
      dom.stopBtn.style.display = 'none';
    }
  }

  function updateBackState() {
    var visible = stage !== 1;
    dom.backBtn.classList.toggle('hidden', !visible);
    dom.backBtn.disabled = !visible;
  }

  function updateCameraSelectVisibility() {
    var visible = stage === 1;
    dom.cameraSelectRowEl.classList.toggle('hidden', !visible);
    if (!visible) closeCameraSourceModal();
  }

  async function refreshAvailableCameras() {
    if (!navigator.mediaDevices || !navigator.mediaDevices.enumerateDevices) return;

    try {
      var devices = await navigator.mediaDevices.enumerateDevices();
      availableVideoDevices = devices.filter(function (d) {
        return d && d.kind === 'videoinput';
      });
      renderCameraDeviceSelects();
    } catch (err) {
      console.warn('Failed to enumerate camera devices:', err);
    }
  }

  function getSelectedCameraSource() {
    var selectEl = dom.cameraDeviceSelectsEl.querySelector('select[data-camera-index=\"0\"]');
    if (!selectEl) return null;
    var id = String(selectEl.value || '').trim();
    if (!id) return null;

    if (id.startsWith('ip:')) {
      return { type: 'ip', url: id.slice(3) };
    }

    return { type: 'device', deviceId: id };
  }

  function renderCameraDeviceSelects() {
    var count = parseInt(dom.cameraCountSelectEl.value, 10);
    if (isNaN(count) || count < 0) count = 0;
    if (count > 2) count = 2;

    var previousValues = [];
    var existing = dom.cameraDeviceSelectsEl.querySelectorAll('select');
    for (var i = 0; i < existing.length; i++) {
      previousValues[i] = existing[i].value;
    }

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

      for (var d = 0; d < availableVideoDevices.length; d++) {
        var device = availableVideoDevices[d];
        var opt = document.createElement('option');
        opt.value = device.deviceId || '';

        var label = device.label;
        if (!label) label = 'Camera ' + (d + 1);
        opt.textContent = label;
        selectEl.appendChild(opt);
      }

      if (customCameraSources.length > 0) {
        var group = document.createElement('optgroup');
        group.label = 'IP camera sources';

        for (var s = 0; s < customCameraSources.length; s++) {
          var url = customCameraSources[s];
          var opt2 = document.createElement('option');
          opt2.value = 'ip:' + url;
          opt2.textContent = url;
          group.appendChild(opt2);
        }

        selectEl.appendChild(group);
      }

      if (previousValues[index]) {
        selectEl.value = previousValues[index];
      } else if (availableVideoDevices[index] && availableVideoDevices[index].deviceId) {
        selectEl.value = availableVideoDevices[index].deviceId;
      }

      dom.cameraDeviceSelectsEl.appendChild(selectEl);
    }
  }

  function openCameraSourceModal() {
    dom.cameraSourceInputEl.value = '';
    dom.cameraSourceModalEl.classList.remove('hidden');
    dom.cameraSourceModalEl.setAttribute('aria-hidden', 'false');
    setTimeout(function () {
      dom.cameraSourceInputEl.focus();
    }, 0);
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

    if (customCameraSources.indexOf(raw) === -1) {
      customCameraSources.push(raw);
      saveCustomCameraSources(customCameraSources);
    }

    closeCameraSourceModal();
    renderCameraDeviceSelects();
  }

  async function startIpCamera(url) {
    stopCameraStream(currentStream);
    currentStream = null;

    usingIpCamera = true;
    pixelReadBlockedNotified = false;

    if (!ipCameraImg) {
      ipCameraImg = document.createElement('img');
      ipCameraImg.alt = 'IP camera';
      ipCameraImg.id = 'ipCameraImage';
      ipCameraImg.decoding = 'async';
      ipCameraImg.loading = 'eager';
      ipCameraImg.style.width = '100%';
      ipCameraImg.style.height = 'auto';
      ipCameraImg.style.borderRadius = '8px';
      ipCameraImg.style.background = '#000';
      ipCameraImg.style.display = 'block';
      ipCameraImg.crossOrigin = 'anonymous';
      // Insert before the overlay so overlay is on top
      videoContainer.insertBefore(ipCameraImg, dom.overlay);
    }

    dom.video.classList.add('hidden');

    try {
      await waitForImageLoad(ipCameraImg, url);
    } catch (err) {
      cameraStarting = false;
      cameraReady = false;
      updateLoadingMessage();
      dom.startBtn.disabled = false;
      setNextEnabled(false);
      setError('Failed to load IP camera URL.');
      return;
    }

    var w = ipCameraImg.naturalWidth || 640;
    var h = ipCameraImg.naturalHeight || 480;

    // Set canvas internal dimensions to match image native resolution
    dom.overlay.width = w;
    dom.overlay.height = h;
    captureCanvas.width = w;
    captureCanvas.height = h;

    // Ensure overlay canvas has same display aspect ratio as image
    // The CSS width:100% handles horizontal, we need to set height proportionally
    dom.overlay.style.height = 'auto';
    dom.overlay.style.aspectRatio = w + ' / ' + h;

    console.log('IP camera dimensions:', w, 'x', h);

    setButtonsRunning(true);
    cameraStarting = false;
    cameraReady = true;
    updateLoadingMessage();
    setNextEnabled(true);

    if (apriltagEnabled) {
      loadDetectorIfNeeded();
    }

    // Start second camera if in stereo mode (same logic as regular camera path)
    var cameraCount = parseInt(dom.cameraCountSelectEl.value, 10);
    stereoMode = cameraCount === 2;
    if (stereoMode) {
      var secondCameraOk = await startSecondCamera();
      if (!secondCameraOk) {
        setError('Failed to start second camera. Stereo mode disabled.');
        stereoMode = false;
      }
    }
    updateStereoUIVisibility();

    startProcessing();
  }

  function stopIpCameraIfRunning() {
    if (!usingIpCamera) return;
    usingIpCamera = false;

    if (ipCameraImg) {
      try {
        ipCameraImg.src = '';
      } catch {}
    }
  }

  function setError(text) {
    dom.errorEl.textContent = text;
  }

  function updateMapFingerDots(cameraPoints) {
    if (!surfaceHomography) {
      setMapFingerDotsVisible(false);
      return;
    }

    var w = dom.mapWarpEl.offsetWidth;
    var h = dom.mapWarpEl.offsetHeight;
    if (!w || !h) {
      setMapFingerDotsVisible(false);
      return;
    }

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
    var tolerance = 0.12;

    for (var i = 0; i < required; i++) {
      var point = cameraPoints[i];
      var dotEl = dom.mapFingerDotsEl.children[i];

      var uv = applyHomography(surfaceHomography, point.x, point.y);
      if (!uv || uv.x < -tolerance || uv.x > 1 + tolerance || uv.y < -tolerance || uv.y > 1 + tolerance) {
        dotEl.classList.add('hidden');
        continue;
      }

      var u = clamp01(uv.x);
      var v = clamp01(uv.y);
      var x = u * w;
      var y = v * h;

      // Dot is 14px; center it.
      dotEl.style.transform = 'translate(' + (x - 7) + 'px, ' + (y - 7) + 'px)';
      dotEl.classList.remove('hidden');
      anyVisible = true;
    }

    setMapFingerDotsVisible(anyVisible);
  }
}

function clamp01(value) {
  if (value < 0) return 0;
  if (value > 1) return 1;
  return value;
}

function cloneSticker(templateEl) {
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

  // draw
  var drawEl = document.createElement('canvas');
  drawEl.className = 'ui-draw ui-sticker-instance';
  drawEl.dataset.uiType = 'draw';
  drawEl.dataset.color = templateEl.dataset && templateEl.dataset.color ? templateEl.dataset.color : '#2bb8ff';
  drawEl.width = 24;
  drawEl.height = 24;
  drawEl.style.left = templateEl.style.left || '0px';
  drawEl.style.top = templateEl.style.top || '0px';

  // Copy pixels from template canvas if possible.
  try {
    var srcCanvas = templateEl;
    var ctx = drawEl.getContext('2d');
    if (ctx && srcCanvas && srcCanvas.width && srcCanvas.height) {
      ctx.drawImage(srcCanvas, 0, 0, drawEl.width, drawEl.height);
    }
  } catch {}

  templateEl.parentElement.appendChild(drawEl);
  return drawEl;
}

function startStickerDrag(el, startEvent) {
  if (!el || !startEvent) return;
  var draggingClass = el.classList.contains('ui-dot') ? 'ui-dot--dragging' : 'ui-draw--dragging';

  var rect = el.getBoundingClientRect();
  var offsetX = startEvent.clientX - rect.left;
  var offsetY = startEvent.clientY - rect.top;
  var pointerId = startEvent.pointerId;

  el.classList.add(draggingClass);
  try { el.setPointerCapture(pointerId); } catch {}

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
    try { el.releasePointerCapture(pointerId); } catch {}
    document.removeEventListener('pointermove', onMove, true);
    document.removeEventListener('pointerup', onEnd, true);
    document.removeEventListener('pointercancel', onEnd, true);
  }

  document.addEventListener('pointermove', onMove, true);
  document.addEventListener('pointerup', onEnd, true);
  document.addEventListener('pointercancel', onEnd, true);
}

function clamp(value, min, max) {
  if (value < min) return min;
  if (value > max) return max;
  return value;
}

function loadNumberSetting(key, fallback, min, max) {
  try {
    var raw = localStorage.getItem(String(key));
    if (raw === null || raw === undefined || raw === '') return fallback;
    var v = parseFloat(raw);
    if (!isFinite(v)) return fallback;
    if (typeof min === 'number') v = Math.max(min, v);
    if (typeof max === 'number') v = Math.min(max, v);
    return v;
  } catch {
    return fallback;
  }
}

function saveNumberSetting(key, value) {
  try {
    if (!isFinite(value)) return;
    localStorage.setItem(String(key), String(value));
  } catch {}
}

function loadCustomCameraSources() {
  try {
    var raw = localStorage.getItem('customCameraSources');
    if (!raw) return [];
    var parsed = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    return parsed
      .filter(function (v) {
        return typeof v === 'string' && v.trim();
      })
      .map(function (v) {
        return v.trim();
      });
  } catch {
    return [];
  }
}

function saveCustomCameraSources(sources) {
  try {
    localStorage.setItem('customCameraSources', JSON.stringify(sources || []));
  } catch {}
}

function waitForImageLoad(imgEl, url) {
  return new Promise(function (resolve, reject) {
    var settled = false;

    function cleanup() {
      imgEl.removeEventListener('load', onLoad);
      imgEl.removeEventListener('error', onError);
    }

    function onLoad() {
      if (settled) return;
      settled = true;
      cleanup();
      resolve();
    }

    function onError() {
      if (settled) return;
      settled = true;
      cleanup();
      reject(new Error('Image load failed'));
    }

    imgEl.addEventListener('load', onLoad, { once: true });
    imgEl.addEventListener('error', onError, { once: true });

    // Bust caches so snapshot endpoints update.
    var cacheBustedUrl = url;
    if (url.indexOf('?') >= 0) cacheBustedUrl = url + '&_t=' + Date.now();
    else cacheBustedUrl = url + '?_t=' + Date.now();

    imgEl.src = cacheBustedUrl;
  });
}

function applyHomography(H, x, y) {
  var denom = H[6] * x + H[7] * y + H[8];
  if (!denom) return null;

  return {
    x: (H[0] * x + H[1] * y + H[2]) / denom,
    y: (H[3] * x + H[4] * y + H[5]) / denom,
  };
}

function computeHomography(src, dst) {
  if (!src || !dst || src.length !== 4 || dst.length !== 4) return null;

  var A = [];
  var b = [];

  for (var i = 0; i < 4; i++) {
    var x = src[i].x;
    var y = src[i].y;
    var u = dst[i].x;
    var v = dst[i].y;

    A.push([x, y, 1, 0, 0, 0, -u * x, -u * y]);
    b.push(u);
    A.push([0, 0, 0, x, y, 1, -v * x, -v * y]);
    b.push(v);
  }

  var h = solveLinearSystem(A, b);
  if (!h) return null;

  return [h[0], h[1], h[2], h[3], h[4], h[5], h[6], h[7], 1];
}

function solveLinearSystem(A, b) {
  var n = b.length;
  var M = [];

  for (var i = 0; i < n; i++) {
    M[i] = A[i].slice();
    M[i].push(b[i]);
  }

  for (var col = 0; col < n; col++) {
    var pivot = col;
    for (var row = col + 1; row < n; row++) {
      if (Math.abs(M[row][col]) > Math.abs(M[pivot][col])) pivot = row;
    }

    if (Math.abs(M[pivot][col]) < 1e-12) return null;

    if (pivot !== col) {
      var tmp = M[col];
      M[col] = M[pivot];
      M[pivot] = tmp;
    }

    var div = M[col][col];
    for (var c = col; c <= n; c++) {
      M[col][c] = M[col][c] / div;
    }

    for (var r = 0; r < n; r++) {
      if (r === col) continue;
      var factor = M[r][col];
      if (!factor) continue;
      for (var c2 = col; c2 <= n; c2++) {
        M[r][c2] = M[r][c2] - factor * M[col][c2];
      }
    }
  }

  var x = new Array(n);
  for (var i = 0; i < n; i++) {
    x[i] = M[i][n];
  }
  return x;
}

function cameraErrorMessage(err) {
  if (!err || typeof err !== 'object') return 'Error accessing camera.';
  if (err.name === 'NotAllowedError') return 'Camera access denied. Please allow camera permissions.';
  if (err.name === 'NotFoundError') return 'No camera found on this device.';
  return 'Error accessing camera: ' + (err.message || String(err));
}
