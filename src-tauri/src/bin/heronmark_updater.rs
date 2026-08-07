//! heronmark_updater — 独立更新器（逻辑移植自 LightTranslate.Updater/Program.cs）
//!
//! 流程：读 marker json → 等主进程退出（对 target_exe 做替换尝试轮询，文件被
//! 运行中的进程锁定时失败重试，最多 60s；等价于模板按进程名等待）→ 备份旧 exe
//! 为 .bak → 替换 → 删 marker → 重启主程序 → 失败回滚 .bak。
//!
//! 由主程序 apply_update 写入 marker 并启动；也可手动验证：
//!   heronmark_updater.exe <update.json>
//! 日志：%Temp%\HeronMark-update.log
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

use std::path::Path;
use std::time::{Duration, Instant};

use heronmark::update::UpdateMarker;

#[cfg(windows)]
use std::os::windows::process::CommandExt;

const WAIT_SECONDS: u64 = 60;
const POLL_MS: u64 = 300;
const LOG_FILE: &str = "HeronMark-update.log";
const CREATE_NO_WINDOW: u32 = 0x0800_0000;

fn main() {
    let marker_arg = std::env::args()
        .nth(1)
        .unwrap_or_default()
        .trim_matches('"')
        .to_string();
    if marker_arg.is_empty() || !Path::new(&marker_arg).is_file() {
        error(&format!("用法: heronmark_updater <update.json>（标记文件不存在: {marker_arg}）"));
        std::process::exit(2);
    }

    let marker = match read_marker(&marker_arg) {
        Ok(m) => m,
        Err(e) => {
            error(&format!("标记文件解析失败: {e}"));
            std::process::exit(2);
        }
    };
    if marker.target_exe.is_empty() || marker.new_exe.is_empty() {
        error("标记文件缺少 target_exe / new_exe");
        std::process::exit(2);
    }

    log(&format!(
        "updater 启动 marker={marker_arg} target={} new={} backup={}",
        marker.target_exe, marker.new_exe, marker.backup_exe
    ));

    if let Err(e) = run(&marker, &marker_arg) {
        rollback(&marker);
        error(&format!("更新失败: {e}"));
        std::process::exit(1);
    }
    log("更新完成");
    std::process::exit(0);
}

fn run(marker: &UpdateMarker, marker_path: &str) -> Result<(), String> {
    replace_with_wait(marker)?;

    // 删 marker；更新目录清理失败可忽略（自身 exe 正被本进程占用）
    let _ = std::fs::remove_file(marker_path);
    if let Some(dir) = Path::new(marker_path).parent() {
        let _ = std::fs::remove_dir_all(dir);
    }

    if marker.restart && Path::new(&marker.target_exe).is_file() {
        let mut cmd = std::process::Command::new(&marker.target_exe);
        #[cfg(windows)]
        cmd.creation_flags(CREATE_NO_WINDOW);
        cmd.spawn()
            .map_err(|e| format!("重启主程序失败: {e}"))?;
        log("已请求重启主程序");
    }
    Ok(())
}

/// 等主进程退出并完成替换：轮询"备份 + 替换"，目标被占用时重试，最多 60s。
fn replace_with_wait(marker: &UpdateMarker) -> Result<(), String> {
    if !Path::new(&marker.new_exe).is_file() {
        return Err(format!("新程序不存在: {}", marker.new_exe));
    }
    let deadline = Instant::now() + Duration::from_secs(WAIT_SECONDS);
    loop {
        match try_replace(marker) {
            Ok(()) => return Ok(()),
            Err(e) => {
                if Instant::now() >= deadline {
                    return Err(format!("等待主进程退出超时（{WAIT_SECONDS}s）：{e}"));
                }
                std::thread::sleep(Duration::from_millis(POLL_MS));
            }
        }
    }
}

fn try_replace(marker: &UpdateMarker) -> Result<(), String> {
    let target = Path::new(&marker.target_exe);
    let backup = Path::new(&marker.backup_exe);
    let new = Path::new(&marker.new_exe);

    if target.exists() {
        // 备份（先删旧备份，等价模板 File.Move overwrite:true）
        let _ = std::fs::remove_file(backup);
        std::fs::rename(target, backup)
            .map_err(|e| format!("备份旧程序失败（主进程可能仍在运行）: {e}"))?;
    }
    std::fs::rename(new, target).map_err(|e| format!("替换程序失败: {e}"))?;
    Ok(())
}

/// 失败回滚：target 缺失且存在 .bak 时恢复（模板同款）
fn rollback(marker: &UpdateMarker) {
    let target = Path::new(&marker.target_exe);
    let backup = Path::new(&marker.backup_exe);
    if !target.exists() && backup.exists() {
        match std::fs::rename(backup, target) {
            Ok(()) => log("已从 .bak 回滚"),
            Err(e) => log(&format!("回滚失败: {e}")),
        }
    }
}

fn read_marker(path: &str) -> Result<UpdateMarker, String> {
    let text = std::fs::read_to_string(path).map_err(|e| e.to_string())?;
    serde_json::from_str(&text).map_err(|e| e.to_string())
}

fn log(msg: &str) {
    let path = std::env::temp_dir().join(LOG_FILE);
    let secs = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .unwrap_or_default()
        .as_secs();
    let line = format!("[{secs}] {msg}\n");
    if let Ok(mut f) = std::fs::OpenOptions::new().create(true).append(true).open(path) {
        use std::io::Write;
        let _ = f.write_all(line.as_bytes());
    }
}

fn error(msg: &str) {
    log(msg);
    eprintln!("{msg}");
}
