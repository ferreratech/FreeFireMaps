// Least-squares affine solver + a small 3x3 style transform stored as 6 coeffs.
// X' = m0*x + m1*y + m2 ;  Y' = m3*x + m4*y + m5

export type Affine = [number, number, number, number, number, number];

export function applyAffine(t: Affine, x: number, y: number): [number, number] {
  return [t[0] * x + t[1] * y + t[2], t[3] * x + t[4] * y + t[5]];
}

/**
 * Solve the affine that best maps src points -> dst points (least squares).
 * Needs >= 3 non-collinear point pairs; with the 4 GeoPDF corners it is
 * over-determined and the residual is ~0 because the mapping is truly affine
 * in projected (UTM) space.
 */
export function solveAffine(src: [number, number][], dst: [number, number][]): Affine {
  const n = src.length;
  // Normal equations for [x y 1] * [c0 c1 c2]^T = dst_component
  // Build A^T A (3x3) and A^T b for each output component.
  let Sxx = 0, Sxy = 0, Sx = 0, Syy = 0, Sy = 0;
  let bX0 = 0, bX1 = 0, bX2 = 0; // A^T * dstX
  let bY0 = 0, bY1 = 0, bY2 = 0; // A^T * dstY
  for (let i = 0; i < n; i++) {
    const [x, y] = src[i];
    const [u, v] = dst[i];
    Sxx += x * x; Sxy += x * y; Sx += x; Syy += y * y; Sy += y;
    bX0 += x * u; bX1 += y * u; bX2 += u;
    bY0 += x * v; bY1 += y * v; bY2 += v;
  }
  // Symmetric 3x3 matrix ATA
  const M = [
    [Sxx, Sxy, Sx],
    [Sxy, Syy, Sy],
    [Sx, Sy, n],
  ];
  const cX = solve3(M, [bX0, bX1, bX2]);
  const cY = solve3(M, [bY0, bY1, bY2]);
  return [cX[0], cX[1], cX[2], cY[0], cY[1], cY[2]];
}

/** Solve a 3x3 linear system by Gaussian elimination with partial pivoting. */
function solve3(Ain: number[][], bin: number[]): [number, number, number] {
  const A = Ain.map((r) => r.slice());
  const b = bin.slice();
  for (let col = 0; col < 3; col++) {
    let piv = col;
    for (let r = col + 1; r < 3; r++) if (Math.abs(A[r][col]) > Math.abs(A[piv][col])) piv = r;
    [A[col], A[piv]] = [A[piv], A[col]];
    [b[col], b[piv]] = [b[piv], b[col]];
    const d = A[col][col];
    for (let r = 0; r < 3; r++) {
      if (r === col) continue;
      const factor = A[r][col] / d;
      for (let c = col; c < 3; c++) A[r][c] -= factor * A[col][c];
      b[r] -= factor * b[col];
    }
  }
  return [b[0] / A[0][0], b[1] / A[1][1], b[2] / A[2][2]];
}
