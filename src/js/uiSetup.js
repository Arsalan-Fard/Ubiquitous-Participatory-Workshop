import { state } from './state.js';

export function initUiSetup(options) {
  options = options || {};
  var panelEl = options.panelEl;
  var overlayEl = options.overlayEl;
  var onNextStage = options.onNextStage || null;

  if (!panelEl) throw new Error('initUiSetup: missing panelEl');
  if (!overlayEl) throw new Error('initUiSetup: missing overlayEl');

  panelEl.textContent = '';

  var currentColor = '#ff3b30';
  var currentDrawColor = '#2bb8ff';

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

  var colorInputEl = document.createElement('input');
  colorInputEl.type = 'color';
  colorInputEl.className = 'ui-color-input';
  colorInputEl.value = currentColor;
  colorInputEl.setAttribute('aria-label', 'Pick circle color');

  var colorSwatchBtn = document.createElement('div');
  colorSwatchBtn.className = 'ui-color-swatch';
  colorSwatchBtn.style.background = currentColor;
  colorSwatchBtn.appendChild(colorInputEl);

  var addDotBtn = document.createElement('button');
  addDotBtn.className = 'ui-setup-add-btn';
  addDotBtn.type = 'button';
  addDotBtn.textContent = '+';
  addDotBtn.setAttribute('aria-label', 'Add circle');

  addBtn.addEventListener('click', function () {
    createLabelFromInput();
  });

  inputEl.addEventListener('keydown', function (e) {
    if (e.key !== 'Enter') return;
    e.preventDefault();
    createLabelFromInput();
  });

  colorInputEl.addEventListener('input', function () {
    currentColor = colorInputEl.value;
    colorSwatchBtn.style.background = currentColor;
  });

  addDotBtn.addEventListener('click', function () {
    createDot();
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

  var addNoteBtn = document.createElement('button');
  addNoteBtn.className = 'ui-setup-note-btn';
  addNoteBtn.type = 'button';
  addNoteBtn.textContent = 'Note';
  addNoteBtn.setAttribute('aria-label', 'Add note annotation');

  addNoteBtn.addEventListener('click', function () {
    createNote();
  });

  var controlsRow = document.createElement('div');
  controlsRow.className = 'ui-setup-row';
  controlsRow.appendChild(colorSwatchBtn);
  controlsRow.appendChild(addDotBtn);
  controlsRow.appendChild(drawSwatchEl);
  controlsRow.appendChild(addDrawBtn);
  controlsRow.appendChild(addNoteBtn);
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

  footer.appendChild(exportBtn);
  footer.appendChild(importBtn);
  footer.appendChild(nextBtn);
  panelEl.appendChild(footer);
  panelEl.appendChild(importFileEl);

  nextBtn.addEventListener('click', function () {
    if (onNextStage) onNextStage();
  });

  redrawDrawPreview();

  drawColorInputEl.addEventListener('input', function () {
    currentDrawColor = drawColorInputEl.value;
    redrawDrawPreview();
  });

  addDrawBtn.addEventListener('click', function () {
    createDraw();
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

  function createLabelFromInput() {
    var text = String(inputEl.value || '').trim();
    if (!text) return;

    var labelEl = document.createElement('div');
    labelEl.className = 'ui-label';
    labelEl.textContent = text;
    labelEl.dataset.uiType = 'label';
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

  function createDot() {
    var dotEl = document.createElement('div');
    dotEl.className = 'ui-dot';
    dotEl.style.background = currentColor;
    dotEl.dataset.uiType = 'dot';
    dotEl.dataset.color = currentColor;
    overlayEl.appendChild(dotEl);

    positionDotAboveSwatch(dotEl);
    makeDraggable(dotEl, { draggingClass: 'ui-dot--dragging' });
  }

  function positionDotAboveSwatch(dotEl) {
    var swatchRect = colorSwatchBtn.getBoundingClientRect();
    var x = swatchRect.left + swatchRect.width / 2;
    var y = swatchRect.top;

    dotEl.style.left = '0px';
    dotEl.style.top = '0px';
    dotEl.style.visibility = 'hidden';

    requestAnimationFrame(function () {
      var dotRect = dotEl.getBoundingClientRect();
      var left = Math.max(8, Math.min(window.innerWidth - dotRect.width - 8, x - dotRect.width / 2));
      var top = Math.max(8, y - 10 - dotRect.height);
      dotEl.style.left = left + 'px';
      dotEl.style.top = top + 'px';
      dotEl.style.visibility = 'visible';
    });
  }

  function redrawDrawPreview() {
    var ctx = drawPreviewCanvas.getContext('2d');
    if (!ctx) return;
    ctx.clearRect(0, 0, drawPreviewCanvas.width, drawPreviewCanvas.height);
    drawScribble(ctx, currentDrawColor, drawPreviewCanvas.width, drawPreviewCanvas.height);
  }

  function createDraw() {
    var drawEl = document.createElement('canvas');
    drawEl.className = 'ui-draw';
    drawEl.width = 48;
    drawEl.height = 48;
    drawEl.dataset.uiType = 'draw';
    drawEl.dataset.color = currentDrawColor;
    overlayEl.appendChild(drawEl);

    positionDrawAboveSwatch(drawEl);
    renderDrawIcon(drawEl, currentDrawColor);
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

    var iconEl = document.createElement('div');
    iconEl.className = 'ui-note__icon';
    iconEl.textContent = '📝';
    noteEl.appendChild(iconEl);

    overlayEl.appendChild(noteEl);

    positionNoteAboveButton(noteEl);
    makeDraggable(noteEl, { draggingClass: 'ui-note--dragging' });
    setupNoteInteraction(noteEl);
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

  function expandNote(noteEl) {
    if (noteEl.dataset.expanded === 'true') return;
    noteEl.dataset.expanded = 'true';
    noteEl.classList.add('ui-note--expanded');

    // Create form if not exists
    var formEl = noteEl.querySelector('.ui-note__form');
    if (!formEl) {
      formEl = document.createElement('div');
      formEl.className = 'ui-note__form';

      var textareaEl = document.createElement('textarea');
      textareaEl.className = 'ui-note__textarea';
      textareaEl.placeholder = 'Enter your note...';
      textareaEl.rows = 3;

      var submitBtn = document.createElement('button');
      submitBtn.className = 'ui-note__submit';
      submitBtn.type = 'button';
      submitBtn.textContent = 'Save';

      submitBtn.addEventListener('click', function (e) {
        e.stopPropagation();
        var text = textareaEl.value.trim();
        if (text) {
          noteEl.dataset.noteText = text;
          collapseNote(noteEl, text);
        }
      });

      textareaEl.addEventListener('click', function (e) {
        e.stopPropagation();
      });

      textareaEl.addEventListener('keydown', function (e) {
        e.stopPropagation();
        if (e.key === 'Enter' && !e.shiftKey) {
          e.preventDefault();
          submitBtn.click();
        }
        if (e.key === 'Escape') {
          collapseNote(noteEl);
        }
      });

      formEl.appendChild(textareaEl);
      formEl.appendChild(submitBtn);
      noteEl.appendChild(formEl);

      // Focus textarea
      setTimeout(function () {
        textareaEl.focus();
      }, 50);
    } else {
      var textarea = formEl.querySelector('.ui-note__textarea');
      if (textarea) {
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

    // Update icon to show it has content
    var iconEl = noteEl.querySelector('.ui-note__icon');
    if (iconEl && savedText) {
      iconEl.textContent = '📝✓';
    }
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
        items.push({ type: 'label', text: el.textContent || '', x: left, y: top });
      } else if (type === 'dot') {
        items.push({ type: 'dot', color: el.dataset.color || '#ff3b30', x: left, y: top });
      } else if (type === 'draw') {
        items.push({ type: 'draw', color: el.dataset.color || '#2bb8ff', x: left, y: top });
      } else if (type === 'note') {
        items.push({ type: 'note', text: el.dataset.noteText || '', x: left, y: top });
      }
    }

    var payload = {
      version: 1,
      exportedAt: new Date().toISOString(),
      items: items,
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
        overlayEl.appendChild(labelEl);
        makeDraggable(labelEl);
        continue;
      }

      if (item.type === 'dot') {
        var dotEl = document.createElement('div');
        dotEl.className = 'ui-dot';
        dotEl.dataset.uiType = 'dot';
        dotEl.dataset.color = String(item.color || '#ff3b30');
        dotEl.style.background = dotEl.dataset.color;
        dotEl.style.left = String(item.x || 0) + 'px';
        dotEl.style.top = String(item.y || 0) + 'px';
        overlayEl.appendChild(dotEl);
        makeDraggable(dotEl, { draggingClass: 'ui-dot--dragging' });
        continue;
      }

      if (item.type === 'draw') {
        var drawEl = document.createElement('canvas');
        drawEl.className = 'ui-draw';
        drawEl.width = 48;
        drawEl.height = 48;
        drawEl.dataset.uiType = 'draw';
        drawEl.dataset.color = String(item.color || '#2bb8ff');
        drawEl.style.left = String(item.x || 0) + 'px';
        drawEl.style.top = String(item.y || 0) + 'px';
        overlayEl.appendChild(drawEl);
        renderDrawIcon(drawEl, drawEl.dataset.color);
        makeDraggable(drawEl, { draggingClass: 'ui-draw--dragging' });
        continue;
      }

      if (item.type === 'note') {
        var noteEl = document.createElement('div');
        noteEl.className = 'ui-note';
        noteEl.dataset.uiType = 'note';
        noteEl.dataset.expanded = 'false';
        noteEl.dataset.noteText = String(item.text || '');
        noteEl.style.left = String(item.x || 0) + 'px';
        noteEl.style.top = String(item.y || 0) + 'px';

        var iconEl = document.createElement('div');
        iconEl.className = 'ui-note__icon';
        iconEl.textContent = item.text ? '📝✓' : '📝';
        noteEl.appendChild(iconEl);

        overlayEl.appendChild(noteEl);
        makeDraggable(noteEl, { draggingClass: 'ui-note--dragging' });
        setupNoteInteraction(noteEl);
        continue;
      }
    }
  }
}

function makeDraggable(el, options) {
  options = options || {};
  var draggingClass = options.draggingClass || 'ui-label--dragging';
  var dragging = false;
  var offsetX = 0;
  var offsetY = 0;

  el.addEventListener('pointerdown', function (e) {
    if (e.button !== 0) return;
    e.preventDefault();

    var rect = el.getBoundingClientRect();
    dragging = true;
    offsetX = e.clientX - rect.left;
    offsetY = e.clientY - rect.top;

    el.classList.add(draggingClass);
    el.setPointerCapture(e.pointerId);
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

    if (el.releasePointerCapture) el.releasePointerCapture(e.pointerId);
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
