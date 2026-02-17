import { state } from './state.js';

export function initUiSetup(options) {
  options = options || {};
  var panelEl = options.panelEl;
  var overlayEl = options.overlayEl;
  var actionsHostEl = options.actionsHostEl || null;
  var onNextStage = options.onNextStage || null;
  var getSetupExportData = typeof options.getSetupExportData === 'function' ? options.getSetupExportData : null;
  var applySetupImportData = typeof options.applySetupImportData === 'function' ? options.applySetupImportData : null;

  if (!panelEl) throw new Error('initUiSetup: missing panelEl');
  if (!overlayEl) throw new Error('initUiSetup: missing overlayEl');

  panelEl.textContent = '';
  if (actionsHostEl) actionsHostEl.textContent = '';

  var defaultItemColor = '#2bb8ff';
  var currentDrawColor = defaultItemColor;
  var currentNoteColor = defaultItemColor;

  var participantsRowEl = document.createElement('div');
  participantsRowEl.className = 'ui-setup-row';

  var participantsLabelEl = document.createElement('label');
  participantsLabelEl.className = 'ui-setup-row-label';
  participantsLabelEl.textContent = 'Number of participants';

  var participantsInputEl = document.createElement('input');
  participantsInputEl.className = 'ui-setup-input ui-setup-input--narrow';
  participantsInputEl.id = 'uiSetupParticipantsCountInput';
  participantsInputEl.type = 'number';
  participantsInputEl.min = '1';
  participantsInputEl.max = '10';
  participantsInputEl.inputMode = 'numeric';
  participantsInputEl.placeholder = 'Participants (1-10)';
  participantsInputEl.value = state.stage3ParticipantCount ? String(state.stage3ParticipantCount) : '';
  participantsLabelEl.setAttribute('for', participantsInputEl.id);

  participantsRowEl.appendChild(participantsLabelEl);
  participantsRowEl.appendChild(participantsInputEl);
  panelEl.appendChild(participantsRowEl);

  var participantSelectsRowEl = document.createElement('div');
  participantSelectsRowEl.className = 'ui-setup-row ui-setup-row--wrap';
  panelEl.appendChild(participantSelectsRowEl);

  var row = document.createElement('div');
  row.className = 'ui-setup-row';

  var inputEl = document.createElement('input');
  inputEl.className = 'ui-setup-input';
  inputEl.type = 'text';
  inputEl.placeholder = 'Enter your question';
  inputEl.autocomplete = 'off';
  inputEl.spellcheck = false;

  var addBtn = document.createElement('button');
  addBtn.className = 'ui-setup-add-btn';
  addBtn.type = 'button';
  addBtn.textContent = '+';
  addBtn.setAttribute('aria-label', 'Add label');

  row.appendChild(inputEl);
  row.appendChild(addBtn);
  panelEl.appendChild(row);

  function sanitizeParticipantCount(v) {
    var n = parseInt(v, 10);
    if (!isFinite(n) || n < 1) return 0;
    if (n > 10) n = 10;
    return n;
  }

  function renderParticipantSelects(count) {
    participantSelectsRowEl.textContent = '';

    if (!count) {
      state.stage3ParticipantTagIds = [];
      state.stage3ParticipantTriggerTagIds = [];
      return;
    }

    // Ensure array has correct length
    if (!Array.isArray(state.stage3ParticipantTagIds)) state.stage3ParticipantTagIds = [];
    if (!Array.isArray(state.stage3ParticipantTriggerTagIds)) state.stage3ParticipantTriggerTagIds = [];
    state.stage3ParticipantTagIds.length = count;
    state.stage3ParticipantTriggerTagIds.length = count;

    for (var i = 0; i < count; i++) {
      var wrap = document.createElement('div');
      wrap.className = 'ui-setup-participant';

      var label = document.createElement('div');
      label.className = 'ui-setup-participant__label';
      label.textContent = 'P' + (i + 1);

      var primaryGroupEl = document.createElement('div');
      primaryGroupEl.className = 'ui-setup-participant__tag-group';

      var primaryLabelEl = document.createElement('span');
      primaryLabelEl.className = 'ui-setup-participant__tag-label';
      primaryLabelEl.textContent = 'Primary';

      var primarySelectEl = document.createElement('select');
      primarySelectEl.className = 'ui-setup-select';
      primarySelectEl.setAttribute('aria-label', 'Participant ' + (i + 1) + ' primary AprilTag ID');

      var triggerGroupEl = document.createElement('div');
      triggerGroupEl.className = 'ui-setup-participant__tag-group';

      var triggerLabelEl = document.createElement('span');
      triggerLabelEl.className = 'ui-setup-participant__tag-label';
      triggerLabelEl.textContent = 'Trigger';

      var triggerSelectEl = document.createElement('select');
      triggerSelectEl.className = 'ui-setup-select';
      triggerSelectEl.setAttribute('aria-label', 'Participant ' + (i + 1) + ' trigger AprilTag ID');

      for (var tagId = 10; tagId <= 30; tagId++) {
        var optPrimary = document.createElement('option');
        optPrimary.value = String(tagId);
        optPrimary.textContent = String(tagId);
        primarySelectEl.appendChild(optPrimary);

        var optTrigger = document.createElement('option');
        optTrigger.value = String(tagId);
        optTrigger.textContent = String(tagId);
        triggerSelectEl.appendChild(optTrigger);
      }

      var currentPrimary = parseInt(state.stage3ParticipantTagIds[i], 10);
      if (!isFinite(currentPrimary) || currentPrimary < 10 || currentPrimary > 30) {
        currentPrimary = 10 + i;
        if (currentPrimary > 30) currentPrimary = 10;
      }
      state.stage3ParticipantTagIds[i] = currentPrimary;
      primarySelectEl.value = String(currentPrimary);

      var currentTrigger = parseInt(state.stage3ParticipantTriggerTagIds[i], 10);
      if (!isFinite(currentTrigger) || currentTrigger < 10 || currentTrigger > 30) {
        currentTrigger = 10 + i + 1;
        if (currentTrigger > 30) currentTrigger = 10;
      }
      state.stage3ParticipantTriggerTagIds[i] = currentTrigger;
      triggerSelectEl.value = String(currentTrigger);

      (function (index, primarySel, triggerSel) {
        primarySel.addEventListener('change', function () {
          var v = parseInt(primarySel.value, 10);
          if (!isFinite(v)) return;
          state.stage3ParticipantTagIds[index] = v;
        });
        triggerSel.addEventListener('change', function () {
          var v = parseInt(triggerSel.value, 10);
          if (!isFinite(v)) return;
          state.stage3ParticipantTriggerTagIds[index] = v;
        });
      })(i, primarySelectEl, triggerSelectEl);

      wrap.appendChild(label);
      primaryGroupEl.appendChild(primaryLabelEl);
      primaryGroupEl.appendChild(primarySelectEl);
      triggerGroupEl.appendChild(triggerLabelEl);
      triggerGroupEl.appendChild(triggerSelectEl);
      wrap.appendChild(primaryGroupEl);
      wrap.appendChild(triggerGroupEl);
      participantSelectsRowEl.appendChild(wrap);
    }
  }

  function updateParticipantsUi() {
    var count = sanitizeParticipantCount(participantsInputEl.value);
    state.stage3ParticipantCount = count;
    renderParticipantSelects(count);

    var showSelects = count > 0;
    participantSelectsRowEl.classList.toggle('hidden', !showSelects);
    participantSelectsRowEl.setAttribute('aria-hidden', showSelects ? 'false' : 'true');
  }

  participantsInputEl.addEventListener('input', function () {
    updateParticipantsUi();
  });

  // Initialize on first render
  if (!sanitizeParticipantCount(participantsInputEl.value)) {
    participantsInputEl.value = String(state.stage3ParticipantCount || 1);
  }
  updateParticipantsUi();

  addBtn.addEventListener('click', function () {
    createLabelFromInput();
  });

  inputEl.addEventListener('keydown', function (e) {
    if (e.key !== 'Enter') return;
    e.preventDefault();
    createLabelFromInput();
  });

  var drawColorInputEl = document.createElement('input');
  drawColorInputEl.type = 'color';
  drawColorInputEl.className = 'ui-color-input';
  drawColorInputEl.value = currentDrawColor;
  drawColorInputEl.setAttribute('aria-label', 'Pick drawing color');

  var drawSwatchEl = document.createElement('div');
  drawSwatchEl.className = 'ui-draw-swatch';

  var drawPreviewCanvas = document.createElement('canvas');
  drawPreviewCanvas.className = 'ui-draw-preview';
  drawPreviewCanvas.width = 44;
  drawPreviewCanvas.height = 44;

  drawSwatchEl.appendChild(drawPreviewCanvas);
  drawSwatchEl.appendChild(drawColorInputEl);

  var addDrawBtn = document.createElement('button');
  addDrawBtn.className = 'ui-setup-add-btn';
  addDrawBtn.type = 'button';
  addDrawBtn.textContent = '+';
  addDrawBtn.setAttribute('aria-label', 'Add drawing');

  var noteColorInputEl = document.createElement('input');
  noteColorInputEl.type = 'color';
  noteColorInputEl.className = 'ui-color-input';
  noteColorInputEl.value = currentNoteColor;
  noteColorInputEl.setAttribute('aria-label', 'Pick annotation color');

  var noteSwatchEl = document.createElement('div');
  noteSwatchEl.className = 'ui-note-swatch';
  noteSwatchEl.style.background = currentNoteColor;
  var noteSwatchIconEl = document.createElement('div');
  noteSwatchIconEl.className = 'ui-note-swatch__icon';
  noteSwatchIconEl.textContent = '\ud83d\udcdd';
  noteSwatchEl.appendChild(noteSwatchIconEl);
  noteSwatchEl.appendChild(noteColorInputEl);

  var addNoteBtn = document.createElement('button');
  addNoteBtn.className = 'ui-setup-add-btn';
  addNoteBtn.type = 'button';
  addNoteBtn.textContent = '+';
  addNoteBtn.setAttribute('aria-label', 'Add note annotation');

  var addEraserBtn = document.createElement('button');
  addEraserBtn.className = 'ui-setup-add-btn ui-setup-add-btn--eraser';
  addEraserBtn.type = 'button';
  addEraserBtn.textContent = 'Eraser';
  addEraserBtn.setAttribute('aria-label', 'Add eraser');

  var addSelectionBtn = document.createElement('button');
  addSelectionBtn.className = 'ui-setup-add-btn ui-setup-add-btn--selection';
  addSelectionBtn.type = 'button';
  addSelectionBtn.textContent = 'Selection';
  addSelectionBtn.setAttribute('aria-label', 'Add selection cursor');

  var controlsRow = document.createElement('div');
  controlsRow.className = 'ui-setup-row';
  controlsRow.appendChild(drawSwatchEl);
  controlsRow.appendChild(addDrawBtn);
  controlsRow.appendChild(noteSwatchEl);
  controlsRow.appendChild(addNoteBtn);
  controlsRow.appendChild(addEraserBtn);
  controlsRow.appendChild(addSelectionBtn);
  panelEl.appendChild(controlsRow);

  var footer = document.createElement('div');
  footer.className = 'ui-setup-footer';

  var exportBtn = document.createElement('button');
  exportBtn.className = 'ui-setup-action-btn';
  exportBtn.type = 'button';
  exportBtn.textContent = 'Export';

  var importBtn = document.createElement('button');
  importBtn.className = 'ui-setup-action-btn';
  importBtn.type = 'button';
  importBtn.textContent = 'Import';

  var blackoutToggleLabel = document.createElement('label');
  blackoutToggleLabel.className = 'ui-setup-blackout-toggle';
  blackoutToggleLabel.setAttribute('for', 'blackoutPulseToggle');

  var blackoutToggleText = document.createElement('span');
  blackoutToggleText.className = 'ui-setup-blackout-toggle__text';
  blackoutToggleText.textContent = 'Blackout';

  var blackoutSwitch = document.createElement('span');
  blackoutSwitch.className = 'switch';

  var blackoutToggleInput = document.createElement('input');
  blackoutToggleInput.id = 'blackoutPulseToggle';
  blackoutToggleInput.type = 'checkbox';
  blackoutToggleInput.setAttribute('aria-label', 'Enable periodic blackout when trigger tag is active without primary tag');

  var blackoutToggleSlider = document.createElement('span');
  blackoutToggleSlider.className = 'slider';
  blackoutToggleSlider.setAttribute('aria-hidden', 'true');

  blackoutSwitch.appendChild(blackoutToggleInput);
  blackoutSwitch.appendChild(blackoutToggleSlider);
  blackoutToggleLabel.appendChild(blackoutToggleText);
  blackoutToggleLabel.appendChild(blackoutSwitch);

  var mapStyleToggleLabel = document.createElement('label');
  mapStyleToggleLabel.className = 'ui-setup-mapstyle-toggle';
  mapStyleToggleLabel.setAttribute('for', 'mapMonochromeToggle');

  var mapStyleToggleText = document.createElement('span');
  mapStyleToggleText.className = 'ui-setup-blackout-toggle__text';
  mapStyleToggleText.textContent = 'B/W Map';

  var mapStyleSwitch = document.createElement('span');
  mapStyleSwitch.className = 'switch';

  var mapStyleToggleInput = document.createElement('input');
  mapStyleToggleInput.id = 'mapMonochromeToggle';
  mapStyleToggleInput.type = 'checkbox';
  mapStyleToggleInput.setAttribute('aria-label', 'Use monochrome map style');

  var mapStyleToggleSlider = document.createElement('span');
  mapStyleToggleSlider.className = 'slider';
  mapStyleToggleSlider.setAttribute('aria-hidden', 'true');

  mapStyleSwitch.appendChild(mapStyleToggleInput);
  mapStyleSwitch.appendChild(mapStyleToggleSlider);
  mapStyleToggleLabel.appendChild(mapStyleToggleText);
  mapStyleToggleLabel.appendChild(mapStyleSwitch);

  var nextBtn = document.createElement('button');
  nextBtn.className = 'ui-setup-action-btn ui-setup-action-btn--primary';
  nextBtn.type = 'button';
  nextBtn.textContent = 'Next →';

  var importFileEl = document.createElement('input');
  importFileEl.type = 'file';
  importFileEl.accept = 'application/json,.json';
  importFileEl.style.position = 'absolute';
  importFileEl.style.left = '-9999px';
  importFileEl.style.width = '1px';
  importFileEl.style.height = '1px';
  importFileEl.setAttribute('aria-hidden', 'true');

  footer.appendChild(mapStyleToggleLabel);
  footer.appendChild(blackoutToggleLabel);
  footer.appendChild(exportBtn);
  footer.appendChild(importBtn);
  footer.appendChild(nextBtn);
  if (actionsHostEl) {
    actionsHostEl.appendChild(footer);
    actionsHostEl.appendChild(importFileEl);
  } else {
    panelEl.appendChild(footer);
    panelEl.appendChild(importFileEl);
  }

  nextBtn.addEventListener('click', function () {
    if (onNextStage) onNextStage();
  });

  redrawDrawPreview();

  drawColorInputEl.addEventListener('input', function () {
    currentDrawColor = drawColorInputEl.value;
    redrawDrawPreview();
  });

  noteColorInputEl.addEventListener('input', function () {
    currentNoteColor = noteColorInputEl.value;
    noteSwatchEl.style.background = currentNoteColor;
  });

  addDrawBtn.addEventListener('click', function () {
    createDraw();
  });

  addNoteBtn.addEventListener('click', function () {
    createNote();
  });

  addEraserBtn.addEventListener('click', function () {
    createEraser();
  });

  var selectionCreatedFromPointerDown = false;
  addSelectionBtn.addEventListener('pointerdown', function (e) {
    if (e.button !== 0) return;
    e.preventDefault();
    selectionCreatedFromPointerDown = true;
    createSelection({ startDragEvent: e });
  });

  addSelectionBtn.addEventListener('click', function () {
    if (selectionCreatedFromPointerDown) {
      selectionCreatedFromPointerDown = false;
      return;
    }
    createSelection();
  });

  exportBtn.addEventListener('click', function () {
    exportToJson();
  });

  importBtn.addEventListener('click', function () {
    importFileEl.value = '';
    importFileEl.click();
  });

  importFileEl.addEventListener('change', function () {
    var file = importFileEl.files && importFileEl.files[0];
    if (!file) return;
    importFromFile(file);
  });

  function normalizeSessionId(value) {
    if (value === null || value === undefined) return '';
    var text = String(value).trim();
    return text;
  }

  function assignCurrentSessionId(el) {
    if (!el || !el.dataset) return;
    var sessionId = normalizeSessionId(state.currentMapSessionId);
    if (sessionId) el.dataset.sessionId = sessionId;
    else delete el.dataset.sessionId;
  }

  function assignImportedSessionId(el, rawSessionId) {
    if (!el || !el.dataset) return;
    var sessionId = normalizeSessionId(rawSessionId);
    if (sessionId) el.dataset.sessionId = sessionId;
    else delete el.dataset.sessionId;
  }

  function createLabelFromInput() {
    var text = String(inputEl.value || '').trim();
    if (!text) return;

    var labelEl = document.createElement('div');
    labelEl.className = 'ui-label';
    labelEl.textContent = text;
    labelEl.dataset.uiType = 'label';
    assignCurrentSessionId(labelEl);
    overlayEl.appendChild(labelEl);

    positionLabelAboveInput(labelEl);
    makeDraggable(labelEl);

    inputEl.focus();
  }

  function positionLabelAboveInput(labelEl) {
    var inputRect = inputEl.getBoundingClientRect();
    var x = inputRect.left + inputRect.width / 2;
    var y = inputRect.top;

    // First paint so we can measure.
    labelEl.style.left = '0px';
    labelEl.style.top = '0px';
    labelEl.style.visibility = 'hidden';

    requestAnimationFrame(function () {
      var labelRect = labelEl.getBoundingClientRect();
      var left = Math.max(8, Math.min(window.innerWidth - labelRect.width - 8, x - labelRect.width / 2));
      var top = Math.max(8, y - 10 - labelRect.height);

      labelEl.style.left = left + 'px';
      labelEl.style.top = top + 'px';
      labelEl.style.visibility = 'visible';
    });
  }

  function redrawDrawPreview() {
    var ctx = drawPreviewCanvas.getContext('2d');
    if (!ctx) return;
    ctx.clearRect(0, 0, drawPreviewCanvas.width, drawPreviewCanvas.height);
    drawScribble(ctx, currentDrawColor, drawPreviewCanvas.width, drawPreviewCanvas.height);
  }

  function createDraw() {
    var drawEl = document.createElement('div');
    drawEl.className = 'ui-draw';
    drawEl.dataset.uiType = 'draw';
    drawEl.dataset.color = currentDrawColor;
    assignCurrentSessionId(drawEl);

    var drawCanvasEl = document.createElement('canvas');
    drawCanvasEl.className = 'ui-draw__canvas';
    drawCanvasEl.width = 90;
    drawCanvasEl.height = 90;
    drawEl.appendChild(drawCanvasEl);

    overlayEl.appendChild(drawEl);


    positionDrawAboveSwatch(drawEl);
    renderDrawIcon(drawCanvasEl, currentDrawColor);
    makeDraggable(drawEl, { draggingClass: 'ui-draw--dragging' });
  }

  function positionDrawAboveSwatch(drawEl) {
    var swatchRect = drawSwatchEl.getBoundingClientRect();
    var x = swatchRect.left + swatchRect.width / 2;
    var y = swatchRect.top;

    drawEl.style.left = '0px';
    drawEl.style.top = '0px';
    drawEl.style.visibility = 'hidden';

    requestAnimationFrame(function () {
      var rect = drawEl.getBoundingClientRect();
      var left = Math.max(8, Math.min(window.innerWidth - rect.width - 8, x - rect.width / 2));
      var top = Math.max(8, y - 10 - rect.height);
      drawEl.style.left = left + 'px';
      drawEl.style.top = top + 'px';
      drawEl.style.visibility = 'visible';
    });
  }

  function createNote() {
    var noteEl = document.createElement('div');
    noteEl.className = 'ui-note';
    noteEl.dataset.uiType = 'note';
    noteEl.dataset.expanded = 'false';
    noteEl.dataset.color = currentNoteColor;
    noteEl.style.background = currentNoteColor;
    assignCurrentSessionId(noteEl);

    var iconEl = document.createElement('div');
    iconEl.className = 'ui-note__icon';
    iconEl.textContent = '📝';
    noteEl.appendChild(iconEl);

    overlayEl.appendChild(noteEl);


    positionNoteAboveButton(noteEl);
    makeDraggable(noteEl, { draggingClass: 'ui-note--dragging' });
    setupNoteInteraction(noteEl);
  }

  function createEraser() {
    var eraserEl = document.createElement('div');
    eraserEl.className = 'ui-eraser';
    eraserEl.dataset.uiType = 'eraser';
    assignCurrentSessionId(eraserEl);

    var iconEl = document.createElement('div');
    iconEl.className = 'ui-eraser__icon';
    iconEl.textContent = '\u232B';
    eraserEl.appendChild(iconEl);

    overlayEl.appendChild(eraserEl);

    positionEraserAboveButton(eraserEl);
    makeDraggable(eraserEl, { draggingClass: 'ui-eraser--dragging' });
  }

  function createSelection(options) {
    options = options || {};
    var selectionEl = document.createElement('div');
    selectionEl.className = 'ui-selection';
    selectionEl.dataset.uiType = 'selection';
    assignCurrentSessionId(selectionEl);

    var iconEl = document.createElement('div');
    iconEl.className = 'ui-selection__icon';
    iconEl.textContent = '↖';
    selectionEl.appendChild(iconEl);

    overlayEl.appendChild(selectionEl);

    var startSelectionDrag = makeDraggable(selectionEl, { draggingClass: 'ui-selection--dragging' });

    var dragEvent = options.startDragEvent || null;
    if (dragEvent && typeof dragEvent.clientX === 'number' && typeof dragEvent.clientY === 'number') {
      selectionEl.style.left = String(dragEvent.clientX - 45) + 'px';
      selectionEl.style.top = String(dragEvent.clientY - 45) + 'px';
      selectionEl.style.visibility = 'visible';
      startSelectionDrag(dragEvent);
    } else {
      positionSelectionAboveButton(selectionEl);
    }
  }

  function positionEraserAboveButton(eraserEl) {
    var btnRect = addEraserBtn.getBoundingClientRect();
    var x = btnRect.left + btnRect.width / 2;
    var y = btnRect.top;

    eraserEl.style.left = '0px';
    eraserEl.style.top = '0px';
    eraserEl.style.visibility = 'hidden';

    requestAnimationFrame(function () {
      var rect = eraserEl.getBoundingClientRect();
      var left = Math.max(8, Math.min(window.innerWidth - rect.width - 8, x - rect.width / 2));
      var top = Math.max(8, y - 10 - rect.height);
      eraserEl.style.left = left + 'px';
      eraserEl.style.top = top + 'px';
      eraserEl.style.visibility = 'visible';
    });
  }

  function positionSelectionAboveButton(selectionEl) {
    var btnRect = addSelectionBtn.getBoundingClientRect();
    var x = btnRect.left + btnRect.width / 2;
    var y = btnRect.top;

    selectionEl.style.left = '0px';
    selectionEl.style.top = '0px';
    selectionEl.style.visibility = 'hidden';

    requestAnimationFrame(function () {
      var rect = selectionEl.getBoundingClientRect();
      var left = Math.max(8, Math.min(window.innerWidth - rect.width - 8, x - rect.width / 2));
      var top = Math.max(8, y - 10 - rect.height);
      selectionEl.style.left = left + 'px';
      selectionEl.style.top = top + 'px';
      selectionEl.style.visibility = 'visible';
    });
  }

  function positionNoteAboveButton(noteEl) {
    var btnRect = addNoteBtn.getBoundingClientRect();
    var x = btnRect.left + btnRect.width / 2;
    var y = btnRect.top;

    noteEl.style.left = '0px';
    noteEl.style.top = '0px';
    noteEl.style.visibility = 'hidden';

    requestAnimationFrame(function () {
      var rect = noteEl.getBoundingClientRect();
      var left = Math.max(8, Math.min(window.innerWidth - rect.width - 8, x - rect.width / 2));
      var top = Math.max(8, y - 10 - rect.height);
      noteEl.style.left = left + 'px';
      noteEl.style.top = top + 'px';
      noteEl.style.visibility = 'visible';
    });
  }

  function setupNoteInteraction(noteEl) {
    // Click to expand/collapse in Stage 4
    // Only sticker instances (cloned notes) should expand - not the template
    noteEl.addEventListener('click', function (e) {
      if (state.stage !== 4) return;
      if (!noteEl.classList.contains('ui-sticker-instance')) return; // Only expand cloned instances
      if (e.target.closest('.ui-note__form')) return; // Don't toggle when clicking form elements

      var isExpanded = noteEl.dataset.expanded === 'true';
      if (!isExpanded) {
        expandNote(noteEl);
      }
    });
  }

  function colorToRgbaWithAlpha(colorText, alpha) {
    var a = isFinite(alpha) ? Math.max(0, Math.min(1, alpha)) : 1;
    var text = String(colorText || '').trim();
    var m = null;

    if (/^#([0-9a-f]{3})$/i.test(text)) {
      m = /^#([0-9a-f]{3})$/i.exec(text);
      var h3 = m[1];
      var r3 = parseInt(h3.charAt(0) + h3.charAt(0), 16);
      var g3 = parseInt(h3.charAt(1) + h3.charAt(1), 16);
      var b3 = parseInt(h3.charAt(2) + h3.charAt(2), 16);
      return 'rgba(' + r3 + ', ' + g3 + ', ' + b3 + ', ' + a + ')';
    }

    if (/^#([0-9a-f]{6})$/i.test(text)) {
      m = /^#([0-9a-f]{6})$/i.exec(text);
      var h6 = m[1];
      var r6 = parseInt(h6.slice(0, 2), 16);
      var g6 = parseInt(h6.slice(2, 4), 16);
      var b6 = parseInt(h6.slice(4, 6), 16);
      return 'rgba(' + r6 + ', ' + g6 + ', ' + b6 + ', ' + a + ')';
    }

    m = /^rgba?\(([^)]+)\)$/i.exec(text);
    if (m) {
      var parts = m[1].split(',');
      if (parts.length >= 3) {
        var r = parseFloat(parts[0]);
        var g = parseFloat(parts[1]);
        var b = parseFloat(parts[2]);
        if (isFinite(r) && isFinite(g) && isFinite(b)) {
          return 'rgba(' + Math.round(r) + ', ' + Math.round(g) + ', ' + Math.round(b) + ', ' + a + ')';
        }
      }
    }

    return 'rgba(255, 200, 87, ' + a + ')';
  }

  function applyNoteTextareaStyle(noteEl, textareaEl) {
    if (!noteEl || !textareaEl) return;
    var noteColor = noteEl.dataset && noteEl.dataset.color ? String(noteEl.dataset.color) : '#ffc857';
    textareaEl.style.background = colorToRgbaWithAlpha(noteColor, 0.7);
  }

  function setExpandedNoteContainerVisual(noteEl, expanded) {
    if (!noteEl || !noteEl.style) return;
    if (expanded) {
      noteEl.style.background = 'transparent';
      noteEl.style.borderColor = 'transparent';
      noteEl.style.boxShadow = 'none';
      return;
    }
    var color = noteEl.dataset && noteEl.dataset.color ? String(noteEl.dataset.color) : '';
    if (color) noteEl.style.background = color;
    else noteEl.style.removeProperty('background');
    noteEl.style.removeProperty('border-color');
    noteEl.style.removeProperty('box-shadow');
  }

  function expandNote(noteEl) {
    if (noteEl.dataset.expanded === 'true') return;
    noteEl.classList.remove('ui-note--sticker');
    noteEl.dataset.expanded = 'true';
    noteEl.classList.add('ui-note--expanded');
    setExpandedNoteContainerVisual(noteEl, true);

    // Create form if not exists
    var formEl = noteEl.querySelector('.ui-note__form');
    if (!formEl) {
      formEl = document.createElement('div');
      formEl.className = 'ui-note__form';

      var textareaEl = document.createElement('textarea');
      textareaEl.className = 'ui-note__textarea';
      textareaEl.placeholder = 'Enter your note...';
      textareaEl.rows = 3;
      applyNoteTextareaStyle(noteEl, textareaEl);

      textareaEl.addEventListener('click', function (e) {
        e.stopPropagation();
      });

      textareaEl.addEventListener('keydown', function (e) {
        e.stopPropagation();
        if (e.key === 'Enter' && !e.shiftKey) {
          e.preventDefault();
          var text = textareaEl.value.trim();
          if (text) {
            noteEl.dataset.noteText = text;
            collapseNote(noteEl, text);
          }
        }
        if (e.key === 'Escape') {
          collapseNote(noteEl);
        }
      });

      formEl.appendChild(textareaEl);
      noteEl.appendChild(formEl);

      // Focus textarea
      setTimeout(function () {
        textareaEl.focus();
      }, 50);
    } else {
      var textarea = formEl.querySelector('.ui-note__textarea');
      if (textarea) {
        applyNoteTextareaStyle(noteEl, textarea);
        textarea.value = noteEl.dataset.noteText || '';
        setTimeout(function () {
          textarea.focus();
        }, 50);
      }
    }
  }

  function collapseNote(noteEl, savedText) {
    noteEl.dataset.expanded = 'false';
    noteEl.classList.remove('ui-note--expanded');
    setExpandedNoteContainerVisual(noteEl, false);

    // Update icon to show it has content
    var iconEl = noteEl.querySelector('.ui-note__icon');
    if (iconEl && savedText) {
      iconEl.textContent = '📝✓';
    }

    var hasText = !!String(noteEl.dataset.noteText || '').trim();
    noteEl.classList.toggle('ui-note--sticker', hasText);
  }

  function exportToJson() {
    var items = [];
    var children = overlayEl.children;

    for (var i = 0; i < children.length; i++) {
      var el = children[i];
      var type = el.dataset && el.dataset.uiType;
      if (!type) continue;

      var left = parseFloat(el.style.left || '0');
      var top = parseFloat(el.style.top || '0');

      if (type === 'label') {
        var rotationDeg = parseFloat(el.dataset.rotationDeg || '0');
        if (!isFinite(rotationDeg)) rotationDeg = 0;
        items.push({
          type: 'label',
          text: el.textContent || '',
          x: left,
          y: top,
          rotationDeg: rotationDeg,
          sessionId: normalizeSessionId(el.dataset.sessionId)
        });
      } else if (type === 'draw') {
        items.push({
          type: 'draw',
          color: el.dataset.color || defaultItemColor,
          triggerTagId: el.dataset.triggerTagId || '',
          x: left,
          y: top,
          sessionId: normalizeSessionId(el.dataset.sessionId)
        });
      } else if (type === 'note') {
        items.push({
          type: 'note',
          text: el.dataset.noteText || '',
          color: el.dataset.color || defaultItemColor,
          triggerTagId: el.dataset.triggerTagId || '',
          x: left,
          y: top,
          sessionId: normalizeSessionId(el.dataset.sessionId)
        });
      } else if (type === 'eraser') {
        items.push({
          type: 'eraser',
          triggerTagId: el.dataset.triggerTagId || '',
          x: left,
          y: top,
          sessionId: normalizeSessionId(el.dataset.sessionId)
        });
      } else if (type === 'selection') {
        items.push({
          type: 'selection',
          triggerTagId: el.dataset.triggerTagId || '',
          x: left,
          y: top,
          sessionId: normalizeSessionId(el.dataset.sessionId)
        });
      } else if (type === 'layer-square') {
        var layerName = el.dataset.layerName || '';
        if (!layerName && el.querySelector) {
          var textEl = el.querySelector('.ui-layer-square__text');
          if (textEl) layerName = String(textEl.textContent || '').trim();
        }
        items.push({
          type: 'layer-square',
          layerName: String(layerName || ''),
          color: el.dataset.color || defaultItemColor,
          triggerTagId: el.dataset.triggerTagId || '',
          x: left,
          y: top,
          sessionId: normalizeSessionId(el.dataset.sessionId)
        });
      }
    }

    var participants = {
      count: state.stage3ParticipantCount || 0,
      primaryTagIds: Array.isArray(state.stage3ParticipantTagIds) ? state.stage3ParticipantTagIds.slice() : [],
      triggerTagIds: Array.isArray(state.stage3ParticipantTriggerTagIds) ? state.stage3ParticipantTriggerTagIds.slice() : []
    };
    var mapSetup = getSetupExportData ? getSetupExportData() : null;

    var payload = {
      version: 3,
      exportedAt: new Date().toISOString(),
      items: items,
      participants: participants,
      mapSetup: mapSetup
    };

    downloadTextFile(JSON.stringify(payload, null, 2), fileNameForExport());
  }

  async function importFromFile(file) {
    try {
      var text = await file.text();
      var data = JSON.parse(text);
      importFromData(data);
    } catch (err) {
      console.error('Import failed:', err);
      alert('Import failed: invalid JSON.');
    }
  }

  function importFromData(data) {
    if (!data || typeof data !== 'object' || !Array.isArray(data.items)) {
      alert('Import failed: invalid format.');
      return;
    }

    var participants = data.participants && typeof data.participants === 'object' ? data.participants : null;
    if (participants) {
      var importedCount = sanitizeParticipantCount(participants.count);
      state.stage3ParticipantCount = importedCount;

      var primaryIds = Array.isArray(participants.primaryTagIds) ? participants.primaryTagIds.slice() : [];
      var triggerIds = Array.isArray(participants.triggerTagIds) ? participants.triggerTagIds.slice() : [];
      state.stage3ParticipantTagIds = primaryIds;
      state.stage3ParticipantTriggerTagIds = triggerIds;
      participantsInputEl.value = importedCount ? String(importedCount) : '';
      updateParticipantsUi();
    }

    overlayEl.textContent = '';

    for (var i = 0; i < data.items.length; i++) {
      var item = data.items[i];
      if (!item || typeof item !== 'object') continue;

      if (item.type === 'label') {
        var labelEl = document.createElement('div');
        labelEl.className = 'ui-label';
        labelEl.textContent = String(item.text || '');
        labelEl.dataset.uiType = 'label';
        labelEl.style.left = String(item.x || 0) + 'px';
        labelEl.style.top = String(item.y || 0) + 'px';
        var importedRotationDeg = parseFloat(item.rotationDeg);
        if (!isFinite(importedRotationDeg)) importedRotationDeg = 0;
        setElementRotation(labelEl, importedRotationDeg);
        assignImportedSessionId(labelEl, item.sessionId);
        overlayEl.appendChild(labelEl);
        makeDraggable(labelEl);
        continue;
      }

      if (item.type === 'draw') {
        var drawEl = document.createElement('div');
        drawEl.className = 'ui-draw';
        drawEl.dataset.uiType = 'draw';
        drawEl.dataset.color = String(item.color || defaultItemColor);
        drawEl.style.left = String(item.x || 0) + 'px';
        drawEl.style.top = String(item.y || 0) + 'px';
        assignImportedSessionId(drawEl, item.sessionId);

        var drawCanvasEl = document.createElement('canvas');
        drawCanvasEl.className = 'ui-draw__canvas';
        drawCanvasEl.width = 90;
        drawCanvasEl.height = 90;
        drawEl.appendChild(drawCanvasEl);

        overlayEl.appendChild(drawEl);

        renderDrawIcon(drawCanvasEl, drawEl.dataset.color);
        makeDraggable(drawEl, { draggingClass: 'ui-draw--dragging' });
        continue;
      }

      if (item.type === 'note') {
        var noteEl = document.createElement('div');
        noteEl.className = 'ui-note';
        noteEl.dataset.uiType = 'note';
        noteEl.dataset.expanded = 'false';
        noteEl.dataset.noteText = String(item.text || '');
        noteEl.dataset.color = String(item.color || defaultItemColor);
        noteEl.style.background = noteEl.dataset.color;
        noteEl.style.left = String(item.x || 0) + 'px';
        noteEl.style.top = String(item.y || 0) + 'px';
        assignImportedSessionId(noteEl, item.sessionId);

        var iconEl = document.createElement('div');
        iconEl.className = 'ui-note__icon';
        iconEl.textContent = item.text ? '📝✓' : '📝';
        noteEl.appendChild(iconEl);

        overlayEl.appendChild(noteEl);

        makeDraggable(noteEl, { draggingClass: 'ui-note--dragging' });
        setupNoteInteraction(noteEl);
        continue;
      }

      if (item.type === 'eraser') {
        var eraserEl = document.createElement('div');
        eraserEl.className = 'ui-eraser';
        eraserEl.dataset.uiType = 'eraser';
        eraserEl.style.left = String(item.x || 0) + 'px';
        eraserEl.style.top = String(item.y || 0) + 'px';
        assignImportedSessionId(eraserEl, item.sessionId);

        var eraserIcon = document.createElement('div');
        eraserIcon.className = 'ui-eraser__icon';
        eraserIcon.textContent = '\u232B';
        eraserEl.appendChild(eraserIcon);

        overlayEl.appendChild(eraserEl);

        makeDraggable(eraserEl, { draggingClass: 'ui-eraser--dragging' });
        continue;
      }

      if (item.type === 'selection') {
        var selectionEl = document.createElement('div');
        selectionEl.className = 'ui-selection';
        selectionEl.dataset.uiType = 'selection';
        selectionEl.style.left = String(item.x || 0) + 'px';
        selectionEl.style.top = String(item.y || 0) + 'px';
        assignImportedSessionId(selectionEl, item.sessionId);

        var selectionIcon = document.createElement('div');
        selectionIcon.className = 'ui-selection__icon';
        selectionIcon.textContent = '↖';
        selectionEl.appendChild(selectionIcon);

        overlayEl.appendChild(selectionEl);

        makeDraggable(selectionEl, { draggingClass: 'ui-selection--dragging' });
        continue;
      }

      if (item.type === 'layer-square') {
        var layerSquareEl = document.createElement('div');
        layerSquareEl.className = 'ui-dot ui-sticker-instance ui-layer-square';
        layerSquareEl.dataset.uiType = 'layer-square';
        var importedLayerName = String(item.layerName || item.text || '').trim();
        layerSquareEl.dataset.layerName = importedLayerName;
        layerSquareEl.dataset.color = String(item.color || defaultItemColor);
        layerSquareEl.style.background = layerSquareEl.dataset.color;
        layerSquareEl.style.left = String(item.x || 0) + 'px';
        layerSquareEl.style.top = String(item.y || 0) + 'px';
        assignImportedSessionId(layerSquareEl, item.sessionId);

        var layerTextEl = document.createElement('span');
        layerTextEl.className = 'ui-layer-square__text';
        layerTextEl.textContent = importedLayerName;
        layerSquareEl.appendChild(layerTextEl);

        overlayEl.appendChild(layerSquareEl);
      }
    }

    if (applySetupImportData) {
      applySetupImportData(data.mapSetup || null);
    }
  }
}

function makeDraggable(el, options) {
  options = options || {};
  var draggingClass = options.draggingClass || 'ui-label--dragging';
  var dragging = false;
  var offsetX = 0;
  var offsetY = 0;

  function startDrag(e, isProgrammaticStart) {
    if (!e) return;
    if (!isProgrammaticStart && e.button !== 0) return;

    if (!isProgrammaticStart && state.stage === 3 && el.classList && el.classList.contains('ui-label') && e.ctrlKey) {
      e.preventDefault();
      var currentDeg = parseFloat(el.dataset.rotationDeg || '0');
      if (!isFinite(currentDeg)) currentDeg = 0;
      setElementRotation(el, currentDeg + 45);
      return;
    }
    if (state.stage === 4 && el.classList && (el.classList.contains('ui-eraser') || el.classList.contains('ui-selection'))) return;
    if (typeof e.preventDefault === 'function') e.preventDefault();

    if (!isFinite(e.pointerId)) return;
    var rect = el.getBoundingClientRect();
    dragging = true;
    offsetX = e.clientX - rect.left;
    offsetY = e.clientY - rect.top;

    el.classList.add(draggingClass);
    if (el.setPointerCapture) {
      try {
        el.setPointerCapture(e.pointerId);
      } catch (err) {
        // Ignore if pointer capture is unavailable.
      }
    }
  }

  el.addEventListener('pointerdown', function (e) {
    startDrag(e, false);
  });

  el.addEventListener('pointermove', function (e) {
    if (!dragging) return;
    e.preventDefault();

    var left = e.clientX - offsetX;
    var top = e.clientY - offsetY;

    el.style.left = left + 'px';
    el.style.top = top + 'px';
  });

  function stopDrag(e) {
    if (!dragging) return;
    dragging = false;
    el.classList.remove(draggingClass);

    if (el.releasePointerCapture) {
      try {
        el.releasePointerCapture(e.pointerId);
      } catch (err) {
        // Ignore if capture was not active.
      }
    }
  }

  el.addEventListener('pointerup', stopDrag);
  el.addEventListener('pointercancel', stopDrag);

  // Right-click to remove element (only in Stage 3)
  el.addEventListener('contextmenu', function (e) {
    e.preventDefault();
    if (state.stage === 3 && el.parentNode) {
      el.parentNode.removeChild(el);
    }
  });

  return function beginProgrammaticDrag(startEvent) {
    startDrag(startEvent, true);
  };
}

function setElementRotation(el, deg) {
  if (!el) return;
  var normalized = ((deg % 360) + 360) % 360;
  el.dataset.rotationDeg = String(normalized);
  el.style.transform = normalized ? ('rotate(' + normalized + 'deg)') : '';
}

function renderDrawIcon(canvasEl, color) {
  var ctx = canvasEl.getContext('2d');
  if (!ctx) return;
  ctx.clearRect(0, 0, canvasEl.width, canvasEl.height);
  drawScribble(ctx, color, canvasEl.width, canvasEl.height);
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

function downloadTextFile(text, filename) {
  var blob = new Blob([text], { type: 'application/json' });
  var url = URL.createObjectURL(blob);

  var a = document.createElement('a');
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();

  setTimeout(function () {
    URL.revokeObjectURL(url);
  }, 0);
}

function fileNameForExport() {
  var iso = new Date().toISOString().replace(/[:.]/g, '-');
  return 'ui-setup-' + iso + '.json';
}
