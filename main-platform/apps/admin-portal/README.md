# admin-portal

管理后台。提供仪表盘、用户、余额、站点、生成任务、图片、模板、充值、Bot 和命令配置管理。

## 端口

开发端口 `5174`。

## 入口

- `src/main.tsx`
- `src/app/App.tsx`

## 命令

```bash
pnpm --prefix apps/admin-portal run dev
pnpm --prefix apps/admin-portal run type-check
pnpm --prefix apps/admin-portal run build
```

## 注意

`src/main.tsx` 必须导入 `./styles/index.css`。所有敏感操作必须走 admin JWT。
