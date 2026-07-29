"""本文件在 GPU 主机提供受令牌保护的桌面模型白名单与单段 Range 下载。"""
from __future__ import annotations

import hmac
import json
import os
import re
from datetime import datetime, timezone
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path

MODEL_ROOT = Path(os.environ.get("COMFYUI_MODEL_ROOT", "/data/ComfyUI-master/models"))
TOKEN = os.environ.get("DESKTOP_MODEL_RUNTIME_TOKEN", "").strip()
PORT = int(os.environ.get("DESKTOP_MODEL_RUNTIME_PORT", "7121"))
# 文件名、目录、大小和哈希来自已核验的官方模型版本，不接受客户端路径。
MODEL_FILES = {
    "anima-base-v1.0.safetensors": ("diffusion_models", 4_182_218_328, "bd43b7cffe1ed1153d9c41e7beb2f18cb1273eafbaa3af3edd6a173dc90a006e"),
    "animeBulldozer_anima.safetensors": ("diffusion_models", 4_182_218_504, "8e279f111ed7e7ea214ea61850e002f700cce55a8cd027675796773089b3c739"),
    "miaomiaoRealskin_anima11.safetensors": ("diffusion_models", 4_182_218_328, "d33247d48a9c15a872aef963940fc87362f925e3e087365810ad747042fcc454"),
    "miaomiao3DHarem_animaLH3D10.safetensors": ("diffusion_models", 4_182_218_328, "0707cbe8deed6c858a6ba8dfbcfe2006e3a4fd44c099aafd048400fdec1866dd"),
    "waiANIMA_v10Base10.safetensors": ("diffusion_models", 4_182_233_976, "9d5a1e1393c2978d6a979fab38fb0dee00bc2a94e354196c9f3cf2f6f56d5fbf"),
    "qwen_3_06b_base.safetensors": ("text_encoders", 1_192_135_096, "cd2a512003e2f9f3cd3c32a9c3573f820bb28c940f73c57b1ddaa983d9223eba"),
    "qwen_image_vae.safetensors": ("vae", 253_806_246, "a70580f0213e67967ee9c95f05bb400e8fb08307e017a924bf3441223e023d1f"),
}


def utc_now() -> str:
    """返回访问日志使用的 UTC 时间。"""
    return datetime.now(timezone.utc).isoformat().replace("+00:00", "Z")


def available_models() -> int:
    """统计大小符合白名单的本机模型组件。"""
    return sum(1 for name, (directory, size, _) in MODEL_FILES.items() if (MODEL_ROOT / directory / name).is_file() and (MODEL_ROOT / directory / name).stat().st_size == size)


class Handler(BaseHTTPRequestHandler):
    """提供健康检查和受保护的模型分片下载。"""

    server_version = "DrawHimeDesktopModelRuntime/1.0"

    def do_GET(self) -> None:
        if self.path == "/health":
            count = available_models()
            return self.send_json(200, {"ok": True, "data": {"ready": bool(TOKEN and count == len(MODEL_FILES)), "available": count, "total": len(MODEL_FILES)}})
        if not self.authorized():
            return self.send_json(403, {"ok": False, "code": "forbidden", "message": "服务凭证不正确"})
        match = re.fullmatch(r"/v1/models/([A-Za-z0-9._-]+)", self.path)
        if not match or match.group(1) not in MODEL_FILES:
            return self.send_json(404, {"ok": False, "code": "model_not_found", "message": "桌面模型资源不存在"})
        file_name = match.group(1)
        directory, expected_size, sha256 = MODEL_FILES[file_name]
        path = MODEL_ROOT / directory / file_name
        if not path.is_file() or path.stat().st_size != expected_size:
            return self.send_json(503, {"ok": False, "code": "model_not_ready", "message": "桌面模型资源尚未就绪"})
        self.send_file(path, sha256)

    def authorized(self) -> bool:
        """使用常量时间比较验证平台服务令牌。"""
        received = self.headers.get("x-desktop-model-token", "")
        return bool(TOKEN and hmac.compare_digest(received, TOKEN))

    def send_file(self, path: Path, sha256: str) -> None:
        """按严格单段闭区间 Range 流式返回模型文件。"""
        size = path.stat().st_size
        start, end, status = 0, size - 1, 200
        range_header = self.headers.get("range", "").strip()
        if range_header:
            match = re.fullmatch(r"bytes=(\d+)-(\d*)", range_header, re.I)
            if not match:
                return self.send_range_error(size)
            start = int(match.group(1))
            end = int(match.group(2)) if match.group(2) else size - 1
            if start >= size or end < start or end >= size:
                return self.send_range_error(size)
            status = 206
        length = end - start + 1
        self.send_response(status)
        self.send_header("content-type", "application/octet-stream")
        self.send_header("content-length", str(length))
        self.send_header("accept-ranges", "bytes")
        self.send_header("cache-control", "private, no-store")
        self.send_header("x-content-sha256", sha256)
        if status == 206:
            self.send_header("content-range", f"bytes {start}-{end}/{size}")
        self.end_headers()
        try:
            with path.open("rb") as source:
                source.seek(start)
                remaining = length
                while remaining > 0 and (chunk := source.read(min(1024 * 1024, remaining))):
                    self.wfile.write(chunk)
                    remaining -= len(chunk)
        except (BrokenPipeError, ConnectionResetError):
            return

    def send_range_error(self, size: int) -> None:
        """返回不包含文件内容的标准 416。"""
        self.send_response(416)
        self.send_header("content-range", f"bytes */{size}")
        self.send_header("content-length", "0")
        self.end_headers()

    def send_json(self, status: int, body: dict[str, object]) -> None:
        """发送统一 JSON 响应。"""
        data = json.dumps(body, ensure_ascii=False).encode("utf-8")
        self.send_response(status)
        self.send_header("content-type", "application/json; charset=utf-8")
        self.send_header("content-length", str(len(data)))
        self.send_header("cache-control", "no-store")
        self.end_headers()
        self.wfile.write(data)

    def log_message(self, format: str, *args: object) -> None:
        """输出不包含令牌的精简访问日志。"""
        print(f"[{utc_now()}] {self.address_string()} {format % args}", flush=True)


if __name__ == "__main__":
    if not TOKEN:
        raise SystemExit("DESKTOP_MODEL_RUNTIME_TOKEN 未配置")
    print(f"桌面模型 Runtime 已监听 0.0.0.0:{PORT}", flush=True)
    ThreadingHTTPServer(("0.0.0.0", PORT), Handler).serve_forever()
