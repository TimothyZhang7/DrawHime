# shared-contracts

跨程序共享契约包。只能放 DTO、事件类型、响应类型和枚举。

## 当前内容

- `auth`
- `common`
- `drawing`
- `qq`
- `wsproxy`

## 命令

```bash
pnpm --prefix packages/shared-contracts run type-check
pnpm --prefix packages/shared-contracts run build
```

## 维护要求

新增契约前先更新 `standards/interfaces/README.md`。业务逻辑不得放入本包。
