//! 本模块统一隐藏 Windows 后台子进程窗口，避免 Runtime、检测、打标、训练和解压弹出命令行窗口。

use std::process::Command;

/** 为后台命令应用 Windows CREATE_NO_WINDOW；其他平台保持原命令行为。 */
pub fn hide_window(command: &mut Command) -> &mut Command {
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        command.creation_flags(0x0800_0000);
    }
    command
}
