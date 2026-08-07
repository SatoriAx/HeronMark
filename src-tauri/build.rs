fn main() {
    tauri_build::build();

    // 防呆：主 bin 编译期 include_bytes! 内嵌更新器，必须先运行 tools\build-updater.ps1
    // 生成 resources/heronmark_updater.exe。CARGO_BIN_NAME 区分目标，
    // 避免构建 updater 自身（无内嵌需求）时误报。
    if let Ok(bin) = std::env::var("CARGO_BIN_NAME") {
        if bin == "heronmark" && !std::path::Path::new("resources/heronmark_updater.exe").exists() {
            panic!("缺少 resources/heronmark_updater.exe：请先运行 tools\\build-updater.ps1 构建更新器，再构建主程序");
        }
    }
    println!("cargo:rerun-if-changed=resources/heronmark_updater.exe");
}
