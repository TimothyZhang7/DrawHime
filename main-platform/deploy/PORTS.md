# 端口分配

| 服务 | 端口 |
|---|---:|
| backend | 6369 |
| drawing-service | 3005 |
| bot-service | 3004 |
| wsproxy-service | 3011 |
| drawing-worker | 3012 |
| media-service | 3013 |
| bot-renderer | 3014 |
| notification-worker | 3015 |
| ops-worker | 3016 |
| web-frontend | 5173 |
| admin-portal | 5174 |

禁止使用旧系统端口：`6367`、`3001`、`3002`、`3003`。

端口变更必须同步：

- `configs/env.example`
- `ecosystem.config.js`
- `docker-compose.yml`
- 源码默认值
- 本文件
- Nginx/OpenResty 配置
