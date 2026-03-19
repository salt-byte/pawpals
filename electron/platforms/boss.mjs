/**
 * Boss直聘 平台适配器
 *
 * 实现平台接口：
 *   login(cookieFile, serverPort)   — 弹窗让用户扫码登录，保存 cookie
 *   search(task, serverPort)        — 调内部 API 提取岗位列表
 *   apply(task, serverPort)         — DOM 自动化一键投递
 *
 * 所有方法自行创建 / 销毁 BrowserWindow，不对外暴露窗口对象。
 */

import fs from "fs";
import path from "path";
import { app, BrowserWindow } from "electron";

export const id   = "boss";
export const name = "Boss直聘";
export const supportsApply = true;  // 支持一键投递（Boss 有"立即沟通"按钮）

const PARTITION = "persist:boss"; // 登录 / 搜索 / 投递共用同一个 Chromium session
const UA = `Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/${process.versions.chrome || "136.0.0.0"} Safari/537.36`;

async function persistBossCookies(session, cookieFile) {
  const all = await session.cookies.get({});
  const filtered = all.filter((c) => c.domain?.includes("zhipin.com"));
  const formatted = filtered.map((c) => ({
    name: c.name,
    value: c.value,
    domain: c.domain,
    path: c.path,
    secure: c.secure,
    httpOnly: c.httpOnly,
    expirationDate: c.expirationDate,
  }));
  fs.mkdirSync(path.dirname(cookieFile), { recursive: true });
  fs.writeFileSync(cookieFile, JSON.stringify({ cookies: formatted, savedAt: new Date().toISOString() }, null, 2));
  return formatted;
}

function looksLoggedIn(url, html = "") {
  const lowerUrl = String(url || "").toLowerCase();
  const lowerHtml = String(html || "").toLowerCase();
  return (
    lowerUrl.includes("/web/geek/job") ||
    lowerUrl.includes("/web/geek/home") ||
    lowerUrl.includes("/web/user/home") ||
    lowerUrl.includes("zpgeek") ||
    lowerHtml.includes("消息") ||
    lowerHtml.includes("简历") ||
    lowerHtml.includes("首页") ||
    lowerHtml.includes("职位")
  );
}

// ── 登录 ────────────────────────────────────────────────────────────────────
export async function login(cookieFile, serverPort) {
  await new Promise(async (resolve) => {
    let resolved = false;
    console.log(`[PawPals] opening Boss login window, cookieFile=${cookieFile}`);

    const win = new BrowserWindow({
      show: true,
      width: 1100, height: 800,
      title: "登录 Boss直聘 — 登录成功后窗口自动关闭",
      webPreferences: { partition: PARTITION, contextIsolation: true },
    });
    win.webContents.setUserAgent(UA);
    app.focus({ steal: true });
    win.show();
    win.focus();

    const ses = win.webContents.session;

    const finish = async (ok, error) => {
      if (resolved) return;
      resolved = true;
      await fetch(`http://127.0.0.1:${serverPort}/api/internal/boss-login-done`, {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ ok, error }),
        signal: AbortSignal.timeout(5000),
      }).catch(() => {});
      resolve();
    };

    const tryPersistIfLoggedIn = async (url) => {
      if (resolved) return;
      try {
        const html = await win.webContents.executeJavaScript("document.documentElement?.innerText?.slice(0, 1200) || ''").catch(() => "");
        if (!looksLoggedIn(url, html)) return;
        const formatted = await persistBossCookies(ses, cookieFile);
        if (formatted.length === 0) return;
        console.log(`[PawPals] Boss login succeeded, saved ${formatted.length} cookies`);
        await finish(true, null);
        setTimeout(() => { try { win.close(); } catch {} }, 1500);
      } catch (e) {
        console.warn("[PawPals] Boss login cookie capture failed:", e.message);
        await finish(false, e.message);
      }
    };

    const onNavigate = async (url) => {
      if (resolved) return;
      if (url.includes("zhipin.com")) {
        try {
          await tryPersistIfLoggedIn(url);
        } catch (e) {
          console.warn("[PawPals] Boss login navigate check failed:", e.message);
        }
      }
    };

    win.webContents.on("did-navigate", (_e, url) => onNavigate(url));
    win.webContents.on("did-navigate-in-page", (_e, url) => onNavigate(url));
    win.webContents.on("did-finish-load", () => {
      void tryPersistIfLoggedIn(win.webContents.getURL());
    });
    win.on("closed", async () => {
      console.log("[PawPals] Boss login window closed");
      if (!resolved) await finish(false, "窗口被关闭");
    });

    try {
      await win.loadURL("https://www.zhipin.com/web/user/?ka=header-login");
    } catch (error) {
      await finish(false, error?.message || "loadURL failed");
      try { win.close(); } catch {}
    }
  });
}

// ── 搜索 ────────────────────────────────────────────────────────────────────
export async function search(task, serverPort) {
  const { id: taskId, query, city, careerDir, cookieFile } = task;

  const win = new BrowserWindow({
    show: false, width: 1280, height: 800,
    webPreferences: { partition: PARTITION, contextIsolation: true },
  });
  win.webContents.setUserAgent(UA);

  let result = "BOSS_FAILED";
  try {
    await win.loadURL("https://www.zhipin.com/web/geek/job");
    await new Promise(r => setTimeout(r, 3000));
    if (cookieFile) {
      try {
        const formatted = await persistBossCookies(win.webContents.session, cookieFile);
        if (formatted.length > 0) {
          console.log(`[PawPals] refreshed Boss cookies during search: ${formatted.length}`);
        }
      } catch (error) {
        console.warn("[PawPals] failed to refresh Boss cookies during search:", error?.message || error);
      }
    }

    const cityCode = city && /^\d{9}$/.test(city) ? city : "101010100";
    const params = new URLSearchParams({
      query, city: cityCode, page: "1", pageSize: "20",
      jobType: "", salary: "", experience: "", degree: "",
      industry: "", position: "", scale: "", stage: "",
      multiBusinessDistrict: "", multiSubway: "",
    });

    const raw = await win.webContents.executeJavaScript(`
      fetch('/wapi/zpgeek/search/joblist.json?' + ${JSON.stringify(params.toString())}, {
        headers: { 'Accept': 'application/json, text/plain, */*', 'X-Requested-With': 'XMLHttpRequest',
                   'Referer': 'https://www.zhipin.com/web/geek/job' },
        credentials: 'include',
      }).then(r => r.json()).then(d => JSON.stringify(d)).catch(e => JSON.stringify({ error: e.message }))
    `);

    const data = JSON.parse(raw);
    if (data.code === 0) {
      const jobs = data?.zpData?.jobList || [];
      if (jobs.length > 0) {
        const rows = jobs.slice(0, 15).map((job, i) => {
          const url = job.encryptJobId
            ? `https://www.zhipin.com/job_detail/${job.encryptJobId}.html` : "";
          return `| ${i + 1} | ${job.jobName || ""} | ${job.brandName || ""} | ${job.salaryDesc || ""} | ${job.areaDistrict || job.cityName || ""} | ${url ? `[投递](${url})` : "-"} |`;
        });
        result = ["| # | 职位 | 公司 | 薪资 | 地点 | 投递链接 |", "|---|------|------|------|------|---------|", ...rows].join("\n");

        // 保存到 jobs.json
        try {
          const dir = careerDir || path.join(app.getPath("home"), "Library", "Application Support", "PawPals", "openclaw", "workspace", "career");
          fs.mkdirSync(dir, { recursive: true });
          const jobsFile = path.join(dir, "jobs.json");
          const existing = fs.existsSync(jobsFile) ? JSON.parse(fs.readFileSync(jobsFile, "utf8")) : [];
          const existUrls = new Set(existing.map(j => j.url));
          const newJobs = jobs.slice(0, 15).map(job => ({
            company: job.brandName, title: job.jobName,
            url: job.encryptJobId ? `https://www.zhipin.com/job_detail/${job.encryptJobId}.html` : "",
            salary: job.salaryDesc, city: job.areaDistrict || job.cityName,
            source: "boss", applied: false,
          })).filter(j => j.url && !existUrls.has(j.url));
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
  } finally {
    try { win.close(); } catch {}
  }

  await fetch(`http://127.0.0.1:${serverPort}/api/internal/browser-search-done`, {
    method: "POST", headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ id: taskId, result }),
    signal: AbortSignal.timeout(5000),
  }).catch(() => {});
}

// ── 投递 ────────────────────────────────────────────────────────────────────
// Boss直聘"立即沟通"流程：
// 1. 打开岗位详情页（show: true 让用户能看到）
// 2. 点击"立即沟通"按钮 → Boss 会跳转到聊天页面
// 3. 在聊天页面输入招呼语并发送
// 4. 到此结束，不再自动附简历文件
export async function apply(task, serverPort) {
  const { id: taskId, jobUrl, greeting } = task;

  const win = new BrowserWindow({
    show: true, width: 1280, height: 800,
    title: "PawPals 正在投递...",
    webPreferences: { partition: PARTITION, contextIsolation: true },
  });
  win.webContents.setUserAgent(UA);

  let result = "NO_BUTTON";
  try {
    await win.loadURL(jobUrl);
    await new Promise(r => setTimeout(r, 3000));

    // Step 1: 在岗位详情页找到"立即沟通"按钮并点击
    const clickResult = await win.webContents.executeJavaScript(`
      (() => {
        const pageText = (document.body?.innerText || "").slice(0, 1200);
        if (/扫码登录|登录|注册/.test(pageText) && !document.querySelector('a.btn-startchat, .btn-startchat, a[ka="job_detail_chat"]')) {
          return 'NEED_LOGIN';
        }
        // Boss直聘 2024-2026 版本的按钮选择器
        const selectors = [
          'a.btn-startchat',
          '.btn-startchat',
          'a[ka="job_detail_chat"]',
          '.job-detail-box .btn-startchat',
          '.btn.btn-startchat.btn-page',
          'div.btn-container a.btn',
          '.job-op .btn-primary',
        ];
        for (const sel of selectors) {
          const btn = document.querySelector(sel);
          if (btn) {
            const text = btn.textContent || "";
            if (text.includes('继续沟通')) return 'ALREADY_APPLIED';
            btn.click();
            return 'CLICKED';
          }
        }
        return 'NO_BUTTON:' + document.title + '|' + document.URL;
      })()
    `);

    console.log("[boss-apply] click result:", clickResult);

    if (clickResult === 'ALREADY_APPLIED') {
      result = 'ALREADY_APPLIED';
    } else if (clickResult === 'NEED_LOGIN') {
      result = 'NEED_LOGIN';
    } else if (clickResult === 'CLICKED') {
      // Step 2: 等待页面跳转到聊天页 或 弹出聊天窗口
      await new Promise(r => setTimeout(r, 4000));

      // Step 3: 在聊天页面输入招呼语
      const greetingText = greeting || "您好！对贵司这个岗位很感兴趣，期待与您进一步沟通！";
      result = await win.webContents.executeJavaScript(`
        (async () => {
          const sleep = ms => new Promise(r => setTimeout(r, ms));
          const greeting = ${JSON.stringify(greetingText)};

          // 等待聊天输入框出现（Boss 可能跳转到 /web/geek/chat 页面）
          let input = null;
          for (let i = 0; i < 15; i++) {
            input = document.querySelector([
              '#chat-input',
              '.chat-input textarea',
              'div[contenteditable="true"].edit-area',
              '.chat-conversation [contenteditable="true"]',
              '.chat-im [contenteditable="true"]',
              'div.chat-input [contenteditable]',
              '[contenteditable="true"]',
            ].join(', '));
            if (input && input.offsetParent !== null) break;
            input = null;
            await sleep(500);
          }
          if (!input) {
            // 如果已经到了聊天页，说明沟通已发起（Boss可能自动发送了打招呼语）
            if (document.URL.includes('/chat') || document.URL.includes('geek/new')) {
              return 'SUCCESS';
            }
            return 'NO_INPUT:' + document.title + '|' + document.URL;
          }

          // 输入招呼语
          input.focus();
          await sleep(200);
          if (input.tagName === 'TEXTAREA' || input.tagName === 'INPUT') {
            const proto = input.tagName === 'TEXTAREA' ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
            const setter = Object.getOwnPropertyDescriptor(proto, 'value')?.set;
            if (setter) setter.call(input, greeting); else input.value = greeting;
            input.dispatchEvent(new Event('input', { bubbles: true }));
            input.dispatchEvent(new Event('change', { bubbles: true }));
          } else {
            // contenteditable div
            input.innerHTML = '';
            input.focus();
            document.execCommand('insertText', false, greeting);
            input.dispatchEvent(new Event('input', { bubbles: true }));
          }
          await sleep(500);

          // 发送：先找发送按钮，找不到就按 Enter
          const sendSelectors = [
            'button.btn-send',
            'button[class*="send"]',
            '.chat-op button',
            '.input-action button',
            '.chat-conversation button[type="submit"]',
            '.chat-im .btn-send',
          ];
          for (const sel of sendSelectors) {
            const send = document.querySelector(sel);
            if (send && send.offsetParent !== null) {
              send.click();
              return 'SUCCESS';
            }
          }
          // 回车发送
          input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', keyCode: 13, which: 13, bubbles: true }));
          await sleep(200);
          input.dispatchEvent(new KeyboardEvent('keypress', { key: 'Enter', keyCode: 13, which: 13, bubbles: true }));
          input.dispatchEvent(new KeyboardEvent('keyup', { key: 'Enter', keyCode: 13, which: 13, bubbles: true }));
          return 'SUCCESS';
        })()
      `);
    } else {
      result = clickResult; // NO_BUTTON:...
    }

    console.log("[boss-apply] final result:", result);
  } catch (e) {
    result = "ERROR: " + e.message;
    console.error("[boss-apply] error:", e);
  } finally {
    // 投递完成后延迟关闭，让用户看到结果
    setTimeout(() => { try { win.close(); } catch {} }, 5000);
  }

  await fetch(`http://127.0.0.1:${serverPort}/api/internal/browser-task-done`, {
    method: "POST", headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ id: taskId, result }),
    signal: AbortSignal.timeout(5000),
  }).catch(() => {});
}
