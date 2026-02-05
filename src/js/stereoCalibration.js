/**
 * Stereo calibration for dual-camera mode
 * - Capture 12 calibration points (8 surface + 4 elevated)
 * - Compute projection matrices for both cameras
 * - Enable 3D triangulation for touch detection
 */

import { state } from './state.js';
import { computeProjectionMatrix, computeAverageReprojectionError } from './stereo.js';
import { recomputeSurfaceHomographyFromStereoIfReady, setMapFingerDotsVisible } from './surfaceCalibration.js';

// Setup click listeners for stereo calibration buttons
export function setupStereoCalibButtonListeners(setErrorFn) {
  for (var i = 1; i <= 12; i++) {
    (function(index) {
      var btn = document.getElementById('stereoCalibBtn' + index);
      if (btn) {
        btn.addEventListener('click', function() {
          armStereoCalibPoint(index - 1);
        });
      }
    })(i);
  }

  var computeBtn = document.getElementById('stereoComputeBtn');
  if (computeBtn) {
    computeBtn.addEventListener('click', function() {
      computeStereoCalibration(setErrorFn);
    });
  }
}

// Update visibility of stereo UI elements
export function updateStereoUIVisibility(videoContainer2) {
  var dom = state.dom;
  var stereoCalibBtns = document.getElementById('stereoCalibButtons');
  var touchIndicator = document.getElementById('touchIndicator');

  if (state.stereoMode) {
    if (videoContainer2) {
      videoContainer2.classList.remove('hidden');
    }
    if (stereoCalibBtns && state.stage === 2) {
      stereoCalibBtns.classList.remove('hidden');
    }
    dom.surfaceButtonsEl.classList.add('hidden');
    recomputeSurfaceHomographyFromStereoIfReady();
  } else {
    if (videoContainer2) {
      videoContainer2.classList.add('hidden');
    }
    if (stereoCalibBtns) {
      stereoCalibBtns.classList.add('hidden');
    }
    if (touchIndicator) {
      touchIndicator.classList.add('hidden');
    }
  }

  if (touchIndicator) {
    if (state.stereoMode && state.stereoCalibrationReady) {
      touchIndicator.classList.remove('hidden');
    } else {
      touchIndicator.classList.add('hidden');
    }
  }
}

// Arm a stereo calibration point for capture
export function armStereoCalibPoint(index, setViewModeFn) {
  if (state.stage !== 2) return;
  if (!state.stereoMode) return;

  if (state.viewMode !== 'camera' && setViewModeFn) {
    state.dom.viewToggleEl.checked = false;
    setViewModeFn('camera');
  }

  state.stereoArmedPointIndex = index;
  updateStereoCalibButtonsUI();

  if (state.stereoArmedTimeoutId) clearTimeout(state.stereoArmedTimeoutId);
  state.stereoArmedTimeoutId = setTimeout(function() {
    clearStereoArmedPoint();
    updateStereoCalibButtonsUI();
  }, 3000);
}

// Clear the currently armed stereo point
export function clearStereoArmedPoint() {
  state.stereoArmedPointIndex = null;
  if (state.stereoArmedTimeoutId) {
    clearTimeout(state.stereoArmedTimeoutId);
    state.stereoArmedTimeoutId = null;
  }
}

// Flash animation on stereo calibration button
export function flashStereoCalibButton(index) {
  var btn = document.getElementById('stereoCalibBtn' + (index + 1));
  if (!btn) return;

  btn.classList.add('stereo-calib-btn--flash');
  setTimeout(function() {
    btn.classList.remove('stereo-calib-btn--flash');
  }, 220);
}

// Update stereo calibration button UI states
export function updateStereoCalibButtonsUI() {
  for (var i = 0; i < 12; i++) {
    var btn = document.getElementById('stereoCalibBtn' + (i + 1));
    if (!btn) continue;

    var isSet = state.stereoCalibrationPoints[i] &&
                state.stereoCalibrationPoints[i].camera1Pixel &&
                state.stereoCalibrationPoints[i].camera2Pixel;
    var isArmed = state.stereoArmedPointIndex === i;

    btn.classList.toggle('stereo-calib-btn--set', !!isSet);
    btn.classList.toggle('stereo-calib-btn--armed', isArmed);
  }

  var computeBtn = document.getElementById('stereoComputeBtn');
  if (computeBtn) {
    var validCount = countValidStereoPoints();
    computeBtn.disabled = validCount < 6;
    computeBtn.textContent = 'Compute (' + validCount + '/12)';
  }

  var statusEl = document.getElementById('stereoCalibStatus');
  if (statusEl) {
    if (state.stereoCalibrationReady) {
      statusEl.textContent = 'Calibrated!';
      statusEl.className = 'stereo-calib-status stereo-calib-status--success';
    } else if (state.stereoArmedPointIndex !== null) {
      statusEl.textContent = 'Move your calibration AprilTag to point ' + (state.stereoArmedPointIndex + 1) + ' (visible in both cameras)...';
      statusEl.className = 'stereo-calib-status stereo-calib-status--armed';
    } else {
      statusEl.textContent = '';
      statusEl.className = 'stereo-calib-status';
    }
  }
}

// Count how many valid calibration points we have
export function countValidStereoPoints() {
  var count = 0;
  for (var i = 0; i < state.stereoCalibrationPoints.length; i++) {
    var pt = state.stereoCalibrationPoints[i];
    if (pt && pt.camera1Pixel && pt.camera2Pixel) {
      count++;
    }
  }
  return count;
}

// Capture a stereo calibration point from both cameras
export function captureStereoCalibPoint(point1, point2) {
  if (state.stereoArmedPointIndex === null) return;
  if (!point1 || !point2) return;

  var index = state.stereoArmedPointIndex;
  state.stereoCalibrationPoints[index] = {
    index: index,
    worldPos: state.STEREO_WORLD_POSITIONS[index],
    camera1Pixel: { x: point1.x, y: point1.y },
    camera2Pixel: { x: point2.x, y: point2.y },
    timestamp: Date.now()
  };

  flashStereoCalibButton(index);
  clearStereoArmedPoint();
  updateStereoCalibButtonsUI();
  recomputeSurfaceHomographyFromStereoIfReady();
}

// Compute projection matrices from calibration points
export function computeStereoCalibration(setErrorFn, videoContainer2) {
  var validPoints = [];
  for (var i = 0; i < state.stereoCalibrationPoints.length; i++) {
    var pt = state.stereoCalibrationPoints[i];
    if (pt && pt.worldPos && pt.camera1Pixel && pt.camera2Pixel) {
      validPoints.push(pt);
    }
  }

  if (validPoints.length < 6) {
    if (setErrorFn) setErrorFn('Need at least 6 calibration points for stereo calibration. Currently have ' + validPoints.length + '.');
    return;
  }

  var worldPoints = validPoints.map(function(p) { return p.worldPos; });
  var imagePoints1 = validPoints.map(function(p) { return p.camera1Pixel; });
  var imagePoints2 = validPoints.map(function(p) { return p.camera2Pixel; });

  state.stereoProjectionMatrix1 = computeProjectionMatrix(worldPoints, imagePoints1);
  state.stereoProjectionMatrix2 = computeProjectionMatrix(worldPoints, imagePoints2);

  if (!state.stereoProjectionMatrix1 || !state.stereoProjectionMatrix2) {
    if (setErrorFn) setErrorFn('Failed to compute projection matrices. Check calibration points are not collinear.');
    state.stereoCalibrationReady = false;
    updateStereoUIVisibility(videoContainer2);
    return;
  }

  var avgError = computeAverageReprojectionError(
    state.stereoProjectionMatrix1,
    state.stereoProjectionMatrix2,
    validPoints
  );

  if (avgError > 15 && setErrorFn) {
    setErrorFn('High reprojection error (' + avgError.toFixed(1) + 'px). Consider recalibrating.');
  }

  state.stereoCalibrationReady = true;
  if (setErrorFn) setErrorFn('');
  updateStereoCalibButtonsUI();
  updateStereoUIVisibility(videoContainer2);

  console.log('Stereo calibration complete. Avg reprojection error:', avgError.toFixed(2), 'px');
}

// Update touch indicator with triangulated Z value
export function updateTouchIndicator(worldPoint) {
  var touchIndicator = document.getElementById('touchIndicator');
  var touchStatus = document.getElementById('touchStatus');
  var touchZ = document.getElementById('touchZ');

  if (!touchIndicator || !touchStatus || !touchZ) return;

  var z = worldPoint.z;
  var isTouch = Math.abs(z) < state.touchZThreshold;

  touchStatus.textContent = isTouch ? 'TOUCH' : 'HOVER';
  touchStatus.classList.toggle('touch-status--touch', isTouch);
  touchStatus.classList.toggle('touch-status--hover', !isTouch);
  touchZ.textContent = 'Z: ' + z.toFixed(3);
}

// Reset all stereo calibration state
export function resetStereoCalibration(videoContainer2) {
  state.stereoCalibrationPoints = [];
  state.stereoProjectionMatrix1 = null;
  state.stereoProjectionMatrix2 = null;
  state.stereoCalibrationReady = false;
  state.surfaceHomography = null;
  clearStereoArmedPoint();
  updateStereoCalibButtonsUI();
  updateStereoUIVisibility(videoContainer2);
  setMapFingerDotsVisible(false);
}
