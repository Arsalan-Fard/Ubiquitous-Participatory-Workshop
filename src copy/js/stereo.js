/**
 * Stereo Vision Math Module
 *
 * Provides functions for:
 * - Computing 3x4 projection matrices from point correspondences (DLT)
 * - Triangulating 3D points from two camera observations
 * - Reprojection error calculation for validation
 */

/**
 * Compute 3x4 projection matrix from world-to-image point correspondences using DLT.
 *
 * @param {Array<{x: number, y: number, z: number}>} worldPoints - 3D world coordinates
 * @param {Array<{x: number, y: number}>} imagePoints - 2D pixel coordinates
 * @returns {Array<number>|null} - 12-element flat array for 3x4 matrix (row-major), or null if failed
 */
export function computeProjectionMatrix(worldPoints, imagePoints) {
  var n = worldPoints.length;
  if (n < 6) {
    console.error('computeProjectionMatrix: need at least 6 points, got', n);
    return null;
  }

  if (worldPoints.length !== imagePoints.length) {
    console.error('computeProjectionMatrix: worldPoints and imagePoints must have same length');
    return null;
  }

  // Normalize points for numerical stability
  var normWorld = normalizePoints3D(worldPoints);
  var normImage = normalizePoints2D(imagePoints);

  // Build matrix A (2n x 12) for DLT
  // For each point, we get 2 equations
  var A = [];
  for (var i = 0; i < n; i++) {
    var X = normWorld.points[i].x;
    var Y = normWorld.points[i].y;
    var Z = normWorld.points[i].z;
    var u = normImage.points[i].x;
    var v = normImage.points[i].y;

    // Row 1: [X, Y, Z, 1, 0, 0, 0, 0, -u*X, -u*Y, -u*Z, -u]
    A.push([X, Y, Z, 1, 0, 0, 0, 0, -u * X, -u * Y, -u * Z, -u]);
    // Row 2: [0, 0, 0, 0, X, Y, Z, 1, -v*X, -v*Y, -v*Z, -v]
    A.push([0, 0, 0, 0, X, Y, Z, 1, -v * X, -v * Y, -v * Z, -v]);
  }

  // Solve using SVD approach: find null space of A
  // We use the constraint P[11] = 1 and solve the 11x11 system
  var p = solveDLT(A);
  if (!p) {
    console.error('computeProjectionMatrix: DLT solve failed');
    return null;
  }

  // Denormalize the projection matrix
  // P_denorm = T_image^-1 * P_norm * T_world
  var P = denormalizeProjectionMatrix(p, normWorld.T, normImage.T);

  return P;
}

/**
 * Triangulate 3D point from two camera observations using DLT.
 *
 * @param {Array<number>} P1 - 12-element projection matrix for camera 1
 * @param {Array<number>} P2 - 12-element projection matrix for camera 2
 * @param {{x: number, y: number}} pixel1 - Observation in camera 1
 * @param {{x: number, y: number}} pixel2 - Observation in camera 2
 * @returns {{x: number, y: number, z: number}|null} - 3D world point or null
 */
export function triangulatePoint(P1, P2, pixel1, pixel2) {
  var u1 = pixel1.x;
  var v1 = pixel1.y;
  var u2 = pixel2.x;
  var v2 = pixel2.y;

  // Build 4x4 matrix A from the projection equations
  // Each camera gives 2 equations: u*P3 - P1 = 0 and v*P3 - P2 = 0
  // Where P1, P2, P3 are rows of P
  var A = [
    // Camera 1, equation 1: u1 * row3 - row1
    [
      u1 * P1[8] - P1[0],
      u1 * P1[9] - P1[1],
      u1 * P1[10] - P1[2],
      u1 * P1[11] - P1[3]
    ],
    // Camera 1, equation 2: v1 * row3 - row2
    [
      v1 * P1[8] - P1[4],
      v1 * P1[9] - P1[5],
      v1 * P1[10] - P1[6],
      v1 * P1[11] - P1[7]
    ],
    // Camera 2, equation 1: u2 * row3 - row1
    [
      u2 * P2[8] - P2[0],
      u2 * P2[9] - P2[1],
      u2 * P2[10] - P2[2],
      u2 * P2[11] - P2[3]
    ],
    // Camera 2, equation 2: v2 * row3 - row2
    [
      v2 * P2[8] - P2[4],
      v2 * P2[9] - P2[5],
      v2 * P2[10] - P2[6],
      v2 * P2[11] - P2[7]
    ]
  ];

  // Solve AX = 0 where X = [x, y, z, w]^T
  // We assume w = 1 and solve the overdetermined 4x3 system
  var A3 = [];
  var b = [];
  for (var i = 0; i < 4; i++) {
    A3.push([A[i][0], A[i][1], A[i][2]]);
    b.push(-A[i][3]);
  }

  // Least squares solution: (A^T A) x = A^T b
  var AtA = matMul(transpose(A3), A3);
  var Atb = matVecMul(transpose(A3), b);

  var xyz = solveLinearSystem3x3(AtA, Atb);
  if (!xyz) {
    return null;
  }

  return { x: xyz[0], y: xyz[1], z: xyz[2] };
}

/**
 * Project a 3D world point to 2D image coordinates.
 *
 * @param {Array<number>} P - 12-element projection matrix
 * @param {{x: number, y: number, z: number}} worldPoint - 3D point
 * @returns {{x: number, y: number}|null} - 2D pixel coordinates or null
 */
export function projectPoint(P, worldPoint) {
  var X = worldPoint.x;
  var Y = worldPoint.y;
  var Z = worldPoint.z;

  // P * [X, Y, Z, 1]^T = [u*w, v*w, w]^T
  var uw = P[0] * X + P[1] * Y + P[2] * Z + P[3];
  var vw = P[4] * X + P[5] * Y + P[6] * Z + P[7];
  var w = P[8] * X + P[9] * Y + P[10] * Z + P[11];

  if (Math.abs(w) < 1e-10) {
    return null;
  }

  return { x: uw / w, y: vw / w };
}

/**
 * Compute reprojection error for a single point.
 *
 * @param {Array<number>} P - 12-element projection matrix
 * @param {{x: number, y: number, z: number}} worldPoint - 3D point
 * @param {{x: number, y: number}} imagePoint - Observed 2D point
 * @returns {number} - Euclidean distance in pixels
 */
export function computeReprojectionError(P, worldPoint, imagePoint) {
  var projected = projectPoint(P, worldPoint);
  if (!projected) {
    return Infinity;
  }

  var dx = projected.x - imagePoint.x;
  var dy = projected.y - imagePoint.y;
  return Math.sqrt(dx * dx + dy * dy);
}

/**
 * Compute average reprojection error for calibration validation.
 *
 * @param {Array<number>} P1 - Projection matrix for camera 1
 * @param {Array<number>} P2 - Projection matrix for camera 2
 * @param {Array<Object>} calibrationPoints - Array of {worldPos, camera1Pixel, camera2Pixel}
 * @returns {number} - Average reprojection error in pixels
 */
export function computeAverageReprojectionError(P1, P2, calibrationPoints) {
  var totalError = 0;
  var count = 0;

  for (var i = 0; i < calibrationPoints.length; i++) {
    var pt = calibrationPoints[i];
    if (!pt || !pt.worldPos || !pt.camera1Pixel || !pt.camera2Pixel) continue;

    var err1 = computeReprojectionError(P1, pt.worldPos, pt.camera1Pixel);
    var err2 = computeReprojectionError(P2, pt.worldPos, pt.camera2Pixel);

    if (isFinite(err1)) {
      totalError += err1;
      count++;
    }
    if (isFinite(err2)) {
      totalError += err2;
      count++;
    }
  }

  return count > 0 ? totalError / count : Infinity;
}

// ============== Internal Helper Functions ==============

/**
 * Normalize 3D points for numerical stability.
 * Returns normalized points and the transformation matrix T.
 */
function normalizePoints3D(points) {
  var n = points.length;

  // Compute centroid
  var cx = 0, cy = 0, cz = 0;
  for (var i = 0; i < n; i++) {
    cx += points[i].x;
    cy += points[i].y;
    cz += points[i].z;
  }
  cx /= n;
  cy /= n;
  cz /= n;

  // Compute average distance from centroid
  var avgDist = 0;
  for (var i = 0; i < n; i++) {
    var dx = points[i].x - cx;
    var dy = points[i].y - cy;
    var dz = points[i].z - cz;
    avgDist += Math.sqrt(dx * dx + dy * dy + dz * dz);
  }
  avgDist /= n;

  // Scale so average distance is sqrt(3)
  var scale = avgDist > 1e-10 ? Math.sqrt(3) / avgDist : 1;

  // Normalized points
  var normalized = [];
  for (var i = 0; i < n; i++) {
    normalized.push({
      x: (points[i].x - cx) * scale,
      y: (points[i].y - cy) * scale,
      z: (points[i].z - cz) * scale
    });
  }

  // Transformation matrix T (4x4): T * [x,y,z,1]^T = [x',y',z',1]^T
  // T = [[s,0,0,-s*cx], [0,s,0,-s*cy], [0,0,s,-s*cz], [0,0,0,1]]
  var T = {
    scale: scale,
    cx: cx,
    cy: cy,
    cz: cz
  };

  return { points: normalized, T: T };
}

/**
 * Normalize 2D points for numerical stability.
 */
function normalizePoints2D(points) {
  var n = points.length;

  // Compute centroid
  var cx = 0, cy = 0;
  for (var i = 0; i < n; i++) {
    cx += points[i].x;
    cy += points[i].y;
  }
  cx /= n;
  cy /= n;

  // Compute average distance from centroid
  var avgDist = 0;
  for (var i = 0; i < n; i++) {
    var dx = points[i].x - cx;
    var dy = points[i].y - cy;
    avgDist += Math.sqrt(dx * dx + dy * dy);
  }
  avgDist /= n;

  // Scale so average distance is sqrt(2)
  var scale = avgDist > 1e-10 ? Math.sqrt(2) / avgDist : 1;

  // Normalized points
  var normalized = [];
  for (var i = 0; i < n; i++) {
    normalized.push({
      x: (points[i].x - cx) * scale,
      y: (points[i].y - cy) * scale
    });
  }

  var T = {
    scale: scale,
    cx: cx,
    cy: cy
  };

  return { points: normalized, T: T };
}

/**
 * Denormalize the projection matrix after solving with normalized coordinates.
 * P_final = T_image_inv * P_normalized * T_world
 */
function denormalizeProjectionMatrix(P_norm, T_world, T_image) {
  // T_world transforms world points: X_norm = s_w * (X - c_w)
  // T_image transforms image points: x_norm = s_i * (x - c_i)
  //
  // We have: x_norm = P_norm * X_norm
  // We want: x = P * X
  //
  // x_norm = s_i * (x - c_i)
  // x = x_norm / s_i + c_i = T_image_inv * x_norm
  //
  // X_norm = s_w * X - s_w * c_w = T_world * X (in homogeneous: T_world is 4x4)
  //
  // So: x = T_image_inv * P_norm * T_world * X
  // P = T_image_inv * P_norm * T_world

  var sw = T_world.scale;
  var cwx = T_world.cx;
  var cwy = T_world.cy;
  var cwz = T_world.cz;

  var si = T_image.scale;
  var cix = T_image.cx;
  var ciy = T_image.cy;

  // P_norm is 3x4 (12 elements, row-major)
  // First apply T_world (multiply from right), then T_image_inv (multiply from left)

  // T_world (4x4):
  // [sw,  0,  0, -sw*cwx]
  // [ 0, sw,  0, -sw*cwy]
  // [ 0,  0, sw, -sw*cwz]
  // [ 0,  0,  0,    1   ]

  // P_norm * T_world (3x4):
  var PT = [
    P_norm[0] * sw, P_norm[1] * sw, P_norm[2] * sw,
    P_norm[3] - P_norm[0] * sw * cwx - P_norm[1] * sw * cwy - P_norm[2] * sw * cwz,

    P_norm[4] * sw, P_norm[5] * sw, P_norm[6] * sw,
    P_norm[7] - P_norm[4] * sw * cwx - P_norm[5] * sw * cwy - P_norm[6] * sw * cwz,

    P_norm[8] * sw, P_norm[9] * sw, P_norm[10] * sw,
    P_norm[11] - P_norm[8] * sw * cwx - P_norm[9] * sw * cwy - P_norm[10] * sw * cwz
  ];

  // T_image_inv (3x3 for homogeneous 2D):
  // [1/si,    0, cix]
  // [   0, 1/si, ciy]
  // [   0,    0,   1]

  // T_image_inv * PT (3x4):
  var P = [
    PT[0] / si + cix * PT[8], PT[1] / si + cix * PT[9], PT[2] / si + cix * PT[10], PT[3] / si + cix * PT[11],
    PT[4] / si + ciy * PT[8], PT[5] / si + ciy * PT[9], PT[6] / si + ciy * PT[10], PT[7] / si + ciy * PT[11],
    PT[8], PT[9], PT[10], PT[11]
  ];

  return P;
}

/**
 * Solve the DLT system for projection matrix.
 * A is 2n x 12, we solve for p (12 elements) with constraint p[11] = 1.
 */
function solveDLT(A) {
  var rows = A.length;

  // We have Ap = 0 with p[11] = 1
  // Rearrange: A[:, 0:11] * p[0:11] = -A[:, 11]
  var Aprime = [];
  var b = [];

  for (var i = 0; i < rows; i++) {
    Aprime.push(A[i].slice(0, 11));
    b.push(-A[i][11]);
  }

  // Solve overdetermined system using normal equations: (A'^T A') p' = A'^T b
  var At = transpose(Aprime);
  var AtA = matMul(At, Aprime);
  var Atb = matVecMul(At, b);

  var p11 = solveLinearSystemNxN(AtA, Atb);
  if (!p11) {
    return null;
  }

  // Append p[11] = 1
  p11.push(1);
  return p11;
}

/**
 * Matrix transpose.
 */
function transpose(A) {
  var rows = A.length;
  var cols = A[0].length;
  var T = [];

  for (var j = 0; j < cols; j++) {
    var row = [];
    for (var i = 0; i < rows; i++) {
      row.push(A[i][j]);
    }
    T.push(row);
  }

  return T;
}

/**
 * Matrix multiplication A * B.
 */
function matMul(A, B) {
  var rowsA = A.length;
  var colsA = A[0].length;
  var colsB = B[0].length;
  var C = [];

  for (var i = 0; i < rowsA; i++) {
    var row = [];
    for (var j = 0; j < colsB; j++) {
      var sum = 0;
      for (var k = 0; k < colsA; k++) {
        sum += A[i][k] * B[k][j];
      }
      row.push(sum);
    }
    C.push(row);
  }

  return C;
}

/**
 * Matrix-vector multiplication A * v.
 */
function matVecMul(A, v) {
  var result = [];
  for (var i = 0; i < A.length; i++) {
    var sum = 0;
    for (var j = 0; j < v.length; j++) {
      sum += A[i][j] * v[j];
    }
    result.push(sum);
  }
  return result;
}

/**
 * Solve 3x3 linear system using Cramer's rule (for triangulation).
 */
function solveLinearSystem3x3(A, b) {
  var det = determinant3x3(A);
  if (Math.abs(det) < 1e-12) {
    return null;
  }

  var x = [];
  for (var col = 0; col < 3; col++) {
    // Replace column 'col' of A with b
    var Acopy = [];
    for (var i = 0; i < 3; i++) {
      var row = [];
      for (var j = 0; j < 3; j++) {
        row.push(j === col ? b[i] : A[i][j]);
      }
      Acopy.push(row);
    }
    x.push(determinant3x3(Acopy) / det);
  }

  return x;
}

/**
 * 3x3 determinant.
 */
function determinant3x3(A) {
  return (
    A[0][0] * (A[1][1] * A[2][2] - A[1][2] * A[2][1]) -
    A[0][1] * (A[1][0] * A[2][2] - A[1][2] * A[2][0]) +
    A[0][2] * (A[1][0] * A[2][1] - A[1][1] * A[2][0])
  );
}

/**
 * Solve NxN linear system using Gaussian elimination with partial pivoting.
 */
function solveLinearSystemNxN(A, b) {
  var n = A.length;

  // Create augmented matrix
  var aug = [];
  for (var i = 0; i < n; i++) {
    var row = A[i].slice();
    row.push(b[i]);
    aug.push(row);
  }

  // Forward elimination with partial pivoting
  for (var col = 0; col < n; col++) {
    // Find pivot
    var maxRow = col;
    var maxVal = Math.abs(aug[col][col]);
    for (var row = col + 1; row < n; row++) {
      if (Math.abs(aug[row][col]) > maxVal) {
        maxVal = Math.abs(aug[row][col]);
        maxRow = row;
      }
    }

    // Swap rows
    if (maxRow !== col) {
      var temp = aug[col];
      aug[col] = aug[maxRow];
      aug[maxRow] = temp;
    }

    // Check for singular matrix
    if (Math.abs(aug[col][col]) < 1e-12) {
      return null;
    }

    // Eliminate column
    for (var row = col + 1; row < n; row++) {
      var factor = aug[row][col] / aug[col][col];
      for (var j = col; j <= n; j++) {
        aug[row][j] -= factor * aug[col][j];
      }
    }
  }

  // Back substitution
  var x = new Array(n);
  for (var i = n - 1; i >= 0; i--) {
    var sum = aug[i][n];
    for (var j = i + 1; j < n; j++) {
      sum -= aug[i][j] * x[j];
    }
    x[i] = sum / aug[i][i];
  }

  return x;
}
