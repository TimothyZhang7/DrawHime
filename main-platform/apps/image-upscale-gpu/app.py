"""图片放大 GPU 服务入口：提供受保护的 Real-ESRGAN/ESRGAN 超分 HTTP 接口。"""
from __future__ import annotations

import hashlib
import hmac
import io
import logging
import os
import re
import threading
import time
import uuid
from collections import OrderedDict
from datetime import datetime, timezone
from pathlib import Path
from typing import Literal
from urllib.parse import quote

import numpy as np
import requests
import torch
from fastapi import FastAPI, File, Form, Header, HTTPException, UploadFile
from fastapi.responses import FileResponse, JSONResponse, Response
from PIL import Image
from spandrel import ImageModelDescriptor, ModelLoader
from wd14_tagger import Wd14TaggerError, Wd14TaggerService

ModelName = Literal[
    "RealESRGAN_x4plus",
    "RealESRNet_x4plus",
    "RealESRGAN_x2plus",
    "RealESRGAN_x4plus_anime_6B",
    "realesr-animevideov3",
    "realesr-general-x4v3",
    "realesr-general-wdn-x4v3",
]
OutputFormat = Literal["png", "webp"]
ResponseMode = Literal["binary", "s3", "local"]

APP = FastAPI(title="AIImage Image Upscale GPU Service", version="1.0.0")
logging.basicConfig(level=logging.INFO, format="%(asctime)s %(levelname)s %(message)s")
LOGGER = logging.getLogger("aiimage-upscale")
API_KEY = os.getenv("UPSCALE_API_KEY", "").strip()
MODEL_DIR = Path(os.getenv("UPSCALE_MODEL_DIR", "/data/aiimage-upscale-service/models"))
MAX_INPUT_PIXELS = int(os.getenv("UPSCALE_MAX_INPUT_PIXELS", "32000000"))
DEFAULT_DEVICE = os.getenv("UPSCALE_DEVICE", "cuda:0" if torch.cuda.is_available() else "cpu")
DEFAULT_RESPONSE_MODE = os.getenv("UPSCALE_RESPONSE_MODE", "binary").strip().lower()
S3_ENDPOINT_URL = os.getenv("UPSCALE_S3_ENDPOINT_URL", "").strip()
S3_BUCKET = os.getenv("UPSCALE_S3_BUCKET", "").strip()
S3_PUBLIC_BASE_URL = os.getenv("UPSCALE_S3_PUBLIC_BASE_URL", "").strip().rstrip("/")
S3_ACCESS_KEY_ID = os.getenv("UPSCALE_S3_ACCESS_KEY_ID", "").strip()
S3_SECRET_ACCESS_KEY = os.getenv("UPSCALE_S3_SECRET_ACCESS_KEY", "").strip()
S3_REGION = os.getenv("UPSCALE_S3_REGION", "cn-sy1").strip() or "cn-sy1"
S3_PREFIX = os.getenv("UPSCALE_S3_PREFIX", "aiimage-upscale").strip().strip("/")
S3_ACL = os.getenv("UPSCALE_S3_ACL", "").strip()
LOCAL_OUTPUT_DIR = Path(os.getenv("UPSCALE_LOCAL_OUTPUT_DIR", "/data/aiimage-upscale-service/tmp-outputs"))
LOCAL_PUBLIC_BASE_URL = os.getenv("UPSCALE_LOCAL_PUBLIC_BASE_URL", "").strip().rstrip("/")
LOCAL_TTL_SECONDS = int(os.getenv("UPSCALE_LOCAL_TTL_SECONDS", "7200"))
WD14_MODEL_DIR = Path(os.getenv("WD14_MODEL_DIR", str(MODEL_DIR / "wd14")))
WD14_TAGGER = Wd14TaggerService(WD14_MODEL_DIR)

MODEL_URLS: dict[ModelName, str] = {
    "RealESRGAN_x4plus": "https://github.com/xinntao/Real-ESRGAN/releases/download/v0.1.0/RealESRGAN_x4plus.pth",
    "RealESRNet_x4plus": "https://github.com/xinntao/Real-ESRGAN/releases/download/v0.1.1/RealESRNet_x4plus.pth",
    "RealESRGAN_x2plus": "https://github.com/xinntao/Real-ESRGAN/releases/download/v0.2.1/RealESRGAN_x2plus.pth",
    "RealESRGAN_x4plus_anime_6B": "https://github.com/xinntao/Real-ESRGAN/releases/download/v0.2.2.4/RealESRGAN_x4plus_anime_6B.pth",
    "realesr-animevideov3": "https://github.com/xinntao/Real-ESRGAN/releases/download/v0.2.5.0/realesr-animevideov3.pth",
    "realesr-general-x4v3": "https://github.com/xinntao/Real-ESRGAN/releases/download/v0.2.5.0/realesr-general-x4v3.pth",
    "realesr-general-wdn-x4v3": "https://github.com/xinntao/Real-ESRGAN/releases/download/v0.2.5.0/realesr-general-wdn-x4v3.pth",
}

MODEL_FILENAMES: dict[ModelName, str] = {
    "RealESRGAN_x4plus": "RealESRGAN_x4plus.pth",
    "RealESRNet_x4plus": "RealESRNet_x4plus.pth",
    "RealESRGAN_x2plus": "RealESRGAN_x2plus.pth",
    "RealESRGAN_x4plus_anime_6B": "RealESRGAN_x4plus_anime_6B.pth",
    "realesr-animevideov3": "realesr-animevideov3.pth",
    "realesr-general-x4v3": "realesr-general-x4v3.pth",
    "realesr-general-wdn-x4v3": "realesr-general-wdn-x4v3.pth",
}

MODEL_CACHE: OrderedDict[ModelName, ImageModelDescriptor] = OrderedDict()
MODEL_LOCK = threading.Lock()


def read_positive_int_env(name: str, fallback: int) -> int:
    """读取正整数环境变量；配置异常时回退，避免服务因单个变量写错无法启动。"""
    try:
        value = int(os.getenv(name, str(fallback)))
        return value if value > 0 else fallback
    except ValueError:
        return fallback


MODEL_CACHE_LIMIT = read_positive_int_env("UPSCALE_MODEL_CACHE_LIMIT", 1)


@APP.get("/health")
def health() -> dict[str, object]:
    """健康检查：返回设备、模型目录、可用模型、权重文件和已加载模型。"""
    return {
        "ok": True,
        "device": DEFAULT_DEVICE,
        "cuda": torch.cuda.is_available(),
        "availableModels": sorted(MODEL_FILENAMES.keys()),
        "weightFiles": list_ready_weight_models(),
        "models": sorted(MODEL_CACHE.keys()),
        "modelCacheLimit": MODEL_CACHE_LIMIT,
        "modelDir": str(MODEL_DIR),
        "responseMode": DEFAULT_RESPONSE_MODE if DEFAULT_RESPONSE_MODE in ("binary", "s3", "local") else "binary",
        "s3Configured": bool(S3_ENDPOINT_URL and S3_BUCKET and S3_PUBLIC_BASE_URL and S3_ACCESS_KEY_ID and S3_SECRET_ACCESS_KEY),
        "localConfigured": bool(LOCAL_PUBLIC_BASE_URL),
        "localOutputDir": str(LOCAL_OUTPUT_DIR),
        "wd14": WD14_TAGGER.health(),
    }


def list_ready_weight_models() -> list[str]:
    """列出已经落盘且大小可信的权重模型；避免把未加载缓存误判为缺模型。"""
    ready: list[str] = []
    for model_name, filename in MODEL_FILENAMES.items():
        path = MODEL_DIR / filename
        try:
            if path.exists() and path.stat().st_size > 1024 * 1024:
                ready.append(model_name)
        except OSError:
            LOGGER.warning("weight_probe_failed model=%s path=%s", model_name, path)
    return sorted(ready)


@APP.get("/v1/upscale-files/{day}/{filename}")
def read_upscale_file(day: str, filename: str) -> FileResponse:
    """读取 GPU 本机暂存结果；文件名是随机 UUID，仅用于短期结果分发。"""
    if not re.fullmatch(r"\d{8}", day) or not re.fullmatch(r"[a-f0-9]{32}\.(png|webp)", filename):
        raise HTTPException(status_code=404, detail="文件不存在")
    path = (LOCAL_OUTPUT_DIR / day / filename).resolve()
    root = LOCAL_OUTPUT_DIR.resolve()
    if root not in path.parents or not path.exists() or not path.is_file():
        raise HTTPException(status_code=404, detail="文件不存在")
    media_type = "image/webp" if filename.endswith(".webp") else "image/png"
    return FileResponse(path, media_type=media_type, headers={"cache-control": f"public, max-age={min(LOCAL_TTL_SECONDS, 86400)}"})


@APP.post("/v1/upscale")
async def upscale(
    file: UploadFile = File(...),
    scale: int = Form(4),
    model: str = Form("RealESRGAN_x4plus_anime_6B"),
    output_format: str = Form("png"),
    response_mode: str | None = Form(default=None),
    x_api_key: str | None = Header(default=None),
) -> Response:
    """执行图片放大；调用方必须是主站 backend，不允许浏览器直连。"""
    request_started_at = time.time()
    verify_api_key(x_api_key)
    normalized_model = normalize_model(model)
    normalized_scale = normalize_scale(scale)
    normalized_format = normalize_output_format(output_format)
    normalized_response_mode = normalize_response_mode(response_mode)

    data = await file.read()
    if not data:
        raise HTTPException(status_code=400, detail="图片为空")
    image = load_image(data)
    width, height = image.size
    if width * height > MAX_INPUT_PIXELS:
        raise HTTPException(status_code=400, detail="源图像素过大")

    LOGGER.info(
        "upscale_start width=%s height=%s scale=%s model=%s format=%s responseMode=%s inputBytes=%s",
        width,
        height,
        normalized_scale,
        normalized_model,
        normalized_format,
        normalized_response_mode,
        len(data),
    )
    wait_started_at = time.time()
    with MODEL_LOCK:
        lock_wait_ms = int((time.time() - wait_started_at) * 1000)
        started_at = time.time()
        upsampler = load_upsampler(normalized_model)
        output = run_spandrel_upscale(upsampler, image, normalized_scale)
    output_image = Image.fromarray(output)
    output_bytes, mime_type = encode_image(output_image, normalized_format)
    elapsed_ms = int((time.time() - started_at) * 1000)
    headers = {
        "x-upscale-model": normalized_model,
        "x-upscale-scale": str(normalized_scale),
        "x-upscale-elapsed-ms": str(elapsed_ms),
    }

    if normalized_response_mode == "local":
        return build_local_response(
            output_bytes,
            mime_type,
            output_image,
            normalized_format,
            normalized_model,
            normalized_scale,
            elapsed_ms,
            lock_wait_ms,
            request_started_at,
            headers,
            width,
            height,
        )
    if normalized_response_mode == "s3":
        return build_s3_response(
            output_bytes,
            mime_type,
            output_image,
            normalized_format,
            normalized_model,
            normalized_scale,
            elapsed_ms,
            lock_wait_ms,
            request_started_at,
            headers,
            width,
            height,
        )

    total_ms = int((time.time() - request_started_at) * 1000)
    LOGGER.info(
        "upscale_done width=%s height=%s outWidth=%s outHeight=%s scale=%s model=%s format=%s responseMode=binary lockWaitMs=%s gpuAndEncodeMs=%s totalMs=%s outputBytes=%s",
        width,
        height,
        output_image.width,
        output_image.height,
        normalized_scale,
        normalized_model,
        normalized_format,
        lock_wait_ms,
        elapsed_ms,
        total_ms,
        len(output_bytes),
    )
    return Response(content=output_bytes, media_type=mime_type, headers=headers)


@APP.post("/v1/tag")
async def tag_image(
    file: UploadFile = File(...),
    general_threshold: float = Form(0.35),
    character_threshold: float = Form(0.85),
    max_tags: int = Form(300),
    x_api_key: str | None = Header(default=None),
) -> JSONResponse:
    """执行 WD EVA02 Large v3 标签推理；只允许主站 backend 使用同一内部密钥调用。"""
    verify_api_key(x_api_key)
    data = await file.read()
    if not data:
        raise HTTPException(status_code=400, detail="图片为空")
    normalized_general = min(1.0, max(0.01, general_threshold))
    normalized_character = min(1.0, max(0.01, character_threshold))
    normalized_max_tags = min(500, max(1, max_tags))
    try:
        result = WD14_TAGGER.tag(data, normalized_general, normalized_character, normalized_max_tags)
        return JSONResponse(content=result)
    except Wd14TaggerError as exc:
        LOGGER.warning("wd14_failed error=%s", str(exc)[:300])
        raise HTTPException(status_code=503, detail=str(exc)[:300]) from exc


def build_local_response(
    output_bytes: bytes,
    mime_type: str,
    output_image: Image.Image,
    output_format: OutputFormat,
    model_name: ModelName,
    scale: int,
    elapsed_ms: int,
    lock_wait_ms: int,
    request_started_at: float,
    headers: dict[str, str],
    source_width: int,
    source_height: int,
) -> JSONResponse:
    """构建 GPU 本机暂存响应，避免 backend 中转大图。"""
    local_started_at = time.time()
    object_key, public_url = save_output_to_local(output_bytes, output_format)
    local_write_ms = int((time.time() - local_started_at) * 1000)
    total_ms = int((time.time() - request_started_at) * 1000)
    LOGGER.info(
        "upscale_done width=%s height=%s outWidth=%s outHeight=%s scale=%s model=%s format=%s responseMode=local lockWaitMs=%s gpuAndEncodeMs=%s localWriteMs=%s totalMs=%s outputBytes=%s key=%s",
        source_width,
        source_height,
        output_image.width,
        output_image.height,
        scale,
        model_name,
        output_format,
        lock_wait_ms,
        elapsed_ms,
        local_write_ms,
        total_ms,
        len(output_bytes),
        object_key,
    )
    headers["x-upscale-storage"] = "local"
    headers["x-upscale-local-write-ms"] = str(local_write_ms)
    return JSONResponse(
        content={
            "ok": True,
            "storage": "local",
            "url": public_url,
            "key": object_key,
            "mimeType": mime_type,
            "model": model_name,
            "scale": scale,
            "elapsedMs": elapsed_ms,
            "localWriteMs": local_write_ms,
            "sizeBytes": len(output_bytes),
            "width": output_image.width,
            "height": output_image.height,
        },
        headers=headers,
    )


def build_s3_response(
    output_bytes: bytes,
    mime_type: str,
    output_image: Image.Image,
    output_format: OutputFormat,
    model_name: ModelName,
    scale: int,
    elapsed_ms: int,
    lock_wait_ms: int,
    request_started_at: float,
    headers: dict[str, str],
    source_width: int,
    source_height: int,
) -> JSONResponse:
    """构建对象存储直链响应；凭证只留在 GPU 服务器。"""
    s3_started_at = time.time()
    object_key, public_url = upload_output_to_s3(output_bytes, mime_type, output_format)
    s3_upload_ms = int((time.time() - s3_started_at) * 1000)
    total_ms = int((time.time() - request_started_at) * 1000)
    LOGGER.info(
        "upscale_done width=%s height=%s outWidth=%s outHeight=%s scale=%s model=%s format=%s responseMode=s3 lockWaitMs=%s gpuAndEncodeMs=%s s3UploadMs=%s totalMs=%s outputBytes=%s key=%s",
        source_width,
        source_height,
        output_image.width,
        output_image.height,
        scale,
        model_name,
        output_format,
        lock_wait_ms,
        elapsed_ms,
        s3_upload_ms,
        total_ms,
        len(output_bytes),
        object_key,
    )
    headers["x-upscale-storage"] = "s3"
    headers["x-upscale-s3-upload-ms"] = str(s3_upload_ms)
    return JSONResponse(
        content={
            "ok": True,
            "storage": "s3",
            "url": public_url,
            "key": object_key,
            "mimeType": mime_type,
            "model": model_name,
            "scale": scale,
            "elapsedMs": elapsed_ms,
            "s3UploadMs": s3_upload_ms,
            "sizeBytes": len(output_bytes),
            "width": output_image.width,
            "height": output_image.height,
        },
        headers=headers,
    )


def verify_api_key(value: str | None) -> None:
    """校验内部调用密钥；未配置密钥时拒绝启动开放式调用。"""
    if not API_KEY:
        raise HTTPException(status_code=503, detail="服务未配置 UPSCALE_API_KEY")
    if value != API_KEY:
        raise HTTPException(status_code=403, detail="服务密钥无效")


def normalize_model(value: str) -> ModelName:
    """收敛模型名称，避免任意文件路径被传入加载。"""
    if value in MODEL_FILENAMES:
        return value  # type: ignore[return-value]
    return "RealESRGAN_x4plus_anime_6B"


def normalize_scale(value: int) -> int:
    """收敛放大倍率；Real-ESRGAN 支持任意 outscale，但生产只开放 2/3/4。"""
    if value in (2, 3, 4):
        return value
    return 4


def normalize_output_format(value: str) -> OutputFormat:
    """收敛输出格式，默认 PNG 保留细节。"""
    return "webp" if value.lower() == "webp" else "png"


def normalize_response_mode(value: str | None) -> ResponseMode:
    """收敛结果返回链路；非法值回退 binary。"""
    raw = (value or DEFAULT_RESPONSE_MODE or "binary").strip().lower()
    return "s3" if raw == "s3" else "local" if raw == "local" else "binary"


def load_image(data: bytes) -> Image.Image:
    """读取真实图片内容并转换为 RGB。"""
    try:
        image = Image.open(io.BytesIO(data))
        image.load()
        return image.convert("RGB")
    except Exception as exc:
        raise HTTPException(status_code=400, detail="图片无法识别") from exc


def load_upsampler(model_name: ModelName) -> ImageModelDescriptor:
    """懒加载 Real-ESRGAN/ESRGAN 模型；切换模型时按缓存上限释放显存。"""
    cached = MODEL_CACHE.get(model_name)
    if cached is not None:
        MODEL_CACHE.move_to_end(model_name)
        return cached
    MODEL_DIR.mkdir(parents=True, exist_ok=True)
    weight_path = ensure_weight(model_name)
    evict_model_cache_until(MODEL_CACHE_LIMIT - 1)
    upsampler = ModelLoader().load_from_file(weight_path)
    if not isinstance(upsampler, ImageModelDescriptor):
        raise HTTPException(status_code=503, detail=f"模型不是图片超分模型：{model_name}")
    upsampler = upsampler.eval().to(torch.device(DEFAULT_DEVICE)).float()
    MODEL_CACHE[model_name] = upsampler
    return upsampler


def evict_model_cache_until(max_size: int) -> None:
    """把模型缓存压到指定数量；释放旧模型后清理 CUDA 缓存，避免多模型切换堆高显存。"""
    target_size = max(0, max_size)
    evicted: list[str] = []
    while len(MODEL_CACHE) > target_size:
        model_name, model = MODEL_CACHE.popitem(last=False)
        evicted.append(model_name)
        del model
    if evicted and torch.cuda.is_available():
        torch.cuda.empty_cache()
    if evicted:
        LOGGER.info("model_cache_evicted models=%s cacheLimit=%s", ",".join(evicted), MODEL_CACHE_LIMIT)


def run_spandrel_upscale(model: ImageModelDescriptor, image: Image.Image, outscale: int) -> np.ndarray:
    """使用 Spandrel 执行 tile 超分；P40 上禁用 half，保证兼容性。"""
    input_array = np.asarray(image).astype(np.float32) / 255.0
    tensor = torch.from_numpy(input_array).permute(2, 0, 1).unsqueeze(0).to(torch.device(DEFAULT_DEVICE)).float()
    with torch.inference_mode():
        output = tiled_inference(model, tensor)
    model_scale = max(1, int(getattr(model, "scale", 4) or 4))
    if outscale != model_scale:
        output = torch.nn.functional.interpolate(output, scale_factor=outscale / model_scale, mode="bicubic", align_corners=False)
    output = output.clamp(0, 1).squeeze(0).permute(1, 2, 0).detach().cpu().numpy()
    return (output * 255.0).round().astype(np.uint8)


def tiled_inference(model: ImageModelDescriptor, tensor: torch.Tensor) -> torch.Tensor:
    """按 tile 分块推理，避免大图一次性占满显存。"""
    tile = int(os.getenv("UPSCALE_TILE", "400"))
    tile_pad = int(os.getenv("UPSCALE_TILE_PAD", "10"))
    _, _, height, width = tensor.shape
    if tile <= 0 or (height <= tile and width <= tile):
        return model(tensor)
    scale = max(1, int(getattr(model, "scale", 4) or 4))
    output = torch.zeros((1, 3, height * scale, width * scale), device=tensor.device, dtype=tensor.dtype)
    for y in range(0, height, tile):
        for x in range(0, width, tile):
            y0, y1 = y, min(y + tile, height)
            x0, x1 = x, min(x + tile, width)
            py0, py1 = max(y0 - tile_pad, 0), min(y1 + tile_pad, height)
            px0, px1 = max(x0 - tile_pad, 0), min(x1 + tile_pad, width)
            tile_tensor = tensor[:, :, py0:py1, px0:px1]
            tile_output = model(tile_tensor)
            oy0, oy1 = (y0 - py0) * scale, (y1 - py0) * scale
            ox0, ox1 = (x0 - px0) * scale, (x1 - px0) * scale
            output[:, :, y0 * scale:y1 * scale, x0 * scale:x1 * scale] = tile_output[:, :, oy0:oy1, ox0:ox1]
    return output


def ensure_weight(model_name: ModelName) -> Path:
    """确保模型权重存在；下载失败会返回明确错误。"""
    path = MODEL_DIR / MODEL_FILENAMES[model_name]
    if path.exists() and path.stat().st_size > 1024 * 1024:
        return path
    tmp = path.with_suffix(".download")
    try:
        with requests.get(MODEL_URLS[model_name], stream=True, timeout=60) as response:
            response.raise_for_status()
            with tmp.open("wb") as handle:
                for chunk in response.iter_content(chunk_size=1024 * 1024):
                    if chunk:
                        handle.write(chunk)
        tmp.replace(path)
        return path
    except Exception as exc:
        if tmp.exists():
            tmp.unlink()
        raise HTTPException(status_code=503, detail=f"模型权重下载失败：{model_name}") from exc


def save_output_to_local(data: bytes, output_format: OutputFormat) -> tuple[str, str]:
    """把结果图写入 GPU 本机 /data 暂存目录，并返回随机公开路径。"""
    if not LOCAL_PUBLIC_BASE_URL:
        raise HTTPException(status_code=503, detail="GPU 本机暂存公开地址未配置")
    cleanup_old_local_outputs()
    ext = "webp" if output_format == "webp" else "png"
    day = datetime.now(timezone.utc).strftime("%Y%m%d")
    filename = f"{uuid.uuid4().hex}.{ext}"
    directory = LOCAL_OUTPUT_DIR / day
    directory.mkdir(parents=True, exist_ok=True)
    path = directory / filename
    path.write_bytes(data)
    key = f"{day}/{filename}"
    return key, f"{LOCAL_PUBLIC_BASE_URL}/v1/upscale-files/{day}/{filename}"


def cleanup_old_local_outputs() -> None:
    """按 TTL 轻量清理 GPU 本机暂存结果，避免 /data 长期积累。"""
    now = time.time()
    if LOCAL_TTL_SECONDS <= 0 or not LOCAL_OUTPUT_DIR.exists():
        return
    for file_path in LOCAL_OUTPUT_DIR.glob("*/*"):
        try:
            if file_path.is_file() and now - file_path.stat().st_mtime > LOCAL_TTL_SECONDS:
                file_path.unlink()
        except OSError:
            LOGGER.warning("local_temp_cleanup_failed path=%s", file_path)
    for directory in LOCAL_OUTPUT_DIR.glob("*"):
        try:
            if directory.is_dir() and not any(directory.iterdir()):
                directory.rmdir()
        except OSError:
            pass


def upload_output_to_s3(data: bytes, mime_type: str, output_format: OutputFormat) -> tuple[str, str]:
    """上传结果图到 S3；凭证只读取 GPU 服务器私有环境变量。"""
    if not all([S3_ENDPOINT_URL, S3_BUCKET, S3_PUBLIC_BASE_URL, S3_ACCESS_KEY_ID, S3_SECRET_ACCESS_KEY]):
        raise HTTPException(status_code=503, detail="S3 返回链路未配置完整")
    ext = "webp" if output_format == "webp" else "png"
    day = datetime.now(timezone.utc).strftime("%Y%m%d")
    key = f"{S3_PREFIX}/{day}/{uuid.uuid4().hex}.{ext}" if S3_PREFIX else f"{day}/{uuid.uuid4().hex}.{ext}"
    encoded_key = quote(key, safe="/")
    endpoint = S3_ENDPOINT_URL.rstrip("/")
    url = f"{endpoint}/{S3_BUCKET}/{encoded_key}"
    amz_date = datetime.now(timezone.utc).strftime("%Y%m%dT%H%M%SZ")
    date_stamp = amz_date[:8]
    payload_hash = hashlib.sha256(data).hexdigest()
    host = endpoint.replace("https://", "").replace("http://", "").split("/", 1)[0]
    headers = {
        "cache-control": "public, max-age=86400",
        "content-type": mime_type,
        "host": host,
        "x-amz-content-sha256": payload_hash,
        "x-amz-date": amz_date,
    }
    if S3_ACL:
        headers["x-amz-acl"] = S3_ACL
    signed_headers = ";".join(sorted(headers))
    canonical_headers = "".join(f"{name}:{headers[name]}\n" for name in sorted(headers))
    canonical_request = "\n".join(["PUT", f"/{S3_BUCKET}/{encoded_key}", "", canonical_headers, signed_headers, payload_hash])
    credential_scope = f"{date_stamp}/{S3_REGION}/s3/aws4_request"
    string_to_sign = "\n".join(["AWS4-HMAC-SHA256", amz_date, credential_scope, hashlib.sha256(canonical_request.encode("utf-8")).hexdigest()])
    signature = hmac.new(get_signature_key(S3_SECRET_ACCESS_KEY, date_stamp, S3_REGION, "s3"), string_to_sign.encode("utf-8"), hashlib.sha256).hexdigest()
    headers["authorization"] = f"AWS4-HMAC-SHA256 Credential={S3_ACCESS_KEY_ID}/{credential_scope}, SignedHeaders={signed_headers}, Signature={signature}"
    response = requests.put(url, data=data, headers=headers, timeout=60)
    if response.status_code >= 400:
        LOGGER.warning("s3_upload_failed status=%s body=%s", response.status_code, response.text[:300])
        raise HTTPException(status_code=502, detail="结果上传对象存储失败")
    return key, f"{S3_PUBLIC_BASE_URL}/{encoded_key}"


def get_signature_key(secret_key: str, date_stamp: str, region_name: str, service_name: str) -> bytes:
    """生成 AWS S3 SigV4 签名密钥。"""
    key_date = hmac.new(("AWS4" + secret_key).encode("utf-8"), date_stamp.encode("utf-8"), hashlib.sha256).digest()
    key_region = hmac.new(key_date, region_name.encode("utf-8"), hashlib.sha256).digest()
    key_service = hmac.new(key_region, service_name.encode("utf-8"), hashlib.sha256).digest()
    return hmac.new(key_service, b"aws4_request", hashlib.sha256).digest()


def encode_image(image: Image.Image, output_format: OutputFormat) -> tuple[bytes, str]:
    """编码输出图片，PNG 保真，WebP 适合压缩下载体积。"""
    buffer = io.BytesIO()
    if output_format == "webp":
        image.save(buffer, format="WEBP", quality=96, method=4)
        return buffer.getvalue(), "image/webp"
    image.save(buffer, format="PNG", compress_level=4)
    return buffer.getvalue(), "image/png"
