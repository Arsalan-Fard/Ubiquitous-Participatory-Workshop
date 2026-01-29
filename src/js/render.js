export function clearOverlay(ctx, canvas) {
  ctx.clearRect(0, 0, canvas.width, canvas.height);
}

export function drawDetections(ctx, detections) {
  for (const det of detections) drawDetection(ctx, det);
}

function drawDetection(ctx, det) {
  const corners = det.corners;

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
  for (const corner of corners) {
    ctx.beginPath();
    ctx.arc(corner.x, corner.y, 5, 0, 2 * Math.PI);
    ctx.fill();
  }

  ctx.font = 'bold 24px Arial';
  ctx.fillStyle = '#00ff00';
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  const marginText = det.decision_margin ? ` (${det.decision_margin.toFixed(1)})` : '';
  ctx.fillText('ID: ' + det.id + marginText, det.center.x, det.center.y);
}
