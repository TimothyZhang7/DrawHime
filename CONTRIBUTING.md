# 贡献指南

## 开发流程

1. 从默认分支创建功能分支。
2. 保持服务职责边界，不让 GPU Runtime 直接接触公网、身份钱包或主站数据库。
3. 新增跨程序 DTO 前更新 `docs/interfaces/README.md`，共享类型统一放入 contracts 包。
4. 新源码需包含中文职责注释；鉴权、计费、幂等、事务和退款分支需说明关键约束。
5. 提交前执行类型检查、测试和完整构建。

```powershell
pnpm run type-check
pnpm run test
pnpm run build
```

## Pull Request

PR 描述应包含变更目的、接口或数据影响、验证命令和必要的回滚方式。涉及数据库结构时必须提交可审计迁移，生产环境不得使用 `prisma db push`。

## 禁止提交

真实凭证、生产地址清单、用户数据、生成产物、数据库导出、模型权重、构建目录和本地缓存均不得进入仓库。
