/**
 * 本文件管理环境复检与 Runtime 轮询，只在真实状态变化时通知桌面根组件。
 */
import type { DesktopEnvironmentReport, DesktopRuntimeStatusView } from "@drawhime/contracts";
import { useCallback, useEffect, useRef, useState } from "react";
import { inspectDesktopEnvironment, loadDesktopRuntimeStatus } from "../desktop-api";

interface EnvironmentMonitorOptions {
  enabled: boolean;
  environment: DesktopEnvironmentReport | null;
  onChanged: (environment: DesktopEnvironmentReport) => void;
  onMessage: (message: string) => void;
}

interface RuntimeMonitorOptions {
  enabled: boolean;
  runtime: DesktopRuntimeStatusView | null;
  transitioning: boolean;
  onChanged: (runtime: DesktopRuntimeStatusView) => void;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error || "环境检测失败");
}

/** 检测时间不属于业务状态，忽略它可避免相同环境报告反复重绘页面。 */
function sameEnvironment(previous: DesktopEnvironmentReport | null, next: DesktopEnvironmentReport): boolean {
  if (!previous) return false;
  const { checkedAt: _previousCheckedAt, ...previousStable } = previous;
  const { checkedAt: _nextCheckedAt, ...nextStable } = next;
  return JSON.stringify(previousStable) === JSON.stringify(nextStable);
}

/** Runtime 的轮询时间不外显，只比较影响功能门禁与界面的字段。 */
function sameRuntime(previous: DesktopRuntimeStatusView | null, next: DesktopRuntimeStatusView): boolean {
  if (!previous) return false;
  return previous.status === next.status
    && previous.pid === next.pid
    && previous.port === next.port
    && previous.startedAt === next.startedAt
    && previous.logPath === next.logPath
    && previous.backend === next.backend
    && previous.deviceIndex === next.deviceIndex
    && previous.launchProfile === next.launchProfile
    && previous.error === next.error;
}

/** 环境复检使用单飞、可见性门禁与短退避，静默检查不会阻塞用户操作。 */
export function useDesktopEnvironmentMonitor({ enabled, environment, onChanged, onMessage }: EnvironmentMonitorOptions) {
  const [checking, setChecking] = useState(false);
  const running = useRef(false);
  const lastCheckedAt = useRef(0);
  const windowsVersionRetryCount = useRef(0);
  const environmentRef = useRef(environment);
  const onChangedRef = useRef(onChanged);
  const onMessageRef = useRef(onMessage);
  environmentRef.current = environment;
  onChangedRef.current = onChanged;
  onMessageRef.current = onMessage;

  /** 手工检查显示进度与结果，后台检查仅在真实变化时提交状态。 */
  const recheck = useCallback(async (quiet = false): Promise<void> => {
    if (running.current) return;
    running.current = true;
    if (!quiet) setChecking(true);
    try {
      const next = await inspectDesktopEnvironment();
      lastCheckedAt.current = Date.now();
      if (!sameEnvironment(environmentRef.current, next)) onChangedRef.current(next);
      if (!quiet) onMessageRef.current("环境检测已更新");
    } catch (error) {
      onMessageRef.current(errorMessage(error));
    } finally {
      running.current = false;
      if (!quiet) setChecking(false);
    }
  }, []);

  useEffect(() => {
    if (!enabled) return undefined;
    const timer = window.setInterval(() => void recheck(true), 90_000);
    const onVisibility = () => {
      if (document.visibilityState === "visible" && Date.now() - lastCheckedAt.current >= 30_000) void recheck(true);
    };
    document.addEventListener("visibilitychange", onVisibility);
    return () => {
      window.clearInterval(timer);
      document.removeEventListener("visibilitychange", onVisibility);
    };
  }, [enabled, recheck]);

  useEffect(() => {
    const versionUnknown = environment?.issues.some((issue) => issue.code === "windows_version_unknown") ?? false;
    if (!versionUnknown) {
      windowsVersionRetryCount.current = 0;
      return undefined;
    }
    if (windowsVersionRetryCount.current >= 2) return undefined;
    const delay = windowsVersionRetryCount.current === 0 ? 1_000 : 3_000;
    const timer = window.setTimeout(() => {
      windowsVersionRetryCount.current += 1;
      void recheck(true);
    }, delay);
    return () => window.clearTimeout(timer);
  }, [environment?.checkedAt, recheck]);

  return { checking, recheck };
}

/** Runtime 自适应轮询串行执行，隐藏窗口暂停，恢复时立即同步一次。 */
export function useDesktopRuntimeMonitor({ enabled, runtime, transitioning, onChanged }: RuntimeMonitorOptions): void {
  const running = useRef(false);
  const runtimeRef = useRef(runtime);
  const onChangedRef = useRef(onChanged);
  runtimeRef.current = runtime;
  onChangedRef.current = onChanged;
  useEffect(() => {
    if (!enabled) return undefined;
    let cancelled = false;
    let timer: number | null = null;
    const interval = transitioning ? 1_000 : runtime?.status === "ready" ? 5_000 : 3_000;
    const poll = async () => {
      if (cancelled || document.visibilityState !== "visible") return;
      if (running.current) {
        timer = window.setTimeout(() => void poll(), Math.min(interval, 500));
        return;
      }
      running.current = true;
      try {
        const next = await loadDesktopRuntimeStatus();
        if (!sameRuntime(runtimeRef.current, next)) onChangedRef.current(next);
      } catch {
        // 单次读取失败保留最后一次可信状态，下个可见周期继续收敛。
      } finally {
        running.current = false;
        if (!cancelled && document.visibilityState === "visible") timer = window.setTimeout(() => void poll(), interval);
      }
    };
    const refreshVisibleRuntime = () => {
      if (document.visibilityState !== "visible" || running.current) return;
      if (timer !== null) window.clearTimeout(timer);
      timer = null;
      void poll();
    };
    timer = window.setTimeout(() => void poll(), interval);
    document.addEventListener("visibilitychange", refreshVisibleRuntime);
    window.addEventListener("focus", refreshVisibleRuntime);
    return () => {
      cancelled = true;
      if (timer !== null) window.clearTimeout(timer);
      document.removeEventListener("visibilitychange", refreshVisibleRuntime);
      window.removeEventListener("focus", refreshVisibleRuntime);
    };
  }, [enabled, runtime?.status, transitioning]);
}
