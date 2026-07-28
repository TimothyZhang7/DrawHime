"""本文件为 ComfyUI 提供受保护的 LoRA 查询与原子同步接口。"""

import asyncio
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
MAX_UPLOAD_CHUNK_BYTES = 8 * 1024 * 1024
SAFE_FILE_NAME = re.compile(r"^aiimage_lora_[a-f0-9]{64}\.safetensors$")
SAFE_SHA256 = re.compile(r"^[a-f0-9]{64}$")
HASH_CACHE: dict[str, tuple[int, int, str]] = {}
UPLOAD_LOCKS: dict[str, asyncio.Lock] = {}


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


def _json_error(status: int, code: str, message: str, **data: object) -> web.HTTPException:
    """构造统一 JSON 错误，并在偏移冲突时携带可恢复的真实状态。"""
    payload: dict[str, object] = {"ok": False, "code": code, "message": message}
    payload.update(data)
    if status == 413:
        maximum = int(data.get("maxBytes", data.get("maxChunkBytes", MAX_LORA_BYTES)))
        actual = int(data.get("actualBytes", maximum + 1))
        return web.HTTPRequestEntityTooLarge(max_size=maximum, actual_size=actual, text=json.dumps(payload, ensure_ascii=False), content_type="application/json")
    exception_type = {
        400: web.HTTPBadRequest,
        403: web.HTTPForbidden,
        404: web.HTTPNotFound,
        409: web.HTTPConflict,
        503: web.HTTPServiceUnavailable,
    }.get(status, web.HTTPInternalServerError)
    return exception_type(text=json.dumps(payload, ensure_ascii=False), content_type="application/json")


def _read_upload_identity(request: web.Request, target: Path) -> tuple[str, int]:
    """读取并校验断点上传的完整哈希和总大小，确保临时文件身份稳定。"""
    expected_sha256 = request.headers.get("x-aiimage-sha256", "").strip().lower()
    if not SAFE_SHA256.fullmatch(expected_sha256):
        raise _json_error(400, "invalid_lora_sha256", "LoRA 文件哈希不正确")
    expected_file_name = f"aiimage_lora_{expected_sha256}.safetensors"
    if target.name != expected_file_name:
        raise _json_error(400, "lora_sha256_mismatch", "LoRA 文件名与声明哈希不一致")
    try:
        total_bytes = int(request.headers.get("x-aiimage-total-bytes", ""))
    except ValueError as error:
        raise _json_error(400, "invalid_lora_size", "LoRA 文件总大小不正确") from error
    if total_bytes <= 0 or total_bytes > MAX_LORA_BYTES:
        raise _json_error(413, "lora_too_large", "LoRA 文件超过允许大小", maxBytes=MAX_LORA_BYTES)
    return expected_sha256, total_bytes


def _upload_path(target: Path) -> Path:
    """为同一内容哈希生成固定临时路径，使进程和网络中断后可以续传。"""
    return target.parent / f".{target.name}.upload.part"


def _upload_lock(target: Path) -> asyncio.Lock:
    """同一 LoRA 只允许一个请求修改偏移，避免并发追加破坏文件。"""
    key = str(target)
    lock = UPLOAD_LOCKS.get(key)
    if lock is None:
        lock = asyncio.Lock()
        UPLOAD_LOCKS[key] = lock
    return lock


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


@PromptServer.instance.routes.get("/aiimage/loras/{file_name}/upload")
async def get_lora_upload_status(request: web.Request) -> web.Response:
    """返回已安装状态或固定临时文件的真实续传偏移。"""
    if not _authorized(request):
        raise _json_error(403, "invalid_service_token", "服务间 token 不正确")
    target = _resolve_lora_path(request.match_info["file_name"])
    expected_sha256, total_bytes = _read_upload_identity(request, target)
    target.parent.mkdir(parents=True, exist_ok=True)
    if target.is_file() and target.stat().st_size == total_bytes:
        actual_sha256 = await asyncio.to_thread(_file_sha256, target)
        if hmac.compare_digest(actual_sha256, expected_sha256):
            return web.json_response({"ok": True, "data": {"state": "complete", "offset": total_bytes, "totalBytes": total_bytes, "sha256": actual_sha256}})
    temporary = _upload_path(target)
    offset = temporary.stat().st_size if temporary.is_file() else 0
    if offset > total_bytes:
        temporary.unlink(missing_ok=True)
        offset = 0
    return web.json_response({"ok": True, "data": {"state": "uploading", "offset": offset, "totalBytes": total_bytes, "sha256": expected_sha256}})


@PromptServer.instance.routes.put("/aiimage/loras/{file_name}/upload")
async def put_lora_upload_chunk(request: web.Request) -> web.Response:
    """按服务端真实偏移追加一个有限大小分片，并持久化到磁盘。"""
    if not _authorized(request):
        raise _json_error(403, "invalid_service_token", "服务间 token 不正确")
    target = _resolve_lora_path(request.match_info["file_name"])
    expected_sha256, total_bytes = _read_upload_identity(request, target)
    content_length = request.content_length
    if content_length is None or content_length <= 0 or content_length > MAX_UPLOAD_CHUNK_BYTES:
        raise _json_error(413, "invalid_chunk_size", "LoRA 上传分片大小不正确", maxChunkBytes=MAX_UPLOAD_CHUNK_BYTES)
    try:
        expected_offset = int(request.headers.get("x-aiimage-offset", ""))
    except ValueError as error:
        raise _json_error(400, "invalid_upload_offset", "LoRA 上传偏移不正确") from error
    if expected_offset < 0 or expected_offset + content_length > total_bytes:
        raise _json_error(400, "invalid_upload_range", "LoRA 上传范围不正确")
    target.parent.mkdir(parents=True, exist_ok=True)
    temporary = _upload_path(target)
    async with _upload_lock(target):
        actual_offset = temporary.stat().st_size if temporary.is_file() else 0
        if actual_offset != expected_offset:
            raise _json_error(409, "upload_offset_conflict", "LoRA 上传偏移已变化", offset=actual_offset, totalBytes=total_bytes)
        written = 0
        try:
            with temporary.open("ab") as output:
                async for chunk in request.content.iter_chunked(1024 * 1024):
                    written += len(chunk)
                    if written > content_length:
                        raise _json_error(400, "chunk_size_mismatch", "LoRA 上传分片超过声明大小")
                    output.write(chunk)
                output.flush()
                os.fsync(output.fileno())
            if written != content_length:
                raise _json_error(400, "chunk_size_mismatch", "LoRA 上传分片与声明大小不一致")
        except Exception:
            with temporary.open("r+b") as rollback:
                rollback.truncate(expected_offset)
            raise
        next_offset = expected_offset + written
    return web.json_response({"ok": True, "data": {"state": "uploading", "offset": next_offset, "totalBytes": total_bytes, "sha256": expected_sha256}})


@PromptServer.instance.routes.post("/aiimage/loras/{file_name}/upload")
async def complete_lora_upload(request: web.Request) -> web.Response:
    """校验完整断点文件并原子安装，只有完成后工作流才可引用。"""
    if not _authorized(request):
        raise _json_error(403, "invalid_service_token", "服务间 token 不正确")
    target = _resolve_lora_path(request.match_info["file_name"])
    expected_sha256, total_bytes = _read_upload_identity(request, target)
    temporary = _upload_path(target)
    async with _upload_lock(target):
        actual_size = temporary.stat().st_size if temporary.is_file() else 0
        if actual_size != total_bytes:
            raise _json_error(409, "upload_incomplete", "LoRA 文件尚未上传完整", offset=actual_size, totalBytes=total_bytes)
        actual_sha256 = await asyncio.to_thread(_file_sha256, temporary)
        if not hmac.compare_digest(actual_sha256, expected_sha256):
            temporary.unlink(missing_ok=True)
            raise _json_error(400, "lora_sha256_mismatch", "LoRA 文件哈希校验失败")
        try:
            await asyncio.to_thread(_validate_safetensors, temporary, total_bytes)
        except (ValueError, json.JSONDecodeError, UnicodeDecodeError) as error:
            temporary.unlink(missing_ok=True)
            raise _json_error(400, "invalid_safetensors", str(error)) from error
        os.chmod(temporary, 0o644)
        os.replace(temporary, target)
        HASH_CACHE.pop(str(temporary), None)
        HASH_CACHE.pop(str(target), None)
        _clear_comfy_lora_cache()
    return web.json_response({"ok": True, "data": {"state": "complete", "offset": total_bytes, "totalBytes": total_bytes, "fileName": target.name, "sha256": actual_sha256}})


@PromptServer.instance.routes.delete("/aiimage/loras/{file_name}/upload")
async def cancel_lora_upload(request: web.Request) -> web.Response:
    """清理指定内容哈希尚未完成的临时文件，不影响已安装 LoRA。"""
    if not _authorized(request):
        raise _json_error(403, "invalid_service_token", "服务间 token 不正确")
    target = _resolve_lora_path(request.match_info["file_name"])
    _read_upload_identity(request, target)
    async with _upload_lock(target):
        _upload_path(target).unlink(missing_ok=True)
    return web.json_response({"ok": True, "data": {"deleted": True, "fileName": target.name}})


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
