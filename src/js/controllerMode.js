var CONTROLLER_STORAGE_KEY = 'phoneControllerClientId';
var CONTROLLER_HEARTBEAT_INTERVAL_MS = 150;
var CONTROLLER_HEARTBEAT_ENDPOINT = '/api/controller/heartbeat';
var CONTROLLER_AUDIO_UPLOAD_ENDPOINT = '/api/controller/audio';
var CONTROLLER_AUDIO_UPLOAD_INTERVAL_MS = 30000; // upload audio chunk every 30s
var CONTROLLER_NOTE_TEXT_MAX_LEN = 500;

var CONTROLLER_COLORS = [
  { color: '#000000', label: 'Black' },
  { color: '#2bb8ff', label: 'Blue' },
  { color: '#45d483', label: 'Green' },
  { color: '#ff5b5b', label: 'Red' }
];
var CONTROLLER_DEFAULT_COLOR = '#2bb8ff';

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
    '.controller-top-row { display: flex; gap: 12px; align-items: center; justify-content: center; width: 100%; max-width: 300px; }',
    '.controller-select { width: 120px; font-size: 24px; font-weight: 700; text-align: center; text-align-last: center; padding: 10px 8px; border-radius: 12px; border: 1px solid rgba(255,255,255,0.24); background: rgba(17,24,39,0.8); color: #f9fafb; }',
    // Color row
    '.controller-color-row { display: flex; gap: 10px; justify-content: center; }',
    '.controller-color-btn { width: 48px; height: 48px; border-radius: 8px; border: 3px solid transparent; cursor: pointer; touch-action: none; user-select: none; -webkit-user-select: none; transition: border-color 100ms ease, transform 100ms ease; padding: 0; }',
    '.controller-color-btn:active { transform: scale(0.93); }',
    '.controller-color-btn.is-selected { border-color: #ffffff; }',
    // Tool grid
    '.controller-tool-grid { width: 100%; max-width: 300px; display: grid; grid-template-columns: repeat(2, 1fr); gap: 12px; }',
    '.controller-tool-row { width: 100%; max-width: 300px; }',
    // Tool button base
    '.controller-tool-btn { border: 2px solid rgba(255, 255, 255, 0.85); background: rgba(255, 255, 255, 0.10); box-shadow: 0 14px 30px rgba(0, 0, 0, 0.35); touch-action: none; user-select: none; -webkit-user-select: none; cursor: pointer; display: flex; flex-direction: column; align-items: center; justify-content: center; gap: 4px; padding: 8px 0; position: relative; overflow: hidden; color: #f9fafb; transition: transform 120ms ease, box-shadow 120ms ease, background 120ms ease; border-radius: 16px; }',
    '.controller-tool-btn::before { content: ""; position: absolute; inset: 0; border-radius: inherit; pointer-events: none; background: radial-gradient(circle at center, rgba(255, 255, 255, 0.96) 0%, rgba(255, 255, 255, 0.58) 40%, rgba(255, 255, 255, 0.22) 68%, rgba(255, 255, 255, 0.02) 100%); opacity: 0; transition: opacity 80ms linear; }',
    '.controller-tool-btn:active { transform: scale(0.98); }',
    '.controller-tool-btn.is-active { box-shadow: 0 0 0 3px rgba(255, 255, 255, 0.85), 0 14px 30px rgba(0, 0, 0, 0.35); transform: scale(1.05); background: rgba(43, 184, 255, 0.28); }',
    '.controller-tool-btn.is-active::before { opacity: 1; }',
    // Small tools (eraser, select)
    '.controller-tool-btn--small { height: 72px; }',
    '.controller-tool-btn--small .controller-tool-icon { width: 32px; height: 32px; }',
    // Large tools (sticker, draw)
    '.controller-tool-btn--large { height: 110px; }',
    '.controller-tool-btn--large .controller-tool-icon { width: 48px; height: 48px; }',
    // Icon & label
    '.controller-tool-icon { object-fit: contain; pointer-events: none; position: relative; z-index: 1; }',
    '.controller-tool-label { font-size: 13px; font-weight: 600; position: relative; z-index: 1; pointer-events: none; }',
    // Note input
    '.controller-note-wrap { width: 100%; max-width: 300px; }',
    '.controller-note-wrap.hidden { display: none; }',
    '.controller-note-input { width: 100%; min-height: 46px; padding: 10px 12px; border-radius: 12px; border: 1px solid rgba(255,255,255,0.22); background: rgba(17,24,39,0.85); color: #f9fafb; font-size: 16px; box-sizing: border-box; }',
    '.controller-note-input::placeholder { color: rgba(249,250,251,0.65); }',
    // Audio record button
    '.controller-rec-btn { width: 100%; height: 48px; border-radius: 14px; border: 2px solid rgba(255,255,255,0.85); font-size: 16px; font-weight: 700; cursor: pointer; display: flex; align-items: center; justify-content: center; gap: 8px; color: #f9fafb; background: rgba(255,255,255,0.10); transition: transform 120ms ease, background 120ms ease; }',
    '.controller-rec-btn:active { transform: scale(0.97); }',
    '.controller-rec-btn--recording { background: rgba(239,68,68,0.28); border-color: rgba(239,68,68,0.85); }',
    '.controller-rec-dot { width: 10px; height: 10px; border-radius: 50%; background: #ef4444; flex-shrink: 0; }',
    '.controller-rec-btn--recording .controller-rec-dot { animation: controller-rec-pulse 1.2s ease-in-out infinite; }',
    '@keyframes controller-rec-pulse { 0%,100% { opacity: 1; } 50% { opacity: 0.3; } }'
  ].join('');
  document.head.appendChild(style);
}

function getToolIconSrc(tool) {
  if (tool === 'draw') return '/icons/drawing.png';
  if (tool === 'note') return '/icons/sticker.png';
  if (tool === 'eraser') return '/icons/eraser.png';
  if (tool === 'selection') return '/icons/select.png';
  return '';
}

function buildToolButton(toolDef) {
  var btn = document.createElement('button');
  var sizeClass = toolDef.size === 'large' ? 'controller-tool-btn--large' : 'controller-tool-btn--small';
  btn.className = 'controller-tool-btn ' + sizeClass;
  btn.type = 'button';
  btn.dataset.tool = toolDef.tool;
  btn.setAttribute('aria-label', toolDef.ariaLabel);

  var iconEl = document.createElement('img');
  iconEl.className = 'controller-tool-icon';
  iconEl.alt = '';
  iconEl.setAttribute('aria-hidden', 'true');
  iconEl.src = getToolIconSrc(toolDef.tool);
  btn.appendChild(iconEl);

  var labelEl = document.createElement('span');
  labelEl.className = 'controller-tool-label';
  labelEl.textContent = toolDef.label || '';
  btn.appendChild(labelEl);

  btn._labelEl = labelEl;
  return btn;
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

function clampNoteText(raw) {
  var text = String(raw || '');
  if (text.length > CONTROLLER_NOTE_TEXT_MAX_LEN) {
    text = text.slice(0, CONTROLLER_NOTE_TEXT_MAX_LEN);
  }
  return text;
}

// ---- Audio Recording ----

var audioRecorder = null;
var audioChunks = [];
var audioUploadTimerId = 0;
var audioClientId = '';
var audioTriggerTagId = 0;
var audioRecordingActive = false;
var audioRecordingId = '';
var audioRecordingStartedAtMs = 0;
var audioRecordingParticipantTagId = 0;

function createRecordingId(clientId) {
  var safeClient = String(clientId || '').replace(/[^A-Za-z0-9_-]/g, '_').slice(0, 24) || 'client';
  var tsPart = Date.now().toString(36);
  var rndPart = Math.random().toString(36).slice(2, 8);
  return 'rec-' + safeClient + '-' + tsPart + '-' + rndPart;
}

function startAudioRecording(clientId) {
  if (audioRecordingActive) return Promise.resolve(false);
  audioClientId = clientId;
  audioRecordingId = createRecordingId(clientId);
  audioRecordingStartedAtMs = Date.now();
  audioRecordingParticipantTagId = parseInt(audioTriggerTagId, 10) || 0;

  if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) {
    console.warn('Audio recording not supported in this browser');
    return Promise.resolve(false);
  }

  return navigator.mediaDevices.getUserMedia({ audio: true, video: false })
    .then(function(stream) {
      var mimeType = 'audio/webm;codecs=opus';
      if (typeof MediaRecorder.isTypeSupported === 'function' && !MediaRecorder.isTypeSupported(mimeType)) {
        mimeType = 'audio/webm';
        if (!MediaRecorder.isTypeSupported(mimeType)) {
          mimeType = '';
        }
      }
      var options = mimeType ? { mimeType: mimeType } : {};
      audioRecorder = new MediaRecorder(stream, options);
      audioChunks = [];
      audioRecordingActive = true;

      audioRecorder.ondataavailable = function(e) {
        if (e.data && e.data.size > 0) {
          audioChunks.push(e.data);
        }
      };

      audioRecorder.onerror = function() {
        console.warn('Audio recorder error');
      };

      // Request data every 5 seconds so chunks accumulate
      audioRecorder.start(5000);

      // Periodically upload accumulated chunks to backend
      audioUploadTimerId = setInterval(function() {
        uploadAudioChunks(false, { useKeepalive: false });
      }, CONTROLLER_AUDIO_UPLOAD_INTERVAL_MS);

      return true;
    })
    .catch(function(err) {
      console.warn('Microphone access denied:', err);
      return false;
    });
}

function uploadAudioChunks(isFinal, options) {
  var opts = options || {};
  var useKeepalive = !!opts.useKeepalive;
  var finalEndMs = isFinal ? (opts.recordingEndedAtMs || Date.now()) : 0;

  if (audioChunks.length === 0 && !isFinal) return Promise.resolve();

  var chunksToSend = audioChunks.slice();
  audioChunks = [];

  if (chunksToSend.length === 0 && isFinal) {
    // Send empty final marker
    var formData = new FormData();
    formData.append('clientId', audioClientId);
    formData.append('triggerTagId', String(audioRecordingParticipantTagId || audioTriggerTagId || 0));
    formData.append('recordingId', String(audioRecordingId || ''));
    formData.append('recordingStartMs', String(audioRecordingStartedAtMs || 0));
    formData.append('recordingEndMs', String(finalEndMs || 0));
    formData.append('isFinal', '1');
    return fetch(CONTROLLER_AUDIO_UPLOAD_ENDPOINT, {
      method: 'POST',
      body: formData,
      keepalive: useKeepalive,
    }).then(function(resp) {
      return resp.text().then(function(text) {
        var body = null;
        try { body = text ? JSON.parse(text) : null; } catch (e) { body = null; }
        if (!resp.ok || !body || body.ok === false) {
          throw new Error(body && body.error ? String(body.error) : ('HTTP ' + resp.status));
        }
      });
    });
  }

  var blob = new Blob(chunksToSend, { type: chunksToSend[0].type || 'audio/webm' });
  var formData = new FormData();
  formData.append('audio', blob, 'chunk.webm');
  formData.append('clientId', audioClientId);
  formData.append('triggerTagId', String(audioRecordingParticipantTagId || audioTriggerTagId || 0));
  formData.append('recordingId', String(audioRecordingId || ''));
  formData.append('recordingStartMs', String(audioRecordingStartedAtMs || 0));
  if (isFinal) {
    formData.append('recordingEndMs', String(finalEndMs || 0));
    formData.append('isFinal', '1');
  }

  return fetch(CONTROLLER_AUDIO_UPLOAD_ENDPOINT, {
    method: 'POST',
    body: formData,
    keepalive: useKeepalive,
  }).then(function(resp) {
    return resp.text().then(function(text) {
      var body = null;
      try { body = text ? JSON.parse(text) : null; } catch (e) { body = null; }
      if (!resp.ok || !body || body.ok === false) {
        throw new Error(body && body.error ? String(body.error) : ('HTTP ' + resp.status));
      }
      return body;
    });
  }).catch(function(err) {
    // On failure, put chunks back so next upload retries
    if (!isFinal) {
      audioChunks = chunksToSend.concat(audioChunks);
    } else if (chunksToSend.length > 0) {
      // Keep final chunks in memory so caller can retry save.
      audioChunks = chunksToSend.concat(audioChunks);
    }
    throw err;
  });
}

function stopAudioRecording() {
  if (!audioRecordingActive) return Promise.resolve();
  audioRecordingActive = false;

  if (audioUploadTimerId) {
    clearInterval(audioUploadTimerId);
    audioUploadTimerId = 0;
  }

  return new Promise(function(resolve, reject) {
    if (!audioRecorder || audioRecorder.state === 'inactive') {
      uploadAudioChunks(true, { useKeepalive: false, recordingEndedAtMs: Date.now() }).then(resolve).catch(reject);
      return;
    }

    audioRecorder.onstop = function() {
      // Stop all mic tracks
      if (audioRecorder.stream) {
        var tracks = audioRecorder.stream.getTracks();
        for (var i = 0; i < tracks.length; i++) tracks[i].stop();
      }
      uploadAudioChunks(true, { useKeepalive: false, recordingEndedAtMs: Date.now() }).then(resolve).catch(reject);
      audioRecorder = null;
    };
    try { audioRecorder.requestData(); } catch (e) { }
    audioRecorder.stop();
  });
}

// ---- Controller UI ----

export function initControllerMode() {
  var clientId = getOrCreateClientId();
  var activePointerId = null;
  var holding = false;
  var heartbeatTimerId = 0;
  var noteSyncTimerId = 0;
  var activeTool = 'draw';
  var activeButtonEl = null;
  var toolButtons = [];
  var noteSessionActive = false;
  var noteDraftText = '';
  var noteFinalizeTick = 0;
  var selectedColor = CONTROLLER_DEFAULT_COLOR;
  var colorButtons = [];

  document.body.className = '';
  document.body.classList.add('controller-mode');
  document.body.textContent = '';
  createStyles();

  var root = document.createElement('main');
  root.className = 'controller-root';

  // ---- Title ----
  var title = document.createElement('div');
  title.className = 'controller-title';
  title.textContent = 'Phone Controller';
  root.appendChild(title);

  // ---- Top row: participant selector + record ----
  var topRowEl = document.createElement('div');
  topRowEl.className = 'controller-top-row';

  var triggerSelectEl = document.createElement('select');
  triggerSelectEl.className = 'controller-select';
  triggerSelectEl.setAttribute('aria-label', 'Participant ID');
  buildOptionElements(triggerSelectEl);
  topRowEl.appendChild(triggerSelectEl);

  var recBtnEl = document.createElement('button');
  recBtnEl.className = 'controller-rec-btn';
  recBtnEl.type = 'button';
  recBtnEl.style.width = 'auto';
  recBtnEl.style.flex = '1';
  var recDotEl = document.createElement('span');
  recDotEl.className = 'controller-rec-dot';
  var recLabelEl = document.createElement('span');
  recLabelEl.textContent = 'Record';
  recBtnEl.appendChild(recDotEl);
  recBtnEl.appendChild(recLabelEl);
  topRowEl.appendChild(recBtnEl);

  root.appendChild(topRowEl);

  // ---- Color row ----
  var colorRowEl = document.createElement('div');
  colorRowEl.className = 'controller-color-row';

  for (var ci = 0; ci < CONTROLLER_COLORS.length; ci++) {
    var colorDef = CONTROLLER_COLORS[ci];
    var colorBtn = document.createElement('button');
    colorBtn.className = 'controller-color-btn';
    colorBtn.type = 'button';
    colorBtn.style.background = colorDef.color;
    colorBtn.dataset.color = colorDef.color;
    colorBtn.setAttribute('aria-label', colorDef.label);
    if (colorDef.color === selectedColor) {
      colorBtn.classList.add('is-selected');
    }
    colorButtons.push(colorBtn);
    colorRowEl.appendChild(colorBtn);
  }
  root.appendChild(colorRowEl);

  // ---- Tool buttons: top row (small) — eraser, select ----
  var smallGridEl = document.createElement('div');
  smallGridEl.className = 'controller-tool-grid';

  var smallTools = [
    { tool: 'eraser', ariaLabel: 'Hold eraser tool', label: 'Eraser', size: 'small' },
    { tool: 'selection', ariaLabel: 'Hold edit tool', label: 'Select', size: 'small' }
  ];
  for (var si = 0; si < smallTools.length; si++) {
    var smallBtn = buildToolButton(smallTools[si]);
    toolButtons.push(smallBtn);
    smallGridEl.appendChild(smallBtn);
  }
  root.appendChild(smallGridEl);

  // ---- Tool buttons: bottom row (large) — sticker, draw ----
  var largeGridEl = document.createElement('div');
  largeGridEl.className = 'controller-tool-grid';

  var largeTools = [
    { tool: 'note', ariaLabel: 'Annotation tool', label: 'Sticker', size: 'large' },
    { tool: 'draw', ariaLabel: 'Hold drawing tool', label: 'Draw', size: 'large' }
  ];
  for (var li = 0; li < largeTools.length; li++) {
    var largeBtn = buildToolButton(largeTools[li]);
    toolButtons.push(largeBtn);
    largeGridEl.appendChild(largeBtn);
  }
  root.appendChild(largeGridEl);

  // ---- Note text input (hidden by default) ----
  var noteWrapEl = document.createElement('div');
  noteWrapEl.className = 'controller-note-wrap hidden';
  var noteInputEl = document.createElement('input');
  noteInputEl.className = 'controller-note-input';
  noteInputEl.type = 'text';
  noteInputEl.setAttribute('autocomplete', 'off');
  noteInputEl.setAttribute('autocapitalize', 'sentences');
  noteInputEl.setAttribute('spellcheck', 'false');
  noteInputEl.setAttribute('aria-label', 'Annotation text');
  noteInputEl.placeholder = 'Type annotation...';
  noteWrapEl.appendChild(noteInputEl);
  root.appendChild(noteWrapEl);

  document.body.appendChild(root);

  // ---- Color selection handler ----
  function updateColorSelection(newColor) {
    selectedColor = newColor;
    for (var k = 0; k < colorButtons.length; k++) {
      colorButtons[k].classList.toggle('is-selected', colorButtons[k].dataset.color === selectedColor);
    }
  }

  for (var cbi = 0; cbi < colorButtons.length; cbi++) {
    colorButtons[cbi].addEventListener('pointerdown', function(e) {
      e.preventDefault();
      var color = this.dataset.color;
      if (color) updateColorSelection(color);
      // Send a heartbeat with the new color
      pushHeartbeat(holding, false);
    });
  }

  // ---- Heartbeat & tool state ----

  function buildPayload(isActive) {
    return {
      clientId: clientId,
      tool: activeTool,
      triggerTagId: parseInt(triggerSelectEl.value, 10),
      active: !!(holding || noteSessionActive),
      noteText: noteDraftText,
      noteSessionActive: !!noteSessionActive,
      noteFinalizeTick: noteFinalizeTick,
      color: selectedColor
    };
  }

  function setUiActive(isActive) {
    for (var i = 0; i < toolButtons.length; i++) {
      toolButtons[i].classList.remove('is-active');
    }
    if ((holding || noteSessionActive) && activeButtonEl) activeButtonEl.classList.add('is-active');
  }

  function pushHeartbeat(isActive, useBeacon) {
    return sendHeartbeat(buildPayload(isActive), !!useBeacon).catch(function() {});
  }

  function shouldRunHeartbeatLoop() {
    return !!holding || !!noteSessionActive;
  }

  function clearHeartbeatLoop() {
    if (!heartbeatTimerId) return;
    clearInterval(heartbeatTimerId);
    heartbeatTimerId = 0;
  }

  function syncHeartbeatLoop() {
    if (!shouldRunHeartbeatLoop()) {
      clearHeartbeatLoop();
      return;
    }
    if (heartbeatTimerId) return;
    heartbeatTimerId = setInterval(function() {
      pushHeartbeat(holding, false);
    }, CONTROLLER_HEARTBEAT_INTERVAL_MS);
  }

  function setNoteInputVisible(visible, focusInput) {
    noteWrapEl.classList.toggle('hidden', !visible);
    if (!visible) {
      noteInputEl.blur();
      return;
    }
    if (!focusInput) return;
    setTimeout(function() {
      try {
        noteInputEl.focus();
        var end = noteInputEl.value.length;
        noteInputEl.setSelectionRange(end, end);
      } catch (e) { }
    }, 0);
  }

  function clearPendingNoteSync() {
    if (!noteSyncTimerId) return;
    clearTimeout(noteSyncTimerId);
    noteSyncTimerId = 0;
  }

  function scheduleNoteSync() {
    clearPendingNoteSync();
    noteSyncTimerId = setTimeout(function() {
      noteSyncTimerId = 0;
      pushHeartbeat(holding, false);
    }, 70);
  }

  function resetNoteSession() {
    noteSessionActive = false;
    noteDraftText = '';
    noteInputEl.value = '';
    setNoteInputVisible(false, false);
    clearPendingNoteSync();
    // Restore sticker label
    if (noteBtnEl && noteBtnEl._labelEl) noteBtnEl._labelEl.textContent = 'Sticker';
  }

  function startHolding(pointerId, toolId, buttonEl) {
    if (holding) return;
    var nextTool = String(toolId || 'draw');

    if (noteSessionActive) {
      resetNoteSession();
    }

    holding = true;
    activePointerId = pointerId;
    activeTool = nextTool;
    activeButtonEl = buttonEl || null;
    setUiActive(true);
    pushHeartbeat(true, false);
    syncHeartbeatLoop();
  }

  function stopHolding(useBeacon) {
    if (!holding) return;
    holding = false;
    activePointerId = null;
    setUiActive(false);
    activeButtonEl = null;

    pushHeartbeat(false, !!useBeacon);
    syncHeartbeatLoop();
  }

  function getActivePointerId() {
    return activePointerId;
  }

  // ---- Bind tool button events ----
  var noteBtnEl = null;
  for (var bi = 0; bi < toolButtons.length; bi++) {
    if (String(toolButtons[bi].dataset.tool || '') === 'note') {
      noteBtnEl = toolButtons[bi];
      continue;
    }
    bindHoldEvents(toolButtons[bi], startHolding, stopHolding, getActivePointerId);
  }

  if (noteBtnEl) {
    noteBtnEl.addEventListener('pointerdown', function(e) {
      if (e.button !== undefined && e.button !== 0) return;
      e.preventDefault();

      if (!noteSessionActive) {
        if (holding) stopHolding(false);
        noteSessionActive = true;
        activeTool = 'note';
        activeButtonEl = noteBtnEl;
        setNoteInputVisible(true, true);
        setUiActive(true);
        // Change label to "Apply"
        if (noteBtnEl._labelEl) noteBtnEl._labelEl.textContent = 'Apply';
        pushHeartbeat(true, false);
        syncHeartbeatLoop();
        return;
      }

      // Second press: finalize placement
      noteFinalizeTick += 1;
      noteSessionActive = false;
      setNoteInputVisible(false, false);
      setUiActive(false);
      activeButtonEl = null;
      // Restore label to "Sticker"
      if (noteBtnEl._labelEl) noteBtnEl._labelEl.textContent = 'Sticker';
      pushHeartbeat(false, false);
      noteDraftText = '';
      noteInputEl.value = '';
      clearPendingNoteSync();
      syncHeartbeatLoop();
    });
  }

  noteInputEl.addEventListener('input', function() {
    var nextText = clampNoteText(noteInputEl.value);
    if (noteInputEl.value !== nextText) noteInputEl.value = nextText;
    noteDraftText = nextText;
    if (!noteSessionActive) return;
    syncHeartbeatLoop();
    scheduleNoteSync();
  });

  triggerSelectEl.addEventListener('change', function() {
    audioTriggerTagId = parseInt(triggerSelectEl.value, 10) || 0;
    if (!holding && !noteSessionActive) return;
    pushHeartbeat(holding, false);
  });

  // Initialize audio trigger tag ID
  audioTriggerTagId = parseInt(triggerSelectEl.value, 10) || 0;

  // Record audio toggle button
  recBtnEl.addEventListener('click', function() {
    if (!audioRecordingActive) {
      // Start recording
      recBtnEl.disabled = true;
      recLabelEl.textContent = 'Starting...';
      startAudioRecording(clientId).then(function(started) {
        recBtnEl.disabled = false;
        if (started) {
          recBtnEl.classList.add('controller-rec-btn--recording');
          recLabelEl.textContent = 'Stop';
        } else {
          recLabelEl.textContent = 'Record';
        }
      });
    } else {
      // Stop recording and save
      recBtnEl.disabled = true;
      recLabelEl.textContent = 'Saving...';
      recBtnEl.classList.remove('controller-rec-btn--recording');
      stopAudioRecording().then(function() {
        recBtnEl.disabled = false;
        recLabelEl.textContent = 'Record';
      }).catch(function(err) {
        recBtnEl.disabled = false;
        recLabelEl.textContent = 'Save Failed';
        console.warn('Failed to save audio recording:', err);
      });
    }
  });

  window.addEventListener('blur', function() { stopHolding(false); });
  document.addEventListener('visibilitychange', function() {
    if (document.hidden) stopHolding(true);
  });
  window.addEventListener('beforeunload', function() {
    stopHolding(true);
    clearPendingNoteSync();
    if (audioRecordingActive) {
      stopAudioRecording();
    }
  });
}
