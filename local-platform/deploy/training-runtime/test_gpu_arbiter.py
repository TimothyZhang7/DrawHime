"""本文件验证 GPU 仲裁器只控制训练 Runtime 登记的进程组，并能幂等暂停和恢复。"""

import importlib.util
import json
import tempfile
import unittest
from pathlib import Path


MODULE_PATH = Path(__file__).with_name("gpu_arbiter.py")
SPECIFICATION = importlib.util.spec_from_file_location("drawhime_gpu_arbiter_test_module", MODULE_PATH)
if SPECIFICATION is None or SPECIFICATION.loader is None:
    raise RuntimeError("GPU 仲裁器测试模块加载失败")
ARBITER = importlib.util.module_from_spec(SPECIFICATION)
SPECIFICATION.loader.exec_module(ARBITER)


class GpuArbiterTest(unittest.TestCase):
    """覆盖状态发现、重复暂停和队列空闲恢复。"""

    def test_discovers_only_running_training_groups(self) -> None:
        """只返回真实运行状态且具有有效 PID 的训练进程组。"""
        with tempfile.TemporaryDirectory() as directory:
            jobs = Path(directory) / "jobs"
            for name, state in {
                "running": {"status": "running", "pid": 123},
                "finished": {"status": "succeeded", "pid": 456},
                "invalid": {"status": "running", "pid": None},
            }.items():
                path = jobs / name
                path.mkdir(parents=True)
                (path / "state.json").write_text(json.dumps(state), encoding="utf-8")
            self.assertEqual(ARBITER.discover_training_groups(Path(directory)), {123})

    def test_pauses_and_resumes_idempotently(self) -> None:
        """同一繁忙周期只暂停一次，空闲后只恢复一次。"""
        calls: list[tuple[int, int]] = []
        send_signal = lambda process_group, value: calls.append((process_group, value))
        paused = ARBITER.reconcile_training_priority({123}, set(), True, send_signal)
        paused = ARBITER.reconcile_training_priority({123}, paused, True, send_signal)
        paused = ARBITER.reconcile_training_priority({123}, paused, False, send_signal)
        self.assertEqual(paused, set())
        self.assertEqual(calls, [(123, ARBITER.SIGSTOP), (123, ARBITER.SIGCONT)])


if __name__ == "__main__":
    unittest.main()
