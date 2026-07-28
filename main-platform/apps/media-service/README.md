# media-service

媒体服务。负责本地文件保存、图片读取、缩略图生成和媒体相关接口。

## 端口

`MEDIA_PORT=3013`

## 入口

- `src/main.ts`
- `src/app/media-service-app.ts`

## 模块

- `file-store`
- `thumbnail`
- `media-api`

## 命令

```bash
pnpm --prefix apps/media-service run dev
pnpm --prefix apps/media-service run type-check
pnpm --prefix apps/media-service run build
```

## 注意

生产凭证通过环境变量注入，文档中只使用占位符。
