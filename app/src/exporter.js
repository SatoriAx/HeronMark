/*!
 * exporter.js — 批量导出调度
 * Worker 池并行渲染 → 文件名模板解析与冲突处理 → FS Access 写盘（降级为逐张下载）→ 进度与取消。
 * 合成数学不在本文件：Worker 内部 import render.js 的唯一实现。
 */

/**
 * 文件名模板解析：{name} 原名无扩展、{seq} 序号 3 位、{date} 日期 YYYYMMDD。
 * @param {string} template 模板，如 '{name}_wm'
 * @param {{name:string, seq:number, date:string}} vars
 * @returns {string} 不含扩展名的主体
 */
export function buildFileName(template, vars) {
  return template
    .replace(/\{name\}/g, vars.name)
    .replace(/\{seq\}/g, String(vars.seq).padStart(3, '0'))
    .replace(/\{date\}/g, vars.date);
}

/** 今日日期戳 YYYYMMDD（本地时区） */
export function todayStamp() {
  const d = new Date();
  const p = (n) => String(n).padStart(2, '0');
  return '' + d.getFullYear() + p(d.getMonth() + 1) + p(d.getDate());
}

/**
 * 按导出格式解析扩展名与 MIME 类型。
 * 'follow' 跟随原图扩展名；jpg/png 强制指定。
 * @param {string} format 'follow' | 'jpg' | 'png'
 * @param {string} originalName 原文件名（用于 follow 推断）
 * @returns {{ext:string, mime:string}}
 */
export function formatSpec(format, originalName) {
  if (format === 'jpg') return { ext: 'jpg', mime: 'image/jpeg' };
  if (format === 'png') return { ext: 'png', mime: 'image/png' };
  // 跟随原图
  const m = /\.([A-Za-z0-9]+)$/.exec(originalName);
  const e = m ? m[1].toLowerCase() : 'jpg';
  if (e === 'png') return { ext: 'png', mime: 'image/png' };
  if (e === 'webp') return { ext: 'webp', mime: 'image/webp' };
  return { ext: 'jpg', mime: 'image/jpeg' }; // jpg/jpeg 及其他一律按 JPEG
}

/**
 * 在已用名集合内生成不冲突的文件名：冲突自动追加 -2、-3……
 * @param {Set<string>} used 已用文件名集合（会被修改）
 * @param {string} base 文件名主体（不含扩展名）
 * @param {string} ext 扩展名（不含点）
 * @returns {string}
 */
export function uniqueFileName(used, base, ext) {
  let name = `${base}.${ext}`;
  let n = 2;
  while (used.has(name)) {
    name = `${base}-${n}.${ext}`;
    n++;
  }
  used.add(name);
  return name;
}

/** 逐张下载降级方案：创建 <a download> 触发浏览器保存 */
function downloadBlob(blob, filename) {
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  // 延迟释放，避免下载未开始就失效
  setTimeout(() => URL.revokeObjectURL(url), 30000);
}

/** 通过 File System Access API 写入目录句柄（同名覆盖，冲突名已在上游处理） */
async function writeFileToDir(dirHandle, filename, blob) {
  const fh = await dirHandle.getFileHandle(filename, { create: true });
  const w = await fh.createWritable();
  await w.write(blob);
  await w.close();
}

/**
 * 导出控制器：Worker 池 + 任务队列 + 写盘 + 进度/取消。
 * 用法：
 *   const c = new ExportController({ workerCount, markBitmaps, onProgress, onDone, onCancelled, onError });
 *   c.start(jobs, opts);
 *   c.cancel();  // 队列停发，在跑的任务跑完即丢弃结果
 */
export class ExportController {
  /**
   * @param {object} p
   * @param {number} p.workerCount Worker 数量
   * @param {Map<string, ImageBitmap>} p.markBitmaps 水印素材位图池（presetId → 位图，结构化克隆进每个 Worker）
   * @param {(done:number, total:number)=>void} [p.onProgress]
   * @param {(r:{done:number,total:number,errors:string[]})=>void} [p.onDone]
   * @param {(done:number)=>void} [p.onCancelled]
   * @param {(message:string)=>void} [p.onError]
   */
  constructor({ workerCount, markBitmaps, onProgress, onDone, onCancelled, onError }) {
    this.workerCount = workerCount;
    this.markBitmaps = markBitmaps;
    this.onProgress = onProgress;
    this.onDone = onDone;
    this.onCancelled = onCancelled;
    this.onError = onError;
    /** @type {Worker[]} */
    this.workers = [];
    /** @type {Worker[]} 已完成素材初始化的空闲 Worker */
    this.idleWorkers = [];
    this.jobs = [];
    this.cursor = 0;   // 下一个待派发的任务下标
    this.busy = 0;     // 在跑任务数
    this.done = 0;     // 已写盘/已下载数
    this.cancelled = false;
    this.finished = false;
    this.errors = [];
    this.opts = null;
    this.pendingWrites = 0; // 已渲染完成但尚未落盘的结果数（收尾必须等它归零）
  }

  /**
   * 开始导出。
   * @param {Array<{id:string, file:File, settings:object}>} jobs 顺序即导出顺序（seq 按此分配）
   * @param {object} opts
   * @param {string} opts.template 文件名模板
   * @param {string} opts.format 'follow' | 'jpg' | 'png'
   * @param {number} opts.jpgQuality JPG 质量 60~100
   * @param {number} opts.resizeLongEdge 长边缩放（0 = 不缩放）
   * @param {FileSystemDirectoryHandle|null} opts.dirHandle 输出目录句柄（null 时逐张下载）
   * @param {boolean} opts.fallbackDownload 强制使用逐张下载降级
   */
  async start(jobs, opts) {
    this.jobs = jobs;
    this.opts = opts;

    // 预分配文件名（顺序即 seq），同时收集目录内已有文件名防冲突
    const used = new Set();
    await this.precollectUsedNames(used);
    for (let i = 0; i < jobs.length; i++) {
      const job = jobs[i];
      const spec = formatSpec(opts.format, job.file.name);
      job.mime = spec.mime;
      const base = buildFileName(opts.template, {
        name: job.file.name.replace(/\.[^.]+$/, ''),
        seq: i + 1,
        date: todayStamp(),
      });
      job.filename = uniqueFileName(used, base, spec.ext);
      job.presetId = job.settings.preset;
    }

    // 创建 Worker 池并注入素材
    for (let i = 0; i < this.workerCount; i++) {
      this.spawnWorker();
    }
  }

  /** 收集输出目录内已存在的文件名，避免覆盖旧文件（仅 FS Access 路径） */
  async precollectUsedNames(used) {
    const dir = this.opts.dirHandle;
    if (!dir) return;
    try {
      for await (const [name] of dir.entries()) used.add(name);
    } catch { /* 目录不可枚举时忽略，冲突处理退化为会话内去重 */ }
  }

  /** 创建并初始化一个 Worker */
  spawnWorker() {
    const worker = new Worker(new URL('./export-worker.js', import.meta.url), { type: 'module' });
    worker.onmessage = (ev) => this.onWorkerMessage(worker, ev.data);
    worker.onerror = (ev) => {
      this.onError && this.onError('Worker 异常：' + (ev.message || '未知错误'));
      this.onWorkerDone(worker);
    };
    this.workers.push(worker);
    // 注入全部素材（结构化克隆，主线程保留原件）
    for (const [id, bitmap] of this.markBitmaps) {
      worker.postMessage({ type: 'init-mark', id, bitmap, expected: this.markBitmaps.size });
    }
  }

  onWorkerMessage(worker, msg) {
    if (msg.type === 'mark-ready') {
      this.idleWorkers.push(worker);
      this.pump();
      return;
    }
    if (msg.type === 'done') {
      // 验收修复：先登记在途写盘，再让 Worker 归位续跑；收尾必须等写盘归零
      this.pendingWrites++;
      this.handleResult(msg.id, msg.blob).finally(() => {
        this.pendingWrites--;
        this.maybeFinish();
      });
      this.onWorkerDone(worker);
      return;
    }
    if (msg.type === 'error') {
      this.onWorkerDone(worker);
      this.errors.push(msg.message || '未知错误');
      this.onError && this.onError(msg.message || '未知错误');
      return;
    }
  }

  /** 一个任务结束（无论成败），Worker 回到空闲池并继续派发 */
  onWorkerDone(worker) {
    this.busy = Math.max(0, this.busy - 1); // 验收修复：worker.onerror 在空闲时也可能触发，防负值死锁
    if (!this.cancelled) {
      this.idleWorkers.push(worker);
      this.pump();
    } else {
      this.maybeFinish();
    }
  }

  /** 从队列派发任务给空闲 Worker；取消后停发 */
  pump() {
    if (this.finished) return;
    while (this.cursor < this.jobs.length && this.idleWorkers.length > 0 && !this.cancelled) {
      const worker = this.idleWorkers.shift();
      const job = this.jobs[this.cursor++];
      this.busy++;
      worker.postMessage({
        type: 'render',
        id: job.id,
        file: job.file,
        settings: job.settings,
        presetId: job.presetId,
        resizeLongEdge: this.opts.resizeLongEdge,
        mime: job.mime,
        quality: this.opts.jpgQuality / 100, // convertToBlob 的 quality 域是 0~1，设置面板是 60~100
      });
    }
    this.maybeFinish();
  }

  /** 处理一个完成结果：写盘或下载（取消后丢弃不写） */
  async handleResult(id, blob) {
    const job = this.jobs.find((j) => j.id === id);
    try {
      if (!job) return;
      if (this.cancelled) return; // 取消后结果丢弃
      if (this.opts.fallbackDownload || !this.opts.dirHandle) {
        downloadBlob(blob, job.filename);
      } else {
        await writeFileToDir(this.opts.dirHandle, job.filename, blob);
      }
      this.done++;
      this.onProgress && this.onProgress(this.done, this.jobs.length);
      this.maybeFinish();
    } catch (err) {
      this.errors.push('写盘失败：' + job.filename + '（' + ((err && err.message) || err) + '）');
      this.onError && this.onError('写盘失败：' + job.filename);
      this.maybeFinish();
    }
  }

  /** 全部派发、无在跑任务且无在途写盘时收尾 */
  maybeFinish() {
    if (this.finished) return;
    if (this.cursor >= this.jobs.length && this.busy === 0 && this.pendingWrites === 0) {
      this.finished = true;
      this.teardown();
      if (this.cancelled) {
        this.onCancelled && this.onCancelled(this.done);
      } else {
        this.onDone && this.onDone({ done: this.done, total: this.jobs.length, errors: this.errors });
      }
    }
  }

  /** 取消导出：停发新任务，在跑任务跑完即丢弃 */
  cancel() {
    if (this.finished) return;
    this.cancelled = true;
    this.maybeFinish();
  }

  /** 释放 Worker 池 */
  teardown() {
    for (const w of this.workers) {
      w.onmessage = null;
      w.onerror = null;
      w.terminate();
    }
    this.workers = [];
    this.idleWorkers = [];
  }
}
