//! 更新模块：GitHub Releases 检查 / 下载 / 应用
//!
//! 机制移植自 LightTranslate.UpdateService.cs：
//! GET https://github.com/{Repo}/releases/latest 不跟随重定向 → 从 Location 解析 tag
//! → 版本比较（数字元组）→ 下载 {exe} 与 {exe}.sha256 → SHA-256 校验（64 位十六进制，
//! 大小写不敏感；sha256 缺失/格式异常时跳过校验）→ 写 marker + 解出内嵌更新器 → 退出，
//! 由 heronmark_updater 完成备份/替换/重启。
//!
//! 构建顺序（重要）：主程序编译期把更新器嵌入自身，必须先运行 tools\build-updater.ps1
//! 生成 src-tauri\resources\heronmark_updater.exe，再构建主程序（build.rs 有防呆检查）。

use std::path::{Path, PathBuf};
use std::sync::OnceLock;
use std::time::Duration;

use serde::Serialize;
use sha2::{Digest, Sha256};
use tauri::Emitter;

/// 仓库与资产命名（发布产物约定，勿改）
pub const REPO: &str = "SatoriAx/HeronMark";
pub const ASSET_EXE: &str = "HeronMark-windows-x64.exe";
pub const ASSET_SHA: &str = "HeronMark-windows-x64.exe.sha256";
pub const MAIN_PROCESS_NAME: &str = "heronmark";
pub const UPDATER_TEMP_DIR: &str = "HeronMark-update";
pub const UPDATER_EXE: &str = "heronmark_updater.exe";

/// 内嵌更新器字节。由 main.rs 启动时注入（include_bytes! 放在主 bin，避免首次
/// 构建 updater 时因资源缺失导致 lib 编译死锁——先有鸡还是先有蛋）。
pub static UPDATER_BYTES: OnceLock<&'static [u8]> = OnceLock::new();

/// 更新器 marker（%Temp%\HeronMark-update\update.json），
/// 字段与 src/bin/heronmark_updater.rs 严格对齐（snake_case）。
#[derive(Debug, Clone, Serialize, serde::Deserialize)]
pub struct UpdateMarker {
    pub new_exe: String,
    pub target_exe: String,
    pub backup_exe: String,
    pub main_process_name: String,
    pub restart: bool,
}

#[derive(Debug, Clone, Serialize)]
pub struct UpdateInfo {
    pub version: String,
    pub tag: String,
    pub exe_url: String,
    pub sha_url: String,
}

#[derive(Debug, Clone, Serialize)]
pub struct CheckResult {
    pub current_version: String,
    pub latest_version: Option<String>,
    pub tag: Option<String>,
    pub has_update: bool,
}

#[derive(Debug, Clone, Serialize)]
pub struct DownloadProgress {
    pub done: u64,
    pub total: u64,
}

#[derive(Debug, Clone, Serialize)]
pub struct DownloadResult {
    pub path: String,
}

/// 检查用 client：25s 超时、禁止重定向（靠 Location 头解析 tag）
fn check_client() -> &'static reqwest::Client {
    static C: OnceLock<reqwest::Client> = OnceLock::new();
    C.get_or_init(|| {
        reqwest::Client::builder()
            .redirect(reqwest::redirect::Policy::none())
            .timeout(Duration::from_secs(25))
            .user_agent(concat!("HeronMark/", env!("CARGO_PKG_VERSION"), " (auto-update)"))
            .build()
            .expect("检查用 HTTP client 构建失败")
    })
}

/// 下载用 client：10 分钟总超时（模板 10min）
fn download_client() -> &'static reqwest::Client {
    static C: OnceLock<reqwest::Client> = OnceLock::new();
    C.get_or_init(|| {
        reqwest::Client::builder()
            .timeout(Duration::from_secs(10 * 60))
            .user_agent(concat!("HeronMark/", env!("CARGO_PKG_VERSION"), " (auto-update)"))
            .build()
            .expect("下载用 HTTP client 构建失败")
    })
}

/// "x.y.z" → (x,y,z)；容忍 v 前缀与缺段（1 / 1.2）
pub fn parse_version(s: &str) -> Option<(u64, u64, u64)> {
    let s = s.trim().trim_start_matches('v');
    let mut it = s.split('.');
    Some((
        it.next()?.parse().ok()?,
        it.next().unwrap_or("0").parse().unwrap_or(0),
        it.next().unwrap_or("0").parse().unwrap_or(0),
    ))
}

/// 检查更新核心逻辑（command 与 update_probe 共用）
pub async fn check_impl(current_version: &str) -> Result<Option<UpdateInfo>, String> {
    let resp = check_client()
        .get(format!("https://github.com/{REPO}/releases/latest"))
        .send()
        .await
        .map_err(|e| format!("检查更新网络错误: {e}"))?;

    if !(300..400).contains(&resp.status().as_u16()) {
        return Ok(None); // 非重定向（404 无 release / 200 等）→ 视为无更新
    }
    let location = resp
        .headers()
        .get(reqwest::header::LOCATION)
        .and_then(|v| v.to_str().ok())
        .unwrap_or_default()
        .to_string();
    if !location.contains("/tag/") {
        return Ok(None);
    }
    let tag = location
        .trim_end_matches('/')
        .rsplit('/')
        .next()
        .unwrap_or_default()
        .to_string();
    let version = tag.trim_start_matches('v').to_string();

    let (Some(cur), Some(remote)) = (parse_version(current_version), parse_version(&version)) else {
        return Ok(None);
    };
    if remote <= cur {
        return Ok(None); // 模板：仅严格大于才提示更新
    }

    Ok(Some(UpdateInfo {
        version,
        exe_url: format!("https://github.com/{REPO}/releases/download/{tag}/{ASSET_EXE}"),
        sha_url: format!("https://github.com/{REPO}/releases/download/{tag}/{ASSET_SHA}"),
        tag,
    }))
}

/// 拉取 sha256 旁挂文件；缺失/失败 → 空串（模板：跳过校验）
async fn fetch_sha256(tag: &str) -> String {
    match download_client()
        .get(format!("https://github.com/{REPO}/releases/download/{tag}/{ASSET_SHA}"))
        .send()
        .await
    {
        Ok(resp) if resp.status().is_success() => {
            resp.text().await.unwrap_or_default().trim().to_string()
        }
        _ => String::new(),
    }
}

fn sha256_hex(path: &Path) -> Result<String, String> {
    let bytes = std::fs::read(path).map_err(|e| format!("读取 {path:?} 失败: {e}"))?;
    Ok(Sha256::digest(&bytes)
        .iter()
        .map(|b| format!("{b:02x}"))
        .collect())
}

/// 下载核心逻辑：exe → {exe}.new.tmp（进度回调）→ SHA-256 校验 → rename {exe}.new；
/// 失败清理 tmp。on_progress(done, total) 按字节回报。
pub async fn download_impl(
    tag: &str,
    target_dir: &Path,
    on_progress: &mut (dyn FnMut(u64, u64) + Send),
) -> Result<PathBuf, String> {
    use tokio::io::AsyncWriteExt;

    std::fs::create_dir_all(target_dir).map_err(|e| format!("创建目录失败: {e}"))?;
    let temp_exe = target_dir.join(format!("{ASSET_EXE}.new.tmp"));
    let new_exe = target_dir.join(format!("{ASSET_EXE}.new"));

    let result = (async {
        let mut resp = download_client()
            .get(format!(
                "https://github.com/{REPO}/releases/download/{tag}/{ASSET_EXE}"
            ))
            .send()
            .await
            .map_err(|e| format!("下载网络错误: {e}"))?;
        resp.error_for_status_ref()
            .map_err(|e| format!("下载失败（HTTP {}）", e.status().map(|s| s.as_u16()).unwrap_or(0)))?;

        let total = resp.content_length().unwrap_or(0);
        let mut file = tokio::fs::File::create(&temp_exe)
            .await
            .map_err(|e| format!("创建临时文件失败: {e}"))?;
        let mut done: u64 = 0;
        while let Some(chunk) = resp.chunk().await.map_err(|e| format!("下载中断: {e}"))? {
            file.write_all(&chunk)
                .await
                .map_err(|e| format!("写入临时文件失败: {e}"))?;
            done += chunk.len() as u64;
            if total > 0 {
                on_progress(done, total);
            }
        }
        drop(file);

        let expected = fetch_sha256(tag).await;
        if expected.len() == 64 {
            let actual = sha256_hex(&temp_exe)?;
            if !actual.eq_ignore_ascii_case(&expected) {
                return Err(format!(
                    "SHA-256 校验不匹配，已中止更新：期望 {expected}，实际 {actual}"
                ));
            }
        } else if !expected.is_empty() {
            // 格式异常（如 shasum 带文件名行）→ 跳过校验并记录行为
            eprintln!(
                "[heronmark-update] sha256 文件内容非 64 位十六进制（{} 字节），跳过校验",
                expected.len()
            );
        }
        // sha256 缺失（远端未发布旁挂文件）→ 跳过校验（v1.0.0 即此情况）

        std::fs::rename(&temp_exe, &new_exe).map_err(|e| format!("移动临时文件失败: {e}"))?;
        Ok(new_exe)
    })
    .await;

    if result.is_err() {
        let _ = std::fs::remove_file(&temp_exe); // 失败清理临时文件
    }
    result
}

/// 当前 exe 所在目录（更新文件与 updater 替换都在这里）
fn exe_dir() -> Result<PathBuf, String> {
    let exe = std::env::current_exe().map_err(|e| format!("无法定位当前程序路径: {e}"))?;
    Ok(exe
        .parent()
        .map(|p| p.to_path_buf())
        .unwrap_or_else(|| PathBuf::from(".")))
}

/* ═══════════════════ Tauri commands ═══════════════════ */

/// 检查更新：返回当前版本 / 最新版本 / 是否有新版。当前版本取 Cargo 包版本。
#[tauri::command]
pub async fn check_update() -> Result<CheckResult, String> {
    let current = env!("CARGO_PKG_VERSION").to_string();
    match check_impl(&current).await {
        Ok(Some(info)) => Ok(CheckResult {
            current_version: current,
            latest_version: Some(info.version),
            tag: Some(info.tag),
            has_update: true,
        }),
        Ok(None) => Ok(CheckResult {
            current_version: current,
            latest_version: None,
            tag: None,
            has_update: false,
        }),
        Err(e) => Err(e),
    }
}

/// 下载指定 tag 的发布资产到 exe 同级目录，进度经 hm-download-progress 事件广播。
#[tauri::command]
pub async fn download_update(app: tauri::AppHandle, tag: String) -> Result<DownloadResult, String> {
    let dir = exe_dir()?;
    let mut on_progress = |done: u64, total: u64| {
        let _ = app.emit("hm-download-progress", DownloadProgress { done, total });
    };
    let path = download_impl(&tag, &dir, &mut on_progress).await?;
    Ok(DownloadResult {
        path: path.display().to_string(),
    })
}

/// 应用更新：写 marker json + 解出内嵌更新器到 %Temp%\HeronMark-update\，
/// 启动更新器后主进程退出（由更新器完成 备份 → 替换 → 重启）。
#[tauri::command]
pub fn apply_update() -> Result<(), String> {
    let updater_bytes = UPDATER_BYTES.get().ok_or("更新器未注入（构建流程错误）")?;

    let target_exe = std::env::current_exe().map_err(|e| format!("无法定位当前程序路径: {e}"))?;
    let updater_dir = std::env::temp_dir().join(UPDATER_TEMP_DIR);
    std::fs::create_dir_all(&updater_dir).map_err(|e| format!("创建更新目录失败: {e}"))?;

    let marker = UpdateMarker {
        new_exe: exe_dir()?.join(format!("{ASSET_EXE}.new")).display().to_string(),
        target_exe: target_exe.display().to_string(),
        backup_exe: format!("{}.bak", target_exe.display()),
        main_process_name: MAIN_PROCESS_NAME.to_string(),
        restart: true,
    };
    let marker_path = updater_dir.join("update.json");
    std::fs::write(
        &marker_path,
        serde_json::to_string_pretty(&marker).map_err(|e| format!("序列化 marker 失败: {e}"))?,
    )
    .map_err(|e| format!("写入 marker 失败: {e}"))?;

    let updater_path = updater_dir.join(UPDATER_EXE);
    std::fs::write(&updater_path, updater_bytes).map_err(|e| format!("解出更新器失败: {e}"))?;

    let _ = std::process::Command::new(&updater_path)
        .arg(marker_path.display().to_string())
        .spawn()
        .map_err(|e| format!("启动更新器失败: {e}"))?;

    // 主进程退出，更新器接手（模板同款 Environment.Exit(0)）
    std::process::exit(0);
}
