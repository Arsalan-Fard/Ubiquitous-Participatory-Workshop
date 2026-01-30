/**
 * Gesture controls for Stage 3 map interaction
 * - Dwell-to-click: Hold finger still to trigger a click
 * - Pinch-to-drag: Pinch and hold to start dragging
 */

import { state } from './state.js';

// Get the primary finger dot position in viewport coordinates
export function getPrimaryMapPointerViewportPoint() {
  var dom = state.dom;
  if (!dom.mapFingerDotsEl || dom.mapFingerDotsEl.classList.contains('hidden')) return null;
  if (!dom.mapFingerDotsEl.children || dom.mapFingerDotsEl.children.length < 1) return null;

  var dotEl = dom.mapFingerDotsEl.children[0];
  if (!dotEl || dotEl.classList.contains('hidden')) return null;

  var rect = dotEl.getBoundingClientRect();
  return { x: rect.left + rect.width / 2, y: rect.top + rect.height / 2 };
}

// Main gesture handling function called each frame
export function handleStage3Gestures(usableIndexTipPoints) {
  var pointer = getPrimaryMapPointerViewportPoint();
  updateStage3Cursor(pointer);

  if (!pointer) {
    setStage3CursorProgress(0, null);
    if (state.dragActive) endDrag(state.lastPointerViewport || pointer);
    resetGestureTimers();
    return;
  }

  state.lastPointerViewport = pointer;

  var primary = usableIndexTipPoints && usableIndexTipPoints.length > 0 ? usableIndexTipPoints[0] : null;
  var pinchDistance = primary && typeof primary.pinchDistance === 'number' ? primary.pinchDistance : null;
  var pinchRatio = primary && typeof primary.pinchRatio === 'number' ? primary.pinchRatio : null;

  var isPinching = false;
  if (pinchDistance !== null) {
    isPinching = pinchDistance <= state.pinchDistanceThresholdPx;
  } else if (pinchRatio !== null) {
    isPinching = pinchRatio <= state.PINCH_RATIO_THRESHOLD;
  }

  var nowMs = performance.now();

  // Pinch-to-drag (arm by holding pinch)
  if (isPinching) {
    state.dwellStartMs = 0;
    state.dwellAnchor = null;
    state.dwellFired = false;

    if (!state.pinchAnchor || distance(pointer, state.pinchAnchor) > state.holdStillThresholdPx) {
      state.pinchAnchor = pointer;
      state.pinchStartMs = nowMs;
    } else if (!state.pinchStartMs) {
      state.pinchStartMs = nowMs;
    }

    var pinchProgress = Math.min(1, (nowMs - state.pinchStartMs) / state.pinchHoldMs);
    setStage3CursorProgress(state.dragActive ? 1 : pinchProgress, state.dragActive ? 'drag' : 'pinch');

    if (!state.dragActive && nowMs - state.pinchStartMs >= state.pinchHoldMs) {
      startDrag(pointer);
    }

    if (state.dragActive) {
      continueDrag(pointer);
    }
    return;
  }

  state.pinchStartMs = 0;
  state.pinchAnchor = null;
  setStage3CursorProgress(0, null);

  if (state.dragActive) {
    endDrag(pointer);
    return;
  }

  // Dwell-to-click
  if (!state.dwellAnchor || distance(pointer, state.dwellAnchor) > state.holdStillThresholdPx) {
    state.dwellAnchor = pointer;
    state.dwellStartMs = nowMs;
    state.dwellFired = false;
    setStage3CursorProgress(0, null);
    return;
  }

  if (!state.dwellFired && state.dwellStartMs) {
    var dwellProgress = Math.min(1, (nowMs - state.dwellStartMs) / state.dwellClickMs);
    setStage3CursorProgress(dwellProgress, 'dwell');
  }

  if (!state.dwellFired && state.dwellStartMs && nowMs - state.dwellStartMs >= state.dwellClickMs) {
    dispatchClickAt(pointer);
    state.dwellFired = true;
    setStage3CursorProgress(0, null);
  }
}

export function resetGestureTimers() {
  state.dwellAnchor = null;
  state.dwellStartMs = 0;
  state.dwellFired = false;
  state.pinchStartMs = 0;
  state.pinchAnchor = null;
}

export function resetStage3Gestures() {
  if (state.dragActive) endDrag(state.lastPointerViewport);
  updateStage3Cursor(null);
  setStage3CursorProgress(0, null);
  resetGestureTimers();
  state.lastPointerViewport = null;
}

function getMapFingerCursorProgressCircleEl() {
  if (state.mapFingerCursorProgressCircleEl) return state.mapFingerCursorProgressCircleEl;
  if (!state.dom.mapFingerCursorEl) return null;
  state.mapFingerCursorProgressCircleEl = state.dom.mapFingerCursorEl.querySelector('.map-finger-cursor__progress');
  return state.mapFingerCursorProgressCircleEl;
}

export function setStage3CursorProgress(progress01, mode) {
  var dom = state.dom;
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

export function updateStage3Cursor(pointer) {
  var dom = state.dom;
  if (!dom.mapFingerCursorEl) return;

  var visible = state.stage === 3 && state.viewMode === 'map' && !!pointer;
  if (!visible) {
    dom.mapFingerCursorEl.classList.add('hidden');
    dom.mapFingerCursorEl.setAttribute('aria-hidden', 'true');
    dom.mapFingerCursorEl.style.transform = 'translate(-9999px, -9999px)';
    return;
  }

  dom.mapFingerCursorEl.classList.remove('hidden');
  dom.mapFingerCursorEl.setAttribute('aria-hidden', 'false');
  dom.mapFingerCursorEl.style.transform = 'translate(' + (pointer.x - 18) + 'px, ' + (pointer.y - 18) + 'px)';
}

function startDrag(pointer) {
  var hit = getEventTargetAt(pointer);
  state.dragTarget = hit.target || document.body;
  state.dragPointerId = 1;
  state.dragActive = true;

  dispatchPointerMouse(state.dragTarget, 'pointerdown', 'mousedown', pointer, {
    pointerId: state.dragPointerId,
    buttons: 1,
    button: 0
  });
}

function continueDrag(pointer) {
  if (!state.dragTarget) state.dragTarget = document.body;
  dispatchPointerMouse(state.dragTarget, 'pointermove', 'mousemove', pointer, {
    pointerId: state.dragPointerId,
    buttons: 1,
    button: 0
  });
}

function endDrag(pointer) {
  var pos = pointer || state.lastPointerViewport;
  if (!state.dragTarget || !pos) {
    state.dragActive = false;
    state.dragTarget = null;
    return;
  }

  dispatchPointerMouse(state.dragTarget, 'pointerup', 'mouseup', pos, {
    pointerId: state.dragPointerId,
    buttons: 0,
    button: 0
  });

  state.dragActive = false;
  state.dragTarget = null;
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
  } catch (e) { /* ignore */ }
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
      if (!state.crossOriginClickWarned) {
        state.crossOriginClickWarned = true;
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
  } catch (e) { /* ignore */ }

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
  } catch (e) { /* ignore */ }
}

export function distance(a, b) {
  var dx = a.x - b.x;
  var dy = a.y - b.y;
  return Math.sqrt(dx * dx + dy * dy);
}
