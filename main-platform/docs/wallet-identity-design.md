# 钱包与身份绑定设计

## 目标

本设计用于把现有“余额归属 QQ 号”的模型升级为“余额归属身份钱包，绑定关系提供跨端共享能力”。

需要同时满足：

- Web 用户不绑定 QQ 也能网页绘图、充值、查看余额。
- QQ Bot 用户不绑定网页账号也能 Bot 绘图、兑换卡密、查看余额。
- Web 账号和 QQ 号绑定后，两端可以联合使用余额。
- 支持解绑 QQ，解绑后两端恢复各自余额，不做余额拆分或转移。
- 每日免费余额按端独立发放：Web 身份一份，QQ 身份一份。
- 任意端扣费都必须先消耗可访问钱包的免费余额，再消耗付费余额。
- 失败退款必须按实际扣费来源原路退回。

## 核心原则

### 不做破坏性合并

绑定 QQ 时不把两个钱包物理合并成一个钱包。

原因：

- 物理合并后解绑时无法公平拆分余额。
- 已消耗金额无法可靠判断原本属于 Web 还是 QQ。
- 后续退款会受到当前绑定状态影响，存在资金归属风险。

正确做法：

```text
Web 用户有 user wallet
QQ 号有 qq wallet
绑定只建立 wallet_link
解绑只关闭 wallet_link
```

### 余额归属身份钱包

```text
userId -> user wallet
qqNumber -> qq wallet
```

绑定后不是变成一个钱包，而是当前身份可以访问“自己的钱包 + 已绑定身份的钱包”。

### 扣费必须分账记录

任务扣费不能只记录总金额，必须记录每个 wallet 扣了多少免费余额、多少付费余额。

失败退款、取消退款、超时退款都只看这张扣费分账表，不看当前是否还绑定。

## 数据模型

### wallets

身份钱包表。一个 Web 用户一个 user wallet，一个 QQ 号一个 qq wallet。

```text
id
ownerType        user | qq
ownerKey         userId 字符串或 qqNumber 字符串
freeBalance
paidBalance
createdAt
updatedAt
```

约束：

```text
unique(ownerType, ownerKey)
```

### wallet_links

Web 用户和 QQ 号的绑定关系。

```text
id
userId
qqNumber
status          active | unbound
createdAt
unboundAt
createdByIp
unboundByIp
```

约束：

```text
unique(userId, status=active)
unique(qqNumber, status=active)
```

同一时间一个 Web 用户只能绑定一个 QQ，一个 QQ 也只能绑定一个 Web 用户。

### wallet_ledger

余额流水表。所有充值、扣费、退款、每日免费发放都写入流水。

```text
id
walletId
type            daily_free | recharge | charge | refund | admin_adjust
amount
balanceKind     free | paid
source          web | bot | admin | system
taskId
rechargeCardId
createdAt
metadata
```

邀请奖励也必须写入 `wallet_ledger`，`type=referral_reward`、`source=system`、`balanceKind=paid`。奖励只进入 Web 用户钱包的付费余额，不进入 QQ 钱包；发放由邮箱验证事务或已验证用户使用邀请码事务触发，必须基于 `user_referrals.status` 幂等判断，不能绕过钱包服务直接修改余额。

### daily_free_grants

每日免费余额发放幂等表。

```text
id
walletId
date
amount
createdAt
```

约束：

```text
unique(walletId, date)
```

也可以只用 `wallet_ledger` 承担幂等，但独立表更容易做日常巡检。

### task_charge_allocations

任务扣费分账表。

```text
id
taskId
walletId
freeAmount
paidAmount
createdAt
refundedAt
```

约束：

```text
unique(taskId, walletId)
```

任务失败退款时按本表原路退回。

## 扣费规则

任务创建前必须先把用户输入或默认值解析为真实模型 ID，再读取 `drawing_model_settings` 中该模型的单次价格。Web、Bot、批量任务和复投必须使用同一价格；历史全局单价只允许为尚未登记的模型兜底。模型价格确定后仍由钱包事务完成扣费和任务创建，失败退款继续按原分账记录原路退回。

### Web 端发起任务

如果 Web 用户没有绑定 QQ：

```text
1. user wallet 免费余额
2. user wallet 付费余额
```

如果 Web 用户绑定了 QQ：

```text
1. user wallet 免费余额
2. qq wallet 免费余额
3. user wallet 付费余额
4. qq wallet 付费余额
```

### QQ Bot 端发起任务

如果 QQ 没有绑定 Web：

```text
1. qq wallet 免费余额
2. qq wallet 付费余额
```

如果 QQ 绑定了 Web：

```text
1. qq wallet 免费余额
2. user wallet 免费余额
3. qq wallet 付费余额
4. user wallet 付费余额
```

### 退款规则

退款不重新计算绑定关系。

流程：

```text
1. 查询 task_charge_allocations
2. 对每个 wallet 按 freeAmount / paidAmount 原路退回
3. 写 wallet_ledger refund
4. 标记 task_charge_allocations.refundedAt
```

退款必须幂等。已有 `refundedAt` 的分账行不能重复退款。

## 每日免费余额

每日免费余额按 wallet 独立发放。

```text
user wallet 每日一份
qq wallet 每日一份
```

绑定不会产生新 wallet，也不会重复发放。

发放时机建议：

- 用户打开 Web 余额、绘图、充值页时惰性发放 user wallet。
- QQ Bot 收到绘图、余额、卡密命令时惰性发放 qq wallet。
- ops-worker 可以每日巡检补发或清理异常，但不作为唯一入口。

## 解绑规则

解绑 QQ 只关闭 `wallet_links`，不转移余额。

解绑后：

```text
Web 账号只能访问 user wallet
QQ Bot 只能访问 qq wallet
```

绑定期间已经被另一端消耗的余额不回滚。

解绑文案需要明确：

```text
解绑后，网页账号和 QQ Bot 将分别使用各自余额；已有余额不会互相转移。
```

如果解绑时存在运行中任务：

- 不阻止解绑。
- 任务后续退款仍按 `task_charge_allocations` 原路退回。
- 任务展示保留原始 `userId` / `qqNumber`。

## 各端修改范围

### backend

backend 是余额和任务最终写入入口，需要承担主要改造。

需要新增模块：

- `wallet-service`
- `wallet-repository`
- `wallet-ledger-service`
- `wallet-daily-free-service`
- `wallet-charge-service`

需要改造：

- Prisma schema 增加 `wallets`、`wallet_links`、`wallet_ledger`、`daily_free_grants`、`task_charge_allocations`。
- `GenerationTask` 增加主扣费上下文字段，例如 `chargeStatus`，历史 `qqNumber` 保留用于 Bot 来源和展示。
- Web `/api/generate` 从 `userId` 解析可访问钱包并扣费。
- Bot `/internal/bot/generate` 从 `qqNumber` 解析可访问钱包并扣费。
- `/qq/status` 不再作为 Web 绘图前置条件，只返回绑定状态和可访问余额摘要。
- 新增 `/wallet/status` 或 `/users/balance`，返回当前 Web 用户可访问余额。
- Bot 内部新增按 QQ 查询余额的接口，例如 `/internal/bot/wallet/:qqNumber`。
- 充值卡兑换按调用入口入账：
  - Web 兑换进入 user wallet。
  - Bot 兑换进入 qq wallet。
- QQ 绑定从“余额所有权绑定”改成“wallet_link active”。
- QQ 解绑从“清空余额归属”改成“关闭 wallet_link”。
- 所有失败退款逻辑改为按 `task_charge_allocations` 幂等退款。

接口返回建议：

```json
{
  "ok": true,
  "data": {
    "freeBalance": "3.00",
    "paidBalance": "30.00",
    "wallets": [
      { "type": "user", "freeBalance": "1.00", "paidBalance": "10.00" },
      { "type": "qq", "freeBalance": "2.00", "paidBalance": "20.00" }
    ],
    "linkedQqNumber": "123456"
  }
}
```

### web-frontend

需要改造页面：

- `GeneratePage`
  - 未绑定 QQ 不再阻止绘图。
  - 显示 `/wallet/status` 的聚合余额。
  - 已绑定 QQ 时可展开显示 Web / QQ 余额来源。

- `RechargePage`
  - 未绑定 QQ 也允许兑换卡密。
  - 文案改为“绑定 QQ 后可在 Bot 中共用余额”。
  - 兑换成功更新 user wallet 余额。

- `ProfilePage`
  - QQ 绑定区展示绑定关系，不再暗示余额只归 QQ。
  - 增加“解绑 QQ”确认文案，说明解绑不转移余额。
  - 展示当前 Web wallet 和已绑定 QQ wallet 的余额摘要。

- `BotsPage`
  - Bot owner 仍按 `my-bots` 判断。
  - Bot 绑定状态只表示“这个 Web 用户是否管理该 Bot”，不等于 QQ 绘图身份是否存在钱包。

### bot-service

QQ Bot 端需要支持未绑定 Web 账号的独立使用。

需要改造：

- 收到 QQ 用户绘图命令时，直接按 QQ 号请求 backend 创建或读取 qq wallet。
- 余额命令显示 QQ wallet；如果绑定 Web，则显示合计和来源。
- 卡密兑换命令直接充值到 QQ wallet。
- 绑定 Web 命令只创建 wallet_link，不迁移余额。
- 解绑 Web/QQ 命令如果开放，需要调用 backend 关闭 wallet_link。
- Bot 绘图结果卡片中的余额展示改为 wallet 聚合结果。

### wsproxy-service

wsproxy 只负责 OneBot 连接和在线状态，不直接处理余额。

需要确认：

- 不新增余额逻辑。
- 只保持 Bot owner 绑定、连接、断开、封禁等现有职责。
- Bot owner 和 QQ 绘图用户是两个概念，不能混用。

### drawing-service

drawing-service 不应承担余额职责。

需要确认：

- 接收任务时只使用 backend 已创建的任务。
- 不直接读取 wallet。
- 不直接扣费或退款。

可能需要同步类型：

- `DrawingGenerateRequest` 保留任务上下文即可。
- 如需审计，可透传 `chargeStatus` 或 `walletContextId`，但不参与计算。

### drawing-worker

drawing-worker 不应承担余额职责。

需要确认：

- 成功、失败、超时只回写任务状态。
- 失败退款仍由 backend 在状态变更时按 `task_charge_allocations` 执行。
- Worker 不直接操作 wallet。

### workflow-service

workflow-service 通过用户 JWT 调 backend `/api/generate`。

需要改造：

- 不直接扣费。
- Web 用户未绑定 QQ 时也允许运行工作流。
- 余额不足错误直接透传 backend。

### admin-portal

管理后台需要新增余额审计能力。

建议增加：

- Wallet 列表。
- Wallet identity/link 查询。
- 用户和 QQ 的余额来源展示。
- Wallet ledger 明细。
- 任务扣费分账明细。
- 管理员手动调整余额必须写 `wallet_ledger admin_adjust`。

### ops-worker

ops-worker 不直接扣费，但需要适配新的巡检对象。

建议增加：

- 检查 `task_charge_allocations` 中未退款但任务失败的异常。
- 检查 `wallet_ledger` 和 `wallets` 余额是否一致。
- 检查每日免费余额发放幂等。
- 保留当前 stale task 清理，但退款调用 backend 统一入口。

### packages/shared-contracts

新增跨程序类型前必须先登记到 `standards/interfaces/README.md`。

建议新增：

- `WalletBalanceView`
- `WalletSourceBalance`
- `WalletLinkView`
- `WalletChargeAllocation`
- `WalletLedgerEntry`
- `WalletStatusResponse`

### standards/interfaces

需要登记：

- Web 钱包状态接口。
- Bot 钱包状态接口。
- 充值响应中的 wallet 字段。
- 生成任务扣费响应中的 charge allocation 摘要。
- QQ 绑定/解绑响应中的 wallet link 状态。

## 迁移方案

### 阶段 1：只加表，不切流量

- 新增 wallet 相关表。
- 保留现有 `QqQuota`。
- 写迁移脚本创建 wallet。

### 阶段 2：迁移现有数据

迁移规则：

- 每条 `QqQuota` 创建一个 `ownerType=qq` 的 wallet。
- 已绑定 QQ 的 Web 用户创建 `ownerType=user` 的 user wallet，初始余额为 0。
- 为已绑定关系创建 active `wallet_link`。
- 未绑定 QQ 的 Web 用户创建 user wallet，初始余额为 0。
- 当前运行中的任务需要单独处理，建议迁移前暂停提交或只迁移成功/失败终态任务。

### 阶段 3：双写审计

- 旧 QqQuota 仍作为线上权威。
- 新 wallet 表同步写入，用于对账。
- 每日对比 QqQuota 与 qq wallet。

### 阶段 4：切换扣费权威

- Web `/api/generate` 改走 wallet。
- Bot `/internal/bot/generate` 改走 wallet。
- 退款改走 `task_charge_allocations`。
- QqQuota 冻结为只读兼容数据。

### 阶段 5：删除旧依赖

- 前端不再用 QQ 绑定作为 Web 绘图和充值前置条件。
- Bot 不再要求 QQ 绑定 Web 账号。
- 后端清理 QqQuota 直接扣费路径。

## 风险点

- 余额迁移必须可回滚，迁移前备份数据库。
- 运行中任务迁移最危险，建议短暂停止新建任务或对 running/finalizing 任务做专项脚本。
- 解绑后用户可能误解余额“少了”，前端必须展示 Web/QQ 来源。
- 绑定关系不能被反复用于刷每日免费余额，wallet 必须按身份持久存在。
- 退款必须只按扣费分账表，不能按当前绑定关系。

## 最小可实施切片

如果要分批落地，建议顺序：

1. 新增 wallet 表和只读 `/wallet/status`。
2. Web 用户未绑定 QQ 时创建 user wallet，但暂不允许绘图。
3. QQ 用户首次 Bot 命令时创建 qq wallet，但暂不改变扣费。
4. 接入充值到 user wallet / qq wallet。
5. 接入 Web 绘图 wallet 扣费。
6. 接入 Bot 绘图 wallet 扣费。
7. 接入绑定共享和解绑。
8. 清理旧 QqQuota 路径。
