"""本文件在 GPU 主机提供受服务令牌保护的 Anima LoRA 训练 Runtime，并持久化真实进程状态。"""
from __future__ import annotations

import hashlib
import json
import os
import re
import signal
import subprocess
import threading
import time
import urllib.request
from datetime import datetime, timezone
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from typing import Any

ROOT = Path(os.environ.get("DRAWHIME_TRAINING_ROOT", "/data/drawhime-training"))
JOBS = ROOT / "jobs"
SD_SCRIPTS = Path(os.environ.get("SD_SCRIPTS_ROOT", "/data/sd-scripts"))
VENV = Path(os.environ.get("TRAINING_VENV", str(ROOT / "venv")))
MODEL_ROOT = Path(os.environ.get("COMFYUI_MODEL_ROOT", "/data/ComfyUI-master/models"))
TOKEN = os.environ.get("TRAINING_RUNTIME_TOKEN", "").strip()
PORT = int(os.environ.get("TRAINING_RUNTIME_PORT", "7120"))
CUDA_DEVICE = os.environ.get("TRAINING_CUDA_DEVICE", "1")
state_lock = threading.Lock()
training_condition = threading.Condition(state_lock)
processes: dict[str, subprocess.Popen[str]] = {}
waiting_job_ids: list[str] = []
active_training_job_id: str | None = None


def utc_now() -> str:
    """返回统一 UTC 时间。"""
    return datetime.now(timezone.utc).isoformat().replace("+00:00", "Z")


def state_path(job_id: str) -> Path:
    """返回任务状态文件路径。"""
    return JOBS / job_id / "state.json"


def load_state(job_id: str) -> dict[str, Any] | None:
    """读取持久化任务状态。"""
    path = state_path(job_id)
    if not path.exists():
        return None
    return json.loads(path.read_text(encoding="utf-8"))


def save_state(job_id: str, state: dict[str, Any]) -> None:
    """原子写入训练状态，重启后仍可恢复终态。"""
    state["updatedAt"] = utc_now()
    path = state_path(job_id)
    path.parent.mkdir(parents=True, exist_ok=True)
    temporary = path.with_suffix(".tmp")
    temporary.write_text(json.dumps(state, ensure_ascii=False, indent=2), encoding="utf-8")
    temporary.replace(path)


def recover_interrupted_states() -> None:
    """Runtime 重启时把失去子进程的状态写成明确失败，供平台在原任务内安全重试。"""
    if not JOBS.exists():
        return
    for path in JOBS.glob("*/state.json"):
        try:
            state = json.loads(path.read_text(encoding="utf-8"))
            if state.get("status") not in ("queued", "running"):
                continue
            state.update({"status": "failed", "progress": 100, "pid": None, "errorMessage": "训练 Runtime 重启，旧训练进程已终止"})
            save_state(str(state["jobId"]), state)
        except (OSError, ValueError, KeyError, TypeError):
            continue


def validate_request(payload: dict[str, Any]) -> None:
    """校验跨服务训练请求，拒绝路径注入和异常资源参数。"""
    if not re.fullmatch(r"[0-9a-f-]{36}", str(payload.get("jobId", "")), re.I):
        raise ValueError("训练任务 ID 不正确")
    if not re.fullmatch(r"[A-Za-z0-9_-]+", str(payload.get("outputName", ""))):
        raise ValueError("输出名称不正确")
    dataset = payload.get("dataset")
    if not isinstance(dataset, list) or not 5 <= len(dataset) <= 200:
        raise ValueError("训练数据集数量必须为 5 到 200")
    parameters = payload.get("parameters")
    if not isinstance(parameters, dict):
        raise ValueError("训练参数缺失")
    integer_ranges = {
        "rank": (8, 64), "alpha": (1, 64), "epochs": (1, 20), "repeats": (1, 50),
        "resolution": (512, 1536), "gradientAccumulationSteps": (1, 4), "keepTokens": (0, 10),
        "seed": (0, 2147483647),
    }
    for name, (minimum, maximum) in integer_ranges.items():
        value = parameters.get(name)
        if not isinstance(value, int) or not minimum <= value <= maximum:
            raise ValueError(f"训练参数 {name} 不正确")
    if parameters["alpha"] > parameters["rank"] or parameters["resolution"] % 64 != 0:
        raise ValueError("Alpha 或训练分辨率不正确")
    if parameters.get("lrScheduler") not in ("constant", "cosine", "cosine_with_restarts"):
        raise ValueError("学习率调度器不正确")
    numeric_ranges = {"learningRate": (0.000001, 0.01), "warmupRatio": (0.0, 0.2), "captionDropoutRate": (0.0, 0.3)}
    for name, (minimum, maximum) in numeric_ranges.items():
        value = parameters.get(name)
        if not isinstance(value, (int, float)) or not minimum <= float(value) <= maximum:
            raise ValueError(f"训练参数 {name} 不正确")
    if not isinstance(parameters.get("shuffleCaption"), bool):
        raise ValueError("Caption 打乱参数不正确")
    for name in ("baseModelFile", "textEncoderFile", "vaeFile"):
        if Path(str(payload.get(name, ""))).name != str(payload.get(name, "")):
            raise ValueError("模型文件名不正确")


def download_dataset(job_id: str, payload: dict[str, Any]) -> Path:
    """逐图下载并校验 SHA-256，任何不完整数据都会终止训练。"""
    image_dir = JOBS / job_id / "dataset" / "images"
    image_dir.mkdir(parents=True, exist_ok=True)
    for index, item in enumerate(payload["dataset"]):
        expected = str(item.get("sha256", ""))
        request = urllib.request.Request(str(item.get("url", "")), headers={"x-training-runtime-token": TOKEN})
        with urllib.request.urlopen(request, timeout=120) as response:
            body = response.read(30 * 1024 * 1024)
        actual = hashlib.sha256(body).hexdigest()
        if actual != expected:
            raise RuntimeError(f"训练图片 {index + 1} SHA-256 校验失败")
        stem = f"{index + 1:04d}_{actual[:12]}"
        (image_dir / f"{stem}.webp").write_bytes(body)
        caption = str(item.get("caption", "")).replace("\x00", " ").strip()
        if not caption:
            raise RuntimeError(f"训练图片 {index + 1} 缺少 Caption")
        (image_dir / f"{stem}.txt").write_text(caption, encoding="utf-8")
    return image_dir


def write_dataset_config(job_id: str, image_dir: Path, parameters: dict[str, Any]) -> Path:
    """写入 sd-scripts 官方数据集 TOML。"""
    path = JOBS / job_id / "dataset.toml"
    escaped = str(image_dir).replace("\\", "/").replace('"', '\\"')
    path.write_text(
        "[general]\ncaption_extension = \".txt\"\n\n"
        f"[[datasets]]\nresolution = {int(parameters['resolution'])}\nbatch_size = 1\nenable_bucket = true\nbucket_no_upscale = true\n\n"
        f"  [[datasets.subsets]]\n  image_dir = \"{escaped}\"\n  num_repeats = {int(parameters['repeats'])}\n"
        f"  shuffle_caption = {str(bool(parameters['shuffleCaption'])).lower()}\n"
        f"  keep_tokens = {int(parameters['keepTokens'])}\n"
        f"  caption_dropout_rate = {float(parameters['captionDropoutRate'])}\n",
        encoding="utf-8",
    )
    return path


def build_command(job_id: str, payload: dict[str, Any], config: Path) -> list[str]:
    """依据 Anima 官方训练脚本构建 P40 显存受控命令。"""
    parameters = payload["parameters"]
    resolution = int(parameters["resolution"])
    blocks_to_swap = 8 if resolution <= 768 else 12 if resolution <= 1024 else 18
    output_dir = JOBS / job_id / "output"
    output_dir.mkdir(parents=True, exist_ok=True)
    image_passes = len(payload["dataset"]) * int(parameters["repeats"]) * int(parameters["epochs"])
    optimizer_steps = max(1, (image_passes + int(parameters["gradientAccumulationSteps"]) - 1) // int(parameters["gradientAccumulationSteps"]))
    warmup_steps = round(optimizer_steps * float(parameters["warmupRatio"]))
    command = [
        str(VENV / "bin" / "accelerate"), "launch", "--num_cpu_threads_per_process", "4",
        str(SD_SCRIPTS / "anima_train_network.py"),
        f"--pretrained_model_name_or_path={MODEL_ROOT / 'diffusion_models' / payload['baseModelFile']}",
        f"--qwen3={MODEL_ROOT / 'text_encoders' / payload['textEncoderFile']}",
        f"--vae={MODEL_ROOT / 'vae' / payload['vaeFile']}",
        f"--dataset_config={config}", f"--output_dir={output_dir}", f"--output_name={payload['outputName']}",
        "--save_model_as=safetensors", "--network_module=networks.lora_anima",
        "--network_train_unet_only",
        f"--network_dim={int(parameters['rank'])}", f"--network_alpha={int(parameters['alpha'])}",
        f"--learning_rate={float(parameters['learningRate'])}", "--optimizer_type=AdamW8bit", f"--lr_scheduler={parameters['lrScheduler']}",
        f"--lr_warmup_steps={warmup_steps}", f"--gradient_accumulation_steps={int(parameters['gradientAccumulationSteps'])}",
        "--timestep_sampling=sigmoid", "--discrete_flow_shift=1.0", f"--max_train_epochs={int(parameters['epochs'])}",
        "--mixed_precision=bf16", "--save_precision=bf16", "--gradient_checkpointing", "--cache_latents",
        "--qwen_image_vae_2d", f"--blocks_to_swap={blocks_to_swap}",
        f"--seed={int(parameters['seed'])}", "--max_data_loader_n_workers=4", "--persistent_data_loader_workers",
    ]
    # sd-scripts 禁止在随机打乱 Caption 时缓存 Text Encoder 输出；保留用户参数并自动切换兼容执行路径。
    if not parameters["shuffleCaption"]:
        command.append("--cache_text_encoder_outputs")
    if parameters["lrScheduler"] == "cosine_with_restarts":
        command.append("--lr_scheduler_num_cycles=2")
    return command


def training_failure_message(log_path: Path, exit_code: int) -> str:
    """从训练日志尾部提取可操作错误，避免只向任务记录写入退出码。"""
    try:
        content = log_path.read_text(encoding="utf-8", errors="replace")[-128 * 1024 :]
    except OSError:
        return f"训练进程退出码 {exit_code}"
    known_errors = (
        ("when caching Text Encoder output", "Text Encoder 输出缓存与 Caption 随机打乱参数冲突"),
        ("CUDA out of memory", "GPU 显存不足，请降低训练分辨率、Rank 或梯度累积"),
        ("No space left on device", "GPU 训练磁盘空间不足"),
    )
    for marker, message in known_errors:
        if marker in content:
            return message
    prefixes = ("AssertionError:", "RuntimeError:", "ValueError:", "FileNotFoundError:", "ModuleNotFoundError:")
    for line in reversed(content.splitlines()):
        normalized = line.strip()
        if normalized.startswith(prefixes):
            return f"训练进程退出码 {exit_code}：{normalized}"[:2000]
    return f"训练进程退出码 {exit_code}；请查看 Runtime 训练日志"


def acquire_training_slot(job_id: str) -> bool:
    """按提交顺序等待唯一训练槽位；排队任务取消后立即退出。"""
    global active_training_job_id
    with training_condition:
        waiting_job_ids.append(job_id)
        while True:
            state = load_state(job_id)
            if not state or state.get("status") == "cancelled":
                waiting_job_ids.remove(job_id)
                training_condition.notify_all()
                return False
            if active_training_job_id is None and waiting_job_ids[0] == job_id:
                waiting_job_ids.pop(0)
                active_training_job_id = job_id
                return True
            training_condition.wait(timeout=1)


def release_training_slot(job_id: str) -> None:
    """训练进入终态后释放唯一槽位并唤醒下一项。"""
    global active_training_job_id
    with training_condition:
        if active_training_job_id == job_id:
            active_training_job_id = None
        if job_id in waiting_job_ids:
            waiting_job_ids.remove(job_id)
        training_condition.notify_all()


def run_training(job_id: str, payload: dict[str, Any]) -> None:
    """在后台执行单个真实训练进程并持续更新进度与终态。"""
    state = load_state(job_id)
    if not state:
        return
    slot_acquired = False
    try:
        slot_acquired = acquire_training_slot(job_id)
        if not slot_acquired:
            return
        image_dir = download_dataset(job_id, payload)
        config = write_dataset_config(job_id, image_dir, payload["parameters"])
        command = build_command(job_id, payload, config)
        log_path = JOBS / job_id / "training.log"
        environment = {**os.environ, "CUDA_VISIBLE_DEVICES": CUDA_DEVICE, "PYTHONUNBUFFERED": "1"}
        with log_path.open("a", encoding="utf-8") as log:
            # 状态切换、进程创建与取消共用同一把锁，避免下载期间的取消被旧状态覆盖。
            with training_condition:
                current_state = load_state(job_id) or {}
                if current_state.get("status") == "cancelled":
                    return
                blocks_to_swap = next((int(item.split("=", 1)[1]) for item in command if item.startswith("--blocks_to_swap=")), 18)
                current_state.update({"status": "running", "progress": 2, "currentEpoch": 0, "metrics": {"command": command, "runtimeProfile": "anima-p40-fast-v1", "blocksToSwap": blocks_to_swap, "memoryCacheEnabled": True, "textEncoderCacheEnabled": not payload["parameters"]["shuffleCaption"]}, "errorMessage": None})
                process = subprocess.Popen(command, cwd=SD_SCRIPTS, env=environment, stdout=subprocess.PIPE, stderr=subprocess.STDOUT, text=True, bufsize=1, start_new_session=True)
                processes[job_id] = process
                current_state["pid"] = process.pid
                save_state(job_id, current_state)
                state = current_state
            assert process.stdout is not None
            for line in process.stdout:
                log.write(line); log.flush()
                match = re.search(r"epoch\s+(\d+)\s*/\s*(\d+)", line, re.I)
                if match:
                    current = int(match.group(1)); total = max(1, int(match.group(2)))
                    state.update({"currentEpoch": current, "totalEpochs": total, "progress": min(95, max(3, current / total * 95))})
                    save_state(job_id, state)
                    continue
                # sd-scripts 的主进度使用 steps 百分比而不是逐 Epoch 文本，按优化步实时回写用户可见进度。
                step_match = re.search(r"steps:\s*(\d+)%.*?(\d+)\s*/\s*(\d+)", line, re.I)
                if step_match:
                    current_step = int(step_match.group(2)); total_steps = max(1, int(step_match.group(3)))
                    total_epochs = max(1, int(state["totalEpochs"]))
                    state.update({"currentEpoch": min(total_epochs, int(current_step / total_steps * total_epochs)), "progress": min(95, max(3, current_step / total_steps * 95))})
                    save_state(job_id, state)
            exit_code = process.wait()
        if load_state(job_id).get("status") == "cancelled":
            return
        if exit_code != 0:
            raise RuntimeError(training_failure_message(log_path, exit_code))
        output = JOBS / job_id / "output" / f"{payload['outputName']}.safetensors"
        if not output.exists() or output.stat().st_size < 1024:
            raise RuntimeError("训练完成但未生成有效 safetensors 文件")
        digest = hashlib.sha256(output.read_bytes()).hexdigest()
        state.update({"status": "succeeded", "progress": 100, "pid": None, "currentEpoch": state["totalEpochs"], "outputSha256": digest, "outputBytes": output.stat().st_size})
        save_state(job_id, state)
    except Exception as error:
        state = load_state(job_id) or state
        if state.get("status") != "cancelled":
            state.update({"status": "failed", "progress": 100, "pid": None, "errorMessage": str(error)[:2000]})
            save_state(job_id, state)
    finally:
        with training_condition:
            processes.pop(job_id, None)
        if slot_acquired:
            release_training_slot(job_id)


class Handler(BaseHTTPRequestHandler):
    """提供训练提交、轮询、取消、日志和产物下载 HTTP 接口。"""

    server_version = "DrawHimeTrainingRuntime/1.0"

    def do_GET(self) -> None:
        if self.path == "/health":
            return self.send_json(200, {"ok": True, "data": {"ready": bool(TOKEN and SD_SCRIPTS.exists() and (VENV / "bin" / "accelerate").exists())}})
        if not self.authorized():
            return self.send_json(403, {"ok": False, "code": "forbidden", "message": "服务凭证不正确"})
        if self.path == "/v1/system/gpus":
            try:
                output = subprocess.check_output(["nvidia-smi", "--query-gpu=index,name,memory.total,memory.free,utilization.gpu,temperature.gpu", "--format=csv,noheader,nounits"], text=True, timeout=10)
                devices = []
                for line in output.splitlines():
                    values = [item.strip() for item in line.split(",")]
                    if len(values) == 6:
                        devices.append({"index": int(values[0]), "name": values[1], "totalVramBytes": int(values[2]) * 1024 * 1024, "freeVramBytes": int(values[3]) * 1024 * 1024, "utilizationPercent": float(values[4]), "temperatureCelsius": float(values[5])})
                return self.send_json(200, {"ok": True, "data": {"devices": devices}})
            except Exception as error:
                return self.send_json(500, {"ok": False, "code": "gpu_metrics_failed", "message": str(error)[:500]})
        match = re.fullmatch(r"/v1/training/jobs/([0-9a-f-]{36})(/output|/log)?", self.path, re.I)
        if not match:
            return self.send_json(404, {"ok": False, "code": "not_found", "message": "端点不存在"})
        job_id, suffix = match.group(1), match.group(2)
        state = load_state(job_id)
        if not state:
            return self.send_json(404, {"ok": False, "code": "job_not_found", "message": "训练任务不存在"})
        if suffix == "/output":
            if state.get("status") != "succeeded":
                return self.send_json(409, {"ok": False, "code": "output_not_ready", "message": "训练产物尚未就绪"})
            output = JOBS / job_id / "output" / f"{state['outputName']}.safetensors"
            return self.send_file(output, "application/octet-stream", state["outputSha256"])
        if suffix == "/log":
            log = JOBS / job_id / "training.log"
            return self.send_file(log, "text/plain; charset=utf-8", None) if log.exists() else self.send_json(404, {"ok": False, "code": "log_not_found", "message": "日志尚未生成"})
        return self.send_json(200, {"ok": True, "data": public_state(state)})

    def do_POST(self) -> None:
        if not self.authorized():
            return self.send_json(403, {"ok": False, "code": "forbidden", "message": "服务凭证不正确"})
        if self.path == "/v1/training/jobs":
            try:
                payload = self.read_json(); validate_request(payload); job_id = payload["jobId"]
                existing = load_state(job_id)
                if existing:
                    return self.send_json(200, {"ok": True, "data": public_state(existing)})
                state = {"jobId": job_id, "status": "queued", "progress": 0, "pid": None, "currentEpoch": 0, "totalEpochs": int(payload["parameters"]["epochs"]), "metrics": {}, "errorMessage": None, "outputName": payload["outputName"], "outputSha256": None, "outputBytes": None, "createdAt": utc_now(), "updatedAt": utc_now()}
                save_state(job_id, state)
                threading.Thread(target=run_training, args=(job_id, payload), daemon=True).start()
                return self.send_json(201, {"ok": True, "data": public_state(state)})
            except Exception as error:
                return self.send_json(400, {"ok": False, "code": "invalid_request", "message": str(error)[:1000]})
        match = re.fullmatch(r"/v1/training/jobs/([0-9a-f-]{36})/cancel", self.path, re.I)
        if not match:
            return self.send_json(404, {"ok": False, "code": "not_found", "message": "端点不存在"})
        job_id = match.group(1); state = load_state(job_id)
        if not state:
            return self.send_json(404, {"ok": False, "code": "job_not_found", "message": "训练任务不存在"})
        with training_condition:
            process = processes.get(job_id)
            if process and process.poll() is None:
                os.killpg(process.pid, signal.SIGTERM)
            state.update({"status": "cancelled", "progress": 100, "pid": None, "errorMessage": "训练由控制面取消"}); save_state(job_id, state)
            training_condition.notify_all()
        return self.send_json(200, {"ok": True, "data": public_state(state)})

    def authorized(self) -> bool:
        """校验固定训练服务令牌。"""
        return bool(TOKEN and self.headers.get("x-training-runtime-token", "") == TOKEN)

    def read_json(self) -> dict[str, Any]:
        """读取有上限的 JSON 请求。"""
        length = int(self.headers.get("content-length", "0"))
        if length <= 0 or length > 2 * 1024 * 1024:
            raise ValueError("请求体大小不正确")
        return json.loads(self.rfile.read(length))

    def send_json(self, status: int, body: dict[str, Any]) -> None:
        """发送统一 JSON 响应。"""
        data = json.dumps(body, ensure_ascii=False).encode("utf-8")
        self.send_response(status); self.send_header("content-type", "application/json; charset=utf-8"); self.send_header("content-length", str(len(data))); self.send_header("cache-control", "no-store"); self.end_headers(); self.wfile.write(data)

    def send_file(self, path: Path, content_type: str, sha256: str | None) -> None:
        """按标准单段 Range 流式输出文件，支持产物断点续传。"""
        if not path.exists():
            return self.send_json(404, {"ok": False, "code": "file_not_found", "message": "文件不存在"})
        size = path.stat().st_size
        start, end, status = 0, size - 1, 200
        range_header = self.headers.get("range", "").strip()
        if range_header:
            match = re.fullmatch(r"bytes=(\d+)-(\d*)", range_header, re.I)
            if not match:
                self.send_response(416); self.send_header("content-range", f"bytes */{size}"); self.send_header("content-length", "0"); self.end_headers(); return
            start = int(match.group(1))
            end = min(int(match.group(2)) if match.group(2) else size - 1, size - 1)
            if start >= size or end < start:
                self.send_response(416); self.send_header("content-range", f"bytes */{size}"); self.send_header("content-length", "0"); self.end_headers(); return
            status = 206
        length = end - start + 1
        self.send_response(status); self.send_header("content-type", content_type); self.send_header("content-length", str(length)); self.send_header("accept-ranges", "bytes"); self.send_header("cache-control", "no-store")
        if status == 206:
            self.send_header("content-range", f"bytes {start}-{end}/{size}")
        if sha256:
            self.send_header("x-content-sha256", sha256)
        self.end_headers()
        with path.open("rb") as source:
            source.seek(start)
            remaining = length
            while remaining > 0 and (chunk := source.read(min(64 * 1024, remaining))):
                self.wfile.write(chunk)
                self.wfile.flush()
                remaining -= len(chunk)

    def log_message(self, format: str, *args: Any) -> None:
        """输出精简访问日志。"""
        print(f"[{utc_now()}] {self.address_string()} {format % args}", flush=True)


def public_state(state: dict[str, Any]) -> dict[str, Any]:
    """移除内部输出名与命令细节，仅返回契约字段。"""
    return {key: state.get(key) for key in ("jobId", "status", "progress", "pid", "currentEpoch", "totalEpochs", "metrics", "errorMessage", "outputSha256", "outputBytes", "createdAt", "updatedAt")}


if __name__ == "__main__":
    if not TOKEN:
        raise SystemExit("TRAINING_RUNTIME_TOKEN 未配置")
    JOBS.mkdir(parents=True, exist_ok=True)
    recover_interrupted_states()
    print(f"训练 Runtime 已监听 0.0.0.0:{PORT}", flush=True)
    ThreadingHTTPServer(("0.0.0.0", PORT), Handler).serve_forever()
