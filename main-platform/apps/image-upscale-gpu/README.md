# 图片放大 GPU 服务

本目录是部署到私有 GPU 主机的独立图片推理服务源码。服务不保存用户图片，只接收 backend 的内部请求，使用 `x-api-key` 鉴权后提供图片放大和 WD14 标签证据。

## 模型选择

2026-07-01 联网检索后，当前生产优先采用：

- `RealESRGAN_x4plus`：通用照片和插画超分，部署稳定、速度快、P40 可用；未下载权重时会按官方 GitHub Release 尝试下载。
- `RealESRNet_x4plus`：通用图片保守超分，锐化和纹理重绘更弱，适合不想改变原图质感的图片。
- `RealESRGAN_x2plus`：通用 2x 模型，源图较大或只需要轻度放大时使用。
- `RealESRGAN_x4plus_anime_6B`：当前默认模型，动漫/插画更轻，细节锐化更积极。
- `realesr-animevideov3`：轻量动漫视频/插画模型，线上已存在权重，可作为更快的动漫图备选模型。
- `realesr-general-x4v3`：轻量通用 4x 模型，速度快，适合普通图片快速放大。
- `realesr-general-wdn-x4v3`：轻量通用 4x 降噪模型，适合噪点或压缩痕迹明显的图片。

OSEDiff、SUPIR、SeeSR 等扩散式方案质量潜力更高，但对显存、CUDA、权重和推理耗时要求明显更高。当前 P40 服务器先以 Real-ESRGAN 提供可用链路，服务配置保留 `model` 字段，后续可增加扩散式后端。

## 接口

- `GET /health`
- `POST /v1/upscale`
- `POST /v1/tag`

`POST /v1/tag` 使用 multipart：

- `file`：图片文件；
- `general_threshold`：WD14 general 标签阈值；
- `character_threshold`：WD14 character 标签阈值；
- `max_tags`：general 标签上限。

服务使用 `wd-eva02-large-tagger-v3`，按模型要求执行白底方形补边、RGB 转 BGR 和 ONNX Runtime CUDA/CPU Provider 回退。响应返回 general/character 标签、模型原生置信度、阈值、耗时和实际 Execution Provider。

`POST /v1/upscale` 使用 multipart：

- `file`：图片文件
- `scale`：`2`、`3` 或 `4`
- `model`：`RealESRGAN_x4plus`、`RealESRNet_x4plus`、`RealESRGAN_x2plus`、`RealESRGAN_x4plus_anime_6B`、`realesr-animevideov3`、`realesr-general-x4v3` 或 `realesr-general-wdn-x4v3`
- `output_format`：`png` 或 `webp`
- `response_mode`：可选，`binary`、`s3` 或 `local`；生产默认使用 `local`，由 backend 返回 GPU 暂存 URL 供用户快速访问。

响应为图片二进制，`x-upscale-model` 头返回实际模型。
