# 萌爪伴学 PawPals 🐾

> 陪你备考、求职、考研的 AI 伴学助手——用群聊的方式，让多个 AI 小动物帮你搞定学习任务。

---

## 产品简介

萌爪伴学是一款基于 Electron 的桌面 AI 应用，通过模拟「群聊」的交互方式，将多个专项 AI Agent 组织成一个伴学团队，覆盖求职、公考、考研三条赛道。

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
- 🔄 模型切换（支持 Anthropic、Gemini、OpenAI、GLM、Doubao、MiniMax、自定义接口）

---

## 技术架构

```
Electron (桌面壳)
  └── OpenClaw Gateway (本地 AI 网关, port 18790)
  └── Express + Socket.IO Server (应用服务, port 3010)
       ├── 7 个 Job Agent（关键词路由 / @ 路由 / 链式调用）
       ├── 流式输出（stream_chunk → 打字机效果）
       └── React 前端（Vite 构建）
```

**主要依赖：**
- `electron` + `electron-builder` — 桌面打包
- `socket.io` — 实时双向通信
- `express` — HTTP API 服务
- `openclaw` — 本地 AI 网关（管理 agent session、工具调用）
- `react` + `tailwindcss` + `motion` — 前端 UI

---

## 快速开始

### 环境要求

- Node.js >= 22
- macOS arm64（当前桌面构建仅支持 Apple Silicon）

### 本地开发

```bash
npm install

# 仅启动 web 服务（需自行配置 OpenClaw）
npm run dev

# 启动独立运行时（推荐）
npm run dev:isolated

# 启动 Electron 桌面开发模式
npm run desktop:dev
```

### 构建桌面应用

```bash
npm run desktop:build
```

构建产物在 `dist/mac-arm64/PawPals.app`。

> ⚠️ 分发前请确保模板目录 `resources/openclaw-template/` 中不含个人 API Key（默认已清空）。

---

## 环境变量

| 变量 | 说明 | 默认值 |
|------|------|--------|
| `PAWPALS_HOME` | 应用数据目录 | `~/Library/Application Support/PawPals` |
| `OPENCLAW_HOME` | OpenClaw 配置目录 | `$PAWPALS_HOME/openclaw` |
| `OPENCLAW_BASE_URL` | Gateway 地址 | `http://127.0.0.1:18790` |
| `OPENCLAW_BIN` | 自定义 openclaw 二进制路径 | 内置 |
| `PAWPALS_PORT` | 应用服务端口 | `3010` |
| `PAWPALS_COPY_SECRETS` | 是否复制本机 secrets | `1`（开发），`0`（分发） |

---

## 模型切换

应用内支持在线切换模型，无需重启：

头像 → **换模型** → 选择厂商和模型 → 填写 API Key → 保存

支持厂商：Anthropic Claude、Google Gemini、OpenAI、智谱 GLM、火山豆包、MiniMax、自定义 OpenAI 兼容接口。

---

## 已知问题 & 注意事项

- 首次打开如提示「已损坏」，在终端运行：`xattr -dr com.apple.quarantine /path/to/PawPals.app`
- 求职群的 Boss直聘自动投递功能需要提前在群内完成登录授权
- 模型切换后 gateway 约 10 秒重启生效

---

## License

MIT
