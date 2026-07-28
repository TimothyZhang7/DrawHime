"""本文件在共享 GPU 上为 ComfyUI 推理提供计算优先级，并在空闲时恢复 LoRA 训练。"""

from __future__ import annotations

import json
import os
import signal
import time
import urllib.request
from pathlib import Path
from typing import Callable


TRAINING_ROOT = Path(os.environ.get("DRAWHIME_TRAINING_ROOT", "/data/drawhime-training"))
COMFY_QUEUE_URL = os.environ.get("COMFYUI_QUEUE_URL", "http://127.0.0.1:8189/queue")
POLL_SECONDS = max(0.5, min(10.0, float(os.environ.get("GPU_ARBITER_POLL_SECONDS", "1"))))
SIGSTOP = getattr(signal, "SIGSTOP", 19)
SIGCONT = getattr(signal, "SIGCONT", 18)
running = True


def read_comfy_busy(url: str = COMFY_QUEUE_URL) -> bool:
    """读取真实 ComfyUI 队列；不可达时恢复训练，避免进程永久冻结。"""
    try:
        with urllib.request.urlopen(url, timeout=3) as response:
            payload = json.loads(response.read(1024 * 1024))
        return bool(payload.get("queue_running") or payload.get("queue_pending"))
    except (OSError, ValueError, TypeError):
        return False


def discover_training_groups(root: Path = TRAINING_ROOT) -> set[int]:
    """只读取训练 Runtime 持久化的运行中进程组，禁止扫描或控制其他 GPU 程序。"""
    groups: set[int] = set()
    jobs = root / "jobs"
    if not jobs.is_dir():
        return groups
    for state_path in jobs.glob("*/state.json"):
        try:
            state = json.loads(state_path.read_text(encoding="utf-8"))
            process_id = state.get("pid")
            if state.get("status") == "running" and isinstance(process_id, int) and process_id > 1:
                groups.add(process_id)
        except (OSError, ValueError, TypeError):
            continue
    return groups


def send_process_group_signal(process_group: int, value: int) -> None:
    """在 Linux 生产节点向训练 Runtime 创建的独立进程组发送控制信号。"""
    os.killpg(process_group, value)


def reconcile_training_priority(
    active_groups: set[int],
    paused_groups: set[int],
    comfy_busy: bool,
    send_signal: Callable[[int, int], None] | None = None,
) -> set[int]:
    """推理繁忙时暂停训练进程组，队列清空后恢复；重复轮询保持幂等。"""
    next_paused = paused_groups & active_groups
    desired_signal = SIGSTOP if comfy_busy else SIGCONT
    candidates = active_groups - next_paused if comfy_busy else set(next_paused)
    signal_sender = send_signal or send_process_group_signal
    for process_group in candidates:
        try:
            signal_sender(process_group, desired_signal)
            if comfy_busy:
                next_paused.add(process_group)
            else:
                next_paused.discard(process_group)
        except ProcessLookupError:
            next_paused.discard(process_group)
        except PermissionError:
            continue
    return next_paused


def stop_service(_signal_number: int, _frame: object) -> None:
    """接收 systemd 退出信号，主循环会在退出前恢复所有训练进程。"""
    global running
    running = False


def main() -> None:
    """持续协调推理和训练，同一时刻只让一个工作负载占用 GPU 计算单元。"""
    signal.signal(signal.SIGTERM, stop_service)
    signal.signal(signal.SIGINT, stop_service)
    paused_groups: set[int] = set()
    last_busy: bool | None = None
    try:
        while running:
            active_groups = discover_training_groups()
            comfy_busy = read_comfy_busy()
            paused_groups = reconcile_training_priority(active_groups, paused_groups, comfy_busy)
            if comfy_busy != last_busy:
                print(f"[gpu-arbiter] inference_busy={str(comfy_busy).lower()} paused_training_groups={len(paused_groups)}", flush=True)
                last_busy = comfy_busy
            time.sleep(POLL_SECONDS)
    finally:
        reconcile_training_priority(discover_training_groups(), paused_groups, False)


if __name__ == "__main__":
    main()
