/**
 * Minimal linear algebra helpers (single-camera pipeline).
 */

/**
 * Solve an NxN linear system Ax = b using Gaussian elimination with partial pivoting.
 *
 * @param {number[][]} A
 * @param {number[]} b
 * @returns {number[]|null}
 */
export function solveLinearSystem(A, b) {
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
    for (var r = col + 1; r < n; r++) {
      var factor = aug[r][col] / aug[col][col];
      for (var j = col; j <= n; j++) {
        aug[r][j] -= factor * aug[col][j];
      }
    }
  }

  // Back substitution
  var x = new Array(n);
  for (var k = n - 1; k >= 0; k--) {
    var sum = aug[k][n];
    for (var c = k + 1; c < n; c++) {
      sum -= aug[k][c] * x[c];
    }
    x[k] = sum / aug[k][k];
  }

  return x;
}

