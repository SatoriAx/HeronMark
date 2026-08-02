/*!
 * app.js — 鹭印 HeronMark 入口
 * 状态、事件绑定、导入、缩略图、预览调度、拖拽、持久化、导出入口。
 * 只对接 index.html 既有 DOM 契约；不修改任何冻结文件。
 */

import {
  computeFitRect,
  drawAvoidGhost,
  hitTestMark,
  renderPreview,
} from './render.js';
import { analyzeAvoidance } from './avoid.js';
import { ExportController } from './exporter.js';

/* ═══════════════════ 状态模型（DESIGN.md §7.1） ═══════════════════ */

/** 样式类键：apply-all 关闭时照片 override 只允许覆盖这些键 */
const STYLE_KEYS = ['preset', 'anchor', 'offsetX', 'offsetY', 'sizePct', 'opacity', 'rotation', 'glow', 'glowStrength'];

/** 内置预设（仅 personal 版本渲染；friend/通用版不含这些个人签名素材） */
const BUILTIN_PRESETS = [
  { id: 'heron-slim', name: '夜鹭·纤细' },
  { id: 'heron-bold', name: '夜鹭·粗体' },
  { id: 'egret-slim', name: '白鹭·纤细' },
];

/** 版本：personal（含个人预设）| friend（通用版，无内置预设，签名框留空） */
const edition = { value: 'personal' };

async function loadEdition() {
  try {
    const res = await fetch('version.json');
    if (!res.ok) return;
    const v = await res.json();
    if (v && v.edition === 'friend') edition.value = 'friend';
  } catch { /* 无 version.json 一律按 personal */ }
}

/** 渲染内置预设卡（仅 personal）；并维护空素材提示 */
function renderBuiltinCards() {
  if (edition.value !== 'personal') return;
  for (const p of BUILTIN_PRESETS) {
    const btn = document.createElement('button');
    btn.className = 'preset-card';
    btn.dataset.preset = p.id;
    const img = document.createElement('img');
    img.src = 'assets/presets/' + p.id + '.png';
    img.alt = p.name;
    const span = document.createElement('span');
    span.textContent = p.name;
    btn.append(img, span);
    el['preset-list'].appendChild(btn);
  }
}

function updatePresetEmptyHint() {
  const has = el['preset-list'].querySelector('.preset-card');
  el['preset-empty-hint'].hidden = !!has;
}

function defaultSettings() {
  return {
    preset: 'heron-slim',
    customMarks: [], // [{ id, name, blobUrl }] blobUrl 会话内重建，不持久化
    anchor: 'bc',
    offsetX: 0,
    offsetY: 0,
    sizePct: 15,
    opacity: 100,
    rotation: 0,
    glow: true,
    glowStrength: 20,
    applyAll: true,
    smartAvoid: false, // Phase 2 智能避让（DESIGN.md §7.6），持久化
    export: {
      format: 'follow',
      jpgQuality: 90,
      resizeLongEdge: 0,
      nameTemplate: '{name}_wm',
      outputDirHandle: null, // 会话内有效，不持久化
    },
  };
}

const state = {
  photos: [],        // [{ id, file, width, height, thumbUrl, bitmap, selected, override, itemEl }]
  currentPhotoId: null,
  settings: defaultSettings(),
  userScale: 1,      // 预览额外缩放（不影响导出）
  viewX: 0,          // 视野平移（放大后拖拽照片，CSS px，不影响导出）
  viewY: 0,
};

const LS_KEY = 'heronmark.settings.v1';
const IDB_NAME = 'heronmark';
const IDB_STORE = 'marks';

/* ═══════════════════ DOM 引用 ═══════════════════ */

const el = {};
function $(id) { return document.getElementById(id); }
const IDS = [
  'btn-import-files', 'btn-import-folder', 'btn-export', 'file-input', 'folder-input',
  'photo-list', 'rail-empty', 'photo-count', 'btn-select-all', 'btn-clear',
  'preview-canvas', 'preview-stage', 'stage-empty', 'btn-prev-photo', 'btn-next-photo',
  'zoom-fit', 'zoom-100', 'zoom-label', 'photo-info',
  'preset-list', 'btn-import-mark', 'mark-input', 'btn-find-assets', 'preset-empty-hint',
  'find-assets-modal', 'find-assets-close', 'find-assets-input', 'find-assets-search',
  'find-assets-grid', 'find-assets-status',
  'modal-compose', 'compose-text', 'compose-preview', 'compose-add', 'compose-icon-only',
  'compose-text-only', 'compose-gap', 'compose-gap-val', 'compose-vshift', 'compose-vshift-val',
  'anchor-grid', 'offset-x', 'offset-y', 'offset-x-val', 'offset-y-val',
  'size-pct', 'size-pct-val', 'opacity', 'opacity-val', 'rotation', 'rotation-val',
  'glow-toggle', 'glow-strength', 'glow-strength-val',
  'apply-all', 'btn-reset-photo', 'smart-avoid',
  'export-format', 'jpg-quality', 'jpg-quality-val', 'resize-long-edge',
  'filename-template', 'btn-choose-output', 'output-path-label',
  'status-text', 'export-progress', 'export-progress-fill', 'btn-cancel-export',
  'win-min', 'win-max', 'win-close',
];
IDS.forEach((id) => { el[id] = $(id); });

/* ────────── Tauri 无边框窗控（浏览器环境下 __TAURI__ 不存在，窗控保持隐藏） ────────── */
(function initWindowControls() {
  const tauriWin = window.__TAURI__ && window.__TAURI__.window
    ? window.__TAURI__.window.getCurrentWindow()
    : null;
  if (!tauriWin) return;
  document.body.classList.add('tauri');
  el['win-min'].addEventListener('click', () => tauriWin.minimize());
  el['win-max'].addEventListener('click', () => tauriWin.toggleMaximize());
  el['win-close'].addEventListener('click', () => tauriWin.close());
})();

/* ═══════════════════ 工具函数 ═══════════════════ */

function setStatus(text) { el['status-text'].textContent = text; }
function clamp(v, min, max) { return Math.min(max, Math.max(min, v)); }
function uid() {
  return 'p' + Date.now().toString(36) + Math.random().toString(36).slice(2, 8);
}
function currentPhoto() {
  return state.photos.find((p) => p.id === state.currentPhotoId) || null;
}

/** 照片的有效设置：apply-all 开 → 全局；关 → 全局叠加该照片 override */
function effectiveSettings(photo) {
  let s;
  if (state.settings.applyAll) s = state.settings;
  else if (photo && photo.override) s = Object.assign({}, state.settings, photo.override);
  else s = state.settings;
  // 避让层（DESIGN.md §7.6）：独立于 override；applied 时叠加建议的 anchor/offsetX/offsetY。
  // 预览与导出都走本函数，导出（快照 effectiveSettings）自动继承避让位置。
  if (state.settings.smartAvoid && photo && photo.avoid &&
      photo.avoid.status === 'applied' && photo.avoid.suggestion) {
    s = Object.assign({}, s, {
      anchor: photo.avoid.suggestion.anchor,
      offsetX: photo.avoid.suggestion.offsetX,
      offsetY: photo.avoid.suggestion.offsetY,
    });
  }
  return s;
}

/** 复制一份样式类设置（仅 STYLE_KEYS，防止 export 等全局键混入 override） */
function cloneStyle(src) {
  const o = {};
  for (const k of STYLE_KEYS) o[k] = src[k];
  return o;
}

/* ═══════════════════ 持久化（localStorage + IndexedDB） ═══════════════════ */

/** 保存可持久化设置（去掉句柄等会话对象） */
function saveSettings() {
  const s = state.settings;
  const data = {
    preset: s.preset,
    customMarks: s.customMarks.map((m) => ({ id: m.id, name: m.name })),
    anchor: s.anchor,
    offsetX: s.offsetX,
    offsetY: s.offsetY,
    sizePct: s.sizePct,
    opacity: s.opacity,
    rotation: s.rotation,
    glow: s.glow,
    glowStrength: s.glowStrength,
    applyAll: s.applyAll,
    smartAvoid: s.smartAvoid,
    export: {
      format: s.export.format,
      jpgQuality: s.export.jpgQuality,
      resizeLongEdge: s.export.resizeLongEdge,
      nameTemplate: s.export.nameTemplate,
    },
  };
  try { localStorage.setItem(LS_KEY, JSON.stringify(data)); } catch { /* 存储不可用时静默 */ }
}

/** 启动时恢复设置（与默认值合并） */
function loadSettings() {
  try {
    const raw = localStorage.getItem(LS_KEY);
    if (!raw) return;
    const d = JSON.parse(raw);
    const s = state.settings;
    if (typeof d.preset === 'string') s.preset = d.preset;
    if (Array.isArray(d.customMarks)) s.customMarks = d.customMarks.map((m) => ({ id: m.id, name: m.name }));
    if (typeof d.anchor === 'string') s.anchor = d.anchor;
    if (typeof d.offsetX === 'number') s.offsetX = d.offsetX;
    if (typeof d.offsetY === 'number') s.offsetY = d.offsetY;
    if (typeof d.sizePct === 'number') s.sizePct = d.sizePct;
    if (typeof d.opacity === 'number') s.opacity = d.opacity;
    if (typeof d.rotation === 'number') s.rotation = d.rotation;
    if (typeof d.glow === 'boolean') s.glow = d.glow;
    if (typeof d.glowStrength === 'number') s.glowStrength = d.glowStrength;
    if (typeof d.applyAll === 'boolean') s.applyAll = d.applyAll;
    if (typeof d.smartAvoid === 'boolean') s.smartAvoid = d.smartAvoid;
    if (d.export && typeof d.export === 'object') {
      const ex = d.export;
      if (typeof ex.format === 'string') s.export.format = ex.format;
      if (typeof ex.jpgQuality === 'number') s.export.jpgQuality = ex.jpgQuality;
      if (typeof ex.resizeLongEdge === 'number' || typeof ex.resizeLongEdge === 'string') {
        s.export.resizeLongEdge = +ex.resizeLongEdge;
      }
      if (typeof ex.nameTemplate === 'string') s.export.nameTemplate = ex.nameTemplate;
    }
  } catch { /* 数据损坏时用默认设置 */ }
}

/** IndexedDB 封装（自定义水印 blob 存储） */
function idbOpen() {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(IDB_NAME, 1);
    req.onupgradeneeded = () => { req.result.createObjectStore(IDB_STORE); };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}
async function idbPut(key, value) {
  const db = await idbOpen();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(IDB_STORE, 'readwrite');
    tx.objectStore(IDB_STORE).put(value, key);
    tx.oncomplete = () => { db.close(); resolve(); };
    tx.onerror = () => { db.close(); reject(tx.error); };
  });
}
async function idbGet(key) {
  const db = await idbOpen();
  return new Promise((resolve, reject) => {
    const req = db.transaction(IDB_STORE, 'readonly').objectStore(IDB_STORE).get(key);
    req.onsuccess = () => { db.close(); resolve(req.result || null); };
    req.onerror = () => { db.close(); reject(req.error); };
  });
}
async function idbDel(key) {
  const db = await idbOpen();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(IDB_STORE, 'readwrite');
    tx.objectStore(IDB_STORE).delete(key);
    tx.oncomplete = () => { db.close(); resolve(); };
    tx.onerror = () => { db.close(); reject(tx.error); };
  });
}

/* ═══════════════════ 水印素材解析 ═══════════════════ */

/** 素材位图缓存：presetId → ImageBitmap（素材会话内不变，永久缓存） */
const markCache = new Map();

/** 解析素材 URL：内置预设走 assets/presets，自定义走 blobUrl；空预设返回 null */
function markUrl(presetId) {
  if (!presetId) return null;
  if (presetId.startsWith('mark_')) {
    const meta = state.settings.customMarks.find((m) => m.id === presetId);
    return meta && meta.blobUrl ? meta.blobUrl : null;
  }
  return 'assets/presets/' + presetId + '.png';
}

/** 解析（并缓存）素材位图 */
async function resolveMarkBitmap(presetId) {
  if (!presetId) throw new Error('未选择水印素材');
  const cached = markCache.get(presetId);
  if (cached) return cached;
  const url = markUrl(presetId);
  if (!url) throw new Error('未知水印：' + presetId);
  const resp = await fetch(url);
  if (!resp.ok) throw new Error('素材加载失败：' + url);
  const blob = await resp.blob();
  const bmp = await createImageBitmap(blob);
  markCache.set(presetId, bmp);
  return bmp;
}

/** 当前照片的生效素材位图（未缓存时异步加载） */
function getCurrentMarkBitmap(presetId) {
  return resolveMarkBitmap(presetId);
}

/* ═══════════════════ 导入与缩略图 ═══════════════════ */

const THUMB_MAX_EDGE = 240;

/** 从位图生成最长边 240px 的 JPEG 缩略图 blob */
async function makeThumbBlob(bmp, maxEdge) {
  const k = Math.min(1, maxEdge / Math.max(bmp.width, bmp.height));
  const w = Math.max(1, Math.round(bmp.width * k));
  const h = Math.max(1, Math.round(bmp.height * k));
  const c = document.createElement('canvas');
  c.width = w;
  c.height = h;
  c.getContext('2d').drawImage(bmp, 0, 0, w, h);
  return new Promise((resolve) => c.toBlob(resolve, 'image/jpeg', 0.8));
}

/**
 * 导入一张照片：全尺寸解码一次（拿原始尺寸 + 生成缩略图）后立即释放。
 * 串行执行以保证内存峰值可控（3250 万像素 JPG 单张解码约百余 MB）。
 */
async function createPhoto(file) {
  const bmp = await createImageBitmap(file, { imageOrientation: 'from-image' });
  const width = bmp.width;
  const height = bmp.height;
  const thumbBlob = await makeThumbBlob(bmp, THUMB_MAX_EDGE);
  bmp.close();
  const thumbUrl = URL.createObjectURL(thumbBlob);
  return {
    id: uid(),
    file,
    width,
    height,
    thumbUrl,
    bitmap: null,    // 全尺寸位图：懒加载，仅当前预览照片保留一份
    selected: true,
    override: null,
    itemEl: null,
  };
}

/** 按文件名自然序排序 */
function byNaturalName(a, b) {
  return a.name.localeCompare(b.name, undefined, { numeric: true, sensitivity: 'base' });
}

/** 导入文件列表（多选或文件夹）；过滤图片、去重、自然序 */
async function importFiles(fileList) {
  const files = [...fileList].filter((f) => /\.(jpe?g|png|webp)$/i.test(f.name));
  if (!files.length) {
    setStatus('未找到支持的图片文件（.jpg/.jpeg/.png/.webp）');
    return;
  }
  files.sort(byNaturalName);
  const existing = new Set(state.photos.map((p) => p.file.name + '|' + p.file.size));
  const fresh = files.filter((f) => !existing.has(f.name + '|' + f.size));
  if (!fresh.length) {
    setStatus('没有新图片（已全部导入）');
    return;
  }
  setStatus('正在导入 ' + fresh.length + ' 张…');
  for (const file of fresh) {
    try {
      const photo = await createPhoto(file);
      state.photos.push(photo);
      appendPhotoItem(photo);
      enqueueDetect(photo); // 开关开时加入显著性检测队列（不阻塞导入）
      // 让出事件循环，保证列表逐张渲染、UI 不冻结
      await new Promise((r) => setTimeout(r, 0));
    } catch (err) {
      setStatus('导入失败：' + file.name + '（' + ((err && err.message) || err) + '）');
    }
  }
  updatePhotoCount();
  updateRailEmpty();
  if (!currentPhoto()) {
    selectPhoto(state.photos[0].id);
  }
  setStatus('已导入 ' + state.photos.length + ' 张照片');
}

/** 构建缩略图节点（结构对齐 HTML 注释中的模板） */
function buildPhotoItem(photo) {
  const div = document.createElement('div');
  div.className = 'photo-item';
  div.dataset.id = photo.id;
  const img = document.createElement('img');
  img.className = 'photo-thumb';
  img.src = photo.thumbUrl;
  img.alt = photo.file.name;
  const name = document.createElement('span');
  name.className = 'photo-name';
  name.textContent = photo.file.name;
  const status = document.createElement('span');
  status.className = 'photo-status';
  const suggest = document.createElement('span');
  suggest.className = 'photo-suggest';
  div.append(img, name, status, suggest);
  photo.itemEl = div;
  return div;
}

function appendPhotoItem(photo) {
  el['photo-list'].appendChild(buildPhotoItem(photo));
  updateItemStatus(photo);
}

/** 刷新单张缩略图的选中态与"不导出"标记 */
function updateItemStatus(photo) {
  const item = photo.itemEl;
  if (!item) return;
  item.classList.toggle('selected', photo.id === state.currentPhotoId);
  const status = item.querySelector('.photo-status');
  if (photo.selected) {
    status.classList.remove('show');
    status.textContent = '';
  } else {
    status.classList.add('show');
    status.textContent = '不导出';
  }
}

function updatePhotoCount() {
  el['photo-count'].textContent = state.photos.length + ' 张';
}

function updateRailEmpty() {
  el['rail-empty'].style.display = state.photos.length ? 'none' : 'block';
}

/** 全列表刷新选中态（当前照片金框） */
function refreshSelectionUI() {
  for (const p of state.photos) updateItemStatus(p);
}

/** 释放照片相关资源（缩略图 URL、全尺寸位图） */
function disposePhoto(photo) {
  if (photo.thumbUrl) URL.revokeObjectURL(photo.thumbUrl);
  if (photo.bitmap) { photo.bitmap.close(); photo.bitmap = null; }
}

/* ═══════════════════ 选中语义（DESIGN.md §7.2） ═══════════════════ */

/** 设为当前照片（金框只给当前照片） */
function selectPhoto(id) {
  state.currentPhotoId = id;
  state.viewX = 0;   // 切照片时视野复位
  state.viewY = 0;
  refreshSelectionUI();
  syncControlsFromSettings();
  updateResetBtn();
  scheduleRender();
}

/* ═══════════════════ 预览渲染与调度 ═══════════════════ */

let renderQueued = false;
/** 合并渲染请求：一帧内只渲染一次 */
function scheduleRender() {
  if (renderQueued) return;
  renderQueued = true;
  requestAnimationFrame(() => {
    renderQueued = false;
    renderCurrent();
  });
}

let lastFit = null; // 最近一帧照片的 fit 矩形（拖拽坐标换算用）

/** 解码当前照片全尺寸位图；切走其他照片的位图立即释放 */
async function decodePhoto(photo) {
  // 同一张照片任何时刻只保留一份全尺寸解码：先释放其余照片
  for (const p of state.photos) {
    if (p !== photo && p.bitmap) { p.bitmap.close(); p.bitmap = null; }
  }
  if (photo.bitmap) { photo.bitmap.close(); photo.bitmap = null; }
  try {
    const bmp = await createImageBitmap(photo.file, { imageOrientation: 'from-image' });
    // 解码期间用户已切走：直接丢弃
    if (state.currentPhotoId !== photo.id) { bmp.close(); return; }
    photo.bitmap = bmp;
    photo.width = bmp.width;
    photo.height = bmp.height;
    scheduleRender();
  } catch (err) {
    setStatus('照片解码失败：' + photo.file.name);
  }
}

/** 渲染当前帧：清屏 → fit 照片 → 水印（所见即所得） */
async function renderCurrent() {
  const canvas = el['preview-canvas'];
  const ctx = canvas.getContext('2d');
  const cssW = canvas.clientWidth || 0;
  const cssH = canvas.clientHeight || 0;
  if (!cssW || !cssH) return;
  // devicePixelRatio 感知
  const dpr = window.devicePixelRatio || 1;
  const bw = Math.max(1, Math.round(cssW * dpr));
  const bh = Math.max(1, Math.round(cssH * dpr));
  if (canvas.width !== bw || canvas.height !== bh) {
    canvas.width = bw;
    canvas.height = bh;
  }
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  ctx.clearRect(0, 0, cssW, cssH);

  const photo = currentPhoto();
  if (!photo) {
    el['stage-empty'].style.display = 'block';
    el['photo-info'].textContent = '';
    updateZoomLabel(null);
    lastFit = null;
    return;
  }
  el['stage-empty'].style.display = 'none';

  if (!photo.bitmap) {
    el['photo-info'].textContent = photo.file.name + ' · 解码中…';
    decodePhoto(photo);
    return;
  }

  const eff = effectiveSettings(photo);
  let mark = null;
  if (eff.preset) {
    try {
      mark = await getCurrentMarkBitmap(eff.preset);
    } catch (err) {
      setStatus('水印素材加载失败：' + ((err && err.message) || err));
      return;
    }
  }
  const fit = renderPreview(ctx, cssW, cssH, photo.bitmap, mark, Object.assign({}, eff, { userScale: state.userScale, viewX: state.viewX, viewY: state.viewY }));
  lastFit = fit;
  // 智能避让：suggested 时在建议位置画虚线幽灵框（DESIGN.md §7.6）
  if (mark && state.settings.smartAvoid && photo.avoid && photo.avoid.status === 'suggested' &&
      photo.avoid.suggestion && fit) {
    const sugSettings = Object.assign({}, eff, photo.avoid.suggestion);
    ctx.save();
    ctx.translate(fit.x, fit.y);
    ctx.scale(fit.k, fit.k);
    drawAvoidGhost(ctx, fit, mark.width, mark.height, sugSettings);
    ctx.restore();
  }
  el['photo-info'].textContent = photo.file.name + ' · ' + photo.bitmap.width + ' × ' + photo.bitmap.height;
  updateZoomLabel(fit ? fit.k : null);
}

function updateZoomLabel(k) {
  el['zoom-label'].textContent = k ? Math.round(k * 100) + '%' : '';
}

/* ═══════════════════ 控件联动 ═══════════════════ */

const CONTROL_BINDINGS = [
  { key: 'offsetX', input: 'offset-x', val: 'offset-x-val', fmt: (v) => String(v) },
  { key: 'offsetY', input: 'offset-y', val: 'offset-y-val', fmt: (v) => String(v) },
  { key: 'sizePct', input: 'size-pct', val: 'size-pct-val', fmt: (v) => v + '%' },
  { key: 'opacity', input: 'opacity', val: 'opacity-val', fmt: (v) => v + '%' },
  { key: 'rotation', input: 'rotation', val: 'rotation-val', fmt: (v) => v + '°' },
  { key: 'glowStrength', input: 'glow-strength', val: 'glow-strength-val', fmt: (v) => String(v) },
];

/**
 * 写一个样式键：apply-all 开 → 写全局；关 → 写入当前照片 override（先复制全局作底）。
 * @param {string} key STYLE_KEYS 之一
 * @param {*} value 新值
 * @param {boolean} [noSave] 高频调用（拖拽）时跳过持久化，由调用方收尾保存
 */
function setControl(key, value, noSave) {
  const photo = currentPhoto();
  // 手动调整设置 = 放弃当前照片已应用的避让（回到 suggested 并重新评估建议）
  if (state.settings.smartAvoid && photo && photo.avoid && photo.avoid.status === 'applied') {
    photo.avoid.status = 'suggested';
    updateAvoidBadge(photo);
    scheduleAvoidAnalysis(photo);
  }
  if (!state.settings.applyAll && photo) {
    if (!photo.override) photo.override = cloneStyle(state.settings);
    photo.override[key] = value;
  } else {
    state.settings[key] = value;
  }
  syncControlDisplay();
  if (!noSave) saveSettings();
  scheduleRender();
}

/** 把生效设置回显到全部控件 */
function syncControlDisplay() {
  const eff = effectiveSettings(currentPhoto());
  for (const b of CONTROL_BINDINGS) {
    el[b.input].value = eff[b.key];
    el[b.val].textContent = b.fmt(eff[b.key]);
  }
  el['glow-toggle'].checked = !!eff.glow;
  updateAnchorUI(eff.anchor);
  updatePresetUI(eff.preset);
}

function updateAnchorUI(anchor) {
  el['anchor-grid'].querySelectorAll('button[data-anchor]').forEach((btn) => {
    btn.classList.toggle('active', btn.dataset.anchor === anchor);
  });
}

function updatePresetUI(preset) {
  el['preset-list'].querySelectorAll('.preset-card').forEach((card) => {
    card.classList.toggle('active', card.dataset.preset === preset);
  });
}

function updateResetBtn() {
  const photo = currentPhoto();
  el['btn-reset-photo'].disabled = state.settings.applyAll || !photo || !photo.override;
}

/* ═══════════════════ 画布拖拽与缩放 ═══════════════════ */

let drag = null; // { startClientX, startClientY, baseX, baseY, photo }

function onCanvasMouseDown(e) {
  if (e.button !== 0) return;
  const photo = currentPhoto();
  if (!photo || !photo.bitmap || !lastFit) return;
  const eff = effectiveSettings(photo);
  const mark = markCache.get(eff.preset); // 命中检测用已缓存素材，缺失时仍允许平移
  const rect = el['preview-canvas'].getBoundingClientRect();
  const mx = e.clientX - rect.left;
  const my = e.clientY - rect.top;
  // 换算到照片坐标
  const px = (mx - lastFit.x) / lastFit.k;
  const py = (my - lastFit.y) / lastFit.k;
  if (mark && hitTestMark(px, py, photo.bitmap.width, photo.bitmap.height, mark.width, mark.height, eff)) {
    drag = { startClientX: e.clientX, startClientY: e.clientY, baseX: eff.offsetX, baseY: eff.offsetY, photo };
    el['preview-canvas'].classList.add('dragging');
    e.preventDefault();
    return;
  }
  // 未命中水印：拖拽 = 平移视野（放大后查看细节）
  drag = { pan: true, startClientX: e.clientX, startClientY: e.clientY, baseViewX: state.viewX, baseViewY: state.viewY, photo };
  el['preview-canvas'].classList.add('dragging');
  e.preventDefault();
}

function onWindowMouseMove(e) {
  if (!drag) return;
  // 平移视野分支：直接改视野偏移，不动任何水印设置
  if (drag.pan) {
    state.viewX = drag.baseViewX + (e.clientX - drag.startClientX);
    state.viewY = drag.baseViewY + (e.clientY - drag.startClientY);
    scheduleRender();
    return;
  }
  const photo = drag.photo;
  if (!photo.bitmap || !lastFit) return;
  const dx = (e.clientX - drag.startClientX) / lastFit.k; // 照片像素
  const dy = (e.clientY - drag.startClientY) / lastFit.k;
  const nx = clamp(Math.round(drag.baseX + dx / photo.bitmap.width * 1000), -500, 500);
  const ny = clamp(Math.round(drag.baseY + dy / photo.bitmap.height * 1000), -500, 500);
  const eff = effectiveSettings(photo);
  if (nx !== eff.offsetX) setControl('offsetX', nx, true);
  if (ny !== eff.offsetY) setControl('offsetY', ny, true);
}

function onWindowMouseUp() {
  if (!drag) return;
  drag = null;
  el['preview-canvas'].classList.remove('dragging');
  saveSettings();
}

function onCanvasWheel(e) {
  e.preventDefault();
  const factor = e.deltaY < 0 ? 1.12 : 1 / 1.12;
  state.userScale = clamp(state.userScale * factor, 0.05, 40);
  scheduleRender();
}

/* ═══════════════════ 智能避让（Phase 2，DESIGN.md §7.6） ═══════════════════ */

/** 显著性 grid 分辨率（与 detect-worker.js 一致） */
const AVOID_GRID_SIZE = 64;

let detectQueue = [];     // 待检照片 id 队列（主线程串行派发）
let detectWorker = null;  // 检测 Worker（惰性创建，复用）
let detectBusy = false;   // 当前是否有一张在检
let detectDisabled = false; // Worker 级故障后停用整个检测

/**
 * 把照片加入检测队列（去重：已检/在检/已排队的不重复加）。
 * 开关关闭或检测不可用时直接忽略；检测期间不阻塞导入与预览。
 */
function enqueueDetect(photo) {
  if (!state.settings.smartAvoid || detectDisabled) return;
  if (!photo || !photo.file) return;
  const av = photo.avoid;
  if (av && av.grid) return;                 // 已检测过
  if (av && av.status === 'detecting') return; // 在检
  if (detectQueue.includes(photo.id)) return;  // 已排队
  detectQueue.push(photo.id);
  pumpDetect();
}

/** 串行派发：一个 Worker 一次一张；照片已被清掉时跳过 */
function pumpDetect() {
  if (detectDisabled || detectBusy || !state.settings.smartAvoid) return;
  const id = detectQueue.shift();
  if (!id) return;
  const photo = state.photos.find((p) => p.id === id);
  if (!photo) { pumpDetect(); return; }
  if (!detectWorker) {
    try {
      detectWorker = new Worker(new URL('./detect-worker.js', import.meta.url), { type: 'module' });
      detectWorker.onmessage = (ev) => { onDetectMessage(ev.data); };
      detectWorker.onerror = () => {
        // Worker 级错误（脚本/依赖加载失败）：停用检测，detecting 归位，不空转队列
        detectDisabled = true;
        detectQueue.length = 0;
        failDetectingPhotos();
      };
    } catch (err) {
      detectDisabled = true;
      detectQueue.length = 0;
      failDetectingPhotos();
      return;
    }
  }
  detectBusy = true;
  photo.avoid = { grid: null, status: 'detecting', suggestion: null };
  updateAvoidBadge(photo);
  detectWorker.postMessage({ type: 'detect', id: photo.id, file: photo.file });
}

/** 所有在检照片标记为 clear（Worker 故障/队列清空时兜底） */
function failDetectingPhotos() {
  for (const p of state.photos) {
    if (p.avoid && p.avoid.status === 'detecting') {
      p.avoid.status = 'clear';
      p.avoid.suggestion = null;
      updateAvoidBadge(p);
    }
  }
}

/** Worker 消息处理：grid 挂载 → 避让分析 → 徽章刷新；error/fatal 分别兜底 */
async function onDetectMessage(msg) {
  detectBusy = false;
  if (msg.type === 'grid') {
    const photo = state.photos.find((p) => p.id === msg.id);
    if (photo) {
      photo.avoid = photo.avoid || {};
      photo.avoid.grid = msg.grid; // 64×64 Float32Array
      await analyzePhotoAvoid(photo);
      updateAvoidBadge(photo);
      if (photo.id === state.currentPhotoId) scheduleRender();
    }
  } else if (msg.type === 'error') {
    const photo = state.photos.find((p) => p.id === msg.id);
    if (photo) {
      photo.avoid = photo.avoid || {};
      photo.avoid.status = 'clear';
      photo.avoid.suggestion = null;
      updateAvoidBadge(photo);
    }
  } else if (msg.type === 'fatal') {
    // 模型/会话初始化失败：停用整个检测，detecting 归位，清空队列
    detectDisabled = true;
    detectQueue.length = 0;
    failDetectingPhotos();
    console.warn('智能避让不可用：' + msg.message);
    setStatus('智能避让不可用（显著性模型加载失败）');
  }
  pumpDetect();
}

/**
 * 用 grid 跑避让分析：需要当前生效设置与水印素材尺寸（异步取素材）。
 * 分析结果：suggestion 存在 → suggested；否则 clear。
 * 开关已关闭时同样归为 clear（grid 保留复用，重开开关不再重复检测）。
 */
async function analyzePhotoAvoid(photo) {
  try {
    if (!state.settings.smartAvoid || !photo.avoid || !photo.avoid.grid) {
      if (photo.avoid) { photo.avoid.status = 'clear'; photo.avoid.suggestion = null; }
      return;
    }
    const eff = effectiveSettings(photo);
    if (!eff.preset) {
      photo.avoid.status = 'clear';
      photo.avoid.suggestion = null;
      return;
    }
    const mark = await resolveMarkBitmap(eff.preset);
    const sug = analyzeAvoidance(
      photo.avoid.grid, AVOID_GRID_SIZE,
      photo.width, photo.height,
      mark.width, mark.height,
      eff
    );
    photo.avoid.suggestion = sug;
    photo.avoid.status = sug ? 'suggested' : 'clear';
  } catch (err) {
    // 分析失败（素材加载异常等）：按无需避让处理，不阻塞队列
    if (photo.avoid) { photo.avoid.status = 'clear'; photo.avoid.suggestion = null; }
    console.warn('避让分析失败：' + ((photo.file && photo.file.name) || ''), err);
  }
}

/** 设置变化后重新评估当前照片的建议（异步，结果回来后刷新徽章与预览） */
function scheduleAvoidAnalysis(photo) {
  if (!photo || !photo.avoid || !photo.avoid.grid) return;
  analyzePhotoAvoid(photo).then(() => {
    updateAvoidBadge(photo);
    if (photo.id === state.currentPhotoId) scheduleRender();
  });
}

/** 刷新单张缩略图的避让徽章（开关关 / detecting / clear 时不显示） */
function updateAvoidBadge(photo) {
  const item = photo && photo.itemEl;
  if (!item) return;
  const badge = item.querySelector('.photo-suggest');
  if (!badge) return;
  const on = state.settings.smartAvoid;
  const st = photo.avoid ? photo.avoid.status : null;
  badge.classList.toggle('show', on && (st === 'suggested' || st === 'applied'));
  badge.classList.toggle('applied', on && st === 'applied');
  badge.textContent = st === 'applied' ? '已避让' : '建议避让';
}

/** 全量刷新徽章（开关切换时调用） */
function updateAllAvoidBadges() {
  for (const p of state.photos) updateAvoidBadge(p);
}

/** 徽章点击：suggested ↔ applied 切换（不改变当前照片选中） */
function toggleAvoidApply(photo) {
  if (!photo || !photo.avoid) return;
  const st = photo.avoid.status;
  if (st === 'suggested') photo.avoid.status = 'applied';
  else if (st === 'applied') photo.avoid.status = 'suggested';
  else return;
  updateAvoidBadge(photo);
  if (photo.id === state.currentPhotoId) scheduleRender();
}

/* ═══════════════════ 自定义水印 ═══════════════════ */

function appendCustomCard(meta, blobUrl) {
  const btn = document.createElement('button');
  btn.className = 'preset-card';
  btn.dataset.preset = meta.id;
  const img = document.createElement('img');
  img.src = blobUrl;
  img.alt = meta.name;
  const span = document.createElement('span');
  span.textContent = meta.name;
  btn.append(img, span);
  const del = document.createElement('button');
  del.className = 'preset-del';
  del.textContent = '✕';
  del.title = '删除这个素材';
  del.addEventListener('click', (e) => {
    e.stopPropagation();
    deleteCustomMark(meta.id, btn);
  });
  btn.appendChild(del);
  el['preset-list'].appendChild(btn);
  updatePresetEmptyHint();
}

/** 删除自定义素材：IndexedDB + 内存 + 卡片三处一起清，选中中的则回退到默认预设 */
async function deleteCustomMark(id, cardEl) {
  const meta = state.settings.customMarks.find((m) => m.id === id);
  if (!meta) return;
  if (!window.confirm('删除素材「' + meta.name + '」？此操作不可撤销')) return;
  try { await idbDel(id); } catch { /* 存储清理失败不阻塞界面删除 */ }
  if (meta.blobUrl) URL.revokeObjectURL(meta.blobUrl);
  state.settings.customMarks = state.settings.customMarks.filter((m) => m.id !== id);
  markCache.delete(id);
  cardEl.remove();
  if (state.settings.preset === id) {
    // 回退：优先内置预设（personal），其次剩余自定义素材，都没有则清空
    const fallback = (edition.value === 'personal' && BUILTIN_PRESETS[0] && BUILTIN_PRESETS[0].id)
      || (state.settings.customMarks[0] && state.settings.customMarks[0].id)
      || null;
    if (fallback) {
      setControl('preset', fallback);
    } else {
      state.settings.preset = null;
      updatePresetUI(null);
      saveSettings();
      scheduleRender();
    }
  } else {
    saveSettings();
  }
  updatePresetEmptyHint();
  setStatus('已删除素材：' + meta.name);
}

/** 把一个 PNG blob 注册为自定义水印（导入文件与图标库拾取共用） */
async function registerCustomMark(blob, name) {
  const id = 'mark_' + Date.now().toString(36) + Math.random().toString(36).slice(2, 7);
  const blobUrl = URL.createObjectURL(blob);
  const meta = { id, name: name || '自定义水印', blobUrl };
  state.settings.customMarks.push(meta);
  await idbPut(id, blob); // 持久化 blob
  appendCustomCard(meta, blobUrl);
  state.settings.preset = id;
  updatePresetUI(id);
  saveSettings();
  scheduleRender();
  setStatus('已添加自定义水印：' + meta.name);
}

async function importCustomMark(file) {
  // 校验可解码
  try {
    await createImageBitmap(file);
  } catch {
    setStatus('无法解码该 PNG，导入失败');
    return;
  }
  await registerCustomMark(file, file.name.replace(/\.png$/i, ''));
}

/** 启动时从 IndexedDB 恢复自定义水印（blobUrl 会话内重建） */
async function restoreCustomMarks() {
  for (const meta of state.settings.customMarks) {
    try {
      const blob = await idbGet(meta.id);
      if (!blob) continue;
      meta.blobUrl = URL.createObjectURL(blob);
      appendCustomCard(meta, meta.blobUrl);
    } catch { /* 单条恢复失败跳过 */ }
  }
}

/* ═══════════════════ 找素材（Iconify 开源图标库） ═══════════════════ */

const ICONIFY_API = 'https://api.iconify.design';

function findAssetsStatus(text) { el['find-assets-status'].textContent = text; }

function openFindAssets() {
  el['find-assets-modal'].hidden = false;
  el['find-assets-input'].focus();
  renderComposePreview();
}
function closeFindAssets() {
  el['find-assets-modal'].hidden = true;
  pendingIcon = null;
  el['compose-icon-only'].hidden = true;
}

async function searchIconify() {
  const q = el['find-assets-input'].value.trim();
  if (!q) { findAssetsStatus('先输入关键词，英文更准'); return; }
  const grid = el['find-assets-grid'];
  grid.innerHTML = '';
  findAssetsStatus('搜索中…');
  try {
    const res = await fetch(ICONIFY_API + '/search?query=' + encodeURIComponent(q) + '&limit=48');
    if (!res.ok) throw new Error('HTTP ' + res.status);
    const data = await res.json();
    const icons = data.icons || [];
    if (!icons.length) { findAssetsStatus('没搜到，换个关键词试试（英文）'); return; }
    for (const name of icons) {
      const cell = document.createElement('button');
      cell.className = 'icon-cell';
      cell.title = name;
      const img = document.createElement('img');
      img.loading = 'lazy';
      img.src = ICONIFY_API + '/' + name.replace(':', '/') + '.svg?color=%23dddddd&height=48';
      img.alt = name;
      cell.appendChild(img);
      cell.addEventListener('click', () => pickIconifyIcon(name));
      grid.appendChild(cell);
    }
    findAssetsStatus('共 ' + (data.total || icons.length) + ' 个结果，点击图标即转为白色透明水印');
  } catch (err) {
    findAssetsStatus('搜索失败：网络不通或图标库暂时不可用（' + err.message + '）');
  }
}

/** 待合成的图标（SVG 解码后的 Image 与尺寸） */
let pendingIcon = null;

/** 拉取白色 SVG → 解码 → 进入签名合成步骤 */
async function pickIconifyIcon(name) {
  findAssetsStatus('正在载入 ' + name + ' …');
  try {
    const url = ICONIFY_API + '/' + name.replace(':', '/') + '.svg?color=%23ffffff';
    const res = await fetch(url);
    if (!res.ok) throw new Error('HTTP ' + res.status);
    const text = await res.text();
    // Chromium 的 createImageBitmap 不支持 SVG，走 Image 元素解码；
    // 先按 viewBox 注入显式宽高，保证栅格化尺寸正确
    const vb = /viewBox="([^"]+)"/.exec(text);
    let w = 512, h = 512;
    if (vb) {
      const p = vb[1].trim().split(/\s+/).map(Number);
      h = Math.max(1, Math.round(512 * p[3] / p[2]));
    }
    const svg = text.replace(/<svg([^>]*)>/, (m, attrs) =>
      '<svg' + attrs.replace(/\s(width|height)="[^"]*"/g, '') + ' width="' + w + '" height="' + h + '">');
    const objUrl = URL.createObjectURL(new Blob([svg], { type: 'image/svg+xml' }));
    const im = new Image();
    await new Promise((resolve, reject) => {
      im.onload = resolve;
      im.onerror = () => reject(new Error('SVG 解码失败'));
      im.src = objUrl;
    });
    URL.revokeObjectURL(objUrl);
    pendingIcon = { name, im, w, h };
    await renderComposePreview();
    findAssetsStatus('已选中 ' + name + '，调好字体间距后「合成并添加」');
  } catch (err) {
    findAssetsStatus('载入失败：' + err.message + '（可换个图标重试）');
  }
}

/** 当前选中的签名字体 */
function composeFont() {
  const chip = el['modal-compose'].querySelector('.font-chip.active');
  return chip ? chip.dataset.font : 'Great Vibes';
}

/** 合成排版：图标在左、签名在右（两者都可缺省），间距/上下由滑杆控制（按 512 高空间定义） */
function drawComposed(ctx, W, H, text, fontFamily, withIcon) {
  ctx.clearRect(0, 0, W, H);
  const hasIcon = withIcon && pendingIcon;
  if (!hasIcon && !text) return 0;
  const pad = Math.round(H * 0.09);
  const gapV = (+el['compose-gap'].value || 0) * H / 512;
  const vsh = (+el['compose-vshift'].value || 0) * H / 512;
  let iconW = 0, iconH = 0;
  if (hasIcon) {
    iconH = H - pad * 2;
    iconW = Math.round(iconH * pendingIcon.w / pendingIcon.h);
  }
  const fontPx = Math.round(H * 0.42);
  ctx.font = fontPx + 'px "' + fontFamily + '"';
  const textW = text ? ctx.measureText(text).width : 0;
  const gap = hasIcon && text ? gapV : 0;
  const totalW = pad * 2 + iconW + gap + textW;
  let x = pad;
  if (hasIcon) {
    ctx.drawImage(pendingIcon.im, x, (H - iconH) / 2 + vsh, iconW, iconH);
    x += iconW + gap;
  }
  if (text) {
    ctx.fillStyle = '#ffffff';
    ctx.textBaseline = 'middle';
    ctx.fillText(text, x, H / 2 + fontPx * 0.04);
  }
  return totalW;
}

async function renderComposePreview() {
  const font = composeFont();
  try { await document.fonts.load('64px "' + font + '"'); } catch { /* 字体未就绪则用回退 */ }
  const canvas = el['compose-preview'];
  const ctx = canvas.getContext('2d');
  const text = el['compose-text'].value.trim();
  const measure = document.createElement('canvas').getContext('2d');
  const totalW = drawComposed(measure, 4096, canvas.height, text, font, true) || 1;
  const s = Math.min(1, (canvas.width - 12) / totalW);
  const dx = Math.max(6, (canvas.width - totalW * s) / 2);
  ctx.setTransform(s, 0, 0, s, dx, canvas.height * (1 - s) / 2);
  drawComposed(ctx, canvas.width / s, canvas.height, text, font, true);
  ctx.setTransform(1, 0, 0, 1, 0, 0);
  el['compose-icon-only'].hidden = !pendingIcon;
}

/** 成品合成：mode = full（所见即所得）| text（只要签名）| icon（只要图标）；内容决定画布宽，高 512 */
async function composeAndRegister(mode) {
  const text = mode === 'icon' ? '' : el['compose-text'].value.trim();
  const withIcon = mode !== 'text' && !!pendingIcon;
  if (mode === 'icon' && !pendingIcon) return;
  if (!text && !withIcon) { findAssetsStatus('先输签名文字，或点一个图标'); return; }
  const font = composeFont();
  if (text) {
    try { await document.fonts.load('256px "' + font + '"'); } catch { }
  }
  const H = 512;
  const measure = document.createElement('canvas').getContext('2d');
  const contentW = drawComposed(measure, 4096, H, text, font, withIcon) || 512;
  const W = Math.max(64, Math.ceil(contentW));
  const canvas = document.createElement('canvas');
  canvas.width = W;
  canvas.height = H;
  const ctx = canvas.getContext('2d');
  drawComposed(ctx, W, H, text, font, withIcon);
  const pngBlob = await new Promise((resolve) => canvas.toBlob(resolve, 'image/png'));
  if (!pngBlob) { findAssetsStatus('栅格化失败'); return; }
  const base = withIcon ? pendingIcon.name.replace(':', '·') : '签名';
  await registerCustomMark(pngBlob, text ? (withIcon ? text + '·' + base : text) : base);
  pendingIcon = null;
  closeFindAssets();
}

/* ═══════════════════ 导出 ═══════════════════ */

let exporting = false;
let exportController = null;

function updateOutputLabel() {
  const h = state.settings.export.outputDirHandle;
  el['output-path-label'].textContent = h
    ? '输出到：' + h.name
    : '未选择（导出时会询问）';
}

async function chooseOutput() {
  if (!window.showDirectoryPicker) {
    setStatus('当前浏览器不支持选择文件夹，导出时将逐个下载');
    return;
  }
  try {
    const h = await window.showDirectoryPicker({ mode: 'readwrite' });
    state.settings.export.outputDirHandle = h;
    updateOutputLabel();
    setStatus('已选择输出文件夹：' + h.name);
  } catch { /* 用户取消选择 */ }
}

/** 导出期间锁定相关 UI */
function setExportUILock(lock) {
  el['btn-export'].disabled = lock;
  el['btn-import-files'].disabled = lock;
  el['btn-import-folder'].disabled = lock;
  el['btn-select-all'].disabled = lock;
  el['btn-clear'].disabled = lock;
  el['btn-choose-output'].disabled = lock;
  el['btn-cancel-export'].hidden = !lock;
}

async function startExport() {
  if (exporting) return;
  const photos = state.photos.filter((p) => p.selected);
  if (!photos.length) {
    setStatus('没有选中的照片可导出');
    return;
  }
  // 收集本批次所需水印素材（内置预设 + 自定义），一次性解码
  const presets = new Set();
  for (const p of photos) presets.add(effectiveSettings(p).preset);
  if ([...presets].some((id) => !id)) {
    setStatus('先添加一个水印素材：「找素材」或「导入 PNG 素材」');
    return;
  }
  const markBitmaps = new Map();
  try {
    for (const id of presets) markBitmaps.set(id, await resolveMarkBitmap(id));
  } catch (err) {
    setStatus('水印素材加载失败：' + ((err && err.message) || err));
    return;
  }

  // 确定输出目标：已有句柄 → 询问选择 → 不支持则逐张下载
  let dirHandle = state.settings.export.outputDirHandle || null;
  let fallback = false;
  if (!dirHandle) {
    if (window.showDirectoryPicker) {
      try {
        dirHandle = await window.showDirectoryPicker({ mode: 'readwrite' });
        state.settings.export.outputDirHandle = dirHandle;
        updateOutputLabel();
      } catch {
        setStatus('已取消导出（未选择输出文件夹）');
        return;
      }
    } else {
      fallback = true;
    }
  }

  exporting = true;
  setExportUILock(true);
  el['export-progress'].classList.add('show');
  el['export-progress-fill'].style.width = '0%';
  setStatus('导出中 0/' + photos.length + '…');

  const workerCount = Math.max(2, (navigator.hardwareConcurrency || 4) - 2);
  exportController = new ExportController({
    workerCount,
    markBitmaps,
    onProgress: (done, total) => {
      el['export-progress-fill'].style.width = Math.round((done / total) * 100) + '%';
      setStatus('导出中 ' + done + '/' + total + '…');
    },
    onDone: (r) => {
      const fail = r.errors.length ? '，失败 ' + r.errors.length + ' 张' : '';
      finishExport('导出完成，共 ' + r.done + ' 张' + fail);
    },
    onCancelled: (done) => {
      finishExport('已取消，已完成 ' + done + ' 张');
    },
    onError: (msg) => {
      setStatus('导出出错：' + msg);
    },
  });

  exportController.start(
    photos.map((photo, i) => ({
      id: photo.id,
      file: photo.file,
      // 验收修复：开跑即快照设置，防止导出中途改控件影响未派发任务
      settings: Object.assign({}, effectiveSettings(photo)),
      seq: i + 1,
    })),
    {
      template: state.settings.export.nameTemplate,
      format: state.settings.export.format,
      jpgQuality: state.settings.export.jpgQuality,
      resizeLongEdge: +state.settings.export.resizeLongEdge,
      dirHandle,
      fallbackDownload: fallback,
    }
  );
}

function finishExport(msg) {
  exporting = false;
  exportController = null;
  setExportUILock(false);
  el['export-progress'].classList.remove('show');
  setStatus(msg);
}

/* ═══════════════════ 事件绑定 ═══════════════════ */

function bindEvents() {
  // 导入
  el['btn-import-files'].addEventListener('click', () => el['file-input'].click());
  el['file-input'].addEventListener('change', () => {
    importFiles(el['file-input'].files);
    el['file-input'].value = '';
  });
  el['btn-import-folder'].addEventListener('click', () => el['folder-input'].click());
  el['folder-input'].addEventListener('change', () => {
    importFiles(el['folder-input'].files);
    el['folder-input'].value = '';
  });

  // 拖放导入
  let dragDepth = 0;
  window.addEventListener('dragenter', (e) => {
    e.preventDefault();
    dragDepth++;
    document.getElementById('app').classList.add('drop-active');
  });
  window.addEventListener('dragover', (e) => e.preventDefault());
  window.addEventListener('dragleave', (e) => {
    e.preventDefault();
    dragDepth = Math.max(0, dragDepth - 1);
    if (dragDepth === 0) document.getElementById('app').classList.remove('drop-active');
  });
  window.addEventListener('drop', (e) => {
    e.preventDefault();
    dragDepth = 0;
    document.getElementById('app').classList.remove('drop-active');
    if (e.dataTransfer && e.dataTransfer.files.length) {
      importFiles(e.dataTransfer.files);
    }
  });

  // 缩略图：普通点击设当前照片；Ctrl/Cmd 点击切换 selected；徽章点击应用/撤销避让
  el['photo-list'].addEventListener('click', (e) => {
    const badge = e.target.closest('.photo-suggest');
    if (badge) {
      const item = badge.closest('.photo-item');
      const photo = item && state.photos.find((p) => p.id === item.dataset.id);
      if (photo) toggleAvoidApply(photo);
      return;
    }
    const item = e.target.closest('.photo-item');
    if (!item) return;
    const photo = state.photos.find((p) => p.id === item.dataset.id);
    if (!photo) return;
    if (e.ctrlKey || e.metaKey) {
      photo.selected = !photo.selected;
      updateItemStatus(photo);
    } else {
      selectPhoto(photo.id);
    }
  });

  // 批量栏
  el['btn-select-all'].addEventListener('click', () => {
    for (const p of state.photos) p.selected = true;
    refreshSelectionUI();
  });
  el['btn-clear'].addEventListener('click', () => {
    if (exporting) return;
    for (const p of state.photos) disposePhoto(p);
    state.photos = [];
    state.currentPhotoId = null;
    state.userScale = 1;
    lastFit = null;
    el['photo-list'].querySelectorAll('.photo-item').forEach((n) => n.remove());
    updatePhotoCount();
    updateRailEmpty();
    updateResetBtn();
    syncControlDisplay();
    scheduleRender();
  });

  // 画布工具
  el['btn-prev-photo'].addEventListener('click', () => {
    const idx = state.photos.findIndex((p) => p.id === state.currentPhotoId);
    if (idx > 0) selectPhoto(state.photos[idx - 1].id);
  });
  el['btn-next-photo'].addEventListener('click', () => {
    const idx = state.photos.findIndex((p) => p.id === state.currentPhotoId);
    if (idx >= 0 && idx < state.photos.length - 1) selectPhoto(state.photos[idx + 1].id);
  });
  el['zoom-fit'].addEventListener('click', () => {
    state.userScale = 1;
    state.viewX = 0;
    state.viewY = 0;
    scheduleRender();
  });
  el['zoom-100'].addEventListener('click', () => {
    const photo = currentPhoto();
    if (!photo || !photo.bitmap) return;
    const cssW = el['preview-canvas'].clientWidth;
    const cssH = el['preview-canvas'].clientHeight;
    const fit = computeFitRect(cssW, cssH, photo.bitmap.width, photo.bitmap.height);
    state.userScale = fit.k > 0 ? 1 / fit.k : 1;
    scheduleRender();
  });

  // 预设卡片（含自定义）
  el['preset-list'].addEventListener('click', (e) => {
    if (e.target.closest('.preset-del')) return; // 删除键有自己的处理
    const card = e.target.closest('.preset-card');
    if (!card) return;
    setControl('preset', card.dataset.preset);
  });
  el['btn-import-mark'].addEventListener('click', () => el['mark-input'].click());
  el['mark-input'].addEventListener('change', () => {
    const f = el['mark-input'].files[0];
    if (f) importCustomMark(f);
    el['mark-input'].value = '';
  });

  // 找素材（Iconify）
  el['btn-find-assets'].addEventListener('click', openFindAssets);
  el['find-assets-close'].addEventListener('click', closeFindAssets);
  el['find-assets-search'].addEventListener('click', searchIconify);
  el['find-assets-input'].addEventListener('keydown', (e) => {
    if (e.key === 'Enter') searchIconify();
    if (e.key === 'Escape') closeFindAssets();
  });
  el['find-assets-modal'].addEventListener('mousedown', (e) => {
    if (e.target === el['find-assets-modal']) closeFindAssets(); // 点遮罩关闭
  });
  // 签名合成
  el['modal-compose'].querySelectorAll('.font-chip').forEach((chip) => {
    chip.addEventListener('click', () => {
      el['modal-compose'].querySelectorAll('.font-chip').forEach((c) => c.classList.remove('active'));
      chip.classList.add('active');
      renderComposePreview();
    });
  });
  el['compose-text'].addEventListener('input', renderComposePreview);
  el['compose-add'].addEventListener('click', () => composeAndRegister('full'));
  el['compose-text-only'].addEventListener('click', () => composeAndRegister('text'));
  el['compose-icon-only'].addEventListener('click', () => composeAndRegister('icon'));
  el['compose-gap'].addEventListener('input', () => {
    el['compose-gap-val'].textContent = el['compose-gap'].value;
    renderComposePreview();
  });
  el['compose-vshift'].addEventListener('input', () => {
    el['compose-vshift-val'].textContent = el['compose-vshift'].value;
    renderComposePreview();
  });

  // 九宫格
  el['anchor-grid'].addEventListener('click', (e) => {
    const btn = e.target.closest('button[data-anchor]');
    if (!btn) return;
    setControl('anchor', btn.dataset.anchor);
  });

  // 滑杆
  for (const b of CONTROL_BINDINGS) {
    el[b.input].addEventListener('input', () => {
      setControl(b.key, +el[b.input].value);
    });
  }

  // 发光开关
  el['glow-toggle'].addEventListener('change', () => {
    setControl('glow', el['glow-toggle'].checked);
  });

  // 批量模式
  el['apply-all'].addEventListener('change', () => {
    state.settings.applyAll = el['apply-all'].checked;
    updateResetBtn();
    syncControlDisplay();
    saveSettings();
    scheduleRender();
  });
  el['btn-reset-photo'].addEventListener('click', () => {
    const photo = currentPhoto();
    if (!photo) return;
    photo.override = null;
    updateResetBtn();
    syncControlDisplay();
    saveSettings();
    scheduleRender();
  });

  // 智能避让开关（Phase 2）：开 → 全量补检缺失 grid 的存量照片；关 → 隐藏徽章、避让层失效
  el['smart-avoid'].addEventListener('change', () => {
    state.settings.smartAvoid = el['smart-avoid'].checked;
    saveSettings();
    if (state.settings.smartAvoid) {
      for (const p of state.photos) enqueueDetect(p);
    }
    updateAllAvoidBadges();
    scheduleRender();
  });

  // 导出设置
  el['export-format'].addEventListener('change', () => {
    state.settings.export.format = el['export-format'].value;
    saveSettings();
  });
  el['jpg-quality'].addEventListener('input', () => {
    state.settings.export.jpgQuality = +el['jpg-quality'].value;
    el['jpg-quality-val'].textContent = String(state.settings.export.jpgQuality);
    saveSettings();
  });
  el['resize-long-edge'].addEventListener('change', () => {
    state.settings.export.resizeLongEdge = +el['resize-long-edge'].value;
    saveSettings();
  });
  el['filename-template'].addEventListener('change', () => {
    state.settings.export.nameTemplate = el['filename-template'].value.trim() || '{name}_wm';
    el['filename-template'].value = state.settings.export.nameTemplate;
    saveSettings();
  });

  // 输出目录
  el['btn-choose-output'].addEventListener('click', chooseOutput);

  // 导出
  el['btn-export'].addEventListener('click', startExport);
  el['btn-cancel-export'].addEventListener('click', () => {
    if (exportController) {
      exportController.cancel();
      setStatus('正在取消…');
    }
  });

  // 画布拖拽 + 滚轮缩放
  el['preview-canvas'].addEventListener('mousedown', onCanvasMouseDown);
  window.addEventListener('mousemove', onWindowMouseMove);
  window.addEventListener('mouseup', onWindowMouseUp);
  el['preview-canvas'].addEventListener('wheel', onCanvasWheel, { passive: false });

  // 舞台尺寸变化（窗口缩放等）→ 重渲染
  const ro = new ResizeObserver(() => scheduleRender());
  ro.observe(el['preview-stage']);
}

/* ═══════════════════ 启动 ═══════════════════ */

function syncControlsFromSettings() {
  const eff = effectiveSettings(currentPhoto());
  for (const b of CONTROL_BINDINGS) {
    el[b.input].value = eff[b.key];
    el[b.val].textContent = b.fmt(eff[b.key]);
  }
  el['glow-toggle'].checked = !!eff.glow;
  updateAnchorUI(eff.anchor);
  updatePresetUI(eff.preset);
  el['export-format'].value = state.settings.export.format;
  el['jpg-quality'].value = state.settings.export.jpgQuality;
  el['jpg-quality-val'].textContent = String(state.settings.export.jpgQuality);
  el['resize-long-edge'].value = String(state.settings.export.resizeLongEdge);
  el['filename-template'].value = state.settings.export.nameTemplate;
}

async function init() {
  await loadEdition();
  loadSettings();
  renderBuiltinCards();
  updatePresetEmptyHint();
  if (edition.value === 'friend') {
    // 通用版：无内置预设，签名框留空；持久化里若存着内置 id 一律清空
    if (!state.settings.preset || !state.settings.preset.startsWith('mark_')) {
      state.settings.preset = state.settings.customMarks[0] ? state.settings.customMarks[0].id : null;
    }
    el['compose-text'].value = '';
    el['compose-text'].placeholder = '输入你的名字';
  }
  // canvas 撑满舞台（CSS 未给尺寸，运行时内联设置，不动 styles.css）
  el['preview-canvas'].style.width = '100%';
  el['preview-canvas'].style.height = '100%';
  syncControlsFromSettings();
  el['smart-avoid'].checked = !!state.settings.smartAvoid;
  updateOutputLabel();
  updatePhotoCount();
  updateRailEmpty();
  updateResetBtn();
  bindEvents();
  // 恢复自定义水印（IndexedDB），完成后回显预设选中态
  restoreCustomMarks().then(() => {
    updatePresetUI(state.settings.preset);
    syncControlDisplay();
  });
  // 预热默认预设素材，缩短首次预览等待
  if (state.settings.preset) resolveMarkBitmap(state.settings.preset).catch(() => {});
  setStatus('就绪');
}

init();
