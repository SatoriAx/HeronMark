/*!
 * update.js — 更新检查 / 下载 / 应用（对接 src-tauri 的 update 模块）
 *
 * 交互原则（移植自 LightTranslate App.xaml.cs）：
 *   - 启动后台静默检查，发现新版本仅提醒、不自动下载；
 *   - 手动「检查更新」入口带进度与结果反馈；
 *   - 下载完成后由用户确认才 apply_update（重启应用）。
 *
 * 依赖 Tauri v2 全局 API（window.__TAURI__，withGlobalTauri）；
 * 纯浏览器预览无该 API 时按钮保持隐藏、不启动任何检查。
 */
const PROGRESS_EVENT = 'hm-download-progress';
const SILENT_CHECK_DELAY_MS = 6000;

const updateState = {
  available: null,   // check_update 结果：{ current_version, latest_version, tag }
  downloading: false,
  unlisten: null,
};

function tauri() { return window.__TAURI__; }
function invoke(cmd, args) { return tauri().core.invoke(cmd, args); }

function hintEl() { return document.getElementById('update-hint'); }
function btnEl() { return document.getElementById('btn-check-update'); }
function statusEl() { return document.getElementById('status-text'); }

function setStatus(text) {
  if (statusEl()) statusEl().textContent = text;
}

/** 非侵入提示条：文字 + 操作按钮组（statusbar 内胶囊样式） */
function showHint(text, actions) {
  const hint = hintEl();
  if (!hint) return;
  hint.textContent = '';
  const span = document.createElement('span');
  span.textContent = text;
  hint.append(span);
  for (const a of actions || []) {
    const b = document.createElement('button');
    b.className = 'hint-action';
    b.textContent = a.label;
    b.addEventListener('click', a.action);
    hint.append(b);
  }
  hint.hidden = false;
}

function hideHint() {
  if (hintEl()) hintEl().hidden = true;
}

function showAvailable(result) {
  updateState.available = result;
  showHint(`发现新版本 v${result.latest_version}（当前 v${result.current_version}）`, [
    { label: '下载', action: startDownload },
    { label: '忽略', action: hideHint },
  ]);
}

export function initUpdate() {
  if (!tauri()) return; // 浏览器预览：无 Tauri API，不启用更新 UI
  const btn = btnEl();
  if (!btn) return;
  btn.hidden = false;
  btn.addEventListener('click', onManualCheck);
  // 启动后台静默检查（延迟 6s，避免启动期抢网络；仅提醒不自动下载）
  setTimeout(silentCheck, SILENT_CHECK_DELAY_MS);
}

async function silentCheck() {
  try {
    const r = await invoke('check_update');
    if (r && r.has_update) showAvailable(r);
  } catch { /* 静默失败：不打扰用户 */ }
}

async function onManualCheck() {
  const btn = btnEl();
  btn.disabled = true;
  btn.textContent = '检查中…';
  showHint('正在检查更新…', []);   // 等待期反馈：按钮旁即时可见
  try {
    const r = await invoke('check_update');
    if (r && r.has_update) {
      showAvailable(r);
      setStatus(`发现新版本 v${r.latest_version}`);
    } else if (r) {
      // 结果用 hint 胶囊条呈现（按钮旁），不再只写状态栏远端小字
      showHint(`已是最新版本 v${r.current_version}`, [{ label: '好的', action: hideHint }]);
      setStatus(`已是最新版本 v${r.current_version}`);
    } else {
      showHint('检查更新失败（无返回结果）', [{ label: '重试', action: onManualCheck }, { label: '忽略', action: hideHint }]);
      setStatus('检查更新失败（无返回结果）');
    }
  } catch (e) {
    showHint('检查更新失败：' + ((e && e.message) || e), [{ label: '重试', action: onManualCheck }, { label: '忽略', action: hideHint }]);
    setStatus('检查更新失败：' + ((e && e.message) || e));
  } finally {
    btn.disabled = false;
    btn.textContent = '检查更新';
  }
}

async function startDownload() {
  if (!updateState.available || updateState.downloading) return;
  const { tag, latest_version: latestVersion } = updateState.available;
  updateState.downloading = true;
  hideHint();
  showHint(`正在下载 v${latestVersion} 0%…`, []);
  btnEl().disabled = true;

  try {
    updateState.unlisten = await tauri().event.listen(PROGRESS_EVENT, (e) => {
      const { done, total } = e.payload || {};
      const pct = total ? Math.round((done / total) * 100) : (done || 0);
      showHint(`正在下载 v${latestVersion} ${pct}%…`, []);
    });

    const r = await invoke('download_update', { tag });
    if (r && r.path) {
      showHint(`下载完成（v${latestVersion}），重启应用以完成更新`, [
        { label: '重启更新', action: applyUpdate },
        { label: '稍后', action: hideHint },
      ]);
      setStatus(`新版本 v${latestVersion} 已就绪`);
    }
  } catch (e) {
    hideHint();
    showHint('下载失败，可稍后重试', [{ label: '重试', action: startDownload }, { label: '忽略', action: hideHint }]);
    setStatus('下载失败：' + ((e && e.message) || e));
  } finally {
    updateState.downloading = false;
    btnEl().disabled = false;
    if (updateState.unlisten) { updateState.unlisten(); updateState.unlisten = null; }
  }
}

async function applyUpdate() {
  try {
    setStatus('正在应用更新…');
    await invoke('apply_update');
    // 正常情况下主进程随即退出，由更新器完成替换并重启，这里不会继续执行
  } catch (e) {
    setStatus('应用更新失败：' + ((e && e.message) || e));
  }
}
