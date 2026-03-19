import { BrowserWindow } from "electron";

export const id = "web-form";
export const name = "官网申请";
export const supportsApply = true;

const PARTITION = "persist:web-form";
const UA = `Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/${process.versions.chrome || "136.0.0.0"} Safari/537.36`;

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

async function clickApplyEntry(win) {
  return await win.webContents.executeJavaScript(`
    (() => {
      const buttons = [...document.querySelectorAll("button, a, input[type=button], input[type=submit]")];
      for (const el of buttons) {
        const text = (el.innerText || el.value || el.textContent || "").trim();
        if (/apply|application|submit application|立即申请|投递|申请职位|我要应聘|申请/.test(text.toLowerCase())) {
          el.click();
          return true;
        }
      }
      return false;
    })()
  `);
}

export async function apply(task, serverPort) {
  const { id: taskId, jobUrl, company, title } = task;
  const win = new BrowserWindow({
    show: true,
    width: 1280,
    height: 900,
    title: "PawPals 正在填写官网申请",
    webPreferences: { partition: PARTITION, contextIsolation: true },
  });
  win.webContents.setUserAgent(UA);

  let result = "NO_FORM";
  try {
    await win.loadURL(jobUrl);
    await new Promise((r) => setTimeout(r, 3000));

    let fields = await scanFields(win);
    if (!fields.length) {
      const clicked = await clickApplyEntry(win);
      if (clicked) {
        await new Promise((r) => setTimeout(r, 2500));
        fields = await scanFields(win);
      }
    }

    if (!fields.length) {
      result = "NO_FORM";
    } else {
      const fillResp = await fetch(`http://127.0.0.1:${serverPort}/api/internal/browser-fill-form`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          url: jobUrl,
          company,
          title,
          fields,
        }),
        signal: AbortSignal.timeout(8000),
      }).then((r) => r.json()).catch(() => ({ values: [] }));

      const values = Array.isArray(fillResp?.values) ? fillResp.values : [];
      if (!values.length) {
        result = "NO_FORM_DATA";
      } else {
        await win.webContents.executeJavaScript(`
          (() => {
            const values = ${JSON.stringify(values)};
            for (const item of values) {
              const el = document.querySelector('[data-pawpals-field-index="' + item.index + '"]');
              if (!el) continue;
              const value = item.value || "";
              if (el.tagName === "SELECT") {
                const options = [...el.querySelectorAll("option")];
                const target = options.find((opt) => opt.value === value || (opt.textContent || "").trim() === value);
                if (target) {
                  el.value = target.value;
                  el.dispatchEvent(new Event("change", { bubbles: true }));
                }
                continue;
              }
              if (el.tagName === "TEXTAREA" || el.tagName === "INPUT") {
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

        const submitted = await win.webContents.executeJavaScript(`
          (() => {
            const buttons = [...document.querySelectorAll("button, input[type=submit], a")];
            for (const el of buttons) {
              const text = (el.innerText || el.value || el.textContent || "").trim().toLowerCase();
              if (/submit|apply|send application|确认申请|提交申请|投递简历|立即申请|申请职位/.test(text)) {
                el.click();
                return true;
              }
            }
            return false;
          })()
        `);
        result = submitted ? "SUCCESS" : "FILLED_ONLY";
      }
    }
  } catch (error) {
    result = `ERROR: ${error?.message || error}`;
  } finally {
    setTimeout(() => {
      try { win.close(); } catch {}
    }, 5000);
  }

  await fetch(`http://127.0.0.1:${serverPort}/api/internal/browser-task-done`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ id: taskId, result }),
    signal: AbortSignal.timeout(5000),
  }).catch(() => {});
}
