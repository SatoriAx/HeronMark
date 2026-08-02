/*!
 * detect-worker.js — U2-Netp 显著性检测 Worker（DESIGN.md §7.6）
 *
 * 主线程串行派发：一个 Worker 一次一张照片。
 * 管线：照片 File → 320×320 缩放解码（允许拉伸，检测不需要保比例）→
 *       NCHW float32 + ImageNet mean/std 归一化 → onnxruntime-web（wasm）推理 →
 *       [1,1,320,320] 输出按 5×5 均值池化为 64×64 grid → ArrayBuffer transfer 回传。
 *
 * 模型与运行时全部为本地文件（app/models、app/vendor/ort），无任何网络请求。
 */

// 验收修复：用 wasm 专用入口。webgpu 入口运行时会动态拉取未备料的 asyncify 模块（23MB），
// Phase 2 走纯 CPU wasm；Phase 2.5 升级 WebGPU 时需补齐 asyncify + jsep 全套再换回
import * as ort from '../vendor/ort/ort.wasm.min.mjs';

// 开发服务器是 python http.server，无 COOP/COEP 头 → crossOriginIsolated=false，
// SharedArrayBuffer 不可用，wasm 必须回退单线程（禁止假设多线程可用）。
// Phase 3 Tauri 配 COOP/COEP 头后可开多线程加速。
// 验收修复：ORT 把相对 wasmPaths 按它自己的 bundle 位置解析（../vendor/ort 会叠加成 /vendor/vendor/ort），
// 必须按本 worker 的 import.meta.url 生成绝对 URL，http 与 Tauri 自定义协议下都安全
ort.env.wasm.wasmPaths = new URL('../vendor/ort/', import.meta.url).href;
ort.env.wasm.numThreads =
  (typeof crossOriginIsolated !== 'undefined' && crossOriginIsolated)
    ? Math.min(4, (navigator.hardwareConcurrency || 4) - 2)
    : 1;

/** 模型输入分辨率（正方形） */
const INPUT_SIZE = 320;
/** 均值池化目标分辨率 */
const GRID_SIZE = 64;
/** 池化窗口：320 / 64 */
const POOL = INPUT_SIZE / GRID_SIZE;

let sessionPromise = null; // 惰性创建、会话复用
let sessionError = null;   // 会话初始化失败后全局停用

/**
 * 获取（并缓存）推理会话。模型加载失败会置 sessionError，
 * 后续所有 detect 都走 fatal 分支，由主线程停用整个检测。
 */
async function getSession() {
  if (sessionError) throw sessionError;
  if (!sessionPromise) {
    sessionPromise = ort.InferenceSession.create(new URL('../models/u2netp.onnx', import.meta.url).href, {
      executionProviders: ['wasm'],
    }).catch((err) => {
      sessionError = err;
      throw err;
    });
  }
  return sessionPromise;
}

/**
 * 解码照片到 320×320 并返回 RGBA 像素。
 * resizeWidth/Height 由浏览器缩放（允许拉伸变形），OffscreenCanvas 保证 320×320 落盘。
 * 位图用完立即 close（内存纪律）。
 */
async function decodeInput(file) {
  const bmp = await createImageBitmap(file, {
    imageOrientation: 'from-image',
    resizeWidth: INPUT_SIZE,
    resizeHeight: INPUT_SIZE,
  });
  try {
    const canvas = new OffscreenCanvas(INPUT_SIZE, INPUT_SIZE);
    const ctx = canvas.getContext('2d');
    ctx.drawImage(bmp, 0, 0, INPUT_SIZE, INPUT_SIZE);
    return ctx.getImageData(0, 0, INPUT_SIZE, INPUT_SIZE).data;
  } finally {
    bmp.close();
  }
}

/**
 * RGBA（0~255）→ NCHW float32，ImageNet mean/std 归一化。
 * mean = [0.485, 0.456, 0.406]，std = [0.229, 0.224, 0.225]，像素先归一到 0~1。
 */
function toNCHW(rgba) {
  const n = INPUT_SIZE * INPUT_SIZE;
  const out = new Float32Array(3 * n);
  const inv255 = 1 / 255;
  for (let i = 0; i < n; i++) {
    out[i] = (rgba[i * 4] * inv255 - 0.485) / 0.229;
    out[n + i] = (rgba[i * 4 + 1] * inv255 - 0.456) / 0.224;
    out[2 * n + i] = (rgba[i * 4 + 2] * inv255 - 0.406) / 0.225;
  }
  return out;
}

/**
 * [1,1,320,320] 输出 → 5×5 均值池化 → 64×64 Float32Array（grid）。
 * 每个输出格子的热量 = 其 5×5 邻域均值，取值 0~1 量级。
 */
function poolGrid(outData) {
  const grid = new Float32Array(GRID_SIZE * GRID_SIZE);
  for (let gy = 0; gy < GRID_SIZE; gy++) {
    for (let gx = 0; gx < GRID_SIZE; gx++) {
      let sum = 0;
      for (let dy = 0; dy < POOL; dy++) {
        const iy = gy * POOL + dy;
        for (let dx = 0; dx < POOL; dx++) {
          sum += outData[iy * INPUT_SIZE + gx * POOL + dx];
        }
      }
      grid[gy * GRID_SIZE + gx] = sum / (POOL * POOL);
    }
  }
  return grid;
}

self.onmessage = async (ev) => {
  const msg = ev.data;
  if (!msg || msg.type !== 'detect') return;
  const { id, file } = msg;
  try {
    const session = await getSession();
    const rgba = await decodeInput(file);
    const feeds = {};
    feeds[session.inputNames[0]] = new ort.Tensor('float32', toNCHW(rgba), [1, 3, INPUT_SIZE, INPUT_SIZE]);
    const results = await session.run(feeds);
    const raw = results[session.outputNames[0]].data;
    // 规格约定输出 [1,1,320,320]；取首个输出前 102400 元素，长度不符则报错兜底
    const n = INPUT_SIZE * INPUT_SIZE;
    if (!raw || raw.length < n) {
      throw new Error('模型输出维度异常（期望 320×320，实际 ' + (raw ? raw.length : 0) + '）');
    }
    const grid = poolGrid(raw);
    // grid 的 ArrayBuffer 可 transfer（可转移类型只认 ArrayBuffer/ImageBitmap 等，Blob 不可 transfer）
    self.postMessage({ type: 'grid', id, grid, gridSize: GRID_SIZE }, [grid.buffer]);
  } catch (err) {
    const message = String((err && err.message) || err);
    // 会话初始化失败是全局性的：fatal 通知主线程停用检测；单张推理失败仅回 error
    if (sessionError) {
      self.postMessage({ type: 'fatal', message });
    } else {
      self.postMessage({ type: 'error', id, message });
    }
  }
};
