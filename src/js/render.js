export function clearOverlay(ctx, canvas) {
  ctx.clearRect(0, 0, canvas.width, canvas.height);
}

export function drawDetections(ctx, detections) {
  for (var i = 0; i < detections.length; i++) {
    drawDetection(ctx, detections[i]);
  }
}

export function drawSurface(ctx, corners, options) {
  options = options || {};
  var previewPoint = options.previewPoint || null;
  var previewIndex = typeof options.previewIndex === 'number' ? options.previewIndex : null;

  if (!corners || corners.length !== 4) return;

  var allSet = true;
  for (var i = 0; i < 4; i++) {
    if (!corners[i]) {
      allSet = false;
      break;
    }
  }

  ctx.save();

  if (allSet) {
    ctx.beginPath();
    ctx.moveTo(corners[0].x, corners[0].y);
    ctx.lineTo(corners[1].x, corners[1].y);
    ctx.lineTo(corners[2].x, corners[2].y);
    ctx.lineTo(corners[3].x, corners[3].y);
    ctx.closePath();
    ctx.fillStyle = 'rgba(43, 184, 255, 0.14)';
    ctx.fill();
    ctx.strokeStyle = 'rgba(43, 184, 255, 0.95)';
    ctx.lineWidth = 3;
    ctx.stroke();
  } else {
    ctx.strokeStyle = 'rgba(43, 184, 255, 0.95)';
    ctx.lineWidth = 3;
    for (var j = 0; j < 3; j++) {
      if (!corners[j] || !corners[j + 1]) continue;
      ctx.beginPath();
      ctx.moveTo(corners[j].x, corners[j].y);
      ctx.lineTo(corners[j + 1].x, corners[j + 1].y);
      ctx.stroke();
    }
  }

  if (previewPoint && previewIndex !== null) {
    var prevIndex = previewIndex > 0 ? previewIndex - 1 : null;
    if (prevIndex !== null && corners[prevIndex]) {
      ctx.save();
      ctx.strokeStyle = 'rgba(255, 255, 255, 0.75)';
      ctx.lineWidth = 2;
      ctx.setLineDash([6, 6]);
      ctx.beginPath();
      ctx.moveTo(corners[prevIndex].x, corners[prevIndex].y);
      ctx.lineTo(previewPoint.x, previewPoint.y);
      ctx.stroke();
      ctx.restore();
    }

    ctx.save();
    ctx.strokeStyle = 'rgba(255, 255, 255, 0.9)';
    ctx.lineWidth = 2;
    ctx.setLineDash([4, 4]);
    ctx.beginPath();
    ctx.arc(previewPoint.x, previewPoint.y, 10, 0, 2 * Math.PI);
    ctx.stroke();
    ctx.restore();
  }

  for (var k = 0; k < 4; k++) {
    var pt = corners[k];
    if (!pt) continue;

    ctx.beginPath();
    ctx.arc(pt.x, pt.y, 7, 0, 2 * Math.PI);
    ctx.fillStyle = 'rgba(49, 214, 123, 0.95)';
    ctx.fill();
    ctx.strokeStyle = 'rgba(0, 0, 0, 0.45)';
    ctx.lineWidth = 2;
    ctx.stroke();

    ctx.font = 'bold 14px Arial';
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillStyle = '#0b0b0b';
    ctx.fillText(String(k + 1), pt.x, pt.y);
  }

  ctx.restore();
}

/**
 * Draws a zigzag guide path inside the surface polygon for surface plane calibration.
 * The path covers edges and crosses through the middle for good point distribution.
 * @param {CanvasRenderingContext2D} ctx
 * @param {Array} corners - The 4 surface corners [{x,y}, ...]
 * @param {Object} options - { progress: 0-1 (how far along the path the user is), collecting: boolean }
 */
export function drawPlaneCalibrationGuide(ctx, corners, options) {
  options = options || {};
  var collecting = options.collecting || false;
  var collectedPoints = options.collectedPoints || [];

  if (!corners || corners.length !== 4) return;
  for (var i = 0; i < 4; i++) {
    if (!corners[i]) return;
  }

  ctx.save();

  // Interpolate within the quadrilateral using bilinear interpolation
  // u goes left-right (0-1), v goes top-bottom (0-1)
  function lerp(a, b, t) { return a + (b - a) * t; }
  function interpQuad(u, v) {
    // corners: 0=TL, 1=TR, 2=BR, 3=BL
    var topX = lerp(corners[0].x, corners[1].x, u);
    var topY = lerp(corners[0].y, corners[1].y, u);
    var botX = lerp(corners[3].x, corners[2].x, u);
    var botY = lerp(corners[3].y, corners[2].y, u);
    return { x: lerp(topX, botX, v), y: lerp(topY, botY, v) };
  }

  // Build zigzag path with margins inside the surface
  var margin = 0.08;  // 8% inset from edges
  var rows = 4;       // number of horizontal passes
  var pathPoints = [];

  for (var r = 0; r <= rows; r++) {
    var v = margin + (1 - 2 * margin) * (r / rows);
    if (r % 2 === 0) {
      // left to right
      pathPoints.push(interpQuad(margin, v));
      pathPoints.push(interpQuad(1 - margin, v));
    } else {
      // right to left
      pathPoints.push(interpQuad(1 - margin, v));
      pathPoints.push(interpQuad(margin, v));
    }
  }

  // Draw the guide path
  if (pathPoints.length > 1) {
    ctx.beginPath();
    ctx.moveTo(pathPoints[0].x, pathPoints[0].y);
    for (var p = 1; p < pathPoints.length; p++) {
      ctx.lineTo(pathPoints[p].x, pathPoints[p].y);
    }
    ctx.strokeStyle = collecting ? 'rgba(255, 160, 0, 0.7)' : 'rgba(180, 100, 255, 0.5)';
    ctx.lineWidth = 3;
    ctx.setLineDash([10, 8]);
    ctx.stroke();
    ctx.setLineDash([]);

    // Draw arrows along the path to show direction
    for (var a = 0; a < pathPoints.length - 1; a++) {
      var from = pathPoints[a];
      var to = pathPoints[a + 1];
      var mx = (from.x + to.x) / 2;
      var my = (from.y + to.y) / 2;
      var angle = Math.atan2(to.y - from.y, to.x - from.x);
      var arrowSize = 8;

      ctx.beginPath();
      ctx.moveTo(mx + arrowSize * Math.cos(angle), my + arrowSize * Math.sin(angle));
      ctx.lineTo(mx - arrowSize * Math.cos(angle - Math.PI / 4), my - arrowSize * Math.sin(angle - Math.PI / 4));
      ctx.moveTo(mx + arrowSize * Math.cos(angle), my + arrowSize * Math.sin(angle));
      ctx.lineTo(mx - arrowSize * Math.cos(angle + Math.PI / 4), my - arrowSize * Math.sin(angle + Math.PI / 4));
      ctx.strokeStyle = collecting ? 'rgba(255, 160, 0, 0.9)' : 'rgba(180, 100, 255, 0.7)';
      ctx.lineWidth = 2;
      ctx.stroke();
    }

    // Draw start dot
    ctx.beginPath();
    ctx.arc(pathPoints[0].x, pathPoints[0].y, 6, 0, 2 * Math.PI);
    ctx.fillStyle = 'rgba(49, 214, 123, 0.9)';
    ctx.fill();
  }

  // Draw collected sample points as small dots
  if (collecting && collectedPoints.length > 0) {
    for (var cp = 0; cp < collectedPoints.length; cp++) {
      ctx.beginPath();
      ctx.arc(collectedPoints[cp].x, collectedPoints[cp].y, 3, 0, 2 * Math.PI);
      ctx.fillStyle = 'rgba(255, 160, 0, 0.8)';
      ctx.fill();
    }
  }

  ctx.restore();
}

function drawDetection(ctx, det) {
  var corners = det.corners;

  ctx.beginPath();
  ctx.moveTo(corners[0].x, corners[0].y);
  ctx.lineTo(corners[1].x, corners[1].y);
  ctx.lineTo(corners[2].x, corners[2].y);
  ctx.lineTo(corners[3].x, corners[3].y);
  ctx.closePath();
  ctx.strokeStyle = '#00ff00';
  ctx.lineWidth = 3;
  ctx.stroke();

  ctx.fillStyle = '#ff0000';
  for (var i = 0; i < corners.length; i++) {
    var corner = corners[i];
    ctx.beginPath();
    ctx.arc(corner.x, corner.y, 5, 0, 2 * Math.PI);
    ctx.fill();
  }

  ctx.font = 'bold 24px Arial';
  ctx.fillStyle = '#00ff00';
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  var marginText = '';
  if (det.decision_margin) {
    marginText = ' (' + det.decision_margin.toFixed(1) + ')';
  }
  ctx.fillText('ID: ' + det.id + marginText, det.center.x, det.center.y);
}
