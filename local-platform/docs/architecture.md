# 架构与职责

## 调用方向

```text
web/admin -> api -> 独立数据库 / Redis / 对象存储
api -> 主站 SSO、钱包 Integration API、图库发布 Integration API
scheduler -> inference-worker / training-worker -> gpu-agent -> 私有 Runtime
desktop -> api -> 主站 /data 资源存储
artifact-service -> 独立对象存储
```

## 权威数据

| 数据 | 权威系统 |
|---|---|
| 登录、密码、邮箱、角色、封禁 | 主站 |
| 身份钱包、余额、流水、扣费分账 | 主站 |
| 本地模型任务、尝试、阶段、Runtime ID | 本项目 |
| 模型、工作流、LoRA、训练数据和训练版本 | 本项目 |
| 任务临时产物和训练产物 | 本项目对象存储 |
| 正式图库媒体、隐私、标签、点赞和浏览 | 主站 |

两个项目不共享数据库。所有跨项目写入使用版本化接口、服务身份、幂等键和 outbox/inbox。

## 当前生产边界

推理与训练均已进入真实生产闭环。推理任务使用模型级图片价格；训练任务使用模型级计价单位价格，并按图片数量、重复、Epoch、分辨率和 Rank 动态计算 1–32 个单位。两类任务都先在主站事务预留身份钱包，产物成功保存后提交，失败或取消按固化分账释放。训练数据、自动打标确认、Runtime 日志和可用 LoRA 产物保存在独立平台；正式图库和钱包仍由主站权威管理。

训练 Runtime 固定使用官方 `sd-scripts` 修订，通过仅允许平台生产主机访问的受令牌保护端口工作。Runtime 不读取独立平台数据库，数据集通过逐图 HTTPS 下载与 SHA-256 校验进入 GPU 临时目录，输出再次校验后写入独立 MinIO。Runtime 内部以尝试 ID 幂等并使用单训练槽位串行排队；短响应被截断时 Worker 保持原尝试、资金预留与租约持续重连，不会创建第二个训练进程。生产环境使用物理双卡：ComfyUI 固定 GPU 0，训练 Runtime 固定 GPU 1；调度器设置 `GPU_WORKLOADS_SHARE_DEVICE=false`，并以 `INFERENCE_GPU_DEVICE_KEY=cuda:0`、`TRAINING_GPU_DEVICE_KEY=cuda:1` 固定各自租约，因此训练不会阻塞新推理任务。

## 桌面端边界

`apps/desktop` 是独立离线客户端。桌面核心通过 Tauri 命令连接 WebView，使用本机 SQLite、文件目录和用户自己的 GPU，不连接独立平台数据库、Redis 或对象存储。本地计算不进入主站钱包计费；联网身份使用浏览器设备码确认，随机会话只写 Windows Credential Manager。初始化依赖使用签名资源接口，底模与 LoRA 仓库使用在线目录和版本化权限接口，最近一次成功目录供离线浏览。生成结果必须先在本地完成格式与 SHA-256 校验，再进入独立的网页图库同步队列，任务成功状态不依赖网络上传结果。

桌面端的 Runtime、底模与 LoRA 只从主站 `/data` 对应的受控 HTTPS Range 端点下载。主站缺少文件时明确失败，不代理模型来源站点，也不访问共享 GPU Runtime；桌面客户端始终复核总大小和完整 SHA-256。底模与 LoRA 列表只由在线 API 下发，最近一次成功目录会原子缓存供离线浏览，客户端不维护第二份仓库清单。

## 公网路径边界

用户端和管理端采用两个独立静态目录与两个独立 URL 后缀；二者不嵌入主站 React 路由。本地模型用户端从主站导航在当前窗口整页加载，管理端从管理后台进入。浏览器仅访问 `/local-model-api/`，调度器、Worker、GPU Agent、ComfyUI、Redis、数据库与对象存储均不暴露公网。
