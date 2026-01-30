import { getDom } from './dom.js';
import { startCameraStream, stopCameraStream, waitForVideoMetadata } from './camera.js';
import { initDetector } from './detector.js';
import { initHandDetector } from './handDetector.js';
import { rgbaToGrayscale } from './grayscale.js';
import { clearOverlay, drawDetections, drawSurface } from './render.js';
import { initUiSetup } from './uiSetup.js';
import { createHandPointer } from './handPointer.js';

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
  var handPointer = createHandPointer();
  var pinchPressed = false;
  var lastGestureHandTimeMs = 0;
  var lastPinchLogMs = 0;
  var handDebugEl = null;
  var availableVideoDevices = [];
  var customCameraSources = loadCustomCameraSources();
  var ipCameraImg = null;
  var usingIpCamera = false;
  var pixelReadBlockedNotified = false;

  var videoContainer = document.querySelector('.video-container');
  initHandDetector({ videoContainer: videoContainer }).then(function (h) {
    handDetector = h;
    handDetectorReady = true;
    updateLoadingMessage();
  });

  initUiSetup({ panelEl: dom.uiSetupPanelEl, overlayEl: dom.uiSetupOverlayEl });
  handDebugEl = initHandDebug(dom.mapViewEl);

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

  setStage(1);
  setViewMode('camera');
  setNextEnabled(false);
  updateSurfaceButtonsUI();
  updateUiSetupPanelVisibility();
  updateBackState();
  updateCameraSelectVisibility();
  renderCameraDeviceSelects();
  refreshAvailableCameras();
  closeCameraSourceModal();

  logScreenInfo('init');
  window.addEventListener(
    'resize',
    function () {
      // Keep the camera->viewport mapping valid when the browser window changes size.
      if (areSurfaceCornersReady()) recomputeSurfaceHomographyIfReady();
      logScreenInfo('resize');
    },
    { passive: true }
  );

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
    } else {
      dom.apriltagToggleContainerEl.classList.remove('hidden');
      dom.viewToggleContainerEl.classList.add('hidden');
    }

    if (stage === 2) {
      dom.surfaceButtonsEl.classList.remove('hidden');
      setViewMode(dom.viewToggleEl.checked ? 'map' : 'camera');
    } else if (stage === 3) {
      dom.surfaceButtonsEl.classList.add('hidden');
      dom.viewToggleEl.checked = true;
      setViewMode('map');
    } else {
      dom.surfaceButtonsEl.classList.add('hidden');
      setViewMode('camera');
    }

    updateUiSetupPanelVisibility();
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
    if (stage !== 2 && stage !== 3) return;
    setViewMode(dom.viewToggleEl.checked ? 'map' : 'camera');
  }

  function setViewMode(mode) {
    viewMode = mode === 'map' ? 'map' : 'camera';

    if (viewMode === 'map') {
      dom.mapViewEl.classList.remove('hidden');
      dom.mapViewEl.setAttribute('aria-hidden', 'false');
      dom.viewToggleContainerEl.classList.add('toggle-floating');
      initMaptasticIfNeeded();
      // Keep processing running so we can track the index fingertip and project it onto the map.
      updateUiSetupPanelVisibility();
      return;
    }

    dom.mapViewEl.classList.add('hidden');
    dom.mapViewEl.setAttribute('aria-hidden', 'true');
    dom.viewToggleContainerEl.classList.remove('toggle-floating');
    setMapFingerDotsVisible(false);
    updateUiSetupPanelVisibility();
    resumeProcessingIfReady();
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
    var visible = stage === 3 && viewMode === 'map';

    if (visible) {
      dom.uiSetupPanelEl.classList.remove('hidden');
      dom.uiSetupPanelEl.setAttribute('aria-hidden', 'false');
      dom.uiSetupOverlayEl.classList.remove('hidden');
      dom.uiSetupOverlayEl.setAttribute('aria-hidden', 'false');
      setHandDebugVisible(true);
      return;
    }

    dom.uiSetupPanelEl.classList.add('hidden');
    dom.uiSetupPanelEl.setAttribute('aria-hidden', 'true');
    dom.uiSetupOverlayEl.classList.add('hidden');
    dom.uiSetupOverlayEl.setAttribute('aria-hidden', 'true');
    setHandDebugVisible(false);
  }

  function areSurfaceCornersReady() {
    return !!(surfaceCorners[0] && surfaceCorners[1] && surfaceCorners[2] && surfaceCorners[3]);
  }

  function recomputeSurfaceHomographyIfReady() {
    if (!areSurfaceCornersReady()) {
      surfaceHomography = null;
      return;
    }

    // Map the physical surface (captured in camera pixels) directly to the browser viewport (client pixels).
    // This makes finger interactions line up with what is rendered in the window.
    var viewportW = Math.max(1, window.innerWidth || 1);
    var viewportH = Math.max(1, window.innerHeight || 1);

    surfaceHomography = computeHomography(surfaceCorners, [
      { x: 0, y: 0 },
      { x: viewportW, y: 0 },
      { x: viewportW, y: viewportH },
      { x: 0, y: viewportH },
    ]);

    if (!surfaceHomography) {
      console.warn('Surface homography could not be computed (degenerate corners).');
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

    // Hand detection (hand skeleton drawing happens in iframe)
    if (handDetector) {
      try {
        hands = (await handDetector.detect(imageData.data, width, height)) || [];
      } catch (err) {
        console.error('Hand detection error:', err);
        hands = [];
      }
    }

    var indexTipPoint = null;
    var indexTipPoints = [];

    if (hands && hands.length > 0) {
      for (var i = 0; i < hands.length; i++) {
        var hand = hands[i];
        if (!hand || !hand.landmarks || hand.landmarks.length <= 8) continue;
        var tip = hand.landmarks[8];
        indexTipPoints.push({ x: tip.x, y: tip.y });
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

    if (
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

    if (isSurfaceSetupCameraView) {
      drawSurface(overlayCtx, surfaceCorners, {
        previewIndex: armedCornerIndex,
        previewPoint: armedCornerIndex !== null ? usableIndexTipPoint : null,
      });
    }

    updateHandPinchInteractions(hands, width, height);
    updateStage3HandDebug(hands);

    var isSurfaceSetupMapView = (stage === 2 || stage === 3) && viewMode === 'map';
    if (isSurfaceSetupMapView && surfaceHomography && usableIndexTipPoints && usableIndexTipPoints.length > 0) {
      updateMapFingerDots(usableIndexTipPoints);
    } else {
      setMapFingerDotsVisible(false);
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

  function updateHandPinchInteractions(hands, captureWidth, captureHeight) {
    // Enable pinch interactions once we have a camera->viewport homography.
    // Keep it active in both camera/map views so UI controls (like the map toggle) are clickable by pinching.
    if ((stage !== 2 && stage !== 3) || !surfaceHomography) {
      if (pinchPressed) {
        pinchPressed = false;
        handPointer.reset();
      }
      setMapFingerDotsPinchActive(false);
      return;
    }

    // While capturing corners in stage 2 camera view, don't trigger clicks/drags.
    if (stage === 2 && viewMode === 'camera' && armedCornerCaptureRequested) {
      if (pinchPressed) {
        pinchPressed = false;
        handPointer.reset();
      }
      setMapFingerDotsPinchActive(false);
      return;
    }

    var nowMs = performance.now();

    var interactionHand = pickInteractionHand(hands);
    if (!interactionHand || !interactionHand.landmarks || interactionHand.landmarks.length <= 8) {
      // If tracking drops briefly, keep dragging for a moment; then release.
      if (pinchPressed && nowMs - lastGestureHandTimeMs > 200) {
        pinchPressed = false;
        handPointer.reset();
      }
      setMapFingerDotsPinchActive(false);
      return;
    }

    lastGestureHandTimeMs = nowMs;

    var thumbTip = interactionHand.landmarks[4];
    var indexTip = interactionHand.landmarks[8];
    if (!thumbTip || !indexTip) return;

    var pinchDistance2d = Math.hypot(thumbTip.x - indexTip.x, thumbTip.y - indexTip.y);

    // Hysteresis to avoid flicker.
    var minDim = Math.max(1, Math.min(captureWidth || 1, captureHeight || 1));
    // Calibrated against ~640x480 defaults: 40px/480 ~= 0.083, 55px/480 ~= 0.115.
    var pinchDownPx = clamp(minDim * 0.03, 18, 160);
    var pinchUpPx = clamp(minDim * 0.04, 26, 220);
    var wasPinchPressed = pinchPressed;
    if (!pinchPressed && pinchDistance2d < pinchDownPx) pinchPressed = true;
    else if (pinchPressed && pinchDistance2d > pinchUpPx) pinchPressed = false;

    // Use the index fingertip for the cursor position (including click targeting).
    // This matches the stage-3 debug overlay and tends to feel more intuitive for UI interaction.
    var cursorCamPoint = { x: indexTip.x, y: indexTip.y };

    var mapped = applyHomography(surfaceHomography, cursorCamPoint.x, cursorCamPoint.y);
    if (!mapped || typeof mapped.x !== 'number' || typeof mapped.y !== 'number') {
      if (pinchPressed) {
        pinchPressed = false;
        handPointer.reset();
      }
      setMapFingerDotsPinchActive(false);
      return;
    }

    setMapFingerDotsPinchActive(pinchPressed);

    if (pinchPressed !== wasPinchPressed || (pinchPressed && nowMs - lastPinchLogMs > 250)) {
      lastPinchLogMs = nowMs;
      console.log('[hand] pinch', pinchPressed ? 'down' : 'up', {
        client: { x: Math.round(mapped.x), y: Math.round(mapped.y) },
        camera: { x: Math.round(cursorCamPoint.x), y: Math.round(cursorCamPoint.y) },
        pinchDistancePx: Math.round(pinchDistance2d),
        pinchDownPx: Math.round(pinchDownPx),
        pinchUpPx: Math.round(pinchUpPx),
        capture: { width: captureWidth || null, height: captureHeight || null },
        viewport: { width: window.innerWidth, height: window.innerHeight, dpr: window.devicePixelRatio || 1 },
        screen: { width: window.screen && window.screen.width, height: window.screen && window.screen.height },
        viewMode: viewMode,
        stage: stage,
      });
    }

    handPointer.update({
      clientX: mapped.x,
      clientY: mapped.y,
      pressed: pinchPressed,
      nowMs: nowMs,
    });
  }

  function pickInteractionHand(hands) {
    if (!hands || hands.length === 0) return null;

    // Prefer the "most pinched" hand, so pinch intent wins if two hands are visible.
    var best = null;
    var bestDistance = Infinity;

    for (var i = 0; i < hands.length; i++) {
      var hand = hands[i];
      if (!hand || !hand.landmarks || hand.landmarks.length <= 8) continue;
      var thumbTip = hand.landmarks[4];
      var indexTip = hand.landmarks[8];
      if (!thumbTip || !indexTip) continue;

      var d = Math.hypot(thumbTip.x - indexTip.x, thumbTip.y - indexTip.y);
      if (d < bestDistance) {
        bestDistance = d;
        best = hand;
      }
    }

    return best;
  }

  function clamp(value, min, max) {
    if (value < min) return min;
    if (value > max) return max;
    return value;
  }

  function initHandDebug(parentEl) {
    try {
      var el = document.createElement('pre');
      el.className = 'hand-debug hidden';
      el.setAttribute('aria-hidden', 'true');
      el.textContent = '';
      parentEl.appendChild(el);
      return el;
    } catch {
      return null;
    }
  }

  function setHandDebugVisible(visible) {
    if (!handDebugEl) return;
    if (visible) {
      handDebugEl.classList.remove('hidden');
      handDebugEl.setAttribute('aria-hidden', 'false');
      return;
    }
    handDebugEl.classList.add('hidden');
    handDebugEl.setAttribute('aria-hidden', 'true');
  }

  function updateStage3HandDebug(hands) {
    if (!handDebugEl) return;
    if (stage !== 3 || viewMode !== 'map') return;

    var inputEl = dom.uiSetupPanelEl.querySelector('.ui-setup-input');
    var inputRect = null;
    if (inputEl && inputEl.getBoundingClientRect) inputRect = inputEl.getBoundingClientRect();

    var fingerClient = null;
    if (surfaceHomography) {
      var interactionHand = pickInteractionHand(hands);
      if (interactionHand && interactionHand.landmarks && interactionHand.landmarks.length > 8) {
        var indexTip = interactionHand.landmarks[8];
        if (indexTip) {
          var mapped = applyHomography(surfaceHomography, indexTip.x, indexTip.y);
          if (mapped && isFinite(mapped.x) && isFinite(mapped.y)) {
            fingerClient = { x: mapped.x, y: mapped.y };
          }
        }
      }
    }

    var inside = false;
    if (inputRect && fingerClient) {
      inside =
        fingerClient.x >= inputRect.left &&
        fingerClient.x <= inputRect.right &&
        fingerClient.y >= inputRect.top &&
        fingerClient.y <= inputRect.bottom;
    }

    var active = null;
    try {
      active = document.activeElement;
    } catch {}

    var activeInfo = 'N/A';
    if (active) {
      var tag = active.tagName || 'UNKNOWN';
      var id = active.id ? '#' + active.id : '';
      var cls = active.className ? '.' + String(active.className).trim().replace(/\s+/g, '.') : '';
      activeInfo = tag + id + cls;
    }

    var inputFocused = !!(active && inputEl && active === inputEl);

    handDebugEl.textContent =
      'DEBUG (stage 3)\n' +
      'viewport: ' +
      window.innerWidth +
      ' x ' +
      window.innerHeight +
      ' (dpr ' +
      (window.devicePixelRatio || 1) +
      ')\n' +
      'homography: ' +
      (surfaceHomography ? 'ready' : 'not ready') +
      '\n' +
      'pinchPressed: ' +
      (pinchPressed ? 'true' : 'false') +
      '\n' +
      'ui-setup-input rect: ' +
      (inputRect
        ? 'L ' +
          Math.round(inputRect.left) +
          ' T ' +
          Math.round(inputRect.top) +
          ' R ' +
          Math.round(inputRect.right) +
          ' B ' +
          Math.round(inputRect.bottom) +
          ' (W ' +
          Math.round(inputRect.width) +
          ' H ' +
          Math.round(inputRect.height) +
          ')'
        : 'N/A') +
      '\n' +
      'index finger (client): ' +
      (fingerClient ? 'x ' + Math.round(fingerClient.x) + ' y ' + Math.round(fingerClient.y) : 'N/A') +
      '\n' +
      'inside input: ' +
      (inside ? 'YES' : 'NO') +
      '\n' +
      'activeElement: ' +
      activeInfo +
      '\n' +
      'input focused: ' +
      (inputFocused ? 'YES' : 'NO');
  }

  function setMapFingerDotsPinchActive(active) {
    dom.mapFingerDotsEl.classList.toggle('map-finger-dots--pinch', !!active);
  }

  function logScreenInfo(source) {
    try {
      console.log('[hand] screen', source, {
        viewport: { width: window.innerWidth, height: window.innerHeight, dpr: window.devicePixelRatio || 1 },
        screen: { width: window.screen && window.screen.width, height: window.screen && window.screen.height },
      });
    } catch {}
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
      ipCameraImg.decoding = 'async';
      ipCameraImg.loading = 'eager';
      ipCameraImg.style.width = '100%';
      ipCameraImg.style.borderRadius = '8px';
      ipCameraImg.style.background = '#000';
      ipCameraImg.style.display = 'block';
      ipCameraImg.style.objectFit = 'cover';
      ipCameraImg.crossOrigin = 'anonymous';
      videoContainer.insertBefore(ipCameraImg, dom.video.nextSibling);
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
    dom.overlay.width = w;
    dom.overlay.height = h;
    captureCanvas.width = w;
    captureCanvas.height = h;

    setButtonsRunning(true);
    cameraStarting = false;
    cameraReady = true;
    updateLoadingMessage();
    setNextEnabled(true);

    if (apriltagEnabled) {
      loadDetectorIfNeeded();
    }

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
    var tolerancePx = 80;
    var viewportW = Math.max(1, window.innerWidth || 1);
    var viewportH = Math.max(1, window.innerHeight || 1);

    for (var i = 0; i < required; i++) {
      var point = cameraPoints[i];
      var dotEl = dom.mapFingerDotsEl.children[i];

      var mapped = applyHomography(surfaceHomography, point.x, point.y);
      if (
        !mapped ||
        mapped.x < -tolerancePx ||
        mapped.x > viewportW + tolerancePx ||
        mapped.y < -tolerancePx ||
        mapped.y > viewportH + tolerancePx
      ) {
        dotEl.classList.add('hidden');
        continue;
      }

      var x = mapped.x;
      var y = mapped.y;

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
