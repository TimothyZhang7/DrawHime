# ComfyUI LoRA 同步节点

该自定义节点为 drawing-worker 提供受保护的 LoRA 内容哈希查询和流式同步接口。部署时将目录复制到 ComfyUI `custom_nodes/aiimage_lora_sync`，并在 ComfyUI 服务环境设置 `AIIMAGE_LORA_SYNC_TOKEN`；该值必须与生产 drawing-worker 使用的 `WS_PROXY_TOKEN` 一致。

接口只接受 `aiimage_lora_<sha256>.safetensors` 安全文件名。上传完成后会校验声明大小、SHA-256 与 safetensors 文件头，原子落盘并清理 ComfyUI LoRA 列表缓存。

`GET/PUT /aiimage/loras/<file_name>` 保留完整文件查询与上传兼容能力。独立本地模型平台使用 `GET/PUT/POST/DELETE /aiimage/loras/<file_name>/upload`：查询已接收偏移、按偏移追加分片、完成原子安装或取消临时文件。分片上传中断后继续使用同一个内容哈希临时文件，不会重新传输已经确认的字节。
