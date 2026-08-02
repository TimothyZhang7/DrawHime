//! 本模块统一隐藏 Windows 后台子进程窗口，避免 Runtime、检测、打标、训练和解压弹出命令行窗口。

use std::{
    io::{self, Read},
    process::{Command, Output, Stdio},
    thread,
    time::{Duration, Instant},
};

/** 为后台命令应用 Windows CREATE_NO_WINDOW；其他平台保持原命令行为。 */
pub fn hide_window(command: &mut Command) -> &mut Command {
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        command.creation_flags(0x0800_0000);
    }
    command
}

/** 执行短时后台探针并设置总截止时间，超时返回 None 且确保回收子进程。 */
pub fn output_with_timeout(command: &mut Command, timeout: Duration) -> io::Result<Option<Output>> {
    command.stdout(Stdio::piped()).stderr(Stdio::piped());
    let mut child = command.spawn()?;
    let deadline = Instant::now() + timeout;
    loop {
        if let Some(status) = child.try_wait()? {
            let mut stdout = Vec::new();
            let mut stderr = Vec::new();
            if let Some(mut stream) = child.stdout.take() {
                stream.read_to_end(&mut stdout)?;
            }
            if let Some(mut stream) = child.stderr.take() {
                stream.read_to_end(&mut stderr)?;
            }
            return Ok(Some(Output {
                status,
                stdout,
                stderr,
            }));
        }
        if Instant::now() >= deadline {
            let _ = child.kill();
            let _ = child.wait();
            return Ok(None);
        }
        thread::sleep(Duration::from_millis(25));
    }
}

#[cfg(all(test, windows))]
mod tests {
    use super::*;

    #[test]
    fn short_probe_timeout_reclaims_child_process() {
        let mut command = Command::new("powershell.exe");
        hide_window(&mut command).args([
            "-NoProfile",
            "-NonInteractive",
            "-Command",
            "Start-Sleep -Seconds 5",
        ]);
        let started = Instant::now();
        let output = output_with_timeout(&mut command, Duration::from_millis(100))
            .expect("启动受控测试进程");
        assert!(output.is_none());
        assert!(started.elapsed() < Duration::from_secs(2));
    }
}
