# 多租户改造 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 让同一份服务能同时承载多个互不可见的用户，并且插件的自动投递永远不会打到别人的浏览器上。

**Architecture:** `userId` 放进 `AsyncLocalStorage`，`careerDir()` / `emitTo()` 内部读取它——100 多处调用点写法几乎不变，改动收敛到三个可单测的封装点（`server/tenancy.ts`、`server/auth.ts`、`server/official-socket.ts`）。进程级可变状态全部收进按用户懒加载的 `UserState` 容器。单人版是"只有一个用户 `local` 的多用户版"：两种部署共用一条代码路径，由 `PAWPALS_MULTI_USER=1` 切换认证方式和定时任务。

**Tech Stack:** TypeScript (ESM, `type: module`, 跑在 `tsx` 下)、Node 内置 `node:async_hooks` / `node:crypto`、vitest（`environment: jsdom`, `globals: false`）、Express 4、socket.io 4、ws 8、插件侧原生 ES 模块（Manifest V3，无构建步骤）。

**Spec:** `docs/superpowers/specs/2026-09-08-multi-tenancy-design.md`

## Global Constraints

- 相对导入必须带 `.ts` 后缀（`server/routing.test.ts` 即 `from "./routing.ts"`）。
- vitest 的 `globals: false`：每个测试文件都要 `import { describe, it, expect } from "vitest"`。
- vitest 的 `include` 是 `['extension/**/*.test.js', 'server/**/*.test.ts']`——新测试必须放在这两处才会被跑到。本计划不改这个配置。
- 新建的纯函数模块不得 import `server.ts`、`llm.ts` 或任何有副作用的模块（照 `server/routing.ts` 的先例）。文件系统、时钟、随机数一律通过参数注入。
- 注释和用户可见文案一律中文，与现有代码一致。
- 不引入新的 npm 依赖：密码哈希用 `node:crypto` 的 `scryptSync`，上下文用 `node:async_hooks`。
- **安全边界（不可违反）**：
  1. `careerDir()` 拿不到 userId 一律抛错，永不回退全局目录。
  2. userId 只能来自会话（cookie / 插件 token），绝不接受请求体或查询参数中的 userId。
  3. 用户目录名用服务端生成的随机 id，不用邮箱；id 只允许 `[A-Za-z0-9_-]{1,64}`。
  4. 上传文件名 sanitize，只落在该用户目录内。
  5. 插件 WebSocket 握手验证失败即关闭连接，不加入任何集合。
- **本地单人版（`PAWPALS_MULTI_USER` 未设）行为与改造前一致**——这是验收项，优先级高于设计稿里的个别措辞。因此：单人模式保留现有 PIN 认证与 localhost 放行；数据仍在原来的 `workspace/career`（或 `PAWPALS_WORKSPACE`）；6 个每日主动任务照常运行。多用户模式下才删除 localhost 放行、改用 `PAWPALS_DEV_NO_AUTH=1`。
- `server.ts` 里 62 处 `io.emit(` 与 47 处 `CAREER_DIR` 用 sed 批量替换，然后**以 `npm run lint` 通过为"改全"的判据**，不靠人眼。
- 每完成一个任务跑一次 `npm test` 与 `npm run lint`，两者都过才提交。

## 术语

- **单人模式**：`PAWPALS_MULTI_USER` 未设。唯一用户 id 为 `local`。
- **多用户模式**：`PAWPALS_MULTI_USER=1`。
- **用户上下文**：`AsyncLocalStorage` 里当前的 `userId`。

---

## File Structure

| 文件 | 责任 |
|---|---|
| `server/tenancy.ts`（新建） | 用户上下文（`runWithUser` / `currentUserId`）、`careerDir()` / `userDataDir()`、`emitTo()`、userId 合法性校验。零依赖。 |
| `server/tenancy.test.ts`（新建） | 上述纯函数单测。**`careerDir()` 无上下文必须抛错**是整套设计最关键的一条断言。 |
| `server/user-state.ts`（新建） | 通用的按用户懒加载状态容器 `createUserStateStore`，带闲置卸载。零依赖。 |
| `server/user-state.test.ts`（新建） | 懒加载、同一用户拿到同一实例、闲置卸载、活跃用户不卸载。 |
| `server/auth.ts`（新建） | scrypt 哈希/校验、用户档案存取、会话签发/校验/作废（落盘）。文件系统通过参数注入。 |
| `server/auth.test.ts`（新建） | round-trip；**相同密码不同 salt 必须不同 hash**；会话过期；邮箱归一化。 |
| `server/auth-page.ts`（新建） | 多用户模式下 401 时返回的登录/注册 HTML 字符串。 |
| `server/pairing.ts`（新建） | 插件配对：8 位配对码（5 分钟、一次性）换长期 token；token 落盘、可撤销。 |
| `server/pairing.test.ts`（新建） | 配对码只能用一次、过期作废、token 解析、撤销后失效。 |
| `server/quota.ts`（新建） | 按用户按天的 token 计数与超额判定。 |
| `server/quota.test.ts`（新建） | 累计、跨天重置、超额判定、未设上限时永不超额。 |
| `server/migration.ts`（新建） | 首次多用户启动时把 `workspace/career` 搬到 `users/local/career`，幂等，原目录改名保留。 |
| `server/migration.test.ts`（新建） | 用临时目录验证：搬迁、幂等、原目录改名。 |
| `server/official-socket.ts`（修改） | `Set<TaskClient>` → `Map<userId, Set<TaskClient>>`；`broadcast` → `sendToUser`（只发最近活跃的一条）。 |
| `server/official-socket.test.ts`（修改） | 追加：A 的任务不到 B；A 无插件时返回 0；同一用户两条连接只发一条。 |
| `server/official-routes.ts`（修改） | 队列与 hub 改成按当前用户取。 |
| `llm.ts`（修改） | 暴露 `setUsageHook`，`trackUsage` 调用它。llm.ts 仍不知道用户。 |
| `server.ts`（修改） | 常量改函数；状态收进容器；auth 端点；socket 鉴权与房间；插件握手；定时任务开关；迁移。 |
| `extension/background/session-client.js`（修改） | `SERVER_BASE` 改为从 `chrome.storage.local` 读，默认不变。 |
| `extension/background/official-task-client.js`（修改） | `base` 允许传函数（惰性读配置）。 |
| `extension/background/service-worker.js`（修改） | 连接 URL 带 token；收到 `RECONNECT` 消息时重连。 |
| `extension/sidepanel/pairing.js`（新建） | 配对表单解析与请求，纯逻辑。 |
| `extension/sidepanel/pairing.test.js`（新建） | 表单校验、请求形状、错误文案。 |
| `extension/sidepanel/panel.html` / `panel.js`（修改） | 加"连接服务器"区块。 |
| `src/App.tsx`（修改） | 个人设置里加"连接插件"（生成配对码、解除绑定）与"退出登录"。 |

---

### Task 1: 用户上下文与数据目录（`server/tenancy.ts`）

**Files:**
- Create: `server/tenancy.ts`
- Test: `server/tenancy.test.ts`

**Interfaces:**
- Consumes: 无
- Produces:
  - `LOCAL_USER_ID = "local"`
  - `isValidUserId(id: unknown): id is string` —— `[A-Za-z0-9_-]{1,64}`
  - `initTenancy(opts: { dataRoot: string; localCareerDir?: string }): void`
  - `runWithUser<T>(userId: string, fn: () => T): T`
  - `currentUserId(): string | null`
  - `userDataDir(): string` —— 无上下文抛错
  - `careerDir(): string` —— 无上下文抛错
  - `setEmitter(io: { to(room: string): { emit(event: string, ...args: any[]): any } } | null): void`
  - `emitTo(event: string, ...args: any[]): boolean` —— 无上下文不发、返回 false

- [ ] **Step 1: 写失败的测试**

创建 `server/tenancy.test.ts`：

```ts
import { describe, it, expect, vi } from "vitest";
import {
  LOCAL_USER_ID, isValidUserId, initTenancy, runWithUser, currentUserId,
  userDataDir, careerDir, setEmitter, emitTo,
} from "./tenancy.ts";

describe("isValidUserId", () => {
  it("只接受 [A-Za-z0-9_-]{1,64}——目录名不能带路径穿越", () => {
    expect(isValidUserId("local")).toBe(true);
    expect(isValidUserId("a1b2c3d4e5f6a1b2c3d4e5f6")).toBe(true);
    expect(isValidUserId("../etc")).toBe(false);
    expect(isValidUserId("a/b")).toBe(false);
    expect(isValidUserId("")).toBe(false);
    expect(isValidUserId("x".repeat(65))).toBe(false);
    expect(isValidUserId(null)).toBe(false);
  });
});

describe("careerDir", () => {
  it("没有用户上下文时必须抛错，永不回退全局目录", () => {
    initTenancy({ dataRoot: "/data" });
    expect(() => careerDir()).toThrow(/用户上下文/);
    expect(() => userDataDir()).toThrow(/用户上下文/);
  });

  it("上下文里返回 users/<id>/career", () => {
    initTenancy({ dataRoot: "/data" });
    runWithUser("u1", () => {
      expect(userDataDir()).toBe("/data/users/u1");
      expect(careerDir()).toBe("/data/users/u1/career");
    });
  });

  it("local 用户配了 localCareerDir 时用它——单人版数据位置一字不变", () => {
    initTenancy({ dataRoot: "/data", localCareerDir: "/data/workspace/career" });
    runWithUser(LOCAL_USER_ID, () => {
      expect(careerDir()).toBe("/data/workspace/career");
      // 用户级文件（如 pet.json）仍在 dataRoot 下，与改造前一致
      expect(userDataDir()).toBe("/data");
    });
    // 其他用户不受 localCareerDir 影响
    runWithUser("u2", () => expect(careerDir()).toBe("/data/users/u2/career"));
  });

  it("非法 userId 进了上下文也要抛错——最后一道闸", () => {
    initTenancy({ dataRoot: "/data" });
    expect(() => runWithUser("../x", () => careerDir())).toThrow();
  });

  it("上下文跨 await 传播", async () => {
    initTenancy({ dataRoot: "/data" });
    const seen = await runWithUser("u3", async () => {
      await new Promise((r) => setTimeout(r, 1));
      return currentUserId();
    });
    expect(seen).toBe("u3");
    expect(currentUserId()).toBeNull();
  });

  it("嵌套时内层覆盖外层，退出后恢复", () => {
    initTenancy({ dataRoot: "/data" });
    runWithUser("outer", () => {
      runWithUser("inner", () => expect(currentUserId()).toBe("inner"));
      expect(currentUserId()).toBe("outer");
    });
  });
});

describe("emitTo", () => {
  it("在上下文里只发给该用户的房间", () => {
    const emit = vi.fn();
    const to = vi.fn(() => ({ emit }));
    setEmitter({ to });
    const ok = runWithUser("u1", () => emitTo("receive_message", { id: 1 }));
    expect(ok).toBe(true);
    expect(to).toHaveBeenCalledWith("u1");
    expect(emit).toHaveBeenCalledWith("receive_message", { id: 1 });
  });

  it("没有上下文时不发任何东西——宁可丢也不能广播给所有人", () => {
    const emit = vi.fn();
    setEmitter({ to: () => ({ emit }) });
    expect(emitTo("receive_message", {})).toBe(false);
    expect(emit).not.toHaveBeenCalled();
  });

  it("emitter 没装上时返回 false 不抛错", () => {
    setEmitter(null);
    expect(runWithUser("u1", () => emitTo("x"))).toBe(false);
  });
});
```

- [ ] **Step 2: 跑测试确认失败**

Run: `npx vitest run server/tenancy.test.ts`
Expected: FAIL，报 `Cannot find module './tenancy.ts'`

- [ ] **Step 3: 写实现**

创建 `server/tenancy.ts`：

```ts
/**
 * 用户上下文与数据目录。
 *
 * 整个进程原本假设只有一个人在用：CAREER_DIR 是模块级常量，io.emit 广播给所有
 * 连接。改成多用户时不想把 userId 一路传 100 多个调用点，所以放进
 * AsyncLocalStorage：careerDir() / emitTo() 内部读取，调用点写法几乎不变。
 *
 * 代价是上下文隐式——所以这里有一条不可违反的规矩：
 * **拿不到 userId 一律抛错，永不回退全局目录。** 静默回退等于跨用户写入。
 */
import { AsyncLocalStorage } from "node:async_hooks";
import path from "node:path";

export const LOCAL_USER_ID = "local";

const USER_ID_RE = /^[A-Za-z0-9_-]{1,64}$/;

/** 目录名直接来自 userId，所以这里就是路径穿越的最后一道闸。 */
export function isValidUserId(id: unknown): id is string {
  return typeof id === "string" && USER_ID_RE.test(id);
}

const als = new AsyncLocalStorage<{ userId: string }>();

let dataRoot: string | null = null;
let localCareerDir: string | undefined;

/**
 * @param dataRoot        APP_DATA_DIR
 * @param localCareerDir  单人模式下 local 用户的 career 目录（即改造前的 CAREER_DIR）。
 *                        多用户模式不传，local 用户和其他人一样住在 users/local/career。
 */
export function initTenancy(opts: { dataRoot: string; localCareerDir?: string }): void {
  dataRoot = opts.dataRoot;
  localCareerDir = opts.localCareerDir;
}

export function runWithUser<T>(userId: string, fn: () => T): T {
  return als.run({ userId }, fn);
}

export function currentUserId(): string | null {
  return als.getStore()?.userId ?? null;
}

function requireUserId(): string {
  const userId = currentUserId();
  if (!userId) throw new Error("careerDir() 在没有用户上下文时被调用");
  if (!isValidUserId(userId)) throw new Error(`非法的 userId：${JSON.stringify(userId)}`);
  if (!dataRoot) throw new Error("initTenancy() 还没调用");
  return userId;
}

/** 用户级目录：pet.json、quota.json 之类不属于 career 的文件放这里。 */
export function userDataDir(): string {
  const userId = requireUserId();
  // 单人模式的 local 用户：用户级文件仍在 dataRoot 根下，与改造前一致
  if (userId === LOCAL_USER_ID && localCareerDir) return dataRoot!;
  return path.join(dataRoot!, "users", userId);
}

export function careerDir(): string {
  const userId = requireUserId();
  if (userId === LOCAL_USER_ID && localCareerDir) return localCareerDir;
  return path.join(dataRoot!, "users", userId, "career");
}

// ── 定向推送 ──────────────────────────────────────────────────────────

type Emitter = { to(room: string): { emit(event: string, ...args: any[]): any } };
let emitter: Emitter | null = null;

export function setEmitter(io: Emitter | null): void {
  emitter = io;
}

/**
 * 替代 io.emit：只发给当前用户的房间。
 *
 * 没有上下文时**不发**并返回 false。这里不抛错——它常在 setInterval 里被调用，
 * 抛了会把进程带下去；但也绝不能退化成广播。
 */
export function emitTo(event: string, ...args: any[]): boolean {
  const userId = currentUserId();
  if (!userId || !emitter) {
    if (!userId) console.warn(`[tenancy] emitTo("${event}") 没有用户上下文，已丢弃`);
    return false;
  }
  emitter.to(userId).emit(event, ...args);
  return true;
}
```

- [ ] **Step 4: 跑测试确认通过**

Run: `npx vitest run server/tenancy.test.ts`
Expected: PASS（11 tests）

- [ ] **Step 5: 提交**

```bash
git add server/tenancy.ts server/tenancy.test.ts
git commit -m "feat(tenancy): 用户上下文与 careerDir()——拿不到 userId 一律抛错，永不回退全局目录"
```

---

### Task 2: 常量改函数——`server.ts` 里的 `CAREER_DIR` 与 13 个文件常量

本任务只做机械替换并让单人模式跑起来。多用户模式的认证等在后面任务。

**Files:**
- Modify: `server.ts:81-97`（常量声明）、`server.ts:682-683,727-728,1730,1830`（6 个晚声明的常量）、全文 `CAREER_DIR` 47 处、`PET_FILE` 7 处
- Modify: `server.ts` 末尾 `startServer();`

**Interfaces:**
- Consumes: Task 1 的 `initTenancy` / `runWithUser` / `careerDir` / `userDataDir` / `LOCAL_USER_ID`
- Produces: `server.ts` 内的 `applicationsFile()` `jobsFile()` `contactsFile()` `onboardingStateFile()` `collabBoardFile()` `lastSearchResultsFile()` `messagesFile()` `resumeMasterFile()` `profileFile()` `skillsGapFile()` `reviewsFile()` `eventsFile()` `petFile()`；模块级 `const MULTI_USER: boolean`

- [ ] **Step 1: 加 import 与模式常量**

在 `server.ts` 的 import 区（`import { runToolLoop } ...` 之后）加：

```ts
import { LOCAL_USER_ID, initTenancy, runWithUser, currentUserId, careerDir, userDataDir, setEmitter, emitTo } from "./server/tenancy.ts";
```

在 `dotenv.config();` 之后加：

```ts
/** 多用户模式。未设时是本地单人版：唯一用户 local，行为与改造前一致。 */
const MULTI_USER = process.env.PAWPALS_MULTI_USER === "1";
```

- [ ] **Step 2: 常量声明改成函数**

把 `server.ts:81-92` 这一段：

```ts
const APP_DATA_DIR = resolveAppDataDir();
const WORKSPACE_DIR = path.join(APP_DATA_DIR, "workspace");
const CAREER_DIR = process.env.PAWPALS_WORKSPACE || path.join(WORKSPACE_DIR, "career");
const COOKIE_DIR = ...
const APPLICATIONS_FILE = path.join(CAREER_DIR, "applications.json");
const JOBS_FILE = path.join(CAREER_DIR, "jobs.json");
const CONTACTS_FILE = path.join(CAREER_DIR, "contacts.json");
const PET_FILE = path.join(APP_DATA_DIR, "pet.json");
const ONBOARDING_STATE_FILE = path.join(CAREER_DIR, "onboarding_state.json");
const COLLAB_BOARD_FILE = path.join(CAREER_DIR, "collaboration_board.json");
const LAST_SEARCH_RESULTS_FILE = path.join(CAREER_DIR, "last_search_results.json");
```

改成：

```ts
const APP_DATA_DIR = resolveAppDataDir();
const WORKSPACE_DIR = path.join(APP_DATA_DIR, "workspace");
/** 改造前的 CAREER_DIR。单人模式下 local 用户仍用它；多用户模式下迁移到 users/local/career。 */
const LEGACY_CAREER_DIR = process.env.PAWPALS_WORKSPACE || path.join(WORKSPACE_DIR, "career");
initTenancy({ dataRoot: APP_DATA_DIR, localCareerDir: MULTI_USER ? undefined : LEGACY_CAREER_DIR });
const COOKIE_DIR = ...（不动）
/**
 * 数据文件路径全部改成函数：路径取决于当前用户，import 阶段没有用户。
 * 改成函数后旧写法全部编译报错——编译通过即为改全。
 */
const applicationsFile = () => path.join(careerDir(), "applications.json");
const jobsFile = () => path.join(careerDir(), "jobs.json");
const contactsFile = () => path.join(careerDir(), "contacts.json");
const petFile = () => path.join(userDataDir(), "pet.json");
const onboardingStateFile = () => path.join(careerDir(), "onboarding_state.json");
const collabBoardFile = () => path.join(careerDir(), "collaboration_board.json");
const lastSearchResultsFile = () => path.join(careerDir(), "last_search_results.json");
```

同样处理晚声明的 6 个：

```ts
// server.ts:682-683
const messagesFile = () => path.join(careerDir(), "pawpals_messages.json");
const resumeMasterFile = () => path.join(careerDir(), "resume_master.md");
// server.ts:727-728
const profileFile = () => path.join(careerDir(), "profile.md");
const skillsGapFile = () => path.join(careerDir(), "skills_gap.md");
// server.ts:1730
const reviewsFile = () => path.join(careerDir(), "reviews.jsonl");
// server.ts:1830
const eventsFile = () => path.join(careerDir(), "events.jsonl");
```

- [ ] **Step 3: 批量替换引用**

```bash
cd "/Users/dengyudie/Downloads/萌爪伴学-(pawpals)"
sed -i '' \
  -e 's/\bCAREER_DIR\b/careerDir()/g' \
  -e 's/\bAPPLICATIONS_FILE\b/applicationsFile()/g' \
  -e 's/\bJOBS_FILE\b/jobsFile()/g' \
  -e 's/\bCONTACTS_FILE\b/contactsFile()/g' \
  -e 's/\bPET_FILE\b/petFile()/g' \
  -e 's/\bONBOARDING_STATE_FILE\b/onboardingStateFile()/g' \
  -e 's/\bCOLLAB_BOARD_FILE\b/collabBoardFile()/g' \
  -e 's/\bLAST_SEARCH_RESULTS_FILE\b/lastSearchResultsFile()/g' \
  -e 's/\bMESSAGES_FILE\b/messagesFile()/g' \
  -e 's/\bRESUME_MASTER_FILE\b/resumeMasterFile()/g' \
  -e 's/\bPROFILE_FILE\b/profileFile()/g' \
  -e 's/\bSKILLS_GAP_FILE\b/skillsGapFile()/g' \
  -e 's/\bREVIEWS_FILE\b/reviewsFile()/g' \
  -e 's/\bEVENTS_FILE\b/eventsFile()/g' \
  server.ts
grep -n "careerDir() = \|const [a-zA-Z]*File() = " server.ts
```

最后那条 grep 用来抓 sed 把函数**定义行**也替换了的情况（例如 `const careerDir() = ...`）。Step 2 里的定义如果被替换，手工改回。注释里的 `CAREER_DIR` 被替换成 `careerDir()` 无妨。

macOS 自带的 sed 不支持 `\b`。如果上面的命令没有替换任何内容，换成 `perl -pi -e 's/\bCAREER_DIR\b/careerDir()/g; ...' server.ts`（同样的 14 条规则，用 `;` 连接）。

- [ ] **Step 4: 让单人模式带着上下文启动**

`server.ts` 最后一行 `startServer();` 改为：

```ts
/**
 * 单人模式：整个服务跑在 local 用户的上下文里。startServer() 里创建的
 * setInterval、scheduleJob、闭包都会继承它，所以启动期读写 careerDir() 的代码
 * 不用改。多用户模式没有"启动期的用户"——所有访问都必须来自请求，见后续任务。
 */
if (MULTI_USER) startServer();
else runWithUser(LOCAL_USER_ID, () => startServer());
```

`server.ts:181,303,352` 三个模块级 `setInterval` 不读 careerDir，不用动。

- [ ] **Step 5: 编译，按报错逐个修**

Run: `npm run lint`
Expected: 0 错误。若报 `Cannot find name 'CAREER_DIR'` 之类，说明 Step 3 的替换漏了（大概率是 `\b` 没生效），按报错行修。

- [ ] **Step 6: 跑全量测试与手动冒烟**

Run: `npm test`
Expected: 全部通过（这一步没动任何测试文件，通过说明没破坏被测模块）。

手动冒烟（单人模式）：

```bash
npm run dev
```

打开 `http://localhost:3000`，在求职群发一句"你好"，确认：有回复；服务端日志没有"用户上下文"字样的报错；`~/Library/Application Support/PawPals/workspace/career/pawpals_messages.json` 被更新（数据位置没变）。

- [ ] **Step 7: 提交**

```bash
git add server.ts
git commit -m "refactor(server): 数据文件路径从常量改成函数——路径取决于当前用户，import 阶段没有用户"
```

---

### Task 3: 按用户的状态容器（`server/user-state.ts`）

**Files:**
- Create: `server/user-state.ts`
- Test: `server/user-state.test.ts`

**Interfaces:**
- Consumes: 无
- Produces:
  - `createUserStateStore<T>(opts: { create: (userId: string) => T; idleMs: number; now?: () => number }): UserStateStore<T>`
  - `UserStateStore<T>`: `get(userId): T`（懒加载并记活跃）、`touch(userId): void`、`has(userId): boolean`、`evictIdle(isActive?: (userId) => boolean): string[]`（返回被卸载的 id）、`size(): number`

- [ ] **Step 1: 写失败的测试**

创建 `server/user-state.test.ts`：

```ts
import { describe, it, expect, vi } from "vitest";
import { createUserStateStore } from "./user-state.ts";

describe("createUserStateStore", () => {
  it("第一次 get 时才创建，同一用户拿到同一实例", () => {
    const create = vi.fn((id: string) => ({ id, items: [] as string[] }));
    const store = createUserStateStore({ create, idleMs: 1000 });
    expect(create).not.toHaveBeenCalled();
    const a1 = store.get("a");
    const a2 = store.get("a");
    expect(a1).toBe(a2);
    expect(create).toHaveBeenCalledTimes(1);
    expect(create).toHaveBeenCalledWith("a");
  });

  it("不同用户互不可见", () => {
    const store = createUserStateStore({ create: () => ({ items: [] as string[] }), idleMs: 1000 });
    store.get("a").items.push("x");
    expect(store.get("b").items).toEqual([]);
  });

  it("闲置超过 idleMs 的被卸载，下次 get 重新创建", () => {
    let t = 0;
    const create = vi.fn((id: string) => ({ id }));
    const store = createUserStateStore({ create, idleMs: 100, now: () => t });
    store.get("a");
    t = 50; store.get("b");
    t = 120;
    expect(store.evictIdle()).toEqual(["a"]);
    expect(store.has("a")).toBe(false);
    expect(store.has("b")).toBe(true);
    store.get("a");
    expect(create).toHaveBeenCalledTimes(3);
  });

  it("touch 刷新活跃时间", () => {
    let t = 0;
    const store = createUserStateStore({ create: (id) => ({ id }), idleMs: 100, now: () => t });
    store.get("a");
    t = 90; store.touch("a");
    t = 150;
    expect(store.evictIdle()).toEqual([]);
  });

  it("isActive 返回 true 的用户即使闲置也不卸载——有连接挂着时不能换掉它手里的数组", () => {
    let t = 0;
    const store = createUserStateStore({ create: (id) => ({ id }), idleMs: 100, now: () => t });
    store.get("a"); store.get("b");
    t = 500;
    expect(store.evictIdle((id) => id === "a")).toEqual(["b"]);
    expect(store.size()).toBe(1);
  });
});
```

- [ ] **Step 2: 跑测试确认失败**

Run: `npx vitest run server/user-state.test.ts`
Expected: FAIL，`Cannot find module './user-state.ts'`

- [ ] **Step 3: 写实现**

创建 `server/user-state.ts`：

```ts
/**
 * 按用户的进程内状态容器。
 *
 * 改造前 officialApplicationQueue、bossLoginPending、messages 这些都是模块级或
 * startServer() 闭包里的单份变量——两个用户会直接串：A 的投递任务被 B 领走，
 * A 触发登录弹的是 B 的桌面窗口。全部收进这里，按 userId 懒加载。
 *
 * 闲置卸载：数据都在磁盘上，内存里的只是缓存。不卸载它只会单向增长。
 * 但**有连接挂着的用户不能卸**——socket 连接闭包里持有 messages 数组的引用，
 * 卸了再建就成了两份数组。由调用方通过 isActive 告诉我们谁还连着。
 */
export type UserStateStore<T> = {
  get(userId: string): T;
  touch(userId: string): void;
  has(userId: string): boolean;
  evictIdle(isActive?: (userId: string) => boolean): string[];
  size(): number;
};

export function createUserStateStore<T>(opts: {
  create: (userId: string) => T;
  idleMs: number;
  now?: () => number;
}): UserStateStore<T> {
  const now = opts.now ?? (() => Date.now());
  const entries = new Map<string, { state: T; lastActiveAt: number }>();

  return {
    get(userId) {
      let entry = entries.get(userId);
      if (!entry) {
        entry = { state: opts.create(userId), lastActiveAt: now() };
        entries.set(userId, entry);
      } else {
        entry.lastActiveAt = now();
      }
      return entry.state;
    },
    touch(userId) {
      const entry = entries.get(userId);
      if (entry) entry.lastActiveAt = now();
    },
    has(userId) { return entries.has(userId); },
    evictIdle(isActive = () => false) {
      const cutoff = now() - opts.idleMs;
      const evicted: string[] = [];
      for (const [userId, entry] of entries) {
        if (entry.lastActiveAt > cutoff) continue;
        if (isActive(userId)) continue;
        entries.delete(userId);
        evicted.push(userId);
      }
      return evicted;
    },
    size() { return entries.size; },
  };
}
```

- [ ] **Step 4: 跑测试确认通过**

Run: `npx vitest run server/user-state.test.ts`
Expected: PASS（5 tests）

- [ ] **Step 5: 提交**

```bash
git add server/user-state.ts server/user-state.test.ts
git commit -m "feat(user-state): 按用户懒加载的状态容器，带闲置卸载"
```

---

### Task 4: 把 `server.ts` 的进程级状态收进容器

**Files:**
- Modify: `server.ts:123-176`（模块级状态声明）、`server.ts:4812-4816`（startServer 闭包里的 messages / studyRoomUsers / treeHolePosts）、`server.ts:4830` 附近的 `posts`
- Modify: `server/official-routes.ts:17-30`（deps 改成 getter）

**Interfaces:**
- Consumes: Task 3 的 `createUserStateStore`；Task 1 的 `currentUserId` / `runWithUser`
- Produces（`server.ts` 内）:
  - `type UserState = { messages: any[]; studyRoomUsers: any[]; treeHolePosts: any[]; posts: any[]; officialQueue: OfficialApplicationQueue; activeOfficialApplicationPage: {...} | null; pendingResumableSearchTask: {...} | null; bossLoginPending: boolean; bossLoginPlatform: string; lastAskedProfileLabels: string[]; pendingApplyCommands: Map<...>; pendingWorkflowSelections: Map<...> }`
  - `const userStates: UserStateStore<UserState>`
  - `function state(): UserState` —— 取当前用户的状态，无上下文抛错
  - `OfficialRouteDeps.queue` 变成 `() => OfficialApplicationQueue`

- [ ] **Step 1: 定义 UserState 与 store**

在 `server.ts` 的 import 区加：

```ts
import { createUserStateStore, type UserStateStore } from "./server/user-state.ts";
```

把 `server.ts:123-176` 里这些声明**删掉**：`const officialApplicationQueue = new OfficialApplicationQueue();`、`let activeOfficialApplicationPage ...`、`let pendingResumableSearchTask ...`、`let bossLoginPending ...`、`let bossLoginPlatform ...`、`let lastAskedProfileLabels ...`、`const pendingApplyCommands = new Map ...`、`const pendingWorkflowSelections = new Map ...`。（`officialTaskHub`、`pendingApplyQueue`、`applyResultStore`、`pendingBrowserFetchQueue` 保留：hub 在 Task 7 按用户分；后三个是 Electron 桌面端专用，多用户模式不启用 Electron。）

在原位置写：

```ts
/**
 * 每个用户自己的一份进程内状态。
 *
 * 改造前这些全是模块级单份变量，两个用户之间会直接串（A 的投递任务被 B 领走）。
 * 现在按用户懒加载；messages 等闭包变量也从 startServer() 里搬到这。
 */
type UserState = {
  messages: any[];
  studyRoomUsers: any[];
  treeHolePosts: any[];
  posts: any[];
  officialQueue: OfficialApplicationQueue;
  activeOfficialApplicationPage: { url: string; title: string; provider: string; seenAt: number } | null;
  pendingResumableSearchTask: null | { query: string; location: string; cityText: string; channels: string[] };
  bossLoginPending: boolean;
  bossLoginPlatform: string;
  lastAskedProfileLabels: string[];
  pendingApplyCommands: Map<string, { url: string; company: string; title: string; timestamp: number; officialConfirmationId?: string }>;
  pendingWorkflowSelections: Map<string, { rowIds: string[]; timestamp: number }>;
};

/** 30 分钟无活动即卸载；有 socket 或插件连接的用户不卸（见 startServer 里的 evict 定时器）。 */
const USER_STATE_IDLE_MS = 30 * 60 * 1000;

const userStates: UserStateStore<UserState> = createUserStateStore<UserState>({
  idleMs: USER_STATE_IDLE_MS,
  // create 在 get(userId) 时被调用，而 get 只在用户上下文里调用，所以这里的
  // loadMessages() 读的是该用户自己的文件。
  create: (userId) => runWithUser(userId, () => ({
    messages: (() => { const saved = loadMessages(); return saved.length > 0 ? saved : defaultMessagesFor(); })(),
    studyRoomUsers: [],
    treeHolePosts: [
      { id: "t1", content: "今天面试又挂了，感觉好挫败... 呜呜", timestamp: new Date().toISOString(), replies: [{ author: "抱抱助手汪", content: "汪呜！不哭不哭，失败是成功的麻麻，抱抱你！给你一张虚拟抱抱券 🎟️", avatar: "https://api.dicebear.com/7.x/adventurer/svg?seed=HugDog" }] },
    ],
    posts: defaultPostsFor(),
    officialQueue: new OfficialApplicationQueue(),
    activeOfficialApplicationPage: null,
    pendingResumableSearchTask: null,
    bossLoginPending: false,
    bossLoginPlatform: "boss",
    lastAskedProfileLabels: [],
    pendingApplyCommands: new Map(),
    pendingWorkflowSelections: new Map(),
  })),
});

function state(): UserState {
  const userId = currentUserId();
  if (!userId) throw new Error("state() 在没有用户上下文时被调用");
  return userStates.get(userId);
}
```

`defaultMessagesFor()` / `defaultPostsFor()`：把 `startServer()` 里 `const defaultMessages = [...]`（`server.ts:4812` 之前那段数组）和 `const posts: any[] = [...]`（`server.ts:4830` 附近）的字面量**原样搬**成两个模块级函数，每次调用返回新数组（它们含 `new Date().toISOString()`，必须每个用户各自求值）：

```ts
function defaultMessagesFor(): any[] { return [ /* 原 defaultMessages 数组字面量 */ ]; }
function defaultPostsFor(): any[] { return [ /* 原 posts 数组字面量 */ ]; }
```

注意 `loadMessages` 与 `messagesFile` 定义在 `server.ts:682` / `1698`，而 `userStates` 在 123 行——TypeScript 的函数声明会提升，箭头函数常量 `messagesFile` 不会。但 `create` 只在运行期 `get()` 时调用，届时模块已加载完，没有 TDZ 问题。

- [ ] **Step 2: 删闭包变量，按编译报错逐个改**

在 `startServer()` 里删掉：`const defaultMessages = [...]`、`const savedMessages = loadMessages();`、`const messages: any[] = ...`、`const studyRoomUsers: any[] = [];`、`const treeHolePosts: any[] = [...]`、`const posts: any[] = [...]`。

Run: `npm run lint`

每条 `Cannot find name 'X'` 按下面规则改：

| 报错的名字 | 改法 |
|---|---|
| `messages` / `studyRoomUsers` / `treeHolePosts` / `posts` 出现在 `io.on("connection", ...)` 闭包内 | 在该闭包最顶部（`console.log("User connected"...)` 之后）加一行 `const { messages, studyRoomUsers, treeHolePosts, posts } = state();`，闭包内其余引用不动。本任务只验证单人模式：startServer 已跑在 local 上下文里（Task 2 Step 4），连接闭包继承它，`state()` 有值。Task 6 会把这段包进按连接的 `runWithUser(userId, ...)`。 |
| 同上，出现在 HTTP 路由处理函数内 | 改成 `state().messages` 等 |
| 同上，出现在 `proactivePost` / `startMailWatcher(io, messages)` / 2 分钟宠物定时器 | 改成 `state().messages`（单人模式有上下文；多用户模式这些在 Task 9 被关掉） |
| `officialApplicationQueue` | 改成 `state().officialQueue` |
| `activeOfficialApplicationPage` / `pendingResumableSearchTask` / `bossLoginPending` / `bossLoginPlatform` / `lastAskedProfileLabels` | 读改成 `state().x`，赋值改成 `state().x = ...` |
| `pendingApplyCommands` / `pendingWorkflowSelections` | 改成 `state().pendingApplyCommands` 等 |

`server.ts:181` 那个清理过期 `pendingApplyCommands` 的模块级 `setInterval` 没有用户上下文，改成遍历不了——**删掉它**，把清理逻辑挪到每次读 `state().pendingApplyCommands` 前（在 `send_message` 处理里读它的那处，先执行一遍"删掉超过 10 分钟的条目"）。

`registerOfficialRoutes` 的调用改为：

```ts
registerOfficialRoutes({
  app,
  queue: () => state().officialQueue,
  hub: officialTaskHub,
  enqueueOfficialTask,
  parseRequestedKind,
  setActivePage: (page) => { state().activeOfficialApplicationPage = page; },
  log: (line) => console.log(line),
});
```

`server/official-routes.ts` 对应改：`queue: () => OfficialApplicationQueue;`，函数体第一行的解构去掉 `queue: officialApplicationQueue`，然后：

```bash
perl -pi -e 's/\bofficialApplicationQueue\./deps.queue()./g' server/official-routes.ts
```

- [ ] **Step 3: 编译通过、测试通过**

Run: `npm run lint && npm test`
Expected: 都过。

- [ ] **Step 4: 手动冒烟（单人模式）**

```bash
npm run dev
```

发消息有回复；刷新页面后历史还在；服务端日志无"用户上下文"报错。

- [ ] **Step 5: 提交**

```bash
git add server.ts server/official-routes.ts
git commit -m "refactor(server): 进程级可变状态全部收进按用户的 UserState——两个用户不再共用一份队列和消息"
```

---

### Task 5: 账号与会话（`server/auth.ts`）

**Files:**
- Create: `server/auth.ts`
- Test: `server/auth.test.ts`

**Interfaces:**
- Consumes: 无
- Produces:
  - `hashPassword(password: string, salt?: Buffer): { hash: string; salt: string }` —— scrypt，hex
  - `verifyPassword(password: string, hash: string, salt: string): boolean` —— timingSafeEqual
  - `normalizeEmail(raw: unknown): string | null` —— trim + 小写；不像邮箱返回 null
  - `validatePassword(raw: unknown): string | null` —— 8~128 位字符串，否则返回错误文案
  - `type UserRecord = { id: string; email: string; hash: string; salt: string; createdAt: number }`
  - `type JsonFs = { readFileSync(p: string, enc: "utf-8"): string; writeFileSync(p: string, data: string): void; existsSync(p: string): boolean; mkdirSync(p: string, o: { recursive: true }): void }`
  - `createUserStore(opts: { file: string; fs: JsonFs; randomId?: () => string }): { register(email, password): { ok: true; user: UserRecord } | { ok: false; error: string }; authenticate(email, password): UserRecord | null; findById(id): UserRecord | null; count(): number }`
  - `createSessionStore(opts: { file: string; fs: JsonFs; ttlMs: number; now?: () => number; randomToken?: () => string }): { issue(userId): string; resolve(token): string | null; revoke(token): void; sweep(): number }`

- [ ] **Step 1: 写失败的测试**

创建 `server/auth.test.ts`：

```ts
import { describe, it, expect } from "vitest";
import { hashPassword, verifyPassword, normalizeEmail, validatePassword, createUserStore, createSessionStore, type JsonFs } from "./auth.ts";

/** 内存文件系统：只实现 store 用到的四个方法。 */
function memFs(): JsonFs & { files: Map<string, string> } {
  const files = new Map<string, string>();
  return {
    files,
    readFileSync: (p) => { const v = files.get(p); if (v === undefined) throw new Error("ENOENT"); return v; },
    writeFileSync: (p, d) => { files.set(p, d); },
    existsSync: (p) => files.has(p),
    mkdirSync: () => {},
  };
}

describe("hashPassword / verifyPassword", () => {
  it("round-trip", () => {
    const { hash, salt } = hashPassword("correct horse");
    expect(verifyPassword("correct horse", hash, salt)).toBe(true);
    expect(verifyPassword("wrong", hash, salt)).toBe(false);
  });

  it("相同密码、不同 salt 必须产生不同 hash——否则撞库一撞一片", () => {
    const a = hashPassword("same");
    const b = hashPassword("same");
    expect(a.salt).not.toBe(b.salt);
    expect(a.hash).not.toBe(b.hash);
  });

  it("hash 长度不对时返回 false 不抛错", () => {
    expect(verifyPassword("x", "ab", "cd")).toBe(false);
  });
});

describe("normalizeEmail / validatePassword", () => {
  it("邮箱 trim + 小写；不像邮箱的返回 null", () => {
    expect(normalizeEmail("  Foo@Example.com ")).toBe("foo@example.com");
    expect(normalizeEmail("not-an-email")).toBeNull();
    expect(normalizeEmail(42)).toBeNull();
  });
  it("密码 8~128 位", () => {
    expect(validatePassword("short")).toMatch(/8/);
    expect(validatePassword("x".repeat(129))).toMatch(/128/);
    expect(validatePassword("longenough")).toBeNull();
    expect(validatePassword(null)).toMatch(/密码/);
  });
});

describe("createUserStore", () => {
  it("注册后能登录；错密码不行；id 是服务端随机生成的，不是邮箱", () => {
    const fs = memFs();
    const store = createUserStore({ file: "/d/users.json", fs, randomId: () => "id_abc" });
    const r = store.register("A@x.com", "password1");
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.user.id).toBe("id_abc");
    expect(r.user.email).toBe("a@x.com");
    expect(store.authenticate("a@x.com", "password1")?.id).toBe("id_abc");
    expect(store.authenticate("a@x.com", "nope")).toBeNull();
    expect(store.authenticate("nobody@x.com", "password1")).toBeNull();
  });

  it("邮箱已注册时拒绝（大小写不敏感）", () => {
    const store = createUserStore({ file: "/d/users.json", fs: memFs() });
    store.register("a@x.com", "password1");
    expect(store.register("A@X.COM", "password2")).toEqual({ ok: false, error: "该邮箱已注册" });
  });

  it("落盘后新实例能读回", () => {
    const fs = memFs();
    createUserStore({ file: "/d/users.json", fs }).register("a@x.com", "password1");
    const again = createUserStore({ file: "/d/users.json", fs });
    expect(again.count()).toBe(1);
    expect(again.authenticate("a@x.com", "password1")).not.toBeNull();
  });

  it("文件损坏时当空表处理，不抛错", () => {
    const fs = memFs();
    fs.files.set("/d/users.json", "{not json");
    expect(createUserStore({ file: "/d/users.json", fs }).count()).toBe(0);
  });
});

describe("createSessionStore", () => {
  it("签发、解析、作废", () => {
    const store = createSessionStore({ file: "/d/sessions.json", fs: memFs(), ttlMs: 1000 });
    const token = store.issue("u1");
    expect(token.startsWith("paw_")).toBe(true);
    expect(store.resolve(token)).toBe("u1");
    store.revoke(token);
    expect(store.resolve(token)).toBeNull();
  });

  it("过期后解析为 null，sweep 清掉", () => {
    let t = 0;
    const store = createSessionStore({ file: "/d/sessions.json", fs: memFs(), ttlMs: 100, now: () => t });
    const token = store.issue("u1");
    t = 101;
    expect(store.resolve(token)).toBeNull();
    expect(store.sweep()).toBe(1);
  });

  it("落盘：新实例能解析旧 token——重新部署不该全员登出", () => {
    const fs = memFs();
    const token = createSessionStore({ file: "/d/s.json", fs, ttlMs: 1000 }).issue("u1");
    expect(createSessionStore({ file: "/d/s.json", fs, ttlMs: 1000 }).resolve(token)).toBe("u1");
  });
});
```

- [ ] **Step 2: 跑测试确认失败**

Run: `npx vitest run server/auth.test.ts`
Expected: FAIL，`Cannot find module './auth.ts'`

- [ ] **Step 3: 写实现**

创建 `server/auth.ts`：

```ts
/**
 * 账号与会话。
 *
 * 改造前是一个全局 PIN：sha256("pawpals:" + pin)，无 salt、快哈希，会话在内存
 * Map 里，进程一重启全员登出。对一个人的 PIN 勉强够用，对 200 个真人密码不够。
 *
 * 这里：scrypt + 每用户独立随机 salt；用户表和会话表落盘。文件系统通过参数
 * 注入，测试用内存实现。不引入新依赖。
 */
import { scryptSync, randomBytes, timingSafeEqual } from "node:crypto";
import path from "node:path";

export type JsonFs = {
  readFileSync(p: string, enc: "utf-8"): string;
  writeFileSync(p: string, data: string): void;
  existsSync(p: string): boolean;
  mkdirSync(p: string, o: { recursive: true }): void;
};

const SCRYPT_KEYLEN = 64;

export function hashPassword(password: string, salt: Buffer = randomBytes(16)): { hash: string; salt: string } {
  const hash = scryptSync(password, salt, SCRYPT_KEYLEN);
  return { hash: hash.toString("hex"), salt: salt.toString("hex") };
}

export function verifyPassword(password: string, hash: string, salt: string): boolean {
  try {
    const expected = Buffer.from(hash, "hex");
    const actual = scryptSync(password, Buffer.from(salt, "hex"), SCRYPT_KEYLEN);
    if (expected.length !== actual.length) return false;
    return timingSafeEqual(expected, actual);
  } catch {
    return false;
  }
}

export function normalizeEmail(raw: unknown): string | null {
  if (typeof raw !== "string") return null;
  const email = raw.trim().toLowerCase();
  if (email.length > 254 || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) return null;
  return email;
}

/** 返回错误文案；合法返回 null。 */
export function validatePassword(raw: unknown): string | null {
  if (typeof raw !== "string") return "请输入密码";
  if (raw.length < 8) return "密码至少 8 位";
  if (raw.length > 128) return "密码最多 128 位";
  return null;
}

function readJson<T>(fs: JsonFs, file: string, fallback: T): T {
  try {
    if (!fs.existsSync(file)) return fallback;
    return JSON.parse(fs.readFileSync(file, "utf-8")) as T;
  } catch {
    // 文件损坏当空表：登录页打不开比丢一份可重建的会话表更糟
    return fallback;
  }
}

function writeJson(fs: JsonFs, file: string, data: unknown) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify(data, null, 2));
}

// ── 用户表 ────────────────────────────────────────────────────────────

export type UserRecord = { id: string; email: string; hash: string; salt: string; createdAt: number };

export function createUserStore(opts: {
  file: string;
  fs: JsonFs;
  /** 用户目录名就是它，所以必须是服务端生成的随机串，绝不用邮箱。 */
  randomId?: () => string;
  now?: () => number;
}) {
  const { file, fs } = opts;
  const randomId = opts.randomId ?? (() => randomBytes(12).toString("hex"));
  const now = opts.now ?? (() => Date.now());
  const users: UserRecord[] = readJson<{ users: UserRecord[] }>(fs, file, { users: [] }).users ?? [];
  const save = () => writeJson(fs, file, { users });

  return {
    register(emailRaw: unknown, password: string): { ok: true; user: UserRecord } | { ok: false; error: string } {
      const email = normalizeEmail(emailRaw);
      if (!email) return { ok: false, error: "邮箱格式不对" };
      const bad = validatePassword(password);
      if (bad) return { ok: false, error: bad };
      if (users.some((u) => u.email === email)) return { ok: false, error: "该邮箱已注册" };
      const { hash, salt } = hashPassword(password);
      const user: UserRecord = { id: randomId(), email, hash, salt, createdAt: now() };
      users.push(user);
      save();
      return { ok: true, user };
    },
    authenticate(emailRaw: unknown, password: string): UserRecord | null {
      const email = normalizeEmail(emailRaw);
      if (!email || typeof password !== "string") return null;
      const user = users.find((u) => u.email === email);
      if (!user) return null;
      return verifyPassword(password, user.hash, user.salt) ? user : null;
    },
    findById(id: string): UserRecord | null {
      return users.find((u) => u.id === id) ?? null;
    },
    count() { return users.length; },
  };
}

// ── 会话表 ────────────────────────────────────────────────────────────

type SessionRow = { userId: string; createdAt: number };

export function createSessionStore(opts: {
  file: string;
  fs: JsonFs;
  ttlMs: number;
  now?: () => number;
  randomToken?: () => string;
}) {
  const { file, fs, ttlMs } = opts;
  const now = opts.now ?? (() => Date.now());
  // 前缀沿用改造前的 paw_，_getSessionToken 里的 Bearer 解析不用改
  const randomToken = opts.randomToken ?? (() => "paw_" + randomBytes(32).toString("hex"));
  const sessions = new Map<string, SessionRow>(Object.entries(readJson<Record<string, SessionRow>>(fs, file, {})));
  const save = () => writeJson(fs, file, Object.fromEntries(sessions));

  const expired = (row: SessionRow) => now() - row.createdAt > ttlMs;

  return {
    issue(userId: string): string {
      const token = randomToken();
      sessions.set(token, { userId, createdAt: now() });
      save();
      return token;
    },
    resolve(token: string): string | null {
      const row = sessions.get(token);
      if (!row) return null;
      if (expired(row)) { sessions.delete(token); save(); return null; }
      return row.userId;
    },
    revoke(token: string): void {
      if (sessions.delete(token)) save();
    },
    sweep(): number {
      let n = 0;
      for (const [token, row] of sessions) if (expired(row)) { sessions.delete(token); n += 1; }
      if (n) save();
      return n;
    },
  };
}
```

- [ ] **Step 4: 跑测试确认通过**

Run: `npx vitest run server/auth.test.ts`
Expected: PASS（12 tests）

- [ ] **Step 5: 提交**

```bash
git add server/auth.ts server/auth.test.ts
git commit -m "feat(auth): 邮箱账号——scrypt 独立 salt，用户表与会话表落盘"
```

---

### Task 6: 把认证接进 `server.ts`——请求上下文、socket 房间、`emitTo`

**Files:**
- Create: `server/auth-page.ts`
- Modify: `server.ts:310-360`（认证函数）、`server.ts:4542-4600`（中间件与 auth 路由）、`server.ts:4455`（io 创建处）、`server.ts:4889`（connection 处理）、全文 `io.emit(` 62 处

**Interfaces:**
- Consumes: Task 1 `setEmitter` / `emitTo` / `runWithUser` / `LOCAL_USER_ID` / `isValidUserId`；Task 5 `createUserStore` / `createSessionStore`
- Produces（`server.ts` 内）:
  - `const userStore`、`const sessionStore`（仅多用户模式创建）
  - `function resolveRequestUser(req): string | null` —— 请求 → userId；单人模式返回 `"local"`（PIN 校验通过或 localhost）
  - `AUTH_PAGE_HTML: string`（`server/auth-page.ts` 导出 `renderAuthPage(): string`）

- [ ] **Step 1: 写登录/注册页**

创建 `server/auth-page.ts`。这是多用户模式下未登录访问非 API 路径时返回的整页，样式照抄单人模式 PIN 页（`server.ts:4548`）：

```ts
/**
 * 多用户模式的登录/注册页。
 *
 * 前端 App.tsx 没有任何登录态处理——它从来不需要：单人模式下 401 时服务端直接
 * 返回一个 PIN 页。多用户模式照这个做法，页面登录成功就 reload，App.tsx 一行不改。
 */
export function renderAuthPage(): string {
  return `<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>PawPals 登录</title><style>*{box-sizing:border-box}body{margin:0;min-height:100vh;display:flex;align-items:center;justify-content:center;background:#fdf3e8;font-family:system-ui}form{background:#fff;padding:2rem;border-radius:1.5rem;box-shadow:0 4px 24px #f4956a22;text-align:center;width:340px}h2{margin:0 0 .5rem;color:#3d2b1f;font-size:1.3rem}p{color:#8c6b52;font-size:.85rem;margin:0 0 1.2rem}input{width:100%;margin-top:.6rem;padding:.75rem 1rem;border:2px solid #f4956a44;border-radius:.75rem;font-size:1rem;outline:none;color:#3d2b1f}.err{color:#d4694a;font-size:.8rem;margin:.5rem 0 0;min-height:1em}button{margin-top:1rem;width:100%;padding:.75rem;background:#f4956a;color:#fff;border:none;border-radius:.75rem;font-size:1rem;cursor:pointer;font-weight:600}a{display:block;margin-top:.8rem;color:#8c6b52;font-size:.8rem;cursor:pointer}</style></head><body><form id="f"><h2>🐾 PawPals</h2><p id="tip">登录后继续</p><input id="email" type="email" placeholder="邮箱" autocomplete="email" autofocus><input id="pw" type="password" placeholder="密码（至少 8 位）" autocomplete="current-password"><div class="err" id="err"></div><button type="submit" id="go">登录</button><a id="sw">还没有账号？注册</a></form><script>
let mode='login';const $=id=>document.getElementById(id);
$('sw').onclick=()=>{mode=mode==='login'?'register':'login';$('go').textContent=mode==='login'?'登录':'注册';$('sw').textContent=mode==='login'?'还没有账号？注册':'已有账号？登录';$('tip').textContent=mode==='login'?'登录后继续':'注册一个新账号';$('err').textContent='';};
$('f').addEventListener('submit',async e=>{e.preventDefault();$('err').textContent='';const r=await fetch('/api/auth/'+mode,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({email:$('email').value,password:$('pw').value})});const d=await r.json().catch(()=>({}));if(d.ok)location.reload();else $('err').textContent=d.error||'失败了，再试一次';});
</script></body></html>`;
}
```

- [ ] **Step 2: 认证函数改成"请求 → userId"**

在 `server.ts` 的 import 区加：

```ts
import { createUserStore, createSessionStore } from "./server/auth.ts";
import { renderAuthPage } from "./server/auth-page.ts";
import * as nodeFs from "fs";
```

在 `server.ts:310`（`const kSessionTtlMs` 之后）加：

```ts
/** 多用户模式的用户表与会话表。单人模式不创建——PIN 那套原样保留。 */
const USERS_FILE = path.join(APP_DATA_DIR, "users.json");
const SESSIONS_FILE = path.join(APP_DATA_DIR, "sessions.json");
const userStore = MULTI_USER ? createUserStore({ file: USERS_FILE, fs: nodeFs }) : null;
const sessionStore = MULTI_USER ? createSessionStore({ file: SESSIONS_FILE, fs: nodeFs, ttlMs: kSessionTtlMs }) : null;

/**
 * 请求属于谁。返回 null 表示未认证。
 *
 * 单人模式：沿用改造前的 _isAuthenticated（含 localhost 放行、PIN 未启用放行），
 * 通过即是 local——"本地单人版行为与改造前一致"是验收项。
 * 多用户模式：只认会话 cookie / Bearer。没有 localhost 放行；开发期用
 * PAWPALS_DEV_NO_AUTH=1 显式打开，默认关闭。
 */
function resolveRequestUser(req: any): string | null {
  if (!MULTI_USER) return _isAuthenticated(req) ? LOCAL_USER_ID : null;
  if (process.env.PAWPALS_DEV_NO_AUTH === "1") return LOCAL_USER_ID;
  const token = _getSessionToken(req);
  if (!token) return null;
  const userId = sessionStore!.resolve(token);
  return userId && isValidUserId(userId) ? userId : null;
}

/** 从任意 cookie 头字符串解析会话 token（socket.io 握手也用它）。 */
function sessionTokenFromCookie(cookie: string | undefined): string | null {
  const m = (cookie || "").match(/paw_session=([^;]+)/);
  return m ? m[1] : null;
}

function sessionCookie(token: string): string {
  const secure = process.env.NODE_ENV === "production" ? "; Secure" : "";
  return `paw_session=${token}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${kSessionTtlMs / 1000}${secure}`;
}
```

`_isAuthenticated`（`server.ts:340`）**不动**——单人模式还在用。

- [ ] **Step 3: 中间件与 auth 路由**

把 `server.ts:4542-4549` 的中间件改为：

```ts
const AUTH_EXEMPT_PREFIX = ["/api/auth/", "/api/health"];
// 精确匹配：前缀匹配会把需要登录的 /api/extension/pair-code 一起放过去
const AUTH_EXEMPT_EXACT = ["/api/extension/pair"];
app.use((req: any, res: any, next: any) => {
  const isExempt = AUTH_EXEMPT_PREFIX.some(p => req.path.startsWith(p)) || AUTH_EXEMPT_EXACT.includes(req.path);
  const userId = resolveRequestUser(req);
  if (isExempt && !userId) return next();
  if (userId) {
    userStates.touch(userId);
    // 之后整条处理链（含 await 之后）都在该用户的上下文里
    return runWithUser(userId, () => next());
  }
  if (req.path.startsWith("/api/")) return res.status(401).json({ error: "未授权，请先登录", requirePin: !MULTI_USER, requireLogin: MULTI_USER });
  if (MULTI_USER) return res.status(401).send(renderAuthPage());
  res.status(401).send(`<!doctype html>...（原 PIN 页字符串，一字不动）`);
});
```

`/api/auth/status` 改为：

```ts
app.get("/api/auth/status", (req: any, res: any) => {
  if (MULTI_USER) {
    const userId = resolveRequestUser(req);
    const user = userId ? userStore!.findById(userId) : null;
    return res.json({ mode: "multi", authenticated: !!userId, user: user ? { id: user.id, email: user.email } : null });
  }
  const sec = _loadSecurity();
  const ip = _getClientIp(req);
  res.json({ mode: "single", pinEnabled: sec.enabled && !!sec.pinHash, isLocalhost: _isLocalhost(ip), authenticated: _isAuthenticated(req) });
});
```

在 `/api/auth/login` 处理函数**最前面**加多用户分支，原 PIN 逻辑放在其后不动：

```ts
app.post("/api/auth/login", (req: any, res: any) => {
  if (MULTI_USER) {
    const { email, password } = req.body || {};
    // 限流键从 IP 改为 IP + 邮箱：一个 IP 后面可能是一整个学校
    const key = `${_getClientIp(req)}|${String(email || "").trim().toLowerCase()}`;
    const { blocked, retryAfterSec } = _checkThrottle(key);
    if (blocked) return res.status(429).json({ ok: false, error: `尝试次数过多，请 ${retryAfterSec} 秒后重试` });
    const user = userStore!.authenticate(email, password);
    if (!user) { _recordFailure(key); return res.status(401).json({ ok: false, error: "邮箱或密码不对" }); }
    _recordSuccess(key);
    const token = sessionStore!.issue(user.id);
    res.setHeader("Set-Cookie", sessionCookie(token));
    return res.json({ ok: true, token, user: { id: user.id, email: user.email } });
  }
  // ── 以下单人模式 PIN 逻辑原样 ──
  ...
});

app.post("/api/auth/register", (req: any, res: any) => {
  if (!MULTI_USER) return res.status(404).json({ ok: false, error: "单人模式没有注册" });
  const { email, password } = req.body || {};
  const r = userStore!.register(email, password);
  if (!r.ok) return res.status(400).json({ ok: false, error: r.error });
  ensureDir(path.join(APP_DATA_DIR, "users", r.user.id, "career"));
  const token = sessionStore!.issue(r.user.id);
  res.setHeader("Set-Cookie", sessionCookie(token));
  console.log(`[auth] 新用户注册 ${r.user.id}`);
  return res.json({ ok: true, token, user: { id: r.user.id, email: r.user.email } });
});

app.get("/api/auth/me", (req: any, res: any) => {
  const userId = resolveRequestUser(req);
  if (!userId) return res.status(401).json({ ok: false });
  const user = MULTI_USER ? userStore!.findById(userId) : null;
  res.json({ ok: true, mode: MULTI_USER ? "multi" : "single", user: user ? { id: user.id, email: user.email } : { id: userId } });
});
```

`/api/auth/logout` 改为两种模式都处理：

```ts
app.post("/api/auth/logout", (req: any, res: any) => {
  const token = _getSessionToken(req);
  if (token) { _sessions.delete(token); sessionStore?.revoke(token); }
  res.setHeader("Set-Cookie", "paw_session=; Path=/; HttpOnly; Max-Age=0");
  res.json({ ok: true });
});
```

`/api/auth/pin/set` 最前面加 `if (MULTI_USER) return res.status(404).json({ error: "多用户模式没有 PIN" });`。

`_checkThrottle` / `_recordFailure` / `_recordSuccess` 的参数名叫 `ip` 但只是 Map 的键，传 `ip|email` 字符串不用改实现。

- [ ] **Step 4: socket.io 鉴权、房间、每包上下文**

`server.ts:4455` 创建 `io` 之后加：

```ts
setEmitter(io);

/**
 * socket 鉴权：cookie 里的会话 → userId → 加入以 userId 命名的房间。
 * 之后 emitTo() 只往这个房间发。socket.use 让每个收到的包都跑在该用户上下文里。
 */
io.use((socket, next) => {
  const fakeReq = { headers: socket.handshake.headers, socket: { remoteAddress: socket.handshake.address } };
  const userId = resolveRequestUser(fakeReq);
  if (!userId) return next(new Error("未登录"));
  (socket.data as any).userId = userId;
  socket.join(userId);
  socket.use((_packet, nextPacket) => runWithUser(userId, () => nextPacket()));
  next();
});
```

`_getSessionToken(req)` 读的是 `req.headers.cookie` 与 `req.headers.authorization`，`fakeReq` 满足它。

在 `io.on("connection", (socket) => {` 的第一行改为：

```ts
io.on("connection", (socket) => {
  const userId: string = (socket.data as any).userId;
  console.log("User connected:", socket.id, "user:", userId);
  // 连接事件本身不经过 socket.use，这里手动进上下文；Task 4 放在闭包顶部的
  // const { messages, ... } = state() 必须在这行之后
  runWithUser(userId, () => {
    const { messages, studyRoomUsers, treeHolePosts, posts } = state();
    ...（原闭包内容整体缩进一层，直到 socket.on("disconnect") 之后）
  });
});
```

注意 `socket.on(...)` 的注册发生在 `runWithUser` 内，但**触发**时的上下文由 `socket.use` 提供；两者取到的是同一个 userId。

- [ ] **Step 5: `io.emit` 批量换成 `emitTo`**

```bash
perl -pi -e 's/\bio\.emit\(/emitTo(/g' server.ts
grep -n "io\.emit(" server.ts
```

grep 应为空。`notifyIO?.emit("backup_done", ...)`（`server.ts:259`，备份是全局的）不在替换范围内，保持广播。

`emitTo` 定义在 `server/tenancy.ts`，签名 `(event, ...args)`，与 `io.emit` 一致；类型上 `io: Server` 参数在很多函数签名里仍存在但可能不再使用——留着，本轮不清签名。

- [ ] **Step 6: 状态容器的闲置卸载定时器**

在 `startServer()` 里 `io.on("connection", ...)` 之前加：

```ts
// 有 socket 连着的用户不卸：连接闭包里持着它的 messages 数组
setInterval(() => {
  const active = new Set<string>();
  for (const s of io.sockets.sockets.values()) active.add((s.data as any).userId);
  const evicted = userStates.evictIdle((id) => active.has(id) || officialTaskHub.size(id) > 0);
  if (evicted.length) console.log(`[state] 卸载闲置用户状态 ${evicted.join(",")}`);
}, 5 * 60 * 1000);
```

`officialTaskHub.size(id)` 在 Task 7 才有按用户的签名；本任务先写 `officialTaskHub.size() > 0`，Task 7 再改。

- [ ] **Step 6b: 启动期不能求值 `careerDir()`——多用户模式下 `startServer()` 没有用户**

单人模式下 `startServer()` 跑在 local 上下文里，所以启动期读 `careerDir()` 没事；多用户模式没有"启动期的用户"，这些地方会在启动时抛错。找全：

```bash
grep -n "careerDir()" server.ts | awk -F: '$1 > 4450'
```

逐行看，**不在任何路由处理函数 / socket 处理函数体内**的改成惰性：

- `server.ts:4537-4539` 三个 `sync*ToCollaborationBoard()` 启动调用：包进 `if (!MULTI_USER) { ... }`。多用户模式下改为每个用户首次 `state()` 创建时做一次——在 Task 4 的 `create` 里 `messages:` 那行之前加 `_sync: (() => { syncJobsToCollaborationBoard(); syncApplicationsToCollaborationBoard(); syncContactsToCollaborationBoard(); return true; })(),`（并在 `UserState` 类型里加 `_sync: boolean`），此时在 `runWithUser(userId)` 内。
- `server.ts:5759` `const MANAGE_UPLOADS_DIR = path.join(careerDir(), "uploads");` → `const manageUploadsDir = () => path.join(careerDir(), "uploads");`；`multer({ dest: MANAGE_UPLOADS_DIR })` → `multer({ dest: os.tmpdir() })`；处理函数里 `const dir = manageUploadsDir(); ensureDir(dir);` 然后原来用 `MANAGE_UPLOADS_DIR` 的地方用 `dir`。
- `server.ts:5825` `const INBOUND_DIR = path.join(careerDir(), "media", "inbound"); ensureDir(INBOUND_DIR);` → `const inboundDir = () => path.join(careerDir(), "media", "inbound");`；处理函数里 `const dir = inboundDir(); ensureDir(dir);`，后面 `INBOUND_DIR` 全改 `dir`。
- 其余同类的按同样办法改。在处理函数体内的不用动。

- [ ] **Step 7: 编译、测试、双模式冒烟**

Run: `npm run lint && npm test`
Expected: 都过。

单人模式冒烟：`npm run dev`，发消息有回复，历史能刷出来。

多用户模式冒烟：

```bash
PAWPALS_MULTI_USER=1 PAWPALS_HOME=/tmp/pawpals-multi npm run dev
```

打开 `http://localhost:3000`：出现登录/注册页；注册 `a@x.com`；进入后发消息有回复；`/tmp/pawpals-multi/users/<id>/career/pawpals_messages.json` 存在。再开一个**无痕窗口**注册 `b@x.com`：看不到 a 的消息；a 发消息时 b 的屏幕没有任何动静。

- [ ] **Step 8: 提交**

```bash
git add server.ts server/auth-page.ts
git commit -m "feat(server): 多用户模式的登录注册、请求上下文与 socket 房间——A 的每个字不再出现在 B 的屏幕上"
```

---

### Task 7: 插件通道按用户定向（`server/official-socket.ts`）

**Files:**
- Modify: `server/official-socket.ts`
- Modify: `server/official-socket.test.ts`
- Modify: `server.ts:126-138`（`enqueueOfficialTask`）、`server/official-routes.ts:20,66-67`（`hub` 类型与 reload 路由）

**Interfaces:**
- Consumes: 无
- Produces（`createTaskBroadcaster()` 的新形状）:
  - `add(userId: string, client: TaskClient): void`
  - `remove(client: TaskClient): void`
  - `touch(client: TaskClient): void` —— 收到消息/pong 时调用，更新活跃时间
  - `size(userId?: string): number`
  - `sendToUser(userId: string, task: unknown): number` —— 只发给该用户最近活跃的一条，返回 0 或 1
  - `sendRawToUser(userId: string, message: unknown): number`
  - **删除** `broadcast` 与 `sendRaw`

- [ ] **Step 1: 改测试**

`server/official-socket.test.ts` 里 `describe("createTaskBroadcaster")` 与 `describe("sendRaw")` 两段**整体替换**为：

```ts
describe("createTaskBroadcaster（按用户定向）", () => {
  it("发给 A 的任务不会到达 B——这是多用户下最硬的一条", () => {
    const hub = createTaskBroadcaster();
    const a = fakeClient();
    const b = fakeClient();
    hub.add("A", a);
    hub.add("B", b);

    expect(hub.sendToUser("A", task)).toBe(1);
    expect(JSON.parse(a.send.mock.calls[0][0])).toEqual({ type: "task", task });
    expect(b.send).not.toHaveBeenCalled();
  });

  it("该用户没有插件在线时返回 0——任务留在队列里等重连补发", () => {
    const hub = createTaskBroadcaster();
    hub.add("B", fakeClient());
    expect(hub.sendToUser("A", task)).toBe(0);
    expect(hub.size("A")).toBe(0);
    expect(hub.size("B")).toBe(1);
  });

  it("同一用户两条连接只发最近活跃的一条——两台电脑同时执行等于重复提交", () => {
    let t = 0;
    const hub = createTaskBroadcaster({ now: () => t });
    const older = fakeClient();
    const newer = fakeClient();
    t = 1; hub.add("A", older);
    t = 2; hub.add("A", newer);

    expect(hub.sendToUser("A", task)).toBe(1);
    expect(newer.send).toHaveBeenCalledTimes(1);
    expect(older.send).not.toHaveBeenCalled();

    // older 上收到消息后它成了最近活跃的
    t = 3; hub.touch(older);
    expect(hub.sendToUser("A", task)).toBe(1);
    expect(older.send).toHaveBeenCalledTimes(1);
    expect(newer.send).toHaveBeenCalledTimes(1);
  });

  it("最近活跃的那条已关闭时退到下一条，并把死连接清掉", () => {
    let t = 0;
    const hub = createTaskBroadcaster({ now: () => t });
    const live = fakeClient();
    const dead = fakeClient(3); // CLOSED
    t = 1; hub.add("A", live);
    t = 2; hub.add("A", dead);

    expect(hub.sendToUser("A", task)).toBe(1);
    expect(live.send).toHaveBeenCalledTimes(1);
    expect(hub.size("A")).toBe(1);
  });

  it("send 抛错的连接清掉并退到下一条", () => {
    let t = 0;
    const hub = createTaskBroadcaster({ now: () => t });
    const live = fakeClient();
    const broken = fakeClient();
    broken.send.mockImplementation(() => { throw new Error("socket gone"); });
    t = 1; hub.add("A", live);
    t = 2; hub.add("A", broken);

    expect(hub.sendToUser("A", task)).toBe(1);
    expect(live.send).toHaveBeenCalledTimes(1);
    expect(hub.size("A")).toBe(1);
  });

  it("remove 之后不再收到推送；size() 不带参数时是全体在线数", () => {
    const hub = createTaskBroadcaster();
    const client = fakeClient();
    hub.add("A", client);
    hub.add("B", fakeClient());
    expect(hub.size()).toBe(2);
    hub.remove(client);
    expect(hub.sendToUser("A", task)).toBe(0);
    expect(hub.size()).toBe(1);
  });

  it("同一个客户端加两次只算一个", () => {
    const hub = createTaskBroadcaster();
    const client = fakeClient();
    hub.add("A", client);
    hub.add("A", client);
    expect(hub.size("A")).toBe(1);
  });
});

describe("sendRawToUser", () => {
  it("原样发出去，不套 task 外壳，且只发给该用户", () => {
    const hub = createTaskBroadcaster();
    const sentA: string[] = [];
    const sentB: string[] = [];
    hub.add("A", { readyState: 1, send: (m: string) => sentA.push(m) } as any);
    hub.add("B", { readyState: 1, send: (m: string) => sentB.push(m) } as any);
    expect(hub.sendRawToUser("A", { type: "reload" })).toBe(1);
    expect(JSON.parse(sentA[0])).toEqual({ type: "reload" });
    expect(sentB).toEqual([]);
  });
});
```

`parseClientMessage` 那段测试不动。

- [ ] **Step 2: 跑测试确认失败**

Run: `npx vitest run server/official-socket.test.ts`
Expected: FAIL，`hub.sendToUser is not a function`

- [ ] **Step 3: 改实现**

`server/official-socket.ts` 里 `createTaskBroadcaster` 整体替换为：

```ts
type Entry = { userId: string; lastActiveAt: number };

/**
 * 按用户定向的推送通道。
 *
 * 改造前是一个 Set，enqueue 时 broadcast 给全体——多用户下 A 的填表任务（payload
 * 里是 A 的姓名电话履历）会被 B 的浏览器执行，A 点确认后 submit 也可能由 B 的
 * 浏览器、B 的登录态发出。所以这里按 userId 分桶。
 *
 * 同一用户多条连接时**只发最近活跃的一条**：两台电脑都装了插件，发给全部就是
 * 两台同时执行同一次投递 = 重复提交。队列的租约机制配合：派给一条后租约期内不
 * 再派；那条掉线（remove）则下一次派发落到另一条。
 */
export function createTaskBroadcaster(opts: { now?: () => number } = {}) {
  const now = opts.now ?? (() => Date.now());
  const clients = new Map<TaskClient, Entry>();

  const isOpen = (client: TaskClient) => (client.readyState ?? OPEN) === OPEN;

  /** 该用户的连接，最近活跃的在前。 */
  const ofUser = (userId: string) =>
    [...clients.entries()].filter(([, e]) => e.userId === userId).sort((a, b) => b[1].lastActiveAt - a[1].lastActiveAt).map(([c]) => c);

  const deliverOne = (userId: string, payload: string): number => {
    for (const client of ofUser(userId)) {
      if (!isOpen(client)) { clients.delete(client); continue; }
      try {
        client.send(payload);
        return 1;
      } catch {
        clients.delete(client);
      }
    }
    return 0;
  };

  return {
    add(userId: string, client: TaskClient) { clients.set(client, { userId, lastActiveAt: now() }); },
    remove(client: TaskClient) { clients.delete(client); },
    touch(client: TaskClient) { const e = clients.get(client); if (e) e.lastActiveAt = now(); },
    size(userId?: string) { return userId === undefined ? clients.size : ofUser(userId).length; },

    /** 返回 0 表示该用户没有插件在线——任务只能留在队列里，等重连时 onConnect 补发。 */
    sendToUser(userId: string, task: unknown): number {
      return deliverOne(userId, JSON.stringify({ type: "task", task }));
    },

    /** 原样发一条消息（开发期的 reload 命令），不套 task 外壳。 */
    sendRawToUser(userId: string, message: unknown): number {
      return deliverOne(userId, JSON.stringify(message));
    },
  };
}
```

- [ ] **Step 4: 跑测试确认通过**

Run: `npx vitest run server/official-socket.test.ts`
Expected: PASS

- [ ] **Step 5: 改调用点**

`server.ts` 的 `enqueueOfficialTask`（`server.ts:126-138`）：

```ts
function enqueueOfficialTask(input: Parameters<OfficialApplicationQueue["enqueue"]>[0]) {
  const userId = currentUserId();
  if (!userId) throw new Error("enqueueOfficialTask() 在没有用户上下文时被调用");
  const task = state().officialQueue.enqueue(input);
  const delivered = officialTaskHub.sendToUser(userId, task);
  console.log(`[official] 入队 ${task.id.slice(0, 24)} kind=${task.kind} user=${userId} 送达=${delivered}`);
  return task;
}
```

Task 6 Step 6 那处 `officialTaskHub.size() > 0` 改为 `officialTaskHub.size(id) > 0`。

`server/official-routes.ts:20` 的 `hub` 类型改为 `{ sendRawToUser: (userId: string, message: unknown) => number }`；`server/official-routes.ts:66-67` reload 路由改为：

```ts
app.post("/api/dev/reload-extension", (_req: any, res: any) => {
  const delivered = deps.currentUserId() ? officialTaskHub.sendRawToUser(deps.currentUserId()!, { type: "reload" }) : 0;
```

给 `OfficialRouteDeps` 加 `currentUserId: () => string | null;`，`server.ts` 调用处传 `currentUserId`。

`server.ts:4496-4529` 的 `officialWss.on("connection")` 里：`officialTaskHub.add(ws as any)` 暂时改为 `officialTaskHub.add(LOCAL_USER_ID, ws as any)`，并把整个连接处理体包进 `runWithUser(LOCAL_USER_ID, () => { ... })`（Task 8 换成握手得到的 userId）；`ws.on("message")` 处理开头加 `officialTaskHub.touch(ws as any);`，`ws.on("pong", ...)` 里也加 `officialTaskHub.touch(ws as any)`。日志里的 `officialTaskHub.size()` 保持（全体在线数）。

- [ ] **Step 6: 编译、测试、冒烟**

Run: `npm run lint && npm test`
Expected: 都过。单人模式 `npm run dev` + 装好的插件：在某个官网申请页说"帮我投这个岗"，日志出现 `送达=1`，插件开始填。

- [ ] **Step 7: 提交**

```bash
git add server/official-socket.ts server/official-socket.test.ts server/official-routes.ts server.ts
git commit -m "feat(official-socket): 插件任务按用户定向，只发最近活跃的一条连接——A 的简历不会被 B 的浏览器填进去"
```

---

### Task 8: 插件配对——配对码换长期 token，握手验证，插件侧可配服务器

**Files:**
- Create: `server/pairing.ts`、`server/pairing.test.ts`
- Modify: `server.ts:4469-4472`（upgrade 握手）、`server.ts:4494-4530`（connection 处理）、auth 路由附近（新增 4 个端点）
- Modify: `extension/background/session-client.js`、`extension/background/official-task-client.js`、`extension/background/service-worker.js:38,114-118,179`
- Create: `extension/sidepanel/pairing.js`、`extension/sidepanel/pairing.test.js`
- Modify: `extension/sidepanel/panel.html`、`extension/sidepanel/panel.js`

**Interfaces:**
- Consumes: Task 5 的 `JsonFs`；Task 7 的 `officialTaskHub.add(userId, client)`
- Produces:
  - `createPairingStore(opts: { file: string; fs: JsonFs; now?: () => number; randomCode?: () => string; randomToken?: () => string; codeTtlMs?: number })`: `issueCode(userId): { code: string; expiresAt: number }`、`redeem(code): { token: string; userId: string } | null`、`resolveToken(token): string | null`、`revokeAll(userId): number`、`count(userId): number`
  - HTTP：`POST /api/extension/pair-code`（需登录）→ `{ ok, code, expiresAt }`；`POST /api/extension/pair {code}`（免认证）→ `{ ok, token }`；`GET /api/extension/bindings`（需登录）→ `{ ok, count }`；`POST /api/extension/unpair`（需登录）→ `{ ok, revoked }`
  - 插件：`loadServerConfig(): Promise<{ base: string; token: string | null }>`；`createSessionClient({ base })` 与 `createOfficialTaskClient({ base })` 的 `base` 可为字符串或返回字符串的（async）函数
  - `extension/sidepanel/pairing.js`：`parsePairingForm({ serverBase, code }): { ok: true; base: string; code: string } | { ok: false; error: string }`；`pair({ fetchImpl, base, code }): Promise<{ ok: true; token: string } | { ok: false; error: string }>`

- [ ] **Step 1: 服务端配对存储——失败的测试**

创建 `server/pairing.test.ts`：

```ts
import { describe, it, expect } from "vitest";
import { createPairingStore } from "./pairing.ts";
import type { JsonFs } from "./auth.ts";

function memFs(): JsonFs {
  const files = new Map<string, string>();
  return {
    readFileSync: (p) => { const v = files.get(p); if (v === undefined) throw new Error("ENOENT"); return v; },
    writeFileSync: (p, d) => { files.set(p, d); },
    existsSync: (p) => files.has(p),
    mkdirSync: () => {},
  };
}

describe("createPairingStore", () => {
  it("配对码是 8 位、不含易混字符；兑换后得到绑定 userId 的长期 token", () => {
    const store = createPairingStore({ file: "/d/ext.json", fs: memFs() });
    const { code } = store.issueCode("u1");
    expect(code).toMatch(/^[ABCDEFGHJKLMNPQRSTUVWXYZ23456789]{8}$/);
    const r = store.redeem(code);
    expect(r?.userId).toBe("u1");
    expect(r?.token.startsWith("ext_")).toBe(true);
    expect(store.resolveToken(r!.token)).toBe("u1");
  });

  it("配对码一次性：第二次兑换返回 null", () => {
    const store = createPairingStore({ file: "/d/ext.json", fs: memFs() });
    const { code } = store.issueCode("u1");
    expect(store.redeem(code)).not.toBeNull();
    expect(store.redeem(code)).toBeNull();
  });

  it("5 分钟后过期", () => {
    let t = 0;
    const store = createPairingStore({ file: "/d/ext.json", fs: memFs(), now: () => t });
    const { code, expiresAt } = store.issueCode("u1");
    expect(expiresAt).toBe(5 * 60 * 1000);
    t = 5 * 60 * 1000 + 1;
    expect(store.redeem(code)).toBeNull();
  });

  it("兑换时大小写与空格不敏感——用户是手输的", () => {
    const store = createPairingStore({ file: "/d/ext.json", fs: memFs(), randomCode: () => "ABCD2345" });
    store.issueCode("u1");
    expect(store.redeem(" abcd 2345 ")?.userId).toBe("u1");
  });

  it("撤销后 token 失效；count 反映绑定数", () => {
    const store = createPairingStore({ file: "/d/ext.json", fs: memFs() });
    const t1 = store.redeem(store.issueCode("u1").code)!.token;
    const t2 = store.redeem(store.issueCode("u1").code)!.token;
    store.redeem(store.issueCode("u2").code);
    expect(store.count("u1")).toBe(2);
    expect(store.revokeAll("u1")).toBe(2);
    expect(store.resolveToken(t1)).toBeNull();
    expect(store.resolveToken(t2)).toBeNull();
    expect(store.count("u2")).toBe(1);
  });

  it("token 落盘，新实例能解析——重新部署后插件不用重新配对", () => {
    // 配对码只在内存里，所以发码和兑换必须是同一个实例；落盘的是 token
    const fs = memFs();
    const first = createPairingStore({ file: "/d/ext.json", fs });
    const token = first.redeem(first.issueCode("u1").code)!.token;
    expect(createPairingStore({ file: "/d/ext.json", fs }).resolveToken(token)).toBe("u1");
  });

  it("不认识的 token / 垃圾输入返回 null", () => {
    const store = createPairingStore({ file: "/d/ext.json", fs: memFs() });
    expect(store.resolveToken("ext_nope")).toBeNull();
    expect(store.resolveToken("")).toBeNull();
    expect(store.redeem("")).toBeNull();
  });
});
```

- [ ] **Step 2: 跑测试确认失败**

Run: `npx vitest run server/pairing.test.ts`
Expected: FAIL，`Cannot find module './pairing.ts'`

- [ ] **Step 3: 写实现**

创建 `server/pairing.ts`：

```ts
/**
 * 插件配对：短期配对码换长期 token。
 *
 * 分两段的理由：配对码要短、能手输，因此必须短命（5 分钟、一次性）；长期 token
 * 要够随机、存在插件里不需要人记。配对码即使被旁人看到，窗口也只有 5 分钟。
 *
 * 配对码只在内存里；token 落盘（重新部署后插件不用重新配对）。
 */
import { randomBytes, randomInt } from "node:crypto";
import path from "node:path";
import type { JsonFs } from "./auth.ts";

/** 去掉 0/O/1/I：用户是看着屏幕手输的。 */
const CODE_ALPHABET = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";

function defaultRandomCode(): string {
  let s = "";
  for (let i = 0; i < 8; i += 1) s += CODE_ALPHABET[randomInt(CODE_ALPHABET.length)];
  return s;
}

type TokenRow = { userId: string; createdAt: number };

export function createPairingStore(opts: {
  file: string;
  fs: JsonFs;
  now?: () => number;
  randomCode?: () => string;
  randomToken?: () => string;
  codeTtlMs?: number;
}) {
  const { file, fs } = opts;
  const now = opts.now ?? (() => Date.now());
  const randomCode = opts.randomCode ?? defaultRandomCode;
  const randomToken = opts.randomToken ?? (() => "ext_" + randomBytes(32).toString("hex"));
  const codeTtlMs = opts.codeTtlMs ?? 5 * 60 * 1000;

  const codes = new Map<string, { userId: string; expiresAt: number }>();

  let tokens: Record<string, TokenRow> = {};
  try {
    if (fs.existsSync(file)) tokens = JSON.parse(fs.readFileSync(file, "utf-8"));
  } catch {
    tokens = {};
  }
  const save = () => {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, JSON.stringify(tokens, null, 2));
  };

  const normalizeCode = (raw: unknown) => String(raw ?? "").replace(/\s+/g, "").toUpperCase();

  return {
    issueCode(userId: string): { code: string; expiresAt: number } {
      // 顺手清掉过期码，别让 Map 单向增长
      for (const [c, row] of codes) if (row.expiresAt <= now()) codes.delete(c);
      const code = randomCode();
      const expiresAt = now() + codeTtlMs;
      codes.set(code, { userId, expiresAt });
      return { code, expiresAt };
    },
    redeem(raw: unknown): { token: string; userId: string } | null {
      const code = normalizeCode(raw);
      const row = codes.get(code);
      if (!row) return null;
      codes.delete(code); // 一次性：不管成不成都作废
      if (row.expiresAt <= now()) return null;
      const token = randomToken();
      tokens[token] = { userId: row.userId, createdAt: now() };
      save();
      return { token, userId: row.userId };
    },
    resolveToken(token: unknown): string | null {
      if (typeof token !== "string" || !token) return null;
      return tokens[token]?.userId ?? null;
    },
    revokeAll(userId: string): number {
      let n = 0;
      for (const [token, row] of Object.entries(tokens)) if (row.userId === userId) { delete tokens[token]; n += 1; }
      if (n) save();
      return n;
    },
    count(userId: string): number {
      return Object.values(tokens).filter((r) => r.userId === userId).length;
    },
  };
}
```

- [ ] **Step 4: 跑测试确认通过**

Run: `npx vitest run server/pairing.test.ts`
Expected: PASS（7 tests）

- [ ] **Step 5: 服务端端点与握手**

`server.ts` import 区加 `import { createPairingStore } from "./server/pairing.ts";`。在 `sessionStore` 声明之后加（两种模式都创建——单人模式配对是可选的，多用户模式是必须的）：

```ts
const EXTENSION_TOKENS_FILE = path.join(APP_DATA_DIR, "extension-tokens.json");
const pairingStore = createPairingStore({ file: EXTENSION_TOKENS_FILE, fs: nodeFs });
```

在 auth 路由之后加：

```ts
// ── 插件配对 ──────────────────────────────────────────────────────────
app.post("/api/extension/pair-code", (_req: any, res: any) => {
  const { code, expiresAt } = pairingStore.issueCode(currentUserId()!);
  res.json({ ok: true, code, expiresAt });
});
// 免认证：插件此时还没有身份，它手里只有配对码
app.post("/api/extension/pair", (req: any, res: any) => {
  const r = pairingStore.redeem(req.body?.code);
  if (!r) return res.status(400).json({ ok: false, error: "配对码不对或已过期，请回网页重新生成" });
  console.log(`[pairing] 插件已绑定 user=${r.userId}`);
  res.json({ ok: true, token: r.token });
});
app.get("/api/extension/bindings", (_req: any, res: any) => {
  res.json({ ok: true, count: pairingStore.count(currentUserId()!) });
});
app.post("/api/extension/unpair", (_req: any, res: any) => {
  const revoked = pairingStore.revokeAll(currentUserId()!);
  res.json({ ok: true, revoked });
});
```

（`/api/extension/pair` 已在 Task 6 的 `AUTH_EXEMPT` 里；其余三个走认证中间件，`currentUserId()` 一定有值。）

握手：`server.ts:4469-4472` 改为：

```ts
httpServer.on("upgrade", (req, socket, head) => {
  if (!req.url?.startsWith("/ws/official")) return;
  /**
   * 握手验证。验证失败直接关连接，不进任何集合——这是安全边界第 5 条。
   * 单人模式不带 token 也放行（行为与改造前一致），带了就按 token 认。
   */
  const token = new URL(req.url, "http://localhost").searchParams.get("token");
  let userId: string | null = null;
  if (token) userId = pairingStore.resolveToken(token);
  else if (!MULTI_USER) userId = LOCAL_USER_ID;
  if (!userId || !isValidUserId(userId)) {
    console.log("[official] 握手验证失败，拒绝连接");
    socket.write("HTTP/1.1 401 Unauthorized\r\n\r\n");
    socket.destroy();
    return;
  }
  (req as any).pawUserId = userId;
  officialWss.handleUpgrade(req, socket as any, head, (ws) => officialWss.emit("connection", ws, req));
});
```

`officialWss.on("connection", (ws) => {` 改为 `officialWss.on("connection", (ws, req: any) => {`，第一行 `const userId: string = req.pawUserId;`，把 Task 7 Step 5 里临时写的 `LOCAL_USER_ID` 换成 `userId`：`officialTaskHub.add(userId, ws as any)`，整个处理体包在 `runWithUser(userId, () => { ... })` 里（这样里面的 `state().officialQueue.releaseLeases()` / `.next()` / `.progress()` / `.complete()` 取的都是该用户的队列；`ws.on("message")` 回调在 `runWithUser` 内注册，触发时继承上下文）。日志加上 `user=${userId}`。

- [ ] **Step 6: 插件侧——服务器地址与 token 可配**

`extension/background/session-client.js` 整体改为：

```js
/** HTTP client for the PawPals server. */
// 默认仍是本地服务：本地单人版行为一字不变。云端部署时用户在侧边栏填地址并配对。
export const SERVER_BASE = 'http://localhost:3000';

/**
 * 从 chrome.storage.local 读服务器配置。没配过就是默认本地地址、无 token。
 * storage 可注入以便测试。
 */
export async function loadServerConfig({ storage } = {}) {
  const area = storage ?? globalThis.chrome?.storage?.local;
  if (!area) return { base: SERVER_BASE, token: null };
  try {
    const { serverBase, extensionToken } = await area.get(['serverBase', 'extensionToken']);
    return { base: (serverBase || SERVER_BASE).replace(/\/+$/, ''), token: extensionToken || null };
  } catch {
    return { base: SERVER_BASE, token: null };
  }
}

/** base 可以是字符串，也可以是返回字符串的（async）函数——后者每次请求时惰性读配置。 */
export const resolveBase = async (base) => (typeof base === 'function' ? await base() : base);

export function createSessionClient({ fetchImpl, base = SERVER_BASE } = {}) {
  const doFetch = fetchImpl ?? globalThis.fetch;
  return {
    async ping() {
      try {
        return (await doFetch(`${await resolveBase(base)}/api/health`, { method: 'GET' })).ok === true;
      } catch {
        return false;
      }
    },
    async report(sessionId, payload) {
      try {
        const response = await doFetch(`${await resolveBase(base)}/api/internal/browser-task-done`, {
          method: 'POST', headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ id: sessionId, result: payload }),
        });
        if (!response.ok) return { ok: false, error: `服务端返回 ${response.status}` };
        return await response.json();
      } catch (error) {
        return { ok: false, error: String(error?.message || error) };
      }
    },
  };
}
```

`extension/background/official-task-client.js`：第一行改为 `import { SERVER_BASE, resolveBase } from './session-client.js';`，函数内每个 `${base}` 改成 `${await resolveBase(base)}`（`next` / `complete` / `reportContext` 三处，以及文件里其余用到 `${base}` 的方法——用 `grep -n '\${base}' extension/background/official-task-client.js` 找全）。

`extension/background/service-worker.js`：

```js
// 第 1 行
import { createSessionClient, SERVER_BASE, loadServerConfig } from './session-client.js';
// 第 7、14 行：客户端改成惰性读地址
const client = createSessionClient({ base: async () => (await loadServerConfig()).base });
const officialClient = createOfficialTaskClient({ base: async () => (await loadServerConfig()).base });
// 第 38 行删掉 const SOCKET_URL = ...
```

`connectOfficialSocket` 改为 async：

```js
async function connectOfficialSocket() {
  if (socket && (socket.readyState === WebSocket.OPEN || socket.readyState === WebSocket.CONNECTING)) return;
  const { base, token } = await loadServerConfig();
  // http → ws、https → wss，云端无需额外处理
  const url = `${base.replace(/^http/, 'ws')}/ws/official${token ? `?token=${encodeURIComponent(token)}` : ''}`;
  try {
    socket = new WebSocket(url);
  } catch {
    socket = null;
    return;
  }
  ...（其余不变）
}
```

`chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {`（第 179 行）的函数体最前面加：

```js
  // 侧边栏配对成功后要求用新配置重连
  if (message?.type === 'RECONNECT_SERVER') {
    try { socket?.close(); } catch { /* 已经断了 */ }
    socket = null;
    void connectOfficialSocket();
    sendResponse({ ok: true });
    return true;
  }
```

- [ ] **Step 7: 侧边栏配对逻辑——失败的测试**

创建 `extension/sidepanel/pairing.test.js`：

```js
import { describe, expect, it, vi } from 'vitest';
import { parsePairingForm, pair } from './pairing.js';

describe('parsePairingForm', () => {
  it('地址去尾部斜杠、配对码去空格转大写', () => {
    expect(parsePairingForm({ serverBase: ' https://paw.example.com/ ', code: ' abcd 2345 ' }))
      .toEqual({ ok: true, base: 'https://paw.example.com', code: 'ABCD2345' });
  });
  it('地址必须以 http(s):// 开头', () => {
    expect(parsePairingForm({ serverBase: 'paw.example.com', code: 'ABCD2345' })).toMatchObject({ ok: false, error: expect.stringContaining('http') });
  });
  it('配对码必须是 8 位', () => {
    expect(parsePairingForm({ serverBase: 'http://localhost:3000', code: 'ABC' })).toMatchObject({ ok: false, error: expect.stringContaining('8') });
  });
});

describe('pair', () => {
  it('POST /api/extension/pair，成功返回 token', async () => {
    const fetchImpl = vi.fn().mockResolvedValue({ ok: true, json: async () => ({ ok: true, token: 'ext_x' }) });
    expect(await pair({ fetchImpl, base: 'https://paw.example.com', code: 'ABCD2345' })).toEqual({ ok: true, token: 'ext_x' });
    const [url, request] = fetchImpl.mock.calls[0];
    expect(url).toBe('https://paw.example.com/api/extension/pair');
    expect(JSON.parse(request.body)).toEqual({ code: 'ABCD2345' });
  });
  it('服务端拒绝时带回它的错误文案', async () => {
    const fetchImpl = vi.fn().mockResolvedValue({ ok: false, json: async () => ({ ok: false, error: '配对码不对或已过期' }) });
    expect(await pair({ fetchImpl, base: 'https://paw.example.com', code: 'ABCD2345' })).toEqual({ ok: false, error: '配对码不对或已过期' });
  });
  it('连不上服务器时不抛错', async () => {
    const fetchImpl = vi.fn().mockRejectedValue(new Error('offline'));
    expect(await pair({ fetchImpl, base: 'https://paw.example.com', code: 'ABCD2345' })).toMatchObject({ ok: false, error: expect.stringContaining('连不上') });
  });
});
```

- [ ] **Step 8: 跑测试确认失败**

Run: `npx vitest run extension/sidepanel/pairing.test.js`
Expected: FAIL，找不到模块

- [ ] **Step 9: 写实现与界面**

创建 `extension/sidepanel/pairing.js`：

```js
/** 侧边栏"连接服务器"的纯逻辑：表单解析与配对请求。DOM 在 panel.js。 */

export function parsePairingForm({ serverBase, code }) {
  const base = String(serverBase ?? '').trim().replace(/\/+$/, '');
  if (!/^https?:\/\//i.test(base)) return { ok: false, error: '服务器地址要以 http:// 或 https:// 开头' };
  const cleaned = String(code ?? '').replace(/\s+/g, '').toUpperCase();
  if (cleaned.length !== 8) return { ok: false, error: '配对码是 8 位，请照网页上显示的输入' };
  return { ok: true, base, code: cleaned };
}

export async function pair({ fetchImpl, base, code }) {
  const doFetch = fetchImpl ?? globalThis.fetch;
  try {
    const response = await doFetch(`${base}/api/extension/pair`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ code }),
    });
    const data = await response.json().catch(() => ({}));
    if (!response.ok || !data.ok || !data.token) return { ok: false, error: data.error || `服务端返回 ${response.status}` };
    return { ok: true, token: data.token };
  } catch (error) {
    return { ok: false, error: `连不上服务器：${String(error?.message || error)}` };
  }
}
```

`extension/sidepanel/panel.html` 在 `<h1>` 之后、`<button id="perceive">` 之前插入：

```html
    <fieldset style="border:1px solid #eaddd0;border-radius:6px;padding:8px 10px;margin:0 0 12px">
      <legend style="font-size:12px;opacity:.78">连接服务器</legend>
      <label>服务器地址<input id="server-base" placeholder="http://localhost:3000"></label>
      <label>配对码（网页 → 个人设置 → 连接插件）<input id="pair-code" placeholder="ABCD2345" maxlength="9"></label>
      <p style="margin:8px 0 0"><button id="pair">配对</button> <button id="unpair" class="ghost">清除配置</button></p>
      <div id="pair-status" style="margin-top:6px;font-size:12px;opacity:.78">（本地单人版不需要配对）</div>
    </fieldset>
```

`extension/sidepanel/panel.js` 顶部加 `import { parsePairingForm, pair } from './pairing.js';`，末尾加：

```js
async function refreshPairStatus() {
  const { serverBase, extensionToken } = await chrome.storage.local.get(['serverBase', 'extensionToken']);
  $('server-base').value = serverBase || '';
  $('pair-status').textContent = extensionToken
    ? `已绑定到 ${serverBase || 'http://localhost:3000'}`
    : '（本地单人版不需要配对）';
}
void refreshPairStatus();

$('pair').addEventListener('click', async () => {
  const parsed = parsePairingForm({ serverBase: $('server-base').value || 'http://localhost:3000', code: $('pair-code').value });
  if (!parsed.ok) return show(false, parsed.error);
  const result = await pair({ base: parsed.base, code: parsed.code });
  if (!result.ok) return show(false, result.error);
  await chrome.storage.local.set({ serverBase: parsed.base, extensionToken: result.token });
  await chrome.runtime.sendMessage({ type: 'RECONNECT_SERVER' });
  $('pair-code').value = '';
  await refreshPairStatus();
  show(true, '配对成功，插件已重新连接');
});

$('unpair').addEventListener('click', async () => {
  await chrome.storage.local.remove(['serverBase', 'extensionToken']);
  await chrome.runtime.sendMessage({ type: 'RECONNECT_SERVER' });
  await refreshPairStatus();
  show(true, '已清除，回到本地服务器');
});
```

- [ ] **Step 10: 测试、编译、端到端**

Run: `npm test && npm run lint`
Expected: 都过（`session-client.test.js` 里 `SERVER_BASE` 仍是 `http://localhost:3000`；`official-task-client.test.js` 传字符串 base 仍能用）。

端到端（多用户模式）：

```bash
PAWPALS_MULTI_USER=1 PAWPALS_HOME=/tmp/pawpals-multi npm run dev
```

1. 网页登录 a@x.com，用 curl 生成配对码（Task 12 之前还没有界面）：`curl -s -X POST -b "paw_session=<a 的 token>" localhost:3000/api/extension/pair-code`
2. 插件侧边栏填 `http://localhost:3000` + 配对码 → "配对成功"；服务端日志 `[official] 扩展已连接 user=<a 的 id>`
3. 不带 token 直接连：`npx wscat -c ws://localhost:3000/ws/official`（或浏览器控制台 `new WebSocket(...)`）→ 立即被拒，日志 `握手验证失败`
4. b@x.com 说"帮我投这个岗"（需在某官网页）→ 日志 `送达=0`，a 的插件没有任何动作

单人模式回归：`npm run dev`，插件不配对直接连上，投递照常。

- [ ] **Step 11: 提交**

```bash
git add server/pairing.ts server/pairing.test.ts server.ts extension/background/session-client.js extension/background/official-task-client.js extension/background/service-worker.js extension/sidepanel/pairing.js extension/sidepanel/pairing.test.js extension/sidepanel/panel.html extension/sidepanel/panel.js
git commit -m "feat(pairing): 插件配对码换长期 token，握手验证失败即拒绝——插件知道自己是谁的"
```

---

### Task 9: 按用户额度（`server/quota.ts` + `llm.ts` 钩子）

**Files:**
- Create: `server/quota.ts`、`server/quota.test.ts`
- Modify: `llm.ts:47-53`（`trackUsage`）
- Modify: `server.ts`（挂钩子；`send_message` 入口的超额判定；`/api/auth/me` 带额度）

**Interfaces:**
- Consumes: Task 1 `currentUserId` / `runWithUser` / `userDataDir`
- Produces:
  - `llm.ts`: `setUsageHook(fn: ((usage: { prompt_tokens: number; completion_tokens: number; total_tokens: number }) => void) | null): void`
  - `createQuota(opts: { dailyLimit: number | null; now?: () => number; load: (userId: string) => { day: string; used: number } | null; save: (userId: string, rec: { day: string; used: number }) => void })`: `record(userId, tokens: number): void`、`used(userId): number`、`exceeded(userId): boolean`、`limit(): number | null`

- [ ] **Step 1: 写失败的测试**

创建 `server/quota.test.ts`：

```ts
import { describe, it, expect } from "vitest";
import { createQuota } from "./quota.ts";

function memQuota(dailyLimit: number | null, clock: { t: number }) {
  const rows = new Map<string, { day: string; used: number }>();
  const quota = createQuota({
    dailyLimit,
    now: () => clock.t,
    load: (id) => rows.get(id) ?? null,
    save: (id, rec) => { rows.set(id, rec); },
  });
  return { quota, rows };
}

const DAY = 24 * 60 * 60 * 1000;

describe("createQuota", () => {
  it("按 token 累计，不按次数", () => {
    const { quota } = memQuota(1000, { t: 0 });
    quota.record("u1", 300);
    quota.record("u1", 400);
    expect(quota.used("u1")).toBe(700);
    expect(quota.exceeded("u1")).toBe(false);
    quota.record("u1", 400);
    expect(quota.exceeded("u1")).toBe(true);
  });

  it("用户之间互不影响", () => {
    const { quota } = memQuota(1000, { t: 0 });
    quota.record("u1", 5000);
    expect(quota.exceeded("u2")).toBe(false);
  });

  it("跨天重置", () => {
    const clock = { t: 0 };
    const { quota } = memQuota(1000, clock);
    quota.record("u1", 5000);
    expect(quota.exceeded("u1")).toBe(true);
    clock.t = DAY + 1;
    expect(quota.used("u1")).toBe(0);
    expect(quota.exceeded("u1")).toBe(false);
  });

  it("没设上限时永不超额，但仍然记账", () => {
    const { quota } = memQuota(null, { t: 0 });
    quota.record("u1", 10_000_000);
    expect(quota.exceeded("u1")).toBe(false);
    expect(quota.used("u1")).toBe(10_000_000);
  });

  it("记账落盘：save 被调用，load 回来的值接着算", () => {
    const { quota, rows } = memQuota(1000, { t: 0 });
    quota.record("u1", 10);
    expect(rows.get("u1")).toEqual({ day: "1970-01-01", used: 10 });
  });

  it("非法 token 数忽略", () => {
    const { quota } = memQuota(1000, { t: 0 });
    quota.record("u1", NaN);
    quota.record("u1", -5);
    expect(quota.used("u1")).toBe(0);
  });
});
```

- [ ] **Step 2: 跑测试确认失败**

Run: `npx vitest run server/quota.test.ts`
Expected: FAIL，找不到模块

- [ ] **Step 3: 写实现**

创建 `server/quota.ts`：

```ts
/**
 * 按用户、按天的 token 额度。
 *
 * 按 token 计，不按调用次数：一次编排轮是 3 次调用，但一次可能 5 万 token、一次
 * 8 千，按次数等于没计。
 *
 * 超额判定在一轮开始时做一次，允许该轮跑完——判定在这里，"允许跑完"由调用方
 * 保证（只在 send_message 入口查，不在每次模型调用前查）。
 *
 * 天的边界用 UTC 日期。用户在各时区，选哪个都有人半夜被重置；UTC 至少可预测。
 */
export type QuotaRecord = { day: string; used: number };

export function createQuota(opts: {
  dailyLimit: number | null;
  now?: () => number;
  load: (userId: string) => QuotaRecord | null;
  save: (userId: string, rec: QuotaRecord) => void;
}) {
  const now = opts.now ?? (() => Date.now());
  const today = () => new Date(now()).toISOString().slice(0, 10);

  const current = (userId: string): QuotaRecord => {
    const rec = opts.load(userId);
    if (!rec || rec.day !== today()) return { day: today(), used: 0 };
    return rec;
  };

  return {
    record(userId: string, tokens: number): void {
      if (!Number.isFinite(tokens) || tokens <= 0) return;
      const rec = current(userId);
      rec.used += Math.round(tokens);
      opts.save(userId, rec);
    },
    used(userId: string): number {
      return current(userId).used;
    },
    exceeded(userId: string): boolean {
      if (opts.dailyLimit === null) return false;
      return current(userId).used >= opts.dailyLimit;
    },
    limit(): number | null {
      return opts.dailyLimit;
    },
  };
}
```

- [ ] **Step 4: 跑测试确认通过**

Run: `npx vitest run server/quota.test.ts`
Expected: PASS（6 tests）

- [ ] **Step 5: `llm.ts` 钩子**

`llm.ts:47-53` 的 `trackUsage` 改为：

```ts
type Usage = { prompt_tokens: number; completion_tokens: number; total_tokens: number };

/**
 * 用量钩子。llm.ts 不知道用户是谁——由 server.ts 挂一个从异步上下文取用户的
 * 函数进来。钩子抛错不能影响模型调用，所以 try/catch。
 */
let usageHook: ((usage: Usage) => void) | null = null;
export function setUsageHook(fn: ((usage: Usage) => void) | null) {
  usageHook = fn;
}

function trackUsage(usage?: Usage) {
  if (!usage) return;
  tokenStats.prompt += usage.prompt_tokens || 0;
  tokenStats.completion += usage.completion_tokens || 0;
  tokenStats.total += usage.total_tokens || 0;
  tokenStats.calls += 1;
  try { usageHook?.(usage); } catch (e: any) { console.warn("[llm] usage hook 抛错：", e?.message || e); }
}
```

- [ ] **Step 6: 接进 `server.ts`**

import 区：`import { ..., setUsageHook } from "./llm.ts";` 与 `import { createQuota } from "./server/quota.ts";`。

在 `userStates` 声明之后加：

```ts
/**
 * 每日 token 上限。未设 = 不限（单人版默认不限）。数字尚未定量——见设计稿
 * "已知风险"：开放注册前必须定下来。
 */
const DAILY_TOKEN_LIMIT = process.env.PAWPALS_DAILY_TOKEN_LIMIT ? Number(process.env.PAWPALS_DAILY_TOKEN_LIMIT) : null;
const quotaFile = () => path.join(userDataDir(), "quota.json");
const quota = createQuota({
  dailyLimit: Number.isFinite(DAILY_TOKEN_LIMIT as number) ? DAILY_TOKEN_LIMIT : null,
  load: (userId) => runWithUser(userId, () => {
    try { return existsSync(quotaFile()) ? JSON.parse(readFileSync(quotaFile(), "utf-8")) : null; } catch { return null; }
  }),
  save: (userId, rec) => runWithUser(userId, () => {
    try { ensureDir(path.dirname(quotaFile())); writeFileSync(quotaFile(), JSON.stringify(rec)); } catch (e: any) { console.warn("[quota] 写入失败：", e?.message); }
  }),
});
setUsageHook((usage) => {
  const userId = currentUserId();
  if (userId) quota.record(userId, usage.total_tokens || 0);
});
```

`socket.on("send_message", (msg) => {` 的函数体最前面加：

```ts
      // 超额判定只在一轮开始时做：一轮 3 次调用，中途掐断用户看到的是半截对话
      if (quota.exceeded(userId)) {
        emitTo("receive_message", {
          id: `quota-${Date.now()}`, sender: "系统", avatar: "/avatars/system.png",
          content: `今天的 AI 用量已经用完（${quota.limit()} tokens/天），明天再来吧 🐾`,
          groupId: msg?.groupId || "job", timestamp: new Date().toISOString(), isBot: true,
        });
        return;
      }
```

`/api/auth/me` 的响应加 `quota: { used: quota.used(userId), limit: quota.limit() }`。

`.env.example` 末尾加：

```
# ── 多用户模式 ─────────────────────────────────────────────────────────
# PAWPALS_MULTI_USER=1          # 邮箱账号 + 数据按用户隔离；未设为本地单人版
# PAWPALS_DEV_NO_AUTH=1         # 仅开发：多用户模式下跳过登录，一律当 local 用户
# PAWPALS_DAILY_TOKEN_LIMIT=300000   # 每用户每日 token 上限；未设为不限
```

- [ ] **Step 7: 测试、编译、冒烟**

Run: `npm test && npm run lint`

冒烟：`PAWPALS_MULTI_USER=1 PAWPALS_DAILY_TOKEN_LIMIT=100 PAWPALS_HOME=/tmp/pawpals-multi npm run dev`，登录后发一句话——这一轮跑完（3 个 agent 都说完），第二句话收到"今天的 AI 用量已经用完"。`users/<id>/quota.json` 里 `used` 大于 100。

- [ ] **Step 8: 提交**

```bash
git add server/quota.ts server/quota.test.ts llm.ts server.ts .env.example
git commit -m "feat(quota): 按用户按天记 token，超额拒绝新一轮但让进行中的一轮跑完"
```

---

### Task 10: 定时任务与后台循环——多用户模式下关闭无用户上下文的那些

**Files:**
- Modify: `server.ts:5964-6016`（6 个 `scheduleJob`）、`server.ts:4879`（2 分钟宠物定时器）、`startMailWatcher(...)` 调用处、`server.ts:4537-4539`（启动期 sync）

**Interfaces:**
- Consumes: `MULTI_USER`
- Produces: 无

- [ ] **Step 1: 用 `!MULTI_USER` 包住**

把 6 个每日 `schedule.scheduleJob({ hour: ... })` 连同 `proactivePost` 定义与最后那行 `console.log("⏰ 定时任务已注册...")` 整体包进：

```ts
if (MULTI_USER) {
  /**
   * 多用户模式下 6 个每日主动任务默认关闭。
   * 它们运行时没有用户上下文；就算给每个用户各跑一遍，6 × 200 = 每天 1200 次
   * 无人请求的 agent 运行，全在项目方的 key 上。"用户可选开关"留作后续。
   */
  console.log("⏰ 多用户模式：每日主动任务已关闭（备份仍每小时一次）");
} else {
  ...（原样）
}
```

同样处理：`server.ts:4879` 那个每 2 分钟 `emitTo` 宠物消息的 `setInterval`、`startMailWatcher(io, ...)` 的调用——都包进 `if (!MULTI_USER) { ... }`。（三个 `sync*ToCollaborationBoard()` 启动调用已在 Task 6 Step 6b 处理。）

`server.ts:4862` 附近还有一个 `setInterval`：读它的函数体，只要用到 `emitTo` / `state()` / `careerDir()` 就同样包进 `if (!MULTI_USER)`；不用就不动。

每小时备份 `startAutoBackup(APP_DATA_DIR, io)` 不动：它备份整个 APP_DATA_DIR（含 `users/`），`notifyIO.emit` 是全局广播但只是"备份完成"通知，不含用户数据。

- [ ] **Step 2: 验证多用户模式启动干净**

```bash
PAWPALS_MULTI_USER=1 PAWPALS_HOME=/tmp/pawpals-multi npm run dev
```

Expected: 启动日志有"每日主动任务已关闭"；跑 3 分钟没有任何 `[tenancy] emitTo(...) 没有用户上下文` 警告。

单人模式：`npm run dev`，启动日志仍是"⏰ 定时任务已注册：9AM 搜岗..."。

- [ ] **Step 3: 提交**

```bash
git add server.ts
git commit -m "chore(server): 多用户模式下关闭无用户上下文的定时任务与后台循环"
```

---

### Task 11: 迁移——首次多用户启动把 `workspace/career` 搬到 `users/local/career`

**Files:**
- Create: `server/migration.ts`、`server/migration.test.ts`
- Modify: `server.ts`（启动入口）

**Interfaces:**
- Consumes: 无
- Produces: `migrateLegacyWorkspace(opts: { legacyDir: string; targetDir: string; extraFiles?: { from: string; to: string }[]; fs: { existsSync; mkdirSync; cpSync; renameSync; copyFileSync } }): "migrated" | "skipped-target-exists" | "skipped-no-legacy"`

- [ ] **Step 1: 写失败的测试**

创建 `server/migration.test.ts`（用真实临时目录——迁移的本质就是文件系统操作）：

```ts
import { describe, it, expect } from "vitest";
import { mkdtempSync, mkdirSync, writeFileSync, existsSync, readFileSync } from "node:fs";
import * as fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { migrateLegacyWorkspace } from "./migration.ts";

function scratch() {
  const root = mkdtempSync(path.join(os.tmpdir(), "pawpals-migrate-"));
  const legacy = path.join(root, "workspace", "career");
  mkdirSync(path.join(legacy, "workspaces", "career-planner"), { recursive: true });
  writeFileSync(path.join(legacy, "profile.md"), "# 我");
  writeFileSync(path.join(legacy, "workspaces", "career-planner", "SOUL.md"), "soul");
  writeFileSync(path.join(root, "pet.json"), '{"name":"团团"}');
  return { root, legacy, target: path.join(root, "users", "local", "career") };
}

describe("migrateLegacyWorkspace", () => {
  it("整体搬到 users/local/career，原目录改名为 career.migrated 而非删除", () => {
    const { root, legacy, target } = scratch();
    const r = migrateLegacyWorkspace({
      legacyDir: legacy, targetDir: target, fs,
      extraFiles: [{ from: path.join(root, "pet.json"), to: path.join(root, "users", "local", "pet.json") }],
    });
    expect(r).toBe("migrated");
    expect(readFileSync(path.join(target, "profile.md"), "utf-8")).toBe("# 我");
    expect(readFileSync(path.join(target, "workspaces", "career-planner", "SOUL.md"), "utf-8")).toBe("soul");
    expect(existsSync(legacy)).toBe(false);
    expect(existsSync(path.join(root, "workspace", "career.migrated"))).toBe(true);
    expect(readFileSync(path.join(root, "users", "local", "pet.json"), "utf-8")).toContain("团团");
  });

  it("幂等：目标已存在就跳过，什么都不动", () => {
    const { legacy, target } = scratch();
    migrateLegacyWorkspace({ legacyDir: legacy, targetDir: target, fs });
    mkdirSync(legacy, { recursive: true });
    writeFileSync(path.join(legacy, "profile.md"), "新的");
    expect(migrateLegacyWorkspace({ legacyDir: legacy, targetDir: target, fs })).toBe("skipped-target-exists");
    expect(readFileSync(path.join(target, "profile.md"), "utf-8")).toBe("# 我");
    expect(existsSync(legacy)).toBe(true);
  });

  it("没有旧数据（全新部署）就跳过", () => {
    const root = mkdtempSync(path.join(os.tmpdir(), "pawpals-migrate-"));
    expect(migrateLegacyWorkspace({ legacyDir: path.join(root, "nope"), targetDir: path.join(root, "users", "local", "career"), fs })).toBe("skipped-no-legacy");
  });

  it("extraFiles 里不存在的文件跳过，不影响主迁移", () => {
    const { root, legacy, target } = scratch();
    const r = migrateLegacyWorkspace({ legacyDir: legacy, targetDir: target, fs, extraFiles: [{ from: path.join(root, "missing.json"), to: path.join(root, "users", "local", "missing.json") }] });
    expect(r).toBe("migrated");
  });
});
```

- [ ] **Step 2: 跑测试确认失败**

Run: `npx vitest run server/migration.test.ts`
Expected: FAIL，找不到模块

- [ ] **Step 3: 写实现**

创建 `server/migration.ts`：

```ts
/**
 * 单人版数据迁移到多用户布局。
 *
 * 首次以多用户模式启动时，把 workspace/career/ 整体搬到 users/local/career/。
 * 幂等：目标存在就不再搬。原目录改名为 career.migrated 而不是删除——出错可以
 * 手工回滚。先复制再改名，中途崩了也不会丢数据。
 */
import path from "node:path";

type MigrateFs = {
  existsSync(p: string): boolean;
  mkdirSync(p: string, o: { recursive: true }): void;
  cpSync(src: string, dest: string, o: { recursive: true }): void;
  renameSync(from: string, to: string): void;
  copyFileSync(from: string, to: string): void;
};

export function migrateLegacyWorkspace(opts: {
  legacyDir: string;
  targetDir: string;
  /** career 之外的用户级文件，比如 pet.json。缺了就跳过。 */
  extraFiles?: { from: string; to: string }[];
  fs: MigrateFs;
}): "migrated" | "skipped-target-exists" | "skipped-no-legacy" {
  const { legacyDir, targetDir, fs } = opts;
  if (fs.existsSync(targetDir)) return "skipped-target-exists";
  if (!fs.existsSync(legacyDir)) return "skipped-no-legacy";

  fs.mkdirSync(path.dirname(targetDir), { recursive: true });
  fs.cpSync(legacyDir, targetDir, { recursive: true });
  for (const { from, to } of opts.extraFiles ?? []) {
    if (!fs.existsSync(from)) continue;
    fs.mkdirSync(path.dirname(to), { recursive: true });
    fs.copyFileSync(from, to);
  }
  fs.renameSync(legacyDir, legacyDir + ".migrated");
  return "migrated";
}
```

- [ ] **Step 4: 跑测试确认通过**

Run: `npx vitest run server/migration.test.ts`
Expected: PASS（4 tests）

- [ ] **Step 5: 接进启动入口**

`server.ts` import 区加 `import { migrateLegacyWorkspace } from "./server/migration.ts";`。文件末尾的启动入口改为：

```ts
if (MULTI_USER) {
  const r = migrateLegacyWorkspace({
    legacyDir: LEGACY_CAREER_DIR,
    targetDir: path.join(APP_DATA_DIR, "users", LOCAL_USER_ID, "career"),
    extraFiles: [{ from: path.join(APP_DATA_DIR, "pet.json"), to: path.join(APP_DATA_DIR, "users", LOCAL_USER_ID, "pet.json") }],
    fs: nodeFs,
  });
  if (r === "migrated") console.log(`[migrate] 单人版数据已搬到 users/${LOCAL_USER_ID}/career，原目录改名为 career.migrated`);
  startServer();
} else {
  runWithUser(LOCAL_USER_ID, () => startServer());
}
```

迁移后的 `local` 用户在多用户模式下没有邮箱账号，只有 `PAWPALS_DEV_NO_AUTH=1` 时能访问到——这是设计稿的既定范围（"现有数据迁移"），把旧数据认领到某个邮箱账号留作后续。

- [ ] **Step 6: 验证**

```bash
rm -rf /tmp/pawpals-migrate && mkdir -p /tmp/pawpals-migrate/workspace/career && echo "# 我" > /tmp/pawpals-migrate/workspace/career/profile.md
PAWPALS_MULTI_USER=1 PAWPALS_HOME=/tmp/pawpals-migrate npm run dev
```

Expected：日志出现 `[migrate] 单人版数据已搬到`；`ls /tmp/pawpals-migrate/users/local/career/profile.md` 存在；`/tmp/pawpals-migrate/workspace/career.migrated/` 存在。再启动一次不再打印迁移日志。

- [ ] **Step 7: 提交**

```bash
git add server/migration.ts server/migration.test.ts server.ts
git commit -m "feat(migration): 首次多用户启动把单人版数据搬到 users/local——幂等，原目录改名保留"
```

---

### Task 12: 网页端——个人设置里的"连接插件"与"退出登录"

**Files:**
- Modify: `src/App.tsx`（个人设置弹窗，`"AI 能力设置"` 区块之后；状态声明处）

**Interfaces:**
- Consumes: Task 8 的四个 `/api/extension/*` 端点；Task 6 的 `/api/auth/status`、`/api/auth/logout`
- Produces: 无

- [ ] **Step 1: 加状态**

在 `App` 组件里 `const [showUserSettings, setShowUserSettings] = useState(...)` 附近加：

```tsx
  const [authMode, setAuthMode] = useState<'single' | 'multi'>('single');
  const [pairCode, setPairCode] = useState<{ code: string; expiresAt: number } | null>(null);
  const [extBindings, setExtBindings] = useState<number>(0);

  // 打开个人设置时拉一次：是哪种部署、绑了几个插件
  useEffect(() => {
    if (!showUserSettings) return;
    fetch('/api/auth/status').then(r => r.json()).then(d => setAuthMode(d.mode === 'multi' ? 'multi' : 'single')).catch(() => {});
    fetch('/api/extension/bindings').then(r => r.json()).then(d => setExtBindings(d.count || 0)).catch(() => {});
  }, [showUserSettings]);
```

- [ ] **Step 2: 加界面**

在个人设置弹窗里 `"AI 能力设置"` 那个 `<div className="rounded-3xl bg-pet-cream/70 p-4">` 之后、`<div className="pt-4">`（保存修改按钮）之前插入：

```tsx
                  <div className="rounded-3xl bg-pet-cream/70 p-4 space-y-3">
                    <div className="text-xs font-bold text-pet-brown/40 uppercase tracking-widest">浏览器插件</div>
                    <p className="text-sm leading-6 text-pet-brown/60">
                      {extBindings > 0 ? `已绑定 ${extBindings} 个插件。` : '还没有绑定插件。'}
                      生成配对码后，在插件侧边栏填入服务器地址和这串码。5 分钟内有效，只能用一次。
                    </p>
                    {pairCode && (
                      <div className="rounded-2xl bg-white p-4 text-center">
                        <div className="text-2xl font-mono font-bold tracking-[0.3em] text-pet-brown">{pairCode.code}</div>
                        <div className="mt-1 text-xs text-pet-brown/40">服务器地址：{window.location.origin}</div>
                      </div>
                    )}
                    <div className="flex gap-2">
                      <button
                        type="button"
                        onClick={async () => {
                          const r = await fetch('/api/extension/pair-code', { method: 'POST' }).then(x => x.json()).catch(() => null);
                          if (r?.ok) setPairCode({ code: r.code, expiresAt: r.expiresAt });
                        }}
                        className="flex-1 rounded-2xl bg-white px-4 py-3 text-xs font-bold text-pet-orange pet-shadow hover:scale-[1.02] transition-transform"
                      >
                        生成配对码
                      </button>
                      {extBindings > 0 && (
                        <button
                          type="button"
                          onClick={async () => {
                            if (!confirm('解除后所有已绑定的插件都要重新配对，确定吗？')) return;
                            await fetch('/api/extension/unpair', { method: 'POST' }).catch(() => {});
                            setExtBindings(0);
                            setPairCode(null);
                          }}
                          className="rounded-2xl border border-red-200 bg-red-50 px-4 py-3 text-xs font-bold text-red-400 hover:bg-red-100 transition-colors"
                        >
                          解除绑定
                        </button>
                      )}
                    </div>
                  </div>
                  {authMode === 'multi' && (
                    <button
                      type="button"
                      onClick={async () => {
                        await fetch('/api/auth/logout', { method: 'POST' }).catch(() => {});
                        window.location.reload();
                      }}
                      className="w-full rounded-2xl border border-pet-brown/10 bg-white px-5 py-3 text-sm font-bold text-pet-brown/60 hover:bg-pet-cream transition-colors"
                    >
                      退出登录
                    </button>
                  )}
```

- [ ] **Step 3: 编译与手测**

Run: `npm run lint`（`tsc --noEmit` 覆盖 `src/`）。

`PAWPALS_MULTI_USER=1 PAWPALS_HOME=/tmp/pawpals-multi npm run dev`：登录 → 个人设置 → "生成配对码"出现 8 位码 → 插件侧边栏配对成功 → 回到设置重新打开显示"已绑定 1 个插件" → "解除绑定"后插件日志出现握手失败并回到未绑定 → "退出登录"回到登录页。

单人模式：`npm run dev`，个人设置里有"浏览器插件"区块但没有"退出登录"按钮。

- [ ] **Step 4: 提交**

```bash
git add src/App.tsx
git commit -m "feat(web): 个人设置里生成插件配对码、解除绑定、退出登录"
```

---

### Task 13: 上传路径收口与端到端验收

**Files:**
- Modify: `server.ts:5759,5811-5821,5825-5835`（两个上传处理）

**Interfaces:**
- Consumes: Task 2 的 `careerDir()`
- Produces（`server.ts` 内）: `safeUploadPath(dir: string, originalName: string): string | null`

- [ ] **Step 1: 上传文件名只落在该用户目录内**

在 `startServer()` 之前加：

```ts
/**
 * 上传文件名 sanitize：去目录部分、换掉危险字符，再确认解析后仍在 dir 内。
 * 多用户下 dir 是该用户自己的目录，这是安全边界第 4 条。
 */
function safeUploadPath(dir: string, originalName: string): string | null {
  const base = path.basename(originalName).replace(/[^a-zA-Z0-9.\-_一-龥 ()]/g, "_");
  if (!base || base === "." || base === "..") return null;
  const dest = path.resolve(dir, base);
  return dest.startsWith(path.resolve(dir) + path.sep) ? dest : null;
}
```

`manageUploadsDir()` / `inboundDir()` 已在 Task 6 Step 6b 改成惰性。`/api/manage/upload` 的处理函数改为：

```ts
    const dir = manageUploadsDir();
    ensureDir(dir);
    const destPath = safeUploadPath(dir, req.file.originalname);
    if (!destPath) return res.status(400).json({ error: "文件名不合法" });
    copyFileSync(req.file.path, destPath);
    try { unlinkSync(req.file.path); } catch {}
    res.json({ ok: true, filename: path.basename(destPath), path: destPath });
```

`/api/upload/resume` 的处理函数里，原来的 `const safeName = origName.replace(...)` 与 `const destPath = path.join(INBOUND_DIR, safeName);` 两行改为：

```ts
    const dir = inboundDir();
    ensureDir(dir);
    const destPath = safeUploadPath(dir, origName);
    if (!destPath) return res.status(400).json({ error: "文件名不合法" });
```

- [ ] **Step 2: 全量回归**

Run: `npm test && npm run lint`
Expected: 都过。

- [ ] **Step 3: 端到端验收（对照设计稿"验收"一节）**

```bash
PAWPALS_MULTI_USER=1 PAWPALS_HOME=/tmp/pawpals-e2e PAWPALS_DAILY_TOKEN_LIMIT=200000 npm run dev
```

用两个浏览器（一个普通、一个无痕）分别注册 A、B，逐条勾：

- [ ] A 发的消息 B 看不到；B 刷新后也看不到
- [ ] A 上传简历后，B 的简历专家说"还没有简历"
- [ ] A 触发的 agent 打字时，B 的屏幕没有任何"思考中"指示
- [ ] A 生成配对码并绑定插件；B 说"帮我投这个岗"→ 服务端日志 `送达=0`，A 的插件无动作
- [ ] A 在第二个 Chrome profile 再绑一个插件，A 投递一次 → 只有一个插件执行（日志 `送达=1`）
- [ ] 不带 token 的 WebSocket 连接被拒（日志"握手验证失败"）
- [ ] 启动日志含"每日主动任务已关闭"
- [ ] 把 `PAWPALS_DAILY_TOKEN_LIMIT` 改成 `100` 重启：A 的第一轮跑完，第二轮被拒
- [ ] `/tmp/pawpals-e2e/users/` 下每个用户一个随机 id 目录，没有邮箱出现在目录名里
- [ ] 重启服务后 A、B 都不用重新登录（sessions.json 落盘）

单人模式回归（`npm run dev`，用改造前的真实数据目录）：

- [ ] 历史消息都在；发消息有回复；简历还在
- [ ] 插件不配对直接连上，投递照常
- [ ] 启动日志"⏰ 定时任务已注册：9AM..."
- [ ] 设了 PIN 的话，外网访问仍要 PIN，本机不用

- [ ] **Step 4: 提交**

```bash
git add server.ts
git commit -m "fix(server): 上传文件名只落在该用户目录内；启动期不再求值 careerDir()"
```

---

## Self-Review

**Spec coverage**

| 设计稿章节 | 任务 |
|---|---|
| 1 身份与会话（scrypt、落盘、cookie 标志、限流键、两套认证互斥、localhost 放行） | Task 5、6（单人模式保留 localhost 放行——见 Global Constraints 的取舍说明） |
| 2 数据目录隔离（careerDir 抛错、12 常量改函数、local 用户） | Task 1、2 |
| 3 进程内状态容器 + 闲置卸载 | Task 3、4、6 Step 6 |
| 4 网页通道定向（emitTo、socket.join） | Task 1、6 |
| 4 插件通道定向（sendToUser 只发最近活跃一条） | Task 7 |
| 5 插件配对（配对码、token、可撤销、地址可配） | Task 8、12 |
| 6 额度（onUsage 钩子、按 token、每日重置、轮开始时判定） | Task 9 |
| 7 定时任务多用户下关闭 | Task 10 |
| 8 迁移（幂等、改名保留） | Task 11 |
| 安全边界 1-5 | 1：Task 1；2：Task 6（只读 cookie）、Task 8（只读 token）；3：Task 1 `isValidUserId` + Task 5 `randomId`；4：Task 13；5：Task 8 Step 5 |
| 验收清单 | Task 13 Step 3 |

**已知未覆盖**（设计稿本身列为不在本轮）：邮箱验证、密码找回、数据导出删除、计费、定时任务的用户开关、把 `local` 数据认领到某个邮箱账号。

**与设计稿的两处取舍**（都在 Global Constraints 里写明）：
1. 单人模式保留 localhost 放行与 PIN——"本地单人版行为与改造前一致"是验收项。
2. `pet.json` 也按用户隔离（设计稿的 18 个文件清单没列它，但宠物名字是用户身份的一部分，不隔离会让所有人共用一个名字）；单人模式下它仍在原位置。

**Type consistency 自查**：`createTaskBroadcaster` 在 Task 7 定义 `add(userId, client)` / `sendToUser` / `sendRawToUser` / `touch` / `size(userId?)`，Task 6 Step 6 与 Task 8 Step 5 按此使用；`JsonFs` 在 Task 5 定义，Task 8 的 `pairing.ts` 从 `./auth.ts` 导入；`state()` 在 Task 4 定义，Task 7、9 使用；`resolveRequestUser` 在 Task 6 定义，同任务的 `io.use` 使用；`LEGACY_CAREER_DIR` 在 Task 2 定义，Task 11 使用；`nodeFs` 在 Task 6 Step 2 引入，Task 8、11 使用。
