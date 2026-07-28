# ComfyUI LoRA 同步节点

该自定义节点为 drawing-worker 提供受保护的 LoRA 内容哈希查询和流式同步接口。部署时将目录复制到 ComfyUI `custom_nodes/aiimage_lora_sync`，并在 ComfyUI 服务环境设置 `AIIMAGE_LORA_SYNC_TOKEN`；该值必须与生产 drawing-worker 使用的 `WS_PROXY_TOKEN` 一致。

接口只接受 `aiimage_lora_<sha256>.safetensors` 安全文件名。上传完成后会校验声明大小、SHA-256 与 safetensors 文件头，原子落盘并清理 ComfyUI LoRA 列表缓存。
