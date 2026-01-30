import { getDom } from './dom.js';
import { startCameraStream, stopCameraStream, waitForVideoMetadata } from './camera.js';
import { initDetector } from './detector.js';
import { initHandDetector } from './handDetector.js';
import { rgbaToGrayscale } from './grayscale.js';
import { clearOverlay, drawDetections, drawSurface } from './render.js';
import { initUiSetup } from './uiSetup.js';

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

  var videoContainer = document.querySelector('.video-container');
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
      return;
    }

    dom.uiSetupPanelEl.classList.add('hidden');
    dom.uiSetupPanelEl.setAttribute('aria-hidden', 'true');
    dom.uiSetupOverlayEl.classList.add('hidden');
    dom.uiSetupOverlayEl.setAttribute('aria-hidden', 'true');
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

      var stream = await startCameraStream(dom.video, {
        video: {
          facingMode: 'environment',
          width: { ideal: 640 },
          height: { ideal: 480 },
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

    stopCameraStream(currentStream);
    currentStream = null;

    dom.video.srcObject = null;
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

    captureCtx.drawImage(dom.video, 0, 0, width, height);
    var imageData = captureCtx.getImageData(0, 0, width, height);

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
