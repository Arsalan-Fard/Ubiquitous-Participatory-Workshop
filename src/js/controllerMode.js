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
  } catch (e2) { /* ignore */ }
  return generated;
}

function createStyles() {
  var style = document.createElement('style');
  style.textContent = [
    ':root { color-scheme: dark; }',
    'body.controller-mode { margin: 0; min-height: 100vh; font-family: "Segoe UI", Tahoma, sans-serif; background: linear-gradient(160deg, #111827 0%, #1f2937 60%, #0b1220 100%); color: #f3f4f6; }',
    '.controller-root { max-width: 420px; margin: 0 auto; padding: 24px 16px 28px; display: grid; gap: 14px; }',
    '.controller-title { font-size: 22px; font-weight: 700; letter-spacing: 0.2px; }',
    '.controller-subtitle { font-size: 13px; opacity: 0.8; line-height: 1.4; }',
    '.controller-label { font-size: 13px; opacity: 0.9; font-weight: 600; }',
    '.controller-select { width: 100%; font-size: 18px; padding: 12px 10px; border-radius: 12px; border: 1px solid rgba(255,255,255,0.2); background: rgba(17,24,39,0.8); color: #f9fafb; }',
    '.controller-button { width: 100%; min-height: 120px; border: none; border-radius: 18px; font-size: 22px; font-weight: 700; color: #f8fafc; background: linear-gradient(160deg, #0284c7, #0369a1); box-shadow: 0 14px 36px rgba(2,132,199,0.34); touch-action: none; user-select: none; -webkit-user-select: none; }',
    '.controller-button.is-active { background: linear-gradient(160deg, #16a34a, #15803d); box-shadow: 0 18px 44px rgba(21,128,61,0.44); transform: translateY(1px); }',
    '.controller-hint { font-size: 12px; opacity: 0.82; }',
    '.controller-status { font-size: 12px; min-height: 1.2em; opacity: 0.92; }',
    '.controller-link { margin-top: 4px; font-size: 12px; opacity: 0.88; color: #93c5fd; text-decoration: none; }'
  ].join('');
  document.head.appendChild(style);
}

function buildOptionElements(selectEl) {
  for (var tagId = 10; tagId <= 30; tagId++) {
    var opt = document.createElement('option');
    opt.value = String(tagId);
    opt.textContent = 'Trigger ' + String(tagId);
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

export function initControllerMode() {
  var clientId = getOrCreateClientId();
  var activePointerId = null;
  var holding = false;
  var heartbeatTimerId = 0;

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

  var subtitle = document.createElement('div');
  subtitle.className = 'controller-subtitle';
  subtitle.textContent = 'Select trigger ID, then hold Draw to activate drawing on the laptop for the linked primary tag.';
  root.appendChild(subtitle);

  var label = document.createElement('label');
  label.className = 'controller-label';
  label.textContent = 'Trigger ID';
  root.appendChild(label);

  var triggerSelectEl = document.createElement('select');
  triggerSelectEl.className = 'controller-select';
  triggerSelectEl.setAttribute('aria-label', 'Trigger tag ID');
  buildOptionElements(triggerSelectEl);
  root.appendChild(triggerSelectEl);

  var drawBtn = document.createElement('button');
  drawBtn.className = 'controller-button';
  drawBtn.type = 'button';
  drawBtn.textContent = 'Hold To Draw';
  root.appendChild(drawBtn);

  var hint = document.createElement('div');
  hint.className = 'controller-hint';
  hint.textContent = 'Keep pressing while drawing. Releasing stops draw mode.';
  root.appendChild(hint);

  var status = document.createElement('div');
  status.className = 'controller-status';
  status.textContent = 'Idle';
  root.appendChild(status);

  var link = document.createElement('a');
  link.className = 'controller-link';
  link.href = '/';
  link.textContent = 'Open workshop mode';
  root.appendChild(link);

  document.body.appendChild(root);

  function buildPayload(isActive) {
    return {
      clientId: clientId,
      tool: 'draw',
      triggerTagId: parseInt(triggerSelectEl.value, 10),
      active: !!isActive,
    };
  }

  function setUiActive(isActive) {
    drawBtn.classList.toggle('is-active', !!isActive);
    drawBtn.textContent = isActive ? 'Drawing Active' : 'Hold To Draw';
  }

  function pushHeartbeat(isActive, useBeacon) {
    return sendHeartbeat(buildPayload(isActive), !!useBeacon).then(function(body) {
      if (!body || !body.controller) {
        status.textContent = isActive ? ('Active: trigger ' + triggerSelectEl.value) : 'Idle';
        return;
      }
      var activeClients = parseInt(body.controller.activeClients, 10);
      if (!isFinite(activeClients)) activeClients = 0;
      status.textContent = (isActive ? ('Active: trigger ' + triggerSelectEl.value) : 'Idle') +
        ' | online controllers: ' + String(activeClients);
    }).catch(function(err) {
      status.textContent = 'Network: ' + String(err && err.message ? err.message : err);
    });
  }

  function clearHeartbeatLoop() {
    if (!heartbeatTimerId) return;
    clearInterval(heartbeatTimerId);
    heartbeatTimerId = 0;
  }

  function startHolding(pointerId) {
    if (holding) return;
    holding = true;
    activePointerId = pointerId;
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
    pushHeartbeat(false, !!useBeacon);
  }

  drawBtn.addEventListener('pointerdown', function(e) {
    if (e.button !== undefined && e.button !== 0) return;
    e.preventDefault();
    try { drawBtn.setPointerCapture(e.pointerId); } catch (err) { /* ignore */ }
    startHolding(e.pointerId);
  });

  drawBtn.addEventListener('pointerup', function(e) {
    if (activePointerId !== null && e.pointerId !== activePointerId) return;
    e.preventDefault();
    stopHolding(false);
  });
  drawBtn.addEventListener('pointercancel', function(e) {
    if (activePointerId !== null && e.pointerId !== activePointerId) return;
    stopHolding(false);
  });
  drawBtn.addEventListener('lostpointercapture', function() {
    stopHolding(false);
  });

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
