# 运维检查

## 标准快速执行链路

该链路是主站代码或配置变更的唯一默认顺序，目标是只做一次必要检查、一次目标化部署和一次部署后提交：

1. **发现**：确认 `pwd`、`git status --short`、适用 `AGENTS.md`，用 `rg --files` 找到文档和源码。
2. **实现**：读完入口、调用方、共享契约和最终写入方后修改；先执行 `git diff --check`。
3. **最小验证**：只运行受影响程序的类型检查、测试或构建。共享包或跨服务契约变化才扩大检查范围。
4. **部署预检**：优先执行 `node scripts/quick-deploy.mjs --changed --dry-run`，由 Git 已跟踪改动推导最小端点；需要人工覆盖时才使用 `--target <target>`。
5. **部署**：执行 `node scripts/quick-deploy.mjs --changed`。仅构建、发布、重启受影响端点；部署工具或文档变化使用 `source` 目标，不触发运行端点。
6. **生产验收**：服务验证 `/health`，backend 额外验证 `/health/db`；前端验证公网 `200` 和本次改动对应功能。
7. **提交**：验收通过后才执行 `git add <明确路径>`、`git diff --cached --check`、`git commit`。失败部署不得提交为已部署版本。
8. **公开同步**：仅在需要时同步已经部署的源码和文档，先比较内容，再独立提交、推送并核对远端 SHA。

## 速度预算与停止扩展

- 单页面、单接口、单配置等小型任务以 15 分钟为目标；跨主站与独立平台任务以 30 分钟为目标。预算用于阻止范围膨胀，不用于跳过失败门禁或生产安全检查。
- 初始发现只允许一个并行只读批次；后续只读取补丁上下文和失败目标，不重新全文读取已经确认的规范、长文档或调用链。
- 实现开始后，除非当前假设被源码或测试推翻，不再追加联网调研、全仓搜索、历史审计或无关问题修复。
- 一个 diff 对同一目标只保留一次成功验证结果。部署脚本再次执行相同构建时，不在部署前后手工重复；失败修复后只重跑失败门禁及其依赖。
- 生产验收以“目标健康 + 公网入口 + 一个业务断言”为默认上限；涉及鉴权时追加一个未授权断言，涉及迁移时追加迁移状态断言。
- 公开同步在所有项目提交完成后一次处理，只同步明确路径并一次比较哈希；公开专用文档只打最小补丁。
- 纯文档任务不运行应用构建、部署 dry-run、服务重启或生产业务测试，只检查 Markdown、链接、diff、提交和公开同步。

推荐命令骨架：

```powershell
git status --short
git diff --check
pnpm --prefix apps/<affected-app> run type-check
node scripts/quick-deploy.mjs --changed --dry-run
node scripts/quick-deploy.mjs --changed
git add -- <明确路径>
git diff --cached --check
git commit -m "<类型>: <中文摘要>"
```

`--skip-local-check` 仅在同一工作树、同一 diff 已经成功完成等价检查时使用；不得凭上一次提交或其他工作树的结果跳过。文档独立修改不触发运行时部署，仍需完成链接、格式、diff 和提交检查。

`--changed` 只读取 Git 已跟踪文件及已通过 `git add -N` 登记意图的新文件，避免把用户目录中的无关大文件误判为部署内容。共享包或锁文件变化会保守选择所有真实依赖端点；普通 app 变化只选择对应服务或前端。

## 命令错误复盘与硬约束

| 已发生错误 | 根因 | 后续强制做法 |
|---|---|---|
| 直接读取不存在的 `docs/deployment.md` | 未先发现真实文件 | 先执行 `rg --files docs` 或 `Test-Path`，再读取返回路径 |
| `rg` 报未闭合正则 | 固定文本被写成复杂正则 | 默认 `rg -F`；多个关键词拆成多条命令 |
| PowerShell 经 SSH 执行 `curl` 出现非法 URL | 本地与远端变量、引号互相展开 | 复杂逻辑使用 here-string 通过 SSH 标准输入发送，远端自行读取环境变量 |
| 远端压缩 JavaScript 出现括号语法错误 | 多层单行脚本不可审计 | 保持多行、缩进和 `try/finally`；可复用逻辑落入仓库脚本并先做语法检查 |
| GPU 轮询因一次连接超时直接退出 | 未区分瞬时超时和最终故障 | 捕获异常、退避重试、设置总截止时间，并用 `/ready`、进程和端口交叉验证 |
| 本地完整检查后部署脚本再次完整检查 | 未识别部署入口自带门禁 | 开发阶段只做目标最小检查，完整部署门禁只由部署脚本运行一次 |
| 诊断 ComfyUI 队列时输出完整提示词 | 未最小化生产查询字段 | 只投影 ID、状态、模型、尺寸、采样参数和耗时，不输出 prompt 或完整请求体 |
| 并行诊断使用快速失败聚合，单条无匹配导致其他输出丢失 | 未区分“全部必须成功”和“全部都要返回” | 独立诊断使用 `Promise.allSettled`；允许无匹配的搜索不得让整批命令返回失败 |
| `apply_patch` 因上下文空格不一致失败 | 未先核对待修改原文 | 先用 `rg -n -F` 定位精确文本，再提交最小上下文补丁；失败后重新读取目标行再重试 |
| 公开导出 README 全文件比较失败 | 公开目录需要调整相对链接，完整文件本来存在允许差异 | 对源码文件做精确比较；对 README、部署示例等路径适配文件只核验本次改动片段和预先登记的允许差异 |
| GitHub 首次推送因 443 连接超时失败 | 外网瞬时不可达 | 保留本地提交，最多重试三次并递增退避；成功后用 `git ls-remote` 核对远端 SHA，连续失败再报告网络阻塞 |

命令失败后的统一处理顺序是：保留错误输出、确认错误层级、修正命令或环境、重新执行失败步骤、确认成功后继续。禁止用 `|| true`、忽略退出码或改写业务校验来掩盖本应阻断部署的错误；只读诊断中允许容错时必须在报告中说明。

## 生产入口

```bash
ssh -i ~/.ssh/id_ed25519 -p 22 root@103.97.200.209
cd /v3
```

生产机项目目录为 `/v3`，前端静态目录在宿主机位于 `/opt/1panel/www/sites/*/index`。OpenResty 容器内同一目录显示为 `/www/sites/*/index`，Nginx `root`、日志和证书路径使用容器内视角。

`/v3` 当前是 `/data/v3` 的软链接，1Panel 数据在 `/data/1panel`。运维清理、备份、构建缓存和日志都应留在 `/data` 盘，不要把项目文件移动回系统盘。

服务统一由 PM2 管理；废弃的 systemd/传统 nginx 脚本已归档到 `backup/unused-runtime/deprecated-deploy-*`，不要恢复使用，也不要写入传统 `/etc/nginx/sites-available`。

## PM2

```bash
pm2 list
pm2 logs v3-backend v3-bot v3-wsproxy --lines 30 --nostream
```

进程名：

```text
v3-backend
v3-drawing
v3-worker
v3-media
v3-bot
v3-renderer
v3-wsproxy
v3-notification
v3-ops
```

重启：

```bash
cd /v3
pm2 restart ecosystem.config.js --only v3-backend --update-env
pm2 restart ecosystem.config.js --only v3-drawing --update-env
pm2 restart ecosystem.config.js --only v3-worker --update-env
pm2 restart ecosystem.config.js --only v3-media --update-env
pm2 restart ecosystem.config.js --only v3-bot --update-env
pm2 restart ecosystem.config.js --only v3-renderer --update-env
pm2 restart ecosystem.config.js --only v3-wsproxy --update-env
pm2 restart ecosystem.config.js --only v3-notification --update-env
pm2 restart ecosystem.config.js --only v3-ops --update-env
pm2 save
```

必须通过 `ecosystem.config.js` 重启，避免 SMTP、服务间 token 等生产私有环境变量从 PM2 进程环境中丢失。

## 健康检查

```bash
for port in 6369 3005 3012 3013 3004 3014 3011 3015 3016; do
  echo -n "$port "
  curl -s http://localhost:$port/health
  echo
done
```

## 聚合状态

```bash
curl -s http://localhost:6369/api/status
```

## 数据库

```bash
curl -s http://localhost:6369/health/db
```

## 1Panel 数据服务

```bash
docker ps --format '{{.Names}} {{.Ports}}' | grep -E '1Panel-(mariadb|redis|openresty)'
ss -lntp | grep -E ':(3306|6379)\b'
```

预期：

- MariaDB 容器名为 `1Panel-mariadb-4zb0`，宿主机只监听 `127.0.0.1:3306`。
- Redis 容器名为 `1Panel-redis-m7uL`，宿主机只监听 `127.0.0.1:6379`。
- OpenResty 容器名匹配 `1Panel-openresty-*`。

真实数据库和 Redis 密码只查服务器私有环境文件或 1Panel 私有配置，不写入运维文档和命令记录。

## OpenResty

```bash
OPENRESTY_CONTAINER=$(docker ps --format '{{.Names}}' | grep -m1 '^1Panel-openresty-')
docker exec "$OPENRESTY_CONTAINER" openresty -t
docker exec "$OPENRESTY_CONTAINER" openresty -s reload
```

`listen ... http2` 兼容性警告不是失败条件；`syntax is ok` 和公网验证通过才是放行依据。

当前 OpenResty 请求体和上游缓冲临时目录固定到 `/www/server-temp/*`，宿主机对应 `/data/1panel/www/server-temp/*`。如果大参考图上传返回 OpenResty `500`，优先检查：

```bash
docker exec "$OPENRESTY_CONTAINER" openresty -T 2>/dev/null | grep -E 'client_body_temp_path|proxy_temp_path'
ls -ld /data/1panel/www/server-temp /data/1panel/www/server-temp/*
```

主站 SPA fallback 使用 `try_files $uri $uri/index.html /index.html;`，避免存在目录但没有 `index.html` 的路由返回目录索引 `403`。

公网检查：

```bash
curl -k -L -s -o /dev/null -w 'www:%{http_code}\n' https://www.xanime.ink
curl -k -L -s -o /dev/null -w 'workflow:%{http_code}\n' https://www.xanime.ink/workflow
curl -k -L -s -o /dev/null -w 'admin:%{http_code}\n' https://admin.xanime.ink
```

`www` 和 `admin` 预期为 `200`；`/workflow` 已下线，预期为 `404`。

## 备份位置

| 内容 | 路径 |
|---|---|
| 代码与生产配置备份 | `/v3/backups/predeploy-<timestamp>` |
| 前端静态文件备份 | `/v3/backups/frontend-<timestamp>` |
| Bot 日志 | `/v3/bot-logs` |
| 媒体存储 | `/v3/media-storage` |
| 项目实际落盘 | `/data/v3` |
| 1Panel 数据 | `/data/1panel` |

2026-06-09 已确认的最近部署备份：

```text
/v3/backups/predeploy-20260609-093522
/v3/backups/frontend-20260609-094012
```

## 常见排查

| 现象 | 优先检查 |
|---|---|
| 前端能打开但接口 404 | Nginx API 代理路径 |
| 登录失败 | `DATABASE_URL`、管理员种子数据 |
| Worker 不消费任务 | `BACKEND_INTERNAL_URL`、`WS_PROXY_TOKEN`、`drawing-worker` 日志 |
| Bot 无响应 | wsproxy 连接、`BOT_SERVICE_URL`、OneBot token |
| 图片不显示 | `MEDIA_SERVICE_URL`、媒体存储路径、图片文件名回写 |
| 图库或个人图库缩略图大量 504 | OpenResty `xanime.ink` access/error 日志、`/images/thumb_*` 耗时、backend/media 日志、本地媒体目录容量和读取耗时 |
| 图库标签长期不更新 | `gallery_tagging_jobs` 是否有超时 `running`；backend 打标运行会自动回收超时 running job 并按失败重试次数继续处理 |
| Bot 任务长期 finalizing | 先确认是否存在 `task_image_<taskId>`；有最终图交给 Bot 补发/补确认，无最终图会被 ops-worker 超时修复为失败并按业务退款 |
| 参考图大图上传返回 OpenResty 500 | `/data/1panel/www/server-temp/*` 是否存在可写，`client_body_temp_path` 是否仍指向 `/www/server-temp/client_body_temp` |
| `/personal` 等前端目录路由返回 403 | `xanime.ink.conf` 的主站 fallback 是否为 `$uri/index.html`，静态目录是否缺少 `index.html` |
| 内部接口 403 | 各服务 `WS_PROXY_TOKEN` 是否一致 |
| 远端构建出现本地没有的 TS 错误 | 远端旧源码残留，清理 `/v3/apps`、`/v3/packages` 等受源码包管理目录后重新解包 |
| `pnpm install` 卡在 Puppeteer | 设置 `PUPPETEER_SKIP_DOWNLOAD=true`，并确认生产机浏览器策略 |

## 主站端口保护

主站内部 Node 服务端口必须只通过本机回环给 OpenResty 和服务间调用使用，不允许公网直连。2026-06-23 已添加 `/usr/local/sbin/aiimage-port-guard.sh` 和 `aiimage-port-guard.service`，阻断外部访问：

```text
3004,3005,3011,3012,3013,3014,3015,3016,6369
```

巡检命令：

```bash
systemctl is-active aiimage-port-guard.service
iptables -S INPUT | grep '3004,3005,3011,3012,3013,3014,3015,3016,6369'
```

公网验收要求：上述端口从公网不可连接，`80/443` 正常，MariaDB/Redis 仍只监听 `127.0.0.1`。

## 清理建议

归档或交付前清理：

- `.next`
- `dist`
- `*.tsbuildinfo`
- `*.tar.gz`
- 运行日志
- 临时上传文件

清理前必须确认目标路径在 `/v3`、`/data/v3`、`/tmp` 或明确的临时目录内；不得删除 `media-storage`、`local`、`backups`、数据库目录、Redis 数据或任何余额/生成记录相关数据。

## 2026-06-22 不可访问巡检补充

2026-06-22 主站不可访问后，手动重启整机恢复。只读巡检确认系统在 `02:11 CST` 启动，PM2 服务和 Docker 中 OpenResty/MariaDB/Redis 随系统恢复。上一轮 journald 在 `01:57` 后断档，没有正常 shutdown 记录，也没有明确 OOM、kernel panic 或磁盘 I/O error。

更可疑的应用层信号是 OpenResty 在不可访问前多批 `/images/thumb_*` 返回 `504`，错误为读取 backend 上游响应头超时。当前存储链路只使用本地媒体目录，后续排查图库、个人图库、图片详情加载慢或不可访问时，应优先检查图片缩略图读取、本地媒体目录容量、media-service 文件读取耗时和 OpenResty 源站缓存策略。

详细记录见 `docs/production-incident-20260622.md`。
