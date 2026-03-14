#!/usr/bin/env python3
"""apply_job: 用 Playwright 在 Boss直聘自动投递岗位。
用法: python apply_job.py <job_url> <company> <title> [greeting]
"""
import asyncio, json, pathlib, sys

COOKIE_PATH = pathlib.Path.home() / ".jobclaw/cookies/boss.json"

job_url  = sys.argv[1]
company  = sys.argv[2]
title    = sys.argv[3]
greeting = sys.argv[4] if len(sys.argv) > 4 else f"您好！我是邓雨蝶，USC数据科学在读，曾在智谱AI做AI产品经理，对{title}岗位很感兴趣，期待与您沟通！"

if not COOKIE_PATH.exists():
    print("NEED_LOGIN"); sys.exit(1)

cookies = json.loads(COOKIE_PATH.read_text())["cookies"]

async def apply():
    from playwright.async_api import async_playwright
    async with async_playwright() as pw:
        browser = await pw.chromium.launch(headless=True, args=["--disable-blink-features=AutomationControlled","--no-sandbox"])
        ctx = await browser.new_context(
            user_agent="Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36",
            viewport={"width":1280,"height":800}
        )
        await ctx.add_init_script("Object.defineProperty(navigator,'webdriver',{get:()=>undefined})")
        await ctx.add_cookies(cookies)
        page = await ctx.new_page()
        await page.goto(job_url, wait_until="domcontentloaded", timeout=30000)
        await asyncio.sleep(1.5)

        if "/web/user" in page.url or "passport" in page.url:
            print("NEED_LOGIN"); await browser.close(); return

        for sel in ["a:has-text('继续沟通')"]:
            el = await page.query_selector(sel)
            if el and await el.is_visible():
                print("ALREADY_APPLIED"); await browser.close(); return

        btn = None
        for sel in ["a.btn-startchat",".job-detail-box .btn-startchat","a[ka='job_detail_chat']","a:has-text('立即沟通')"]:
            el = await page.query_selector(sel)
            if el and await el.is_visible():
                btn = el; break

        if not btn:
            print("NO_BUTTON"); await browser.close(); return

        await btn.click()
        await asyncio.sleep(2.5)

        chat_input = None
        for sel in ["#chat-input",".chat-input textarea","div.edit-area [contenteditable='true']","textarea[name='msg']"]:
            el = await page.query_selector(sel)
            if el and await el.is_visible():
                chat_input = el; break

        if chat_input:
            await chat_input.click()
            await chat_input.fill("")
            await page.keyboard.type(greeting, delay=40)
            await asyncio.sleep(0.8)
            sent = False
            for sel in ["button.btn-send","button:has-text('发送')",".chat-op button"]:
                el = await page.query_selector(sel)
                if el and await el.is_visible():
                    await el.click(); sent = True; break
            if not sent:
                await page.keyboard.press("Enter")
            await asyncio.sleep(1)
            print("SUCCESS")
        else:
            print("DEFAULT_SENT")
        await browser.close()

asyncio.run(apply())
