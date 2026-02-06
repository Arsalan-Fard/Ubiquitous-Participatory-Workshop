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
  stopDrawingForPointer,
  cloneSticker,
  startStickerDrag,
  bindStickerLatLngFromCurrentPosition,
  updateStickerMappingForCurrentView
} from './stage4Drawing.js';

// Multi-pointer tracking: keyed by hand index
// Each entry: { dwellAnchor, dwellStartMs, dwellFired, pinchStartMs, pinchAnchor, dragActive, dragTarget, dragPointerId, lastPointer, cursorEl }
var pointerStates = {};
var nextPointerId = 100; // Start at 100 to avoid conflicts with real pointer IDs

// AprilTag trigger-on-disappearance delay (ms)
var APRILTAG_TRIGGER_DELAY_MS = 1000;

// Get all visible finger dot positions in viewport coordinates
export function getAllMapPointerViewportPoints() {
  var dom = state.dom;

  var dotsEl = dom.mapApriltagDotsEl || dom.mapFingerDotsEl;

  if (!dotsEl || dotsEl.classList.contains('hidden')) return [];
  if (!dotsEl.children || dotsEl.children.length < 1) return [];

  var points = [];
  for (var i = 0; i < dotsEl.children.length; i++) {
    var dotEl = dotsEl.children[i];
    if (!dotEl || dotEl.classList.contains('hidden')) continue;

    var rect = dotEl.getBoundingClientRect();
    // Use handId from DOM element for stable identity across frames
    var handId = dotEl.dataset.handId || dotEl.dataset.tagId || ('hand' + i);
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
      pinchFired: false,
      pinchFiredAt: null,
      missingSinceMs: null,
      dragActive: false,
      dragTarget: null,
      dragPointerId: nextPointerId++,
      lastPointer: null,
      prevPointer: null,
      prevPointerTimeMs: 0,
      cursorEl: null,
      isDrawing: false,  // Multi-hand drawing state
      currentInteractionTarget: null,  // Track current target to detect changes
      // AprilTag trigger-on-disappearance state
      isApriltag: false,
      triggerFillStartMs: 0,  // When the disappearance fill animation started
      triggerFired: false,    // Whether the trigger already fired this disappearance
      armedStickerTemplate: null,  // Template element for dot/note placement (two-step flow)
      drawingStarted: false  // Whether drawing has been started by a trigger (2nd trigger enables actual drawing)
    };
  }
  return pointerStates[handIndex];
}

// Remove active highlight from armed sticker template and clear the reference
function dearmStickerTemplate(ps) {
  if (ps.armedStickerTemplate) {
    ps.armedStickerTemplate.classList.remove('ui-dot--active', 'ui-note--active');
    ps.armedStickerTemplate = null;
  }
}

function shouldPinchClickTarget(target) {
  if (!target || !target.closest) return false;

  // Native interactive elements
  if (target.closest('input, textarea, select, button, a, [contenteditable="true"], [contenteditable=""], [role="button"]')) return true;

  // Stage 4 draw tool buttons should be clickable (not draggable)
  if (state.stage === 4) {
    var drawButton = target.closest('.ui-draw');
    if (drawButton && !drawButton.classList.contains('ui-sticker-instance')) return true;

    // Note form elements (textarea, save button) should be clickable
    if (target.closest('.ui-note__form')) return true;

    // Saved note stickers (with text) should be clickable to edit them
    var noteSticker = target.closest('.ui-sticker-instance.ui-note.ui-note--sticker');
    if (noteSticker) return true;
  }

  return false;
}

function getDraggableRoot(target) {
  if (!target || !target.closest) return null;

  // Never drag inside an expanded note form (should allow focusing text inputs)
  if (target.closest('.ui-note__form')) return null;

  if (state.stage === 4) {
    // Stage 4: draw tool button is clickable only (not draggable)
    var drawButton = target.closest('.ui-draw');
    if (drawButton && !drawButton.classList.contains('ui-sticker-instance')) return null;

    // Dot sticker instances are draggable
    var dotInstance = target.closest('.ui-sticker-instance.ui-dot');
    if (dotInstance) return dotInstance;

    // Note sticker instances: saved notes (with text) are clickable, unsaved are draggable
    var noteInstance = target.closest('.ui-sticker-instance.ui-note');
    if (noteInstance) {
      // Saved note stickers should be clickable to edit, not draggable
      if (noteInstance.classList.contains('ui-note--sticker')) {
        return null; // Will be handled as clickable
      }
      return noteInstance;
    }

    // Template buttons (dots/notes in setup panel) are also draggable to clone them
    var templateEl = target.closest('.ui-dot, .ui-note');
    if (templateEl && !templateEl.classList.contains('ui-sticker-instance')) {
      // Check if it's in the setup overlay (template area)
      var overlayEl = state.dom && state.dom.uiSetupOverlayEl;
      if (overlayEl && overlayEl.contains(templateEl)) {
        return templateEl;
      }
    }

    return null;
  }

  // Stage 3: templates are draggable during UI setup
  var setupEl = target.closest('.ui-dot, .ui-note, .ui-draw');
  return setupEl || null;
}

function getInteractionCandidate(pointer, radiusPx) {
  var r = Math.max(0, radiusPx || 0);
  var offsets = [{ dx: 0, dy: 0 }];
  if (r > 0) {
    var step = Math.max(4, Math.round(r / 3));
    var dirs = [
      { x: 1, y: 0 }, { x: -1, y: 0 }, { x: 0, y: 1 }, { x: 0, y: -1 },
      { x: 1, y: 1 }, { x: -1, y: 1 }, { x: 1, y: -1 }, { x: -1, y: -1 }
    ];

    for (var rad = step; rad <= r; rad += step) {
      for (var d = 0; d < dirs.length; d++) {
        var v = dirs[d];
        var mag = Math.sqrt(v.x * v.x + v.y * v.y) || 1;
        offsets.push({ dx: (v.x / mag) * rad, dy: (v.y / mag) * rad });
      }
    }
  }

  var bestDrag = null;
  var bestDragDist = Infinity;
  var bestClick = null;
  var bestClickDist = Infinity;

  for (var i = 0; i < offsets.length; i++) {
    var off = offsets[i];
    var p = { x: pointer.x + off.dx, y: pointer.y + off.dy };
    var hit = getEventTargetAt(p);
    var el = hit && hit.target ? hit.target : null;
    if (!el) continue;

    var dragRoot = getDraggableRoot(el);
    var clickOk = shouldPinchClickTarget(el);

    if (!dragRoot && !clickOk) continue;

    var dist = Math.sqrt(off.dx * off.dx + off.dy * off.dy);
    if (dragRoot && dist < bestDragDist) {
      bestDragDist = dist;
      bestDrag = dragRoot;
    }
    if (!dragRoot && clickOk && dist < bestClickDist) {
      bestClickDist = dist;
      bestClick = el;
    }
  }

  if (bestDrag) return { action: 'drag', target: bestDrag };
  if (bestClick) return { action: 'click', target: bestClick };
  return null;
}

// Main gesture handling function called each frame - handles multiple pointers
export function handleStage3Gestures(usableIndexTipPoints) {
  var nowMs = performance.now();
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
      if (ps.missingSinceMs === null) ps.missingSinceMs = nowMs;

      var missingDuration = nowMs - ps.missingSinceMs;
      var pointerTimeoutMs = typeof state.pointerLostTimeoutMs === 'number' ? state.pointerLostTimeoutMs : 300;
      var drawingTimeoutMs = typeof state.drawingDeselectTimeoutMs === 'number' ? state.drawingDeselectTimeoutMs : 3000;

      // --- AprilTag trigger-on-disappearance ---
      if (ps.isApriltag && ps.lastPointer) {
        var isDrawingMode = state.stage === 4 && getDrawColorForPointer(ps.dragPointerId);
        var hasStickerArmed = !!ps.armedStickerTemplate;
        var hasAnyToolActive = isDrawingMode || hasStickerArmed;

        // Stop current drawing stroke after brief delay
        var strokeStopDelay = typeof state.strokeStopDelayMs === 'number' ? state.strokeStopDelayMs : 50;
        if (ps.isDrawing && missingDuration >= strokeStopDelay) {
          ps.isDrawing = false;
          stopDrawingForPointer(ps.dragPointerId);
        }

        // Determine if we should show blue fill:
        // - Always show when a tool is active (drawing/sticker/annotation armed)
        // - When nothing is active, only show if pointing at one of the 3 buttons
        var shouldShowFill = hasAnyToolActive;
        if (!shouldShowFill && state.stage === 4) {
          var interactionCheck = getInteractionCandidate(ps.lastPointer, 20);
          if (interactionCheck && interactionCheck.target) {
            var t = interactionCheck.target;
            var onDrawBtn = t.closest && t.closest('.ui-draw') && !t.closest('.ui-draw').classList.contains('ui-sticker-instance');
            var onDotBtn = t.closest && t.closest('.ui-dot') && !t.closest('.ui-dot').classList.contains('ui-sticker-instance');
            var onNoteBtn = t.closest && t.closest('.ui-note') && !t.closest('.ui-note').classList.contains('ui-sticker-instance');
            shouldShowFill = onDrawBtn || onDotBtn || onNoteBtn;
          }
        } else if (!shouldShowFill && state.stage !== 4) {
          // In stage 3, show fill on interactive elements
          var interactionCheck = getInteractionCandidate(ps.lastPointer, 20);
          if (interactionCheck && interactionCheck.action === 'click') {
            shouldShowFill = true;
          }
        }

        if (!shouldShowFill) {
          // Not on a button and no tool active - just show cursor, no fill, no trigger
          updatePointerCursor(handId, ps.lastPointer, 0, null);

          // Still need cleanup timeout
          var triggerTimeout = APRILTAG_TRIGGER_DELAY_MS + 200;
          if (missingDuration < triggerTimeout) continue;

          if (ps.cursorEl) {
            ps.cursorEl.classList.add('hidden');
            ps.cursorEl.setAttribute('aria-hidden', 'true');
            ps.cursorEl.style.transform = 'translate(-9999px, -9999px)';
          }
          if (handId === primaryCursorHandId) primaryCursorHandId = null;
          if (ps.cursorEl && ps.cursorEl !== state.dom.mapFingerCursorEl && ps.cursorEl.parentNode) {
            ps.cursorEl.parentNode.removeChild(ps.cursorEl);
          }
          dearmStickerTemplate(ps);
          delete pointerStates[handId];
          continue;
        }

        // Start fill timer on first frame of disappearance
        if (!ps.triggerFillStartMs) {
          ps.triggerFillStartMs = nowMs;
          ps.triggerFired = false;
        }

        var fillProgress = Math.min(1, (nowMs - ps.triggerFillStartMs) / APRILTAG_TRIGGER_DELAY_MS);

        // Show cursor at last known position with fill animation
        updatePointerCursor(handId, ps.lastPointer, fillProgress, 'pinch');

        // Fire trigger after fill completes
        if (!ps.triggerFired && fillProgress >= 1) {
          ps.triggerFired = true;

          if (isDrawingMode) {
            // Drawing 3-trigger flow:
            //   Trigger 1 (on button): activates drawing, drawingStarted = false
            //   Trigger 2 (this): sets drawingStarted = true, next appearance will draw
            //   Trigger 3 (this): deactivates drawing entirely
            if (!ps.drawingStarted) {
              // 2nd trigger: enable actual drawing for next appearance
              ps.drawingStarted = true;
            } else {
              // 3rd trigger: stop and deactivate drawing
              deactivateDrawingForPointer(ps.dragPointerId);
              ps.drawingStarted = false;
            }
            // Stroke was already stopped above
          } else if (hasStickerArmed) {
            // Sticker/annotation armed (activated by previous trigger on button).
            // This is the 2nd trigger - place the sticker at last position.
            var clonedEl = cloneSticker(ps.armedStickerTemplate);
            if (clonedEl) {
              clonedEl.style.left = (ps.lastPointer.x - (clonedEl.offsetWidth || 20) / 2) + 'px';
              clonedEl.style.top = (ps.lastPointer.y - (clonedEl.offsetHeight || 20) / 2) + 'px';
              // Bind to map coordinates
              if (state.viewMode === 'map' && (state.stage === 3 || state.stage === 4)) {
                bindStickerLatLngFromCurrentPosition(clonedEl);
                updateStickerMappingForCurrentView();
              }
              // Auto-expand notes
              if (clonedEl.classList.contains('ui-note')) {
                setTimeout(function() {
                  clonedEl.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }));
                }, 50);
              }
            }
            dearmStickerTemplate(ps); // Dearm after placement
          } else {
            // Nothing activated - check what's at the last position (only 3 buttons)
            var interaction = getInteractionCandidate(ps.lastPointer, 20);
            if (interaction && interaction.target) {
              var target = interaction.target;

              if (state.stage === 4) {
                // Check if pointing at a drawing button
                var drawButton = target.closest ? target.closest('.ui-draw') : null;
                if (drawButton && !drawButton.classList.contains('ui-sticker-instance')) {
                  // 1st trigger: activate drawing mode for this pointer
                  var color = drawButton.dataset && drawButton.dataset.color ? drawButton.dataset.color : '#2bb8ff';
                  var currentColor = getDrawColorForPointer(ps.dragPointerId);
                  if (currentColor === color) {
                    deactivateDrawingForPointer(ps.dragPointerId);
                    ps.drawingStarted = false;
                  } else {
                    activateDrawingForPointer(ps.dragPointerId, color, drawButton);
                    ps.drawingStarted = false;
                  }
                }
                // Check if pointing at a dot template button - arm it (1st trigger)
                else if (target.closest && target.closest('.ui-dot') && !target.closest('.ui-dot').classList.contains('ui-sticker-instance')) {
                  ps.armedStickerTemplate = target.closest('.ui-dot');
                  ps.armedStickerTemplate.classList.add('ui-dot--active');
                }
                // Check if pointing at a note template button - arm it (1st trigger)
                else if (target.closest && target.closest('.ui-note') && !target.closest('.ui-note').classList.contains('ui-sticker-instance')) {
                  ps.armedStickerTemplate = target.closest('.ui-note');
                  ps.armedStickerTemplate.classList.add('ui-note--active');
                }
                // Not one of the 3 buttons - do nothing (Case 2: no trigger outside buttons)
              } else if (interaction.action === 'click') {
                // Stage 3 or other: dispatch click on interactive elements
                dispatchClickAt(ps.lastPointer, ps.dragPointerId);
              }
            }
            // No interaction target: do nothing
          }
        }

        // Clean up after all timeouts + trigger delay have passed.
        // If a sticker is armed or drawing mode is active, keep the state alive longer
        // so it persists when the tag reappears for the next step.
        var hasDrawingActiveNow = getDrawColorForPointer(ps.dragPointerId);
        var triggerTimeout = APRILTAG_TRIGGER_DELAY_MS + 200; // extra buffer
        var keepAlive = !!ps.armedStickerTemplate || !!hasDrawingActiveNow;
        var maxTimeout = keepAlive ? drawingTimeoutMs : triggerTimeout;
        if (missingDuration < maxTimeout) continue;

        // Hide cursor
        if (ps.cursorEl) {
          ps.cursorEl.classList.add('hidden');
          ps.cursorEl.setAttribute('aria-hidden', 'true');
          ps.cursorEl.style.transform = 'translate(-9999px, -9999px)';
        }

        // Reset primary cursor assignment if this was the primary hand
        if (handId === primaryCursorHandId) {
          primaryCursorHandId = null;
        }

        // Clean up secondary cursors
        if (ps.cursorEl && ps.cursorEl !== state.dom.mapFingerCursorEl && ps.cursorEl.parentNode) {
          ps.cursorEl.parentNode.removeChild(ps.cursorEl);
        }

        dearmStickerTemplate(ps);
        delete pointerStates[handId];
        continue;
      }

      // --- Non-AprilTag (hand tracking) pointer lost handling ---
      // Hide cursor while missing
      if (ps.cursorEl) {
        ps.cursorEl.classList.add('hidden');
        ps.cursorEl.setAttribute('aria-hidden', 'true');
        ps.cursorEl.style.transform = 'translate(-9999px, -9999px)';
      }

      // End drag after short timeout
      if (ps.dragActive && missingDuration >= pointerTimeoutMs) {
        endDragForPointer(ps, ps.lastPointer);
      }

      // Stop current stroke after brief delay when tag disappears
      var strokeStopDelay = typeof state.strokeStopDelayMs === 'number' ? state.strokeStopDelayMs : 50;
      if (ps.isDrawing && missingDuration >= strokeStopDelay) {
        ps.isDrawing = false;
        stopDrawingForPointer(ps.dragPointerId);
      }

      // Deactivate drawing mode (deselect the button) after longer timeout
      var hasDrawingActive = getDrawColorForPointer(ps.dragPointerId);
      if (hasDrawingActive && missingDuration >= drawingTimeoutMs) {
        deactivateDrawingForPointer(ps.dragPointerId);
      }

      // Only fully clean up pointer state after both timeouts have passed
      var maxTimeout = Math.max(pointerTimeoutMs, hasDrawingActive ? drawingTimeoutMs : pointerTimeoutMs);
      if (missingDuration < maxTimeout) continue;

      // Reset primary cursor assignment if this was the primary hand
      if (handId === primaryCursorHandId) {
        primaryCursorHandId = null;
      }

      // Clean up secondary cursors (don't remove the primary cursor, just hide it)
      if (ps.cursorEl && ps.cursorEl !== state.dom.mapFingerCursorEl && ps.cursorEl.parentNode) {
        ps.cursorEl.parentNode.removeChild(ps.cursorEl);
      }

      dearmStickerTemplate(ps);
      delete pointerStates[handId];
    }
  }

  // No pointers visible - but don't hide primary cursor if an AprilTag is showing
  // its trigger-on-disappearance fill animation (the missing-hands loop above
  // already positioned and showed the cursor at the last known location).
  if (viewportPoints.length === 0) {
    var anyApriltagFilling = false;
    for (var hid in pointerStates) {
      if (pointerStates[hid].isApriltag && pointerStates[hid].lastPointer && pointerStates[hid].triggerFillStartMs) {
        anyApriltagFilling = true;
        break;
      }
    }
    if (!anyApriltagFilling) {
      updatePrimaryCursor(null);
    }
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
  ps.missingSinceMs = null;
  ps.prevPointer = ps.lastPointer;
  ps.lastPointer = pointer;

  var isApriltag = !!(handData && handData.isApriltag);
  var isTouch = (handData && typeof handData.isTouch === 'boolean') ? handData.isTouch : null;

  var nowMs = performance.now();
  var threshold = state.holdStillThresholdPx;

  // In AprilTag mode with stereo touch sensing, hovering should not trigger interactions.
  // Still show cursor but cancel any active drawing and prevent trigger-on-disappearance.
  if (isApriltag && isTouch === false) {
    ps.isApriltag = true;
    if (ps.isDrawing) {
      ps.isDrawing = false;
      stopDrawingForPointer(ps.dragPointerId);
    }
    ps.triggerFillStartMs = 0;
    ps.triggerFired = false;
    updatePointerCursor(handIndex, pointer, 0, null);
    ps.prevPointerTimeMs = nowMs;
    return;
  }

  // AprilTag while visible: show cursor, draw if drawing mode active, but NO pinch-hold arming.
  // Trigger happens on disappearance (handled in the missing-hands section).
  if (isApriltag) {
    ps.isApriltag = true;
    ps.triggerFillStartMs = 0;  // Reset fill since tag is visible again
    ps.triggerFired = false;

    var isDrawingMode = state.stage === 4 && getDrawColorForPointer(ps.dragPointerId);

    // If drawing mode is active AND drawing has been started (2nd trigger),
    // draw while the tag is visible.
    if (isDrawingMode && ps.drawingStarted) {
      if (!ps.isDrawing) {
        // Start a new stroke
        ps.isDrawing = true;
        startDrawingAtPoint(ps.dragPointerId, pointer.x, pointer.y);
      } else {
        // Continue drawing
        continueDrawingAtPoint(ps.dragPointerId, pointer.x, pointer.y);
      }
      updatePointerCursor(handIndex, pointer, 1, 'draw');
      ps.prevPointerTimeMs = nowMs;
      return;
    }

    // Show cursor dot without ring fill (progress = 0)
    updatePointerCursor(handIndex, pointer, 0, null);
    ps.prevPointerTimeMs = nowMs;
    return;
  }

  ps.pinchStartMs = 0;
  ps.pinchAnchor = null;
  ps.pinchFired = false;
  ps.pinchFiredAt = null;

  if (ps.dragActive) {
    endDragForPointer(ps, pointer);
    updatePointerCursor(handIndex, pointer, 0, null);
    ps.prevPointerTimeMs = nowMs;
    return;
  }

  if (ps.isDrawing) {
    ps.isDrawing = false;
    stopDrawingForPointer(ps.dragPointerId);
    updatePointerCursor(handIndex, pointer, 0, null);
    ps.prevPointerTimeMs = nowMs;
    return;
  }

  if (!ps.dwellAnchor) {
    // First frame - set anchor
    ps.dwellAnchor = pointer;
    ps.dwellStartMs = nowMs;
    ps.dwellFired = false;
    updatePointerCursor(handIndex, pointer, 0, null);
    ps.prevPointerTimeMs = nowMs;
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
      ps.prevPointerTimeMs = nowMs;
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
    ps.prevPointerTimeMs = nowMs;
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

  ps.prevPointerTimeMs = nowMs;
}

// Drag functions per pointer
function startDragForPointer(ps, pointer, forcedTarget) {
  var target = forcedTarget;
  if (!target) {
    var hit = getEventTargetAt(pointer);
    target = hit.target || document.body;
  }

  // Stage 4: Handle sticker template cloning and direct drag
  if (state.stage === 4) {
    var isNoteTemplate = target.classList.contains('ui-note') && !target.classList.contains('ui-sticker-instance');
    var isDotTemplate = target.classList.contains('ui-dot') && !target.classList.contains('ui-sticker-instance');
    var isTemplate = isNoteTemplate || isDotTemplate;
    var isInstance = target.classList.contains('ui-sticker-instance');

    if (isTemplate || isInstance) {
      // Clone template or use existing instance
      var dragEl = isTemplate ? cloneSticker(target) : target;
      if (dragEl) {
        // Use stage4Drawing's startStickerDrag for proper handling
        var syntheticEvent = {
          clientX: pointer.x,
          clientY: pointer.y,
          pointerId: ps.dragPointerId
        };
        // For note templates, expand the form after dropping
        var dragOptions = isNoteTemplate ? { expandNoteOnDrop: true } : {};
        startStickerDrag(dragEl, syntheticEvent, dragOptions);
        ps.dragTarget = dragEl;
        ps.dragActive = true;
        ps.pinchFired = true;
        ps.pinchFiredAt = { x: pointer.x, y: pointer.y };
        return;
      }
    }
  }

  ps.dragTarget = target;
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
    // Dearm sticker template
    dearmStickerTemplate(ps);
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
