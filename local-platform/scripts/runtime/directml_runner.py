"""本文件从隔离依赖目录加载 DirectML PyTorch，并以固定入口启动 ComfyUI。"""

from pathlib import Path
import runpy
import sys


RUNTIME_ROOT = Path(__file__).resolve().parent
DEPENDENCY_ROOT = RUNTIME_ROOT / "directml-site"
COMFY_MAIN = RUNTIME_ROOT / "ComfyUI" / "main.py"

if not DEPENDENCY_ROOT.is_dir():
    raise SystemExit(f"DirectML dependency directory is missing: {DEPENDENCY_ROOT}")
if not COMFY_MAIN.is_file():
    raise SystemExit(f"ComfyUI entrypoint is missing: {COMFY_MAIN}")

# 隔离目录必须排在便携 Python 自带包之前，避免误加载 CUDA 版 torch。
sys.path.insert(0, str(DEPENDENCY_ROOT))


def select_amd_directml_device() -> int:
    """从 DirectML 的真实设备列表选择 AMD，避免双显卡电脑误用 Intel 核显。"""
    import torch_directml

    devices = []
    for index in range(16):
        try:
            name = str(torch_directml.device_name(index)).replace("\x00", "").strip()
        except (IndexError, RuntimeError, ValueError):
            break
        devices.append((index, name))
        if "amd" in name.lower() or "radeon" in name.lower():
            return index
    visible = ", ".join(f"{index}:{name or 'unknown'}" for index, name in devices) or "none"
    raise SystemExit(f"No AMD DirectML device found; visible devices: {visible}")


# 清单参数仍固定为报告验证过的 --directml 0；Runner 只在混合显卡下替换为真实 AMD 索引。
if "--directml" in sys.argv:
    directml_argument = sys.argv.index("--directml") + 1
    if directml_argument >= len(sys.argv):
        raise SystemExit("DirectML device index is missing")
    sys.argv[directml_argument] = str(select_amd_directml_device())
sys.argv = [str(COMFY_MAIN), *sys.argv[1:]]
runpy.run_path(str(COMFY_MAIN), run_name="__main__")
