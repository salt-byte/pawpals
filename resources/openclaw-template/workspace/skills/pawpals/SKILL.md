# SKILL.md — pawpals 求职工具

求职助手核心工具集：搜岗、投递、记录。供 main agent（像素）直接调用。

## 工具

### 1. 搜索岗位
```bash
python {{OPENCLAW_HOME}}/workspace/skills/pawpals/scripts/search_jobs.py "<query>" [city_code]
```
- city_code 默认北京 `101010100`，上海 `101020100`，深圳 `101280600`
- 有 Boss cookies（`~/.jobclaw/cookies/boss.json`）时走 curl_cffi 直接调 Boss API
- 无 cookies 时 fallback 到 Brave 搜索
- 搜到的岗位自动合并入 `{{OPENCLAW_HOME}}/workspace/career/jobs.json`

### 2. 自动投递
```bash
python {{OPENCLAW_HOME}}/workspace/skills/pawpals/scripts/apply_job.py "<job_url>" "<company>" "<title>" ["greeting"]
```
- **必须先获得用户明确确认再执行**（不可逆操作）
- 输出：`SUCCESS` / `ALREADY_APPLIED` / `NEED_LOGIN` / `NO_BUTTON` / `DEFAULT_SENT`

### 3. 投递记录
```bash
# 读取看板
python {{OPENCLAW_HOME}}/workspace/skills/pawpals/scripts/applications.py read

# 检查 follow-up
python {{OPENCLAW_HOME}}/workspace/skills/pawpals/scripts/applications.py followups

# 记录新投递
python {{OPENCLAW_HOME}}/workspace/skills/pawpals/scripts/applications.py record "<company>" "<role>" [url] [source] [notes]
```

## 数据文件
- `{{OPENCLAW_HOME}}/workspace/career/jobs.json` — 岗位库
- `{{OPENCLAW_HOME}}/workspace/career/applications.json` — 投递记录
- `~/.jobclaw/cookies/boss.json` — Boss直聘 cookies（登录后保存）
- `scripts/brave_key.txt` — Brave Search API key（fallback 用）

## Python 路径
`/Users/dengyudie/code/Anaconda/anaconda3/bin/python`

## 注意
- apply_job 是不可逆操作，执行前必须用户说"确认"/"投"/"ok"等明确同意
- Boss cookies 过期时提示用户重新登录，不要自动重试
