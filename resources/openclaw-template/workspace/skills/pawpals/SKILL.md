# SKILL.md — pawpals 求职工具

PawPals 的求职执行链已经统一到桌面端 Electron 运行时，不再使用旧的 Playwright / jobclaw Python 脚本。

## 当前架构

### 1. Boss 直聘搜索 / 登录 / 发起沟通
- 统一由 Electron BrowserWindow 执行
- 登录由 `/api/boss-login` 或岗位猎手触发
- 搜索和发起沟通任务通过服务端队列下发给 Electron 主进程
- Boss 渠道当前只做到“发起沟通/打招呼”，不自动附简历

### 2. 全网搜索
- 由服务端调用 Tavily 搜索脚本完成
- 主要覆盖官网、LinkedIn、Greenhouse、Lever、Ashby、Workday 等站点

### 3. 投递记录 / 协作表
- 统一由服务端维护：
  - `{{OPENCLAW_HOME}}/workspace/career/jobs.json`
  - `{{OPENCLAW_HOME}}/workspace/career/applications.json`
  - `{{OPENCLAW_HOME}}/workspace/career/collaboration_board.json`

## 注意
- 不要再引用 `workspace/skills/pawpals/scripts/*.py`，这些旧脚本已废弃
- Boss 渠道和非 Boss 渠道是两条不同流程：
  - Boss：先发起沟通
  - 官网/ATS/LinkedIn：后续走简历投递
- 所有不可逆动作仍然必须先获得用户确认
