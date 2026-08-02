/*!
 * export-worker.js — 批量导出 Worker：单张照片 解码 → 合成 → 编码
 * 由 exporter.js 以 ES Module Worker 方式创建。
 * 水印合成复用 render.js 的唯一实现（drawWatermark），与预览完全一致。
 */

import { drawWatermark } from './render.js';

/** 本 worker 持有的水印素材位图池：presetId → ImageBitmap（init-mark 注入，进程内常驻） */
const markPool = new Map();
let marksExpected = 0;
let marksReady = 0;

self.onmessage = async (ev) => {
  const msg = ev.data;
  if (msg.type === 'init-mark') {
    // 素材以结构化克隆到达（主线程保留原件），每个 preset 一份
    marksExpected = msg.expected;
    markPool.set(msg.id, msg.bitmap);
    marksReady++;
    if (marksReady >= marksExpected) {
      self.postMessage({ type: 'mark-ready' });
    }
    return;
  }
  if (msg.type === 'render') {
    await handleRender(msg);
    return;
  }
};

/**
 * 处理单张照片：解码（尊重 EXIF 方向）→ 可选长边缩放 → 合成水印 → 编码回传。
 * 内存纪律：照片位图用完立即 close；同一张照片在此只保留一份全尺寸解码。
 */
async function handleRender(msg) {
  const { id, file, settings, presetId, resizeLongEdge, mime, quality } = msg;
  const mark = markPool.get(presetId);
  if (!mark) {
    self.postMessage({ type: 'error', id, message: '水印素材未就绪：' + presetId });
    return;
  }
  let src = null;
  try {
    src = await createImageBitmap(file, { imageOrientation: 'from-image' });
    let w = src.width;
    let h = src.height;
    // 长边缩放（设置 > 0 且长边超限时）
    if (resizeLongEdge > 0) {
      const longest = Math.max(w, h);
      if (longest > resizeLongEdge) {
        const k = resizeLongEdge / longest;
        w = Math.max(1, Math.round(w * k));
        h = Math.max(1, Math.round(h * k));
      }
    }
    const canvas = new OffscreenCanvas(w, h);
    const ctx = canvas.getContext('2d');
    ctx.drawImage(src, 0, 0, w, h);
    // 合成水印：照片铺满画布 = 照片坐标系，与预览共用同一份数学
    drawWatermark(ctx, w, h, mark, settings);
    const blob = await canvas.convertToBlob({
      type: mime,
      quality: mime === 'image/jpeg' ? quality : undefined,
    });
    src.close();
    src = null;
    // Blob 可结构化克隆但不可 transfer， transfer 列表只能放 ArrayBuffer/ImageBitmap 等
    self.postMessage({ type: 'done', id, blob });
  } catch (err) {
    if (src) src.close();
    self.postMessage({ type: 'error', id, message: String((err && err.message) || err) });
  }
}
