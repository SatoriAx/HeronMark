/*!
 * render.js — 鹭印水印合成数学（唯一实现）
 *
 * 主线程预览与 Worker 导出共用这一份绘制逻辑，禁止在别处另写一套。
 * 本文件无任何 DOM 依赖：主线程直接 import；export-worker.js 以 ES Module 方式 import。
 *
 * 坐标系约定：照片坐标系 = 原点在照片左上角，1 单位 = 1 照片像素。
 * 预览时主线程先把 ctx 变换到照片 fit 区域（translate + scale），
 * 导出时 Worker 直接把照片铺满离屏画布，两者调用的是同一份数学。
 */

/**
 * 计算水印在照片坐标系中的布局（位置 / 尺寸 / 旋转 / 发光参数）。
 * 锚点定基准：边距 = 照片短边 × 3%；再叠加 offsetX / offsetY（照片宽/高的千分比，-500~+500）。
 * 旋转绕水印中心；发光 blur = 水印宽 × glowStrength/100 × 0.06。
 *
 * @param {number} photoW 照片宽（px）
 * @param {number} photoH 照片高（px）
 * @param {number} markW 水印素材原始宽（px）
 * @param {number} markH 水印素材原始高（px）
 * @param {object} s 生效设置（至少含 anchor/offsetX/offsetY/sizePct/rotation/glow/glowStrength）
 * @returns {{x:number,y:number,w:number,h:number,angle:number,cx:number,cy:number,blur:number}}
 *   x/y 为未旋转时水印左上角；cx/cy 为水印中心；angle 为弧度；blur 为发光模糊半径（0 表示关闭发光）。
 */
export function computeMarkLayout(photoW, photoH, markW, markH, s) {
  // 水印宽 = 照片宽 × sizePct%，高按素材原始纵横比（程序内读图自适应，勿硬编码）
  const w = photoW * (s.sizePct ?? 15) / 100;
  const h = w * markH / markW;
  const margin = Math.min(photoW, photoH) * 0.03;
  const anchor = s.anchor || 'bc';
  const row = anchor[0]; // 't' | 'c' | 'b'
  const col = anchor[1]; // 'l' | 'c' | 'r'
  const photoCx = photoW / 2;
  const photoCy = photoH / 2;
  let x;
  if (col === 'l') x = margin;
  else if (col === 'r') x = photoW - margin - w;
  else x = photoCx - w / 2;
  let y;
  if (row === 't') y = margin;
  else if (row === 'b') y = photoH - margin - h;
  else y = photoCy - h / 2;
  // 偏移：单位 = 照片宽/高的千分数
  x += photoW * (s.offsetX || 0) / 1000;
  y += photoH * (s.offsetY || 0) / 1000;
  const angle = (s.rotation || 0) * Math.PI / 180;
  const blur = s.glow ? w * (s.glowStrength || 0) / 100 * 0.06 : 0;
  return { x, y, w, h, angle, cx: x + w / 2, cy: y + h / 2, blur };
}

/**
 * 在照片坐标系中绘制水印。调用方需已把 ctx 变换到照片坐标系。
 * 不透明度用 globalAlpha；发光用 shadowBlur（白色，绕水印中心旋转后绘制）。
 *
 * @param {CanvasRenderingContext2D|OffscreenCanvasRenderingContext2D} ctx
 * @param {number} photoW 照片宽（px）
 * @param {number} photoH 照片高（px）
 * @param {ImageBitmap|HTMLImageElement} mark 水印素材
 * @param {object} s 生效设置
 */
export function drawWatermark(ctx, photoW, photoH, mark, s) {
  const L = computeMarkLayout(photoW, photoH, mark.width, mark.height, s);
  if (L.w <= 0 || L.h <= 0) return;
  ctx.save();
  ctx.translate(L.cx, L.cy);
  ctx.rotate(L.angle);
  ctx.globalAlpha = (s.opacity ?? 100) / 100;
  if (L.blur > 0) {
    ctx.shadowColor = 'rgba(255, 255, 255, 1)';
    ctx.shadowBlur = L.blur;
    ctx.shadowOffsetX = 0;
    ctx.shadowOffsetY = 0;
  } else {
    ctx.shadowBlur = 0;
  }
  // 以中心为原点绘制，旋转自然绕中心
  ctx.drawImage(mark, -L.w / 2, -L.h / 2, L.w, L.h);
  ctx.restore();
}

/**
 * 命中检测：判断照片坐标系内一点是否落在水印（含旋转）包围盒内。
 * 包围盒取旋转后四角的轴对齐外接矩形，再外扩 pad 像素（默认 20，便于抓取）。
 *
 * @param {number} px 点击点 x（照片坐标）
 * @param {number} py 点击点 y（照片坐标）
 * @param {number} photoW 照片宽
 * @param {number} photoH 照片高
 * @param {number} markW 水印素材原始宽
 * @param {number} markH 水印素材原始高
 * @param {object} s 生效设置
 * @param {number} [pad=20] 外扩冗余像素
 * @returns {boolean}
 */
export function hitTestMark(px, py, photoW, photoH, markW, markH, s, pad = 20) {
  const L = computeMarkLayout(photoW, photoH, markW, markH, s);
  const cos = Math.cos(L.angle);
  const sin = Math.sin(L.angle);
  const xs = [];
  const ys = [];
  // 水印矩形四角（相对中心），逐角旋转后取 AABB
  for (const [dx, dy] of [[-L.w / 2, -L.h / 2], [L.w / 2, -L.h / 2], [L.w / 2, L.h / 2], [-L.w / 2, L.h / 2]]) {
    xs.push(L.cx + dx * cos - dy * sin);
    ys.push(L.cy + dx * sin + dy * cos);
  }
  const minX = Math.min(...xs) - pad;
  const maxX = Math.max(...xs) + pad;
  const minY = Math.min(...ys) - pad;
  const maxY = Math.max(...ys) + pad;
  return px >= minX && px <= maxX && py >= minY && py <= maxY;
}

/**
 * 在照片 fit 区域上绘制「建议避让」虚线幽灵框（DESIGN.md §7.6）。
 * 调用方需已把 ctx 变换到照片坐标系（translate 到 fit.x/fit.y 并 scale fit.k）。
 * photoRect 为 renderPreview 返回的 fit 矩形（CSS 像素，k = 照片像素 → CSS 像素缩放），
 * 用于反推照片像素尺寸；水印落点用 computeMarkLayout 计算（与实水印同一份数学）。
 * 白色虚线、50% 透明；线宽与虚线长度换算回照片坐标，保证不同缩放比下视觉一致。
 *
 * @param {CanvasRenderingContext2D} ctx 已变换到照片坐标系的画布上下文
 * @param {{x:number,y:number,w:number,h:number,k:number}|null} photoRect 照片 fit 矩形（CSS 像素）
 * @param {number} markW 水印素材原始宽（px）
 * @param {number} markH 水印素材原始高（px）
 * @param {object} s 建议设置（至少含 anchor/offsetX/offsetY/sizePct）
 */
export function drawAvoidGhost(ctx, photoRect, markW, markH, s) {
  if (!photoRect || !(photoRect.k > 0)) return;
  const photoW = photoRect.w / photoRect.k;
  const photoH = photoRect.h / photoRect.k;
  const L = computeMarkLayout(photoW, photoH, markW, markH, s);
  if (L.w <= 0 || L.h <= 0) return;
  const k = photoRect.k;
  ctx.save();
  ctx.translate(L.cx, L.cy);
  ctx.rotate(L.angle);
  ctx.strokeStyle = 'rgba(255, 255, 255, 0.5)';
  ctx.lineWidth = Math.max(0.5, 1.5 / k);
  ctx.setLineDash([8 / k, 6 / k]);
  ctx.strokeRect(-L.w / 2, -L.h / 2, L.w, L.h);
  ctx.restore();
}

/**
 * 计算照片在画布内 fit 显示的矩形（CSS 像素）。
 * k = 缩放比例（照片像素 → CSS 像素）；userScale 为额外缩放（滚轮/缩放按钮），默认 1。
 *
 * @param {number} canvasW 画布 CSS 宽
 * @param {number} canvasH 画布 CSS 高
 * @param {number} photoW 照片宽
 * @param {number} photoH 照片高
 * @param {number} [userScale=1] 额外缩放因子
 * @returns {{x:number,y:number,w:number,h:number,k:number}}
 */
export function computeFitRect(canvasW, canvasH, photoW, photoH, userScale = 1) {
  const fit = Math.min(canvasW / photoW, canvasH / photoH);
  const k = fit * userScale;
  const w = photoW * k;
  const h = photoH * k;
  return { x: (canvasW - w) / 2, y: (canvasH - h) / 2, w, h, k };
}

/**
 * 完整绘制一帧预览：透明背景（露出舞台的 CSS 渐变）+ fit 照片 + 水印。
 * 画布需已按 devicePixelRatio 设置尺寸并 setTransform(dpr,0,0,dpr,0,0)（本函数不处理 dpr）。
 * 设置对象需额外携带 userScale 字段控制缩放。
 *
 * @param {CanvasRenderingContext2D} ctx
 * @param {number} canvasW 画布 CSS 宽
 * @param {number} canvasH 画布 CSS 高
 * @param {ImageBitmap} photo 照片位图（已解码全尺寸）
 * @param {ImageBitmap} mark 水印素材位图
 * @param {object} s 生效设置（含 userScale）
 * @returns {null | {x,y,w,h,k}} 照片 fit 矩形（拖拽坐标换算用）；无照片时返回 null
 */
export function renderPreview(ctx, canvasW, canvasH, photo, mark, s) {
  ctx.clearRect(0, 0, canvasW, canvasH);
  if (!photo) return null;
  const fit = computeFitRect(canvasW, canvasH, photo.width, photo.height, s.userScale || 1);
  // 视野平移（放大后拖拽照片移动视野），fit 矩形整体偏移
  fit.x += (s.viewX || 0);
  fit.y += (s.viewY || 0);
  ctx.drawImage(photo, fit.x, fit.y, fit.w, fit.h);
  if (mark) {
    ctx.save();
    ctx.translate(fit.x, fit.y);
    ctx.scale(fit.k, fit.k);
    drawWatermark(ctx, photo.width, photo.height, mark, s);
    ctx.restore();
  }
  return fit;
}
