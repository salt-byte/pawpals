#!/usr/bin/env python3
"""applications: 读取/写入投递记录。
用法:
  python applications.py read
  python applications.py followups
  python applications.py record <company> <role> [url] [source] [notes]
"""
import json, pathlib, sys
from datetime import date, timedelta

APPS_FILE = pathlib.Path.home() / ".openclaw/workspace/career/applications.json"

def load():
    return json.loads(APPS_FILE.read_text()) if APPS_FILE.exists() else []

cmd = sys.argv[1] if len(sys.argv) > 1 else "read"

if cmd == "read":
    apps = load()
    if not apps: print("暂无投递记录。"); sys.exit(0)
    by_status = {}
    for a in apps:
        by_status.setdefault(a["status"], []).append(a)
    lines = [f"**{s}** ({len(v)})\n" + "\n".join(f"  · {a['company']} — {a['role']}" for a in v)
             for s, v in by_status.items()]
    print(f"📊 投递看板（共 {len(apps)} 条）\n\n" + "\n\n".join(lines))

elif cmd == "followups":
    apps = load()
    today = date.today().isoformat()
    overdue = [a for a in apps if a.get("status") == "applied" and a.get("followUpDate","") <= today]
    if not overdue: print("✅ 没有逾期的 follow-up！"); sys.exit(0)
    print(f"⏰ 需要 follow-up 的投递（{len(overdue)} 条）：\n\n" +
          "\n".join(f"· **{a['company']}** — {a['role']}（{a['followUpDate']}）" for a in overdue))

elif cmd == "record":
    company = sys.argv[2]; role = sys.argv[3]
    url = sys.argv[4] if len(sys.argv) > 4 else ""
    source = sys.argv[5] if len(sys.argv) > 5 else "direct"
    notes = sys.argv[6] if len(sys.argv) > 6 else ""
    apps = load()
    follow_up = (date.today() + timedelta(days=7)).isoformat()
    apps.append({"id": str(__import__("time").time_ns()), "company": company, "role": role,
                 "status": "applied", "appliedDate": date.today().isoformat(),
                 "followUpDate": follow_up, "source": source, "url": url, "notes": notes,
                 "timeline": [{"date": date.today().isoformat(), "action": "Applied"}]})
    APPS_FILE.write_text(json.dumps(apps, indent=2, ensure_ascii=False))
    print(f"✅ 已记录投递：{company} — {role}，follow-up 提醒设在 {follow_up}。")
