# core-utils

通用工具包。提供 HTTP 基础设施、健康检查、JSON 响应、路由器、环境变量读取和 Worker 基础类型。

## 当前内容

- `config`
- `http`
- `queue`
- `isNonEmptyString`

## 命令

```bash
pnpm --prefix packages/core-utils run type-check
pnpm --prefix packages/core-utils run build
```

## 维护要求

本包只能放无业务副作用的纯工具。涉及用户、余额、绘图、Bot 的规则必须留在 app 内。
