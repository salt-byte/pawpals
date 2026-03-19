/**
 * 通用官网投递适配器
 *
 * 和 Boss 一样的模式：
 *   login(url)   — 弹窗让用户登录任意招聘网站，cookie 自动保存
 *   search(task)  — 在已登录的网站上搜索岗位
 *   apply(task)   — 点击投递/申请按钮（用户已有在线简历）
 *
 * 所有操作共用 persist:web-form partition，登录态持久化。
 */

import { BrowserWindow } from "electron";

export const id = "web-form";
export const name = "官网申请";
export const supportsApply = true;

const PARTITION = "persist:web-form";
const UA = `Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/${process.versions.chrome || "136.0.0.0"} Safari/537.36`;

// ── 登录 ────────────────────────────────────────────────────────────────
// 弹出可见窗口，让用户在任意招聘网站上登录
// 登录成功后 cookie 自动保存在 persist:web-form partition
export async function login(loginUrl, serverPort) {
  const win = new BrowserWindow({
    show: true,
    width: 1200, height: 800,
    title: "PawPals — 登录招聘网站（登录后关闭窗口即可）",
    webPreferences: { partition: PARTITION, contextIsolation: true },
  });
  win.webContents.setUserAgent(UA);
  await win.loadURL(loginUrl || "https://www.linkedin.com/login");

  // 等用户手动关闭窗口
  await new Promise((resolve) => {
    win.on("closed", () => resolve());
  });

  // 通知 server 登录完成
  await fetch(`http://127.0.0.1:${serverPort}/api/internal/browser-task-done`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ id: "web-login", result: "SUCCESS" }),
    signal: AbortSignal.timeout(5000),
  }).catch(() => {});
}

// ── 搜索 ────────────────────────────────────────────────────────────────
// 在已登录的网站上打开搜索页，让用户看到结果
export async function search(task, serverPort) {
  const { id: taskId, query, searchUrl } = task;

  const win = new BrowserWindow({
    show: true,
    width: 1280, height: 800,
    title: `PawPals — 搜索：${query}`,
    webPreferences: { partition: PARTITION, contextIsolation: true },
  });
  win.webContents.setUserAgent(UA);

  // 如果有指定搜索 URL，直接打开；否则打开通用搜索
  const url = searchUrl || `https://www.google.com/search?q=${encodeURIComponent(query + " 招聘")}`;
  await win.loadURL(url);

  // 等用户关闭窗口
  await new Promise((resolve) => {
    win.on("closed", () => resolve());
  });
}

// ── 投递 ────────────────────────────────────────────────────────────────
// 打开岗位链接，尝试点击"投递/申请"按钮
// 用户已登录 + 有在线简历，点击即完成投递
export async function apply(task, serverPort) {
  const { id: taskId, jobUrl, company, title } = task;
  const win = new BrowserWindow({
    show: true,
    width: 1280, height: 900,
    title: `PawPals — 投递：${company || ""} ${title || ""}`,
    webPreferences: { partition: PARTITION, contextIsolation: true },
  });
  win.webContents.setUserAgent(UA);

  let result = "NO_FORM";
  try {
    await win.loadURL(jobUrl);
    await new Promise((r) => setTimeout(r, 3000));

    // Step 1: 尝试点击"投递/申请/Apply"按钮
    const clickResult = await win.webContents.executeJavaScript(`
      (() => {
        const buttons = [...document.querySelectorAll("button, a, input[type=button], input[type=submit]")];
        for (const el of buttons) {
          const text = (el.innerText || el.value || el.textContent || "").trim().toLowerCase();
          if (/apply|submit.*application|投递|申请|立即申请|申请职位|我要应聘|easy apply|quick apply/.test(text)) {
            el.click();
            return 'CLICKED:' + text;
          }
        }
        return 'NO_BUTTON';
      })()
    `);

    console.log("[web-form] click result:", clickResult);

    if (clickResult.startsWith("CLICKED")) {
      await new Promise((r) => setTimeout(r, 3000));

      // Step 2: 检查是否需要填表单
      const fields = await scanFields(win);

      if (fields.length > 0) {
        // 有表单 → 调 LLM 填充
        const fillResp = await fetch(`http://127.0.0.1:${serverPort}/api/internal/browser-fill-form`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ url: jobUrl, company, title, fields }),
          signal: AbortSignal.timeout(8000),
        }).then((r) => r.json()).catch(() => ({ values: [] }));

        const values = Array.isArray(fillResp?.values) ? fillResp.values : [];
        if (values.length > 0) {
          await win.webContents.executeJavaScript(`
            (() => {
              const values = ${JSON.stringify(values)};
              for (const item of values) {
                const el = document.querySelector('[data-pawpals-field-index="' + item.index + '"]');
                if (!el) continue;
                const value = item.value || "";
                if (el.tagName === "SELECT") {
                  const target = [...el.querySelectorAll("option")].find(o => o.value === value || (o.textContent || "").trim() === value);
                  if (target) { el.value = target.value; el.dispatchEvent(new Event("change", { bubbles: true })); }
                } else {
                  const proto = el.tagName === "TEXTAREA" ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
                  const setter = Object.getOwnPropertyDescriptor(proto, "value")?.set;
                  if (setter) setter.call(el, value); else el.value = value;
                  el.dispatchEvent(new Event("input", { bubbles: true }));
                  el.dispatchEvent(new Event("change", { bubbles: true }));
                }
              }
            })()
          `);
          await new Promise((r) => setTimeout(r, 500));

          // 点提交
          const submitted = await win.webContents.executeJavaScript(`
            (() => {
              const buttons = [...document.querySelectorAll("button, input[type=submit], a")];
              for (const el of buttons) {
                const text = (el.innerText || el.value || el.textContent || "").trim().toLowerCase();
                if (/submit|apply|send|确认|提交|投递/.test(text)) { el.click(); return true; }
              }
              return false;
            })()
          `);
          result = submitted ? "SUCCESS" : "FILLED_ONLY";
        } else {
          result = "NO_FORM_DATA";
        }
      } else {
        // 没有表单 → 可能一键投递已完成
        result = "SUCCESS";
      }
    } else {
      result = "NO_BUTTON";
    }

    console.log("[web-form] final result:", result);
  } catch (error) {
    result = `ERROR: ${error?.message || error}`;
    console.error("[web-form] error:", error);
  } finally {
    setTimeout(() => { try { win.close(); } catch {} }, 5000);
  }

  await fetch(`http://127.0.0.1:${serverPort}/api/internal/browser-task-done`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ id: taskId, result }),
    signal: AbortSignal.timeout(5000),
  }).catch(() => {});
}

// ── 辅助：扫描表单字段 ──────────────────────────────────────────────────
async function scanFields(win) {
  return await win.webContents.executeJavaScript(`
    (() => {
      const visible = (el) => {
        const style = window.getComputedStyle(el);
        const rect = el.getBoundingClientRect();
        return style.display !== "none" && style.visibility !== "hidden" && rect.width > 0 && rect.height > 0;
      };
      const readLabel = (el) => {
        const fromLabel = el.labels?.[0]?.innerText?.trim();
        if (fromLabel) return fromLabel;
        const aria = el.getAttribute("aria-label") || "";
        if (aria.trim()) return aria.trim();
        const placeholder = el.getAttribute("placeholder") || "";
        if (placeholder.trim()) return placeholder.trim();
        const parentText = el.closest("label, .field, .form-group, .application-question")?.innerText || "";
        return parentText.trim().slice(0, 80);
      };
      const candidates = [...document.querySelectorAll("input, textarea, select")]
        .filter((el) => {
          const type = (el.getAttribute("type") || "").toLowerCase();
          if (["hidden", "submit", "button", "reset", "checkbox", "radio"].includes(type)) return false;
          return visible(el);
        })
        .slice(0, 30);
      return candidates.map((el, index) => {
        el.setAttribute("data-pawpals-field-index", String(index));
        return {
          index,
          tag: el.tagName.toLowerCase(),
          type: (el.getAttribute("type") || "").toLowerCase(),
          name: el.getAttribute("name") || "",
          id: el.getAttribute("id") || "",
          label: readLabel(el),
          placeholder: el.getAttribute("placeholder") || "",
          options: el.tagName.toLowerCase() === "select"
            ? [...el.querySelectorAll("option")].map((opt) => ({
                value: opt.getAttribute("value") || "",
                text: (opt.textContent || "").trim(),
              })).slice(0, 20)
            : [],
        };
      });
    })()
  `);
}
