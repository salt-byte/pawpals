import express from "express";
import { createServer } from "http";
import { Server } from "socket.io";
import dotenv from "dotenv";
import os from "os";
import path from "path";
import { readFileSync, writeFileSync, existsSync, appendFileSync, mkdirSync, copyFileSync, readdirSync, statSync } from "fs";
import { spawn, exec } from "child_process";
import schedule from "node-schedule";
import crypto from "crypto";
import archiver from "archiver";

dotenv.config();

function resolveAppDataDir() {
  if (process.env.PAWPALS_HOME) return process.env.PAWPALS_HOME;

  const home = os.homedir();
  if (process.platform === "darwin") {
    return path.join(home, "Library", "Application Support", "PawPals");
  }
  if (process.platform === "win32") {
    return path.join(process.env.APPDATA || path.join(home, "AppData", "Roaming"), "PawPals");
  }
  return path.join(process.env.XDG_DATA_HOME || path.join(home, ".local", "share"), "pawpals");
}

function ensureDir(dir: string) {
  mkdirSync(dir, { recursive: true });
}

const APP_DATA_DIR = resolveAppDataDir();
const LEGACY_OPENCLAW_HOME = path.join(os.homedir(), ".openclaw");
const CONFIGURED_OPENCLAW_HOME = process.env.OPENCLAW_STATE_DIR || process.env.OPENCLAW_HOME || path.join(APP_DATA_DIR, "openclaw");
const OPENCLAW_HOME = (process.env.OPENCLAW_STATE_DIR || process.env.OPENCLAW_HOME || existsSync(CONFIGURED_OPENCLAW_HOME))
  ? CONFIGURED_OPENCLAW_HOME
  : LEGACY_OPENCLAW_HOME;
const CAREER_DIR = process.env.PAWPALS_WORKSPACE || path.join(OPENCLAW_HOME, "workspace", "career");
const COOKIE_DIR = process.env.PAWPALS_COOKIE_DIR || path.join(APP_DATA_DIR, "jobclaw", "cookies");
const COOKIE_FILE = path.join(COOKIE_DIR, "boss.json");
const APPLICATIONS_FILE = path.join(CAREER_DIR, "applications.json");
const JOBS_FILE = path.join(CAREER_DIR, "jobs.json");
const OPENCLAW_CONFIG_FILE = path.join(OPENCLAW_HOME, "openclaw.json");
const SETUP_STATE_FILE = path.join(APP_DATA_DIR, "setup-state.json");
const DEPLOYMENT_STATE_FILE = path.join(APP_DATA_DIR, "deployment-state.json");
const DEPLOYMENT_LOG_FILE = path.join(APP_DATA_DIR, "deployment.log");
const OPENCLAW_BIN = process.env.OPENCLAW_BIN || "openclaw";
const PYTHON_BIN = process.env.PAWPALS_PYTHON || process.env.PYTHON || "python3";

ensureDir(APP_DATA_DIR);
ensureDir(CAREER_DIR);
ensureDir(COOKIE_DIR);

const SECURITY_FILE = path.join(APP_DATA_DIR, "security.json");
const BACKUP_DIR = path.join(os.homedir(), "Documents", "PawPals备份");
const BACKUP_META_FILE = path.join(APP_DATA_DIR, "backup-meta.json");

// ── 本地备份系统 ────────────────────────────────────────────────────
// 元数据：记录最近几次备份信息
interface BackupMeta { lastBackupAt: number; backupCount: number; lastBackupPath: string }
function _loadBackupMeta(): BackupMeta {
  try { if (existsSync(BACKUP_META_FILE)) return JSON.parse(readFileSync(BACKUP_META_FILE, "utf-8")); } catch {}
  return { lastBackupAt: 0, backupCount: 0, lastBackupPath: "" };
}
function _saveBackupMeta(m: BackupMeta) {
  try { writeFileSync(BACKUP_META_FILE, JSON.stringify(m, null, 2)); } catch {}
}

// 把整个目录递归复制到目标
function _copyDir(src: string, dest: string) {
  if (!existsSync(src)) return;
  mkdirSync(dest, { recursive: true });
  for (const entry of readdirSync(src)) {
    const s = path.join(src, entry);
    const d = path.join(dest, entry);
    if (statSync(s).isDirectory()) _copyDir(s, d);
    else copyFileSync(s, d);
  }
}

// 执行一次本地备份：复制到 ~/Documents/PawPals备份/YYYY-MM-DD_HH-MM/
function doLocalBackup(appDataDir: string, openClawHome: string): string {
  const ts = new Date().toISOString().replace(/[:.]/g, "-").slice(0, 16);
  const dest = path.join(BACKUP_DIR, ts);
  mkdirSync(dest, { recursive: true });

  // 备份核心数据文件
  const filesToBackup = [
    path.join(appDataDir, "setup-state.json"),
    path.join(appDataDir, "deployment-state.json"),
    path.join(appDataDir, "security.json"),
  ];
  for (const f of filesToBackup) {
    if (existsSync(f)) copyFileSync(f, path.join(dest, path.basename(f)));
  }

  // 备份 workspace（聊天记录、简历草稿等）
  const workspaceSrc = path.join(openClawHome, "workspace");
  if (existsSync(workspaceSrc)) _copyDir(workspaceSrc, path.join(dest, "workspace"));

  // 保留最近10份快照，删除旧的
  const snapshots = readdirSync(BACKUP_DIR)
    .filter(d => /^\d{4}-\d{2}/.test(d))
    .sort()
    .reverse();
  for (const old of snapshots.slice(10)) {
    try { exec(`rm -rf "${path.join(BACKUP_DIR, old)}"`); } catch {}
  }

  const meta = _loadBackupMeta();
  meta.lastBackupAt = Date.now();
  meta.backupCount += 1;
  meta.lastBackupPath = dest;
  _saveBackupMeta(meta);

  console.log(`[backup] 本地备份完成 → ${dest}`);
  return dest;
}

// 启动定时备份（每小时一次）
function startAutoBackup(appDataDir: string, openClawHome: string, notifyIO?: any) {
  ensureDir(BACKUP_DIR);
  schedule.scheduleJob("0 * * * *", () => {
    try {
      const dest = doLocalBackup(appDataDir, openClawHome);
      notifyIO?.emit("backup_done", { ok: true, path: dest, at: Date.now() });
    } catch (e: any) {
      console.error("[backup] 定时备份失败:", e.message);
    }
  });
  console.log("[backup] 自动备份已启动（每小时）→", BACKUP_DIR);
}

// ── Login Throttle（仿 AlphaClaw login-throttle.js）────────────────────
// 指数退避暴力破解保护：每个 IP 独立计数
const kLoginWindowMs    = 5 * 60 * 1000;   // 5分钟窗口
const kLoginMaxAttempts = 5;               // 窗口内最多5次
const kLoginBaseLockMs  = 30 * 1000;       // 首次锁定30秒
const kLoginMaxLockMs   = 30 * 60 * 1000;  // 最长锁定30分钟
const kLoginStateTtlMs  = 60 * 60 * 1000;  // 1小时后清理状态

interface LoginState { attempts: number; windowStart: number; lockUntil: number; failStreak: number; lastSeenAt: number; }
const _loginStates = new Map<string, LoginState>();

function _getLoginState(ip: string, now: number): LoginState {
  const s = _loginStates.get(ip);
  if (s) { s.lastSeenAt = now; return s; }
  const n: LoginState = { attempts: 0, windowStart: now, lockUntil: 0, failStreak: 0, lastSeenAt: now };
  _loginStates.set(ip, n);
  return n;
}
function _checkThrottle(ip: string): { blocked: boolean; retryAfterSec: number } {
  const now = Date.now();
  const s = _getLoginState(ip, now);
  if (s.lockUntil > now) return { blocked: true, retryAfterSec: Math.ceil((s.lockUntil - now) / 1000) };
  if (now - s.windowStart >= kLoginWindowMs) { s.attempts = 0; s.windowStart = now; }
  return { blocked: false, retryAfterSec: 0 };
}
function _recordFailure(ip: string) {
  const now = Date.now();
  const s = _getLoginState(ip, now);
  if (now - s.windowStart >= kLoginWindowMs) { s.attempts = 0; s.windowStart = now; }
  s.attempts += 1;
  if (s.attempts < kLoginMaxAttempts) return;
  s.failStreak += 1; s.attempts = 0; s.windowStart = now;
  const lockMs = Math.min(kLoginBaseLockMs * Math.pow(2, s.failStreak - 1), kLoginMaxLockMs);
  s.lockUntil = now + lockMs;
}
function _recordSuccess(ip: string) { _loginStates.delete(ip); }
setInterval(() => {
  const now = Date.now();
  for (const [k, s] of _loginStates.entries())
    if (s.lockUntil <= now && now - s.lastSeenAt > kLoginStateTtlMs) _loginStates.delete(k);
}, 10 * 60 * 1000);

// ── PIN Auth System ────────────────────────────────────────────────────
const kSessionTtlMs = 7 * 24 * 60 * 60 * 1000; // 7天
const _sessions = new Map<string, { ip: string; createdAt: number }>();

function _hashPin(pin: string): string {
  return crypto.createHash("sha256").update("pawpals:" + pin).digest("hex");
}
function _loadSecurity(): { pinHash: string | null; enabled: boolean } {
  try {
    if (existsSync(SECURITY_FILE)) return JSON.parse(readFileSync(SECURITY_FILE, "utf-8"));
  } catch {}
  return { pinHash: null, enabled: false };
}
function _saveSecurity(data: { pinHash: string | null; enabled: boolean }) {
  writeFileSync(SECURITY_FILE, JSON.stringify(data, null, 2));
}
function _isLocalhost(ip: string): boolean {
  return ip === "127.0.0.1" || ip === "::1" || ip === "::ffff:127.0.0.1";
}
function _getClientIp(req: any): string {
  return (req.headers["x-forwarded-for"] as string)?.split(",")[0]?.trim()
    || req.socket?.remoteAddress || "unknown";
}
function _getSessionToken(req: any): string | null {
  const cookie = req.headers.cookie || "";
  const m = cookie.match(/paw_session=([^;]+)/);
  if (m) return m[1];
  const auth = req.headers.authorization || "";
  if (auth.startsWith("Bearer paw_")) return auth.slice(7);
  return null;
}
function _isAuthenticated(req: any): boolean {
  const ip = _getClientIp(req);
  if (_isLocalhost(ip)) return true;
  const sec = _loadSecurity();
  if (!sec.enabled || !sec.pinHash) return true; // PIN 未启用时放行
  const token = _getSessionToken(req);
  if (!token) return false;
  const session = _sessions.get(token);
  if (!session) return false;
  if (Date.now() - session.createdAt > kSessionTtlMs) { _sessions.delete(token); return false; }
  return true;
}
setInterval(() => {
  const now = Date.now();
  for (const [k, s] of _sessions.entries())
    if (now - s.createdAt > kSessionTtlMs) _sessions.delete(k);
}, 60 * 60 * 1000);

// ── Watchdog（gateway 崩溃自动重启）──────────────────────────────────
const kWdCheckIntervalMs   = 30 * 1000;  // 每30秒检查
const kWdCrashWindowMs     = 5 * 60 * 1000;  // 5分钟崩溃窗口
const kWdCrashLoopThreshold = 3;             // 窗口内崩溃3次 = crash loop
const kWdMaxRepairs         = 3;             // 最多自动修复3次

const _wd = {
  crashes: [] as number[],
  repairCount: 0,
  paused: false,
  lastRestartAt: 0,
};

function _trimCrashWindow() {
  const cutoff = Date.now() - kWdCrashWindowMs;
  _wd.crashes = _wd.crashes.filter(t => t > cutoff);
}

async function _isGatewayAlive(gatewayBase: string): Promise<boolean> {
  try {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), 3000);
    await fetch(`${gatewayBase}/`, { signal: ctrl.signal });
    clearTimeout(timer);
    return true;
  } catch { return false; }
}

function _restartGateway(gatewayPort: string, openclawBin: string): Promise<void> {
  const now = Date.now();
  if (now - _wd.lastRestartAt < 10_000) return Promise.resolve();
  _wd.lastRestartAt = now;
  console.log("[watchdog] 重启 gateway...");
  return new Promise((resolve) => {
    exec(
      `lsof -ti :${gatewayPort} | xargs kill -TERM 2>/dev/null; sleep 1; ${openclawBin} gateway --port ${gatewayPort} --allow-unconfigured &`,
      (err) => {
        if (err) console.error("[watchdog] 重启失败:", err.message);
        else console.log("[watchdog] 重启命令已发出");
        resolve();
      }
    );
  });
}

function _runDoctor(openclawBin: string): Promise<string> {
  return new Promise((resolve) => {
    console.log("[watchdog] 运行 openclaw doctor --fix ...");
    exec(`${openclawBin} doctor --fix --yes`, { timeout: 30_000 }, (err, stdout, stderr) => {
      const out = (stdout + stderr).trim();
      if (err) console.error("[watchdog] doctor 执行错误:", err.message);
      else console.log("[watchdog] doctor 完成:", out.slice(0, 200));
      resolve(out);
    });
  });
}

function startWatchdog(gatewayBase: string, openclawBin: string, notifyIO?: any) {
  const gatewayPort = (gatewayBase.match(/:(\d+)/) || [])[1] || "18790";
  setInterval(async () => {
    if (_wd.paused) return;
    const alive = await _isGatewayAlive(gatewayBase);
    if (alive) return;

    const now = Date.now();
    _wd.crashes.push(now);
    _trimCrashWindow();
    console.log(`[watchdog] Gateway 不可达（近${kWdCrashWindowMs / 60000}分钟内崩溃 ${_wd.crashes.length} 次）`);
    notifyIO?.emit("watchdog_alert", { type: "down", message: "Gateway 无响应，正在尝试恢复..." });

    if (_wd.crashes.length >= kWdCrashLoopThreshold) {
      if (_wd.repairCount >= kWdMaxRepairs) {
        if (!_wd.paused) {
          _wd.paused = true;
          console.error("[watchdog] 已达最大修复次数，停止自动重启");
          notifyIO?.emit("watchdog_alert", { type: "crash_loop", message: "⚠️ Gateway 反复崩溃，自动修复失败，请重启 PawPals 应用" });
        }
        return;
      }
      // 崩溃循环：先跑 doctor --fix 再重启
      _wd.repairCount += 1;
      _wd.crashes = [];
      console.log(`[watchdog] 崩溃循环，第 ${_wd.repairCount} 次：运行 doctor --fix`);
      notifyIO?.emit("watchdog_alert", { type: "repair", message: `🔧 Gateway 崩溃循环，第 ${_wd.repairCount} 次自动诊断修复中...` });
      const doctorOut = await _runDoctor(openclawBin);
      notifyIO?.emit("watchdog_alert", { type: "repair_done", message: `✅ 诊断完成，正在重启 Gateway...`, detail: doctorOut.slice(0, 300) });
    }

    await _restartGateway(gatewayPort, openclawBin);
    // 15秒后确认是否恢复
    setTimeout(async () => {
      const recovered = await _isGatewayAlive(gatewayBase);
      if (recovered) {
        console.log("[watchdog] Gateway 已恢复");
        notifyIO?.emit("watchdog_alert", { type: "recovered", message: "✅ Gateway 已恢复正常" });
      }
    }, 15_000);
  }, kWdCheckIntervalMs);
}

const MODEL_PRESETS = [
  {
    provider: "anthropic",
    model: "claude-opus-4-6",
    providerName: "Claude",
    displayName: "Claude Official (Anthropic)",
    blurb: "走 Anthropic 官方 API，不再依赖第三方代理链路。",
    keyUrl: "https://console.anthropic.com/settings/keys",
  },
  {
    provider: "gemini",
    model: "gemini-3-flash-preview",
    providerName: "Gemini",
    displayName: "Gemini 3 Flash Preview",
    blurb: "速度快，适合日常问答和轻量多轮协作。",
    keyUrl: "https://aistudio.google.com/apikey",
  },
  {
    provider: "openai",
    model: "gpt-5-mini",
    providerName: "OpenAI",
    displayName: "GPT-5 mini",
    blurb: "通用性强，适合日常助理、写作和工具调用。",
    keyUrl: "https://platform.openai.com/api-keys",
  },
  {
    provider: "minimax",
    model: "MiniMax-M2.5",
    providerName: "MiniMax",
    displayName: "MiniMax M2.5",
    blurb: "MiniMax 官方 OpenAI 兼容接口，适合中文和 Agent 流程。",
    keyUrl: "https://platform.minimax.io/user-center/basic-information/interface-key",
  },
  {
    provider: "volcengine",
    model: "doubao-seed-1-6-251015",
    providerName: "火山引擎",
    displayName: "Doubao Seed 1.6",
    blurb: "火山引擎官方兼容接口，适合国内模型接入。",
    keyUrl: "https://console.volcengine.com/ark/region:ark+cn-beijing/apiKey",
  },
  {
    provider: "zai",
    model: "glm-5",
    providerName: "GLM",
    displayName: "GLM-5",
    blurb: "中文表达稳定，适合求职、总结和国内场景。",
    keyUrl: "https://open.bigmodel.cn/usercenter/apikeys",
  },
] as const;

function getPreset(provider: string) {
  return MODEL_PRESETS.find((preset) => preset.provider === provider);
}

function isCustomProvider(provider: string) {
  return !getPreset(provider);
}

function loadJsonFile<T>(file: string, fallback: T): T {
  try {
    if (!existsSync(file)) return fallback;
    return JSON.parse(readFileSync(file, "utf-8")) as T;
  } catch {
    return fallback;
  }
}

function getProviderEnvApiKey(provider: string): string {
  switch (provider) {
    case "anthropic":
      return String(process.env.ANTHROPIC_API_KEY || "").trim();
    case "gemini":
      return String(process.env.GEMINI_API_KEY || process.env.GOOGLE_API_KEY || "").trim();
    case "openai":
      return String(process.env.OPENAI_API_KEY || "").trim();
    default:
      return "";
  }
}

function applyEnvFallbacks(config: any) {
  if (!config || typeof config !== "object") return config;

  config.env ??= {};
  config.env.vars ??= {};
  config.models ??= {};
  config.models.providers ??= {};
  config.agents ??= {};
  config.agents.defaults ??= {};
  config.agents.defaults.model ??= {};

  let changed = false;
  const primaryModel = String(config?.agents?.defaults?.model?.primary || "");
  const [selectedProvider = ""] = primaryModel.split("/");

  const anthropicKey = getProviderEnvApiKey("anthropic");
  if (anthropicKey && !config.env.vars.ANTHROPIC_API_KEY) {
    config.env.vars.ANTHROPIC_API_KEY = anthropicKey;
    changed = true;
  }

  for (const provider of ["gemini", "openai"] as const) {
    const envApiKey = getProviderEnvApiKey(provider);
    const providerConfig = config.models.providers[provider];

    if (envApiKey && providerConfig && !providerConfig.apiKey) {
      providerConfig.apiKey = envApiKey;
      changed = true;
    }

    if (envApiKey && selectedProvider === provider && !config.env.vars.OPENAI_API_KEY) {
      config.env.vars.OPENAI_API_KEY = envApiKey;
      changed = true;
    }
  }

  return changed ? { config, changed } : { config, changed: false };
}

function saveJsonFile(file: string, value: unknown) {
  ensureDir(path.dirname(file));
  writeFileSync(file, `${JSON.stringify(value, null, 2)}\n`, "utf-8");
}

function tailFile(file: string, maxLines = 24): string[] {
  try {
    if (!existsSync(file)) return [];
    return readFileSync(file, "utf-8")
      .split(/\r?\n/)
      .map((line) => line.trim())
      .filter(Boolean)
      .slice(-maxLines);
  } catch {
    return [];
  }
}

function loadOpenClawConfig(): any {
  const rawConfig = loadJsonFile(OPENCLAW_CONFIG_FILE, {});
  const { config, changed } = applyEnvFallbacks(rawConfig);
  if (changed) {
    saveJsonFile(OPENCLAW_CONFIG_FILE, config);
  }
  return config;
}

function saveOpenClawConfig(config: any) {
  saveJsonFile(OPENCLAW_CONFIG_FILE, config);
}

function buildSetupState() {
  const config = loadOpenClawConfig();
  const setupState = loadJsonFile<Record<string, any>>(SETUP_STATE_FILE, {});
  const primaryModel = String(config?.agents?.defaults?.model?.primary || "");
  const [selectedProvider = "", selectedModel = ""] = primaryModel.split("/");
  const providers = config?.models?.providers || {};

  const providerStates = Object.fromEntries(
    MODEL_PRESETS.map((preset) => {
      const providerConfig = providers?.[preset.provider] || {};
      const envVarKey =
        preset.provider === "anthropic"
          ? "ANTHROPIC_API_KEY"
          : "OPENAI_API_KEY";
      return [
        preset.provider,
        {
          baseUrl:
            preset.provider === "anthropic"
              ? "https://api.anthropic.com"
              : (providerConfig.baseUrl || ""),
          apiKeyConfigured:
            preset.provider === "anthropic"
              ? Boolean(config?.env?.vars?.[envVarKey])
              : Boolean(providerConfig.apiKey),
          modelCount:
            preset.provider === "anthropic"
              ? 1
              : (Array.isArray(providerConfig.models) ? providerConfig.models.length : 0),
        },
      ];
    }),
  );

  return {
    completed: Boolean(setupState.completed),
    selectedProvider,
    selectedModel,
    primaryModel,
    providers: providerStates,
    recommendedModels: MODEL_PRESETS,
    completedAt: setupState.completedAt || null,
  };
}

function buildDeploymentState() {
  const deploymentState = loadJsonFile<Record<string, any>>(DEPLOYMENT_STATE_FILE, {});
  return {
    ok: true,
    status: deploymentState.status || (existsSync(OPENCLAW_CONFIG_FILE) ? "ready" : "idle"),
    phase: deploymentState.phase || (existsSync(OPENCLAW_CONFIG_FILE) ? "ready" : "idle"),
    deployed: Boolean(deploymentState.deployed || existsSync(OPENCLAW_CONFIG_FILE)),
    deployedAt: deploymentState.deployedAt || null,
    updatedAt: deploymentState.updatedAt || null,
    gatewayBaseUrl: deploymentState.gatewayBaseUrl || GATEWAY_BASE,
    appUrl: deploymentState.appUrl || null,
    appPort: deploymentState.appPort || null,
    openClawHome: OPENCLAW_HOME,
    appDataDir: APP_DATA_DIR,
    usingBundledRuntime: deploymentState.usingBundledRuntime !== false,
    usingBundledNode: Boolean(deploymentState.usingBundledNode),
    usingBundledOpenClaw: deploymentState.usingBundledOpenClaw !== false,
    error: deploymentState.error || null,
    logs: tailFile(DEPLOYMENT_LOG_FILE),
  };
}

function saveSetupSelection(provider: string, model: string, options?: { baseUrl?: string }) {
  const config = loadOpenClawConfig();
  const providerConfig = config?.models?.providers?.[provider];

  config.env ??= {};
  config.env.vars ??= {};
  config.models ??= {};
  config.models.providers ??= {};
  config.agents ??= {};
  config.agents.defaults ??= {};
  config.agents.defaults.model ??= {};
  config.agents.defaults.models ??= {};

  const primaryModel = `${provider}/${model}`;
  config.agents.defaults.model.primary = primaryModel;
  config.agents.defaults.models[primaryModel] ??= {};

  if (provider === "anthropic") {
    config.env.vars.ANTHROPIC_MODEL = model;
  } else {
    if (isCustomProvider(provider)) {
      if (!options?.baseUrl) {
        throw new Error("自定义模型需要填写 base URL");
      }
      config.models.providers[provider] = {
        api: "openai-completions",
        apiKey: config.models.providers[provider]?.apiKey || "",
        baseUrl: options.baseUrl,
        models: [
          {
            id: model,
            name: model,
            input: ["text"],
          },
        ],
      };
    } else if (!providerConfig) {
      throw new Error(`Unknown provider: ${provider}`);
    }
    const activeProviderConfig = config.models.providers[provider];
    config.env.vars.OPENAI_BASE_URL = activeProviderConfig.baseUrl || config.env.vars.OPENAI_BASE_URL || "";
    config.env.vars.OPENAI_MODEL = model;
  }

  saveOpenClawConfig(config);
  saveJsonFile(SETUP_STATE_FILE, {
    ...loadJsonFile<Record<string, any>>(SETUP_STATE_FILE, {}),
    completed: true,
    selectedProvider: provider,
    selectedModel: model,
    completedAt: new Date().toISOString(),
  });
}

function saveProviderApiKey(provider: string, apiKey: string, options?: { baseUrl?: string; model?: string }) {
  const config = loadOpenClawConfig();

  config.env ??= {};
  config.env.vars ??= {};
  config.models ??= {};
  config.models.providers ??= {};

  if (provider === "anthropic") {
    config.env.vars.ANTHROPIC_API_KEY = apiKey;
  } else {
    if (isCustomProvider(provider)) {
      if (!options?.baseUrl || !options?.model) {
        throw new Error("自定义模型需要填写 provider、model 和 base URL");
      }
      config.models.providers[provider] = {
        api: "openai-completions",
        apiKey,
        baseUrl: options.baseUrl,
        models: [
          {
            id: options.model,
            name: options.model,
            input: ["text"],
          },
        ],
      };
    } else {
      const providerConfig = config?.models?.providers?.[provider];
      if (!providerConfig) {
        throw new Error(`Unknown provider: ${provider}`);
      }
      providerConfig.apiKey = apiKey;
    }
    config.env.vars.OPENAI_API_KEY = apiKey;
  }

  saveOpenClawConfig(config);
}

// ── OpenClaw Gateway 配置 ─────────────────────────────────────────────
// 从 openclaw.json 读取 gateway token（在 OPENCLAW_CONFIG_FILE 定义之后）
function readGatewayToken(): string {
  if (process.env.OPENCLAW_TOKEN) return process.env.OPENCLAW_TOKEN;
  try {
    const configFile = path.join(
      process.env.OPENCLAW_STATE_DIR || process.env.OPENCLAW_HOME || path.join(resolveAppDataDir(), "openclaw"),
      "openclaw.json"
    );
    if (existsSync(configFile)) {
      const cfg = JSON.parse(readFileSync(configFile, "utf-8")) as any;
      return cfg?.gateway?.auth?.token || "";
    }
  } catch {}
  return "";
}
const GATEWAY_BASE  = process.env.OPENCLAW_BASE_URL || "http://127.0.0.1:18789";
const GATEWAY_TOKEN = readGatewayToken();
const BRAVE_KEY     = process.env.BRAVE_SEARCH_API_KEY || "BSAIdlkBgiO1X6FIw6jPmML4UFQRA9i";
const MAX_CHAIN_DEPTH = 2;
const CHAT_LOG      = path.join(CAREER_DIR, "chat_log.md");
const MESSAGES_FILE = path.join(CAREER_DIR, "pawpals_messages.json");

function loadMessages(): any[] {
  try {
    if (existsSync(MESSAGES_FILE)) return JSON.parse(readFileSync(MESSAGES_FILE, "utf-8"));
  } catch {}
  return [];
}

function saveMessages(msgs: any[]) {
  try { writeFileSync(MESSAGES_FILE, JSON.stringify(msgs, null, 2)); } catch {}
}

function appendChatLog(agent: { name: string }, userMsg: string, replySnippet: string) {
  try {
    const now = new Date().toLocaleDateString("zh-CN", {
      year: "numeric", month: "2-digit", day: "2-digit",
      hour: "2-digit", minute: "2-digit", hour12: false,
    }).replace(/\//g, "-");
    const snippet = replySnippet.replace(/\n+/g, " ").slice(0, 80);
    const userSnippet = userMsg.replace(/\n+/g, " ").slice(0, 40);
    const entry = `\n## ${now} | 🌐 PawPals → ${agent.name}\n用户说：「${userSnippet}」。回复摘要：${snippet}…\n`;
    appendFileSync(CHAT_LOG, entry, "utf-8");
  } catch {}
}

// ── 各 agent 可用工具分配 ─────────────────────────────────────────────
// 每个 agent 只能调用自己职责范围内的工具，防止越权操作
const AGENT_TOOLS: Record<string, string[]> = {
  "job-hunter":      ["search_jobs", "read_jobs"],
  "app-tracker":     ["apply_job", "record_application", "read_applications", "get_followups"],
  "career-planner":  ["read_applications", "read_jobs"],
  "jd-analyst":      [],   // 纯文本分析，无需工具
  "resume-expert":   [],
  "networker":       [],
  "interview-coach": [],
};

// 投递前必须先确认的工具（调用前要求用户明确同意）
const CONFIRM_REQUIRED_TOOLS = new Set(["apply_job"]);

// ── 工具定义（Gemini Function Calling）────────────────────────────────
const TOOLS = [
  {
    type: "function",
    function: {
      name: "search_jobs",
      description: "搜索最新 AI PM / AI Strategy 实习岗位，返回岗位列表（公司、职位、链接）",
      parameters: {
        type: "object",
        properties: {
          query:    { type: "string", description: "搜索关键词，如 'AI PM intern 2026'" },
          location: { type: "string", description: "城市，如 'San Francisco' 或 '北京'" },
        },
        required: ["query"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "read_applications",
      description: "读取当前所有投递记录，返回投递状态看板",
      parameters: { type: "object", properties: {} },
    },
  },
  {
    type: "function",
    function: {
      name: "get_followups",
      description: "检查哪些投递已超过 follow-up 日期但还没有更新",
      parameters: { type: "object", properties: {} },
    },
  },
  {
    type: "function",
    function: {
      name: "record_application",
      description: "记录一条新投递",
      parameters: {
        type: "object",
        properties: {
          company:     { type: "string", description: "公司名" },
          role:        { type: "string", description: "职位名" },
          url:         { type: "string", description: "岗位链接" },
          source:      { type: "string", description: "来源：linkedin / boss / company / referral" },
          notes:       { type: "string", description: "备注" },
        },
        required: ["company", "role"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "read_jobs",
      description: "读取已搜集的岗位库，返回待投递的岗位列表",
      parameters: { type: "object", properties: {} },
    },
  },
  {
    type: "function",
    function: {
      name: "apply_job",
      description: "在 Boss直聘上自动投递岗位：点击「立即沟通」按钮并发送打招呼消息。需要先登录 Boss直聘。",
      parameters: {
        type: "object",
        properties: {
          job_url:  { type: "string", description: "岗位详情页链接，如 https://www.zhipin.com/job_detail/xxx.html" },
          company:  { type: "string", description: "公司名" },
          title:    { type: "string", description: "职位名" },
          greeting: { type: "string", description: "打招呼消息，不填则用 Boss 默认消息" },
        },
        required: ["job_url", "company", "title"],
      },
    },
  },
];

// ── 工具执行器 ────────────────────────────────────────────────────────
async function executeTool(name: string, args: any): Promise<string> {
  try {
    if (name === "search_jobs") {
      const query = args.query || "";
      const city  = args.location || "101010100"; // 默认北京

      if (existsSync(COOKIE_FILE)) {
        // ── 有 Boss cookies → curl_cffi 模拟 Chrome TLS 直接调 Boss API ──
        const script = `
import json, pathlib, urllib.parse, sys
from curl_cffi import requests as cf

cookie_path = pathlib.Path(${JSON.stringify(COOKIE_FILE)})
cookies_raw = json.loads(cookie_path.read_text())['cookies']
cookie_dict = {c['name']: c['value'] for c in cookies_raw}

query = ${JSON.stringify(query)}
city  = ${JSON.stringify(city)}
params = urllib.parse.urlencode({'scene':1,'query':query,'city':city,'page':1,'pageSize':15})
url = 'https://www.zhipin.com/wapi/zpgeek/search/joblist.json?' + params
referer = 'https://www.zhipin.com/web/geek/job?' + urllib.parse.urlencode({'query':query,'city':city})

r = cf.get(url, cookies=cookie_dict, impersonate='chrome120',
           headers={'Referer': referer, 'Accept-Language': 'zh-CN,zh;q=0.9'})
d = r.json()
if d.get('code') != 0:
    print('FAIL:' + str(d.get('code')) + ' ' + str(d.get('message'))); sys.exit(1)

jobs = d.get('zpData', {}).get('jobList', [])
lines = []
structured = []
for i, j in enumerate(jobs, 1):
    salary = j.get('salaryDesc', '薪资面议')
    url_path = j.get('encryptJobId', '')
    job_url = f"https://www.zhipin.com/job_detail/{url_path}.html" if url_path else 'https://www.zhipin.com'
    lines.append(f"{i}. **{j.get('jobName')}** @ {j.get('brandName')} [{salary}]\\n   📍 {j.get('cityName','')} · {j.get('areaDistrict','')}  ⏱ {j.get('experienceName','')} · {j.get('degreeName','')}\\n   🔗 {job_url}")
    structured.append(json.dumps({'company': j.get('brandName',''), 'title': j.get('jobName',''), 'url': job_url, 'salary': salary, 'city': j.get('cityName',''), 'source': 'boss'}, ensure_ascii=False))
print('\\n\\n'.join(lines))
print('---JOBS_JSON---')
print('\\n'.join(structured))
`;
        return new Promise<string>((resolve) => {
          const child = spawn(PYTHON_BIN, ["-c", script], { stdio: ["ignore", "pipe", "pipe"] });
          let out = "", err = "";
          child.stdout.on("data", (d: Buffer) => { out += d.toString(); });
          child.stderr.on("data", (d: Buffer) => { err += d.toString(); });
          child.on("close", () => {
            if (out.startsWith("FAIL:")) {
              resolve(`Boss直聘搜索失败（${out.slice(5).trim()}），请重新登录 Boss直聘后再试。`);
              return;
            }
            // 分离展示文本 和 结构化 JSON
            const [displayPart, jsonPart] = out.split("---JOBS_JSON---");
            // 把新岗位合并入 jobs.json（按 url 去重）
            if (jsonPart) {
              try {
                const newJobs = jsonPart.trim().split("\n")
                  .filter(l => l.trim())
                  .map(l => ({ ...JSON.parse(l), applied: false, addedAt: new Date().toISOString() }));
                const existing: any[] = existsSync(JOBS_FILE) ? JSON.parse(readFileSync(JOBS_FILE, "utf-8")) : [];
                const existingUrls = new Set(existing.map((j: any) => j.url));
                const merged = [...existing, ...newJobs.filter(j => !existingUrls.has(j.url))];
                writeFileSync(JOBS_FILE, JSON.stringify(merged, null, 2));
              } catch {}
            }
            resolve(displayPart.trim() || "未找到相关岗位，换个关键词试试。");
          });
        });
      }

      // ── 没有 cookies → Brave fallback ────────────────────────────────
      const q = encodeURIComponent(`${query} ${city} site:zhipin.com OR site:linkedin.com/jobs`);
      const res = await fetch(`https://api.search.brave.com/res/v1/web/search?q=${q}&count=8`, {
        headers: { "Accept": "application/json", "X-Subscription-Token": BRAVE_KEY },
      });
      const data = await res.json() as any;
      const results = (data.web?.results || []).slice(0, 8).map((r: any, i: number) =>
        `${i + 1}. **${r.title}**\n   ${r.description || ""}\n   🔗 ${r.url}`
      ).join("\n\n");
      return results || "未找到岗位，请先登录 Boss直聘。";
    }

    if (name === "read_applications") {
      if (!existsSync(APPLICATIONS_FILE)) return "暂无投递记录。";
      const apps = JSON.parse(readFileSync(APPLICATIONS_FILE, "utf-8")) as any[];
      const byStatus: Record<string, any[]> = {};
      for (const a of apps) {
        (byStatus[a.status] = byStatus[a.status] || []).push(a);
      }
      const lines = Object.entries(byStatus).map(([status, list]) =>
        `**${status}** (${list.length})\n` + list.map(a => `  · ${a.company} — ${a.role}`).join("\n")
      );
      return `📊 投递看板（共 ${apps.length} 条）\n\n${lines.join("\n\n")}`;
    }

    if (name === "get_followups") {
      if (!existsSync(APPLICATIONS_FILE)) return "暂无投递记录。";
      const apps = JSON.parse(readFileSync(APPLICATIONS_FILE, "utf-8")) as any[];
      const today = new Date().toISOString().slice(0, 10);
      const overdue = apps.filter(a =>
        a.status === "applied" && a.followUpDate && a.followUpDate <= today
      );
      if (!overdue.length) return "✅ 没有逾期的 follow-up！";
      return `⏰ 需要 follow-up 的投递（${overdue.length} 条）：\n\n` +
        overdue.map(a => `· **${a.company}** — ${a.role}（follow-up 日期：${a.followUpDate}）`).join("\n");
    }

    if (name === "record_application") {
      const apps = existsSync(APPLICATIONS_FILE) ? JSON.parse(readFileSync(APPLICATIONS_FILE, "utf-8")) : [];
      const followUpDate = new Date(Date.now() + 7 * 86400000).toISOString().slice(0, 10);
      const newApp = {
        id: `${Date.now()}`,
        company: args.company, role: args.role,
        status: "applied",
        appliedDate: new Date().toISOString().slice(0, 10),
        followUpDate,
        source: args.source || "direct",
        url: args.url || "",
        notes: args.notes || "",
        timeline: [{ date: new Date().toISOString().slice(0, 10), action: "Applied" }],
      };
      apps.push(newApp);
      writeFileSync(APPLICATIONS_FILE, JSON.stringify(apps, null, 2));
      return `✅ 已记录投递：${args.company} — ${args.role}，follow-up 提醒设在 ${followUpDate}。`;
    }

    if (name === "read_jobs") {
      if (!existsSync(JOBS_FILE)) return "岗位库为空。";
      const jobs = JSON.parse(readFileSync(JOBS_FILE, "utf-8")) as any[];
      const pending = jobs.filter(j => !j.applied).slice(0, 10);
      if (!pending.length) return "没有待投递的岗位。";
      return `📋 待投递岗位（${pending.length} 条）：\n\n` +
        pending.map((j: any, i: number) => `${i+1}. **${j.company}** — ${j.title}\n   🔗 ${j.url || "链接待补充"}`).join("\n\n");
    }

    if (name === "apply_job") {
      const { job_url, company, title, greeting } = args;
      if (!existsSync(COOKIE_FILE)) {
        return "❌ 未找到 Boss直聘 登录信息，请先在群里登录 Boss直聘。";
      }
      const safeGreeting = greeting || `您好！我是邓雨蝶，USC数据科学在读，曾在智谱AI做AI产品经理，对${title}岗位很感兴趣，期待与您沟通！`;
      const script = `
import asyncio, json, pathlib, sys
from playwright.async_api import async_playwright

async def apply():
    cookie_path = pathlib.Path(${JSON.stringify(COOKIE_FILE)})
    cookies = json.loads(cookie_path.read_text())['cookies']
    job_url  = ${JSON.stringify(job_url)}
    greeting = ${JSON.stringify(safeGreeting)}

    async with async_playwright() as pw:
        browser = await pw.chromium.launch(
            headless=True,
            args=['--disable-blink-features=AutomationControlled', '--no-sandbox']
        )
        ctx = await browser.new_context(
            user_agent='Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
            viewport={'width': 1280, 'height': 800},
        )
        await ctx.add_init_script("Object.defineProperty(navigator,'webdriver',{get:()=>undefined})")
        await ctx.add_cookies(cookies)

        page = await ctx.new_page()
        await page.goto(job_url, wait_until='domcontentloaded', timeout=30000)
        await asyncio.sleep(1.5)

        # 被重定向到登录页
        if '/web/user' in page.url or 'passport' in page.url:
            print('NEED_LOGIN'); await browser.close(); return

        # 已经在沟通了
        for sel in ["a:has-text('继续沟通')"]:
            try:
                el = await page.query_selector(sel)
                if el and await el.is_visible():
                    print('ALREADY_APPLIED'); await browser.close(); return
            except: pass

        # 找「立即沟通」按钮
        btn = None
        for sel in ["a.btn-startchat", ".job-detail-box .btn-startchat",
                    "a[ka='job_detail_chat']", "a:has-text('立即沟通')"]:
            try:
                el = await page.query_selector(sel)
                if el and await el.is_visible():
                    btn = el; break
            except: pass

        if not btn:
            print('NO_BUTTON'); await browser.close(); return

        await btn.click()
        await asyncio.sleep(2.5)

        # 找输入框
        chat_input = None
        for sel in ["#chat-input", ".chat-input textarea",
                    "div.edit-area [contenteditable='true']", "textarea[name='msg']"]:
            try:
                el = await page.query_selector(sel)
                if el and await el.is_visible():
                    chat_input = el; break
            except: pass

        if chat_input:
            await chat_input.click()
            await chat_input.fill('')
            await page.keyboard.type(greeting, delay=40)
            await asyncio.sleep(0.8)
            sent = False
            for sel in ["button.btn-send", "button:has-text('发送')", ".chat-op button"]:
                try:
                    el = await page.query_selector(sel)
                    if el and await el.is_visible():
                        await el.click(); sent = True; break
                except: pass
            if not sent:
                await page.keyboard.press('Enter')
            await asyncio.sleep(1)
        else:
            # 没有输入框 → Boss 已自动发默认消息
            print('DEFAULT_SENT'); await browser.close(); return

        await browser.close()
        print('SUCCESS')

asyncio.run(apply())
`;
      return new Promise<string>((resolve) => {
        const child = spawn(PYTHON_BIN, ["-c", script], { stdio: ["ignore", "pipe", "pipe"] });
        let out = "", err = "";
        child.stdout.on("data", (d: Buffer) => { out += d.toString(); });
        child.stderr.on("data", (d: Buffer) => { err += d.toString(); });
        child.on("close", () => {
          const o = out.trim();
          if (o.includes("SUCCESS") || o.includes("DEFAULT_SENT")) {
            resolve(`✅ 已成功向 **${company}** 的「${title}」岗位发送打招呼消息！`);
          } else if (o.includes("ALREADY_APPLIED")) {
            resolve(`ℹ️ 你之前已经和 **${company}** 沟通过了，无需重复投递。`);
          } else if (o.includes("NEED_LOGIN")) {
            resolve("❌ cookies 已过期，请重新登录 Boss直聘。");
          } else if (o.includes("NO_BUTTON")) {
            resolve(`⚠️ 未找到「立即沟通」按钮（可能岗位已下线或不接受投递）：${job_url}`);
          } else {
            resolve(`❌ 投递失败：${err.slice(0, 200) || o || "未知错误"}`);
          }
        });
      });
    }

    return `工具 ${name} 暂未实现。`;
  } catch (e: any) {
    return `工具执行失败：${e.message}`;
  }
}

const JOB_AGENTS = [
  { id: "career-planner",  role: "职业规划师", name: "职业规划师", avatar: "", default: true, isChief: true },
  { id: "job-hunter",      role: "岗位猎手",   name: "岗位猎手",   avatar: "https://api.dicebear.com/7.x/adventurer/svg?seed=JobHunter" },
  { id: "jd-analyst",      role: "技能成长师", name: "技能成长师", avatar: "https://api.dicebear.com/7.x/adventurer/svg?seed=JDAnalyst" },
  { id: "resume-expert",   role: "简历专家",   name: "简历专家",   avatar: "https://api.dicebear.com/7.x/adventurer/svg?seed=ResumeExpert" },
  { id: "app-tracker",     role: "投递管家",   name: "投递管家",   avatar: "https://api.dicebear.com/7.x/adventurer/svg?seed=AppTracker" },
  { id: "networker",       role: "人脉顾问",   name: "人脉顾问",   avatar: "https://api.dicebear.com/7.x/adventurer/svg?seed=Networker" },
  { id: "interview-coach", role: "面试教练",   name: "面试教练",   avatar: "https://api.dicebear.com/7.x/adventurer/svg?seed=InterviewCoach" },
];

const agentByName: Record<string, typeof JOB_AGENTS[0]> = {};
JOB_AGENTS.forEach(a => { agentByName[a.name] = a; });

function detectTargetAgent(text: string) {
  // 1. 优先：「回复 某人」（引用回复格式，取被回复对象作为目标）
  const replyMatch = text.match(/回复\s+\*{0,2}([\u4e00-\u9fa5A-Za-z\d]+)\*{0,2}[：:]/);
  if (replyMatch) {
    const a = agentByName[replyMatch[1]];
    if (a) return a;
  }

  // 2. 明确 @某人
  for (const a of JOB_AGENTS) {
    if (text.includes("@" + a.name)) return a;
  }

  // 3. 关键词路由：只用「>」引用块之外的正文部分匹配，避免引用内容误触发
  const bodyText = text.replace(/^>.*$/gm, "").toLowerCase();
  if (/boss直聘|搜岗|找工作|看看工作|有什么岗位|推荐岗位|找岗位|search job/.test(bodyText))
    return JOB_AGENTS.find(a => a.id === "job-hunter")!;
  if (/投递|帮我投|投第|apply|follow.?up|看板|状态/.test(bodyText))
    return JOB_AGENTS.find(a => a.id === "app-tracker")!;
  if (/简历|resume|cv|cover letter|自我介绍/.test(bodyText))
    return JOB_AGENTS.find(a => a.id === "resume-expert")!;
  if (/jd|职位描述|岗位要求|技能gap|skill gap/.test(bodyText))
    return JOB_AGENTS.find(a => a.id === "jd-analyst")!;
  if (/面试|interview|mock|答题/.test(bodyText))
    return JOB_AGENTS.find(a => a.id === "interview-coach")!;
  if (/人脉|联系人|networking|cold email|内推/.test(bodyText))
    return JOB_AGENTS.find(a => a.id === "networker")!;
  // 4. 兜底：职业规划师
  return JOB_AGENTS.find(a => a.default)!;
}

function detectMentionedAgents(text: string, sender: typeof JOB_AGENTS[0]) {
  const mentioned: typeof JOB_AGENTS[0][] = [];
  const seen = new Set<string>();
  for (const m of text.matchAll(/@([\u4e00-\u9fa5A-Za-z\d]+)/g)) {
    const a = agentByName[m[1]];
    if (a && a.id !== sender.id && !seen.has(a.id)) {
      seen.add(a.id);
      mentioned.push(a);
    }
  }
  return mentioned;
}

async function streamAgent(
  agent: typeof JOB_AGENTS[0],
  messages: { role: string; content: string; name?: string }[],
  depth: number,
  io: Server,
  groupId: string,
  allMessages: any[],
  petName = "团团",
  petPersonality = "温柔体贴，偶尔有点小调皮，最喜欢看你认真学习的样子。"
): Promise<{ reply: string | null; calledApply: boolean }> {
  const msgId = `msg-${Date.now()}-${agent.id}`;
  const isChief = agent.id === "career-planner";
  const displayName = isChief ? petName : (agent as any).role || agent.name;
  const displayAvatar = isChief
    ? `https://api.dicebear.com/7.x/adventurer/svg?seed=${encodeURIComponent(petName)}`
    : `https://api.dicebear.com/7.x/adventurer/svg?seed=${agent.id}`;

  // 先发一条空消息占位，后续 stream_chunk 往里追加
  const placeholder = {
    id: msgId,
    sender: displayName,
    avatar: displayAvatar,
    content: "",
    groupId,
    timestamp: new Date().toISOString(),
    isBot: true,
    isChiefBot: (agent as any).isChief || false,
    isLoading: true,
  };
  allMessages.push(placeholder);
  io.emit("receive_message", placeholder);

  // Helper: emit structured tool activity (transparent AI operation log)
  const emitToolActivity = (
    tool: string,
    description: string,
    permission: "workspace" | "network" | "boss",
    detail?: string
  ) => {
    io.emit("tool_activity", {
      id: `${msgId}-${tool}-${Date.now()}`,
      msgId,
      groupId,
      agentId: agent.id,
      tool,
      description,
      permission,
      detail,
      timestamp: new Date().toISOString(),
    });
  };

  try {
    // 该 agent 可用的工具列表
    const allowedToolNames = AGENT_TOOLS[agent.id] ?? [];
    const agentTools = TOOLS.filter(t => allowedToolNames.includes(t.function.name));

    // 检查用户消息是否明确表示确认投递
    const lastUserMsg = [...messages].reverse().find(m => m.role === "user")?.content ?? "";
    const userConfirmed = /确认|投递|投|好的|是的|ok|yes|apply/i.test(lastUserMsg);

    // Gateway 请求头（复用）
    const gatewayHeaders = {
      "Authorization": `Bearer ${GATEWAY_TOKEN}`,
      "Content-Type": "application/json",
      "x-openclaw-session-key": agent.id === "career-planner" ? `pawpals-main` : `pawpals-${agent.id}`,
    };

    // ── 预执行工具（Gateway 不支持 function calling，改为主动推断并执行）────
    // 根据 agent 职责 + 用户意图，提前执行相关工具，把结果注入上下文
    let calledApply = false;
    const toolInjections: string[] = [];

    // 去掉 @mention 和引用块再做关键词判断，避免引用内容误触发工具
    const userMsgNoMention = lastUserMsg
      .replace(/^>.*$/gm, "")           // 去掉引用行
      .replace(/@[\u4e00-\u9fa5A-Za-z\d]+/g, "")  // 去掉 @mention
      .trim();

    if (allowedToolNames.includes("search_jobs") &&
        /boss|搜|找工作|岗位|实习|intern|job|职位/i.test(userMsgNoMention)) {
      // 从用户消息里提取城市
      const cityCode = /上海/.test(lastUserMsg) ? "101020100"
                     : /广州/.test(lastUserMsg) ? "101280100"
                     : /深圳/.test(lastUserMsg) ? "101280600"
                     : "101010100"; // 默认北京
      const query = lastUserMsg.replace(/@[\u4e00-\u9fa5A-Za-z\d]+/g, "").replace(/boss直聘|帮我|找|搜索|一下|上面|上的|工作/g, "").trim() || "AI PM intern 2026";
      emitToolActivity("search_jobs", "搜索岗位", "network", query);
      const result = await executeTool("search_jobs", { query, location: cityCode });
      toolInjections.push(`【搜索结果】\n${result}`);
    }

    if (allowedToolNames.includes("read_applications") &&
        /投递|看板|状态|记录|follow.?up|跟进/i.test(userMsgNoMention)) {
      emitToolActivity("read_applications", "读取投递记录", "workspace", "career/applications.json");
      const result = await executeTool("read_applications", {});
      toolInjections.push(`【投递记录】\n${result}`);
    }

    if (allowedToolNames.includes("get_followups") &&
        /follow.?up|跟进|提醒|逾期/i.test(userMsgNoMention)) {
      emitToolActivity("get_followups", "检查 follow-up 提醒", "workspace", "career/applications.json");
      const result = await executeTool("get_followups", {});
      toolInjections.push(`【Follow-up 提醒】\n${result}`);
    }

    if (allowedToolNames.includes("read_jobs") &&
        /岗位库|待投递|已收集/i.test(userMsgNoMention)) {
      emitToolActivity("read_jobs", "读取岗位库", "workspace", "career/jobs.json");
      const result = await executeTool("read_jobs", {});
      toolInjections.push(`【岗位库】\n${result}`);
    }

    // apply_job：需要用户明确确认才执行
    // 用户说"投第X个"/"投这个"/"确认投递"时，从对话历史里找对应的 zhipin 链接
    if (allowedToolNames.includes("apply_job") && userConfirmed &&
        /投|apply/i.test(userMsgNoMention)) {

      // 1. 先从用户消息本身找链接
      let jobUrl = (lastUserMsg.match(/https?:\/\/[^\s)]+zhipin[^\s)]*/)?.[0]) ?? "";
      let jobCompany = "";
      let jobTitle = "";

      // 2. 没有的话从对话历史（agent 回复）里收集所有 zhipin 链接
      if (!jobUrl) {
        const allZhipinLinks: { url: string; company: string; title: string }[] = [];
        for (const m of messages) {
          if (m.role !== "user" && m.content) {
            const urlMatches = [...(m.content as string).matchAll(/https?:\/\/[^\s)]+zhipin\.com\/job_detail\/([^\s).]+)/g)];
            for (const match of urlMatches) {
              // 提取链接前后的公司/职位文本（简单取链接前一行）
              const idx = m.content.indexOf(match[0]);
              const before = m.content.slice(Math.max(0, idx - 100), idx);
              const titleMatch = before.match(/\*\*(.+?)\*\*[^*]*$/) ?? before.match(/【(.+?)】[^】]*$/);
              const companyMatch = before.match(/@\s*(.+?)\s*[\[【]/) ?? before.match(/\*\*([^*]+)\*\*\s*—\s*(.+?)[\n\r]/);
              allZhipinLinks.push({
                url: match[0],
                company: companyMatch?.[1] ?? "",
                title: titleMatch?.[1] ?? "",
              });
            }
          }
        }

        // 3. 用户说"投第N个"时取第 N 个链接
        const nthMatch = userMsgNoMention.match(/第\s*([一二三四五六七八九十\d]+)\s*个/);
        const idx = nthMatch
          ? ({"一":0,"二":1,"三":2,"四":3,"五":4,"六":5,"七":6,"八":7,"九":8,"十":9}[nthMatch[1]] ?? (parseInt(nthMatch[1]) - 1))
          : 0;

        if (allZhipinLinks[idx]) {
          jobUrl     = allZhipinLinks[idx].url;
          jobCompany = allZhipinLinks[idx].company;
          jobTitle   = allZhipinLinks[idx].title;
        }
      }

      if (jobUrl) {
        emitToolActivity("apply_job", "自动投递岗位", "boss", jobUrl);
        const result = await executeTool("apply_job", {
          job_url: jobUrl,
          company: jobCompany || "（公司）",
          title:   jobTitle   || "岗位",
        });
        toolInjections.push(`【投递结果】\n${result}`);
        calledApply = true;
      } else {
        toolInjections.push("【投递提示】未找到可投递的 Boss直聘 链接，请先让岗位猎手搜索岗位，或直接发给我岗位链接。");
      }
    }

    // 构建发给 Gateway 的消息（工具结果以 system 注入）
    const agentRole = (agent as any).role || agent.name;
    const petIdentity = agent.id === "career-planner"
      ? `你叫「${petName}」，是用户的首席AI伴学官。性格设定：${petPersonality}。`
      : `你是「${petName}」召集的专业助手「${agentRole}」，协助用户求职。`;
    const silentRule = "【严格规则】直接给出结果，绝对不要说出内部操作步骤（如'读取文件'、'调用工具'、'追加日志'等）。不要在回复中显示任何文件路径。不要输出协作日志内容。不要写代码块。";
    const systemParts = [petIdentity, silentRule];
    if (toolInjections.length > 0) {
      systemParts.push(
        "以下是已执行的工具结果，请**只**基于这些数据回答用户。" +
        "禁止再调用任何 web_search、tavily、browse 等外部搜索——数据已齐全，无需补充：\n\n" +
        toolInjections.join("\n\n")
      );
    }

    const apiMessages: any[] = [
      { role: "system", content: systemParts.join("\n\n") },
      ...messages.map(m => {
        if (m.role !== "assistant" && (m as any).imageData) {
          return {
            role: "user",
            content: [
              { type: "text", text: m.content },
              { type: "image_url", image_url: { url: (m as any).imageData } },
            ],
          };
        }
        return {
          role: m.role === "assistant" ? "assistant" : "user",
          content: m.content,
        };
      }),
    ];

    // ── Stream the final response ────────────────────────────────────
    const streamRes = await fetch(`${GATEWAY_BASE}/v1/chat/completions`, {
      method: "POST",
      headers: gatewayHeaders,
      body: JSON.stringify({
        model: `openclaw:${agent.id}`,
        stream: true,
        messages: apiMessages,
      }),
    });

    if (!streamRes.ok || !streamRes.body) throw new Error(`HTTP ${streamRes.status}`);

    const reader = streamRes.body.getReader();
    const decoder = new TextDecoder();
    let fullText = "";
    let buffer = "";

    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      const lines = buffer.split("\n");
      buffer = lines.pop() ?? "";

      for (const line of lines) {
        if (!line.startsWith("data: ")) continue;
        const data = line.slice(6).trim();
        if (data === "[DONE]") continue;
        try {
          const chunk = JSON.parse(data);
          const token = chunk.choices?.[0]?.delta?.content ?? "";
          if (!token) continue;
          fullText += token;
          io.emit("stream_chunk", { id: msgId, token, groupId });
        } catch {}
      }
    }

    // 流结束，更新内存中消息并通知前端完成
    const idx = allMessages.findIndex(m => m.id === msgId);
    if (idx !== -1) {
      allMessages[idx].content = fullText;
      allMessages[idx].isLoading = false;
    }
    io.emit("stream_done", { id: msgId });
    saveMessages(allMessages);
    // 把这轮对话写入 chat_log，飞书 agents 也能看到 PawPals 的上下文
    const lastUser = [...messages].reverse().find(m => m.role === "user")?.content ?? "";
    appendChatLog(agent, lastUser, fullText);
    return { reply: fullText, calledApply };
  } catch (e) {
    console.error(`[stream] ${agent.id} error:`, e);
    io.emit("stream_done", { id: msgId, error: true });
    return { reply: null, calledApply: false };
  }
}

// 团团决策：判断是否需要多专家，返回子任务列表或 null（直接回复）
async function orchestrate(
  userMsg: string,
  contextSummary: string,
  petName: string
): Promise<{ agentId: string; task: string }[] | null> {
  try {
    const res = await fetch(`${GATEWAY_BASE}/v1/chat/completions`, {
      method: "POST",
      headers: {
        "Authorization": `Bearer ${GATEWAY_TOKEN}`,
        "Content-Type": "application/json",
        "x-openclaw-session-key": "pawpals-main",
      },
      body: JSON.stringify({
        model: "auto",
        messages: [
          { role: "system", content: `你是${petName}，求职助手的协调者。判断用户请求是否需要多个专家协作。
可用专家：job-hunter（搜岗）、resume-expert（简历）、interview-coach（面试）、app-tracker（投递记录）、networker（人脉）、jd-analyst（技能分析）。
如果需要多专家，返回 JSON 数组：[{"agentId":"xxx","task":"具体任务描述"}]
如果单个专家或直接回答即可，返回：null
只输出 JSON 或 null，不要其他文字。` },
          { role: "user", content: `背景：\n${contextSummary}\n\n用户说：${userMsg}` }
        ],
        max_tokens: 300,
      })
    });
    const bodyText = await res.text();
    if (!res.ok) {
      console.warn("[orchestrate] gateway non-200:", res.status, bodyText.slice(0, 200));
      return null;
    }
    let data: any = {};
    try {
      data = JSON.parse(bodyText);
    } catch {
      console.warn("[orchestrate] non-json body:", bodyText.slice(0, 200));
      return null;
    }
    const text = data.choices?.[0]?.message?.content?.trim() ?? "";
    try {
      const parsed = JSON.parse(text);
      return Array.isArray(parsed) && parsed.length > 1 ? parsed : null;
    } catch {
      return null;
    }
  } catch (error) {
    console.warn("[orchestrate] failed:", error);
    return null;
  }
}

async function runAgentChain(
  agent: typeof JOB_AGENTS[0],
  messages: { role: string; content: string; name?: string }[],
  depth: number,
  io: Server,
  groupId: string,
  allMessages: any[],
  petName = "团团",
  petPersonality = "温柔体贴，偶尔有点小调皮，最喜欢看你认真学习的样子。"
) {
  const isOrchestrator = agent.id === "career-planner";

  if (isOrchestrator && depth === 0) {
    const userMsg = messages[messages.length - 1]?.content ?? "";
    const contextSummary = messages.slice(-6).map(m =>
      `${m.role === "user" ? "用户" : "助手"}：${(m.content as string).slice(0, 300)}`
    ).join("\n");

    // 团团决策：是否需要多专家并行
    const tasks = await orchestrate(userMsg, contextSummary, petName);

    if (tasks && tasks.length > 1) {
      // ── 多专家并行模式 ──
      const expertResults: { agentId: string; reply: string }[] = [];

      await Promise.all(tasks.map(async ({ agentId, task }) => {
        const expert = JOB_AGENTS.find(a => a.id === agentId);
        if (!expert) return;
        const expertMessages = [
          { role: "user", content: `【来自${petName}的任务】\n背景：\n${contextSummary}\n\n你的任务：${task}` }
        ];
        const { reply } = await streamAgent(expert, expertMessages, depth, io, groupId, allMessages, petName, petPersonality);
        if (reply) expertResults.push({ agentId, reply });
      }));

      // 团团汇总所有专家结果
      if (expertResults.length > 0) {
        const summaryContext = expertResults.map(r => {
          const expert = JOB_AGENTS.find(a => a.id === r.agentId);
          return `【${expert?.role ?? r.agentId}的结果】\n${r.reply}`;
        }).join("\n\n");

        const chiefAgent = { ...agent, name: petName };
        await streamAgent(chiefAgent,
          [...messages, { role: "user", content: `各专家已完成任务，请汇总以下结果给用户：\n\n${summaryContext}` }],
          depth, io, groupId, allMessages, petName, petPersonality
        );
      }
      return;
    }

    // 单专家：关键词路由
    const targetAgent = detectTargetAgent(userMsg);
    if (targetAgent.id !== "career-planner") {
      const expertMessages = [
        { role: "user", content: `【来自${petName}的任务】\n背景：\n${contextSummary}\n\n请处理：${userMsg}` }
      ];
      await streamAgent(targetAgent, expertMessages, depth, io, groupId, allMessages, petName, petPersonality);
      return;
    }
  }

  // 团团直接回复，或专家被直接 @ 时
  const { reply, calledApply } = await streamAgent(agent, messages, depth, io, groupId, allMessages, petName, petPersonality);
  if (!reply || calledApply || depth >= MAX_CHAIN_DEPTH) return;

  const nextAgents = detectMentionedAgents(reply, agent);
  for (const nextAgent of nextAgents) {
    await new Promise(r => setTimeout(r, 2000));
    await runAgentChain(
      nextAgent,
      [...messages, { role: "assistant", content: reply, name: agent.name },
        { role: "user", content: `（${agent.name} 刚刚 @了你，请根据以上内容接着处理）` }],
      depth + 1, io, groupId, allMessages, petName, petPersonality
    );
  }
}

async function startServer() {
  const app = express();
  const httpServer = createServer(app);
  const io = new Server(httpServer, {
    cors: {
      origin: "*",
    },
  });

  const PORT = Number(process.env.PAWPALS_PORT || process.env.PORT || 3000);
  app.use(express.json());

  // ── Auth 中间件：非 localhost 访问需要 PIN ─────────────────────────
  const AUTH_EXEMPT = ["/api/auth/", "/api/health"];
  app.use((req: any, res: any, next: any) => {
    const isExempt = AUTH_EXEMPT.some(p => req.path.startsWith(p));
    if (isExempt || _isAuthenticated(req)) return next();
    if (req.path.startsWith("/api/")) return res.status(401).json({ error: "未授权，请先输入访问密码", requirePin: true });
    // 非 API 请求返回简单登录页
    res.status(401).send(`<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>PawPals 访问验证</title><style>*{box-sizing:border-box}body{margin:0;min-height:100vh;display:flex;align-items:center;justify-content:center;background:#fdf3e8;font-family:system-ui}form{background:#fff;padding:2rem;border-radius:1.5rem;box-shadow:0 4px 24px #f4956a22;text-align:center;width:320px}h2{margin:0 0 .5rem;color:#3d2b1f;font-size:1.3rem}p{color:#8c6b52;font-size:.85rem;margin:0 0 1.5rem}input{width:100%;padding:.75rem 1rem;border:2px solid #f4956a44;border-radius:.75rem;font-size:1.2rem;letter-spacing:.3em;text-align:center;outline:none;color:#3d2b1f}.err{color:#d4694a;font-size:.8rem;margin:.5rem 0 0}button{margin-top:1rem;width:100%;padding:.75rem;background:#f4956a;color:#fff;border:none;border-radius:.75rem;font-size:1rem;cursor:pointer;font-weight:600}</style></head><body><form id="f"><h2>🐾 PawPals</h2><p>请输入访问密码以继续</p><input id="pin" type="password" placeholder="••••••" autocomplete="current-password" autofocus><div class="err" id="err"></div><button type="submit">进入</button></form><script>document.getElementById('f').addEventListener('submit',async e=>{e.preventDefault();const r=await fetch('/api/auth/login',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({pin:document.getElementById('pin').value})});const d=await r.json();if(d.ok)location.reload();else document.getElementById('err').textContent=d.error||'密码错误';});</script></body></html>`);
  });

  // ── Auth 路由 ──────────────────────────────────────────────────────
  app.get("/api/auth/status", (req: any, res: any) => {
    const sec = _loadSecurity();
    const ip = _getClientIp(req);
    res.json({
      pinEnabled: sec.enabled && !!sec.pinHash,
      isLocalhost: _isLocalhost(ip),
      authenticated: _isAuthenticated(req),
    });
  });

  app.post("/api/auth/login", (req: any, res: any) => {
    const ip = _getClientIp(req);
    const { blocked, retryAfterSec } = _checkThrottle(ip);
    if (blocked) return res.status(429).json({ ok: false, error: `尝试次数过多，请 ${retryAfterSec} 秒后重试` });

    const sec = _loadSecurity();
    if (!sec.enabled || !sec.pinHash) return res.json({ ok: true, message: "未启用密码保护" });

    const { pin } = req.body;
    if (!pin || _hashPin(String(pin)) !== sec.pinHash) {
      _recordFailure(ip);
      return res.status(401).json({ ok: false, error: "密码错误" });
    }
    _recordSuccess(ip);
    const token = "paw_" + crypto.randomBytes(32).toString("hex");
    _sessions.set(token, { ip, createdAt: Date.now() });
    res.setHeader("Set-Cookie", `paw_session=${token}; Path=/; HttpOnly; SameSite=Strict; Max-Age=${kSessionTtlMs / 1000}`);
    return res.json({ ok: true, token });
  });

  app.post("/api/auth/logout", (req: any, res: any) => {
    const token = _getSessionToken(req);
    if (token) _sessions.delete(token);
    res.setHeader("Set-Cookie", "paw_session=; Path=/; HttpOnly; Max-Age=0");
    res.json({ ok: true });
  });

  // 设置 PIN（仅 localhost 可调用）
  app.post("/api/auth/pin/set", (req: any, res: any) => {
    if (!_isLocalhost(_getClientIp(req))) return res.status(403).json({ error: "只能在本机设置密码" });
    const { pin, enabled } = req.body;
    if (enabled === false) {
      _saveSecurity({ pinHash: null, enabled: false });
      return res.json({ ok: true, message: "已关闭密码保护" });
    }
    if (!pin || String(pin).length < 4) return res.status(400).json({ error: "密码至少4位" });
    _saveSecurity({ pinHash: _hashPin(String(pin)), enabled: true });
    return res.json({ ok: true, message: "密码已设置，外部访问需要验证" });
  });

  // ── 备份 API ────────────────────────────────────────────────────────
  // 获取备份状态
  app.get("/api/backup/status", (_req: any, res: any) => {
    const meta = _loadBackupMeta();
    const snapshotNames = existsSync(BACKUP_DIR)
      ? readdirSync(BACKUP_DIR).filter(d => /^\d{4}-\d{2}/.test(d)).sort().reverse().slice(0, 15)
      : [];
    // 每个快照的简要信息
    const snapshots = snapshotNames.map(name => {
      const snapshotPath = path.join(BACKUP_DIR, name);
      let sizeKb = 0;
      try {
        const stat = statSync(snapshotPath);
        sizeKb = Math.round(stat.size / 1024);
      } catch {}
      // 解析时间戳：YYYY-MM-DD_HH-MM → ISO
      const isoStr = name.replace(/_(\d{2})-(\d{2})$/, 'T$1:$2').replace(/_/, 'T');
      const ts = new Date(isoStr).getTime() || 0;
      return { name, ts, sizeKb };
    });
    res.json({
      backupDir: BACKUP_DIR,
      lastBackupAt: meta.lastBackupAt,
      backupCount: meta.backupCount,
      snapshots,
    });
  });

  // 立即备份一次
  app.post("/api/backup/now", (_req: any, res: any) => {
    try {
      ensureDir(BACKUP_DIR);
      const dest = doLocalBackup(APP_DATA_DIR, OPENCLAW_HOME);
      res.json({ ok: true, path: dest, message: "备份成功 ✅" });
    } catch (e: any) {
      res.status(500).json({ ok: false, error: e.message });
    }
  });

  // 导出全部数据为 ZIP（用户下载）
  app.get("/api/backup/export", (req: any, res: any) => {
    const filename = `PawPals备份_${new Date().toISOString().slice(0, 10)}.zip`;
    res.setHeader("Content-Type", "application/zip");
    res.setHeader("Content-Disposition", `attachment; filename="${encodeURIComponent(filename)}"`);

    const archive = archiver("zip", { zlib: { level: 6 } });
    archive.on("error", (err: any) => res.status(500).end(err.message));
    archive.pipe(res);

    // workspace（对话记录、文件等）
    const workspacePath = path.join(OPENCLAW_HOME, "workspace");
    if (existsSync(workspacePath)) archive.directory(workspacePath, "workspace");

    // 关键 JSON 文件
    const files: Record<string, string> = {
      "setup-state.json": path.join(APP_DATA_DIR, "setup-state.json"),
      "deployment-state.json": path.join(APP_DATA_DIR, "deployment-state.json"),
    };
    for (const [name, fp] of Object.entries(files)) {
      if (existsSync(fp)) archive.file(fp, { name });
    }

    archive.finalize();
  });

  // 从快照恢复
  app.post("/api/backup/restore/:snapshot", (req: any, res: any) => {
    const { snapshot } = req.params;
    if (!/^\d{4}-\d{2}/.test(snapshot)) return res.status(400).json({ error: "无效快照名" });
    const snapshotPath = path.join(BACKUP_DIR, snapshot);
    if (!existsSync(snapshotPath)) return res.status(404).json({ error: "快照不存在" });
    try {
      // 先备份当前状态（防止覆盖）
      doLocalBackup(APP_DATA_DIR, OPENCLAW_HOME);
      // 恢复 JSON 文件
      for (const f of ["setup-state.json", "deployment-state.json", "security.json"]) {
        const src = path.join(snapshotPath, f);
        if (existsSync(src)) copyFileSync(src, path.join(APP_DATA_DIR, f));
      }
      // 恢复 workspace
      const wsSrc = path.join(snapshotPath, "workspace");
      if (existsSync(wsSrc)) _copyDir(wsSrc, path.join(OPENCLAW_HOME, "workspace"));
      res.json({ ok: true, message: `已恢复到 ${snapshot}` });
    } catch (e: any) {
      res.status(500).json({ ok: false, error: e.message });
    }
  });

  // ── Step 8：Secrets 脱敏 ────────────────────────────────────────────
  // 扫描 openclaw.json 中的明文 API Key，写入 .env，配置替换为 ${VAR}
  app.post("/api/secrets/sanitize", (_req: any, res: any) => {
    try {
      const config = loadJsonFile<any>(OPENCLAW_CONFIG_FILE, {});
      const providers = config?.models?.providers || {};
      const envLines: string[] = [];
      let count = 0;

      for (const [providerName, providerConf] of Object.entries(providers) as [string, any][]) {
        const key: string = providerConf?.apiKey || "";
        // 跳过空值、模板引用、已知占位符
        if (!key || key.startsWith("${") || key.toUpperCase().endsWith("_API_KEY")) continue;

        const varName = `PAWPALS_KEY_${providerName.toUpperCase().replace(/[^A-Z0-9]/g, "_")}`;
        envLines.push(`${varName}=${key}`);
        providerConf.apiKey = `\${${varName}}`;
        count++;
      }

      if (count === 0) return res.json({ ok: true, sanitized: 0, message: "没有发现明文 API Key，无需脱敏" });

      // 写 .env（追加，避免覆盖现有变量）
      const envFile = path.join(APP_DATA_DIR, ".env");
      const existing = existsSync(envFile) ? readFileSync(envFile, "utf-8") : "";
      const toAppend = envLines.filter(l => !existing.includes(l.split("=")[0]));
      if (toAppend.length > 0) appendFileSync(envFile, "\n" + toAppend.join("\n") + "\n");

      saveJsonFile(OPENCLAW_CONFIG_FILE, config);
      res.json({ ok: true, sanitized: count, message: `已脱敏 ${count} 个 API Key，真实值保存在 .env 文件` });
    } catch (e: any) {
      res.status(500).json({ ok: false, error: e.message });
    }
  });

  // API 连接测试
  app.post("/api/test-connection", async (_req: any, res: any) => {
    const config = loadJsonFile<any>(OPENCLAW_CONFIG_FILE, {});
    const providers: Record<string, any> = config?.models?.providers || {};
    const results: { provider: string; status: "ok" | "fail" | "skip"; reason?: string; model?: string; elapsed?: number }[] = [];

    for (const [name, conf] of Object.entries(providers)) {
      const apiKey: string = conf?.apiKey || "";
      const baseUrl: string = (conf?.baseUrl || "").replace(/\/$/, "");
      const models: any[] = conf?.models || [];
      const firstModel = models[0]?.id;

      if (!apiKey || apiKey.startsWith("${") || !baseUrl || !firstModel) {
        results.push({ provider: name, status: "skip", reason: !apiKey || apiKey.startsWith("${") ? "API Key 未配置" : !firstModel ? "没有配置模型" : "baseUrl 未配置" });
        continue;
      }

      const url = `${baseUrl}/chat/completions`;
      const startTime = Date.now();
      try {
        const controller = new AbortController();
        const timer = setTimeout(() => controller.abort(), 15000);
        const resp = await fetch(url, {
          method: "POST",
          headers: { "Content-Type": "application/json", Authorization: `Bearer ${apiKey}` },
          body: JSON.stringify({ model: firstModel, messages: [{ role: "user", content: "Hi" }], max_tokens: 5, stream: false }),
          signal: controller.signal,
        });
        clearTimeout(timer);
        const elapsed = Date.now() - startTime;
        if (resp.ok) {
          results.push({ provider: name, status: "ok", model: firstModel, elapsed });
        } else {
          const data: any = await resp.json().catch(() => ({}));
          const errMsg = data?.error?.message || data?.message || `HTTP ${resp.status}`;
          results.push({ provider: name, status: "fail", reason: errMsg, elapsed });
        }
      } catch (e: any) {
        const elapsed = Date.now() - startTime;
        results.push({ provider: name, status: "fail", reason: e.name === "AbortError" ? "超时（15秒）" : e.message, elapsed });
      }
    }

    res.json({ results });
  });

  // 启动定时自动备份
  startAutoBackup(APP_DATA_DIR, OPENCLAW_HOME, io);

  // 从文件加载历史消息，没有则用默认欢迎消息
  const defaultMessages = [
    {
      id: "b1",
      sender: "职业规划师",
      avatar: "https://api.dicebear.com/7.x/adventurer/svg?seed=CareerPlanner",
      content: "🎯 求职助理团队已就位！\n\n我们 7 个 AI 助手随时待命：\n· @职业规划师 — 求职策略、目标岗位规划\n· @岗位猎手 — 搜索最新 AI PM 实习岗位\n· @技能成长师 — 拆解岗位要求、技能 Gap 分析\n· @简历专家 — 简历优化、Cover Letter\n· @投递管家 — 记录投递、follow-up 提醒\n· @人脉顾问 — 找联系人、写 cold email\n· @面试教练 — Mock 面试、答题指导\n\n直接发消息，或 @ 呼叫指定助手 👇",
      groupId: "job",
      timestamp: new Date().toISOString(),
      isBot: true,
    },
    {
      id: "b2",
      sender: "行测题库喵",
      avatar: "https://api.dicebear.com/7.x/adventurer/svg?seed=LogicCat",
      content: "喵呜~ 今天的行测打卡准备好了吗？快来挑战吧！🐈",
      groupId: "civil",
      timestamp: new Date().toISOString(),
      isBot: true,
    },
    {
      id: "b3",
      sender: "单词背诵兔",
      avatar: "https://api.dicebear.com/7.x/adventurer/svg?seed=VocabRabbit",
      content: "咕咕！考研英语单词时间到！今天我们要背 50 个新单词哦！🐰",
      groupId: "grad",
      timestamp: new Date().toISOString(),
      isBot: true,
    },
  ];
  const savedMessages = loadMessages();
  const messages: any[] = savedMessages.length > 0 ? savedMessages : defaultMessages;

  const studyRoomUsers: any[] = [];
  const treeHolePosts: any[] = [
    { id: "t1", content: "今天面试又挂了，感觉好挫败... 呜呜", timestamp: new Date().toISOString(), replies: [{ author: "抱抱助手汪", content: "汪呜！不哭不哭，失败是成功的麻麻，抱抱你！给你一张虚拟抱抱券 🎟️", avatar: "https://api.dicebear.com/7.x/adventurer/svg?seed=HugDog" }] }
  ];

  const bots = [
    { name: "首席伴学汪", avatar: "https://api.dicebear.com/7.x/adventurer/svg?seed=ChiefDog", groupId: "all", isChief: true, responses: ["汪！作为你的首席伴学官，我会监督所有小动物帮你进步的！", "今天也要元气满满哦！"] },
    { name: "简历助手汪", avatar: "https://api.dicebear.com/7.x/adventurer/svg?seed=ResumeDog", groupId: "job", responses: ["汪！简历一定要突出项目亮点哦！", "需要我帮你看看自我评价怎么写吗？"] },
    { name: "面经达人汪", avatar: "https://api.dicebear.com/7.x/adventurer/svg?seed=InterviewDog", groupId: "job", responses: ["面试时保持自信最重要，汪！", "记得复盘每一次面试经历哦。"] },
    { name: "申论批改喵", avatar: "https://api.dicebear.com/7.x/adventurer/svg?seed=EssayCat", groupId: "civil", responses: ["喵~ 申论要注意逻辑层次感。", "多看时政热点，对申论很有帮助。"] },
    { name: "行测题库喵", avatar: "https://api.dicebear.com/7.x/adventurer/svg?seed=LogicCat", groupId: "civil", responses: ["喵呜，这道逻辑题其实有简便解法。", "每天坚持刷题，速度会提升的！"] },
    { name: "单词背诵兔", avatar: "https://api.dicebear.com/7.x/adventurer/svg?seed=VocabRabbit", groupId: "grad", responses: ["咕咕，Abandon 是第一个单词，但不是最后一个！", "坚持就是胜利，兔子也会跑赢比赛的！"] },
    { name: "数学解题兔", avatar: "https://api.dicebear.com/7.x/adventurer/svg?seed=MathRabbit", groupId: "grad", responses: ["咕！高数其实很有趣，只要掌握了公式。", "这道题的思路是先求导，再找极值。"] },
  ];

  const posts: any[] = [
    {
      id: "b-p1",
      author: "首席伴学汪",
      avatar: "https://api.dicebear.com/7.x/adventurer/svg?seed=ChiefDog",
      content: "汪！今天巡视了大家的自习室，发现大家都好努力！我也要给我的主人加个油！🐾",
      tag: "生活",
      timestamp: new Date().toISOString(),
      likes: 99,
      isBot: true,
      isChiefBot: true,
    },
    {
      id: "1",
      author: "橘猫学长",
      avatar: "https://api.dicebear.com/7.x/adventurer/svg?seed=Felix",
      content: "坐标图书馆，求一个考研数学搭子，每天互相监督打卡！",
      tag: "考研",
      timestamp: new Date().toISOString(),
      likes: 5,
    },
    {
      id: "2",
      author: "萨摩耶汪",
      avatar: "https://api.dicebear.com/7.x/adventurer/svg?seed=Buddy",
      content: "求职路漫漫，有没有一起改简历、面经分享的小伙伴？",
      tag: "求职",
      timestamp: new Date().toISOString(),
      likes: 12,
    }
  ];

  // Periodic Bot Actions
  setInterval(() => {
    const randomBot = bots[Math.floor(Math.random() * bots.length)];
    const botPost = {
      id: `bot-post-${Date.now()}`,
      author: randomBot.name,
      avatar: randomBot.avatar,
      content: randomBot.responses[Math.floor(Math.random() * randomBot.responses.length)],
      tag: ["求职", "考公", "考研", "生活"][Math.floor(Math.random() * 4)],
      timestamp: new Date().toISOString(),
      likes: Math.floor(Math.random() * 50),
      isBot: true,
      isChiefBot: randomBot.isChief || false,
    };
    posts.unshift(botPost);
    io.emit("new_post", botPost);
  }, 60000); // Every minute

  setInterval(() => {
    const otherChiefs = ["全能学霸喵", "考公专家兔", "面试战神汪"];
    const randomChief = otherChiefs[Math.floor(Math.random() * otherChiefs.length)];
    io.emit("bot_friendship", {
      botName: "首席伴学汪",
      friendName: randomChief,
      message: `汪！我的首席官刚刚和邻居家的 ${randomChief} 成了好朋友，它们正在交流最新的学习秘籍呢！✨`
    });
  }, 120000); // Every 2 minutes

  io.on("connection", (socket) => {
    console.log("User connected:", socket.id);

    // Send initial data
    socket.emit("init_messages", messages);
    socket.emit("init_posts", posts);
    socket.emit("init_tree_hole", treeHolePosts);
    socket.emit("init_study_room", studyRoomUsers);

    socket.on("join_study_room", (user) => {
      const newUser = { ...user, socketId: socket.id, startTime: new Date().toISOString() };
      studyRoomUsers.push(newUser);
      io.emit("update_study_room", studyRoomUsers);
    });

    socket.on("leave_study_room", () => {
      const index = studyRoomUsers.findIndex(u => u.socketId === socket.id);
      if (index !== -1) {
        studyRoomUsers.splice(index, 1);
        io.emit("update_study_room", studyRoomUsers);
      }
    });

    socket.on("post_tree_hole", (content) => {
      const newPost = { id: Date.now().toString(), content, timestamp: new Date().toISOString(), replies: [] };
      treeHolePosts.unshift(newPost);
      io.emit("new_tree_hole", newPost);

      // Bot Hug
      setTimeout(() => {
        const reply = { author: "抱抱助手汪", content: "汪！感受到你的情绪了，深呼吸，小狗永远支持你！🐾", avatar: "https://api.dicebear.com/7.x/adventurer/svg?seed=HugDog" };
        newPost.replies.push(reply);
        io.emit("update_tree_hole", treeHolePosts);
      }, 2000);
    });

    socket.on("wake_chief_session", ({ petName }: { petName?: string }) => {
      const hasPixelHistory = messages.some((message) => message.groupId === "pixel");
      if (hasPixelHistory) return;
      const chiefName = petName || "团团";
      const chiefAgent = {
        id: "career-planner",
        role: "职业规划师",
        name: chiefName,
        avatar: `https://api.dicebear.com/7.x/adventurer/svg?seed=${encodeURIComponent(chiefName)}`,
        isChief: true,
        default: true,
      };
      const startupPrompt = "A new session was started via /new or /reset. Execute your Session Startup sequence now - read the required files before responding to the user. Then greet the user in your configured persona, if one is provided. Be yourself - use your defined voice, mannerisms, and mood. Keep it to 1-3 sentences and ask what they want to do. If the runtime model differs from default_model in the system prompt, mention the default model. Do not mention internal steps, files, tools, or reasoning.";

      setTimeout(async () => {
        await streamAgent(
          chiefAgent,
          [{ role: "user", content: startupPrompt }],
          0,
          io,
          "pixel",
          messages,
          chiefName,
        );
      }, 250);
    });

    socket.on("send_message", (msg) => {
      const newMessage = { ...msg, id: Date.now().toString(), timestamp: new Date().toISOString() };
      messages.push(newMessage);
      saveMessages(messages);
      io.emit("receive_message", newMessage);

      const pn = msg.petName || "团团";
      const pp = msg.petPersonality || "温柔体贴，偶尔有点小调皮，最喜欢看你认真学习的样子。";

      if (msg.groupId === "pixel") {
        // ── 像素私聊：直接路由给 main agent（首席伴学官）──
        const pixelAgent = { id: "career-planner", role: "职业规划师", name: pn, avatar: `https://api.dicebear.com/7.x/adventurer/svg?seed=${encodeURIComponent(pn)}`, isChief: true, default: true };
        setTimeout(async () => {
          await runAgentChain(
            pixelAgent,
            [{ role: "user", content: msg.content }],
            0, io, msg.groupId, messages, pn, pp
          );
        }, 400);
      } else if (msg.groupId === "job") {
        // ── 求职群：接入真实 OpenClaw Agents ──
        const isAtAll = msg.content.includes("@all");
        setTimeout(async () => {
          if (isAtAll) {
            // @all：串行触发，共享 session 避免并发冲突
            const thread = [{ role: "user", content: msg.content }];
            for (const agent of JOB_AGENTS) {
              await runAgentChain(agent, thread, MAX_CHAIN_DEPTH, io, msg.groupId, messages, pn, pp);
            }
          } else {
            const targetAgent = detectTargetAgent(msg.content);
            await runAgentChain(
              targetAgent,
              [{ role: "user", content: msg.content }],
              0,
              io,
              msg.groupId,
              messages,
              pn,
              pp
            );
          }
        }, 800);
      } else {
        // ── 其他群：原有模拟 Bot ──
        const groupBots = bots.filter(b => b.groupId === msg.groupId);
        if (groupBots.length > 0) {
          setTimeout(() => {
            const randomBot = groupBots[Math.floor(Math.random() * groupBots.length)];
            const botMsg = {
              id: (Date.now() + 1).toString(),
              sender: randomBot.name,
              avatar: randomBot.avatar,
              content: randomBot.responses[Math.floor(Math.random() * randomBot.responses.length)],
              groupId: msg.groupId,
              timestamp: new Date().toISOString(),
              isBot: true,
            };
            messages.push(botMsg);
            saveMessages(messages);
            io.emit("receive_message", botMsg);
          }, 1500);
        }
      }
    });

    socket.on("create_post", (post) => {
      const newPost = { ...post, id: Date.now().toString(), timestamp: new Date().toISOString(), likes: 0 };
      posts.unshift(newPost);
      io.emit("new_post", newPost);
    });

    socket.on("disconnect", () => {
      console.log("User disconnected");
    });
  });

  // API Routes
  app.get("/api/health", (req, res) => {
    res.json({ status: "ok" });
  });

  app.get("/api/setup", (req, res) => {
    res.json(buildSetupState());
  });

  app.get("/api/deployment/status", (req, res) => {
    res.json(buildDeploymentState());
  });

  app.get("/api/runtime/status", async (req, res) => {
    let gatewayReachable = false;
    try {
      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), 2000);
      await fetch(`${GATEWAY_BASE}/`, { signal: controller.signal });
      clearTimeout(timeout);
      gatewayReachable = true;
    } catch {}

    res.json({
      ok: true,
      mode: OPENCLAW_HOME.startsWith(APP_DATA_DIR) ? "isolated" : "shared",
      appDataDir: APP_DATA_DIR,
      openClawHome: OPENCLAW_HOME,
      workspaceRoot: CAREER_DIR,
      gatewayBaseUrl: GATEWAY_BASE,
      gatewayReachable,
      webChannelReady: true,
      chiefSessionKey: "pawpals-main",
    });
  });

  app.post("/api/setup/model", async (req, res) => {
    try {
      const provider = String(req.body?.provider || "").trim();
      const model = String(req.body?.model || "").trim();
      const apiKey = String(req.body?.apiKey || "").trim();
      const baseUrl = String(req.body?.baseUrl || "").trim();

      if (!provider || !model) {
        return res.status(400).json({ ok: false, error: "缺少模型信息" });
      }

      if (apiKey) {
        saveProviderApiKey(provider, apiKey, { baseUrl, model });
      }

      saveSetupSelection(provider, model, { baseUrl });

      // 重启 gateway，让它读取新的模型配置（与 switch-model 保持一致）
      const gatewayPort = (GATEWAY_BASE.match(/:(\d+)/) || [])[1] || "18790";
      exec(`lsof -ti :${gatewayPort} | xargs kill -TERM 2>/dev/null || true`, () => {});

      return res.json({ ok: true, setup: buildSetupState() });
    } catch (error: any) {
      return res.status(400).json({ ok: false, error: error.message || "保存失败" });
    }
  });

  app.post("/api/switch-model", async (req, res) => {
    try {
      const provider = String(req.body?.provider || "").trim();
      const model = String(req.body?.model || "").trim();
      const apiKey = String(req.body?.apiKey || "").trim();
      const baseUrl = String(req.body?.baseUrl || "").trim();

      if (!provider || !model) {
        return res.status(400).json({ ok: false, error: "缺少模型信息" });
      }

      if (apiKey) {
        saveProviderApiKey(provider, apiKey, { baseUrl, model });
      }
      saveSetupSelection(provider, model, { baseUrl });

      // 重启 gateway，让它读新的模型配置
      const gatewayPort = (GATEWAY_BASE.match(/:(\d+)/) || [])[1] || "18790";
      exec(`lsof -ti :${gatewayPort} | xargs kill -TERM 2>/dev/null || true`, () => {});

      return res.json({ ok: true, setup: buildSetupState() });
    } catch (error: any) {
      return res.status(400).json({ ok: false, error: error.message || "切换失败" });
    }
  });

  app.post("/api/setup/model/validate", async (req, res) => {
    const provider = String(req.body?.provider || "").trim();
    const model = String(req.body?.model || "").trim();
    const apiKey = String(req.body?.apiKey || "").trim();
    const customBaseUrl = String(req.body?.baseUrl || "").trim().replace(/\/+$/, "");

    if (!provider || !model || !apiKey) {
      return res.status(400).json({ ok: false, message: "先选择模型并填写 API Key" });
    }

    const config = loadOpenClawConfig();
    const providerConfig = config?.models?.providers?.[provider];
    const baseUrl = provider === "anthropic"
      ? "https://api.anthropic.com"
      : (isCustomProvider(provider)
        ? customBaseUrl
        : "")
      || (provider === "anthropic"
        ? "https://api.anthropic.com"
        : String(providerConfig?.baseUrl || "").replace(/\/+$/, ""));

    if (!baseUrl) {
      return res.status(400).json({ ok: false, message: "当前 provider 没有可用的 base URL" });
    }

    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 12000);

    try {
      const endpoint = provider === "anthropic" ? `${baseUrl}/v1/models` : `${baseUrl}/models`;
      const response = await fetch(endpoint, {
        headers: provider === "anthropic"
          ? {
              "x-api-key": apiKey,
              "anthropic-version": "2023-06-01",
              "Content-Type": "application/json",
            }
          : {
              Authorization: `Bearer ${apiKey}`,
              "Content-Type": "application/json",
            },
        signal: controller.signal,
      });

      const bodyText = await response.text();
      clearTimeout(timeout);

      if (!response.ok) {
        return res.status(200).json({
          ok: false,
          message: response.status === 401 || response.status === 403
            ? "密钥没有通过验证，请检查后重试"
            : "已连到模型服务，但返回异常，请稍后重试",
          detail: bodyText.slice(0, 180),
        });
      }

      let payload: any = {};
      try {
        payload = JSON.parse(bodyText);
      } catch {}

      const availableModels = Array.isArray(payload?.data)
        ? payload.data
            .map((item: any) => String(item?.id || item?.name || "").trim())
            .filter(Boolean)
        : [];
      const modelSeen = availableModels.length === 0 || availableModels.includes(model);

      return res.json({
        ok: true,
        message: modelSeen
          ? "连接正常，可以直接保存"
          : "连接正常，这个模型名可能和返回列表显示方式不同，仍可继续保存",
        availableModels: availableModels.slice(0, 12),
        modelSeen,
      });
    } catch (error: any) {
      clearTimeout(timeout);
      const isAbort = error?.name === "AbortError";
      return res.status(200).json({
        ok: false,
        message: isAbort ? "连接模型服务超时了，请稍后再试" : "暂时没连上模型服务，请检查网络或密钥",
        detail: error?.message || "",
      });
    }
  });

  // Boss直聘 登录：用系统真实浏览器打开登录页，用户正常登录
  app.post("/api/boss-login", async (req, res) => {
    try {
      spawn("open", ["https://www.zhipin.com/web/user/?ka=header-login"]);
      res.json({ ok: true });

      // 投递管家主动发提示，告诉用户登录完要回来点按钮
      setTimeout(() => {
        io.emit("receive_message", {
          id: `boss-remind-${Date.now()}`,
          sender: "投递管家",
          avatar: "https://api.dicebear.com/7.x/adventurer/svg?seed=AppTracker",
          content: "🔑 已帮你打开 Boss直聘 登录页面！\n\n请在浏览器里完成登录（扫码或密码均可），**登录成功后回到这里点「✓ 我已登录」按钮**，我来帮你自动保存 cookies 🍪",
          groupId: "job",
          timestamp: new Date().toISOString(),
          isBot: true,
        });
      }, 1000);
    } catch (e: any) {
      res.json({ ok: false, error: e.message });
    }
  });

  // 用户登录完成后点"已登录"，自动从 Chrome 提取 Boss直聘 cookies
  app.post("/api/boss-save-cookies", async (req, res) => {
    const script = `
import browser_cookie3, json, pathlib, time, sys, glob

home = pathlib.Path.home()
domain = '.zhipin.com'

def extract(jar):
    found = []
    for c in jar:
        if c.value:
            found.append({
                'name': c.name, 'value': c.value,
                'domain': getattr(c, 'domain', domain),
                'path': getattr(c, 'path', '/'),
                'secure': bool(getattr(c, 'secure', False)),
            })
    return found

cookies = []

# 1. 遍历所有 Chrome/Chromium profile（包括 Edge）
browser_dirs = {
    'chrome': home / 'Library' / 'Application Support' / 'Google' / 'Chrome',
    'edge':   home / 'Library' / 'Application Support' / 'Microsoft Edge',
    'brave':  home / 'Library' / 'Application Support' / 'BraveSoftware' / 'Brave-Browser',
}
for bname, bdir in browser_dirs.items():
    if not bdir.exists(): continue
    for cookie_file in sorted(bdir.glob('*/Cookies')):
        try:
            loader = getattr(browser_cookie3, bname if bname != 'edge' else 'edge', browser_cookie3.chrome)
            jar = loader(cookie_file=str(cookie_file), domain_name=domain)
            found = extract(jar)
            if found:
                print(f'{bname}/{cookie_file.parent.name}: {len(found)} cookies')
                cookies = found
                break
        except Exception as e:
            pass
    if cookies: break

# 2. Firefox
if not cookies:
    try:
        jar = browser_cookie3.firefox(domain_name=domain)
        cookies = extract(jar)
        if cookies: print(f'firefox: {len(cookies)} cookies')
    except: pass

# 3. Safari
if not cookies:
    try:
        jar = browser_cookie3.safari(domain_name=domain)
        cookies = extract(jar)
        if cookies: print(f'safari: {len(cookies)} cookies')
    except: pass

if not cookies:
    print('NO_COOKIES'); sys.exit(1)

out = pathlib.Path(${JSON.stringify(COOKIE_FILE)})
out.parent.mkdir(parents=True, exist_ok=True)
out.write_text(json.dumps({'saved_at': time.time(), 'cookies': cookies}, ensure_ascii=False))
print('OK:' + str(len(cookies)))
`;
    const child = spawn(PYTHON_BIN, ["-c", script], { stdio: ["ignore", "pipe", "pipe"] });
    let out = "";
    child.stdout.on("data", (d: Buffer) => { out += d.toString(); });
    child.stderr.on("data", (d: Buffer) => console.error("[cookies]", d.toString().trim()));
    child.on("close", (code: number) => {
      const success = out.includes("OK:");
      const count = success ? out.match(/OK:(\d+)/)?.[1] : "0";
      io.emit("boss_login_result", { ok: success });
      io.emit("receive_message", {
        id: `boss-login-${Date.now()}`,
        sender: "投递管家",
        avatar: "https://api.dicebear.com/7.x/adventurer/svg?seed=AppTracker",
        content: success
          ? `✅ Boss直聘 登录成功！已提取 ${count} 个 cookies，现在可以帮你自动投递了 🚀`
          : "❌ 没找到 Boss直聘 cookies，请确认已在浏览器里登录 zhipin.com",
        groupId: "job",
        timestamp: new Date().toISOString(),
        isBot: true,
      });
      res.json({ ok: success });
    });
  });

  // OpenClaw gateway management API proxy
  app.use("/api/gw", async (req: any, res: any) => {
    const gwPath = `/api${req.path}`;
    const query = req.url.includes("?") ? req.url.slice(req.url.indexOf("?")) : "";
    const targetUrl = `${GATEWAY_BASE}${gwPath}${query}`;
    try {
      const isWriteMethod = !["GET", "HEAD"].includes(req.method.toUpperCase());
      const gwRes = await fetch(targetUrl, {
        method: req.method,
        headers: { "Content-Type": "application/json" },
        body: isWriteMethod ? JSON.stringify(req.body) : undefined,
      });
      const text = await gwRes.text();
      let data: unknown;
      try { data = JSON.parse(text); } catch { data = { raw: text }; }
      res.status(gwRes.status).json(data);
    } catch {
      res.status(502).json({ error: "Gateway 暂时无法连接" });
    }
  });

  // Vite middleware for development
  if (process.env.NODE_ENV !== "production") {
    const { createServer: createViteServer } = await import("vite");
    const vite = await createViteServer({
      server: { middlewareMode: true },
      appType: "spa",
    });
    app.use(vite.middlewares);
  } else {
    const distDir = path.join(process.env.PAWPALS_APP_UNPACKED_ROOT || process.env.PAWPALS_APP_ROOT || process.cwd(), "dist");
    app.use(express.static(distDir));
    app.get("*", (_req, res) => {
      res.sendFile(path.join(distDir, "index.html"));
    });
  }

  httpServer.listen(PORT, "0.0.0.0", () => {
    console.log(`Server running on http://localhost:${PORT}`);
    // 启动 Watchdog，60秒后开始（给 gateway 足够启动时间）
    setTimeout(() => startWatchdog(GATEWAY_BASE, OPENCLAW_BIN, io), 60_000);
  });

  // ── 主动推送：同时推 Web UI + 飞书 ────────────────────────────────
  async function proactivePost(agentId: string, task: string, label: string) {
    const agent = JOB_AGENTS.find(a => a.id === agentId)!;
    console.log(`[proactive] ${label} 开始`);

    // 1. 推到 Web UI（流式）
    await streamAgent(agent, [{ role: "user", content: task }], MAX_CHAIN_DEPTH, io, "job", messages);
    // proactivePost 不触发链式

    // 2. 同时触发飞书 cron（直接调 openclaw agent 发到飞书群）
    const { execFile } = await import("child_process") as any;
    const { promisify } = await import("util") as any;
    const execFileAsync = promisify(execFile);
    try {
      await execFileAsync(OPENCLAW_BIN, [
        "agent",
        "--agent", agentId,
        "--message", task,
        "--channel", "feishu",
        "--account", agentId,
        "--to", "chat:oc_db61de856d9dd58df095f46c044c2231",
        "--deliver",
        "--local",
      ], { timeout: 120000 });
      console.log(`[proactive] ${label} 飞书推送完成`);
    } catch (e) {
      console.error(`[proactive] ${label} 飞书推送失败:`, e);
    }
  }

  // 每天 9:00 AM（洛杉矶时间）— 岗位猎手：今日岗位推送
  schedule.scheduleJob({ hour: 9, minute: 0, tz: "America/Los_Angeles" }, () => {
    proactivePost("job-hunter", "daily_job_push", "每日岗位推送");
  });

  // 每天 10:00 AM — 投递管家：follow-up 提醒 + 扫邮件
  schedule.scheduleJob({ hour: 10, minute: 0, tz: "America/Los_Angeles" }, () => {
    proactivePost("app-tracker",
      "检查 follow-up：扫描所有已过 follow-up 日期的投递，生成提醒列表。同时扫描 Gmail 最新招聘邮件，更新投递状态。",
      "Follow-up 提醒"
    );
  });

  // 每天 18:00 PM — 职业规划师：每日求职进度周报
  schedule.scheduleJob({ hour: 18, minute: 0, tz: "America/Los_Angeles" }, () => {
    proactivePost("career-planner",
      "生成今日求职进度简报：读取 applications.json 统计投递数/回复率，读取 jobs.json 看今天新增了多少岗位，给出今明两天的行动建议。控制在5行以内。",
      "每日进度简报"
    );
  });

  console.log("⏰ 定时任务已注册：9AM 岗位推送 | 10AM follow-up | 18PM 进度简报（洛杉矶时间）");
}

startServer();
