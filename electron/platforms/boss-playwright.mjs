/**
 * Boss直聘 平台适配器 — Playwright + 持久化 profile 版本
 *
 * 与 boss.mjs 接口完全一致（login / search / apply），通过 PAWPALS_USE_PLAYWRIGHT
 * 环境变量在 main.mjs 切换。
 *
 * 反爬关键点：
 *   1. 用真 Chromium（Playwright 自带），不是 Electron 内嵌 Chromium
 *   2. launchPersistentContext + 固定 user-data-dir → cookies/history/localStorage 跨次复用
 *   3. headful（headless: false）+ 关 AutomationControlled flag → navigator.webdriver = false
 *   4. 与 Electron 主进程隔离，UI 操作走独立 Chromium 窗口
 *
 * 进程模型：
 *   - 整个 app 生命周期内**只启动一个** persistent context（单例）
 *   - 每次 apply/search 新开一个 page（tab），完成后关闭 tab
 *   - 用户关闭窗口 → 下一次调用时自动重启
 */

import fs from "fs";
import path from "path";
import { app } from "electron";
import {
  humanDelay,
  humanScroll,
  humanClick,
  humanType,
} from "./human-behavior.mjs";

// 注意：playwright 用动态 import（见 ensureContext），不要静态 import。
// 原因：打包模式下 Playwright 找 Chromium 二进制要看 PLAYWRIGHT_BROWSERS_PATH，
// 这个环境变量必须在 playwright 模块加载之前设置——静态 import 会被 ESM 提升到
// 任何代码运行之前，没法及时 set。所以延迟到 ensureContext 里 dynamic import。

export const id = "boss";
export const name = "Boss直聘";
export const supportsApply = true;

// 持久化 profile 路径：~/Library/Application Support/PawPals/playwright-profile-boss/
const PROFILE_DIR = path.join(
  app.getPath("userData"),
  "playwright-profile-boss"
);

// 用 Chrome 而非 Chromium 的 UA（虽然底层是 Chromium，但 UA 串里写 "Chrome" 更隐蔽）
const UA =
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36";

// 单例 context（整个 app 生命周期内复用）
let _ctx = null;
let _initPromise = null;

async function ensureContext() {
  // context 还在 → 直接复用
  if (_ctx && _ctx.browser()?.isConnected() !== false) {
    try {
      // 探活：访问一下 pages，失败说明 context 已关
      _ctx.pages();
      return _ctx;
    } catch {
      _ctx = null;
    }
  }
  // 正在启动 → 等同一个 promise，避免并发重复启动
  if (_initPromise) return _initPromise;

  _initPromise = (async () => {
    try {
      // 打包模式下，把 Playwright 的 Chromium 路径指向 app.asar.unpacked 里的 node_modules
      // （配合 postinstall 用 PLAYWRIGHT_BROWSERS_PATH=0 把 Chromium 装进 node_modules）
      if (app.isPackaged && !process.env.PLAYWRIGHT_BROWSERS_PATH) {
        process.env.PLAYWRIGHT_BROWSERS_PATH = path.join(
          process.resourcesPath,
          "app.asar.unpacked",
          "node_modules",
          "playwright-core",
          ".local-browsers"
        );
        console.log(
          `[boss-playwright] packaged mode, PLAYWRIGHT_BROWSERS_PATH=${process.env.PLAYWRIGHT_BROWSERS_PATH}`
        );
      }

      // 动态 import，确保上面 env 设置后才加载 playwright
      const { chromium } = await import("playwright");

      fs.mkdirSync(PROFILE_DIR, { recursive: true });
      console.log(`[boss-playwright] launching persistent context at ${PROFILE_DIR}`);
      _ctx = await chromium.launchPersistentContext(PROFILE_DIR, {
        headless: false,
        viewport: null,             // 跟随窗口大小，看起来更像真人
        userAgent: UA,
        locale: "zh-CN",
        timezoneId: "Asia/Shanghai",
        args: [
          "--disable-blink-features=AutomationControlled", // 关 webdriver 标记
          "--no-default-browser-check",
          "--no-first-run",
          "--disable-features=IsolateOrigins,site-per-process",
          "--window-size=1280,860",
        ],
        ignoreDefaultArgs: ["--enable-automation"], // 移除自动化 flag
      });

      // 额外：patch navigator.webdriver（最后保险）
      await _ctx.addInitScript(() => {
        Object.defineProperty(navigator, "webdriver", { get: () => false });
      });

      _ctx.on("close", () => {
        console.log("[boss-playwright] context closed");
        _ctx = null;
      });
      return _ctx;
    } finally {
      _initPromise = null;
    }
  })();
  return _initPromise;
}

function looksLoggedIn(url, text = "") {
  const u = String(url || "").toLowerCase();
  const t = String(text || "").toLowerCase();
  return (
    u.includes("/web/geek/job") ||
    u.includes("/web/geek/home") ||
    u.includes("/web/user/home") ||
    u.includes("zpgeek") ||
    t.includes("消息") ||
    t.includes("简历") ||
    t.includes("首页") ||
    t.includes("职位")
  );
}

// persist:boss partition 已经写在 boss.mjs 里独立持久化 cookie 文件。
// Playwright 路径下，cookies 已经在 PROFILE_DIR 里持久化，所以 cookieFile 可选。
// 为兼容 server.ts 期望（它会读 cookie 文件判断登录状态），我们额外导出 cookies 一份。
async function exportCookiesToFile(ctx, cookieFile) {
  if (!cookieFile) return [];
  try {
    const all = await ctx.cookies();
    const filtered = all.filter((c) => c.domain?.includes("zhipin.com"));
    const formatted = filtered.map((c) => ({
      name: c.name,
      value: c.value,
      domain: c.domain,
      path: c.path,
      secure: c.secure,
      httpOnly: c.httpOnly,
      expirationDate: c.expires > 0 ? c.expires : undefined,
    }));
    fs.mkdirSync(path.dirname(cookieFile), { recursive: true });
    fs.writeFileSync(
      cookieFile,
      JSON.stringify({ cookies: formatted, savedAt: new Date().toISOString() }, null, 2)
    );
    return formatted;
  } catch (e) {
    console.warn("[boss-playwright] export cookies failed:", e.message);
    return [];
  }
}

// ── 登录 ────────────────────────────────────────────────────────────────────
export async function login(cookieFile, serverPort) {
  const ctx = await ensureContext();
  const page = await ctx.newPage();

  let finished = false;
  const finish = async (ok, error) => {
    if (finished) return;
    finished = true;
    await fetch(`http://127.0.0.1:${serverPort}/api/internal/boss-login-done`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ ok, error }),
      signal: AbortSignal.timeout(5000),
    }).catch(() => {});
  };

  try {
    console.log("[boss-playwright] opening login page");
    await page.goto("https://www.zhipin.com/web/user/?ka=header-login", {
      waitUntil: "domcontentloaded",
      timeout: 60_000,
    });

    // 轮询页面状态，最多等 3 分钟
    const start = Date.now();
    while (Date.now() - start < 180_000) {
      const url = page.url();
      let text = "";
      try {
        text = await page.evaluate(
          () => document.documentElement?.innerText?.slice(0, 1200) || ""
        );
      } catch {}
      if (looksLoggedIn(url, text)) {
        const saved = await exportCookiesToFile(ctx, cookieFile);
        console.log(`[boss-playwright] login success, saved ${saved.length} cookies`);
        await finish(true, null);
        setTimeout(() => page.close().catch(() => {}), 1500);
        return;
      }
      if (page.isClosed()) {
        await finish(false, "用户关闭了登录页");
        return;
      }
      await new Promise((r) => setTimeout(r, 2000));
    }
    await finish(false, "登录超时（3 分钟）");
    page.close().catch(() => {});
  } catch (e) {
    console.error("[boss-playwright] login error:", e);
    await finish(false, e.message);
    page.close().catch(() => {});
  }
}

// ── 搜索 ────────────────────────────────────────────────────────────────────
export async function search(task, serverPort) {
  const { id: taskId, query, city, careerDir, cookieFile } = task;
  const ctx = await ensureContext();
  const page = await ctx.newPage();
  let result = "BOSS_FAILED";

  try {
    await page.goto("https://www.zhipin.com/web/geek/job", {
      waitUntil: "domcontentloaded",
      timeout: 60_000,
    });
    await page.waitForTimeout(3000);

    // 顺手刷新 cookie 文件
    if (cookieFile) await exportCookiesToFile(ctx, cookieFile);

    // 检查是否需验证/登录
    const needsAction = await page.evaluate(() => {
      return (
        !!document.querySelector(
          ".verify-wrap, .slide-verify, #captcha, .login-wrap, .sign-wrap, .login-btn, .qr-code-wrap"
        ) ||
        document.title.includes("验证") ||
        document.title.includes("登录") ||
        window.location.href.includes("/web/user/")
      );
    }).catch(() => false);

    if (needsAction) {
      console.log("[boss-playwright] needs login/verify, waiting...");
      // 等用户完成（最多 3 分钟）
      const start = Date.now();
      while (Date.now() - start < 180_000) {
        const url = page.url();
        if (url.includes("/web/geek/job") || url.includes("/web/geek/home")) break;
        const still = await page.evaluate(() => {
          return (
            !!document.querySelector(
              ".verify-wrap, .slide-verify, #captcha, .login-wrap, .sign-wrap, .qr-code-wrap"
            ) ||
            document.title.includes("验证") ||
            document.title.includes("登录") ||
            window.location.href.includes("/web/user/")
          );
        }).catch(() => false);
        if (!still) break;
        if (page.isClosed()) break;
        await page.waitForTimeout(2000);
      }
      if (!page.url().includes("/web/geek/job")) {
        await page.goto("https://www.zhipin.com/web/geek/job", { waitUntil: "domcontentloaded" });
      }
      await page.waitForTimeout(3000);
    }

    const cityCode = city && /^\d{9}$/.test(city) ? city : "101010100";
    const params = new URLSearchParams({
      query, city: cityCode, page: "1", pageSize: "20",
      jobType: "", salary: "", experience: "", degree: "",
      industry: "", position: "", scale: "", stage: "",
      multiBusinessDistrict: "", multiSubway: "",
    });

    const raw = await page.evaluate(async (qs) => {
      try {
        const r = await fetch("/wapi/zpgeek/search/joblist.json?" + qs, {
          headers: {
            Accept: "application/json, text/plain, */*",
            "X-Requested-With": "XMLHttpRequest",
            Referer: "https://www.zhipin.com/web/geek/job",
          },
          credentials: "include",
        });
        const d = await r.json();
        return JSON.stringify(d);
      } catch (e) {
        return JSON.stringify({ error: e.message });
      }
    }, params.toString());

    const data = JSON.parse(raw);
    if (data.code === 0) {
      const jobs = data?.zpData?.jobList || [];
      if (jobs.length > 0) {
        const rows = jobs.slice(0, 15).map((job, i) => {
          const url = job.encryptJobId
            ? `https://www.zhipin.com/job_detail/${job.encryptJobId}.html`
            : "";
          return `| ${i + 1} | ${job.jobName || ""} | ${job.brandName || ""} | ${job.salaryDesc || ""} | ${job.areaDistrict || job.cityName || ""} | ${url ? `[投递](${url})` : "-"} |`;
        });
        result = [
          "| # | 职位 | 公司 | 薪资 | 地点 | 投递链接 |",
          "|---|------|------|------|------|---------|",
          ...rows,
        ].join("\n");

        try {
          const dir =
            careerDir ||
            path.join(app.getPath("home"), "Library", "Application Support", "PawPals", "workspace", "career");
          fs.mkdirSync(dir, { recursive: true });
          const jobsFile = path.join(dir, "jobs.json");
          const existing = fs.existsSync(jobsFile)
            ? JSON.parse(fs.readFileSync(jobsFile, "utf8"))
            : [];
          const existUrls = new Set(existing.map((j) => j.url));
          const newJobs = jobs
            .slice(0, 15)
            .map((job) => ({
              company: job.brandName,
              title: job.jobName,
              url: job.encryptJobId
                ? `https://www.zhipin.com/job_detail/${job.encryptJobId}.html`
                : "",
              salary: job.salaryDesc,
              city: job.areaDistrict || job.cityName,
              source: "boss",
              applied: false,
            }))
            .filter((j) => j.url && !existUrls.has(j.url));
          fs.writeFileSync(jobsFile, JSON.stringify([...existing, ...newJobs], null, 2));
        } catch {}
      } else {
        result = "未找到相关岗位，换个关键词试试。";
      }
    } else if (data.code === 301 || data.message?.includes("登录") || data.message?.includes("异常")) {
      result = "NEED_LOGIN";
    } else {
      result = `Boss直聘返回: ${data.message || "未知错误"}`;
    }
  } catch (e) {
    result = `搜索出错: ${e.message}`;
    console.error("[boss-playwright] search error:", e);
  } finally {
    page.close().catch(() => {});
  }

  await fetch(`http://127.0.0.1:${serverPort}/api/internal/browser-search-done`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ id: taskId, result }),
    signal: AbortSignal.timeout(5000),
  }).catch(() => {});
}

// ── 投递 ────────────────────────────────────────────────────────────────────
// 所有点击/输入都走 Playwright locator（底层 CDP Input.dispatch* → 真 OS 事件，
// trusted=true），不再用 page.evaluate(... .click()) 的 JS dispatchEvent
// （那种 trusted=false，前端能识破）
//
// 节奏上塞 humanDelay / humanScroll / humanClick / humanType 让行为像人

const APPLY_BTN_SELECTORS = [
  "a.btn-startchat",
  ".btn-startchat",
  'a[ka="job_detail_chat"]',
  ".job-detail-box .btn-startchat",
  ".btn.btn-startchat.btn-page",
  ".job-op .btn-primary",
];

const CHAT_INPUT_SELECTORS = [
  "#chat-input",
  ".chat-input textarea",
  'div[contenteditable="true"].edit-area',
  '.chat-conversation [contenteditable="true"]',
  '.chat-im [contenteditable="true"]',
  "div.chat-input [contenteditable]",
  '[contenteditable="true"]',
];

const SEND_BTN_SELECTORS = [
  "button.btn-send",
  'button[class*="send"]',
  ".chat-op button",
  ".input-action button",
  '.chat-conversation button[type="submit"]',
  ".chat-im .btn-send",
];

async function findVisibleLocator(page, selectors) {
  for (const sel of selectors) {
    const loc = page.locator(sel).first();
    const count = await loc.count().catch(() => 0);
    if (count === 0) continue;
    const visible = await loc.isVisible().catch(() => false);
    if (!visible) continue;
    return loc;
  }
  return null;
}

async function runApplyFlow(page, jobUrl, greeting) {
  console.log("[boss-playwright] apply →", jobUrl);
  await page.goto(jobUrl, { waitUntil: "domcontentloaded", timeout: 60_000 });

  // 人类节奏：页面加载完先停一下再行动
  await humanDelay(1200, 2400);

  // 阅读 JD：滚动 + 停留（关键！没人打开 JD 立刻点投递）
  await humanScroll(page, 400 + Math.random() * 400);
  await humanDelay(1500, 3000);

  // 找"立即沟通"按钮
  const applyBtn = await findVisibleLocator(page, APPLY_BTN_SELECTORS);

  if (!applyBtn) {
    // 没按钮：可能是登录页，也可能页面下线
    const earlyText = await page.locator("body").innerText().catch(() => "");
    if (/扫码登录|登录|注册/.test(earlyText.slice(0, 1200))) {
      return "NEED_LOGIN";
    }
    return "NO_BUTTON:" + (await page.title().catch(() => "")) + "|" + page.url();
  }

  const btnText = (await applyBtn.textContent().catch(() => "")) || "";
  if (btnText.includes("继续沟通")) return "ALREADY_APPLIED";

  // 人类点击（贝塞尔轨迹 → off-center → CDP 真事件）
  await humanClick(page, applyBtn);

  // 等聊天界面 / 跳转
  await humanDelay(3500, 5500);

  // 找聊天输入框（最多等 15 * 500ms ≈ 7.5 秒）
  let chatInput = null;
  for (let attempt = 0; attempt < 15; attempt++) {
    chatInput = await findVisibleLocator(page, CHAT_INPUT_SELECTORS);
    if (chatInput) break;
    // 没找到，可能 Boss 已经自动发了招呼语，URL 进 /chat
    if (page.url().includes("/chat") || page.url().includes("geek/new")) {
      return "SUCCESS";
    }
    await humanDelay(400, 700);
  }

  if (!chatInput) {
    if (page.url().includes("/chat") || page.url().includes("geek/new")) return "SUCCESS";
    return "NO_INPUT:" + (await page.title().catch(() => "")) + "|" + page.url();
  }

  // 点击输入框 → 真键盘逐字输入 → 微停（重读）→ 发送
  const greetingText = greeting || "您好！对贵司这个岗位很感兴趣，期待与您进一步沟通！";
  await humanClick(page, chatInput);
  await humanDelay(300, 700);
  await humanType(page, greetingText);
  await humanDelay(500, 1200); // 发前重读

  const sendBtn = await findVisibleLocator(page, SEND_BTN_SELECTORS);
  if (sendBtn) {
    await humanClick(page, sendBtn);
  } else {
    // 兜底：Enter（真 CDP keypress）
    await page.keyboard.press("Enter");
  }
  return "SUCCESS";
}

export async function apply(task, serverPort) {
  const { id: taskId, jobUrl, greeting } = task;
  const ctx = await ensureContext();
  const page = await ctx.newPage();

  const result = await runApplyFlow(page, jobUrl, greeting).catch((e) => {
    console.error("[boss-playwright] apply error:", e);
    return "ERROR: " + e.message;
  });

  console.log("[boss-playwright] final result:", result);
  // 留 5 秒让用户看到结果再关 tab（context 保留）
  setTimeout(() => page.close().catch(() => {}), 5000);

  await fetch(`http://127.0.0.1:${serverPort}/api/internal/browser-task-done`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ id: taskId, result }),
    signal: AbortSignal.timeout(5000),
  }).catch(() => {});
}

// 暴露给 main.mjs 在 app quit 时清理
export async function shutdown() {
  if (_ctx) {
    try { await _ctx.close(); } catch {}
    _ctx = null;
  }
}
