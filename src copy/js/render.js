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
 * Draw stereo calibration points on the overlay.
 * @param {CanvasRenderingContext2D} ctx
 * @param {Array} calibrationPoints - Array of calibration point objects
 * @param {string} cameraKey - 'camera1Pixel' or 'camera2Pixel'
 * @param {Object} options - { armedIndex, previewPoint }
 */
export function drawStereoCalibPoints(ctx, calibrationPoints, cameraKey, options) {
  options = options || {};
  var armedIndex = typeof options.armedIndex === 'number' ? options.armedIndex : null;
  var previewPoint = options.previewPoint || null;

  ctx.save();

  // Draw captured points
  for (var i = 0; i < calibrationPoints.length; i++) {
    var pt = calibrationPoints[i];
    if (!pt || !pt[cameraKey]) continue;

    var pixel = pt[cameraKey];
    var isElevated = i >= 8; // Points 9-12 are elevated

    // Draw point circle
    ctx.beginPath();
    ctx.arc(pixel.x, pixel.y, 8, 0, 2 * Math.PI);
    ctx.fillStyle = isElevated ? 'rgba(255, 184, 43, 0.95)' : 'rgba(49, 214, 123, 0.95)';
    ctx.fill();
    ctx.strokeStyle = 'rgba(0, 0, 0, 0.5)';
    ctx.lineWidth = 2;
    ctx.stroke();

    // Draw point number
    ctx.font = 'bold 11px Arial';
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillStyle = '#0b0b0b';
    ctx.fillText(String(i + 1), pixel.x, pixel.y);
  }

  // Draw preview for armed point
  if (armedIndex !== null && previewPoint) {
    var isElevatedArmed = armedIndex >= 8;

    // Dashed circle around preview point
    ctx.save();
    ctx.strokeStyle = isElevatedArmed ? 'rgba(255, 184, 43, 0.9)' : 'rgba(43, 184, 255, 0.9)';
    ctx.lineWidth = 2;
    ctx.setLineDash([4, 4]);
    ctx.beginPath();
    ctx.arc(previewPoint.x, previewPoint.y, 12, 0, 2 * Math.PI);
    ctx.stroke();
    ctx.restore();

    // Show which point number is being captured
    ctx.font = 'bold 14px Arial';
    ctx.textAlign = 'left';
    ctx.textBaseline = 'middle';
    ctx.fillStyle = isElevatedArmed ? 'rgba(255, 184, 43, 0.95)' : 'rgba(43, 184, 255, 0.95)';
    ctx.fillText('Point ' + (armedIndex + 1), previewPoint.x + 18, previewPoint.y);
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
