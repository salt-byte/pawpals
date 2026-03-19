import fs from "fs";
import { app, BrowserWindow, dialog, ipcMain, shell } from "electron";
import path from "path";
import { fileURLToPath } from "url";
import { getDeploymentFiles } from "../scripts/deployment-state.mjs";
import { startIsolatedRuntime } from "../scripts/runtime-launcher.mjs";
import * as bossPlatform from "./platforms/boss.mjs";
import * as webFormPlatform from "./platforms/web-form.mjs";

// ── 平台注册表 ─────────────────────────────────────────────────────────────
// 每个平台实现 login / search / apply 三个方法
// 新平台只需新建 platforms/<name>.mjs 并在这里注册
const PLATFORMS = {
  boss: bossPlatform,
  "web-form": webFormPlatform,
  // linkedin: linkedinPlatform,   // 未来扩展
  // lagou:    lagouPlatform,
};

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(__dirname, "..");
const unpackedRoot = app.isPackaged
  ? (fs.existsSync(path.join(process.resourcesPath, "app.asar.unpacked"))
      ? path.join(process.resourcesPath, "app.asar.unpacked")
      : path.join(process.resourcesPath, "app"))
  : repoRoot;

let mainWindow = null;
let runtime = null;
let runtimeStartPromise = null;
let applyPollInterval = null;
let applyingNow = false;

// ── 通用平台调度（login / search / apply 统一入口）────────────────────────
// 根据 task.platform 字段分发到对应平台适配器
// 新平台：在 PLATFORMS 注册表里加一行即可，这里不需要改

async function dispatchLogin(platformId, cookieFile, serverPort) {
  const platform = PLATFORMS[platformId];
  if (!platform) {
    console.warn(`[PawPals] 未知平台: ${platformId}`);
    return;
  }
  console.log(`[PawPals] 登录 ${platform.name}…`);
  await platform.login(cookieFile, serverPort);
}

async function dispatchSearch(task, serverPort) {
  const platformId = task.platform || "boss";
  const platform = PLATFORMS[platformId];
  if (!platform) {
    console.warn(`[PawPals] 未知平台: ${platformId}`);
    return;
  }
  console.log(`[PawPals] ${platform.name} 搜索 "${task.query}"`);
  await platform.search(task, serverPort);
}

async function dispatchApply(task, serverPort) {
  const platformId = task.platform || "boss";
  const platform = PLATFORMS[platformId];
  if (!platform?.supportsApply) {
    console.warn(`[PawPals] 平台 ${platformId} 不支持自动投递`);
    return;
  }
  console.log(`[PawPals] ${platform.name} 投递 ${task.jobUrl}`);
  await platform.apply(task, serverPort);
}

let loginNow = false;
let searchNow = false;

function startApplyPolling(serverUrl) {
  if (applyPollInterval) return;
  const port = new URL(serverUrl).port;
  console.log(`[PawPals] browser polling started on :${port}`);
  applyPollInterval = setInterval(async () => {
    // 投递任务（task.platform 指定平台，默认 boss）
    if (!applyingNow) {
      try {
        const r = await fetch(`http://127.0.0.1:${port}/api/internal/browser-task`,
          { signal: AbortSignal.timeout(2000) });
        if (!r.ok) throw new Error(`browser-task returned ${r.status}`);
        const { task } = await r.json();
        if (task) {
          console.log(`[PawPals] apply task received: ${task.id} → ${task.jobUrl}`);
          applyingNow = true;
          try {
            await dispatchApply(task, port);
          } catch (applyErr) {
            console.error("[PawPals] dispatchApply error:", applyErr?.message || applyErr);
            // 回报错误给 server，避免任务永远卡在队列里
            await fetch(`http://127.0.0.1:${port}/api/internal/browser-task-done`, {
              method: "POST", headers: { "Content-Type": "application/json" },
              body: JSON.stringify({ id: task.id, result: `ERROR:${applyErr?.message || "unknown"}` }),
              signal: AbortSignal.timeout(5000),
            }).catch(() => {});
          } finally {
            applyingNow = false;
          }
        }
      } catch (error) {
        console.warn("[PawPals] apply polling failed:", error?.message || error);
      }
    }
    // 登录任务（pending.platform 指定平台，默认 boss）
    if (!loginNow) {
      try {
        const r = await fetch(`http://127.0.0.1:${port}/api/internal/boss-login-task`,
          { signal: AbortSignal.timeout(2000) });
        const { pending, cookieFile, platform } = await r.json();
        if (pending) {
          loginNow = true;
          await dispatchLogin(platform || "boss", cookieFile, port).finally(() => { loginNow = false; });
        }
      } catch (error) {
        console.warn("[PawPals] login polling failed:", error?.message || error);
      }
    }
    // 搜索任务（task.platform 指定平台，默认 boss）
    if (!searchNow) {
      try {
        const r = await fetch(`http://127.0.0.1:${port}/api/internal/browser-search-task`,
          { signal: AbortSignal.timeout(2000) });
        const { task } = await r.json();
        if (task) {
          searchNow = true;
          await dispatchSearch(task, port).finally(() => { searchNow = false; });
        }
      } catch (error) {
        console.warn("[PawPals] search polling failed:", error?.message || error);
      }
    }
    // JD 内容抓取任务（复用 Boss直聘 登录 session）
    try {
      const r = await fetch(`http://127.0.0.1:${port}/api/internal/browser-jd-task`,
        { signal: AbortSignal.timeout(2000) });
      const { task } = await r.json();
      if (task) {
        let jdText = "";
        try {
          const win = new BrowserWindow({
            show: false, width: 1280, height: 800,
            webPreferences: { partition: "persist:boss", contextIsolation: true },
          });
          win.webContents.setUserAgent(`Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/${process.versions.chrome || "136.0.0.0"} Safari/537.36`);
          await win.loadURL(task.url);
          await new Promise(r => setTimeout(r, 3000));
          jdText = await win.webContents.executeJavaScript(`
            (() => {
              // Boss直聘 JD 页面结构
              const jdEl = document.querySelector('.job-sec-text, .job-detail-section, .job-sec .text, .job-detail .text');
              const titleEl = document.querySelector('.job-banner .name h1, .job-title, .info-primary .name h1');
              const infoEl = document.querySelector('.job-banner .info-primary, .job-detail-header');
              let text = "";
              if (titleEl) text += "岗位：" + titleEl.textContent.trim() + "\\n";
              if (infoEl) text += infoEl.textContent.trim().replace(/\\s+/g, " ") + "\\n\\n";
              if (jdEl) text += "JD 正文：\\n" + jdEl.innerText.trim();
              return text || document.body.innerText.slice(0, 3000);
            })()
          `);
          try { win.close(); } catch {}
        } catch (e) {
          console.warn("[PawPals] JD fetch failed:", e.message);
        }
        await fetch(`http://127.0.0.1:${port}/api/internal/browser-jd-done`, {
          method: "POST", headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ id: task.id, result: jdText }),
          signal: AbortSignal.timeout(5000),
        }).catch(() => {});
      }
    } catch {}
  }, 1000); // 每 1 秒轮询一次
}

function readDeploymentStatus() {
  const { stateFile, logFile, openClawHome, pawPalsHome, gatewayBaseUrl } = getDeploymentFiles();
  let state = {};
  try {
    if (fs.existsSync(stateFile)) {
      state = JSON.parse(fs.readFileSync(stateFile, "utf8"));
    }
  } catch {}
  const logs = fs.existsSync(logFile)
    ? fs.readFileSync(logFile, "utf8").split(/\r?\n/).filter(Boolean).slice(-32)
    : [];

  return {
    ok: true,
    status: state.status || (runtime ? "ready" : "idle"),
    phase: state.phase || (runtime ? "ready" : "idle"),
    deployed: Boolean(state.deployed || runtime),
    deployedAt: state.deployedAt || null,
    updatedAt: state.updatedAt || null,
    gatewayBaseUrl: state.gatewayBaseUrl || gatewayBaseUrl,
    appUrl: state.appUrl || runtime?.appUrl || null,
    appPort: state.appPort || null,
    openClawHome,
    appDataDir: pawPalsHome,
    usingBundledRuntime: state.usingBundledRuntime !== false,
    usingBundledNode: Boolean(state.usingBundledNode),
    usingBundledOpenClaw: state.usingBundledOpenClaw !== false,
    error: state.error || null,
    logs,
  };
}

function createWindow() {
  mainWindow = new BrowserWindow({
    width: 1440,
    height: 960,
    minWidth: 1100,
    minHeight: 760,
    title: "PawPals",
    backgroundColor: "#f7f1ea",
    autoHideMenuBar: true,
    icon: path.join(__dirname, "../resources/icon.icns"),
    webPreferences: {
      preload: path.join(__dirname, "preload.cjs"),
      contextIsolation: true,
      nodeIntegration: false,
    },
  });

  if (runtime?.appUrl) {
    mainWindow.loadURL(runtime.appUrl);
  } else {
    mainWindow.loadFile(path.join(__dirname, "launcher.html"));
  }
  mainWindow.webContents.setWindowOpenHandler(({ url }) => {
    shell.openExternal(url);
    return { action: "deny" };
  });
}

async function startDesktopRuntime() {
  if (runtime) return runtime;
  if (runtimeStartPromise) return runtimeStartPromise;

  runtimeStartPromise = startIsolatedRuntime({
    repoRoot,
    unpackedRoot,
    production: app.isPackaged && !process.env.PAWPALS_ELECTRON_DEV,
  }).then((startedRuntime) => {
    runtime = startedRuntime;
    if (mainWindow && !mainWindow.isDestroyed()) {
      mainWindow.loadURL(runtime.appUrl);
    }
    // 启动自动投递轮询（用 Electron BrowserWindow 在后台执行）
    if (runtime.appUrl) startApplyPolling(runtime.appUrl);
    // Mark first run complete so future launches skip the launcher
    const { firstRunFile, pawPalsHome } = getDeploymentFiles();
    try {
      fs.mkdirSync(pawPalsHome, { recursive: true });
      if (!fs.existsSync(firstRunFile)) fs.writeFileSync(firstRunFile, new Date().toISOString(), "utf8");
    } catch {}
    // Auto-restart if server dies unexpectedly
    startedRuntime.server?.on("exit", (code) => {
      if (code !== 0 && !app.isQuitting) {
        runtime = null;
        setTimeout(() => startDesktopRuntime().catch(() => {}), 2000);
      }
    });
    return startedRuntime;
  }).finally(() => {
    runtimeStartPromise = null;
  });

  return runtimeStartPromise;
}

app.whenReady().then(async () => {
  // Clear stale deployment state on startup so launcher always shows "等待开始"
  const { stateFile, firstRunFile } = getDeploymentFiles();
  try { if (fs.existsSync(stateFile)) fs.unlinkSync(stateFile); } catch {}

  ipcMain.handle("pawpals:get-deployment-status", async () => readDeploymentStatus());
  ipcMain.on("pawpals:start-deployment", () => {
    startDesktopRuntime().catch((error) => {
      dialog.showErrorBox("PawPals failed to start", String(error));
    });
  });

  // First launch: show launcher so user can click "开始自动部署"
  // Subsequent launches: skip launcher and boot directly into the app
  const isFirstRun = !fs.existsSync(firstRunFile);
  if (isFirstRun) {
    createWindow();
  } else {
    startDesktopRuntime().catch((error) => {
      dialog.showErrorBox("PawPals failed to start", String(error));
    });
    createWindow();
  }

  app.on("activate", () => {
    if (BrowserWindow.getAllWindows().length === 0) {
      createWindow();
    }
  });
});

app.on("window-all-closed", () => {
  if (process.platform !== "darwin") app.quit();
});

app.on("before-quit", () => {
  app.isQuitting = true;
  if (applyPollInterval) clearInterval(applyPollInterval);
  runtime?.stop();
});
