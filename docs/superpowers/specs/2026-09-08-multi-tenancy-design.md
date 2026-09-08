# 多租户改造设计：账号、数据隔离、通道定向

日期：2026-09-08
状态：已评审通过，待拆实施计划

## 背景

PawPals 目前是一个**从骨子里假设只有一个人在用**的服务。不是"还没做登录页"——是整个进程没有用户这个概念。

盘点（全部经代码核对）：

> 行号为撰写时（2026-09-08）的值。`server.ts` 上有另一条并行的工作线在持续提交，行号会漂——**以符号名定位，不要依赖数字**。

| 证据 | 位置 |
|---|---|
| `userId` 在 server.ts 中出现 **0 次** | — |
| `CAREER_DIR` 被引用 **47 处**，底下 18 个数据文件/目录全局单份 | `CAREER_DIR`（server.ts:82） |
| **12 个模块级常量**在 import 时就由 `CAREER_DIR` 求值 | 见下表 |
| `io.emit`（广播给所有连接）**62 处**；`socket.emit`（定向）仅 4 处；socket.io 房间机制 **0 处** | server.ts |
| 现有"登录"是**一个全局 PIN**，不是账号；且 localhost 直接放行 | `_isAuthenticated`（server.ts:341） |
| 密码哈希是 `sha256("pawpals:" + pin)`——固定前缀、无 salt、快哈希 | `_hashPin`（server.ts:312） |
| 会话存在内存 `Map`，进程重启全员登出 | `_sessions`（server.ts:310） |
| 插件 `SERVER_BASE` **写死 `http://localhost:3000`**，云端根本连不上 | `extension/background/session-client.js:3` |
| 插件任务是 **`broadcast`**——推给所有在线扩展 | `server/official-socket.ts` |
| `llm.ts` 的 token 统计累加进一个全局对象 | `trackUsage`（llm.ts:47） |

**12 个模块级常量**（改造时必须从常量变成函数，否则 import 阶段就会抛错）：
`APPLICATIONS_FILE` `JOBS_FILE` `CONTACTS_FILE` `ONBOARDING_STATE_FILE` `COLLAB_BOARD_FILE`
`LAST_SEARCH_RESULTS_FILE` `MESSAGES_FILE` `RESUME_MASTER_FILE` `PROFILE_FILE`
`SKILLS_GAP_FILE` `REVIEWS_FILE` `EVENTS_FILE`

**进程级可变状态**（两个用户之间会直接串）：

| 变量 | 位置 | 串号后果 |
|---|---|---|
| `officialApplicationQueue` | server.ts:122 | A 的投递任务被 B 领走 |
| `activeOfficialApplicationPage` | server.ts:139 | A 打开的页面被当成 B 的投递目标 |
| `pendingResumableSearchTask` | server.ts:150 | 搜索任务串号 |
| `bossLoginPending` / `bossLoginPlatform` | server.ts:156-157 | A 触发登录，B 的桌面弹窗 |
| `pendingApplyCommands` | server.ts:171 | Map 用 `agent.id` 当键，两人同时找简历专家直接覆盖 |
| `messages` / `treeHolePosts` / `studyRoomUsers` | 启动闭包内 | 所有人同一个群聊 |

### 直接后果

把当前的 Railway 链接发给 200 个人，他们打开的是**同一份数据**：同一个群聊、同一份简历（后一个上传覆盖前一个）、同一份投递记录。而插件那条通道更严重——见"插件串号"一节。

## 目标与范围

**目标**：让服务能同时承载多个互不可见的用户，并且插件的自动投递不会打错人。

**本轮范围**：账号与会话、数据目录隔离、进程内状态容器、两条通道的定向（网页 socket.io + 插件 WebSocket）、插件配对、按用户额度、现有数据迁移。

**明确不在本轮**：邮箱验证、密码找回、数据导出与删除、计费、把考公/考研群接上真 agent。

## 插件串号：为什么它必须在本轮解决

插件不通过网页与服务端通信，它自己开一条 WebSocket。服务端把所有连上来的插件放进同一个集合，派任务时 `broadcast` 给全体。

任务分五类：`inspect` / `probe` / `upload` / `fill` / `submit`。**只有 `submit` 需要用户确认令牌**，前四类直接执行。

于是多用户下会发生：

1. 张三说「帮我投这个岗」→ `fill` 任务广播出去，payload 里装着张三的姓名、电话、学校、履历
2. **李四的浏览器自动打开该页面并把张三的信息填进去**——不需要李四做任何操作
3. 张三点确认 → `submit` 广播 → **可能由李四的浏览器执行**

结果：一份不可逆的工作申请，从李四的 IP、李四的浏览器、李四在该招聘站的登录态发出，内容是张三的简历。

这不是数据泄露的量级问题，是**代表用户做的不可逆对外动作打在了错的人身上**。因此本轮必须解决。

## 方案选型

考虑过三条路：

- **显式传参**：`userId` 一路往下传。TypeScript 能查漏，但 `streamAgent`、`runOrchestratedTurn`、`executePlan`、四个 workflow handler 全要加参数，签名雪崩。
- **每用户一个子进程**：进程内状态天然隔离，代码几乎不改。但 200 个 Node 进程在 Railway 上内存不现实。
- **请求上下文（AsyncLocalStorage）+ 每用户状态容器**（采纳）：把 `userId` 放进异步上下文，`careerDir()` / `emitTo()` 内部读取。100 多处调用点的写法几乎不变，改动收敛到三个可以单独测试的封装点。

采纳第三条。它唯一的风险是上下文隐式——对应的硬约束见"安全边界"。

## 设计

### 1. 身份与会话

**账号形态**：邮箱 + 密码。邮箱只作唯一账号名，**本轮不验证**（验证需要邮件服务，是新的外部依赖与成本）。

**密码存储**：改用 Node 内置 `crypto.scrypt`，每个用户独立随机 salt。不引入新依赖。现有的 `sha256("pawpals:" + pin)` 对单个 PIN 勉强够用，对 200 个真人密码不够——快哈希可高速离线爆破，且无 salt 意味着相同密码产生相同哈希。

**会话**：落盘持久化，7 天 TTL 不变。Railway 重新部署频繁，内存会话意味着每次部署全员登出。

**localhost 绕过**：删除 `_isAuthenticated` 中 `if (_isLocalhost(ip)) return true;` 这一分支，改为显式环境变量 `PAWPALS_DEV_NO_AUTH=1`，默认关闭。

**Cookie**：加 `HttpOnly`、`SameSite=Lax`，生产环境加 `Secure`。当前三者皆无。

**新增端点**（全部进 `AUTH_EXEMPT` 白名单）：

```
POST /api/auth/register   邮箱 + 密码 → 建用户目录、发会话 cookie
POST /api/auth/login      邮箱 + 密码 → 发会话 cookie
POST /api/auth/logout     作废会话
GET  /api/auth/me         当前用户（前端判断登录态）
```

登录失败沿用现有指数退避限流，键从 IP 改为 IP + 邮箱。

**两套认证互斥**：现有 PIN 那套保留给本地单人版，由 `PAWPALS_MULTI_USER=1` 切换。同一份代码同时服务两种部署。

### 2. 数据目录隔离

```ts
function careerDir(): string {
  const userId = currentUserId();
  if (!userId) throw new Error("careerDir() 在没有用户上下文时被调用");
  return path.join(APP_DATA_DIR, "users", userId, "career");
}
```

**单人模式是"只有一个用户 `local` 的多用户模式"**——`userId = "local"`，路径 `users/local/career`。`careerDir()` 内部没有模式分支，两种部署共用一条代码路径。

12 个模块级常量改成函数（`MESSAGES_FILE` → `messagesFile()`）。改成函数后所有旧用法都会编译报错，**编译通过即为改全**，靠 TypeScript 兜底而不是靠人眼。

### 3. 进程内状态容器

上表所列全部状态收进 `UserSession` 对象，由 `Map<userId, UserSession>` 持有，懒加载。

**加闲置卸载**：N 分钟无活动即从内存移除（数据在磁盘上，下次访问重新加载）。200 份消息数组常驻内存约 17MB 不是灾难，但没有卸载它只会单向增长。

### 4. 两条通道的定向

**网页（socket.io）**：62 处 `io.emit` 换成 `emitTo(event, payload)`，内部从异步上下文取 userId 并 `io.to(userId).emit(...)`。调用点写法几乎不变。socket 鉴权成功后 `socket.join(userId)`。

不做这一条，隔离做得再好也没用：A 的专业老师打的每个字都会实时出现在 B 的屏幕上。

**插件（WebSocket）**：

```
createTaskBroadcaster()
  Set<TaskClient>            →  Map<userId, Set<TaskClient>>
  add(client)                →  add(userId, client)
  broadcast(task): number    →  sendToUser(userId, task): number
```

**`sendToUser` 只发给该用户最近活跃的一条连接，不是全部。** 同一个人在两台电脑上都装了插件时，发给全部会导致两台同时执行同一次投递 = 重复提交。队列的租约机制与之配合：派给一条，租约期内不再派；该连接掉线则租约过期，改派另一条。

该用户没有插件在线时 `sendToUser` 返回 0，任务留在队列里等重连补发——现有逻辑不变。

### 5. 插件配对

两段式：短期配对码换长期 token。

1. 网页设置里点"连接插件"→ 服务端生成 **8 位配对码，5 分钟有效、一次性**
2. 插件侧边栏填服务器地址 + 配对码
3. `POST /api/extension/pair {code}` → 验证通过返回**长期 token（绑定 userId）**
4. 插件存进 `chrome.storage`（权限已有）
5. 连接时携带：`wss://<host>/ws/official?token=…`
6. 服务端握手验证 → 得到 userId → 记入该用户；验证失败直接关闭连接，不进集合

分两段的理由：配对码要短、能手输，因此必须短命；长期 token 要够随机、存在插件里不需人记。配对码即使被旁人看到，窗口也只有 5 分钟且一次性。

**可撤销**：网页设置里能解除绑定，作废该 token。

**服务器地址可配**：`SERVER_BASE` 改为读 `chrome.storage.local`，默认仍是 `http://localhost:3000`——本地单人版行为一字不变。现有的 `SERVER_BASE.replace(/^http/, 'ws')` 正好把 `https` 变成 `wss`，云端无需额外改动。manifest 不用动：`storage` 权限已有，`host_permissions` 已含 `https://*/*`。

### 6. 额度

`llm.ts` 的 `trackUsage`（:47）已存在，只是累加进全局对象。改为按用户记账：`llm.ts` 保持不知道用户，暴露一个 `onUsage` 钩子，由 `server.ts` 挂上，从异步上下文取当前用户。

**按 token 计，不按调用次数**。一次编排轮是 3 次调用，但一次可能 5 万 token、一次 8 千，按次数等于没计。配额存在用户目录，每日重置。

**超额判定在一轮开始时做一次，允许该轮跑完**。一轮编排是 3 次调用，若在第 2 次时中断，用户看到的是"专业老师说完了，简历专家说了一半，团团没了"。超一点余量比半截对话好。

### 7. 定时任务

7 个 `scheduleJob`：1 个每小时备份 + 6 个每日主动跑 agent（9/10/14/15/18/21 点）。

它们运行时没有用户上下文，多用户下 `careerDir()` 会抛错。**多用户模式下这 6 个默认关闭**；本地单人版不受影响。

理由是成本：6 × 200 = **每天 1200 次无人请求的 agent 运行**，全在项目方的 key 上，很可能超过全部交互式使用之和。

代价是丢掉"宠物主动找你"这个情感陪伴钩子。这是已知取舍，"用户可选开关"留作后续。

### 8. 迁移

首次以多用户模式启动时，把现有 `workspace/career/` 整体搬到 `users/local/career/`。幂等（搬过不再搬）。**原目录改名为 `career.migrated` 而非删除**，出错可手工回滚。

## 模块边界与测试

新建三个零依赖纯函数模块，照 `server/routing.ts` 的先例：

| 模块 | 关键断言 |
|---|---|
| `server/tenancy.ts` | **`careerDir()` 无用户上下文时必须抛错** —— 整套设计最关键的一条 |
| `server/auth.ts` | scrypt hash/verify round-trip；**相同密码 + 不同 salt 必须产生不同 hash**；会话签发/校验/过期 |
| `server/quota.ts` | 计数、每日重置、超额判定 |

`server/official-socket.test.ts` 已存在，追加两条：**发给 A 的任务不会到达 B**；**A 无插件在线时返回 0 且任务留在队列**。

**测不到的部分（诚实声明）**：AsyncLocalStorage 跨 await / setTimeout 的传播、socket 房间的实际定向、插件握手。这些是集成行为，纯函数够不着。靠一条端到端手动验证：开两个浏览器、注册两个账号，确认 A 发的消息 B 看不到、A 的简历 B 读不到、A 触发的 agent 不在 B 屏幕上打字、A 的投递任务不进 B 的插件。

## 安全边界（不可违反）

1. **`careerDir()` 拿不到 userId 一律抛错，永不回退全局目录。** 静默回退等于跨用户写入，是这套设计里唯一不能出的错。
2. **userId 只能来自会话**，绝不接受请求体或查询参数中传入的 userId。
3. **用户目录名用服务端生成的随机 id，不用邮箱**——避免路径穿越与邮箱泄露。
4. 上传文件名 sanitize，只落在该用户目录内。
5. 插件 WebSocket 握手验证失败即关闭连接，不加入任何集合。

## 验收

- 两个账号并存：A 发的消息 B 看不到；A 的简历 B 读不到；A 触发的 agent 不在 B 屏幕上打字
- A 的投递任务不会到达 B 的插件（`official-socket.test.ts` 断言 + 端到端手测）
- 同一用户两台电脑装插件时，一次投递只被一条连接执行
- `careerDir()` 在无上下文时抛错（单测）
- 现有单人数据迁移后功能不变
- 多用户模式下 6 个每日定时任务不运行
- 超额用户被拒绝新一轮对话，但进行中的一轮跑完
- `npm test` 通过；`npm run lint` 无新增类型错误
- 本地单人版（`PAWPALS_MULTI_USER` 未设）行为与改造前一致

## 不在本轮范围

- 邮箱验证、密码找回（都依赖邮件服务）
- 数据导出与删除
- 计费与付费档位
- 考公群 / 考研群接入真 agent
- 定时任务的"用户可选开关"

## 已知风险与未决问题

**成本尚未定量。** 项目方承担 API 费用并对每个用户限额，但**限额的具体数字尚未计算**。已知：今日实机一轮「帮我看看这个岗我合不合适」= 3 次模型调用，每次输入含 20 条不截断历史 + 3000 字简历 + 前序专家全文产出。

相关联的是 `2026-09-07-job-group-orchestration-design.md` 遗留的未决项：那次改造让每轮 token 较旧实现（6 条 × 300 字）上升数倍，当时留给项目方决定是否加上限。**该决定在多租户下乘以 200，必须在开放注册前完成**，否则第一周即可能打穿额度。

**本轮完成不等于可以开放。** 开放注册前另需确认：额度数字已定、200 份真实简历的存储位置与责任已明确、用户能自行删除数据（本轮不做，属后续）。
