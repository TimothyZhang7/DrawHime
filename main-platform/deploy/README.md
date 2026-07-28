# 部署目录

本目录只保存部署辅助文件，不保存生产凭证。

## 当前统一口径

| 项 | 当前标准 |
|---|---|
| 生产项目入口目录 | `/v3` |
| 生产项目实际目录 | `/data/v3`，`/v3` 为软链接 |
| 1Panel 数据目录 | `/data/1panel` |
| 服务进程 | PM2，配置入口为 `/v3/ecosystem.config.js` |
| 主机侧静态目录 | `/data/1panel/www/sites/*/index` |
| OpenResty 容器内静态目录 | `/www/sites/*/index` |
| OpenResty 配置目录 | `/data/1panel/www/conf.d` |
| 当前 Nginx/OpenResty 参考配置 | `nginx.conf` |

生产命令和脚本统一使用 `/v3`，由软链接落到 `/data/v3`，不要把构建产物、缓存、日志或备份写回系统盘。

`/data/1panel/www/sites/...` 和 `/www/sites/...` 指向同一批站点文件的不同视角：前者用于 SSH 登录宿主机后的复制、备份、回滚；后者用于 1Panel OpenResty 容器里的 `root`、`access_log`、证书路径。

## 1Panel 容器服务

| 服务 | 容器名 | 宿主机端口 |
|---|---|---|
| MariaDB | `1Panel-mariadb-4zb0` | `127.0.0.1:3306` |
| Redis | `1Panel-redis-m7uL` | `127.0.0.1:6379` |
| OpenResty | `1Panel-openresty-*` | 由 1Panel 管理 |

真实数据库和 Redis 密码只保存在服务器私有配置中，不写入本目录文件。

## 文件说明

| 文件 | 状态 | 说明 |
|---|---|---|
| `nginx.conf` | 当前参考 | 统一维护主站、管理后台和本地模型独立路径，已下线的 workflow 入口返回 404 |
| `PORTS.md` | 当前参考 | 端口分配表 |

废弃脚本、旧主域名配置和单站点片段已归档到 `backup/unused-runtime/deprecated-deploy-*`。

详细部署见：

- [../DEPLOY.md](../DEPLOY.md)
- [../docs/deployment.md](../docs/deployment.md)
- [PORTS.md](PORTS.md)
