# 项目代理约束

- 永远使用中文沟通。
- 所有新增或修改的源码必须有中文注释；新增源码文件必须有中文文件级职责注释。
- 不允许使用假数据、伪接口或跳过鉴权、计费、幂等、错误处理来制造成功结果。
- 本项目数据库、Redis、对象存储与主站物理隔离，不直接连接或查询主站数据库。
- 主站账号通过 SSO 使用，禁止复制密码哈希；主站余额只通过版本化 Integration API 预留、提交和释放。
- GPU Runtime 不得直接暴露公网；所有任务必须经过 scheduler 和 GPU Agent。
- 跨程序请求、响应和事件先登记到 `docs/interfaces/README.md`，再落到 `packages/contracts`。
- 成功响应使用 `{ ok: true, data }`，失败响应使用 `{ ok: false, code, message }`。
- 数据库迁移使用可审计 SQL，禁止以 `db push` 代替生产迁移。
- 未配置真实依赖时 readiness 返回明确未就绪，不使用占位数据模拟可用。
