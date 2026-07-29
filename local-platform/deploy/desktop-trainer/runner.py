"""本文件在桌面私有 Python 中执行固定 sd-scripts Anima LoRA 训练，并只输出逐行 JSON 状态。"""

from __future__ import annotations

import argparse
import hashlib
import json
import os
import re
import shutil
import subprocess
import sys
from pathlib import Path

COMPONENT_ROOT = Path(__file__).resolve().parent
SITE_PACKAGES = COMPONENT_ROOT / "site-packages"
SD_SCRIPTS = COMPONENT_ROOT / "sd-scripts"
sys.path.insert(0, str(SITE_PACKAGES))
sys.path.insert(0, str(SD_SCRIPTS))


def emit(payload: dict) -> None:
    """向 Rust 核心输出一条受控 JSON 事件。"""
    sys.stdout.write(json.dumps(payload, ensure_ascii=False, separators=(",", ":")) + "\n")
    sys.stdout.flush()


def parse_arguments() -> argparse.Namespace:
    """读取 Rust 核心写入的请求文件路径。"""
    parser = argparse.ArgumentParser()
    parser.add_argument("--request", required=True)
    return parser.parse_args()


def load_request(path: Path) -> dict:
    """读取并校验任务规模及全部用户参数。"""
    with path.open("r", encoding="utf-8") as handle:
        request = json.load(handle)
    if not re.fullmatch(r"[0-9a-f-]{36}", str(request.get("jobId", "")), re.I):
        raise ValueError("训练任务 ID 不正确")
    if not re.fullmatch(r"[A-Za-z0-9_-]{1,100}", str(request.get("outputName", ""))):
        raise ValueError("训练输出名称不正确")
    assets = request.get("assets")
    if not isinstance(assets, list) or not 5 <= len(assets) <= 200:
        raise ValueError("训练图片数量必须是 5–200 张")
    validate_parameters(request.get("parameters"))
    return request


def validate_parameters(parameters: object) -> None:
    """重复校验跨进程参数，避免损坏请求进入训练脚本。"""
    if not isinstance(parameters, dict):
        raise ValueError("训练参数缺失")
    ranges = {
        "rank": (8, 64), "alpha": (1, 64), "epochs": (1, 20), "repeats": (1, 50),
        "resolution": (512, 1536), "gradientAccumulationSteps": (1, 4), "keepTokens": (0, 10),
        "seed": (0, 2147483647),
    }
    for key, (minimum, maximum) in ranges.items():
        value = parameters.get(key)
        if not isinstance(value, int) or not minimum <= value <= maximum:
            raise ValueError(f"训练参数 {key} 不正确")
    if parameters["alpha"] > parameters["rank"] or parameters["resolution"] % 64:
        raise ValueError("Alpha 或训练分辨率不正确")
    if parameters.get("lrScheduler") not in ("constant", "cosine", "cosine_with_restarts"):
        raise ValueError("学习率调度器不正确")
    for key, minimum, maximum in (("learningRate", 0.000001, 0.01), ("warmupRatio", 0.0, 0.2), ("captionDropoutRate", 0.0, 0.3)):
        value = parameters.get(key)
        if not isinstance(value, (int, float)) or not minimum <= float(value) <= maximum:
            raise ValueError(f"训练参数 {key} 不正确")
    if not isinstance(parameters.get("shuffleCaption"), bool):
        raise ValueError("Caption 打乱参数不正确")


def prepare_dataset(request: dict, workspace: Path) -> Path:
    """校验任务快照并复制到 sd-scripts 独立数据集目录。"""
    image_dir = workspace / "dataset" / "images"
    if image_dir.exists():
        shutil.rmtree(image_dir)
    image_dir.mkdir(parents=True)
    for index, item in enumerate(request["assets"]):
        source = Path(str(item.get("path", "")))
        expected_size = int(item.get("byteSize", -1))
        expected_hash = str(item.get("sha256", ""))
        caption = str(item.get("caption", "")).replace("\x00", " ").strip()
        if not source.is_file() or source.stat().st_size != expected_size or file_sha256(source) != expected_hash:
            raise ValueError(f"训练图片 {index + 1} 快照已经变化")
        if not caption or len(caption) > 10000:
            raise ValueError(f"训练图片 {index + 1} Caption 不正确")
        extension = source.suffix.lower()
        if extension not in (".png", ".jpg", ".jpeg", ".webp"):
            raise ValueError(f"训练图片 {index + 1} 格式不受支持")
        stem = f"{index + 1:04d}_{expected_hash[:12]}"
        shutil.copy2(source, image_dir / f"{stem}{extension}")
        (image_dir / f"{stem}.txt").write_text(caption, encoding="utf-8")
    return image_dir


def write_dataset_config(image_dir: Path, workspace: Path, parameters: dict) -> Path:
    """生成 sd-scripts 官方 TOML 数据集配置。"""
    config = workspace / "dataset.toml"
    escaped = str(image_dir).replace("\\", "/").replace('"', '\\"')
    config.write_text(
        "[general]\ncaption_extension = \".txt\"\n\n"
        f"[[datasets]]\nresolution = {parameters['resolution']}\nbatch_size = 1\nenable_bucket = true\nbucket_no_upscale = true\n\n"
        f"  [[datasets.subsets]]\n  image_dir = \"{escaped}\"\n  num_repeats = {parameters['repeats']}\n"
        f"  shuffle_caption = {str(parameters['shuffleCaption']).lower()}\n  keep_tokens = {parameters['keepTokens']}\n"
        f"  caption_dropout_rate = {float(parameters['captionDropoutRate'])}\n",
        encoding="utf-8",
    )
    return config


def build_command(request: dict, config: Path, workspace: Path) -> list[str]:
    """按固定 Anima 训练修订构建 Windows 兼容命令。"""
    parameters = request["parameters"]
    output_dir = workspace / "output"
    output_dir.mkdir(parents=True, exist_ok=True)
    image_passes = len(request["assets"]) * parameters["repeats"] * parameters["epochs"]
    optimizer_steps = max(1, (image_passes + parameters["gradientAccumulationSteps"] - 1) // parameters["gradientAccumulationSteps"])
    warmup_steps = round(optimizer_steps * float(parameters["warmupRatio"]))
    blocks_to_swap = choose_blocks_to_swap(parameters["resolution"])
    command = [
        sys.executable, "-m", "accelerate.commands.launch", "--num_cpu_threads_per_process", "4",
        str(SD_SCRIPTS / "anima_train_network.py"),
        f"--pretrained_model_name_or_path={request['modelPath']}", f"--qwen3={request['textEncoderPath']}", f"--vae={request['vaePath']}",
        f"--dataset_config={config}", f"--output_dir={output_dir}", f"--output_name={request['outputName']}",
        "--save_model_as=safetensors", "--network_module=networks.lora_anima", "--network_train_unet_only",
        f"--network_dim={parameters['rank']}", f"--network_alpha={parameters['alpha']}",
        f"--learning_rate={float(parameters['learningRate'])}", "--optimizer_type=AdamW8bit", f"--lr_scheduler={parameters['lrScheduler']}",
        f"--lr_warmup_steps={warmup_steps}", f"--gradient_accumulation_steps={parameters['gradientAccumulationSteps']}",
        "--timestep_sampling=sigmoid", "--discrete_flow_shift=1.0", f"--max_train_epochs={parameters['epochs']}",
        "--mixed_precision=bf16", "--save_precision=bf16", "--gradient_checkpointing", "--cache_latents", "--qwen_image_vae_2d",
        f"--blocks_to_swap={blocks_to_swap}", f"--seed={parameters['seed']}", "--max_data_loader_n_workers=4", "--persistent_data_loader_workers",
    ]
    if not parameters["shuffleCaption"]:
        command.append("--cache_text_encoder_outputs")
    if parameters["lrScheduler"] == "cosine_with_restarts":
        command.append("--lr_scheduler_num_cycles=2")
    return command


def choose_blocks_to_swap(resolution: int) -> int:
    """根据真实显存和分辨率选择不超过 20-block 模型安全上限的交换块数。"""
    memory_gib = gpu_memory_gib()
    if memory_gib <= 12:
        return 18
    if memory_gib <= 16:
        return 16 if resolution <= 768 else 18
    if memory_gib <= 20:
        return 12 if resolution <= 768 else 16
    return 8 if resolution <= 768 else 12 if resolution <= 1024 else 18


def gpu_memory_gib() -> float:
    """读取首张 NVIDIA GPU 总显存；探测失败时使用保守配置。"""
    try:
        output = subprocess.check_output(["nvidia-smi", "--query-gpu=memory.total", "--format=csv,noheader,nounits"], text=True, timeout=10, creationflags=subprocess.CREATE_NO_WINDOW)
        return float(output.splitlines()[0].strip()) / 1024
    except (OSError, ValueError, subprocess.SubprocessError, IndexError):
        return 8.0


def run_training(command: list[str], workspace: Path, total_epochs: int) -> Path:
    """执行训练子进程、写本地日志并把真实进度转换为 JSON 事件。"""
    environment = {
        **os.environ,
        "PYTHONPATH": os.pathsep.join((str(SITE_PACKAGES), str(SD_SCRIPTS))),
        "PYTHONUTF8": "1", "PYTHONUNBUFFERED": "1", "PYTHONNOUSERSITE": "1",
        "HF_HOME": str(workspace / "hf-cache"), "HF_HUB_OFFLINE": "1", "TRANSFORMERS_OFFLINE": "1",
    }
    flags = subprocess.CREATE_NO_WINDOW | subprocess.CREATE_NEW_PROCESS_GROUP
    log_path = workspace / "training.log"
    process = subprocess.Popen(command, cwd=SD_SCRIPTS, env=environment, stdin=subprocess.DEVNULL, stdout=subprocess.PIPE, stderr=subprocess.STDOUT, text=True, encoding="utf-8", errors="replace", bufsize=1, creationflags=flags)
    emit({"kind": "progress", "progress": 3, "currentEpoch": 0})
    try:
        assert process.stdout is not None
        with log_path.open("a", encoding="utf-8") as log:
            for line in process.stdout:
                log.write(line)
                log.flush()
                epoch = re.search(r"epoch\s+(\d+)\s*/\s*(\d+)", line, re.I)
                if epoch:
                    current = min(total_epochs, int(epoch.group(1)))
                    emit({"kind": "progress", "progress": min(95, max(3, round(current / max(1, total_epochs) * 95))), "currentEpoch": current})
                    continue
                steps = re.search(r"steps:\s*(\d+)%.*?(\d+)\s*/\s*(\d+)", line, re.I)
                if steps:
                    percent = min(100, int(steps.group(1)))
                    emit({"kind": "progress", "progress": min(95, max(3, round(percent * 0.95))), "currentEpoch": min(total_epochs, percent * total_epochs // 100)})
        exit_code = process.wait()
    except BaseException:
        terminate_process_tree(process)
        raise
    if exit_code:
        message, oom = training_failure(log_path, exit_code)
        emit({"kind": "error", "message": message, "oom": oom})
        raise RuntimeError(message)
    outputs = sorted((workspace / "output").glob("*.safetensors"), key=lambda path: path.stat().st_mtime, reverse=True)
    if not outputs:
        raise RuntimeError("训练完成但未生成 safetensors")
    validate_safetensors(outputs[0])
    return outputs[0]


def training_failure(log_path: Path, exit_code: int) -> tuple[str, bool]:
    """从日志尾部识别 OOM 和常见依赖问题，不回显用户路径。"""
    content = log_path.read_text(encoding="utf-8", errors="replace")[-128 * 1024:] if log_path.exists() else ""
    if "CUDA out of memory" in content or "OutOfMemoryError" in content:
        return "GPU 显存不足，训练进程已安全停止", True
    known = (("No space left on device", "训练磁盘空间不足"), ("ModuleNotFoundError", "Trainer 依赖不完整，请在资源页执行修复"), ("when caching Text Encoder output", "Caption 随机打乱与文本编码器缓存冲突"))
    for marker, message in known:
        if marker in content:
            return message, False
    return f"训练进程退出码 {exit_code}；详细日志已保留在本地任务目录", False


def terminate_process_tree(process: subprocess.Popen[str]) -> None:
    """Windows 上终止 accelerate 及全部训练子进程。"""
    if process.poll() is None:
        subprocess.run(["taskkill", "/PID", str(process.pid), "/T", "/F"], stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL, creationflags=subprocess.CREATE_NO_WINDOW, check=False)
        try:
            process.wait(timeout=15)
        except subprocess.TimeoutExpired:
            process.kill()


def validate_safetensors(path: Path) -> None:
    """检查训练产物 safetensors 文件头和最低大小。"""
    if not path.is_file() or path.stat().st_size < 1024:
        raise ValueError("训练产物文件过小")
    with path.open("rb") as handle:
        header_size = int.from_bytes(handle.read(8), "little")
        if not 2 <= header_size <= 100 * 1024 * 1024 or header_size + 8 >= path.stat().st_size:
            raise ValueError("训练产物 safetensors 文件头不正确")
        json.loads(handle.read(header_size))


def file_sha256(path: Path) -> str:
    """流式计算训练图片 SHA-256。"""
    digest = hashlib.sha256()
    with path.open("rb") as handle:
        while chunk := handle.read(1024 * 1024):
            digest.update(chunk)
    return digest.hexdigest()


def main() -> None:
    """完整执行一次任务，请求与进度均不依赖网络服务。"""
    request = load_request(Path(parse_arguments().request))
    workspace = Path(request["workspace"])
    workspace.mkdir(parents=True, exist_ok=True)
    image_dir = prepare_dataset(request, workspace)
    config = write_dataset_config(image_dir, workspace, request["parameters"])
    emit({"kind": "progress", "progress": 2, "currentEpoch": 0})
    output = run_training(build_command(request, config, workspace), workspace, request["parameters"]["epochs"])
    emit({"kind": "result", "path": str(output), "progress": 100, "currentEpoch": request["parameters"]["epochs"]})


if __name__ == "__main__":
    try:
        main()
    except Exception as error:
        message = str(error).splitlines()[-1][:800] or type(error).__name__
        emit({"kind": "error", "message": message, "oom": "显存不足" in message})
        raise SystemExit(1)
