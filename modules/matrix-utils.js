/**
 * matrix-utils.js
 * 小型矩阵工具集，专为坐标参数变换最小二乘平差设计
 * 无外部依赖，处理小矩阵（控制点数通常 < 50）
 */

const MatrixUtils = (() => {

  /** 创建 m×n 零矩阵 */
  function zeros(m, n) {
    return Array.from({ length: m }, () => new Array(n).fill(0));
  }

  /** 矩阵转置 */
  function transpose(A) {
    const m = A.length, n = A[0].length;
    const T = zeros(n, m);
    for (let i = 0; i < m; i++)
      for (let j = 0; j < n; j++)
        T[j][i] = A[i][j];
    return T;
  }

  /** 矩阵乘法 A(m×k) × B(k×n) → C(m×n) */
  function multiply(A, B) {
    const m = A.length, k = A[0].length, n = B[0].length;
    if (k !== B.length) throw new Error(`矩阵维度不匹配: (${m}×${k}) × (${B.length}×${n})`);
    const C = zeros(m, n);
    for (let i = 0; i < m; i++)
      for (let j = 0; j < n; j++)
        for (let p = 0; p < k; p++)
          C[i][j] += A[i][p] * B[p][j];
    return C;
  }

  /** 矩阵与向量相乘 A(m×n) × v(n) → w(m) */
  function multiplyVec(A, v) {
    return A.map(row => row.reduce((s, a, j) => s + a * v[j], 0));
  }

  /**
   * 高斯消元求解线性方程组 Ax = b
   * A: n×n，b: n×1 列向量（数组）
   * 返回 x 数组，若奇异则 throw
   */
function solve(A, b) {
  const n = A.length;
  if (!A.length || A[0].length !== n) throw new Error(`solve: 期望 ${n}×${n} 矩阵`);
  if (b.length !== n) throw new Error(`solve: b 长度 ${b.length} 与矩阵阶数 ${n} 不符`);

  const M = A.map((row, i) => [...row, b[i]]);

  // 记录初始对角元量级，用于相对奇异判断
  let pivotScale = 0;
  for (let i = 0; i < n; i++) pivotScale = Math.max(pivotScale, Math.abs(M[i][i]));

  for (let col = 0; col < n; col++) {
    // 列主元选取
    let maxRow = col;
    for (let row = col + 1; row < n; row++)
      if (Math.abs(M[row][col]) > Math.abs(M[maxRow][col])) maxRow = row;
    [M[col], M[maxRow]] = [M[maxRow], M[col]];

    if (Math.abs(M[col][col]) < 1e-14 * (pivotScale || 1))
      throw new Error('矩阵奇异，方程组无唯一解');

    // 归一化主元行（FIX BUG-1：使对角元精确为 1）
    const pivot = M[col][col];
    for (let j = col; j <= n; j++) M[col][j] /= pivot;

    // 消去本列其他行
    for (let row = 0; row < n; row++) {
      if (row === col) continue;
      const factor = M[row][col];
      for (let j = col; j <= n; j++) M[row][j] -= factor * M[col][j];
    }
  }

  // 全消元后对角线精确为 1，直接取增广列（FIX BUG-1）
  return M.map(row => row[n]);
}
  /**
   * 最小二乘平差：给定超定方程 Ax ≈ b
   * 法方程：AᵀAx = Aᵀb
   * 返回 { x: 参数向量, residuals: 残差向量, rmse: 中误差 }
   */
function leastSquares(A, b) {
  const AT  = transpose(A);
  const ATA = multiply(AT, A);
  const ATb = multiplyVec(AT, b);
  const x   = solve(ATA, ATb);
  const Ax  = multiplyVec(A, x);
  const residuals = b.map((bi, i) => bi - Ax[i]);

  const obsCount = b.length, paramCount = x.length;
  const dof = obsCount - paramCount;  // 多余观测数（FIX BUG-2）

  const rmse = dof > 0
    ? Math.sqrt(residuals.reduce((s, r) => s + r * r, 0) / dof)
    : 0;  // 零自由度无统计意义，返回 0 而非虚假精度

  return { x, residuals, rmse, dof };
}
 


  /** 单位矩阵 */
  function eye(n) {
    const I = zeros(n, n);
    for (let i = 0; i < n; i++) I[i][i] = 1;
    return I;
  }

  return { zeros, transpose, multiply, multiplyVec, solve, leastSquares, eye };
})();
