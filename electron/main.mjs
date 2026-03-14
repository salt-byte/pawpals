import fs from "fs";
import { app, BrowserWindow, dialog, ipcMain, shell } from "electron";
import path from "path";
import { fileURLToPath } from "url";
import { getDeploymentFiles } from "../scripts/deployment-state.mjs";
import { startIsolatedRuntime } from "../scripts/runtime-launcher.mjs";

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
    return startedRuntime;
  }).finally(() => {
    runtimeStartPromise = null;
  });

  return runtimeStartPromise;
}

app.whenReady().then(async () => {
  ipcMain.handle("pawpals:get-deployment-status", async () => readDeploymentStatus());
  ipcMain.on("pawpals:start-deployment", () => {
    startDesktopRuntime().catch((error) => {
      dialog.showErrorBox("PawPals failed to start", String(error));
    });
  });

  createWindow();

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
  runtime?.stop();
});
