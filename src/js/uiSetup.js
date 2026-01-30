export function initUiSetup(options) {
  options = options || {};
  var panelEl = options.panelEl;
  var overlayEl = options.overlayEl;

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

  var colorRow = document.createElement('div');
  colorRow.className = 'ui-setup-row';

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

  colorRow.appendChild(colorSwatchBtn);
  colorRow.appendChild(addDotBtn);
  panelEl.appendChild(colorRow);

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

  var drawRow = document.createElement('div');
  drawRow.className = 'ui-setup-row';

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

  drawRow.appendChild(drawSwatchEl);
  drawRow.appendChild(addDrawBtn);
  panelEl.appendChild(drawRow);

  redrawDrawPreview();

  drawColorInputEl.addEventListener('input', function () {
    currentDrawColor = drawColorInputEl.value;
    redrawDrawPreview();
  });

  addDrawBtn.addEventListener('click', function () {
    createDraw();
  });

  function createLabelFromInput() {
    var text = String(inputEl.value || '').trim();
    if (!text) return;

    var labelEl = document.createElement('div');
    labelEl.className = 'ui-label';
    labelEl.textContent = text;
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

    try {
      el.releasePointerCapture(e.pointerId);
    } catch {}
  }

  el.addEventListener('pointerup', stopDrag);
  el.addEventListener('pointercancel', stopDrag);
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
