"""本文件为 ComfyUI 提供受保护的 LoRA 查询与原子同步接口。"""

import hashlib
import hmac
import json
import os
import re
import tempfile
from pathlib import Path

import folder_paths
from aiohttp import web
from server import PromptServer


MAX_LORA_BYTES = 1024 * 1024 * 1024
SAFE_FILE_NAME = re.compile(r"^aiimage_lora_[a-f0-9]{64}\.safetensors$")
SAFE_SHA256 = re.compile(r"^[a-f0-9]{64}$")
HASH_CACHE: dict[str, tuple[int, int, str]] = {}


def _expected_token() -> str:
    """读取只存在于 GPU 服务环境中的内部同步 token。"""
    return os.getenv("AIIMAGE_LORA_SYNC_TOKEN", "").strip()


def _authorized(request: web.Request) -> bool:
    """使用常量时间比较校验服务间 token。"""
    expected = _expected_token()
    supplied = request.headers.get("x-service-token", "").strip()
    return bool(expected) and hmac.compare_digest(expected, supplied)


def _resolve_lora_path(file_name: str) -> Path:
    """把安全文件名限定到 ComfyUI 第一个 LoRA 模型目录。"""
    if not SAFE_FILE_NAME.fullmatch(file_name):
        raise web.HTTPBadRequest(text=json.dumps({"ok": False, "message": "LoRA 文件名不正确"}), content_type="application/json")
    directories = folder_paths.get_folder_paths("loras")
    if not directories:
        raise web.HTTPServiceUnavailable(text=json.dumps({"ok": False, "message": "ComfyUI 未配置 LoRA 目录"}), content_type="application/json")
    base = Path(directories[0]).resolve()
    target = (base / file_name).resolve()
    if target.parent != base:
        raise web.HTTPBadRequest(text=json.dumps({"ok": False, "message": "LoRA 文件路径不正确"}), content_type="application/json")
    return target


def _file_sha256(path: Path) -> str:
    """按文件大小和纳秒修改时间缓存哈希，避免每次任务重复扫描大文件。"""
    stat = path.stat()
    cached = HASH_CACHE.get(str(path))
    if cached and cached[0] == stat.st_size and cached[1] == stat.st_mtime_ns:
        return cached[2]
    digest = hashlib.sha256()
    with path.open("rb") as source:
        for chunk in iter(lambda: source.read(1024 * 1024), b""):
            digest.update(chunk)
    value = digest.hexdigest()
    HASH_CACHE[str(path)] = (stat.st_size, stat.st_mtime_ns, value)
    return value


def _validate_safetensors(path: Path, total_bytes: int) -> None:
    """校验 safetensors 文件头和至少一个真实张量目录。"""
    if total_bytes < 10:
        raise ValueError("safetensors 文件结构不正确")
    with path.open("rb") as source:
        header_size = int.from_bytes(source.read(8), "little", signed=False)
        if header_size <= 1 or header_size > 16 * 1024 * 1024 or header_size > total_bytes - 8:
            raise ValueError("safetensors 文件头长度不正确")
        metadata = json.loads(source.read(header_size).decode("utf-8").strip())
    tensors = [value for key, value in metadata.items() if key != "__metadata__"] if isinstance(metadata, dict) else []
    if not tensors or not all(isinstance(value, dict) and isinstance(value.get("dtype"), str) and isinstance(value.get("shape"), list) and isinstance(value.get("data_offsets"), list) and len(value["data_offsets"]) == 2 for value in tensors):
        raise ValueError("safetensors 张量目录不正确")


def _clear_comfy_lora_cache() -> None:
    """写入后清理 ComfyUI 强缓存，使下一次工作流立即识别新 LoRA。"""
    folder_paths.filename_list_cache.pop("loras", None)
    folder_paths.cache_helper.clear()


@PromptServer.instance.routes.get("/aiimage/loras/{file_name}")
async def get_lora_status(request: web.Request) -> web.Response:
    """返回 GPU 上指定安全文件名的真实大小与 SHA-256。"""
    if not _authorized(request):
        raise web.HTTPForbidden(text=json.dumps({"ok": False, "message": "服务间 token 不正确"}), content_type="application/json")
    target = _resolve_lora_path(request.match_info["file_name"])
    if not target.is_file():
        raise web.HTTPNotFound(text=json.dumps({"ok": False, "message": "LoRA 文件不存在"}), content_type="application/json")
    return web.json_response({"ok": True, "fileName": target.name, "sizeBytes": target.stat().st_size, "sha256": _file_sha256(target)})


@PromptServer.instance.routes.put("/aiimage/loras/{file_name}")
async def put_lora_file(request: web.Request) -> web.Response:
    """流式接收 LoRA，完成大小、哈希和 safetensors 校验后原子替换。"""
    if not _authorized(request):
        raise web.HTTPForbidden(text=json.dumps({"ok": False, "message": "服务间 token 不正确"}), content_type="application/json")
    target = _resolve_lora_path(request.match_info["file_name"])
    expected_sha256 = request.headers.get("x-aiimage-sha256", "").strip().lower()
    content_length = request.content_length
    if not SAFE_SHA256.fullmatch(expected_sha256):
        raise web.HTTPBadRequest(text=json.dumps({"ok": False, "message": "LoRA 文件哈希不正确"}), content_type="application/json")
    if content_length is None or content_length <= 0 or content_length > MAX_LORA_BYTES:
        raise web.HTTPRequestEntityTooLarge(max_size=MAX_LORA_BYTES, actual_size=content_length or 0)
    target.parent.mkdir(parents=True, exist_ok=True)
    descriptor, temporary_name = tempfile.mkstemp(prefix=f".{target.name}.", suffix=".part", dir=target.parent)
    temporary = Path(temporary_name)
    digest = hashlib.sha256()
    written = 0
    try:
        with os.fdopen(descriptor, "wb") as output:
            async for chunk in request.content.iter_chunked(1024 * 1024):
                written += len(chunk)
                if written > content_length or written > MAX_LORA_BYTES:
                    raise ValueError("LoRA 文件超过声明大小")
                output.write(chunk)
                digest.update(chunk)
            output.flush()
            os.fsync(output.fileno())
        if written != content_length:
            raise ValueError("LoRA 文件大小与声明不一致")
        actual_sha256 = digest.hexdigest()
        if not hmac.compare_digest(actual_sha256, expected_sha256):
            raise ValueError("LoRA 文件哈希校验失败")
        _validate_safetensors(temporary, written)
        os.chmod(temporary, 0o644)
        os.replace(temporary, target)
        HASH_CACHE.pop(str(target), None)
        _clear_comfy_lora_cache()
        return web.json_response({"ok": True, "fileName": target.name, "sizeBytes": written, "sha256": actual_sha256})
    except (ValueError, json.JSONDecodeError, UnicodeDecodeError) as error:
        temporary.unlink(missing_ok=True)
        raise web.HTTPBadRequest(text=json.dumps({"ok": False, "message": str(error)}, ensure_ascii=False), content_type="application/json") from error
    except Exception:
        temporary.unlink(missing_ok=True)
        raise


NODE_CLASS_MAPPINGS = {}
NODE_DISPLAY_NAME_MAPPINGS = {}
