/**
 * Gesture controls for Stage 3 and Stage 4 map interaction
 * - Dwell-to-click: Hold finger still to trigger a click
 * - Pinch-to-drag: Pinch and hold to start dragging
 * - Supports multiple hands/pointers simultaneously
 * - Multi-hand drawing in Stage 4
 */

import { state } from './state.js';
import {
  activateDrawingForPointer,
  deactivateDrawingForPointer,
  getDrawColorForPointer,
  startDrawingAtPoint,
  continueDrawingAtPoint,
  stopDrawingForPointer
} from './stage4Drawing.js';

// Multi-pointer tracking: keyed by hand index
// Each entry: { dwellAnchor, dwellStartMs, dwellFired, pinchStartMs, pinchAnchor, dragActive, dragTarget, dragPointerId, lastPointer, cursorEl }
var pointerStates = {};
var nextPointerId = 100; // Start at 100 to avoid conflicts with real pointer IDs

// Get all visible finger dot positions in viewport coordinates
export function getAllMapPointerViewportPoints() {
  var dom = state.dom;
  if (!dom.mapFingerDotsEl || dom.mapFingerDotsEl.classList.contains('hidden')) return [];
  if (!dom.mapFingerDotsEl.children || dom.mapFingerDotsEl.children.length < 1) return [];

  var points = [];
  for (var i = 0; i < dom.mapFingerDotsEl.children.length; i++) {
    var dotEl = dom.mapFingerDotsEl.children[i];
    if (!dotEl || dotEl.classList.contains('hidden')) continue;

    var rect = dotEl.getBoundingClientRect();
    // Use handId from DOM element for stable identity across frames
    var handId = dotEl.dataset.handId || ('hand' + i);
    points.push({
      index: i,
      handId: handId,
      x: rect.left + rect.width / 2,
      y: rect.top + rect.height / 2
    });
  }
  return points;
}

// Get the primary finger dot position (for backward compatibility)
export function getPrimaryMapPointerViewportPoint() {
  var points = getAllMapPointerViewportPoints();
  return points.length > 0 ? points[0] : null;
}

// Get or create pointer state for a hand index
function getPointerState(handIndex) {
  if (!pointerStates[handIndex]) {
    pointerStates[handIndex] = {
      dwellAnchor: null,
      dwellStartMs: 0,
      dwellFired: false,
      dwellClickTimeMs: 0,
      pinchStartMs: 0,
      pinchAnchor: null,
      dragActive: false,
      dragTarget: null,
      dragPointerId: nextPointerId++,
      lastPointer: null,
      cursorEl: null,
      isDrawing: false  // Multi-hand drawing state
    };
  }
  return pointerStates[handIndex];
}

// Main gesture handling function called each frame - handles multiple pointers
export function handleStage3Gestures(usableIndexTipPoints) {
  var viewportPoints = getAllMapPointerViewportPoints();

  // Build a map from handId to hand data for quick lookup
  var handDataByHandId = {};
  if (usableIndexTipPoints) {
    for (var i = 0; i < usableIndexTipPoints.length; i++) {
      var hd = usableIndexTipPoints[i];
      if (hd && hd.handId) {
        handDataByHandId[hd.handId] = hd;
      }
    }
  }

  // Track which hand IDs are currently active
  var activeHandIds = {};
  for (var i = 0; i < viewportPoints.length; i++) {
    activeHandIds[viewportPoints[i].handId] = true;
  }

  // End drags and deactivate drawing for hands that are no longer visible
  for (var handId in pointerStates) {
    if (!activeHandIds[handId]) {
      var ps = pointerStates[handId];
      if (ps.dragActive) {
        endDragForPointer(ps, ps.lastPointer);
      }
      // Deactivate drawing for this hand
      deactivateDrawingForPointer(ps.dragPointerId);
      // Reset primary cursor assignment if this was the primary hand
      if (handId === primaryCursorHandId) {
        primaryCursorHandId = null;
      }
      // Clean up secondary cursors (don't remove the primary cursor, just hide it)
      if (ps.cursorEl) {
        if (ps.cursorEl === state.dom.mapFingerCursorEl) {
          // Primary cursor - just hide it, don't remove
          ps.cursorEl.classList.add('hidden');
          ps.cursorEl.setAttribute('aria-hidden', 'true');
        } else if (ps.cursorEl.parentNode) {
          // Secondary cursor - remove from DOM
          ps.cursorEl.parentNode.removeChild(ps.cursorEl);
        }
      }
      delete pointerStates[handId];
    }
  }

  // No pointers visible
  if (viewportPoints.length === 0) {
    updatePrimaryCursor(null);
    return;
  }

  // Process each visible pointer (updatePointerCursor is called inside processPointerGesture)
  for (var i = 0; i < viewportPoints.length; i++) {
    var vp = viewportPoints[i];
    var handId = vp.handId;
    var pointer = { x: vp.x, y: vp.y };

    // Get hand data for pinch info using handId
    var handData = handDataByHandId[handId] || null;

    processPointerGesture(handId, pointer, handData);
  }
}

// Process gestures for a single pointer
function processPointerGesture(handIndex, pointer, handData) {
  var ps = getPointerState(handIndex);
  ps.lastPointer = pointer;

  var pinchDistance = handData && typeof handData.pinchDistance === 'number' ? handData.pinchDistance : null;
  var pinchRatio = handData && typeof handData.pinchRatio === 'number' ? handData.pinchRatio : null;

  var isPinching = false;
  if (pinchDistance !== null) {
    isPinching = pinchDistance <= state.pinchDistanceThresholdPx;
  } else if (pinchRatio !== null) {
    isPinching = pinchRatio <= state.PINCH_RATIO_THRESHOLD;
  }

  var nowMs = performance.now();
  var threshold = state.holdStillThresholdPx;

  // Pinch-to-drag (arm by holding pinch)
  if (isPinching) {
    ps.dwellStartMs = 0;
    ps.dwellAnchor = null;
    ps.dwellFired = false;

    if (!ps.pinchAnchor) {
      // First pinch frame - set anchor
      ps.pinchAnchor = pointer;
      ps.pinchStartMs = nowMs;
    } else {
      var pinchDist = distance(pointer, ps.pinchAnchor);
      if (pinchDist > threshold) {
        // Moved too far - use rolling anchor (move anchor toward current position)
        // This allows slow drift while still detecting fast movement as intentional
        var pullFactor = 0.3; // How much to pull anchor toward current position
        ps.pinchAnchor = {
          x: ps.pinchAnchor.x + (pointer.x - ps.pinchAnchor.x) * pullFactor,
          y: ps.pinchAnchor.y + (pointer.y - ps.pinchAnchor.y) * pullFactor
        };
        // Only reset timer if movement is significantly beyond threshold
        if (pinchDist > threshold * 2) {
          ps.pinchStartMs = nowMs;
        }
      }
    }

    var pinchProgress = Math.min(1, (nowMs - ps.pinchStartMs) / state.pinchHoldMs);
    var isDrawingMode = state.stage === 4 && getDrawColorForPointer(ps.dragPointerId);
    var mode = ps.dragActive || ps.isDrawing ? (isDrawingMode ? 'draw' : 'drag') : 'pinch';
    updatePointerCursor(handIndex, pointer, (ps.dragActive || ps.isDrawing) ? 1 : pinchProgress, mode);

    if (!ps.dragActive && !ps.isDrawing && nowMs - ps.pinchStartMs >= state.pinchHoldMs) {
      if (isDrawingMode) {
        // Start drawing instead of dragging
        ps.isDrawing = true;
        startDrawingAtPoint(ps.dragPointerId, pointer.x, pointer.y);
      } else {
        startDragForPointer(ps, pointer);
      }
    }

    if (ps.dragActive) {
      continueDragForPointer(ps, pointer);
    }
    if (ps.isDrawing) {
      continueDrawingAtPoint(ps.dragPointerId, pointer.x, pointer.y);
    }
    return;
  }

  ps.pinchStartMs = 0;
  ps.pinchAnchor = null;

  if (ps.dragActive) {
    endDragForPointer(ps, pointer);
    updatePointerCursor(handIndex, pointer, 0, null);
    return;
  }

  if (ps.isDrawing) {
    ps.isDrawing = false;
    stopDrawingForPointer(ps.dragPointerId);
    updatePointerCursor(handIndex, pointer, 0, null);
    return;
  }

  // Dwell-to-click with rolling anchor for jitter tolerance
  if (!ps.dwellAnchor) {
    // First frame - set anchor
    ps.dwellAnchor = pointer;
    ps.dwellStartMs = nowMs;
    ps.dwellFired = false;
    updatePointerCursor(handIndex, pointer, 0, null);
    return;
  }

  var dwellDist = distance(pointer, ps.dwellAnchor);
  if (dwellDist > threshold) {
    // Moved beyond threshold - use rolling anchor
    var pullFactor = 0.3;
    ps.dwellAnchor = {
      x: ps.dwellAnchor.x + (pointer.x - ps.dwellAnchor.x) * pullFactor,
      y: ps.dwellAnchor.y + (pointer.y - ps.dwellAnchor.y) * pullFactor
    };
    // Only reset timer if movement is significantly beyond threshold
    if (dwellDist > threshold * 2) {
      ps.dwellStartMs = nowMs;
      ps.dwellFired = false;
      updatePointerCursor(handIndex, pointer, 0, null);
      return;
    }
  }

  // After a click, wait for cooldown before allowing another dwell
  if (ps.dwellFired) {
    var cooldownMs = 500; // Wait 500ms after click before starting new dwell
    if (nowMs - ps.dwellClickTimeMs > cooldownMs) {
      // Cooldown passed, reset for new dwell
      ps.dwellFired = false;
      ps.dwellAnchor = pointer;
      ps.dwellStartMs = nowMs;
    }
    updatePointerCursor(handIndex, pointer, 0, null);
    return;
  }

  if (ps.dwellStartMs) {
    var dwellProgress = Math.min(1, (nowMs - ps.dwellStartMs) / state.dwellClickMs);
    updatePointerCursor(handIndex, pointer, dwellProgress, 'dwell');

    if (nowMs - ps.dwellStartMs >= state.dwellClickMs) {
      dispatchClickAt(pointer, ps.dragPointerId);
      ps.dwellFired = true;
      ps.dwellClickTimeMs = nowMs;
      updatePointerCursor(handIndex, pointer, 0, null);
    }
  }
}

// Drag functions per pointer
function startDragForPointer(ps, pointer) {
  var hit = getEventTargetAt(pointer);
  ps.dragTarget = hit.target || document.body;
  ps.dragActive = true;

  dispatchPointerMouse(ps.dragTarget, 'pointerdown', 'mousedown', pointer, {
    pointerId: ps.dragPointerId,
    buttons: 1,
    button: 0
  });
}

function continueDragForPointer(ps, pointer) {
  if (!ps.dragTarget) ps.dragTarget = document.body;
  dispatchPointerMouse(ps.dragTarget, 'pointermove', 'mousemove', pointer, {
    pointerId: ps.dragPointerId,
    buttons: 1,
    button: 0
  });
}

function endDragForPointer(ps, pointer) {
  var pos = pointer || ps.lastPointer;
  if (!ps.dragTarget || !pos) {
    ps.dragActive = false;
    ps.dragTarget = null;
    return;
  }

  dispatchPointerMouse(ps.dragTarget, 'pointerup', 'mouseup', pos, {
    pointerId: ps.dragPointerId,
    buttons: 0,
    button: 0
  });

  ps.dragActive = false;
  ps.dragTarget = null;
}

// Track which hand is using the primary cursor
var primaryCursorHandId = null;

// Create or get cursor element for a pointer
function getOrCreateCursorEl(handId) {
  var ps = getPointerState(handId);

  if (ps.cursorEl) return ps.cursorEl;

  // First hand to request a cursor gets the primary cursor
  if (primaryCursorHandId === null && state.dom.mapFingerCursorEl) {
    primaryCursorHandId = handId;
    ps.cursorEl = state.dom.mapFingerCursorEl;
    return ps.cursorEl;
  }

  // If this hand is the primary cursor owner, use it
  if (handId === primaryCursorHandId && state.dom.mapFingerCursorEl) {
    ps.cursorEl = state.dom.mapFingerCursorEl;
    return ps.cursorEl;
  }

  // Clone the primary cursor for additional pointers
  if (state.dom.mapFingerCursorEl && state.dom.mapFingerCursorEl.parentNode) {
    var clone = state.dom.mapFingerCursorEl.cloneNode(true);
    clone.id = 'mapFingerCursor_' + handId;
    clone.classList.add('map-finger-cursor--secondary');
    state.dom.mapFingerCursorEl.parentNode.appendChild(clone);
    ps.cursorEl = clone;
    return clone;
  }

  return null;
}

// Update cursor for a specific pointer
function updatePointerCursor(handIndex, pointer, progress, mode) {
  var cursorEl = getOrCreateCursorEl(handIndex);
  if (!cursorEl) return;

  var visible = (state.stage === 3 || state.stage === 4) && state.viewMode === 'map' && !!pointer;
  if (!visible) {
    cursorEl.classList.add('hidden');
    cursorEl.setAttribute('aria-hidden', 'true');
    cursorEl.style.transform = 'translate(-9999px, -9999px)';
    return;
  }

  cursorEl.classList.remove('hidden');
  cursorEl.setAttribute('aria-hidden', 'false');
  cursorEl.style.transform = 'translate(' + (pointer.x - 18) + 'px, ' + (pointer.y - 18) + 'px)';

  // Update progress circle
  var circle = cursorEl.querySelector('.map-finger-cursor__progress');
  if (circle) {
    var p = Math.max(0, Math.min(1, progress || 0));
    var dashOffset = 100 - p * 100;
    circle.style.strokeDashoffset = String(dashOffset);
  }

  // Update mode classes
  cursorEl.classList.remove('map-finger-cursor--dwell');
  cursorEl.classList.remove('map-finger-cursor--pinch');
  cursorEl.classList.remove('map-finger-cursor--drag');
  cursorEl.classList.remove('map-finger-cursor--draw');

  if (mode === 'dwell') cursorEl.classList.add('map-finger-cursor--dwell');
  if (mode === 'pinch') cursorEl.classList.add('map-finger-cursor--pinch');
  if (mode === 'draw') cursorEl.classList.add('map-finger-cursor--draw');
  if (mode === 'drag') cursorEl.classList.add('map-finger-cursor--drag');
}

// Update primary cursor (backward compatibility)
function updatePrimaryCursor(pointer) {
  var dom = state.dom;
  if (!dom.mapFingerCursorEl) return;

  var visible = (state.stage === 3 || state.stage === 4) && state.viewMode === 'map' && !!pointer;
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

export function resetGestureTimers() {
  for (var idx in pointerStates) {
    var ps = pointerStates[idx];
    ps.dwellAnchor = null;
    ps.dwellStartMs = 0;
    ps.dwellFired = false;
    ps.pinchStartMs = 0;
    ps.pinchAnchor = null;
  }

  // Also reset legacy state vars for backward compatibility
  state.dwellAnchor = null;
  state.dwellStartMs = 0;
  state.dwellFired = false;
  state.pinchStartMs = 0;
  state.pinchAnchor = null;
}

export function resetStage3Gestures() {
  // End all active drags and drawings
  for (var idx in pointerStates) {
    var ps = pointerStates[idx];
    if (ps.dragActive) {
      endDragForPointer(ps, ps.lastPointer);
    }
    if (ps.isDrawing) {
      stopDrawingForPointer(ps.dragPointerId);
    }
    // Deactivate drawing mode for this hand
    deactivateDrawingForPointer(ps.dragPointerId);
    // Remove secondary cursors
    if (ps.cursorEl && ps.cursorEl !== state.dom.mapFingerCursorEl && ps.cursorEl.parentNode) {
      ps.cursorEl.parentNode.removeChild(ps.cursorEl);
    }
  }

  pointerStates = {};
  primaryCursorHandId = null;

  updatePrimaryCursor(null);
  setStage3CursorProgress(0, null);
  resetGestureTimers();
  state.lastPointerViewport = null;
  state.dragActive = false;
  state.dragTarget = null;
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
  updatePrimaryCursor(pointer);
}

function dispatchClickAt(pointer, pointerId) {
  var hit = getEventTargetAt(pointer);
  var target = hit.target || document.body;
  var pid = pointerId || 1;

  // Check if clicking on a drawing button in Stage 4
  if (state.stage === 4) {
    var drawButton = target.closest ? target.closest('.ui-draw') : null;
    if (drawButton && !drawButton.classList.contains('ui-sticker-instance')) {
      // This is a drawing tool button, not a sticker instance
      var color = drawButton.dataset && drawButton.dataset.color ? drawButton.dataset.color : '#2bb8ff';
      var currentColor = getDrawColorForPointer(pid);

      if (currentColor === color) {
        // Same color clicked again - deactivate drawing for this hand
        deactivateDrawingForPointer(pid);
      } else {
        // Activate drawing with this color for this hand
        activateDrawingForPointer(pid, color, drawButton);
      }
      return; // Don't dispatch regular click
    }
  }

  dispatchPointerMouse(target, 'pointerdown', 'mousedown', pointer, { pointerId: pid, buttons: 1, button: 0 });
  dispatchPointerMouse(target, 'pointerup', 'mouseup', pointer, { pointerId: pid, buttons: 0, button: 0 });

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
      pointerType: 'touch',
      isPrimary: pointerId === 100,
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
