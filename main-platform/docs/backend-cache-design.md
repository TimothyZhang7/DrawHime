# 后端内部缓存设计

本文记录 backend 侧缓存设计。目标是降低数据库和内部服务重复读取压力，同时保持余额、任务状态和登录态尽可能及时。

## 边界原则

- 对外动态 JSON 接口继续返回 `Cache-Control: no-store`，不交给浏览器或共享代理缓存。
- 当前生产按源站直连运行，静态资源由 OpenResty 提供长缓存和预压缩文件，动态接口不依赖任何边缘缓存。
- 后端缓存只缓存读取结果，不缓存写接口、不缓存鉴权失败、不缓存包含明文 token、卡密、密码、邮箱验证 token 的内容。
- 余额、充值、任务状态、QQ 绑定、隐私和权限相关缓存必须有主动失效路径。
- 任务调度、Worker 抢占、扣费、退款、充值等强一致写入路径不得依赖缓存判断。

## 分层

| 层级 | 用途 | 建议 |
|---|---|---|
| L1 进程内缓存 | 承接极高频短时间重复请求 | TTL 0.5-10 秒，LRU 限容量 |
| L2 Redis | 多进程共享缓存、tag 版本、失效广播 | TTL 1-300 秒，key 带项目前缀 |
| singleflight | 同 key 并发请求合并 | 避免同一瞬间多次打 DB |

生产环境已预留 `REDIS_URL` 和 `REDIS_KEY_PREFIX`。第一阶段可先做 L1 + singleflight；如果 backend 存在多实例或 PM2 cluster，再启用 Redis L2。

## Key 规则

缓存 key 必须包含权限边界，禁止只用 URL。

```text
wallet:web:${userId}
wallet:qq:${qqNumber}
tasks:user:${userId}:${hash(sortedTaskIds)}
tasks:internal:${hash(sortedTaskIds)}
generations:user:${userId}:${hash(query)}
gallery:list:${hash(query)}
image:detail:${filename}:viewer:${userId || 0}
admin:generations:${role}:${hash(query)}
admin:user:${userId}
config:all
sites:list
bot:accounts
wsproxy:user:${userId}:${hash(query)}
```

Redis key 必须再加 `REDIS_KEY_PREFIX`，例如 `aiimage:v3:cache:${key}`。

## Tag 失效

建议用 tag version，而不是 Redis 扫描删除。缓存 key 组装时读取相关 tag 的版本号，写入事件只递增版本。

| Tag | 触发场景 |
|---|---|
| `user:${userId}` | 用户资料、邮箱验证、隐私、QQ 绑定变化 |
| `wallet:${walletId}` | 扣费、退款、充值、免费余额重置、管理员调整 |
| `qq:${qqNumber}` | QQ 绑定、QQ 钱包、QQ 触达、Bot 余额查询 |
| `task:${taskId}` | 子任务、主状态、图片、本地媒体配置、隐私、删除 |
| `task-list:user:${userId}` | 用户创建任务、任务状态变化、删除 |
| `task-list:admin` | 任务创建、状态变化、删除、重试 |
| `gallery` | 成功图入库、图片本地配置、隐私变化、删除 |
| `image:${filename}` | 点赞、浏览聚合、图片详情变化；浏览量只要求详情立即刷新，图库列表允许短延迟 |
| `template` | 模板 CRUD、收藏 |
| `config` | 后台配置、命令配置、绘图配置 |
| `site` | 站点 CRUD、启停、失败计数、默认模型 |
| `bot` | Bot 上下线、绑定、封禁、消息计数 |
| `wsproxy` | endpoint 创建、绑定、解绑、mark seen |

写接口成功后递增对应 tag。缓存读取时把 tag 版本纳入 key，旧值自然过期。

## 端点策略

| 端点 | 缓存策略 | TTL | 主动失效 |
|---|---|---:|---|
| `GET /api/wallet/status`, `/wallet/status` | 用户级极短缓存 + singleflight | L1 1s，Redis 1-2s | 扣费、退款、充值、免费重置、绑定/解绑 |
| `GET /api/generations/tasks?ids=` | 用户级高频轮询缓存；含运行中任务短 TTL，纯终态长 TTL | running 0.8-1.5s，终态 30-60s | 子任务、状态、图片、本地媒体配置、隐私、删除 |
| `GET /internal/generations/tasks?ids=` | 内部 Bot 状态查询；同任务 key，不含用户权限 | 0.8-1.5s | 子任务、状态、图片、本地媒体配置 |
| `GET /api/generations` | 用户任务列表 | 2-5s | 创建任务、状态变化、隐私、删除、图片本地配置 |
| `GET /api/gallery` | 公共图库列表，适合 Redis | 5-15s | 成功图入库、图片本地配置、隐私变化、删除 |
| `GET /api/images/:filename/detail` | 基础信息缓存，用户点赞状态可短缓存 | 基础 15-60s，用户态 3-5s | 隐私、删除、点赞、浏览聚合 |
| `POST /api/images/:filename/view` | 不缓存；浏览写入可异步聚合 | 0 | 可延迟刷新图片详情 |
| `POST/DELETE /api/images/:filename/like` | 不缓存 | 0 | `image:${filename}` |
| `GET /images/:filename` | 文件响应已有 HTTP 长缓存，不进 JSON CacheService | 1 年 | 文件名不可变 |
| `GET /images/proxy` | QQ 临时外链代理；只缓存成功图片流 | 5-30min | 自然过期 |
| `GET /api/templates`, `GET /api/templates/:id` | 模板列表和详情 | 15-60s | 模板 CRUD、收藏 |
| `GET /api/recharge/shop` | 充值页配置 | 30-120s | 后台配置变化 |
| `GET /api/users/profile`, `/auth/me`, `/qq/status` | 用户状态短缓存 | 3-10s | 用户资料、邮箱验证、QQ 绑定、隐私 |
| `GET /api/user-model-pref` | 用户模型偏好 | 30-120s | 保存偏好 |
| `GET /api/drawing/models` | 绘图模型列表 | 30-120s | 站点/模型配置变化 |
| `GET /admin/generations`, `GET /admin/generations/:id` | 管理后台任务列表和详情 | 列表 2-5s，详情 2-10s | 任务写入、状态、删除、重试 |
| `GET /admin/users`, `GET /admin/users/:id` | 后台用户管理 | 5-15s | 用户更新、角色、钱包、绑定 |
| `GET /admin/balance/*` | 后台余额相关查询 | 1-5s | 任意钱包或 QQ 余额写入 |
| `GET /admin/stats`, `/admin/stats/trends` | 后台统计 | stats 5-10s，trends 30-120s | TTL 自然过期 |
| `GET /admin/sites`, `GET /admin/sites/:id`, `/admin/sites/runtime-stats` | 站点管理 | sites 5-30s，runtime 3-10s | 站点 CRUD、启停、失败计数 |
| `GET /admin/config*`, `/admin/ai-image/config` | 配置接口；当前已有 60s 进程缓存 | 30-60s | 配置保存/删除 |
| `GET /admin/bot/status`, `/accounts`, `/qq-bindings` | Bot 后台状态 | status 2-5s，accounts 5-10s，bindings 5-15s | Bot 上下线、绑定解绑、封禁 |
| `GET /wsproxy/my-endpoint`, `/my-bots`, `/public-bots`, `/admin/bots` | wsproxy 查询 | my 5-15s，public 10-30s，admin 5-10s | endpoint、绑定、解绑、封禁、seen |
| `GET /internal/worker/pending-tasks` | 不缓存 | 0 | 调度必须实时 |
| `GET /internal/worker/task-status` | 只做 300-500ms singleflight | <=0.5s | 状态变化 |
| `GET /internal/bot/finalizing-tasks` | 不缓存或 1s singleflight | 0-1s | Bot 投递必须及时 |
| `GET /internal/bot/commands`, `/internal/sites/config`, `/internal/drawing-config` | 内部配置查询 | 30-60s | 配置/站点变化 |
| `GET /internal/generations/by-qq`, `/recent`, `/drawing-stats` | Bot 查询类接口 | 2-10s | 任务创建、状态、删除 |

所有 `POST`、`PUT`、`PATCH`、`DELETE` 默认不缓存。它们的职责是完成真实写入，并失效对应 tag。

## 实现建议

新增 `apps/backend/src/shared/cache/cache-service.ts`：

- `getOrSet<T>(key, options, loader)`：读穿缓存。
- `invalidateTags(tags)`：递增 Redis tag version，同时清理 L1 相关索引。
- `singleflight(key, loader)`：同 key 合并。
- `ttlJitter(ttl)`：加 10%-20% 随机抖动，避免同一时刻集中失效。
- `staleWhileRevalidate` 只允许用于图库、统计、配置，不用于余额和任务状态。

响应头建议：

```text
X-Backend-Cache: hit | miss | stale | bypass
X-Backend-Cache-Key: 只在本地调试环境输出
```

生产日志只记录命中状态、耗时和 key hash，禁止记录完整 token、邮箱验证链接、卡密或图片代理原始 URL。

## 落地顺序

1. 建立 CacheService、Redis 客户端、L1 LRU、singleflight 和诊断头。
2. 接入 `/api/generations/tasks`、`/internal/generations/tasks`、`/api/wallet/status`。
3. 接入 `/api/gallery`、`/api/images/:filename/detail`。
4. 接入后台高频页：`/admin/generations`、`/admin/users`、`/admin/balance/wallets`。
5. 接入配置、模板、站点、Bot、wsproxy 查询。
6. 增加运维指标：命中率、Redis 耗时、DB loader 耗时、singleflight 合并次数。

## 2026-06-12 第一阶段实施任务

本阶段只落地 L1 进程内缓存和 singleflight，不引入 Redis 依赖，原因是当前生产 backend 仍以单 PM2 进程运行为主，L1 可以先削减同一秒内的轮询、配置和图库重复查询；Redis L2 等后续确认多实例或跨进程共享需求后再接入。

### 通用能力

- 新增 `shared/cache/cache-service.ts`，提供 `getOrSet`、`invalidateTags`、`bypass`、`clear`、`getStats`。
- L1 key 由业务显式传入，key 内必须包含用户、QQ、任务 ID、查询参数等权限边界。
- `getOrSet` 内置 singleflight，同 key 并发 miss 只执行一次 loader。
- 每个缓存项保存 tag 列表；写入成功后按 tag 清理 L1 索引。
- TTL 加 10% 抖动，避免大量轮询 key 同时失效。
- 缓存头只在当前响应写出 `X-Backend-Cache`，动态接口的 `Cache-Control: no-store` 不变。

### 本轮接入端点

| 端点 | Key | TTL | 失效 |
|---|---|---:|---|
| `GET /api/wallet/status`、`GET /wallet/status` | `wallet:web:${userId}` | 1000ms | `user:${userId}`、钱包写入用 `cache.invalidateTags(['wallet'])` 粗粒度清理 |
| `GET /api/generations/tasks?ids=` | `tasks:user:${userId}:${sortedIds}` | 运行中 1000ms，纯终态 30000ms | `task:${taskId}`、`task-list:user:${userId}` |
| `GET /internal/generations/tasks?ids=` | `tasks:internal:${sortedIds}` | 运行中 1000ms，纯终态 30000ms | `task:${taskId}`、`task-list:admin` |
| `GET /api/generations` | `generations:user:${userId}:${query}` | 2500ms | `task-list:user:${userId}`、`task-list:admin` |
| `GET /api/gallery` | `gallery:list:${query}`，基础列表不含用户点赞态 | 30000ms | `gallery` |
| `GET /api/images/:filename/detail` | `image:detail:${filename}:viewer:${userId || 0}` | 5000ms | `image:${filename}`、`gallery` |
| `GET /admin/config`、`GET /admin/ai-image/config`、`GET /internal/drawing-config` | `config:*` | 30000ms | `config` |
| `GET /internal/bot/commands` | `bot:commands` | 30000ms | `config`、`bot` |

### 本轮主动失效点

- 任务创建、状态更新、子任务写入、隐私修改、删除任务、Bot 投递成功、图片本地配置回写：清理相关 `task:*`、`task-list:*`、`gallery`。
- 钱包扣费、退款、充值、管理员调整、每日免费重置、QQ 绑定/解绑：清理 `wallet`，以及能确定时清理 `user:*`、`qq:*`。
- 配置写入、删除、命令配置保存：清理 `config` 和 `bot`。
- 点赞、删除图片：清理 `image:*` 和 `gallery`；浏览图片只清理 `image:*`，图库列表通过 TTL/stale 后台刷新同步浏览量。
- 2026-07-02 起，点赞/取消点赞只清理 `image:*`，不再清理 `gallery`。原因是公开图库基础缓存不含当前用户点赞态，用户态会在命中后额外查询覆盖；卡片 `likeCount` 允许随 TTL/stale 短时间延迟，避免高频点赞打穿全站图库首屏缓存。

### 不在本轮缓存的接口

- 所有 `POST`、`PUT`、`PATCH`、`DELETE` 写接口只负责真实写入和失效，不读缓存。
- `/internal/worker/pending-tasks`、`/internal/worker/claim-task`、`/internal/worker/finalize-task` 继续直查直写，避免调度延迟。
- 鉴权、登录、邮箱验证、卡密明文、密码重置不缓存。

## 验证口径

- `/api/wallet/status` 充值、扣费、退款后 1 秒内必须更新。
- `/api/generations/tasks` 运行中任务状态延迟不超过 1-2 秒。
- `/api/gallery` 新图在成功入库并写入图片文件名后 15 秒内可见；当前 `/images/:filename` 只读取 media-service 本地媒体目录。
- 后台列表刷新不应阻塞任务写入。
- Redis 不可用时自动降级到 L1 或直查 DB，不能影响核心业务。

## 2026-06-12 第二阶段完善

本轮把缓存策略从业务路由中抽离到 `apps/backend/src/shared/cache/cache-policies.ts`：

- `cache-service.ts` 只保留通用 L1、singleflight、tag 失效、统计和响应头能力。
- `cache-policies.ts` 集中维护端点 key、TTL、tag、动态 TTL 判断。
- 业务路由不再直接拼 `getOrSet` key，除 `/health/cache` 外不直接读取 `backendCache`。
- 管理端命令配置和 Bot 内部命令配置返回结构不同，必须使用独立 key：`admin:command-configs` 与 `bot:commands`。

本轮新增或整理覆盖：

| 分类 | 端点 | 策略函数 |
|---|---|---|
| 钱包 | `/api/wallet/status`, `/wallet/status` | `cacheWebWalletStatus` |
| 任务 | `/api/generations`, `/api/generations/tasks`, `/internal/generations/tasks` | `cacheUserGenerationList`, `cacheUserTasks`, `cacheInternalTasks` |
| 图库 | `/api/gallery`, `/api/images/:filename/detail` | `cacheGalleryList`, `cacheImageDetail` |
| 配置 | `/admin/config*`, `/admin/ai-image/config`, `/internal/drawing-config` | `cacheConfigAll`, `cacheConfigItem`, `cacheAiImageConfig`, `cacheDrawingRuntimeConfig` |
| Bot 配置 | `/admin/command-configs`, `/internal/bot/commands` | `cacheBotCommandConfigs`, `cacheInternalBotCommands` |
| 绘图模型 | `/api/drawing/models` | `cacheDrawingModels` |
| 充值 | `/api/recharge/shop` | `cacheRechargeShop` |
| 用户端模板 | `/api/templates`, `/api/templates/:id` | `cacheUserTemplateList`, `cacheTemplateDetail` |
| 用户资料 | `/auth/me`, `/api/users/profile`, `/api/users/me/privacy`, `/qq/status`, `/api/user-model-pref` | `cacheCurrentUser`, `cacheUserProfile`, `cacheUserPrivacy`, `cacheQqStatus`, `cacheUserModelPref` |
| 后台 | `/admin/generations`, `/admin/generations/:id`, `/admin/balance/wallets` | `cacheAdminGenerationList`, `cacheAdminGenerationDetail`, `cacheAdminWalletList` |

后续若接入 Redis L2，只允许在 `cache-service.ts` 中扩展，不允许在业务路由直接访问 Redis。

## 2026-06-18 用户端访问速度优化

本轮继续沿用 L1 + singleflight，不改变动态 JSON 的 `Cache-Control: no-store`，避免浏览器或共享缓存保存私有用户数据。新增覆盖：

| 端点 | 策略 | TTL | 失效 |
|---|---|---:|---|
| `GET /api/templates` | 当前用户维度模板列表缓存 | 15s | 模板创建、更新、删除、收藏变化 |
| `GET /api/templates/:id` | 按模板 ID + viewer 缓存详情 | 15s | 模板创建、更新、删除、收藏变化 |
| `GET /auth/me` | 当前登录用户摘要缓存 | 3s | 用户资料、邮箱验证、QQ 绑定/解绑 |
| `GET /api/users/profile` | 当前用户资料缓存 | 10s | 用户资料修改、QQ 绑定/解绑 |
| `GET /api/users/me/privacy` | 当前用户 Web/Bot 隐私偏好缓存 | 5s | 隐私修改、QQ 绑定/解绑 |
| `GET /qq/status` | QQ 绑定状态和余额摘要极短缓存 | 1.5s | 钱包、配置、用户绑定变化 |
| `GET /api/user-model-pref` | 当前用户模型偏好缓存 | 60s | 保存模型偏好 |

写接口新增主动失效：

- 模板创建、更新、删除、收藏和取消收藏：清理 `template`、`template:<id>`、`user:<userId>`。
- 用户名、隐私、模型偏好保存：清理 `user:<userId>`。
- QQ 绑定码生成、绑定成功、解绑：清理用户、钱包和 QQ 相关 tag。

这些缓存主要优化用户端模板页、生成页、个人主页、充值页和资料页的重复进入速度；任务状态、余额和钱包强一致链路仍保持已有短 TTL 或写后主动失效。

## 2026-06-18 图库访问速度优化

本轮进一步优化公开图库：

- `/api/gallery` 基础列表缓存从按 viewer 拆分改为按查询参数共享，缓存值不包含当前用户私有字段。
- 登录用户访问图库时，backend 在缓存命中后只额外查询当前页任务的点赞态，并把 `liked` 覆盖回响应。
- 图库基础列表 TTL 从 10 秒提升到 30 秒；新图入库、隐私变化、删除和点赞仍通过 `gallery` 或 `image:*` tag 主动失效。
- 用户端图库页对未登录公开列表增加 30 秒内存缓存，不写入 localStorage，避免跨账号残留点赞态。
- 用户端首屏前 8 张缩略图使用 eager/high priority 加载，其余图片继续 lazy，优先保障图库首屏可见速度。

动态接口响应头仍保持 `Cache-Control: no-store`；共享缓存只存在 backend 进程内，不依赖外部边缘缓存。

## 2026-06-19 图库 stale-while-revalidate 优化

本轮在 backend L1 缓存中增加 `stale` 命中状态，只给公开图库基础列表启用：

- `/api/gallery` 基础列表 TTL 保持 30 秒，额外允许 120 秒 stale 窗口。
- 缓存刚过期时先返回旧列表并写出 `X-Backend-Cache: stale`，同时后台刷新缓存，避免用户刚好撞上过期点时等待数据库查询。
- 新图入库、隐私变化、删除和点赞仍通过 `gallery` 或 `image:*` tag 主动失效；被主动失效的缓存不会进入 stale 窗口。
- 钱包、任务状态、用户资料、QQ 绑定、充值、后台余额等强一致接口不启用 stale。
- 缓存统计新增 `staleHits` 和 `backgroundRefreshes`，用于巡检 stale 命中和后台刷新次数。

## 2026-06-19 图库聚合搜索优化

本轮增强 `/api/gallery?search=`：

- 无前缀搜索使用“分词 AND、多字段 OR”，覆盖任务 ID、clientRequestId、提示词、用户名、邮箱、QQ、来源、模式、上游模型和站点。
- 支持 `qq:`、`user:`、`id:`、`task:`、`prompt:`、`model:`、`site:`、`source:`、`mode:` 前缀，用户可按明确字段缩小范围。
- 服务端限制搜索最大长度和分词数，避免长输入造成无边界模糊扫描。
- 提示词搜索优先使用 MySQL FULLTEXT，中文或短词保留 `LIKE` 兜底以保证准确性。
- 新增可复跑索引脚本 `apps/backend/prisma/gallery-search-indexes.mjs`，只新增图库搜索相关索引，不改业务数据。
- 搜索结果仍走 `cacheGalleryList`，缓存 key 包含查询参数；新图、隐私、删除、点赞仍通过 `gallery` 或 `image:*` 主动失效。

## 2026-06-19 图库搜索完善

本轮继续完善图库搜索准确性和可用性：

- 搜索构造逻辑拆分到 `apps/backend/src/modules/gallery/gallery-search.ts`，图库服务只负责业务查询和结果装配。
- 支持组合搜索，例如 `qq:QQ_ID 模型:gpt 角色`，显式字段之间和普通词之间使用 AND 约束。
- 新增中文前缀和中文值映射：`用户:`、`任务:`、`提示词:`、`模型:`、`站点:`、`来源:网页/Bot`、`模式:图生图/文生图`。
- 公开图库热路径不做图片文件名反查；该路径需要扫描 `system_configs` JSON 大字段，当前不纳入用户端聚合搜索，避免慢查询影响图库访问。
- 图库列表补齐最终成功上游模型字段，前端卡片展示模式、来源和模型，便于用户判断搜索结果。

## 2026-07-02 状态和后台统计提速

本轮巡检发现 `/api/status` 绑定 `task-list:admin` 和 `site` 失效标签后，会被任务状态高频写入反复打穿缓存，导致公开状态页反复执行健康探测和数据库聚合。调整为：

- `GET /api/status` 使用 15 秒 TTL 和 45 秒 stale 窗口，只绑定 `status` 标签，不再随每次任务写入主动失效。
- `GET /admin/stats` 使用 10 秒 TTL 和 30 秒 stale 窗口，降低后台仪表盘重复打开时的聚合压力。
- `GET /admin/stats/trends` 使用 60 秒 TTL 和 180 秒 stale 窗口，趋势桶按 TTL 自然刷新。
- `GET /admin/health/services` 使用 5 秒 TTL 和 15 秒 stale 窗口，避免后台多入口同时探测内部服务。

这些缓存只影响只读展示，不参与余额、任务调度、扣费、退款、站点选择或权限判断。Worker 记录站点成功/失败同时改为原子 SQL 更新，减少并发回写时 `api_sites` 先读后写冲突。

同时新增可复跑索引脚本 `apps/backend/prisma/status-performance-indexes.mjs`，为 `generation_sub_tasks` 增加 `generation_sub_tasks_status_runtime_idx (kind, status, created_at, site_id, latency_ms)`，用于加速状态页按站点、状态和时间范围聚合上游尝试的查询。

## 2026-07-02 图库首屏预热

backend 启动和 `gallery` tag 主动失效后，都会异步补热公开图库首屏缓存：

- 预热 `/api/gallery` 默认首屏查询：`sort=latest&page=1&pageSize=24`。
- 预热 query 必须包含路由归一化后的默认字段，例如 `tagMatch=any`，确保缓存 key 与真实首屏请求一致。
- 同步预热 `/api/gallery/tags/popular?limit=24`，避免筛选弹窗首次打开时等待热门标签查询。
- 预热复用 `GalleryService.browse`、`GalleryTagService.listPopularTags` 和现有 `cacheGalleryList`、`cacheGalleryPopularTags`，不引入伪数据、不写任务、余额或图片记录。
- 补热带节流保护：默认延迟 1.5 秒，最小补热间隔 15 秒，避免任务高峰期每次新图或标签写入都打数据库。
- 新图成功入库、Bot 成功交付、图片放大保存和 AI 标签/标题写入使用软失效：已有图库列表进入 stale 并后台刷新，用户不再直接等待冷查询。
- 删除、隐私修改和后台批量管理仍使用硬失效，避免已隐藏或已删除图片继续出现在公开列表。
- 预热失败只记录日志，不影响 backend 启动、鉴权、余额、任务调度和写入链路。
- 如需临时关闭，可设置 `BACKEND_GALLERY_WARMUP_DISABLED=true`。
