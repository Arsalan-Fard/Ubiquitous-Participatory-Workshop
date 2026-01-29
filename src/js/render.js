export function clearOverlay(ctx, canvas) {
  ctx.clearRect(0, 0, canvas.width, canvas.height);
}

export function drawDetections(ctx, detections) {
  for (var i = 0; i < detections.length; i++) {
    drawDetection(ctx, detections[i]);
  }
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
