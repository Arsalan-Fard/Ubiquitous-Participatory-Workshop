var CONTROLLER_STORAGE_KEY = 'phoneControllerClientId';
var CONTROLLER_HEARTBEAT_INTERVAL_MS = 150;
var CONTROLLER_HEARTBEAT_ENDPOINT = '/api/controller/heartbeat';

function getOrCreateClientId() {
  var existing = '';
  try {
    existing = String(localStorage.getItem(CONTROLLER_STORAGE_KEY) || '').trim();
  } catch (e) {
    existing = '';
  }
  if (existing) return existing;

  var generated = 'ctrl-' + Math.random().toString(36).slice(2, 10) + '-' + Date.now().toString(36);
  try {
    localStorage.setItem(CONTROLLER_STORAGE_KEY, generated);
  } catch (e2) { }
  return generated;
}

function createStyles() {
  var style = document.createElement('style');
  style.textContent = [
    ':root { color-scheme: dark; }',
    'body.controller-mode { margin: 0; min-height: 100vh; font-family: "Segoe UI", Tahoma, sans-serif; background: linear-gradient(160deg, #111827 0%, #1f2937 60%, #0b1220 100%); color: #f3f4f6; }',
    '.controller-root { max-width: 420px; min-height: 100vh; margin: 0 auto; padding: 28px 16px; display: grid; align-content: start; gap: 16px; justify-items: center; box-sizing: border-box; }',
    '.controller-title { font-size: 22px; font-weight: 700; letter-spacing: 0.2px; }',
    '.controller-select { width: 120px; font-size: 24px; font-weight: 700; text-align: center; text-align-last: center; padding: 10px 8px; border-radius: 12px; border: 1px solid rgba(255,255,255,0.24); background: rgba(17,24,39,0.8); color: #f9fafb; }',
    '.controller-tool-grid { width: 204px; display: grid; grid-template-columns: repeat(2, 96px); gap: 12px; }',
    '.controller-tool-row { width: 204px; }',
    '.controller-tool-btn { border: 2px solid rgba(255, 255, 255, 0.85); background: rgba(255, 255, 255, 0.10); box-shadow: 0 14px 30px rgba(0, 0, 0, 0.35); touch-action: none; user-select: none; -webkit-user-select: none; cursor: pointer; display: inline-flex; align-items: center; justify-content: center; padding: 0; position: relative; overflow: hidden; color: #f9fafb; transition: transform 120ms ease, box-shadow 120ms ease, background 120ms ease; }',
    '.controller-tool-btn--circle { width: 96px; height: 96px; border-radius: 50%; }',
    '.controller-tool-btn--rect { width: 100%; height: 56px; border-radius: 14px; font-size: 22px; font-weight: 700; letter-spacing: 0.2px; }',
    '.controller-tool-btn::before { content: ""; position: absolute; inset: 0; border-radius: inherit; pointer-events: none; background: radial-gradient(circle at center, rgba(255, 255, 255, 0.96) 0%, rgba(255, 255, 255, 0.58) 40%, rgba(255, 255, 255, 0.22) 68%, rgba(255, 255, 255, 0.02) 100%); opacity: 0; transition: opacity 80ms linear; }',
    '.controller-tool-btn:active { transform: scale(0.98); }',
    '.controller-tool-btn.is-active { box-shadow: 0 0 0 3px rgba(255, 255, 255, 0.85), 0 14px 30px rgba(0, 0, 0, 0.35); transform: scale(1.08); background: rgba(43, 184, 255, 0.28); }',
    '.controller-tool-btn.is-active::before { opacity: 1; }',
    '.controller-tool-icon { width: 44px; height: 44px; pointer-events: none; position: relative; z-index: 1; }',
    '.controller-tool-label { position: relative; z-index: 1; }'
  ].join('');
  document.head.appendChild(style);
}

function roundedRectPath(ctx, x, y, w, h, r) {
  var radius = Math.max(0, Math.min(r, Math.min(w, h) * 0.5));
  ctx.beginPath();
  ctx.moveTo(x + radius, y);
  ctx.lineTo(x + w - radius, y);
  ctx.quadraticCurveTo(x + w, y, x + w, y + radius);
  ctx.lineTo(x + w, y + h - radius);
  ctx.quadraticCurveTo(x + w, y + h, x + w - radius, y + h);
  ctx.lineTo(x + radius, y + h);
  ctx.quadraticCurveTo(x, y + h, x, y + h - radius);
  ctx.lineTo(x, y + radius);
  ctx.quadraticCurveTo(x, y, x + radius, y);
  ctx.closePath();
}

function drawScribble(ctx, color, w, h) {
  ctx.save();
  ctx.lineCap = 'round';
  ctx.lineJoin = 'round';
  ctx.strokeStyle = color;
  ctx.lineWidth = Math.max(2, Math.floor(Math.min(w, h) * 0.12));

  ctx.beginPath();
  ctx.moveTo(w * 0.18, h * 0.58);
  ctx.bezierCurveTo(w * 0.32, h * 0.22, w * 0.48, h * 0.78, w * 0.64, h * 0.42);
  ctx.bezierCurveTo(w * 0.72, h * 0.26, w * 0.80, h * 0.30, w * 0.86, h * 0.22);
  ctx.stroke();

  ctx.beginPath();
  ctx.fillStyle = color;
  ctx.arc(w * 0.22, h * 0.62, ctx.lineWidth * 0.55, 0, 2 * Math.PI);
  ctx.fill();

  ctx.restore();
}

function drawStickerIcon(ctx, color, w, h) {
  ctx.save();
  var radius = Math.max(7, Math.min(w, h) * 0.26);
  ctx.fillStyle = color;
  ctx.strokeStyle = 'rgba(255,255,255,0.9)';
  ctx.lineWidth = Math.max(2, Math.floor(Math.min(w, h) * 0.07));
  ctx.beginPath();
  ctx.arc(w * 0.5, h * 0.5, radius, 0, 2 * Math.PI);
  ctx.fill();
  ctx.stroke();
  ctx.restore();
}

function drawNoteIcon(ctx, color, w, h) {
  ctx.save();
  var x = w * 0.2;
  var y = h * 0.14;
  var rw = w * 0.6;
  var rh = h * 0.72;
  var r = Math.max(4, Math.floor(Math.min(w, h) * 0.1));

  roundedRectPath(ctx, x, y, rw, rh, r);
  ctx.fillStyle = 'rgba(255,255,255,0.14)';
  ctx.fill();
  ctx.strokeStyle = color;
  ctx.lineWidth = Math.max(2, Math.floor(Math.min(w, h) * 0.08));
  ctx.stroke();

  ctx.beginPath();
  ctx.moveTo(x + rw * 0.28, y + rh * 0.38);
  ctx.lineTo(x + rw * 0.72, y + rh * 0.38);
  ctx.moveTo(x + rw * 0.28, y + rh * 0.62);
  ctx.lineTo(x + rw * 0.72, y + rh * 0.62);
  ctx.stroke();
  ctx.restore();
}

function drawEraserIcon(ctx, color, w, h) {
  ctx.save();
  ctx.translate(w * 0.5, h * 0.5);
  ctx.rotate(-0.38);
  ctx.fillStyle = 'rgba(255,255,255,0.14)';
  ctx.strokeStyle = color;
  ctx.lineWidth = Math.max(2, Math.floor(Math.min(w, h) * 0.08));

  var bodyW = w * 0.52;
  var bodyH = h * 0.34;
  roundedRectPath(ctx, -bodyW * 0.5, -bodyH * 0.5, bodyW, bodyH, bodyH * 0.24);
  ctx.fill();
  ctx.stroke();

  ctx.beginPath();
  ctx.moveTo(-bodyW * 0.12, bodyH * 0.5);
  ctx.lineTo(bodyW * 0.36, bodyH * 0.5);
  ctx.stroke();
  ctx.restore();
}

function renderToolIcon(canvasEl, tool) {
  var ctx = canvasEl.getContext('2d');
  if (!ctx) return;
  var w = canvasEl.width;
  var h = canvasEl.height;
  ctx.clearRect(0, 0, w, h);

  if (tool === 'draw') {
    drawScribble(ctx, '#2bb8ff', w, h);
    return;
  }
  if (tool === 'dot') {
    drawStickerIcon(ctx, '#ff4d42', w, h);
    return;
  }
  if (tool === 'note') {
    drawNoteIcon(ctx, '#ffd166', w, h);
    return;
  }
  if (tool === 'eraser') {
    drawEraserIcon(ctx, '#f9fafb', w, h);
  }
}

function buildOptionElements(selectEl) {
  for (var tagId = 10; tagId <= 30; tagId++) {
    var opt = document.createElement('option');
    opt.value = String(tagId);
    opt.textContent = String(tagId);
    selectEl.appendChild(opt);
  }
}

function sendHeartbeat(payload, useBeacon) {
  if (useBeacon && typeof navigator !== 'undefined' && typeof navigator.sendBeacon === 'function') {
    try {
      var blob = new Blob([JSON.stringify(payload)], { type: 'application/json' });
      navigator.sendBeacon(CONTROLLER_HEARTBEAT_ENDPOINT, blob);
      return Promise.resolve(null);
    } catch (e) {
      return Promise.resolve(null);
    }
  }

  return fetch(CONTROLLER_HEARTBEAT_ENDPOINT, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    cache: 'no-store',
    body: JSON.stringify(payload),
    keepalive: !!useBeacon,
  }).then(function(resp) {
    return resp.text().then(function(text) {
      var body = null;
      try { body = text ? JSON.parse(text) : null; } catch (e) { body = null; }
      if (!resp.ok || !body || body.ok === false) {
        throw new Error(body && body.error ? String(body.error) : ('HTTP ' + resp.status));
      }
      return body;
    });
  });
}

function buildCircleToolButton(toolDef) {
  var btn = document.createElement('button');
  btn.className = 'controller-tool-btn controller-tool-btn--circle';
  btn.type = 'button';
  btn.dataset.tool = toolDef.tool;
  btn.setAttribute('aria-label', toolDef.ariaLabel);

  var iconCanvas = document.createElement('canvas');
  iconCanvas.className = 'controller-tool-icon';
  iconCanvas.width = 44;
  iconCanvas.height = 44;
  renderToolIcon(iconCanvas, toolDef.tool);
  btn.appendChild(iconCanvas);

  return btn;
}

function buildSelectionButton() {
  var btn = document.createElement('button');
  btn.className = 'controller-tool-btn controller-tool-btn--rect';
  btn.type = 'button';
  btn.dataset.tool = 'selection';
  btn.setAttribute('aria-label', 'Hold edit tool');

  var label = document.createElement('span');
  label.className = 'controller-tool-label';
  label.textContent = 'Edit';
  btn.appendChild(label);
  return btn;
}

function bindHoldEvents(buttonEl, onStart, onStop, getActivePointerId) {
  buttonEl.addEventListener('pointerdown', function(e) {
    if (e.button !== undefined && e.button !== 0) return;
    e.preventDefault();
    try { buttonEl.setPointerCapture(e.pointerId); } catch (err) { }
    onStart(e.pointerId, buttonEl.dataset.tool || 'draw', buttonEl);
  });

  buttonEl.addEventListener('pointerup', function(e) {
    if (getActivePointerId() !== null && e.pointerId !== getActivePointerId()) return;
    e.preventDefault();
    onStop(false);
  });

  buttonEl.addEventListener('pointercancel', function(e) {
    if (getActivePointerId() !== null && e.pointerId !== getActivePointerId()) return;
    onStop(false);
  });

  buttonEl.addEventListener('lostpointercapture', function() {
    onStop(false);
  });
}

export function initControllerMode() {
  var clientId = getOrCreateClientId();
  var activePointerId = null;
  var holding = false;
  var heartbeatTimerId = 0;
  var activeTool = 'draw';
  var activeButtonEl = null;
  var toolButtons = [];

  document.body.className = '';
  document.body.classList.add('controller-mode');
  document.body.textContent = '';
  createStyles();

  var root = document.createElement('main');
  root.className = 'controller-root';

  var title = document.createElement('div');
  title.className = 'controller-title';
  title.textContent = 'Phone Controller';
  root.appendChild(title);

  var triggerSelectEl = document.createElement('select');
  triggerSelectEl.className = 'controller-select';
  triggerSelectEl.setAttribute('aria-label', 'Participant ID');
  buildOptionElements(triggerSelectEl);
  root.appendChild(triggerSelectEl);

  var gridEl = document.createElement('div');
  gridEl.className = 'controller-tool-grid';

  var circleTools = [
    { tool: 'draw', ariaLabel: 'Hold draw tool' },
    { tool: 'dot', ariaLabel: 'Hold sticker tool' },
    { tool: 'note', ariaLabel: 'Hold annotation tool' },
    { tool: 'eraser', ariaLabel: 'Hold eraser tool' }
  ];

  for (var i = 0; i < circleTools.length; i++) {
    var toolBtn = buildCircleToolButton(circleTools[i]);
    toolButtons.push(toolBtn);
    gridEl.appendChild(toolBtn);
  }
  root.appendChild(gridEl);

  var editRowEl = document.createElement('div');
  editRowEl.className = 'controller-tool-row';
  var editBtn = buildSelectionButton();
  toolButtons.push(editBtn);
  editRowEl.appendChild(editBtn);
  root.appendChild(editRowEl);

  document.body.appendChild(root);

  function buildPayload(isActive) {
    return {
      clientId: clientId,
      tool: activeTool,
      triggerTagId: parseInt(triggerSelectEl.value, 10),
      active: !!isActive,
    };
  }

  function setUiActive(isActive) {
    for (var i = 0; i < toolButtons.length; i++) {
      toolButtons[i].classList.remove('is-active');
    }
    if (isActive && activeButtonEl) activeButtonEl.classList.add('is-active');
  }

  function pushHeartbeat(isActive, useBeacon) {
    return sendHeartbeat(buildPayload(isActive), !!useBeacon).catch(function() {});
  }

  function clearHeartbeatLoop() {
    if (!heartbeatTimerId) return;
    clearInterval(heartbeatTimerId);
    heartbeatTimerId = 0;
  }

  function startHolding(pointerId, toolId, buttonEl) {
    if (holding) return;
    holding = true;
    activePointerId = pointerId;
    activeTool = toolId || 'draw';
    activeButtonEl = buttonEl || null;
    setUiActive(true);
    pushHeartbeat(true, false);
    heartbeatTimerId = setInterval(function() {
      pushHeartbeat(true, false);
    }, CONTROLLER_HEARTBEAT_INTERVAL_MS);
  }

  function stopHolding(useBeacon) {
    if (!holding) return;
    holding = false;
    activePointerId = null;
    clearHeartbeatLoop();
    setUiActive(false);
    activeButtonEl = null;
    pushHeartbeat(false, !!useBeacon);
  }

  function getActivePointerId() {
    return activePointerId;
  }

  for (var bi = 0; bi < toolButtons.length; bi++) {
    bindHoldEvents(toolButtons[bi], startHolding, stopHolding, getActivePointerId);
  }

  triggerSelectEl.addEventListener('change', function() {
    if (!holding) return;
    pushHeartbeat(true, false);
  });

  window.addEventListener('blur', function() { stopHolding(false); });
  document.addEventListener('visibilitychange', function() {
    if (document.hidden) stopHolding(true);
  });
  window.addEventListener('beforeunload', function() {
    stopHolding(true);
  });
}
