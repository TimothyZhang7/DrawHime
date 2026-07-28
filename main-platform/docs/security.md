# 安全与脱敏

## 不应写入文档的内容

- 数据库真实密码。
- 邮箱授权码。
- JWT 密钥。
- 服务间 token。
- 管理员真实密码。
- SSH 私钥内容、私钥口令、一次性验证码。

## 公开文档边界

- 生产公网 IP、SSH 登录用户和私有主机名使用占位符，不进入公开仓库。
- 仅记录标准密钥变量和通用文件名，例如 `AIIMAGE_DEPLOY_KEY` 与 `~/.ssh/id_ed25519`。
- 非敏感生产路径，例如 `/v3`、宿主机 `/opt/1panel/www/sites/*/index`、OpenResty 容器内 `/www/sites/*/index`。
- PM2 进程名、端口号、健康检查 URL。
- 数据库与 Redis 使用通用服务名或回环地址，不记录生产容器实例名。

写入这些资料时不得附带密钥内容、密码、token 或真实 `.env` 全文。

## 文档写法

使用占位符：

```text
DATABASE_URL=mysql://<user>:<password>@<host>:3306/aiimagev3
REDIS_URL=redis://:<password>@<host>:6379
JWT_SECRET=<random-32-bytes>
WS_PROXY_TOKEN=<random-32-bytes>
```

## 代码与配置

- `configs/env.example` 只能放示例值或占位符。
- 真实 `.env` 不进入交付包。
- 卡密只保存 SHA-256 哈希。
- 邮箱验证 token 和密码重置 token 只保存哈希。
- API Key 对外展示只能使用掩码。
- 服务间 token 缺失时只允许显式的 `development` 或 `test` 环境兼容；生产环境和未声明环境必须默认拒绝。
- 邮件发送器必须禁用本地文件读取和远程 URL 拉取，未配置 SMTP 时不得把验证或重置链接写入日志。

## 发布前检查

```bash
rg -n "BEGIN OPENSSH|PRIVATE KEY|sk-[A-Za-z0-9_-]{16,}|AKIA|AIza|ghp_|github_pat_"
rg -n "password|secret|token|授权码|密码" docs standards configs deploy scripts
```

命中后人工确认是否为占位符。
