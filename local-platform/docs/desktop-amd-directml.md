# AMD DirectML 桌面兼容链路

## 支持范围

桌面客户端使用统一 GPU 执行后端，不再把 CUDA 当作通用显卡能力：

- `nvidia_cuda`：CUDA 12.6 原生 Runtime，生成与满足显存要求时的 LoRA 训练。
- `amd_directml`：Windows DirectML 兼容 Runtime，当前只开放 Anima 推理。

双显卡设备优先选择满足驱动与显存门禁的 NVIDIA CUDA；CUDA 不可用且检测到 AMD 显卡时自动回落 DirectML。用户无需手动选择 Runtime，签名资源目录只返回当前后端的专属 Runtime 和公共模型组件。

AMD 首版能力来自 2026-08-01 的 RX 6750 GRE 12GB 实测：

- 强制 FP32 UNet、CPU VAE 与 split cross attention。
- 输出和采样最长边 512，Batch 固定 1，最多 1 个 LoRA。
- Windows LoRA Trainer 尚未通过真实前向、反向、优化器和产物重载验收，因此明确关闭。
- WMI `AdapterRAM` 与 ComfyUI DirectML 显存值可能截断或误报，只用于展示，不参与 AMD 显存硬门禁；最终可用性由 Runtime 设备自检确认。
- 混合显卡电脑由受控 Runner 读取 `torch_directml.device_name()` 并选择 AMD/Radeon 索引，再向 ComfyUI 传入实际数字索引，避免固定 0 号设备误用 Intel 核显。

## 资源清单

公共模型、文本编码器、VAE 和 CPU 组件不声明专属后端。Runtime 与 Trainer 使用：

```json
{
  "compatibleBackends": ["amd_directml"],
  "runtimeProfile": {
    "backend": "amd_directml",
    "launchProfile": "anima-directml-fp32",
    "pythonExecutable": "python_embeded/python.exe",
    "entrypoint": "directml_runner.py",
    "capabilities": {
      "inference": true,
      "training": false,
      "cpuVaeRequired": true,
      "fp32UnetRequired": true,
      "maxValidatedEdge": 512,
      "maxValidatedBatch": 1,
      "maxValidatedLoras": 1
    }
  }
}
```

服务端只声明 `launchProfile`，具体命令行由客户端白名单映射，不能通过签名清单执行任意命令。

## 构建

```powershell
pnpm run desktop:build-runtime-amd -- --output <受控构建目录> --cache <受控缓存目录>
node scripts/manage-desktop-resource-manifest.mjs add-runtime --payload <清单> --metadata <构建摘要.json> --output <新清单>
```

构建脚本固定官方 ComfyUI 归档大小和 SHA-256，移除 CUDA torch、NVIDIA、Triton 与 xFormers 包，在隔离目录安装与实测一致的 PyTorch 2.4.1、torchvision 0.19.1 和 torch-directml，并应用两处 Anima DirectML 补丁。构建后再次扫描 CUDA 专用残留；最终归档大小和 SHA-256 由真实构建计算，再进入签名与主站镜像发布流程。

## 发布门禁

AMD Runtime 发布前必须在目标 AMD 机器执行：

1. Runner 的设备枚举选中 AMD/Radeon，`/system_stats` 返回 `privateuseone` 或 DirectML 设备；ComfyUI 可能只返回 `privateuseone` 作为名称，不能把名称缺失误判为非 AMD。
2. 核心节点与 `LoraLoader` 完整。
3. 256×256、20 步、无 LoRA 的 FP32 出图通过坏图统计和人工复核。
4. 512×512、20 步有效出图。
5. 单 LoRA 256×256 对照产生可观察变化。
6. NVIDIA CUDA Runtime 可回退且现有生成、训练行为不变。

ROCm Windows、ZLUDA、AMD 多 LoRA、高于 512px 和 AMD 训练在完成独立端到端验收前不得标记为支持。
