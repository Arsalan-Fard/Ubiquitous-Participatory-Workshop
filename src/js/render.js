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

// Hand skeleton connections
const HAND_CONNECTIONS = [
  // Thumb
  [0, 1], [1, 2], [2, 3], [3, 4],
  // Index
  [0, 5], [5, 6], [6, 7], [7, 8],
  // Middle
  [0, 9], [9, 10], [10, 11], [11, 12],
  // Ring
  [0, 13], [13, 14], [14, 15], [15, 16],
  // Pinky
  [0, 17], [17, 18], [18, 19], [19, 20],
  // Palm
  [5, 9], [9, 13], [13, 17]
];

export function drawHands(ctx, hands) {
  for (const hand of hands) {
    drawHand(ctx, hand);
  }
}

function drawHand(ctx, hand) {
  const landmarks = hand.landmarks;

  // Draw skeleton lines
  ctx.strokeStyle = '#00ffff';
  ctx.lineWidth = 2;
  for (const [start, end] of HAND_CONNECTIONS) {
    ctx.beginPath();
    ctx.moveTo(landmarks[start].x, landmarks[start].y);
    ctx.lineTo(landmarks[end].x, landmarks[end].y);
    ctx.stroke();
  }

  // Draw landmark dots
  for (let i = 0; i < landmarks.length; i++) {
    const lm = landmarks[i];
    ctx.beginPath();
    ctx.arc(lm.x, lm.y, 4, 0, 2 * Math.PI);
    // Highlight thumb tip (4) and index tip (8)
    if (i === 4 || i === 8) {
      ctx.fillStyle = '#ff00ff';
    } else {
      ctx.fillStyle = '#ffff00';
    }
    ctx.fill();
  }

  // Draw pinch distance line between thumb and index tips
  const thumbTip = landmarks[4];
  const indexTip = landmarks[8];
  ctx.beginPath();
  ctx.moveTo(thumbTip.x, thumbTip.y);
  ctx.lineTo(indexTip.x, indexTip.y);
  ctx.strokeStyle = '#ff00ff';
  ctx.lineWidth = 2;
  ctx.setLineDash([5, 5]);
  ctx.stroke();
  ctx.setLineDash([]);

  // Draw pinch distance text
  const midX = (thumbTip.x + indexTip.x) / 2;
  const midY = (thumbTip.y + indexTip.y) / 2;
  ctx.font = 'bold 14px Arial';
  ctx.fillStyle = '#ff00ff';
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  ctx.fillText(`${hand.pinchDistance.toFixed(0)}px`, midX, midY - 15);

  // Draw handedness label near wrist
  const wrist = landmarks[0];
  ctx.font = 'bold 16px Arial';
  ctx.fillStyle = '#00ffff';
  ctx.fillText(hand.handedness, wrist.x, wrist.y + 20);
}
