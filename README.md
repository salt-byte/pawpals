# 萌爪伴学 PawPals 🐾

> 陪你备考、求职、考研的 AI 伴学助手——用群聊的方式，让多个 AI 小动物帮你搞定学习任务。

[![Deploy on Railway](https://railway.app/button.svg)](https://railway.app/new/template?template=https://github.com/salt-byte/pawpals)

---

## 两种使用方式

| | 💻 本地版 | ☁️ 云版 |
|---|---|---|
| 部署方式 | 下载 Electron App | 点按钮一键部署到 Railway |
| 数据存储 | 本机（完全私有） | Railway Volume（持久化） |
| 访问方式 | localhost | your-app.railway.app（任意设备） |
| 费用 | 免费 | Railway $5/月起 |
| 离线使用 | ✅ | ❌ |

**本地版快速开始 →** 见下方「快速开始」
**云版一键部署 →** 点上方 Deploy on Railway 按钮，填写 API Key，完成

---

## 产品简介

萌爪伴学基于 OpenClaw 多 Agent 框架，通过「群聊」交互方式，将多个专项 AI 组织成伴学团队，覆盖求职、公考、考研三条赛道。

**三个学习群：**

| 群名 | 场景 | AI 成员 |
|------|------|---------|
| 求职助理团 | 岗位搜索、简历优化、面试备战 | 职业规划师、岗位猎手、简历专家、投递管家、技能成长师、人脉顾问、面试教练 |
| 公考备战群 | 行测刷题、申论批改 | 行测题库喵、申论批改喵 |
| 考研冲刺群 | 英语单词、数学解题 | 单词背诵兔、数学解题兔 |

**其他功能：**
- 🐾 首席伴学官私聊（可自定义宠物名字和性格）
- 🌳 树洞（匿名倾诉 + AI 抱抱回复）
- 📚 自习室（在线自习打卡）
- 📎 文件上传（支持 PDF、Word 文档解析）
- 🔄 模型切换（Anthropic、Gemini、OpenAI、GLM、Doubao、MiniMax、自定义接口）
- 💾 数据备份（本地快照版本历史 + ZIP 导出 + 一键恢复）
- 🔐 API Key 安全脱敏（明文 Key 自动替换为环境变量引用）
- 🛡️ 安全防护（登录限流、PIN 保护、Session 管理、Watchdog 崩溃自动恢复）

---

## 技术架构

```
用户设备（浏览器 / Electron）
  └── React 前端（Vite 构建，Tailwind CSS + Motion）
        ↕ Socket.IO + REST API
  └── Express + Socket.IO Server（port 3010）
        ├── 7 个 Job Agent（关键词路由 / @ 路由 / 链式调用）
        ├── 流式输出（stream_chunk → 打字机效果）
        ├── Login Throttle（指数退避暴力破解保护）
        ├── Watchdog（Gateway 崩溃检测 + openclaw doctor --fix）
        └── 本地备份系统（快照 / 版本历史 / ZIP 导出）
              ↕
        OpenClaw Gateway（本地 AI 网关，port 18790）
              ↕
        AI 模型（Anthropic / Gemini / OpenAI / GLM / 自定义）
```

**主要依赖：**
- `openclaw` — 本地 AI 网关（Agent session、工具调用）
- `electron` + `electron-builder` — 桌面打包
- `socket.io` — 实时双向通信
- `express` — HTTP API 服务
- `react` + `tailwindcss` + `motion` — 前端 UI
- `pdfjs-dist` + `mammoth` — PDF / Word 文件解析
- `archiver` — ZIP 备份导出

---

## 快速开始

### 本地版

**环境要求：**
- Node.js >= 22
- macOS arm64（桌面构建目前仅支持 Apple Silicon）

```bash
npm install

# 仅启动 web 服务（开发模式，需自行配置 OpenClaw）
npm run dev

# 启动独立运行时（推荐）
npm run dev:isolated

# 启动 Electron 桌面开发模式
npm run desktop:dev

# 构建桌面应用
npm run desktop:build
```

构建产物在 `dist/mac-arm64/PawPals.app`。

> ⚠️ 首次打开如提示「已损坏」，终端运行：`xattr -dr com.apple.quarantine /path/to/PawPals.app`

### 云版（Railway）

1. 点击上方 **Deploy on Railway** 按钮
2. 用 GitHub 账号登录 Railway（30 秒）
3. 填写环境变量（至少填一个 API Key）
4. Deploy → 等待构建完成（约 3-5 分钟）
5. 打开分配的域名 `your-app.railway.app` 即可使用

**Railway 环境变量说明：**

| 变量 | 说明 |
|------|------|
| `OPENAI_API_KEY` | OpenAI / 兼容 API Key |
| `ANTHROPIC_API_KEY` | Anthropic Claude API Key |
| `GEMINI_API_KEY` | Google Gemini API Key |
| `OPENAI_BASE_URL` | 自定义 API Base URL（末尾含 /v1） |
| `PAWPALS_HOME` | 数据目录，默认 `/data/pawpals`（已挂载 Volume） |

---

## 环境变量（本地版）

| 变量 | 说明 | 默认值 |
|------|------|--------|
| `PAWPALS_HOME` | 应用数据目录 | `~/Library/Application Support/PawPals` |
| `OPENCLAW_HOME` | OpenClaw 配置目录 | `$PAWPALS_HOME/openclaw` |
| `OPENCLAW_BASE_URL` | Gateway 地址 | `http://127.0.0.1:18790` |
| `OPENCLAW_BIN` | 自定义 openclaw 二进制路径 | `openclaw` |
| `PAWPALS_PORT` | 应用服务端口 | `3010` |

---

## 模型切换

应用内支持在线切换，无需重启：

头像 → **换模型** → 选择厂商 → 填写 API Key → 保存

支持：Anthropic Claude、Google Gemini、OpenAI GPT、智谱 GLM、火山豆包、MiniMax、自定义 OpenAI 兼容接口。

---

## 安全特性

- **登录限流**：5 分钟窗口内失败 5 次触发指数退避锁定（最长 30 分钟）
- **PIN 保护**：外网访问需设置 PIN，Session 有效期 7 天，SHA-256 存储
- **Watchdog**：每 30 秒检测 Gateway 存活，崩溃循环自动运行 `openclaw doctor --fix`
- **Secrets 脱敏**：Dashboard 一键将明文 API Key 替换为环境变量引用

---

## License

MIT
