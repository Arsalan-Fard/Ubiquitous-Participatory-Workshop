/**
 * Surface calibration for single-camera mode
 * - Capture 4 corner points to define the projection surface
 * - Compute homography for finger-to-surface mapping
 */

import { state } from './state.js';
import { solveLinearSystem } from './stereo.js';

// Reset all surface corners
export function resetSurfaceCorners() {
  state.surfaceCorners = [null, null, null, null];
  state.surfaceHomography = null;
  clearArmedCorner();
  updateSurfaceButtonsUI();
  setMapFingerDotsVisible(false);
}

// Check if all 4 corners are captured
export function areSurfaceCornersReady() {
  return !!(state.surfaceCorners[0] && state.surfaceCorners[1] && state.surfaceCorners[2] && state.surfaceCorners[3]);
}

// Compute homography when all corners are ready
export function recomputeSurfaceHomographyIfReady() {
  if (!areSurfaceCornersReady()) {
    state.surfaceHomography = null;
    return;
  }

  state.surfaceHomography = computeHomography(state.surfaceCorners, [
    { x: 0, y: 0 },
    { x: 1, y: 0 },
    { x: 1, y: 1 },
    { x: 0, y: 1 }
  ]);

  if (!state.surfaceHomography) {
    console.warn('Surface homography could not be computed (degenerate corners).');
  }
}

// Compute homography from stereo calibration points (first 4 corners)
export function recomputeSurfaceHomographyFromStereoIfReady() {
  if (!state.stereoMode) return;

  var corners1 = [];
  for (var i = 0; i < 4; i++) {
    var pt = state.stereoCalibrationPoints[i];
    if (!pt || !pt.camera1Pixel) {
      state.surfaceHomography = null;
      return;
    }
    corners1.push({ x: pt.camera1Pixel.x, y: pt.camera1Pixel.y });
  }

  state.surfaceHomography = computeHomography(corners1, [
    { x: 0, y: 0 },
    { x: 1, y: 0 },
    { x: 1, y: 1 },
    { x: 0, y: 1 }
  ]);

  if (!state.surfaceHomography) {
    console.warn('Stereo surface homography could not be computed (degenerate corners).');
  }
}

// Clear the currently armed corner
export function clearArmedCorner() {
  state.armedCornerIndex = null;
  state.armedCornerCaptureRequested = false;
  if (state.armedCornerTimeoutId) {
    clearTimeout(state.armedCornerTimeoutId);
    state.armedCornerTimeoutId = null;
  }
}

// Arm a corner for capture
export function armCorner(index, setViewModeFn) {
  if (state.stage !== 2) return;

  if (state.viewMode !== 'camera' && setViewModeFn) {
    state.dom.viewToggleEl.checked = false;
    setViewModeFn('camera');
  }

  state.armedCornerIndex = index;
  state.armedCornerCaptureRequested = true;
  updateSurfaceButtonsUI();

  if (state.armedCornerTimeoutId) clearTimeout(state.armedCornerTimeoutId);
  state.armedCornerTimeoutId = setTimeout(function() {
    clearArmedCorner();
    updateSurfaceButtonsUI();
  }, 2500);
}

// Flash animation on corner button after capture
export function flashCornerButton(index) {
  var dom = state.dom;
  var el = null;
  if (index === 0) el = dom.surfaceBtn1;
  if (index === 1) el = dom.surfaceBtn2;
  if (index === 2) el = dom.surfaceBtn3;
  if (index === 3) el = dom.surfaceBtn4;
  if (!el) return;

  el.classList.add('surface-btn--flash');
  setTimeout(function() {
    el.classList.remove('surface-btn--flash');
  }, 220);
}

// Update corner button UI states
export function updateSurfaceButtonsUI() {
  var dom = state.dom;
  dom.surfaceBtn1.classList.toggle('surface-btn--set', !!state.surfaceCorners[0]);
  dom.surfaceBtn2.classList.toggle('surface-btn--set', !!state.surfaceCorners[1]);
  dom.surfaceBtn3.classList.toggle('surface-btn--set', !!state.surfaceCorners[2]);
  dom.surfaceBtn4.classList.toggle('surface-btn--set', !!state.surfaceCorners[3]);

  dom.surfaceBtn1.classList.toggle('surface-btn--armed', state.armedCornerIndex === 0);
  dom.surfaceBtn2.classList.toggle('surface-btn--armed', state.armedCornerIndex === 1);
  dom.surfaceBtn3.classList.toggle('surface-btn--armed', state.armedCornerIndex === 2);
  dom.surfaceBtn4.classList.toggle('surface-btn--armed', state.armedCornerIndex === 3);
}

// Show/hide map finger dots
export function setMapFingerDotsVisible(visible) {
  var dom = state.dom;
  if (visible) {
    dom.mapFingerDotsEl.classList.remove('hidden');
    dom.mapFingerDotsEl.setAttribute('aria-hidden', 'false');
    return;
  }

  dom.mapFingerDotsEl.classList.add('hidden');
  dom.mapFingerDotsEl.setAttribute('aria-hidden', 'true');
  dom.mapFingerDotsEl.textContent = '';
}

// Compute 3x3 homography matrix from 4 source to 4 destination points
export function computeHomography(src, dst) {
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

// Apply homography to a point
export function applyHomography(H, x, y) {
  var denom = H[6] * x + H[7] * y + H[8];
  if (!denom) return null;

  return {
    x: (H[0] * x + H[1] * y + H[2]) / denom,
    y: (H[3] * x + H[4] * y + H[5]) / denom
  };
}
