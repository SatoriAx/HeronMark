//! update_probe — 更新模块验收工具（仅开发用，不随发布分发）
//!
//!   update_probe check [version]        检查更新；默认用 CARGO_PKG_VERSION，
//!                                       伪装旧版示例：update_probe check 0.9.0
//!   update_probe download <tag> [dir]   下载 + sha256 校验到指定目录
//!                                       （默认 %TEMP%\hm-probe-dl）
use std::path::PathBuf;

use heronmark::update::{check_impl, download_impl};

#[tokio::main]
async fn main() {
    let args: Vec<String> = std::env::args().skip(1).collect();
    let code = match args.first().map(|s| s.as_str()) {
        None | Some("check") => cmd_check(args.get(1)).await,
        Some("download") => cmd_download(args.get(1), args.get(2)).await,
        Some(other) => {
            eprintln!("未知命令 {other}：check [version] | download <tag> [dir]");
            2
        }
    };
    std::process::exit(code);
}

async fn cmd_check(version: Option<&String>) -> i32 {
    let current = version.cloned().unwrap_or_else(|| env!("CARGO_PKG_VERSION").to_string());
    match check_impl(&current).await {
        Ok(Some(info)) => {
            println!("HAS_UPDATE current={current} latest={} tag={}", info.version, info.tag);
            println!("  exe_url={}", info.exe_url);
            println!("  sha_url={}", info.sha_url);
            0
        }
        Ok(None) => {
            println!("NO_UPDATE current={current}");
            0
        }
        Err(e) => {
            eprintln!("CHECK_ERROR {e}");
            3
        }
    }
}

async fn cmd_download(tag: Option<&String>, dir: Option<&String>) -> i32 {
    let tag = tag.cloned().unwrap_or_else(|| "v1.0.0".into());
    let dir = dir
        .map(PathBuf::from)
        .unwrap_or_else(|| std::env::temp_dir().join("hm-probe-dl"));
    let mut on_progress = |done: u64, total: u64| {
        let pct = if total > 0 { done as f64 * 100.0 / total as f64 } else { 0.0 };
        println!("  progress {done}/{total} ({pct:.1}%)");
    };
    match download_impl(&tag, &dir, &mut on_progress).await {
        Ok(p) => {
            println!("DOWNLOAD_OK {}", p.display());
            0
        }
        Err(e) => {
            eprintln!("DOWNLOAD_ERROR {e}");
            3
        }
    }
}
