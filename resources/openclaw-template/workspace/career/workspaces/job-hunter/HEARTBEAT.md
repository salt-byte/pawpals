# HEARTBEAT — 🔍 岗位猎手

每次收到 heartbeat：

## 检查今天是否已推送过岗位
- 读 `jobs.json`，看 `addedDate` 是否有今天的记录
- 有 → HEARTBEAT_OK
- 没有 → 立即执行今日搜索（见下）

## 今日搜索任务
1. 使用 `web_search` 搜索最新 AI PM / AI Strategy Intern 岗位（LinkedIn + JobRight）
2. 与已有记录去重
3. 找到新岗位 → 写入 `jobs.json` + 在飞书群推送
4. 推送格式：
```
🌅 今日岗位推送 [日期]

🆕 新增 X 个岗位：
1. [公司] — [职位] ⭐高匹配 🔗 [直达链接]
2. ...

@投递管家 已更新，请协助确认投递
```
