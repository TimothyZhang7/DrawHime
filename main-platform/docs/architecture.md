# 架构说明

当前生产使用多程序拆分，避免把用户 API、长耗时绘图、Bot 连接、图片渲染和后台任务压在单个进程中。工作流和本地模型推理已下线，不再作为生产调用链路的一部分。

## 调用方向

```text
web-frontend ─┐
admin-portal ─┼─> backend ─┬─> drawing-service ─> drawing-worker ─> 上游绘图 API
bot-service  ─┘            ├─> media-service
                            ├─> notification-worker
                            └─> wsproxy-service

wsproxy-service ─> bot-service ─> bot-renderer
ops-worker ─> backend / drawing-service / media-service
```

浏览器只访问 `backend` 和静态前端。内部服务使用 HTTP 或 WebSocket 通信，不共享内部状态。

## 数据写入边界

| 数据 | 写入方 |
|---|---|
| 用户、角色、JWT、邮箱验证 | backend |
| QQ 绑定、QQ 余额、每日用量 | backend |
| 充值卡、充值批次、兑换记录 | backend |
| 任务主状态、子任务轨迹 | backend 接收内部服务回写 |
| 图片原图、缩略图、参考图 | media-service |
| OneBot 连接态 | wsproxy-service 进程态，backend 保存业务归属 |
| 通知发送 | notification-worker |
| 清理、修复、统计 | ops-worker |

## 绘图链路

1. 用户或 Bot 提交生成请求。
2. `backend` 完成鉴权、QQ 绑定、余额或免费额度检查，创建主任务。
3. `backend` 调用 `drawing-service`。
4. `drawing-service` 写入调度子任务并投递 `drawing-worker`。
5. `drawing-worker` 选择站点、调用图片端点或 Grok 视频提交/轮询端点、执行重试。
6. 成功后图片交给 `media-service` 保存并生成缩略图；MP4 视频原样保存且支持 HTTP Range 播放，不经过 Sharp。
7. `drawing-worker` 通过 backend 内部接口回写图片或视频结果和最终状态；公开成功媒体统一进入图库，按 `mediaType` 使用图片或视频组件展示。

## 故障边界

- `drawing-worker` 不可用时，任务可由轮询恢复。
- 上游绘图失败时，错误需要清洗后再暴露。
- `media-service` 只使用本地媒体目录；参考图和上传大图按 3MB 任务输入版压缩，最终生成原图独立保存且不压缩。
- `bot-renderer` 失败时，Bot 应降级为文本。
- `notification-worker` 失败不影响主业务结果。

## 共享包边界

- `packages/shared-contracts` 只放 DTO、枚举、接口契约。
- `packages/core-utils` 只放纯工具、HTTP 基础设施、队列基础类型。
- 业务规则留在拥有职责的 app 内。
