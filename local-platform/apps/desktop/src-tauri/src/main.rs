#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]
// 本文件是 Windows 桌面可执行程序入口，发布构建使用 GUI 子系统且业务命令统一由库模块注册。
fn main() {
    drawhime_desktop_lib::run()
}
