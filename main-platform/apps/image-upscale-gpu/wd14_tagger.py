"""WD14 图片标签 Provider：负责模型下载、ONNX Session 复用、官方预处理和带置信度标签输出。"""
from __future__ import annotations

import csv
import importlib
import io
import logging
import os
import threading
import time
from pathlib import Path
from typing import Any

import numpy as np
import requests
from PIL import Image

LOGGER = logging.getLogger("aiimage-wd14")
MODEL_NAME = "wd-eva02-large-tagger-v3"
MODEL_FILENAME = "model.onnx"
TAGS_FILENAME = "selected_tags.csv"
MODEL_MIN_BYTES = 500 * 1024 * 1024
TAGS_MIN_BYTES = 1024
ASSET_URLS = {
    MODEL_FILENAME: [
        f"https://hf-mirror.com/SmilingWolf/{MODEL_NAME}/resolve/main/{MODEL_FILENAME}",
        f"https://huggingface.co/SmilingWolf/{MODEL_NAME}/resolve/main/{MODEL_FILENAME}",
    ],
    TAGS_FILENAME: [
        f"https://hf-mirror.com/SmilingWolf/{MODEL_NAME}/resolve/main/{TAGS_FILENAME}",
        f"https://huggingface.co/SmilingWolf/{MODEL_NAME}/resolve/main/{TAGS_FILENAME}",
    ],
}
CATEGORY_NAMES = {0: "general", 4: "character", 9: "rating"}


class Wd14TaggerError(RuntimeError):
    """WD14 Provider 可读业务错误。"""


class Wd14TaggerService:
    """长驻复用 WD EVA02 Large v3 ONNX Session 的真实推理服务。"""

    def __init__(self, model_dir: Path) -> None:
        self.model_dir = model_dir
        self.model_path = model_dir / MODEL_FILENAME
        self.tags_path = model_dir / TAGS_FILENAME
        self._session: Any | None = None
        self._input_name = ""
        self._input_size = 448
        self._labels: list[tuple[str, int]] = []
        self._providers: list[str] = []
        self._load_lock = threading.Lock()
        self._inference_lock = threading.Lock()

    def health(self) -> dict[str, object]:
        """返回模型文件、运行时和已加载 Provider 状态，不触发大模型下载。"""
        runtime_version = ""
        runtime_providers: list[str] = []
        runtime_error = ""
        try:
            runtime = importlib.import_module("onnxruntime")
            runtime_version = str(runtime.__version__)
            runtime_providers = list(runtime.get_available_providers())
        except Exception as exc:  # noqa: BLE001
            runtime_error = str(exc)[:240]
        return {
            "model": MODEL_NAME,
            "modelReady": self._is_asset_ready(self.model_path, MODEL_MIN_BYTES),
            "tagsReady": self._is_asset_ready(self.tags_path, TAGS_MIN_BYTES),
            "loaded": self._session is not None,
            "activeProviders": list(self._providers),
            "availableProviders": runtime_providers,
            "runtimeVersion": runtime_version,
            "runtimeError": runtime_error,
            "modelDir": str(self.model_dir),
        }

    def prepare_assets(self) -> None:
        """提前下载并原子落盘模型与标签表，避免首个业务请求承担下载时间。"""
        self.model_dir.mkdir(parents=True, exist_ok=True)
        self._ensure_asset(self.model_path, MODEL_MIN_BYTES)
        self._ensure_asset(self.tags_path, TAGS_MIN_BYTES)

    def tag(self, data: bytes, general_threshold: float, character_threshold: float, max_tags: int) -> dict[str, object]:
        """执行 WD14 推理，返回 general/character 标签及模型原生置信度。"""
        started_at = time.time()
        image = self._load_image(data)
        self._ensure_session()
        input_tensor = self._prepare_input(image)
        with self._inference_lock:
            probabilities = self._session.run(None, {self._input_name: input_tensor})[0][0]
        if len(probabilities) != len(self._labels):
            raise Wd14TaggerError("WD14 输出维度与标签表不一致")

        general: list[dict[str, object]] = []
        character: list[dict[str, object]] = []
        for (name, category), probability in zip(self._labels, probabilities, strict=True):
            confidence = float(probability)
            if category == 0 and confidence >= general_threshold:
                general.append(self._tag_view(name, "general", confidence))
            elif category == 4 and confidence >= character_threshold:
                character.append(self._tag_view(name, "character", confidence))
        general.sort(key=lambda item: float(item["confidence"]), reverse=True)
        character.sort(key=lambda item: float(item["confidence"]), reverse=True)
        general = general[:max_tags]
        character = character[: min(max_tags, 100)]
        elapsed_ms = int((time.time() - started_at) * 1000)
        LOGGER.info(
            "wd14_done width=%s height=%s general=%s character=%s elapsedMs=%s providers=%s",
            image.width,
            image.height,
            len(general),
            len(character),
            elapsed_ms,
            ",".join(self._providers),
        )
        return {
            "ok": True,
            "model": MODEL_NAME,
            "generalThreshold": general_threshold,
            "characterThreshold": character_threshold,
            "generalTags": general,
            "characterTags": character,
            "tags": [*character, *general],
            "elapsedMs": elapsed_ms,
            "providers": list(self._providers),
        }

    def _ensure_session(self) -> None:
        if self._session is not None:
            return
        with self._load_lock:
            if self._session is not None:
                return
            self.prepare_assets()
            try:
                runtime = importlib.import_module("onnxruntime")
            except Exception as exc:  # noqa: BLE001
                raise Wd14TaggerError(f"onnxruntime 未安装：{str(exc)[:160]}") from exc
            available = list(runtime.get_available_providers())
            providers = [name for name in ("CUDAExecutionProvider", "CPUExecutionProvider") if name in available]
            if not providers:
                raise Wd14TaggerError("onnxruntime 没有可用 Execution Provider")
            options = runtime.SessionOptions()
            options.graph_optimization_level = runtime.GraphOptimizationLevel.ORT_ENABLE_ALL
            session = runtime.InferenceSession(str(self.model_path), sess_options=options, providers=providers)
            input_meta = session.get_inputs()[0]
            shape = list(input_meta.shape)
            size = next((int(value) for value in shape[1:3] if isinstance(value, int) and value > 0), 448)
            labels = self._read_labels()
            self._session = session
            self._input_name = input_meta.name
            self._input_size = size
            self._labels = labels
            self._providers = list(session.get_providers())
            LOGGER.info("wd14_loaded model=%s input=%s size=%s providers=%s labels=%s", MODEL_NAME, self._input_name, size, ",".join(self._providers), len(labels))

    def _prepare_input(self, image: Image.Image) -> np.ndarray:
        """复现 ComfyUI-WD14-Tagger：白底方形补边、缩放、RGB 转 BGR、NHWC float32。"""
        size = self._input_size
        square = Image.new("RGB", (max(image.width, image.height), max(image.width, image.height)), "white")
        square.paste(image, ((square.width - image.width) // 2, (square.height - image.height) // 2))
        resized = square.resize((size, size), Image.Resampling.LANCZOS)
        rgb = np.asarray(resized, dtype=np.float32)
        bgr = rgb[:, :, ::-1]
        return np.expand_dims(bgr, axis=0)

    def _read_labels(self) -> list[tuple[str, int]]:
        labels: list[tuple[str, int]] = []
        with self.tags_path.open("r", encoding="utf-8", newline="") as file:
            for row in csv.DictReader(file):
                name = str(row.get("name", "")).strip()
                try:
                    category = int(str(row.get("category", "-1")))
                except ValueError:
                    category = -1
                if name:
                    labels.append((name, category))
        if not labels:
            raise Wd14TaggerError("WD14 标签表为空")
        return labels

    def _ensure_asset(self, path: Path, min_bytes: int) -> None:
        if self._is_asset_ready(path, min_bytes):
            return
        errors: list[str] = []
        temporary = path.with_suffix(path.suffix + ".part")
        temporary.unlink(missing_ok=True)
        for url in ASSET_URLS[path.name]:
            try:
                LOGGER.info("wd14_download_start file=%s url=%s", path.name, url)
                with requests.get(url, stream=True, timeout=(15, 900), allow_redirects=True) as response:
                    response.raise_for_status()
                    with temporary.open("wb") as file:
                        for chunk in response.iter_content(chunk_size=8 * 1024 * 1024):
                            if chunk:
                                file.write(chunk)
                if not self._is_asset_ready(temporary, min_bytes):
                    raise Wd14TaggerError(f"下载文件大小异常：{temporary.stat().st_size}")
                temporary.replace(path)
                LOGGER.info("wd14_download_done file=%s bytes=%s", path.name, path.stat().st_size)
                return
            except Exception as exc:  # noqa: BLE001
                temporary.unlink(missing_ok=True)
                errors.append(str(exc)[:180])
        raise Wd14TaggerError(f"WD14 资源下载失败：{'；'.join(errors)}")

    @staticmethod
    def _is_asset_ready(path: Path, min_bytes: int) -> bool:
        try:
            return path.is_file() and path.stat().st_size >= min_bytes
        except OSError:
            return False

    @staticmethod
    def _load_image(data: bytes) -> Image.Image:
        try:
            source = Image.open(io.BytesIO(data))
            source.load()
            if source.mode == "RGBA":
                background = Image.new("RGBA", source.size, "white")
                source = Image.alpha_composite(background, source)
            return source.convert("RGB")
        except Exception as exc:  # noqa: BLE001
            raise Wd14TaggerError("图片文件无法识别") from exc

    @staticmethod
    def _tag_view(name: str, category: str, confidence: float) -> dict[str, object]:
        return {"name": name, "category": category, "confidence": round(confidence, 6)}
