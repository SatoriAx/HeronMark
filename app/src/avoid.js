/*!
 * avoid.js — 智能避让数学（纯函数，DESIGN.md §7.6）
 *
 * 输入 64×64 显著性热量 grid（由 detect-worker.js 产出），检查水印落点矩形内的
 * 主体热量占比，超过触发阈值则在底排候选位（bc → bl → br 抬升序列）中找低热量位置。
 * 只建议不强制：返回建议的 anchor/offsetX/offsetY，是否应用由用户点击徽章决定。
 *
 * 本文件无任何 DOM / Worker 依赖，可在 node 下直接单测。
 * 水印矩形用 render.js 的 computeMarkLayout 计算（合成数学唯一实现，禁止另写一套）。
 */

import { computeMarkLayout } from './render.js';

/** 重叠占比触发阈值：矩形内热量 / 全图热量 ≥ 6% 才进入候选搜索 */
const TRIGGER_THRESHOLD = 0.06;
/** 候选可接受阈值：重叠 < 2% 的候选优先选用 */
const TARGET_THRESHOLD = 0.02;
/** 抬升序列：锚点不变，offsetY 从 0 逐级上移的步长（‰ 照片高） */
const OFFSET_STEP = -20;
/** 抬升序列下限（‰ 照片高） */
const OFFSET_MAX = -150;
/** 候选搜索锚点顺序（尊重用户底部习惯：底中 → 左下 → 右下） */
const CANDIDATE_ANCHORS = ['bc', 'bl', 'br'];

/** 抬升序列：[0, -20, ..., -140, -150]（含精确端点） */
function liftSequence() {
  const seq = [];
  for (let o = 0; o >= OFFSET_MAX; o += OFFSET_STEP) seq.push(o);
  if (seq[seq.length - 1] !== OFFSET_MAX) seq.push(OFFSET_MAX);
  return seq;
}

/** 全图热量总和（grid 所有元素之和） */
function totalHeat(grid) {
  let sum = 0;
  for (let i = 0; i < grid.length; i++) sum += grid[i];
  return sum;
}

/**
 * 矩形覆盖的 grid 热量：遍历 64×64 全部格子，格子中心落入矩形内则累加其热量。
 * 暴力扫描 4096 格，单张分析开销远小于 5ms。
 * 矩形取 computeMarkLayout 的未旋转 x/y/w/h（rotation 默认 0，规格未要求考虑旋转）。
 *
 * @param {Float32Array} grid gridSize×gridSize 热量
 * @param {number} gridSize grid 边长（64）
 * @param {number} photoW 照片宽（px）
 * @param {number} photoH 照片高（px）
 * @param {{x:number,y:number,w:number,h:number}} rect 照片坐标系矩形
 * @returns {number} 矩形内热量
 */
function rectHeat(grid, gridSize, photoW, photoH, rect) {
  let sum = 0;
  const cellW = photoW / gridSize;
  const cellH = photoH / gridSize;
  for (let gy = 0; gy < gridSize; gy++) {
    const cy = (gy + 0.5) * cellH;
    if (cy < rect.y || cy > rect.y + rect.h) continue;
    for (let gx = 0; gx < gridSize; gx++) {
      const cx = (gx + 0.5) * cellW;
      if (cx >= rect.x && cx <= rect.x + rect.w) {
        sum += grid[gy * gridSize + gx];
      }
    }
  }
  return sum;
}

/**
 * 避让分析：当前水印落点主体热量占比 ≥ 6% 时，按 bc → bl → br 顺序、
 * 每锚点 offsetY 从 0 抬升到 -150‰，选第一个重叠 < 2% 的候选；
 * 全部不满足则取重叠最小者。
 *
 * @param {Float32Array} grid gridSize×gridSize 显著性热量（detect-worker 均值池化结果）
 * @param {number} gridSize grid 边长（64）
 * @param {number} photoW 照片宽（px）
 * @param {number} photoH 照片高（px）
 * @param {number} markW 水印素材原始宽（px）
 * @param {number} markH 水印素材原始高（px）
 * @param {object} settings 生效设置（含 anchor/offsetX/offsetY/sizePct 等，见 computeMarkLayout）
 * @returns {null | {offsetX:number, offsetY:number, anchor:string, overlapBefore:number, overlapAfter:number}}
 *   null = 无需避让；否则为建议的落点（候选 offsetX 保持当前设置的水平位置）与前后重叠占比。
 */
export function analyzeAvoidance(grid, gridSize, photoW, photoH, markW, markH, settings) {
  if (!grid || !(gridSize > 0) || !(photoW > 0) || !(photoH > 0) || !(markW > 0) || !(markH > 0)) {
    return null;
  }
  const total = totalHeat(grid);
  if (total <= 0) return null; // 无显著性热量（全黑照片等），无需避让

  // 当前设置下的重叠占比，决定是否触发
  const currentLayout = computeMarkLayout(photoW, photoH, markW, markH, settings);
  const overlapBefore = rectHeat(grid, gridSize, photoW, photoH, currentLayout) / total;
  if (overlapBefore < TRIGGER_THRESHOLD) return null;

  // 候选搜索：bc → bl → br，每锚点 offsetY 抬升序列；offsetX 保持用户水平位置
  const seq = liftSequence();
  const baseX = settings.offsetX || 0;
  let best = null;
  let bestOverlap = Infinity;
  for (const anchor of CANDIDATE_ANCHORS) {
    for (const offY of seq) {
      const cand = Object.assign({}, settings, { anchor, offsetX: baseX, offsetY: offY });
      const layout = computeMarkLayout(photoW, photoH, markW, markH, cand);
      const overlap = rectHeat(grid, gridSize, photoW, photoH, layout) / total;
      if (overlap < TARGET_THRESHOLD) {
        // 第一个满足「重叠 < 2%」的候选即命中（搜索顺序即优先级）
        return { offsetX: baseX, offsetY: offY, anchor, overlapBefore, overlapAfter: overlap };
      }
      if (overlap < bestOverlap) {
        bestOverlap = overlap;
        best = { offsetX: baseX, offsetY: offY, anchor, overlapBefore, overlapAfter: overlap };
      }
    }
  }
  // 全部候选都不满足：取重叠最小者（best 必非空，因触发时首候选已计入）
  return best;
}
