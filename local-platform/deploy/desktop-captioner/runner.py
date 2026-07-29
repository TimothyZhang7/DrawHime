"""本文件在桌面私有 Python 中执行 WD14 ONNX 批量打标，并以逐行 JSON 返回受控结果。"""

from __future__ import annotations

import argparse
import csv
import json
import os
import sys
from pathlib import Path

COMPONENT_ROOT = Path(__file__).resolve().parent
sys.path.insert(0, str(COMPONENT_ROOT / "site-packages"))

import numpy as np
import onnxruntime as ort
from PIL import Image


KAOMOJI = {
    "0_0", "(o)_(o)", "+_+", "+_-", "._.", "<o>_<o>", "<|>_<|>", "=_=", ">_<",
    "3_3", "6_9", ">_o", "@_@", "^_^", "o_o", "u_u", "x_x", "|_|", "||_||",
}


def parse_arguments() -> argparse.Namespace:
    """读取 Rust 核心写入的请求文件路径。"""
    parser = argparse.ArgumentParser()
    parser.add_argument("--request", required=True)
    return parser.parse_args()


def load_request(path: Path) -> dict:
    """读取并最小校验一次任务请求，避免组件自行访问其他目录。"""
    with path.open("r", encoding="utf-8") as handle:
        request = json.load(handle)
    if not isinstance(request.get("items"), list) or not request["items"]:
        raise ValueError("打标请求没有图片")
    if len(request["items"]) > 200:
        raise ValueError("打标请求图片数量超过限制")
    return request


def load_tags(path: Path) -> tuple[list[str], list[int], list[int]]:
    """按 WD14 官方分类读取 general 与 character 标签索引。"""
    names: list[str] = []
    general_indexes: list[int] = []
    character_indexes: list[int] = []
    with path.open("r", encoding="utf-8", newline="") as handle:
        for index, row in enumerate(csv.DictReader(handle)):
            name = row["name"]
            names.append(name if name in KAOMOJI else name.replace("_", " "))
            category = int(row["category"])
            if category == 0:
                general_indexes.append(index)
            elif category == 4:
                character_indexes.append(index)
    if not names or not general_indexes:
        raise ValueError("WD14 标签文件结构不正确")
    return names, general_indexes, character_indexes


def prepare_image(path: Path, target_size: int) -> np.ndarray:
    """按官方示例把透明图合成白底、居中补方、双三次缩放并转换为 BGR。"""
    with Image.open(path) as source:
        image = source.convert("RGBA")
        canvas = Image.new("RGBA", image.size, (255, 255, 255, 255))
        canvas.alpha_composite(image)
        rgb = canvas.convert("RGB")
    maximum = max(rgb.size)
    padded = Image.new("RGB", (maximum, maximum), (255, 255, 255))
    padded.paste(rgb, ((maximum - rgb.width) // 2, (maximum - rgb.height) // 2))
    if maximum != target_size:
        padded = padded.resize((target_size, target_size), Image.Resampling.BICUBIC)
    array = np.asarray(padded, dtype=np.float32)[:, :, ::-1]
    return np.expand_dims(np.ascontiguousarray(array), axis=0)


def selected_tags(probabilities: np.ndarray, names: list[str], indexes: list[int], threshold: float) -> list[str]:
    """按置信度降序输出超过阈值的唯一标签。"""
    values = [(names[index], float(probabilities[index])) for index in indexes if probabilities[index] > threshold]
    values.sort(key=lambda item: item[1], reverse=True)
    return [name for name, _ in values]


def emit(payload: dict) -> None:
    """每张图片完成后立即刷新一行，供 Rust 持久化进度。"""
    sys.stdout.write(json.dumps(payload, ensure_ascii=False, separators=(",", ":")) + "\n")
    sys.stdout.flush()


def main() -> None:
    """加载模型一次并串行处理整批图片，避免每张图重复初始化 ONNX。"""
    request = load_request(Path(parse_arguments().request))
    names, general_indexes, character_indexes = load_tags(COMPONENT_ROOT / "selected_tags.csv")
    options = ort.SessionOptions()
    options.intra_op_num_threads = min(max(os.cpu_count() or 1, 1), 8)
    options.inter_op_num_threads = 1
    options.graph_optimization_level = ort.GraphOptimizationLevel.ORT_ENABLE_ALL
    session = ort.InferenceSession(str(COMPONENT_ROOT / "model.onnx"), sess_options=options, providers=["CPUExecutionProvider"])
    input_meta = session.get_inputs()[0]
    output_name = session.get_outputs()[0].name
    target_size = int(input_meta.shape[1])
    general_threshold = float(request["generalThreshold"])
    character_threshold = float(request["characterThreshold"])
    include_character_tags = bool(request["includeCharacterTags"])
    for item in request["items"]:
        asset_id = str(item.get("assetId", ""))
        try:
            image = prepare_image(Path(str(item["path"])), target_size)
            probabilities = session.run([output_name], {input_meta.name: image})[0][0].astype(float)
            tags = selected_tags(probabilities, names, general_indexes, general_threshold)
            if include_character_tags:
                tags.extend(selected_tags(probabilities, names, character_indexes, character_threshold))
            emit({"assetId": asset_id, "tags": list(dict.fromkeys(tags)), "error": None})
        except Exception as error:
            emit({"assetId": asset_id, "tags": None, "error": f"图片解码或推理失败：{type(error).__name__}"})


if __name__ == "__main__":
    main()
