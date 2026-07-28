# bot-renderer

Bot 图片卡片渲染服务。负责把 HTML 模板渲染为 PNG。

## 端口

`BOT_RENDERER_PORT=3014`

## 入口

- `src/main.ts`
- `src/app/bot-renderer-app.ts`

## 模块

- `render-api`
- `screenshot`
- `templates`

## 命令

```bash
pnpm --prefix apps/bot-renderer run dev
pnpm --prefix apps/bot-renderer run type-check
pnpm --prefix apps/bot-renderer run build
pnpm run assets:bot-renderer
```

## 本地资源

- `BOT_RENDERER_ASSET_DIR`：字体等卡片静态资源目录，默认 `local/bot-renderer-assets`。
- `BOT_RENDERER_FONT_FILE`：本地中文字体文件名，默认 `NotoSansSC-Regular.otf`。
- `BOT_RENDERER_LOCAL_IMAGE_DIRS`：允许 renderer 读取的本地图片暂存目录，生产应指向 media-service 的 `MEDIA_STORAGE_PATH`。
- renderer 截图时只读取这些本地目录；未命中的 HTTP/远端归档/头像资源会被丢弃，避免 Bot 回复被外部网络拖慢。

## 降级

Puppeteer 不可用时，调用方应降级为文本回复。
