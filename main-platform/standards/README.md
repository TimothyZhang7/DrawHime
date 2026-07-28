# 准入规范

## 接口类型先行

新增或修改跨程序接口时，顺序必须是：

1. 更新 [interfaces/README.md](interfaces/README.md)。
2. 更新 `packages/shared-contracts`。
3. 更新调用方和实现方。
4. 运行受影响的类型检查或构建。

## 共享包边界

- `shared-contracts`：DTO、响应类型、事件类型、枚举。
- `core-utils`：纯工具、HTTP 基础设施、队列基础类型。
- 业务逻辑必须留在 app 内。

## 响应格式

成功：

```json
{ "ok": true, "data": {} }
```

失败：

```json
{ "ok": false, "code": "bad_request", "message": "请求不合法" }
```

## 安全

- 用户接口使用 JWT。
- 管理接口使用 admin JWT。
- 服务间写接口使用 `x-service-token`。
- 敏感字段必须脱敏或不返回。
