#!/usr/bin/env python3
"""search_jobs: 搜索 Boss直聘岗位，有 cookies 用 curl_cffi，否则 fallback 到 Brave。
用法: python search_jobs.py <query> [city_code]
"""
import json, pathlib, sys, urllib.parse

CAREER_DIR = pathlib.Path.home() / ".openclaw/workspace/career"
COOKIE_PATH = pathlib.Path.home() / ".jobclaw/cookies/boss.json"
BRAVE_KEY_FILE = pathlib.Path.home() / ".openclaw/workspace/skills/pawpals/brave_key.txt"

query = sys.argv[1] if len(sys.argv) > 1 else "AI PM intern 2026"
city  = sys.argv[2] if len(sys.argv) > 2 else "101010100"

def save_jobs(new_jobs):
    jobs_file = CAREER_DIR / "jobs.json"
    raw = json.loads(jobs_file.read_text()) if jobs_file.exists() else []
    existing = raw if isinstance(raw, list) else []
    urls = {j["url"] for j in existing if isinstance(j, dict)}
    merged = existing + [j for j in new_jobs if j["url"] not in urls]
    jobs_file.write_text(json.dumps(merged, indent=2, ensure_ascii=False))

if COOKIE_PATH.exists():
    from curl_cffi import requests as cf
    cookies_raw = json.loads(COOKIE_PATH.read_text())["cookies"]
    cookie_dict = {c["name"]: c["value"] for c in cookies_raw}
    params = urllib.parse.urlencode({"scene":1,"query":query,"city":city,"page":1,"pageSize":15})
    url = "https://www.zhipin.com/wapi/zpgeek/search/joblist.json?" + params
    referer = "https://www.zhipin.com/web/geek/job?" + urllib.parse.urlencode({"query":query,"city":city})
    r = cf.get(url, cookies=cookie_dict, impersonate="chrome120",
               headers={"Referer": referer, "Accept-Language": "zh-CN,zh;q=0.9"})
    d = r.json()
    if d.get("code") != 0:
        print(f"FAIL:{d.get('code')} {d.get('message')}"); sys.exit(1)
    jobs = d.get("zpData", {}).get("jobList", [])
    lines, structured = [], []
    for i, j in enumerate(jobs, 1):
        salary = j.get("salaryDesc", "薪资面议")
        url_path = j.get("encryptJobId", "")
        job_url = f"https://www.zhipin.com/job_detail/{url_path}.html" if url_path else "https://www.zhipin.com"
        lines.append(f"{i}. **{j.get('jobName')}** @ {j.get('brandName')} [{salary}]\n   📍 {j.get('cityName','')} · {j.get('areaDistrict','')}  ⏱ {j.get('experienceName','')} · {j.get('degreeName','')}\n   🔗 {job_url}")
        structured.append({"company": j.get("brandName",""), "title": j.get("jobName",""), "url": job_url, "salary": salary, "city": j.get("cityName",""), "source": "boss", "applied": False})
    save_jobs(structured)
    print("\n\n".join(lines) or "未找到相关岗位。")
else:
    import urllib.request
    brave_key = BRAVE_KEY_FILE.read_text().strip() if BRAVE_KEY_FILE.exists() else ""
    q = urllib.parse.quote(f"{query} site:zhipin.com OR site:linkedin.com/jobs")
    req = urllib.request.Request(
        f"https://api.search.brave.com/res/v1/web/search?q={q}&count=8",
        headers={"Accept": "application/json", "X-Subscription-Token": brave_key}
    )
    with urllib.request.urlopen(req) as resp:
        data = json.loads(resp.read())
    results = data.get("web", {}).get("results", [])[:8]
    lines = [f"{i+1}. **{r['title']}**\n   {r.get('description','')}\n   🔗 {r['url']}" for i, r in enumerate(results)]
    print("\n\n".join(lines) or "未找到岗位，请先登录 Boss直聘。")
