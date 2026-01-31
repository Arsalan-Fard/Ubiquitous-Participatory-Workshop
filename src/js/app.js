/**
 * Main application entry point
 * Coordinates all modules and handles frame processing
 */

import { getDom } from './dom.js';
import { startCameraStream, stopCameraStream, waitForVideoMetadata, startCameraById } from './camera.js';
import { initDetector } from './detector.js';
import { initHandDetector } from './handDetector.js';
import { rgbaToGrayscale } from './grayscale.js';
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
  startStickerDrag
} from './stage4Drawing.js';

export function initApp() {
  // Initialize DOM and state
  var dom = getDom();
  state.dom = dom;

  state.overlayCtx = dom.overlay.getContext('2d');
  state.captureCanvas = document.createElement('canvas');
  state.captureCtx = state.captureCanvas.getContext('2d', { willReadFrequently: true });
  state.apriltagEnabled = dom.apriltagToggleEl.checked;

  var videoContainer = document.getElementById('videoContainer1');
  var videoContainer2 = document.getElementById('videoContainer2');

  // Initialize hand detector
  initHandDetector({ videoContainer: videoContainer }).then(function(h) {
    state.handDetector = h;
    state.handDetectorReady = true;
    updateLoadingMessage();
  });

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
  dom.apriltagToggleEl.addEventListener('change', onApriltagToggleChanged);
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
  updateHamburgerMenuVisibility();
  updateBackState();
  updateCameraSelectVisibility();
  renderCameraDeviceSelects();
  refreshAvailableCameras();
  closeCameraSourceModal();
  updateStereoUIVisibility(videoContainer2);

  // Gesture control sliders
  dom.pinchThresholdSliderEl.value = String(Math.round(state.pinchDistanceThresholdPx));
  dom.pinchThresholdValueEl.textContent = String(Math.round(state.pinchDistanceThresholdPx));
  dom.pinchThresholdSliderEl.addEventListener('input', function() {
    var v = parseFloat(dom.pinchThresholdSliderEl.value);
    if (!isFinite(v)) return;
    state.pinchDistanceThresholdPx = clamp(v, 10, 120);
    dom.pinchThresholdValueEl.textContent = String(Math.round(state.pinchDistanceThresholdPx));
    saveNumberSetting('pinchDistanceThresholdPx', state.pinchDistanceThresholdPx);
  });

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

  dom.fingerSmoothingSliderEl.value = String(state.fingerSmoothingFactor.toFixed(2));
  dom.fingerSmoothingValueEl.textContent = state.fingerSmoothingFactor.toFixed(2);
  dom.fingerSmoothingSliderEl.addEventListener('input', function() {
    var v = parseFloat(dom.fingerSmoothingSliderEl.value);
    if (!isFinite(v)) return;
    state.fingerSmoothingFactor = clamp(v, 0.1, 1.0);
    dom.fingerSmoothingValueEl.textContent = state.fingerSmoothingFactor.toFixed(2);
    saveNumberSetting('fingerSmoothingFactor', state.fingerSmoothingFactor);
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
    } else if (state.cameraReady && !state.handDetectorReady) {
      showLoading('Loading hand detection...');
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
      updateHamburgerMenuVisibility();
      setStage4DrawMode(false);
      updateStage4MapInteractivity();
      updateStickerMappingForCurrentView();
      resetStage3Gestures();
      resumeProcessingIfReady();
    }
  }

  function onApriltagToggleChanged() {
    state.apriltagEnabled = dom.apriltagToggleEl.checked;
    if (!state.apriltagEnabled) {
      clearOverlay(state.overlayCtx, dom.overlay);
    } else {
      loadDetectorIfNeeded();
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
    initDetector().then(function(d) {
      state.detector = d;
      state.detectorLoading = false;
    }, function(err) {
      console.error('Failed to initialize detector:', err);
      state.detectorLoading = false;
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

      if (state.apriltagEnabled) loadDetectorIfNeeded();

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

      state.handDetector2 = await initHandDetector({ videoContainer: videoContainer2, instanceId: 'camera2' });
      state.handDetectorReady2 = !!state.handDetector2;
      return true;
    } catch (err) {
      console.error('Failed to start second camera:', err);
      return false;
    }
  }

  function stopSecondCamera() {
    if (state.currentStream2) { stopCameraStream(state.currentStream2); state.currentStream2 = null; }
    if (state.handDetector2 && state.handDetector2.destroy) { state.handDetector2.destroy(); state.handDetector2 = null; state.handDetectorReady2 = false; }
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

    if (state.apriltagEnabled) loadDetectorIfNeeded();

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

    var hands = [];
    var hands2 = [];
    var imageData2 = null;

    // Hand detection camera 1
    if (state.handDetector) {
      try {
        hands = (await state.handDetector.detect(imageData.data, width, height)) || [];
      } catch (err) {
        console.error('Hand detection error (camera 1):', err);
      }
    }

    // Hand detection camera 2 (stereo mode)
    var fingertip2 = null;
    if (state.stereoMode && state.handDetector2 && state.captureCanvas2 && state.captureCtx2) {
      try {
        var video2 = document.getElementById('video2');
        if (video2 && video2.readyState >= 2) {
          var w2 = state.captureCanvas2.width;
          var h2 = state.captureCanvas2.height;
          state.captureCtx2.drawImage(video2, 0, 0, w2, h2);
          imageData2 = state.captureCtx2.getImageData(0, 0, w2, h2);
          hands2 = (await state.handDetector2.detect(imageData2.data, w2, h2)) || [];

          if (hands2.length > 0) {
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
      }
    }

    // Extract fingertips from camera 1
    var indexTipPoint = null;
    var indexTipPoints = [];

    if (hands.length > 0) {
      for (var i = 0; i < hands.length; i++) {
        var hand = hands[i];
        if (!hand || !hand.landmarks || hand.landmarks.length <= 8) continue;

        var tip = hand.landmarks[8];
        var pinchDistance = typeof hand.pinchDistance === 'number' ? hand.pinchDistance : null;
        var handScale = null;

        if (hand.landmarks.length > 17) {
          var lm5 = hand.landmarks[5];
          var lm17 = hand.landmarks[17];
          if (lm5 && lm17) {
            var dxs = lm5.x - lm17.x;
            var dys = lm5.y - lm17.y;
            handScale = Math.sqrt(dxs * dxs + dys * dys);
          }
        }

        if (!handScale && hand.landmarks.length > 9) {
          var lm0 = hand.landmarks[0];
          var lm9 = hand.landmarks[9];
          if (lm0 && lm9) {
            var dxs2 = lm0.x - lm9.x;
            var dys2 = lm0.y - lm9.y;
            handScale = Math.sqrt(dxs2 * dxs2 + dys2 * dys2);
          }
        }

        var pinchRatio = (pinchDistance !== null && handScale && handScale > 1e-6) ? pinchDistance / handScale : null;

        // Use handedness as stable identifier, fallback to index if not available
        var handId = hand.handedness || ('hand' + i);

        // Apply exponential smoothing to reduce jitter
        var smoothedX = tip.x;
        var smoothedY = tip.y;
        var smoothingFactor = state.fingerSmoothingFactor;

        if (state.smoothedFingerPositions[handId]) {
          var prev = state.smoothedFingerPositions[handId];
          smoothedX = prev.x + smoothingFactor * (tip.x - prev.x);
          smoothedY = prev.y + smoothingFactor * (tip.y - prev.y);
        }

        state.smoothedFingerPositions[handId] = { x: smoothedX, y: smoothedY };

        indexTipPoints.push({
          x: smoothedX,
          y: smoothedY,
          pinchDistance: pinchDistance,
          pinchRatio: pinchRatio,
          handedness: hand.handedness || null,
          handId: handId
        });
      }

      if (indexTipPoints.length > 0) {
        indexTipPoint = indexTipPoints[0];
        state.lastIndexTipPoint = indexTipPoint;
        state.lastIndexTipPoints = indexTipPoints;
        state.lastIndexTipTimeMs = performance.now();
      }

      // Clean up smoothed positions for hands no longer visible
      var activeHandIds = {};
      for (var j = 0; j < indexTipPoints.length; j++) {
        activeHandIds[indexTipPoints[j].handId] = true;
      }
      for (var hid in state.smoothedFingerPositions) {
        if (!activeHandIds[hid]) {
          delete state.smoothedFingerPositions[hid];
        }
      }
    }

    // Use recent fingertip if current frame has none
    var usableIndexTipPoint = indexTipPoint;
    var usableIndexTipPoints = indexTipPoints;
    if (!indexTipPoint && state.lastIndexTipPoints && performance.now() - state.lastIndexTipTimeMs < 150) {
      usableIndexTipPoints = state.lastIndexTipPoints;
      usableIndexTipPoint = state.lastIndexTipPoint;
    }

    var isSurfaceSetupCameraView = (state.stage === 2 || state.stage === 3) && state.viewMode === 'camera';

    // Single camera corner capture
    if (!state.stereoMode && isSurfaceSetupCameraView && state.armedCornerCaptureRequested && state.armedCornerIndex !== null && usableIndexTipPoint) {
      state.surfaceCorners[state.armedCornerIndex] = usableIndexTipPoint;
      flashCornerButton(state.armedCornerIndex);
      clearArmedCorner();
      updateSurfaceButtonsUI();
      recomputeSurfaceHomographyIfReady();
    }

    // Stereo calibration capture
    if (state.stereoMode && isSurfaceSetupCameraView && state.stereoArmedPointIndex !== null && usableIndexTipPoint && fingertip2) {
      captureStereoCalibPoint(usableIndexTipPoint, fingertip2);
    }

    // Stereo triangulation for touch detection
    if (state.stereoMode && state.stereoCalibrationReady && usableIndexTipPoint && fingertip2) {
      var worldPoint = triangulatePoint(state.stereoProjectionMatrix1, state.stereoProjectionMatrix2, usableIndexTipPoint, fingertip2);
      if (worldPoint) updateTouchIndicator(worldPoint);
    }

    // Draw calibration overlays
    if (isSurfaceSetupCameraView) {
      if (state.stereoMode) {
        drawStereoCalibPoints(state.overlayCtx, state.stereoCalibrationPoints, 'camera1Pixel', {
          armedIndex: state.stereoArmedPointIndex,
          previewPoint: usableIndexTipPoint
        });

        var overlay2 = document.getElementById('overlay2');
        if (overlay2) {
          var ctx2 = overlay2.getContext('2d');
          if (ctx2) {
            ctx2.clearRect(0, 0, overlay2.width, overlay2.height);
            drawStereoCalibPoints(ctx2, state.stereoCalibrationPoints, 'camera2Pixel', {
              armedIndex: state.stereoArmedPointIndex,
              previewPoint: fingertip2
            });
          }
        }
      } else {
        drawSurface(state.overlayCtx, state.surfaceCorners, {
          previewIndex: state.armedCornerIndex,
          previewPoint: state.armedCornerIndex !== null ? usableIndexTipPoint : null
        });
      }
    }

    // Map finger dots (show in Stage 2, 3, and 4)
    var isMapViewWithHomography = (state.stage === 2 || state.stage === 3 || state.stage === 4) && state.viewMode === 'map';
    var allowFingerDots = !(state.stage3InputMode === 'apriltag' && (state.stage === 3 || state.stage === 4));
    if (allowFingerDots && isMapViewWithHomography && state.surfaceHomography && usableIndexTipPoints && usableIndexTipPoints.length > 0) {
      updateMapFingerDots(usableIndexTipPoints);
    } else {
      setMapFingerDotsVisible(false);
    }

    // Gesture handling (dwell-to-click and pinch-to-drag for Stage 3 and 4)
    if ((state.stage === 3 || state.stage === 4) && state.viewMode === 'map') {
      if (state.stage3InputMode === 'apriltag') {
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
              isTouch: touchInfo ? !!touchInfo.isTouch : null,
              // Make it behave like "pinching" so pinch-hold UI can be reused.
              pinchDistance: 0,
              pinchRatio: 0
            });
          }
        }
        handleStage3Gestures(apriltagPoints);
      } else {
        handleStage3Gestures(usableIndexTipPoints);
      }
    } else {
      resetStage3Gestures();
    }

    // AprilTag detection (keep latest results for map debug dots and AprilTag gestures)
    if (state.apriltagEnabled && state.detector) {
      try {
        var grayscale = rgbaToGrayscale(imageData);
        var detections = await state.detector.detect(grayscale, width, height);
        state.lastApriltagDetections = detections || [];

        if (state.viewMode === 'camera') {
          updateApriltagHud(dom.apriltagHudEl, state.lastApriltagDetections, width, height);
          // Keep canvas drawing too (useful on platforms where it renders correctly).
          if (detections && detections.length > 0) {
            drawDetections(state.overlayCtx, detections);
          }
        } else {
          updateApriltagHud(dom.apriltagHudEl, null, width, height);
        }

        // Stereo AprilTag touch/hover classification (cancel pinch while hovering)
        if (state.stage3InputMode === 'apriltag' && state.stereoMode && state.stereoCalibrationReady && imageData2) {
          try {
            var grayscale2 = rgbaToGrayscale(imageData2);
            var detections2 = await state.detector.detect(grayscale2, imageData2.width, imageData2.height);
            state.lastApriltagDetections2 = detections2 || [];
            if (state.viewMode === 'camera') {
              updateApriltagHud(dom.apriltagHud2El, state.lastApriltagDetections2, imageData2.width, imageData2.height);
            } else {
              updateApriltagHud(dom.apriltagHud2El, null, imageData2.width, imageData2.height);
            }

            var touchById = {};

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

            if (Array.isArray(state.stage3ParticipantTagIds)) {
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
            }

            state.apriltagTouchById = touchById;
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
    if (state.stage3InputMode !== 'apriltag') { setMapApriltagDotsVisible(false); return; }
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
