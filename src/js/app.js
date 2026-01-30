import { getDom } from './dom.js';
import { startCameraStream, stopCameraStream, waitForVideoMetadata } from './camera.js';
import { initDetector } from './detector.js';
import { initHandDetector } from './handDetector.js';
import { rgbaToGrayscale } from './grayscale.js';
import { clearOverlay, drawDetections } from './render.js';

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

  var videoContainer = document.querySelector('.video-container');
  initHandDetector({ videoContainer: videoContainer }).then(function (h) {
    handDetector = h;
    handDetectorReady = true;
    updateLoadingMessage();
  });

  dom.startBtn.addEventListener('click', startCamera);
  dom.nextBtn.addEventListener('click', goToSurfaceSetup);
  dom.stopBtn.addEventListener('click', stopCamera);
  dom.apriltagToggleEl.addEventListener('change', onApriltagToggleChanged);
  dom.viewToggleEl.addEventListener('change', onViewToggleChanged);

  setStage(1);
  setViewMode('camera');
  setNextEnabled(false);

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
    if (stage === 3) titleText = 'Stage 3/4';
    if (stage === 4) titleText = 'Stage 4/4';

    dom.pageTitleEl.textContent = titleText;
    document.title = titleText;

    if (stage === 2) {
      dom.surfaceButtonsEl.classList.remove('hidden');
      dom.apriltagToggleContainerEl.classList.add('hidden');
      dom.viewToggleContainerEl.classList.remove('hidden');
      setViewMode(dom.viewToggleEl.checked ? 'map' : 'camera');
    } else {
      dom.surfaceButtonsEl.classList.add('hidden');
      dom.apriltagToggleContainerEl.classList.remove('hidden');
      dom.viewToggleContainerEl.classList.add('hidden');
      setViewMode('camera');
    }
  }

  function goToSurfaceSetup() {
    if (!cameraReady) return;
    dom.viewToggleEl.checked = false;
    setStage(2);
  }

  function onViewToggleChanged() {
    if (stage !== 2) return;
    setViewMode(dom.viewToggleEl.checked ? 'map' : 'camera');
  }

  function setViewMode(mode) {
    viewMode = mode === 'map' ? 'map' : 'camera';

    if (viewMode === 'map') {
      dom.mapViewEl.classList.remove('hidden');
      dom.mapViewEl.setAttribute('aria-hidden', 'false');
      dom.viewToggleContainerEl.classList.add('toggle-floating');
      initMaptasticIfNeeded();
      pauseProcessing();
      return;
    }

    dom.mapViewEl.classList.add('hidden');
    dom.mapViewEl.setAttribute('aria-hidden', 'true');
    dom.viewToggleContainerEl.classList.remove('toggle-floating');
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

    // AprilTag detection
    if (apriltagEnabled && detector) {
      try {
        clearOverlay(overlayCtx, dom.overlay);

        var grayscale = rgbaToGrayscale(imageData);
        var detections = await detector.detect(grayscale, width, height);

        if (detections && detections.length > 0) {
          drawDetections(overlayCtx, detections);
        }
      } catch (err) {
        console.error('AprilTag detection error:', err);
      }
    }

    // Hand detection (drawing happens in iframe)
    if (handDetector) {
      try {
        await handDetector.detect(imageData.data, width, height);
      } catch (err) {
        console.error('Hand detection error:', err);
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

  function setError(text) {
    dom.errorEl.textContent = text;
  }
}

function cameraErrorMessage(err) {
  if (!err || typeof err !== 'object') return 'Error accessing camera.';
  if (err.name === 'NotAllowedError') return 'Camera access denied. Please allow camera permissions.';
  if (err.name === 'NotFoundError') return 'No camera found on this device.';
  return 'Error accessing camera: ' + (err.message || String(err));
}
