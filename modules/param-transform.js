/**
 * param-transform.js — 坐标变换参数反算模块
 *
 * 功能：
 *   给定若干组公共点坐标（源系 → 目标系），
 *   用最小二乘法反算：
 *     · 四参数（2D Helmert）：Tx, Ty, θ, m
 *     · 七参数（3D Helmert / Bursa-Wolf，SVD 质心法）：Tx, Ty, Tz, ωx, ωy, ωz, m
 *
 * 依赖：ml-matrix（ml-matrix.umd.js，本地文件，全局变量 mlMatrix）
 *   使用到的类：Matrix, LuDecomposition, SingularValueDecomposition
 *
 * 修复记录：
 *   1. 四参数平移还原：增加残差均值精化，消除大坐标下 a/b 误差放大（~1e-4m → ~1e-10m）
 *   2. 零自由度警告：redundancy=0 时 UI 层展示警告，避免用户误信无意义的"零残差"
 *   3. fmtMatrix：按数值物理含义分段精度，替代一律15位的做法
 *   4. 七参数旋转角：补充语义注释，说明 log映射 vs 线性近似的适用范围
 *   5. parsePointText 去重：O(n²) splice 改为 Map，避免大数据集卡顿
 *
 * 本次修复（v2）：
 *   FIX-A  calcFourParams：零自由度时跳过残差精化，避免残差被人工归零掩盖真实误差
 *   FIX-B  calcSevenParams：varP=0（点集退化/所有点重合）时提前抛出有意义的错误
 *   FIX-C  calcSevenParams：兼容 ml-matrix 不同版本的 SVD 奇异值字段名
 *          （svd.diagonal / svd.singularValues，两者均尝试，均缺失则报错）
 *   FIX-D  fmtMatrix：排除大整数坐标被当作齐次"1"显示为无小数形式的误判
 *          （原 Number.isInteger 条件改为仅对 {-1,0,1} 三个值生效）
 *   FIX-E  exportReport：Safari 兼容——将 <a> append 到 DOM 后再 click，再移除
 *   FIX-F  七参数入口防御：确认传入点集含有效 z 字段，防止四参数结果被意外传入
 */
const ParamTransform = (() => {

    // ════════════════════════════════════════════════════════════
    //  线代工具：从全局 mlMatrix 中解构
    // ════════════════════════════════════════════════════════════
    function getLinAlg() {
        if (typeof mlMatrix === 'undefined') {
            throw new Error('依赖缺失：请确认 ml-matrix.umd.js 已在本页面加载');
        }
        const { Matrix, LuDecomposition, SingularValueDecomposition } = mlMatrix;
        return { Matrix, LuDecomposition, SingularValueDecomposition };
    }

    // ════════════════════════════════════════════════════════════
    //  数值格式化
    // ════════════════════════════════════════════════════════════

    /** 普通参数值，固定小数位 */
    const fmt = (v, d = 6) => (typeof v === 'number' ? v.toFixed(d) : '—');

    /**
     * 矩阵元素自适应精度格式化。
     *
     * 按数值量级分段，而非一律15位：
     *   结构整数（仅 -1 / 0 / 1）  → 直接显示整数，避免 "1.000000000000"
     *   |v| < 1e-9                 → 视为结构零，显示 "0"
     *   |v| >= 1e3（平移量）       → 6位小数（微米级，超出坐标量测精度上限）
     *   |v| <= 2（旋转分量）       → 10位小数（双精度旋转矩阵有效位约14位，10位已足够）
     *   其余（尺度≈1等）           → 12位小数（捕获 ppm 级尺度差）
     *
     * FIX-D：原条件 Number.isInteger(v) 会把 1000.0、-2.0 等大整数值误判为
     *   "结构整数"，导致平移量丢失小数部分。现限定为仅 {-1, 0, 1} 触发整数显示。
     */
    function fmtMatrix(v) {
        if (typeof v !== 'number' || !Number.isFinite(v)) return '—';

        // 齐次矩阵中的结构整数（仅 -1、0、1，不含其他整数坐标值）
        if (v === 0 || v === 1 || v === -1) return String(v);

        const abs = Math.abs(v);

        // 浮点误差残留的零
        if (abs < 1e-9) return '0';

        // 平移量级：6位小数 = 微米，已超测量精度上限
        if (abs >= 1e3) return v.toFixed(6);

        // 旋转矩阵分量，值域 [-1, 1]
        if (abs <= 2) return v.toFixed(10);

        // 尺度（≈1）或其他中间量级
        return v.toFixed(12);
    }

    // ════════════════════════════════════════════════════════════
    //  核心算法
    // ════════════════════════════════════════════════════════════

    /**
     * 四参数反算（2D Helmert）—— 质心化正规方程 + 平移精化
     *
     * 模型：X' = a·X - b·Y + Tx，Y' = b·X + a·Y + Ty
     *   其中 a = m·cosθ，b = m·sinθ
     *
     * 精度改进 1（质心化）：
     *   先将源/目标坐标平移到各自质心，在质心坐标系下求 [a, b]。
     *   正规方程 AtA 的对角元从 ~坐标²（~1e12）降至 ~坐标方差，条件数改善约6个数量级。
     *
     * 精度改进 2（平移精化）：
     *   从质心关系还原 Tx0/Ty0 后，用残差均值做一次精化。
     *   精化量 δT 只有 1e-4~1e-6 m 量级，不再经过大坐标乘法，
     *   使平移精度从 ~1e-4m 提升至双精度极限 ~1e-10m。
     *
     * FIX-A：零自由度（n=2）时跳过残差均值精化。
     *   原因：精化量 dTx = Σ残差 / n，当 redundancy=0 时该量恰好等于全部残差之和除以 n，
     *   精化后残差被完全吸收为零，rmse 显示 0.000000 m，给用户"完美拟合"的错误印象。
     *   零自由度下无法检核，rmse 本就无统计意义，不做精化更诚实。
     */
    function calcFourParams(srcPts, dstPts) {
        const n = srcPts.length;
        if (n < 2) throw new Error('四参数解算至少需要 2 组公共点');

        const { Matrix, LuDecomposition } = getLinAlg();

        // ── 质心 ──────────────────────────────────────────────────
        let cSx = 0, cSy = 0, cDx = 0, cDy = 0;
        for (const { x, y } of srcPts) { cSx += x; cSy += y; }
        for (const { x, y } of dstPts) { cDx += x; cDy += y; }
        cSx /= n; cSy /= n; cDx /= n; cDy /= n;

        // ── 质心坐标系下的误差方程 ────────────────────────────────
        const Arows = [], Lvals = [];
        for (let i = 0; i < n; i++) {
            const xc = srcPts[i].x - cSx, yc = srcPts[i].y - cSy;
            const Xc = dstPts[i].x - cDx, Yc = dstPts[i].y - cDy;
            Arows.push([xc, -yc]); Lvals.push(Xc);
            Arows.push([yc, xc]); Lvals.push(Yc);
        }

        const mA = new Matrix(Arows);
        const mAt = mA.transpose();
        const lu = new LuDecomposition(mAt.mmul(mA));
        if (lu.isSingular()) throw new Error('系数矩阵奇异，公共点配置可能存在问题（点位是否全部共线？）');

        const [a, b] = lu.solve(mAt.mmul(Matrix.columnVector(Lvals))).to1DArray();

        // ── 平移还原（+ 有多余观测时做残差均值精化）────────────────
        const Tx0 = cDx - a * cSx + b * cSy;
        const Ty0 = cDy - b * cSx - a * cSy;

        const redundancy = 2 * n - 4;

        // FIX-A：仅在有多余观测时才做精化；零自由度时精化会人工归零残差，不做。
        let Tx = Tx0, Ty = Ty0;
        if (redundancy > 0) {
            let dTx = 0, dTy = 0;
            for (let i = 0; i < n; i++) {
                dTx += dstPts[i].x - (a * srcPts[i].x - b * srcPts[i].y + Tx0);
                dTy += dstPts[i].y - (b * srcPts[i].x + a * srcPts[i].y + Ty0);
            }
            Tx = Tx0 + dTx / n;
            Ty = Ty0 + dTy / n;
        }

        const m = Math.sqrt(a * a + b * b);
        const theta = Math.atan2(b, a);
        const thetaDeg = theta * 180 / Math.PI;

        const matrix = [
            [a, -b, Tx],
            [b, a, Ty],
            [0, 0, 1],
        ];

        // ── 残差（原始坐标系）────────────────────────────────────
        const ptResiduals = [];
        let rmse2sum = 0;
        for (let i = 0; i < n; i++) {
            const { x, y } = srcPts[i];
            const { x: X, y: Y } = dstPts[i];
            const vX = X - (a * x - b * y + Tx);
            const vY = Y - (b * x + a * y + Ty);
            const vPos = Math.sqrt(vX * vX + vY * vY);
            ptResiduals.push({ vX, vY, vPos });
            rmse2sum += vX * vX + vY * vY;
        }
        const dof = 2 * n - 4;   // 即 redundancy
        const rmse = dof > 0 ? Math.sqrt(rmse2sum / dof) : 0;
        const rmsePos = dof > 0 ? Math.sqrt(rmse2sum / (dof / 2)) : 0;

        return {
            type: '四参数 (2D Helmert)',
            params: { Tx, Ty, theta, thetaDeg, m, a, b },
            matrix,
            residuals: ptResiduals,
            rmse,
            rmsePos,
            redundancy,
            zeroRedundancy: redundancy <= 0,
        };
    }

    /**
     * 七参数反算（SVD 质心法，严格旋转矩阵，无小角度限制）
     *
     * 算法：
     *   1. 质心化
     *   2. 协方差矩阵 C = (1/n) · Qc' · Pc
     *   3. SVD(C) = U · diag(S) · Vᵀ
     *   4. R = U · W · Vᵀ，W = diag(1,1,det(UVᵀ)) 保证 det(R) = +1
     *   5. s = trace(S·W) / var(P)
     *   6. t = μQ - s · R · μP
     *
     * 旋转角说明：
     *   wx/wy/wz 用旋转向量（log 映射）提取，单位弧度。
     *   大地测量常见旋转角 < 10"，此时 log 映射与线性近似误差 < 1e-10"，可忽略。
     *   若旋转角较大（> 1'），wx/wy/wz 是旋转向量分量，而非各轴独立欧拉角，请注意区分。
     *
     * FIX-B：varP=0（所有源点重合或只有1个唯一点）时提前抛出有意义的错误，
     *   而非产生 Infinity/NaN 污染后续结果并静默渲染。
     *
     * FIX-C：ml-matrix 不同版本 SVD 奇异值字段名不一致
     *   （旧版 svd.diagonal，新版 svd.singularValues），
     *   两者均尝试，均缺失则报错，避免 svals=undefined 导致 trSW=NaN 无提示失败。
     *
     * FIX-F：入口验证传入点集含有效 z 字段，防止四参数点集被意外传入。
     */
    function calcSevenParams(srcPts, dstPts) {
        const n = srcPts.length;
        if (n < 3) throw new Error('七参数解算至少需要 3 组公共点（建议 ≥ 4）');

        // FIX-F：防御性检查 z 字段，避免四参数点集误传产生 NaN 扩散
        for (let i = 0; i < n; i++) {
            if (!Number.isFinite(srcPts[i].z) || !Number.isFinite(dstPts[i].z)) {
                throw new Error(
                    `第 ${i + 1} 组点对缺少有效的 Z 坐标（z=${srcPts[i].z}）。` +
                    `七参数模式需要三维坐标，请检查输入或切换至四参数模式。`
                );
            }
        }

        const { Matrix, LuDecomposition, SingularValueDecomposition } = getLinAlg();

        // ── 质心 ──────────────────────────────────────────────────
        let muPx = 0, muPy = 0, muPz = 0, muQx = 0, muQy = 0, muQz = 0;
        for (const { x, y, z } of srcPts) { muPx += x; muPy += y; muPz += z; }
        for (const { x, y, z } of dstPts) { muQx += x; muQy += y; muQz += z; }
        muPx /= n; muPy /= n; muPz /= n;
        muQx /= n; muQy /= n; muQz /= n;

        // ── 协方差矩阵 C = (1/n) Σ qc·pcᵀ & var(P) ───────────────
        const Cdata = [[0, 0, 0], [0, 0, 0], [0, 0, 0]];
        let varP = 0;
        for (let k = 0; k < n; k++) {
            const pcx = srcPts[k].x - muPx, pcy = srcPts[k].y - muPy, pcz = srcPts[k].z - muPz;
            const qcx = dstPts[k].x - muQx, qcy = dstPts[k].y - muQy, qcz = dstPts[k].z - muQz;
            const Pc = [pcx, pcy, pcz];
            const Qc = [qcx, qcy, qcz];
            for (let i = 0; i < 3; i++)
                for (let j = 0; j < 3; j++)
                    Cdata[i][j] += Qc[i] * Pc[j] / n;
            varP += pcx * pcx + pcy * pcy + pcz * pcz;
        }
        varP /= n;

        // FIX-B：varP=0 意味着所有源点重合（或单点），SVD 无意义，尺度无法确定
        if (varP < 1e-20) {
            throw new Error(
                '源点集方差为零：所有源点坐标几乎重合，无法确定旋转和尺度。' +
                '请检查源点坐标是否正确，或确认点集包含足够的空间分布。'
            );
        }

        // ── SVD(C) ─────────────────────────────────────────────────
        const svd = new SingularValueDecomposition(new Matrix(Cdata));
        const U = svd.leftSingularVectors.to2DArray();
        const V = svd.rightSingularVectors.to2DArray();

        // FIX-C：ml-matrix 版本间字段名不一致（diagonal vs singularValues）
        //   两者均尝试；若均不可用则抛出明确错误，避免 NaN 静默扩散。
        const svals = Array.isArray(svd.diagonal)
            ? svd.diagonal
            : Array.isArray(svd.singularValues)
                ? svd.singularValues
                : null;
        if (!svals) {
            throw new Error(
                'ml-matrix SVD 接口异常：无法读取奇异值（尝试了 .diagonal 和 .singularValues）。' +
                '请确认 ml-matrix 版本兼容性。'
            );
        }

        // ── R = U · W · Vᵀ（W 保证 det = +1）─────────────────────
        const mU = new Matrix(U);
        const mVt = new Matrix(V).transpose();
        const UVt = mU.mmul(mVt);
        const detUVt = new LuDecomposition(UVt).determinant;
        const wDiag = [1, 1, detUVt < 0 ? -1 : 1];
        const R = mU.mmul(Matrix.diag(wDiag)).mmul(mVt).to2DArray();

        // ── 尺度 & 平移 ────────────────────────────────────────────
        const trSW = svals.reduce((sum, sv, i) => sum + sv * wDiag[i], 0);
        const scale = trSW / varP;
        const dm = scale - 1;

        const RmuP = [
            R[0][0] * muPx + R[0][1] * muPy + R[0][2] * muPz,
            R[1][0] * muPx + R[1][1] * muPy + R[1][2] * muPz,
            R[2][0] * muPx + R[2][1] * muPy + R[2][2] * muPz,
        ];
        const Tx = muQx - scale * RmuP[0];
        const Ty = muQy - scale * RmuP[1];
        const Tz = muQz - scale * RmuP[2];

        // ── 齐次变换矩阵（4×4）────────────────────────────────────
        const sR = R.map(row => row.map(v => v * scale));
        const matrix4 = [
            [sR[0][0], sR[0][1], sR[0][2], Tx],
            [sR[1][0], sR[1][1], sR[1][2], Ty],
            [sR[2][0], sR[2][1], sR[2][2], Tz],
            [0, 0, 0, 1],
        ];

        // ── 旋转角（log 映射提取旋转向量）────────────────────────
        const cosTheta = Math.max(-1, Math.min(1, (R[0][0] + R[1][1] + R[2][2] - 1) / 2));
        const theta = Math.acos(cosTheta);
        let wx, wy, wz;
        if (theta < 1e-12) {
            wx = 0.5 * (R[2][1] - R[1][2]);
            wy = 0.5 * (R[0][2] - R[2][0]);
            wz = 0.5 * (R[1][0] - R[0][1]);
        } else {
            const f = theta / (2 * Math.sin(theta));
            wx = f * (R[2][1] - R[1][2]);
            wy = f * (R[0][2] - R[2][0]);
            wz = f * (R[1][0] - R[0][1]);
        }
        const toSec = r => r * 180 / Math.PI * 3600;

        // ── 残差 ──────────────────────────────────────────────────
        const ptResiduals = [];
        let rmse2sum = 0;
        for (let i = 0; i < n; i++) {
            const { x, y, z } = srcPts[i];
            const { x: X, y: Y, z: Z } = dstPts[i];
            const Xp = sR[0][0] * x + sR[0][1] * y + sR[0][2] * z + Tx;
            const Yp = sR[1][0] * x + sR[1][1] * y + sR[1][2] * z + Ty;
            const Zp = sR[2][0] * x + sR[2][1] * y + sR[2][2] * z + Tz;
            const vX = X - Xp, vY = Y - Yp, vZ = Z - Zp;
            const vPos = Math.sqrt(vX * vX + vY * vY + vZ * vZ);
            ptResiduals.push({ vX, vY, vZ, vPos });
            rmse2sum += vX * vX + vY * vY + vZ * vZ;
        }
        const dof = 3 * n - 7;   // 即 redundancy
        const rmse = dof > 0 ? Math.sqrt(rmse2sum / dof) : 0;
        const rmsePos = dof > 0 ? Math.sqrt(rmse2sum / (dof / 3)) : 0;

        const redundancy = 3 * n - 7;

        return {
            type: '七参数 (SVD 质心法)',
            params: {
                Tx, Ty, Tz,
                wx, wy, wz,
                wxSec: toSec(wx), wySec: toSec(wy), wzSec: toSec(wz),
                thetaDeg: theta * 180 / Math.PI,
                scale,
                dm,
                dmPPM: dm * 1e6,
            },
            rotMatrix: R,
            matrix4,
            residuals: ptResiduals,
            rmse,
            rmsePos,
            redundancy,
            zeroRedundancy: redundancy <= 0,
        };
    }

    // ════════════════════════════════════════════════════════════
    //  文本解析器
    // ════════════════════════════════════════════════════════════

    function parsePointText(text, label, need3D) {
        const lines = text.split(/\r?\n/);
        const points = [];
        const warnings = [];
        const seenIds = new Map();

        for (let li = 0; li < lines.length; li++) {
            const raw = lines[li];
            const trimmed = raw.trim();

            if (!trimmed) continue;
            if (trimmed.startsWith('#')) continue;

            let parts = trimmed.split(',').map(s => s.trim()).filter(s => s.length > 0);
            if (parts.length < 2) parts = trimmed.split(/\s+/);

            const id = parts[0].replaceAll('"', '').trim();
            const numParts = parts.slice(1);
            const minCols = need3D ? 3 : 2;

            if (numParts.length < minCols) {
                throw new Error(
                    `[${label}] 第 ${li + 1} 行字段不足：` +
                    `id 列之后需要至少 ${minCols} 个坐标，实际只有 ${numParts.length} 个。\n` +
                    `  → 原始内容：${raw}`
                );
            }

            const x = parseFloat(numParts[0]);
            const y = parseFloat(numParts[1]);
            if (!Number.isFinite(x)) throw new Error(`[${label}] 第 ${li + 1} 行 X 坐标无法解析："${numParts[0]}"\n  → 原始内容：${raw}`);
            if (!Number.isFinite(y)) throw new Error(`[${label}] 第 ${li + 1} 行 Y 坐标无法解析："${numParts[1]}"\n  → 原始内容：${raw}`);

            const pt = { id, x, y, _line: li + 1 };

            if (need3D) {
                const z = parseFloat(numParts[2]);
                if (!Number.isFinite(z)) throw new Error(`[${label}] 第 ${li + 1} 行 Z 坐标无法解析："${numParts[2]}"\n  → 原始内容：${raw}`);
                pt.z = z;
            } else if (numParts.length >= 3) {
                warnings.push(`[${label}] 第 ${li + 1} 行检测到 Z 列，四参数模式下已忽略`);
            }

            if (seenIds.has(id)) {
                warnings.push(`[${label}] 点号 "${id}" 重复出现，将使用后出现的值`);
                Object.assign(seenIds.get(id), pt);  // 原地覆盖，索引不变
            } else {
                points.push(pt);
                seenIds.set(id, pt);  // 存对象引用，不存索引
            }
        }

        return { points, warnings };
    }

    function matchPoints(srcPoints, dstPoints) {
        const dstMap = new Map(dstPoints.map(p => [p.id, p]));
        const srcMap = new Map(srcPoints.map(p => [p.id, p]));
        const pairs = [];
        const warnings = [];

        for (const sp of srcPoints) {
            const dp = dstMap.get(sp.id);
            if (dp) pairs.push([sp, dp]);
            else warnings.push(`源点 "${sp.id}" 在目标点集中无对应点，已跳过`);
        }
        for (const dp of dstPoints) {
            if (!srcMap.has(dp.id)) warnings.push(`目标点 "${dp.id}" 在源点集中无对应点，已跳过`);
        }

        return { pairs, warnings };
    }

    // ════════════════════════════════════════════════════════════
    //  UI 渲染
    // ════════════════════════════════════════════════════════════

    function render(container) {

        const SAMPLE = {
            four: {
                src: `# id, X(源), Y(源)\npt1, 1000.000, 2000.000\npt2, 3000.000, 1000.000\npt3, 2000.000, 3000.000\npt4, 4000.000, 4000.000`,
                dst: `# id, X(目标), Y(目标)\npt1, 1100.427, 2208.734\npt2, 3101.250, 1225.189\npt3, 2099.375, 3217.281\npt4, 4098.590, 4241.834`,
            },
            seven: {
                src: `# id, X(源), Y(源), Z(源)\nA01, 3657521.0, 532342.0, 5201243.0\nA02, 3623980.0, 562843.0, 5222680.0\nA03, 3680410.0, 498230.0, 5185930.0\nA04, 3642100.0, 540180.0, 5210340.0`,
                dst: `# id, X(目标), Y(目标), Z(目标)\nA01, 3657523.4, 532344.1, 5201245.8\nA02, 3623982.5, 562845.2, 5222682.9\nA03, 3680412.6, 498232.0, 5185932.5\nA04, 3642102.4, 540182.1, 5210342.7`,
            },
        };

        container.innerHTML = `
<div class="pt-module-wrap">
  <div class="pt-header">
    <h2 class="pt-title">变换参数反算</h2>
    <p class="pt-desc">
      粘贴公共点坐标文本，用最小二乘法反算四参数（2D）或七参数（3D Bursa-Wolf）。<br>
      格式：每行 <code class="pt-code-inline">id, x, y[, z]</code>，支持逗号/制表符/空格分隔，<code class="pt-code-inline">#</code> 开头行为注释。
    </p>
  </div>
  <div class="pt-body">
    <div class="pt-panel-left">
      <div class="pt-section">
        <label class="pt-section-title">变换类型</label>
        <div class="pt-tab-group">
          <button class="pt-tab active" data-mode="four">四参数 (2D)</button>
          <button class="pt-tab" data-mode="seven">七参数 (3D)</button>
        </div>
      </div>
      <div class="pt-section">
        <div class="pt-row-between">
          <label class="pt-section-title">源坐标系点集</label>
          <button class="pt-btn-sm" data-sample="src">填入示例</button>
        </div>
        <textarea class="pt-textarea" id="pt-src-text" rows="7"
          placeholder="# id, x, y&#10;pt1, 500000.000, 3500000.000&#10;..."></textarea>
        <div class="pt-parse-status" id="pt-src-status"></div>
      </div>
      <div class="pt-section">
        <div class="pt-row-between">
          <label class="pt-section-title">目标坐标系点集</label>
          <button class="pt-btn-sm" data-sample="dst">填入示例</button>
        </div>
        <textarea class="pt-textarea" id="pt-dst-text" rows="7"
          placeholder="# id, x, y&#10;pt1, 500010.234, 3500005.678&#10;..."></textarea>
        <div class="pt-parse-status" id="pt-dst-status"></div>
      </div>
      <div id="pt-preview-section" class="pt-section" style="display:none">
        <label class="pt-section-title">点对匹配预览</label>
        <div id="pt-preview-wrap"></div>
      </div>
      <div id="pt-global-warnings" style="display:none"></div>
      <button class="pt-calc-btn" id="pt-calc-btn">计 算</button>
    </div>
    <div class="pt-panel-right" id="pt-result-panel">
      <div class="pt-result-placeholder">
        <span class="pt-placeholder-icon">⊕</span>
        <span>计算结果将在此显示</span>
      </div>
    </div>
  </div>
</div>`;

        injectStyles(container);

        let mode = 'four';
        let parsedSrc = null, parsedDst = null;

        const srcText = container.querySelector('#pt-src-text');
        const dstText = container.querySelector('#pt-dst-text');
        const srcStatus = container.querySelector('#pt-src-status');
        const dstStatus = container.querySelector('#pt-dst-status');
        const previewSec = container.querySelector('#pt-preview-section');
        const previewWrap = container.querySelector('#pt-preview-wrap');
        const globalWarn = container.querySelector('#pt-global-warnings');
        const resultPanel = container.querySelector('#pt-result-panel');

        function parseOne(text, label, statusEl) {
            statusEl.className = 'pt-parse-status';
            statusEl.textContent = '';
            if (!text.trim()) { statusEl.textContent = '（未输入）'; return null; }
            try {
                const result = parsePointText(text, label, mode === 'seven');
                const n = result.points.length;
                if (n === 0) {
                    statusEl.classList.add('pt-status-warn');
                    statusEl.textContent = '⚠ 未解析到任何有效点（请检查格式）';
                    return null;
                }
                statusEl.classList.add('pt-status-ok');
                statusEl.textContent = `✓ 解析 ${n} 个点` +
                    (result.warnings.length ? `  ⚠ ${result.warnings.join('；')}` : '');
                return result;
            } catch (e) {
                statusEl.classList.add('pt-status-err');
                statusEl.textContent = `✕ ${e.message}`;
                return null;
            }
        }

        function updatePreview() {
            parsedSrc = parseOne(srcText.value, '源', srcStatus);
            parsedDst = parseOne(dstText.value, '目标', dstStatus);
            globalWarn.style.display = previewSec.style.display = 'none';
            globalWarn.innerHTML = '';
            if (!parsedSrc || !parsedDst) return;

            const { pairs, warnings } = matchPoints(parsedSrc.points, parsedDst.points);
            if (warnings.length) {
                globalWarn.style.display = 'block';
                globalWarn.innerHTML = warnings.map(w => `<div class="pt-warn-line">⚠ ${w}</div>`).join('');
            }
            if (pairs.length === 0) {
                globalWarn.style.display = 'block';
                globalWarn.innerHTML += `<div class="pt-warn-line pt-warn-err">✕ 无有效匹配点对，请检查点号是否一致</div>`;
                return;
            }
            const is3D = mode === 'seven';
            let html = `<div class="pt-preview-count">${pairs.length} 组点对匹配成功</div>
        <div class="pt-table-wrap"><table class="pt-table">
        <thead><tr><th>点号</th><th>X源</th><th>Y源</th>${is3D ? '<th>Z源</th>' : ''}
        <th>X目标</th><th>Y目标</th>${is3D ? '<th>Z目标</th>' : ''}</tr></thead><tbody>`;
            pairs.forEach(([sp, dp]) => {
                html += `<tr><td class="pt-td-id">${sp.id}</td>
          <td>${sp.x.toFixed(3)}</td><td>${sp.y.toFixed(3)}</td>
          ${is3D ? `<td>${sp.z.toFixed(3)}</td>` : ''}
          <td>${dp.x.toFixed(3)}</td><td>${dp.y.toFixed(3)}</td>
          ${is3D ? `<td>${dp.z.toFixed(3)}</td>` : ''}</tr>`;
            });
            html += `</tbody></table></div>`;
            previewWrap.innerHTML = html;
            previewSec.style.display = 'block';
        }

        let debounceTimer = null;
        const onTextInput = () => { clearTimeout(debounceTimer); debounceTimer = setTimeout(updatePreview, 300); };
        srcText.addEventListener('input', onTextInput);
        dstText.addEventListener('input', onTextInput);

        container.querySelectorAll('[data-sample]').forEach(btn => {
            btn.addEventListener('click', () => {
                if (btn.dataset.sample === 'src') srcText.value = SAMPLE[mode].src;
                else dstText.value = SAMPLE[mode].dst;
                updatePreview();
            });
        });

        container.querySelectorAll('.pt-tab').forEach(tab => {
            tab.addEventListener('click', e => {
                container.querySelectorAll('.pt-tab').forEach(t => t.classList.remove('active'));
                e.target.classList.add('active');
                mode = e.target.dataset.mode;

                srcStatus.textContent = dstStatus.textContent = '';
                previewSec.style.display = globalWarn.style.display = 'none';
                resultPanel.innerHTML = `<div class="pt-result-placeholder">
          <span class="pt-placeholder-icon">⊕</span><span>计算结果将在此显示</span></div>`;
                if (srcText.value.trim() || dstText.value.trim()) {
                    updatePreview();
                }
            });
        });

        container.querySelector('#pt-calc-btn').addEventListener('click', () => {
            parsedSrc = parseOne(srcText.value, '源', srcStatus);
            parsedDst = parseOne(dstText.value, '目标', dstStatus);
            if (!parsedSrc || !parsedDst) {
                resultPanel.innerHTML = `<div class="pt-error">⚠ 请先修正输入错误</div>`;
                return;
            }
            try {
                const { pairs, warnings } = matchPoints(parsedSrc.points, parsedDst.points);
                if (pairs.length === 0) throw new Error('无有效匹配点对，请检查源/目标点号是否一致');
                const is3D = mode === 'seven', minPts = is3D ? 3 : 2;
                if (pairs.length < minPts)
                    throw new Error(`${is3D ? '七参数' : '四参数'}需要至少 ${minPts} 组公共点，当前仅匹配到 ${pairs.length} 组`);

                const srcPts = pairs.map(([sp]) => is3D ? { x: sp.x, y: sp.y, z: sp.z } : { x: sp.x, y: sp.y });
                const dstPts = pairs.map(([, dp]) => is3D ? { x: dp.x, y: dp.y, z: dp.z } : { x: dp.x, y: dp.y });
                const ptIds = pairs.map(([sp]) => sp.id);

                const result = is3D ? calcSevenParams(srcPts, dstPts) : calcFourParams(srcPts, dstPts);
                result.ptIds = ptIds;
                result.srcPts = srcPts;
                result.dstPts = dstPts;
                if (warnings.length) result.matchWarnings = warnings;
                renderResult(resultPanel, result, is3D);
            } catch (err) {
                resultPanel.innerHTML = `<div class="pt-error">⚠ ${err.message}</div>`;
            }
        });


        // ════════════════════════════════════════════════════════════
        //  结果渲染
        // ════════════════════════════════════════════════════════════

        function renderResult(panel, res, is3D) {
            const p = res.params;

            const paramsHtml = is3D ? `
      <table class="pt-res-table">
        <tr><th>参数</th><th>数值</th><th>说明</th></tr>
        <tr><td>Tₓ</td><td>${fmt(p.Tx, 6)} m</td><td>X 平移</td></tr>
        <tr><td>Ty</td><td>${fmt(p.Ty, 6)} m</td><td>Y 平移</td></tr>
        <tr><td>Tz</td><td>${fmt(p.Tz, 6)} m</td><td>Z 平移</td></tr>
        <tr><td>ωx</td><td>${fmt(p.wxSec, 6)}"</td><td>X 轴旋转（角秒）</td></tr>
        <tr><td>ωy</td><td>${fmt(p.wySec, 6)}"</td><td>Y 轴旋转（角秒）</td></tr>
        <tr><td>ωz</td><td>${fmt(p.wzSec, 6)}"</td><td>Z 轴旋转（角秒）</td></tr>
        <tr><td>θ</td><td>${fmt(p.thetaDeg, 8)}°</td><td>旋转总量</td></tr>
        <tr><td>s</td><td>${fmt(p.scale, 12)}</td><td>尺度比</td></tr>
        <tr><td>Δm</td><td>${fmt(p.dmPPM, 6)} ppm</td><td>尺度差</td></tr>
      </table>` : `
      <table class="pt-res-table">
        <tr><th>参数</th><th>数值</th><th>说明</th></tr>
        <tr><td>Tₓ</td><td>${fmt(p.Tx, 6)} m</td><td>X 方向平移量</td></tr>
        <tr><td>Ty</td><td>${fmt(p.Ty, 6)} m</td><td>Y 方向平移量</td></tr>
        <tr><td>θ</td><td>${fmt(p.thetaDeg, 10)}°</td><td>旋转角（度）</td></tr>
        <tr><td>θ</td><td>${fmt(p.theta * 206264.806, 6)}"</td><td>旋转角（角秒）</td></tr>
        <tr><td>m</td><td>${fmt(p.m, 12)}</td><td>尺度比（含 1）</td></tr>
        <tr><td>Δm</td><td>${fmt((p.m - 1) * 1e6, 6)} ppm</td><td>尺度差（ppm）</td></tr>
        <tr><td>a</td><td>${fmt(p.a, 12)}</td><td>m·cosθ</td></tr>
        <tr><td>b</td><td>${fmt(p.b, 12)}</td><td>m·sinθ</td></tr>
      </table>`;

            const matData = is3D ? res.matrix4 : res.matrix;
            const rowLabels = is3D ? ["X'", "Y'", "Z'", "1"] : ["X'", "Y'", "1"];
            const colLabels = is3D ? ['X', 'Y', 'Z', '1'] : ['X', 'Y', '1'];
            const matTitle = is3D ? '变换矩阵（齐次 4×4）' : '变换矩阵（齐次 3×3）';
            const matrixHtml = matrixTableHtml(matData, rowLabels, colLabels, matTitle);

            const ptIds = res.ptIds || res.residuals.map((_, i) => i + 1);
            let residHtml = `<table class="pt-res-table">
      <thead><tr><th>点号</th>
        ${is3D ? '<th>vX (m)</th><th>vY (m)</th><th>vZ (m)</th>' : '<th>vX (m)</th><th>vY (m)</th>'}
        <th>点位误差 (m)</th></tr></thead><tbody>`;
            res.residuals.forEach((r, i) => {
                residHtml += `<tr>
        <td class="pt-td-id">${ptIds[i]}</td>
        <td>${fmt(r.vX, 6)}</td><td>${fmt(r.vY, 6)}</td>
        ${is3D ? `<td>${fmt(r.vZ, 6)}</td>` : ''}
        <td>${fmt(r.vPos, 6)}</td></tr>`;
            });
            residHtml += `</tbody></table>`;

            const redundancyHtml = `<span class="pt-stat${res.zeroRedundancy ? ' pt-stat-warn' : ''}">
      <b>多余观测</b> ${res.redundancy}${res.zeroRedundancy ? ' ⚠ 无法检核' : ''}
    </span>`;

            let proj4Html = '';
            if (!is3D) {
                const towgs = `${fmt(p.Tx, 3)},${fmt(p.Ty, 3)},0,0,0,${fmt(p.thetaDeg * 3600, 6)},${fmt((p.m - 1) * 1e6, 6)}`;
                proj4Html = `
        <div class="pt-section-title">Proj4 towgs84 参考</div>
        <div class="pt-code-block" id="pt-proj4-str">+towgs84=${towgs}</div>
        <button class="pt-btn-sm" id="pt-copy-proj4">复制</button>
        <p class="pt-note">
          注：此处将平面旋转角 θ 置入 ωz，ωx/ωy 置零。仅当两坐标系旋转轴严格平行于 Z 轴时在数学上等价。
          用于 proj4/EPSG towgs84 前请核实该假设是否成立，不满足时需改用七参数。
        </p>`;
            }

            panel.innerHTML = `
            <div class="pt-result-inner">
        <div class="pt-result-type">${res.type}</div>
        <div class="pt-result-stats">
          ${redundancyHtml}
          <span class="pt-stat"><b>分量中误差</b> ${fmt(res.rmse, 6)} m</span>
          <span class="pt-stat"><b>点位中误差</b> ${fmt(res.rmsePos, 6)} m</span>
        </div>
        <div class="pt-res-section">
          <div class="pt-section-title">变换参数</div>${paramsHtml}
        </div>
        <div class="pt-res-section">${matrixHtml}</div>
        <div class="pt-res-section">
          <div class="pt-section-title">各点残差</div>${residHtml}
        </div>
        ${proj4Html ? `<div class="pt-res-section">${proj4Html}</div>` : ''}
        <div class="pt-res-section">
            <button class="pt-btn-sm" id="pt-export-txt">导出结果</button>

        </div>
      </div > `;

            const copyProj4Btn = panel.querySelector('#pt-copy-proj4');
            if (copyProj4Btn) {
                copyProj4Btn.addEventListener('click', () => {
                    navigator.clipboard.writeText(panel.querySelector('#pt-proj4-str').textContent).then(() => {
                        copyProj4Btn.textContent = '已复制 ✓';
                        setTimeout(() => { copyProj4Btn.textContent = '复制'; }, 1500);
                    });
                });
            }

            panel.querySelector('#pt-export-txt').addEventListener('click', () => exportReport(res, is3D));
        }

        function matrixTableHtml(M, rowLabels, colLabels, title) {
            let html = `<div class="pt-section-title"> ${title}</div>
            <table class="pt-matrix-table"><thead><tr><th></th>`;
            colLabels.forEach(c => { html += `<th>${c}</th>`; });
            html += `</tr></thead><tbody>`;
            M.forEach((row, i) => {
                html += `<tr><th>${rowLabels[i]}</th>`;
                row.forEach(v => { html += `<td>${fmtMatrix(v)}</td>`; });
                html += `</tr>`;
            });
            html += `</tbody></table > `;
            return html;
        }

        function exportReport(res, is3D) {
            const p = res.params;
            const line = s => s + '\n';
            let txt = '';

            txt += line('═'.repeat(60));
            txt += line('  GeoTools 变换参数反算报告');
            txt += line(`  类型：${res.type} `);
            txt += line(`  生成时间：${new Date().toLocaleString()} `);
            txt += line('═'.repeat(60));
            txt += line('');
            txt += line('【源点组】');
            txt += line('-'.repeat(60));
            
            
            let srcIdIterator = res.ptIds[Symbol.iterator]() || res.srcPts.keys();
            res.srcPts.forEach(p => txt += line(`  ${srcIdIterator.next().value}, ${p.x.toFixed(6)}, ${p.y.toFixed(6)}, ${p.z.toFixed(6)}`));
            txt += line('-'.repeat(60));
            txt += line('');
            txt += line('【目标点组】');
            txt += line('-'.repeat(60));
            
            let dstIdIterator = res.ptIds[Symbol.iterator]() || res.dstPts.keys();
            res.dstPts.forEach(p => txt += line(`  ${dstIdIterator.next().value}, ${p.x.toFixed(6)}, ${p.y.toFixed(6)}, ${p.z.toFixed(6)}`));
            txt += line('-'.repeat(60));
            txt += line('');
            txt += line('【变换参数】');
            if (!is3D) {
                txt += line(`  Tx = ${p.Tx.toFixed(6)} m`);
                txt += line(`  Ty = ${p.Ty.toFixed(6)} m`);
                txt += line(`  θ = ${p.thetaDeg.toFixed(10)}°`);
                txt += line(`  θ = ${(p.theta * 206264.806).toFixed(6)} "`);
                txt += line(`  m (尺度)  = ${p.m.toFixed(12)}`);
                txt += line(`  Δm        = ${((p.m - 1) * 1e6).toFixed(6)} ppm`);
            } else {
                txt += line(`  Tx  = ${p.Tx.toFixed(6)} m`);
                txt += line(`  Ty  = ${p.Ty.toFixed(6)} m`);
                txt += line(`  Tz  = ${p.Tz.toFixed(6)} m`);
                txt += line(`  ωx  = ${p.wxSec.toFixed(6)}"`);
                txt += line(`  ωy  = ${p.wySec.toFixed(6)}"`);
                txt += line(`  ωz  = ${p.wzSec.toFixed(6)}"`);
                txt += line(`  θ   = ${p.thetaDeg.toFixed(8)}°  (旋转总量)`);
                txt += line(`  s   = ${p.scale.toFixed(12)}  (尺度比)`);
                txt += line(`  Δm  = ${p.dmPPM.toFixed(6)} ppm`);
            }
            txt += line('');
            txt += line('【精度统计】');
            txt += line(`  多余观测数：${res.redundancy}${res.zeroRedundancy ? '（⚠ 零自由度，残差必然为零，无统计意义）' : ''}`);
            txt += line(`  坐标分量中误差：${res.rmse.toFixed(6)} m`);
            txt += line(`  点位中误差：${res.rmsePos.toFixed(6)} m`);
            txt += line('');
            txt += line('【齐次变换矩阵】');
            const mat = is3D ? res.matrix4 : res.matrix;
            txt += line('// 空格分隔:');
            txt += line('-'.repeat(78));
            mat.forEach(row => {
                txt += line(row.map(v => fmtMatrix(v).padStart(18)).join(' '));
            });
            txt += line('-'.repeat(78));
            txt += line('');
            txt += line('// 逗号分隔:');
            txt += line('-'.repeat(78));
            mat.forEach(row => {
                txt += line(row.map(v => fmtMatrix(v).padStart(18)).join(','));
            });
            txt += line('-'.repeat(78));
            txt += line('');
            
            // pdal filters 格式 
            txt += line('// PDAL Transformation filters:');
            txt += line('-'.repeat(78));
            txt += line(`{\n  "type": "filters.transformation",`);
            txt += line(`  "matrix": "${mat.flat().map(v => v.toFixed(12)).join(' ')}"\n}`);
            txt += line('-'.repeat(78));
            txt += line('');


            
            txt += line('【各点残差】');
            const ptIds = res.ptIds || res.residuals.map((_, i) => String(i + 1));
            res.residuals.forEach((r, i) => {
                const parts = [`vX=${r.vX.toFixed(6)}`, `vY=${r.vY.toFixed(6)}`];
                if (is3D) parts.push(`vZ=${r.vZ.toFixed(6)}`);
                parts.push(`|vP|=${r.vPos.toFixed(6)}`);
                txt += line(`  ${ptIds[i]}：${parts.join('  ')} m`);
            });
            txt += line('');
            txt += line('─'.repeat(60));

            const blob = new Blob([txt], { type: 'text/plain;charset=utf-8' });
            const url = URL.createObjectURL(blob);
            const a = document.createElement('a');
            a.href = url;
            a.download = `Parameters${getLocaltime()}.txt`;

            // FIX-E：Safari 要求 <a> 在 DOM 中才能触发下载；创建后 append，click，再立即移除。
            document.body.appendChild(a);
            a.click();
            document.body.removeChild(a);
            URL.revokeObjectURL(url);
        }
        // 获取本地时间表示
        function getLocaltime() {
            const now = new Date();
            const pad = (n, len = 2) => String(n).padStart(len, '0');
            return `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}` +
                `_${pad(now.getHours())}-${pad(now.getMinutes())}-${pad(now.getSeconds())}`;
        }
        // ════════════════════════════════════════════════════════════
        //  样式注入
        // ════════════════════════════════════════════════════════════

        /**
         * FIX（附带）：原实现用 document.getElementById 检测重复注入，
         * 在 Shadow DOM 场景下会跨 boundary 失效导致样式反复注入。
         * 现改为在 container 所在的 root（shadowRoot 或 document.head）上查找。
         */
        function injectStyles(container) {
            const root = container.getRootNode();
            const styleHost = (root instanceof ShadowRoot) ? root : document.head;
            if (styleHost.querySelector('#pt-styles')) return;

            const style = document.createElement('style');
            style.id = 'pt-styles';
            style.textContent = `
.pt-module-wrap { display:flex; flex-direction:column; height:100%; gap:0; }
.pt-header { padding:16px 24px 10px; border-bottom:1px solid var(--border,#2a2a3a); }
.pt-title { margin:0 0 4px; font-size:1.1rem; color:var(--accent,#7eb8f7); font-weight:600; }
.pt-desc { margin:0; font-size:.82rem; color:var(--text-muted,#888); line-height:1.5; }
.pt-code-inline { font-family:monospace; font-size:.85em; background:var(--bg-secondary,#1a1a2e); padding:1px 5px; border-radius:3px; color:var(--accent,#7eb8f7); }
.pt-body { display:flex; flex:1; min-height:0; overflow:hidden; }
.pt-panel-left { width:60%; min-width:280px; overflow-y:auto; padding:16px 18px; border-right:1px solid var(--border,#2a2a3a); display:flex; flex-direction:column; gap:14px; }
.pt-panel-right { flex:1; overflow-y:auto; padding:16px 20px; }
.pt-section { display:flex; flex-direction:column; gap:6px; }
.pt-section-title { font-size:.78rem; font-weight:600; letter-spacing:.08em; color:var(--text-muted,#888); text-transform:uppercase; }
.pt-row-between { display:flex; align-items:center; justify-content:space-between; flex-wrap:wrap; gap:6px; }
.pt-tab-group { display:flex; gap:6px; }
.pt-tab { padding:5px 18px; border-radius:4px; border:1px solid var(--border,#3a3a5a); background:transparent; color:var(--text,#ccc); cursor:pointer; font-size:.85rem; transition:all .15s; }
.pt-tab.active { background:var(--accent,#7eb8f7); color:#000; border-color:var(--accent,#7eb8f7); font-weight:600; }
.pt-btn-sm { padding:3px 10px; font-size:.78rem; border-radius:4px; border:1px solid var(--border,#3a3a5a); background:transparent; color:var(--text,#ccc); cursor:pointer; transition:all .12s; }
.pt-btn-sm:hover { border-color:var(--accent,#7eb8f7); color:var(--accent,#7eb8f7); }
.pt-calc-btn { padding:9px 0; border-radius:5px; border:none; background:var(--accent,#7eb8f7); color:#000; font-size:.95rem; font-weight:700; letter-spacing:.06em; cursor:pointer; transition:opacity .15s; }
.pt-calc-btn:hover { opacity:.85; }
.pt-textarea { width:100%; box-sizing:border-box; background:var(--bg-secondary,#12121e); color:var(--text,#ddd); border:1px solid var(--border,#2a2a3a); border-radius:4px; padding:8px 10px; font-family:monospace; font-size:.8rem; line-height:1.55; resize:vertical; outline:none; transition:border-color .15s; }
.pt-textarea:focus { border-color:var(--accent,#7eb8f7); }
.pt-textarea::placeholder { color:var(--text-muted,#444); }
.pt-parse-status { font-size:.76rem; min-height:1.2em; line-height:1.4; white-space:pre-wrap; word-break:break-all; }
.pt-status-ok { color:#4caf7d; } .pt-status-warn { color:#e8a838; } .pt-status-err { color:#f55; }
.pt-warn-line { font-size:.78rem; color:#e8a838; padding:2px 0; } .pt-warn-err { color:#f55; }
.pt-preview-count { font-size:.8rem; color:var(--text-muted,#888); margin-bottom:6px; }
.pt-table-wrap { overflow-x:auto; }
.pt-table { width:100%; border-collapse:collapse; font-size:.78rem; }
.pt-table th, .pt-table td { padding:3px 7px; border:1px solid var(--border,#2a2a3a); text-align:right; white-space:nowrap; }
.pt-table thead th { background:var(--bg-secondary,#1a1a2e); color:var(--text-muted,#888); text-align:center; }
.pt-td-id { text-align:left !important; color:var(--accent,#7eb8f7); font-family:monospace; }
.pt-result-placeholder { display:flex; flex-direction:column; align-items:center; justify-content:center; height:100%; gap:12px; color:var(--text-muted,#555); font-size:.9rem; }
.pt-placeholder-icon { font-size:2.5rem; opacity:.3; }
.pt-error { color:#f55; padding:12px; border:1px solid #f55; border-radius:6px; font-size:.88rem; white-space:pre-wrap; }
.pt-result-inner { display:flex; flex-direction:column; gap:16px; }
.pt-result-type { font-size:1rem; font-weight:700; color:var(--accent,#7eb8f7); padding-bottom:8px; border-bottom:1px solid var(--border,#2a2a3a); }
.pt-result-stats { display:flex; gap:16px; flex-wrap:wrap; font-size:.82rem; }
.pt-stat { padding:4px 10px; border-radius:4px; background:var(--bg-secondary,#1a1a2e); color:var(--text,#ccc); }
.pt-stat-warn { border:1px solid #e8a838 !important; color:#e8a838 !important; }
.pt-res-section { display:flex; flex-direction:column; gap:8px; }
.pt-res-table { width:100%; border-collapse:collapse; font-size:.8rem; }
.pt-res-table th, .pt-res-table td { padding:4px 10px; border:1px solid var(--border,#2a2a3a); text-align:right; }
.pt-res-table th { background:var(--bg-secondary,#1a1a2e); color:var(--text-muted,#888); text-align:center; }
.pt-matrix-table { border-collapse:collapse; font-size:.76rem; font-family:monospace; width:100%; }
.pt-matrix-table th, .pt-matrix-table td { padding:3px 10px; border:1px solid var(--border,#2a2a3a); text-align:right; white-space:nowrap; }
.pt-matrix-table th { background:var(--bg-secondary,#1a1a2e); color:var(--text-muted,#888); text-align:center; }
.pt-code-block { font-family:monospace; font-size:.8rem; background:var(--bg-secondary,#1a1a2e); padding:8px 12px; border-radius:4px; color:var(--accent,#7eb8f7); word-break:break-all; }
.pt-note { margin:4px 0 0; font-size:.75rem; color:var(--text-muted,#666); }
@media (max-width:760px) {
  .pt-body { flex-direction:column; }
  .pt-panel-left { width:100%; border-right:none; border-bottom:1px solid var(--border,#2a2a3a); }
}`;
            styleHost.appendChild(style);
        }
    }
    return { render };

})();
