//! 本模块在桌面进程内串行协调生成与训练，避免两个 Runtime 同时争用同一张 NVIDIA GPU。

use std::sync::{atomic::{AtomicBool, Ordering}, Arc, Condvar, Mutex};
use std::time::Duration;

/** 应用生命周期内共享的单 GPU 工作负载协调器。 */
pub struct GpuWorkloadCoordinator {
    busy: Mutex<bool>,
    changed: Condvar,
}

/** 持有期间独占 GPU；离开作用域时自动唤醒下一任务。 */
pub struct GpuWorkloadGuard {
    coordinator: Arc<GpuWorkloadCoordinator>,
}

impl GpuWorkloadCoordinator {
    /** 创建初始空闲的协调器。 */
    pub fn new() -> Arc<Self> { Arc::new(Self { busy: Mutex::new(false), changed: Condvar::new() }) }

    /** 可中断等待 GPU，桌面退出时最多延迟 500 毫秒。 */
    pub fn acquire(self: &Arc<Self>, stopping: &AtomicBool) -> Option<GpuWorkloadGuard> {
        let mut busy = self.busy.lock().unwrap_or_else(|poisoned| poisoned.into_inner());
        while *busy {
            if stopping.load(Ordering::SeqCst) { return None; }
            let waited = self.changed.wait_timeout(busy, Duration::from_millis(500)).ok()?;
            busy = waited.0;
        }
        if stopping.load(Ordering::SeqCst) { return None; }
        *busy = true;
        Some(GpuWorkloadGuard { coordinator: self.clone() })
    }

    /** 用户手动控制 Runtime 时只在 GPU 空闲时立即取得所有权。 */
    pub fn try_acquire(self: &Arc<Self>) -> Option<GpuWorkloadGuard> {
        let mut busy = self.busy.lock().unwrap_or_else(|poisoned| poisoned.into_inner());
        if *busy { return None; }
        *busy = true;
        Some(GpuWorkloadGuard { coordinator: self.clone() })
    }
}

impl Drop for GpuWorkloadGuard {
    fn drop(&mut self) {
        let mut busy = self.coordinator.busy.lock().unwrap_or_else(|poisoned| poisoned.into_inner());
        *busy = false;
        self.coordinator.changed.notify_all();
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn workload_guard_releases_gpu_after_scope() {
        let coordinator = GpuWorkloadCoordinator::new();
        let guard = coordinator.try_acquire().expect("首次取得 GPU");
        assert!(coordinator.try_acquire().is_none());
        drop(guard);
        assert!(coordinator.try_acquire().is_some());
    }
}
