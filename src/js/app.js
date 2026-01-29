import { getDom } from './dom.js';
import { startCameraStream, stopCameraStream, waitForVideoMetadata } from './camera.js';
import { initDetector } from './detector.js';
import { initHandDetector } from './handDetector.js';
import { rgbaToGrayscale } from './grayscale.js';
import { clearOverlay, drawDetections } from './render.js';

export function initApp() {
  const dom = getDom();

  const overlayCtx = dom.overlay.getContext('2d');
  if (!overlayCtx) throw new Error('Failed to get overlay canvas 2D context');

  const captureCanvas = document.createElement('canvas');
  const captureCtx = captureCanvas.getContext('2d', { willReadFrequently: true });
  if (!captureCtx) throw new Error('Failed to get capture canvas 2D context');

  let currentStream = null;
  let detector = null;
  let detectorInitPromise = null;
  let detectorLoadFailed = false;
  let handDetector = null;
  let isProcessing = false;
  let animationId = null;
  let apriltagEnabled = dom.apriltagToggleEl.checked;
  let overlayHasApriltag = false;

  syncApriltagModeUi();

  const videoContainer = document.querySelector('.video-container');
  initHandDetector({
    onReady: () => {},
    onError: () => {},
    videoContainer,
  }).then((h) => {
    handDetector = h;
  });

  dom.startBtn.addEventListener('click', startCamera);
  dom.stopBtn.addEventListener('click', stopCamera);
  dom.apriltagToggleEl.addEventListener('change', syncApriltagModeFromDom);

  function syncApriltagModeFromDom() {
    apriltagEnabled = dom.apriltagToggleEl.checked;

    if (!apriltagEnabled) {
      if (overlayHasApriltag) {
        clearOverlay(overlayCtx, dom.overlay);
        overlayHasApriltag = false;
      }
      setStatus('Detector: Off');
      return;
    }

    syncApriltagModeUi();

    if (isProcessing) {
      void ensureDetector();
    }
  }

  function syncApriltagModeUi() {
    if (!apriltagEnabled) {
      setStatus('Detector: Off');
      return;
    }

    if (detector) {
      setStatus('Detector: Ready');
      return;
    }

    if (detectorInitPromise) {
      setStatus('Detector: Loading...');
      return;
    }

    if (detectorLoadFailed) {
      setStatus('Detector: Failed to load');
      return;
    }

    setStatus('Detector: On');
  }

  async function ensureDetector() {
    if (!apriltagEnabled) return null;
    if (detector) return detector;
    if (detectorInitPromise) return detectorInitPromise;

    detectorLoadFailed = false;
    setStatus('Detector: Loading...');
    detectorInitPromise = initDetector({
      onReady: () => {
        if (apriltagEnabled) setStatus('Detector: Ready');
      },
      onError: () => {
        detectorLoadFailed = true;
        if (apriltagEnabled) setStatus('Detector: Failed to load');
      },
    })
      .then((d) => {
        detector = d;
        if (!d) detectorLoadFailed = true;
        return d;
      })
      .finally(() => {
        detectorInitPromise = null;
      });

    return detectorInitPromise;
  }

  async function startCamera() {
    try {
      const stream = await startCameraStream(dom.video, {
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
      setError('');

      if (apriltagEnabled) {
        void ensureDetector();
      }

      startProcessing();
    } catch (err) {
      console.error('Error accessing camera:', err);
      setError(cameraErrorMessage(err));
    }
  }

  function stopCamera() {
    isProcessing = false;

    if (animationId) {
      cancelAnimationFrame(animationId);
      animationId = null;
    }

    stopCameraStream(currentStream);
    currentStream = null;

    dom.video.srcObject = null;
    clearOverlay(overlayCtx, dom.overlay);
    overlayHasApriltag = false;

    setButtonsRunning(false);
  }

  function startProcessing() {
    isProcessing = true;
    processFrame();
  }

  async function processFrame() {
    if (!isProcessing) return;

    const width = captureCanvas.width;
    const height = captureCanvas.height;

    captureCtx.drawImage(dom.video, 0, 0, width, height);
    const imageData = captureCtx.getImageData(0, 0, width, height);

    // AprilTag detection
    if (apriltagEnabled && detector) {
      try {
        clearOverlay(overlayCtx, dom.overlay);
        overlayHasApriltag = false;

        const grayscale = rgbaToGrayscale(imageData);
        const detections = await detector.detect(grayscale, width, height);

        if (detections?.length) {
          drawDetections(overlayCtx, detections);
          overlayHasApriltag = true;
        }
      } catch (err) {
        console.error('AprilTag detection error:', err);
      }
    }

    // Hand detection (drawing happens in iframe)
    if (handDetector) {
      try {
        const hands = await handDetector.detect(imageData.data, width, height);

        if (hands?.length) {
        }
      } catch (err) {
        console.error('Hand detection error:', err);
      }
    }

    animationId = requestAnimationFrame(processFrame);
  }

  function setButtonsRunning(isRunning) {
    dom.startBtn.style.display = isRunning ? 'none' : 'inline-block';
    dom.stopBtn.style.display = isRunning ? 'inline-block' : 'none';
  }

  function setStatus(text) {
    void text;
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
