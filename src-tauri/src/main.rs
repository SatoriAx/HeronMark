// 发布模式隐藏控制台窗口
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

use heronmark::update;

fn main() {
    // 注入内嵌更新器字节。构建顺序：先 tools\build-updater.ps1（生成
    // src-tauri\resources\heronmark_updater.exe），再构建主程序。
    update::UPDATER_BYTES
        .set(include_bytes!("../resources/heronmark_updater.exe"))
        .expect("UPDATER_BYTES 重复注入");

    tauri::Builder::default()
        .invoke_handler(tauri::generate_handler![
            update::check_update,
            update::download_update,
            update::apply_update,
        ])
        .run(tauri::generate_context!())
        .expect("error while running HeronMark");
}
