"""本文件使用固定 U2Net ONNX 模型离线生成透明 PNG，不覆盖训练集原图。"""

from __future__ import annotations

import argparse
import json
import os
import sys
from pathlib import Path

COMPONENT_ROOT = Path(__file__).resolve().parent
sys.path.insert(0, str(COMPONENT_ROOT / "site-packages"))

import numpy as np
from PIL import Image


def parse_arguments() -> argparse.Namespace:
    """读取 Rust 核心生成的受控请求文件。"""
    parser = argparse.ArgumentParser()
    parser.add_argument("--request", required=True)
    return parser.parse_args()


def load_request(path: Path) -> dict:
    """限制单批数量并拒绝结构不完整的请求。"""
    with path.open("r", encoding="utf-8") as handle:
        request = json.load(handle)
    items = request.get("items")
    if not isinstance(items, list) or not items or len(items) > 200:
        raise ValueError("抠图请求图片数量必须是 1–200 张")
    return request


def prepare_image(image: Image.Image) -> np.ndarray:
    """按 rembg U2Net 官方归一化方式生成 NCHW 输入。"""
    resized = image.convert("RGB").resize((320, 320), Image.Resampling.LANCZOS)
    array = np.asarray(resized, dtype=np.float32) / 255.0
    array = (array - np.asarray((0.485, 0.456, 0.406), dtype=np.float32)) / np.asarray((0.229, 0.224, 0.225), dtype=np.float32)
    return np.expand_dims(np.transpose(array, (2, 0, 1)), axis=0)


def create_mask(prediction: np.ndarray, size: tuple[int, int]) -> Image.Image:
    """把模型输出稳定归一化为原图尺寸 alpha 蒙版。"""
    values = np.squeeze(prediction).astype(np.float32)
    minimum = float(np.min(values))
    maximum = float(np.max(values))
    if not np.isfinite(minimum) or not np.isfinite(maximum) or maximum - minimum < 1e-7:
        raise ValueError("分割模型返回了无效蒙版")
    normalized = np.clip((values - minimum) / (maximum - minimum), 0.0, 1.0)
    mask = Image.fromarray((normalized * 255.0).astype(np.uint8), mode="L")
    return mask.resize(size, Image.Resampling.LANCZOS)


def emit(payload: dict) -> None:
    """逐图刷新 JSON 行，便于客户端持久化部分成功结果。"""
    sys.stdout.write(json.dumps(payload, ensure_ascii=False, separators=(",", ":")) + "\n")
    sys.stdout.flush()


def create_session():
    """仅在真实执行时加载组件私有 ONNX Runtime，便于离线测试纯图像预处理。"""
    import onnxruntime as ort

    options = ort.SessionOptions()
    options.intra_op_num_threads = min(max(os.cpu_count() or 1, 1), 8)
    options.inter_op_num_threads = 1
    options.graph_optimization_level = ort.GraphOptimizationLevel.ORT_ENABLE_ALL
    return ort.InferenceSession(
        str(COMPONENT_ROOT / "u2net.onnx"),
        sess_options=options,
        providers=["CPUExecutionProvider"],
    )


def main() -> None:
    """模型只加载一次，逐图输出到 Rust 指定的训练集派生目录。"""
    request = load_request(Path(parse_arguments().request))
    session = create_session()
    input_name = session.get_inputs()[0].name
    output_name = session.get_outputs()[0].name
    for item in request["items"]:
        asset_id = str(item.get("assetId", ""))
        try:
            source_path = Path(str(item["sourcePath"]))
            output_path = Path(str(item["outputPath"]))
            with Image.open(source_path) as source:
                original = source.convert("RGBA")
            prediction = session.run([output_name], {input_name: prepare_image(original)})[0]
            original.putalpha(create_mask(prediction, original.size))
            output_path.parent.mkdir(parents=True, exist_ok=True)
            original.save(output_path, format="PNG", optimize=True)
            emit({"assetId": asset_id, "outputPath": str(output_path), "error": None})
        except Exception as error:
            emit({"assetId": asset_id, "outputPath": None, "error": f"抠图解码或推理失败：{type(error).__name__}"})


if __name__ == "__main__":
    main()
