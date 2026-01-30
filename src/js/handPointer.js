export function createHandPointer(options) {
  options = options || {};

  var dragSelector = options.dragSelector || '[data-hand-draggable="true"]';
  var clickMoveThresholdPx = options.clickMoveThresholdPx || 12;
  var clickMoveThresholdPxForClickables =
    typeof options.clickMoveThresholdPxForClickables === 'number'
      ? options.clickMoveThresholdPxForClickables
      : null;
  var clickMoveThresholdPxForInputs = options.clickMoveThresholdPxForInputs || 40;
  var clickMaxDurationMs = options.clickMaxDurationMs || 350;

  var pressed = false;
  var pressTimeMs = 0;
  var pressX = 0;
  var pressY = 0;
  var pressClickEl = null;

  var lastX = 0;
  var lastY = 0;
  var maxMoveSq = 0;

  var dragEl = null;
  var dragOffsetX = 0;
  var dragOffsetY = 0;
  var dragClass = '';

  function clearDragState() {
    if (dragEl && dragClass) {
      dragEl.classList.remove(dragClass);
    }
    dragEl = null;
    dragOffsetX = 0;
    dragOffsetY = 0;
    dragClass = '';
  }

  function clamp(value, min, max) {
    if (value < min) return min;
    if (value > max) return max;
    return value;
  }

  function defaultClickableMoveThresholdPx() {
    try {
      // Make tap tolerance scale with screen size so it's not overly strict on high-res / larger displays.
      var minDim = Math.max(1, Math.min(window.innerWidth || 1, window.innerHeight || 1));
      return clamp(minDim * 0.06, 20, 140);
    } catch {
      return 60;
    }
  }

  function reset() {
    pressed = false;
    pressTimeMs = 0;
    pressX = 0;
    pressY = 0;
    pressClickEl = null;
    lastX = 0;
    lastY = 0;
    maxMoveSq = 0;
    clearDragState();
  }

  function findDragTargetAtPoint(x, y) {
    if (typeof document === 'undefined' || !document.elementFromPoint) return null;
    var hit = document.elementFromPoint(x, y);
    if (!hit || !hit.closest) return null;
    var closest = hit.closest(dragSelector);
    if (closest) return closest;

    // Fallback: if the visual layer is not hit-testable (e.g. pointer-events quirks),
    // do a simple bounding-box hit test over marked draggable elements.
    var candidates = document.querySelectorAll(dragSelector);
    for (var i = candidates.length - 1; i >= 0; i--) {
      var el = candidates[i];
      if (!el || !el.getBoundingClientRect) continue;
      var rect = el.getBoundingClientRect();
      if (x >= rect.left && x <= rect.right && y >= rect.top && y <= rect.bottom) return el;
    }

    return null;
  }

  function isBadHitTarget(hit) {
    return !hit || hit === document.documentElement || hit === document.body || hit.tagName === 'IFRAME';
  }

  function findClickTargetAtPoint(x, y) {
    if (typeof document === 'undefined' || !document.elementFromPoint) return null;
    var hit = document.elementFromPoint(x, y);
    if (isBadHitTarget(hit)) return null;

    var clickable =
      hit.closest &&
      hit.closest('button, a, input, label, select, textarea, [role="button"], [role="link"]');
    return clickable || hit;
  }

  function performClick(target) {
    if (!target) return;

    // Inputs (especially text fields) usually need focus, not just click.
    if (target.tagName === 'INPUT' || target.tagName === 'TEXTAREA') {
      // Try to focus immediately to help on platforms that are picky about timing.
      if (typeof target.focus === 'function') {
        try {
          target.focus({ preventScroll: true });
        } catch {
          try {
            target.focus();
          } catch {}
        }
      }
    }

    if (typeof target.click === 'function') target.click();
  }

  function update(state) {
    state = state || {};
    var nowMs = typeof state.nowMs === 'number' ? state.nowMs : performance.now();
    var isPressed = !!state.pressed;

    var hasPoint =
      typeof state.clientX === 'number' &&
      typeof state.clientY === 'number' &&
      isFinite(state.clientX) &&
      isFinite(state.clientY);

    if (!hasPoint) {
      if (pressed) {
        clearDragState();
      }
      pressed = false;
      return;
    }

    var x = state.clientX;
    var y = state.clientY;

    if (isPressed && !pressed) {
      pressed = true;
      pressTimeMs = nowMs;
      pressX = x;
      pressY = y;
      pressClickEl = findClickTargetAtPoint(x, y);
      lastX = x;
      lastY = y;
      maxMoveSq = 0;

      // If this is a text field, focus right away (not only on release).
      if (pressClickEl && (pressClickEl.tagName === 'INPUT' || pressClickEl.tagName === 'TEXTAREA')) {
        performClick(pressClickEl);
      }

      dragEl = findDragTargetAtPoint(x, y);
      if (dragEl) {
        var rect = dragEl.getBoundingClientRect();
        dragOffsetX = x - rect.left;
        dragOffsetY = y - rect.top;
        dragClass = dragEl.dataset.handDraggingClass || '';
        if (dragClass) dragEl.classList.add(dragClass);
      }

      return;
    }

    if (isPressed && pressed) {
      lastX = x;
      lastY = y;

      var fromPressX = x - pressX;
      var fromPressY = y - pressY;
      var distSq = fromPressX * fromPressX + fromPressY * fromPressY;
      if (distSq > maxMoveSq) maxMoveSq = distSq;

      if (dragEl) {
        dragEl.style.left = x - dragOffsetX + 'px';
        dragEl.style.top = y - dragOffsetY + 'px';
      }
      return;
    }

    if (!isPressed && pressed) {
      var durationMs = nowMs - pressTimeMs;
      var thresholdPx =
        pressClickEl && (pressClickEl.tagName === 'INPUT' || pressClickEl.tagName === 'TEXTAREA')
          ? clickMoveThresholdPxForInputs
          : pressClickEl
            ? clickMoveThresholdPxForClickables !== null
              ? clickMoveThresholdPxForClickables
              : defaultClickableMoveThresholdPx()
          : clickMoveThresholdPx;
      var clickThresholdSq = thresholdPx * thresholdPx;

      var isTap = maxMoveSq <= clickThresholdSq;
      // If the press started on something clearly clickable, allow a longer "hold then release"
      // without losing the click (useful for pinch interactions).
      var didClick = isTap && (durationMs <= clickMaxDurationMs || !!pressClickEl);

      clearDragState();
      pressed = false;

      if (didClick) {
        // Prefer the element we targeted at press-time to avoid drift/jitter on release.
        if (pressClickEl) performClick(pressClickEl);
        else performClick(findClickTargetAtPoint(pressX, pressY));
      } else if (pressClickEl) {
        try {
          var tag = pressClickEl.tagName || 'UNKNOWN';
          var id = pressClickEl.id ? '#' + pressClickEl.id : '';
          console.log('[hand] click skipped', {
            target: tag + id,
            durationMs: Math.round(durationMs),
            maxMovePx: Math.round(Math.sqrt(maxMoveSq)),
            thresholdPx: thresholdPx,
          });
        } catch {}
      }

      pressClickEl = null;
    }
  }

  return {
    update: update,
    reset: reset,
  };
}
