"""本文件验证 GPU 训练 Runtime 固化精确底模、触发词保护与稳定训练参数。"""

import importlib.util
import tempfile
import unittest
from pathlib import Path


MODULE_PATH = Path(__file__).with_name("server.py")
SPECIFICATION = importlib.util.spec_from_file_location("drawhime_training_runtime_test_module", MODULE_PATH)
if SPECIFICATION is None or SPECIFICATION.loader is None:
    raise RuntimeError("训练 Runtime 测试模块加载失败")
RUNTIME = importlib.util.module_from_spec(SPECIFICATION)
SPECIFICATION.loader.exec_module(RUNTIME)


class TrainingProfileTest(unittest.TestCase):
    """覆盖底模文件、Anima LoRA 模块和训练强度的最终命令。"""

    def test_command_uses_exact_model_and_stable_profile(self) -> None:
        """任务选择的底模和 320 次遍历参数必须原样进入 sd-scripts。"""
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            original = (RUNTIME.JOBS, RUNTIME.SD_SCRIPTS, RUNTIME.VENV, RUNTIME.MODEL_ROOT)
            try:
                RUNTIME.JOBS = root / "jobs"
                RUNTIME.SD_SCRIPTS = root / "sd-scripts"
                RUNTIME.VENV = root / "venv"
                RUNTIME.MODEL_ROOT = root / "models"
                parameters = {
                    "rank": 16, "alpha": 16, "epochs": 4, "repeats": 4, "learningRate": 0.0001,
                    "resolution": 768, "lrScheduler": "constant", "warmupRatio": 0,
                    "gradientAccumulationSteps": 1, "captionDropoutRate": 0, "shuffleCaption": False,
                    "keepTokens": 2, "seed": 7,
                }
                payload = {
                    "baseModelFile": "selected-anima.safetensors",
                    "textEncoderFile": "qwen_3_06b_base.safetensors",
                    "vaeFile": "qwen_image_vae.safetensors",
                    "outputName": "trained-character",
                    "dataset": [{} for _ in range(20)],
                    "parameters": parameters,
                }
                image_dir = root / "images"
                image_dir.mkdir()
                (RUNTIME.JOBS / "job-1").mkdir(parents=True)
                config = RUNTIME.write_dataset_config("job-1", image_dir, parameters)
                command = RUNTIME.build_command("job-1", payload, config)
                joined = "\n".join(command)
                self.assertIn("selected-anima.safetensors", joined)
                self.assertIn("--network_module=networks.lora_anima", command)
                self.assertIn("--network_train_unet_only", command)
                self.assertIn("--network_dim=16", command)
                self.assertIn("--network_alpha=16", command)
                self.assertIn("--max_train_epochs=4", command)
                self.assertIn("num_repeats = 4", config.read_text(encoding="utf-8"))
                self.assertEqual(20 * parameters["epochs"] * parameters["repeats"], 320)
            finally:
                RUNTIME.JOBS, RUNTIME.SD_SCRIPTS, RUNTIME.VENV, RUNTIME.MODEL_ROOT = original


if __name__ == "__main__":
    unittest.main()
