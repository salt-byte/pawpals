# HEARTBEAT — 📊 投递管家

每次收到 heartbeat 时执行：

## 必做：Gmail 扫描
1. 执行邮件扫描（见 SOUL.md Gmail 部分）
2. 找到状态变化 → 同步更新 applications.json + 飞书表格 `<bitable-app-token>`
3. 有新面试/offer/拒信 → 主动通知用户
4. 无变化 → 回复 HEARTBEAT_OK

## 定期做（每天一次）：Follow-up 检查
- 扫描所有 `applied` 状态超过 7 天未更新的记录
- 有到期的 → 提醒用户 follow-up
