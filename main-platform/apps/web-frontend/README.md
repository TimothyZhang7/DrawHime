# web-frontend

用户前台。提供登录、绘图、图库、模板、充值、个人中心和 Bot 管理；工作流入口跳转到独立 `workflow-studio`。

## 端口

开发端口 `5173`。

## 入口

- `src/main.tsx`
- `src/app/App.tsx`

## 命令

```bash
pnpm --prefix apps/web-frontend run dev
pnpm --prefix apps/web-frontend run type-check
pnpm --prefix apps/web-frontend run build
```

## 注意

`src/main.tsx` 必须导入 `./styles/index.css`。
