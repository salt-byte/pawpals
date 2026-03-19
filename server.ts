import express from "express";
import { createServer } from "http";
import { Server } from "socket.io";
import dotenv from "dotenv";
import os from "os";
import path from "path";
import { readFileSync, writeFileSync, existsSync, appendFileSync, mkdirSync, copyFileSync, readdirSync, statSync, unlinkSync } from "fs";
import { spawn, exec, execFile } from "child_process";
import schedule from "node-schedule";
import crypto from "crypto";
import archiver from "archiver";
import multer from "multer";
import {
  type OnboardingSlotPatch,
  type OnboardingState,
  type OnboardingStep,
  applyOnboardingSlotPatch,
  clearOnboardingStepValue,
  createDefaultOnboardingState,
  getNextOnboardingStep,
  previousOnboardingStep,
  renderProfileMarkdown,
  normalizeSkills,
} from "./server/onboarding.ts";

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
const CONTACTS_FILE = path.join(CAREER_DIR, "contacts.json");
const PET_FILE = path.join(APP_DATA_DIR, "pet.json");
const ONBOARDING_STATE_FILE = path.join(CAREER_DIR, "onboarding_state.json");
const COLLAB_BOARD_FILE = path.join(CAREER_DIR, "collaboration_board.json");
const LAST_SEARCH_RESULTS_FILE = path.join(CAREER_DIR, "last_search_results.json");
const MAIL_WATCH_STATE_FILE = path.join(APP_DATA_DIR, "mail-watcher-state.json");
const OPENCLAW_CONFIG_FILE = path.join(OPENCLAW_HOME, "openclaw.json");
const SETUP_STATE_FILE = path.join(APP_DATA_DIR, "setup-state.json");
const DEPLOYMENT_STATE_FILE = path.join(APP_DATA_DIR, "deployment-state.json");
const DEPLOYMENT_LOG_FILE = path.join(APP_DATA_DIR, "deployment.log");
const OPENCLAW_BIN = process.env.OPENCLAW_BIN || "openclaw";
const PYTHON_BIN = process.env.PAWPALS_PYTHON || process.env.PYTHON ||
  (existsSync("/opt/homebrew/bin/python3") ? "/opt/homebrew/bin/python3" :
   existsSync("/usr/local/bin/python3")    ? "/usr/local/bin/python3" : "python3");

ensureDir(APP_DATA_DIR);
ensureDir(CAREER_DIR);
ensureDir(COOKIE_DIR);

const SECURITY_FILE = path.join(APP_DATA_DIR, "security.json");
const BACKUP_DIR = path.join(os.homedir(), "Documents", "PawPals备份");
const BACKUP_META_FILE = path.join(APP_DATA_DIR, "backup-meta.json");
const AGENTS_ROOT = path.join(OPENCLAW_HOME, "agents");

// ── 全局队列（search_jobs / apply_job 工具 + Electron BrowserWindow 共享）──
const pendingSearchQueue = new Map<string, {
  query: string;
  city: string;
  cookieFile?: string;
  resolve: (r: string) => void;
}>();
const pendingJdFetchQueue = new Map<string, { url: string; resolve: (r: string) => void }>();
const pendingApplyQueue = new Map<string, any>();
const applyResultStore = new Map<string, any>();
let pendingResumableSearchTask: null | {
  query: string;
  location: string;
  cityText: string;
  channels: string[];
} = null;
let bossLoginPending = false;
let bossLoginPlatform = "boss";

// Step 3：AI 结构化投递指令暂存（app-tracker 回复里嵌入，用户确认后执行）
// key = 会话 groupId，value = 最近一条待确认的投递指令
const pendingApplyCommands = new Map<string, {
  url: string; company: string; title: string; timestamp: number;
}>();
const pendingWorkflowSelections = new Map<string, {
  rowIds: string[];
  timestamp: number;
}>();
// 清理超过 10 分钟未确认的暂存指令
setInterval(() => {
  const cutoff = Date.now() - 10 * 60 * 1000;
  for (const [k, v] of pendingApplyCommands) {
    if (v.timestamp < cutoff) pendingApplyCommands.delete(k);
  }
  for (const [k, v] of pendingWorkflowSelections) {
    if (v.timestamp < cutoff) pendingWorkflowSelections.delete(k);
  }
}, 60_000);

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
          notifyIO?.emit("watchdog_alert", { type: "crash_loop", message: "[WARN] Gateway 反复崩溃，自动修复失败，请重启 PawPals 应用" });
        }
        return;
      }
      // 崩溃循环：先跑 doctor --fix 再重启
      _wd.repairCount += 1;
      _wd.crashes = [];
      console.log(`[watchdog] 崩溃循环，第 ${_wd.repairCount} 次：运行 doctor --fix`);
      notifyIO?.emit("watchdog_alert", { type: "repair", message: `🔧 Gateway 崩溃循环，第 ${_wd.repairCount} 次自动诊断修复中...` });
      const doctorOut = await _runDoctor(openclawBin);
      notifyIO?.emit("watchdog_alert", { type: "repair_done", message: `[OK] 诊断完成，正在重启 Gateway...`, detail: doctorOut.slice(0, 300) });
    }

    await _restartGateway(gatewayPort, openclawBin);
    // 15秒后确认是否恢复
    setTimeout(async () => {
      const recovered = await _isGatewayAlive(gatewayBase);
      if (recovered) {
        console.log("[watchdog] Gateway 已恢复");
        notifyIO?.emit("watchdog_alert", { type: "recovered", message: "[OK] Gateway 已恢复正常" });
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

function listRuntimeAgentIds(): string[] {
  try {
    return readdirSync(AGENTS_ROOT).filter((name) => statSync(path.join(AGENTS_ROOT, name)).isDirectory());
  } catch {
    return [];
  }
}

function syncSelectedProviderToRuntimeAgents(config: any, selectedProvider: string) {
  if (!selectedProvider) return;

  const providerConfig = config?.models?.providers?.[selectedProvider];
  if (!providerConfig || typeof providerConfig !== "object") return;

  const providerApiKey =
    selectedProvider === "anthropic"
      ? String(config?.env?.vars?.ANTHROPIC_API_KEY || "").trim()
      : String(providerConfig?.apiKey || config?.env?.vars?.OPENAI_API_KEY || "").trim();

  for (const agentId of listRuntimeAgentIds()) {
    const agentDir = path.join(AGENTS_ROOT, agentId, "agent");
    const modelsPath = path.join(agentDir, "models.json");
    const authProfilesPath = path.join(agentDir, "auth-profiles.json");
    const sessionsPath = path.join(AGENTS_ROOT, agentId, "sessions", "sessions.json");

    try {
      if (existsSync(modelsPath)) {
        const modelsConfig = loadJsonFile<any>(modelsPath, {});
        modelsConfig.providers ??= {};
        modelsConfig.providers[selectedProvider] = JSON.parse(JSON.stringify(providerConfig));
        saveJsonFile(modelsPath, modelsConfig);
      }
    } catch {}

    try {
      const authConfig = loadJsonFile<any>(authProfilesPath, { version: 1, profiles: {}, usageStats: {} });
      authConfig.version ??= 1;
      authConfig.profiles ??= {};
      authConfig.usageStats ??= {};
      authConfig.profiles[`${selectedProvider}:default`] = {
        type: "api_key",
        provider: selectedProvider,
        key: providerApiKey,
      };
      authConfig.usageStats[`${selectedProvider}:default`] ??= { errorCount: 0 };
      authConfig.lastGood ??= {};
      authConfig.lastGood[selectedProvider] = `${selectedProvider}:default`;
      saveJsonFile(authProfilesPath, authConfig);
    } catch {}

    try {
      if (existsSync(sessionsPath)) {
        unlinkSync(sessionsPath);
      }
    } catch {}
  }
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
    // 优先用调用方传入的 baseUrl（来自 UI 输入），其次用 provider 默认值
    const resolvedBaseUrl = options?.baseUrl || activeProviderConfig.baseUrl || config.env.vars.OPENAI_BASE_URL || "";
    config.env.vars.OPENAI_BASE_URL = resolvedBaseUrl;
    // 同步更新 provider 配置，避免下次切换时被旧值覆盖
    if (options?.baseUrl) activeProviderConfig.baseUrl = options.baseUrl;
    config.env.vars.OPENAI_MODEL = model;
  }

  saveOpenClawConfig(config);
  syncSelectedProviderToRuntimeAgents(config, provider);
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
  syncSelectedProviderToRuntimeAgents(config, provider);
}

function hydrateRuntimeAgentsFromSelectedModel() {
  const config = loadOpenClawConfig();
  const primaryModel = String(config?.agents?.defaults?.model?.primary || "").trim();
  const [selectedProvider = ""] = primaryModel.split("/");
  if (!selectedProvider) return;
  syncSelectedProviderToRuntimeAgents(config, selectedProvider);
}

hydrateRuntimeAgentsFromSelectedModel();

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
// 懒加载缓存：openclaw 部署后首次使用时读取并缓存，之后不再读文件
// 如果遇到 401 可调用 clearGatewayTokenCache() 强制重新读取
let _cachedGatewayToken: string | null = null;
const getGatewayToken = (): string => {
  if (_cachedGatewayToken) return _cachedGatewayToken;
  const token = readGatewayToken();
  if (token) _cachedGatewayToken = token;
  return token;
};
const clearGatewayTokenCache = () => { _cachedGatewayToken = null; };
const BRAVE_KEY     = process.env.BRAVE_SEARCH_API_KEY || "";
const MAX_CHAIN_DEPTH = 2;
const CHAT_LOG      = path.join(CAREER_DIR, "chat_log.md");
const MESSAGES_FILE = path.join(CAREER_DIR, "pawpals_messages.json");
const RESUME_MASTER_FILE = path.join(CAREER_DIR, "resume_master.md");
const PROFILE_FILE = path.join(CAREER_DIR, "profile.md");
const SKILLS_GAP_FILE = path.join(CAREER_DIR, "skills_gap.md");

type CollaborationRow = {
  id: string;
  company: string;
  role: string;
  source: string;
  jdUrl: string;
  salary: string;
  location: string;
  deadline: string;
  jdSummary: string;
  skillHighlights: string;
  resumeVersion: string;
  applicationStatus: "pending" | "contact_started" | "submitted" | "interview" | "rejected" | "offer";
  appliedAt: string;
  followUpDate: string;
  contacts: Array<{ name: string; title: string; channel: string; value?: string }>;
  outreachDraft: string;
  outreachStatus: "draft" | "user_approved" | "sent" | "replied" | "";
  interviewRecord: {
    score?: number;
    strengths?: string[];
    weaknesses?: string[];
    notes?: string;
  } | null;
  workflowStage: "new" | "selected" | "tailoring" | "tailored" | "apply_ready" | "applied";
  notes: string;
  createdAt: string;
  updatedAt: string;
};

type SearchResultRow = {
  index: number;
  company: string;
  role: string;
  salary: string;
  location: string;
  jdUrl: string;
  source: string;
};

// OnboardingState.phase governs the global build-up funnel through the first real application.
// CollaborationRow.workflowStage governs each selected job throughout tailoring/application execution.
// The handoff is explicit: once phase becomes "completed", per-job workflowStage becomes the primary long-running state machine.
const AGENT_PHASE_TIMEOUT_MS = Math.max(15_000, Number(process.env.PAWPALS_AGENT_TIMEOUT_MS || 90_000));
const AGENT_PHASE_RETRIES = Math.max(0, Number(process.env.PAWPALS_AGENT_RETRIES || 0));

function buildBoardRowId(input: { company?: string; role?: string; jdUrl?: string }) {
  const raw = (input.jdUrl || `${input.company || "unknown"}::${input.role || "unknown"}`).trim().toLowerCase();
  return crypto.createHash("sha1").update(raw).digest("hex").slice(0, 16);
}

const CITY_CODE_MAP: Record<string, string> = {
  北京: "101010100",
  上海: "101020100",
  广州: "101280100",
  深圳: "101280600",
  杭州: "101210100",
  成都: "101270100",
};

const BIG_COMPANY_HINTS = [
  "字节", "腾讯", "阿里", "百度", "美团", "京东", "小红书", "快手", "滴滴", "拼多多",
  "Shopee", "bilibili", "哔哩", "米哈游", "携程", "网易", "蚂蚁", "华为", "OPPO", "vivo",
];

function extractOrderedCityPreferences(text: string) {
  const hits = Object.keys(CITY_CODE_MAP)
    .map((city) => ({ city, index: text.indexOf(city) }))
    .filter((item) => item.index >= 0)
    .sort((a, b) => a.index - b.index)
    .map((item) => item.city);
  return Array.from(new Set(hits));
}

function buildSearchPreferencesFromOnboarding(state: OnboardingState) {
  const strategy = state.searchStrategy?.channels?.length ? state.searchStrategy : getDefaultSearchStrategy(state);
  const inferredRoles = state.slots.inferredRoles?.filter(Boolean) || [];
  const explicitRole = (state.slots.targetRole || "").trim();
  const inferredPrimaryRole = (inferredRoles[0] || "").trim();
  const primaryRole = explicitRole || inferredPrimaryRole || "产品经理";
  const query = `${primaryRole}${/实习/.test(state.slots.jobType || "") && !/实习/.test(primaryRole) ? " 实习" : ""}`.trim();
  const orderedCities = extractOrderedCityPreferences(state.slots.targetCity || "");
  const primaryCity = orderedCities[0] || "北京";
  return {
    query,
    explicitRole,
    inferredPrimaryRole,
    channels: strategy.channels,
    priorities: strategy.priorities,
    primaryCity,
    primaryCityCode: CITY_CODE_MAP[primaryCity] || "101010100",
    orderedCities,
    cityText: state.slots.targetCity || primaryCity,
    companyPreference: state.slots.companyPreference || "",
    roleScope: state.slots.roleScope || "",
  };
}

async function generateSearchQueryAndCity(input: {
  profileText?: string;
  userMessage?: string;
  fallbackRole?: string;
  inferredRoles?: string[];
  jobType?: string;
  targetCity?: string;
  companyPreference?: string;
}) {
  const cityMap: Record<string, string> = {
    北京: "101010100",
    上海: "101020100",
    广州: "101280100",
    深圳: "101280600",
    杭州: "101210100",
    成都: "101270100",
  };
  const orderedCities = extractOrderedCityPreferences(input.targetCity || "");
  const fallbackCity = orderedCities[0] || "北京";
  const fallbackQueryBase =
    (input.fallbackRole || "").trim() ||
    (input.inferredRoles?.find(Boolean) || "").trim() ||
    "产品经理";
  const fallbackQuery = `${fallbackQueryBase}${/实习/.test(input.jobType || "") && !/实习/.test(fallbackQueryBase) ? " 实习" : ""}`.trim();

  let query = fallbackQuery;
  let city = fallbackCity;

  try {
    const queryRes = await fetch(`${GATEWAY_BASE}/v1/chat/completions`, {
      method: "POST",
      headers: {
        "Authorization": `Bearer ${getGatewayToken()}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        model: "auto",
        messages: [{
          role: "system",
          content: `你是招聘平台搜索关键词生成器。根据用户档案和当前意图，生成最精准的搜索词。
返回 JSON：{"query":"搜索关键词（4-18字，必须贴近用户真实目标岗位，不要泛化成客服/运营/销售）","city":"城市名（北京/上海/广州/深圳/杭州/成都，默认北京）"}
规则：
1. 优先使用用户明确目标方向，不要擅自改成不相关岗位
2. 如果用户目标是 ToG、公共关系、出海、国际业务，就必须把这些关键词体现在 query 里
3. 如果是实习岗位，query 里保留"实习"
4. 只返回 JSON，不要解释。`
        }, {
          role: "user",
          content: `用户档案：\n${(input.profileText || "（无档案）").slice(0, 1800)}\n\n当前意图：${input.userMessage || "开始搜索岗位"}\n\n显式目标方向：${input.fallbackRole || "无"}\n推断相关方向：${(input.inferredRoles || []).join(" / ") || "无"}\n求职类型：${input.jobType || "未说明"}\n目标城市：${input.targetCity || "未说明"}\n公司偏好：${input.companyPreference || "未说明"}`
        }],
        max_tokens: 120,
      }),
      signal: AbortSignal.timeout(10000),
    });
    const qData = await queryRes.json() as any;
    const qText = qData.choices?.[0]?.message?.content || "";
    const qMatch = qText.match(/\{[\s\S]*\}/);
    if (qMatch) {
      const parsed = JSON.parse(qMatch[0]);
      const llmQuery = String(parsed.query || "").trim();
      const llmCity = String(parsed.city || "").trim();
      if (llmQuery) query = llmQuery;
      if (llmCity && cityMap[llmCity]) city = llmCity;
    }
  } catch (e) {
    console.warn("[search_query] LLM query generation failed:", (e as any)?.message);
  }

  return {
    query: query || fallbackQuery,
    city,
    cityCode: cityMap[city] || cityMap[fallbackCity] || "101010100",
  };
}

function isBossJobUrl(url: string) {
  return /zhipin\.com/i.test(url || "");
}

function extractAutofillProfile() {
  const readIfExists = (file: string) => {
    try {
      return existsSync(file) ? readFileSync(file, "utf8") : "";
    } catch {
      return "";
    }
  };
  const profile = readIfExists(PROFILE_FILE);
  const resume = readIfExists(RESUME_MASTER_FILE);
  const source = `${profile}\n\n${resume}`;
  const readFirst = (...patterns: RegExp[]) => {
    for (const pattern of patterns) {
      const match = source.match(pattern);
      if (match?.[1]?.trim()) return match[1].trim();
    }
    return "";
  };
  return {
    name: readFirst(/姓名[：:]\s*(.+)/, /^#\s*(.+)$/m),
    email: readFirst(/邮箱[：:]\s*([^\s]+)/, /email[：: ]\s*([^\s]+)/i, /([A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,})/i),
    phone: readFirst(/手机(?:号)?[：:]\s*([+\d\s-]{8,})/i, /电话[：:]\s*([+\d\s-]{8,})/i, /(\+?\d[\d\s-]{8,}\d)/),
    linkedin: readFirst(/linkedin[：: ]\s*(https?:\/\/[^\s]+)/i),
    portfolio: readFirst(/作品集[：: ]\s*(https?:\/\/[^\s]+)/i, /portfolio[：: ]\s*(https?:\/\/[^\s]+)/i),
  };
}

function pickAutofillValue(field: any, profile: ReturnType<typeof extractAutofillProfile>, title = "", company = "") {
  const haystack = [field.label, field.name, field.placeholder, field.id, field.type].join(" ").toLowerCase();
  if (/full name|your name|姓名|名字|name/.test(haystack)) return profile.name;
  if (/email|邮箱/.test(haystack)) return profile.email;
  if (/phone|mobile|tel|手机号|电话/.test(haystack)) return profile.phone;
  if (/linkedin/.test(haystack)) return profile.linkedin;
  if (/portfolio|website|personal site|作品集|个人网站/.test(haystack)) return profile.portfolio;
  if (/cover letter|additional information|why|motivation|message|自我介绍|补充说明|说明/.test(haystack)) {
    return `您好，我对 ${company || "贵司"} 的「${title || "该岗位"}」很感兴趣，相关经历与岗位方向匹配，期待进一步沟通。`;
  }
  return "";
}

function rerankSearchRows(rows: SearchResultRow[], prefs: { orderedCities: string[]; companyPreference: string }) {
  const cityOrder = prefs.orderedCities;
  const prefersBigCompany = /大厂/.test(prefs.companyPreference || "");
  const scoreOf = (row: SearchResultRow) => {
    let score = 0;
    const cityRank = cityOrder.findIndex((city) => row.location?.includes(city));
    if (cityRank >= 0) score += 100 - cityRank * 15;
    if (prefersBigCompany && BIG_COMPANY_HINTS.some((hint) => row.company?.includes(hint))) score += 80;
    if (/AI|产品|策略|PM/i.test(row.role || "")) score += 20;
    return score;
  };
  return [...rows]
    .sort((a, b) => scoreOf(b) - scoreOf(a))
    .map((row, index) => ({ ...row, index: index + 1 }));
}

function renderSearchMarkdownTable(rows: SearchResultRow[]) {
  return [
    "| # | 职位 | 公司 | 薪资 | 地点 | 投递链接 |",
    "|---|------|------|------|------|---------|",
    ...rows.map((row) => `| ${row.index} | ${row.role || ""} | ${row.company || ""} | ${row.salary || ""} | ${row.location || ""} | ${row.jdUrl ? `[投递](${row.jdUrl})` : "-"} |`),
  ].join("\n");
}

function parseTavilyJobRows(raw: string) {
  try {
    const parsed = JSON.parse(raw) as { results?: Array<{ title?: string; url?: string; snippet?: string }> };
    const rows = (parsed.results || []).map((item, index) => {
      const title = String(item.title || "").trim();
      const url = String(item.url || "").trim();
      const host = (() => {
        try { return new URL(url).hostname.replace(/^www\./, ""); } catch { return ""; }
      })();
      const source = /linkedin\.com/.test(host) ? "linkedin" : /zhipin\.com/.test(host) ? "boss" : "web";
      const company = title.split(/[-|｜]/)[0]?.trim() || host || "官网渠道";
      return {
        index: index + 1,
        company,
        role: title || "岗位信息",
        salary: "",
        location: "",
        jdUrl: url,
        source,
      } satisfies SearchResultRow;
    }).filter((row) => row.jdUrl);
    return rows;
  } catch {
    return [] as SearchResultRow[];
  }
}

function getApplicationChannel(row: { jdUrl?: string; source?: string }) {
  if (/zhipin\.com/.test(row.jdUrl || "") || row.source === "boss") return "boss_chat";
  return "direct_resume";
}

function normalizeSearchChannels(channels: string[]) {
  const mapped = channels.map((item) => {
    const text = String(item || "").toLowerCase();
    if (/boss/.test(text)) return "boss";
    if (/mixed|混合|都搜|一起搜/.test(text)) return "mixed";
    if (/web|官网|linkedin|领英|全网/.test(text)) return "web";
    return "";
  }).filter(Boolean);
  const deduped = Array.from(new Set(mapped));
  if (deduped.includes("mixed")) return ["boss", "web"];
  return deduped;
}

function normalizeSearchPriorities(priorities: string[]) {
  return Array.from(new Set(priorities.map((item) => {
    const text = String(item || "").toLowerCase();
    if (/地点|城市|location/.test(text)) return "location";
    if (/公司|大厂|brand|company/.test(text)) return "company";
    if (/投递|渠道|apply|channel/.test(text)) return "channel";
    if (/匹配|岗位|role|fit/.test(text)) return "fit";
    return "";
  }).filter(Boolean)));
}

function getDefaultSearchStrategy(state: OnboardingState) {
  const channels = /海外|国外|美国|欧洲|新加坡|remote/i.test(state.slots.market || "")
    ? ["web"]
    : ["boss", "web"];
  const priorities = ["location"];
  if (/大厂/.test(state.slots.companyPreference || "")) priorities.push("company");
  priorities.push("fit");
  return { channels, priorities };
}

function applySearchStrategyUpdate(
  state: OnboardingState,
  update: Partial<OnboardingState["searchStrategy"]>
) {
  const next = { ...state.searchStrategy };
  if (Array.isArray(update.channels) && update.channels.length > 0) {
    next.channels = normalizeSearchChannels(update.channels);
  }
  if (Array.isArray(update.priorities) && update.priorities.length > 0) {
    next.priorities = normalizeSearchPriorities(update.priorities);
  }
  if (typeof update.confirmed === "boolean") next.confirmed = update.confirmed;
  state.searchStrategy = next;
}

function extractSearchStrategyHeuristic(userMsg: string, state: OnboardingState) {
  const text = userMsg.trim();
  const update: Partial<OnboardingState["searchStrategy"]> = {};
  const channels: string[] = [];
  const priorities: string[] = [];
  const looksLikeQuestion = /[?？吗呢么]|\bwhy\b|\bhow\b/i.test(text);
  const looksLikePushback = /(不行|不可以|不能|别|不要|等一下|先别|先不)/.test(text);

  if (/boss/i.test(text)) channels.push("boss");
  if (/全网|官网|linkedin|领英|web/i.test(text)) channels.push("web");
  if (/混合|都搜|一起搜/.test(text)) channels.push("mixed");
  if (/地点|城市|北京|上海|remote/.test(text)) priorities.push("location");
  if (/大厂|公司|平台|品牌/.test(text)) priorities.push("company");
  if (/投递|渠道|打招呼|官网投|简历投/.test(text)) priorities.push("channel");
  if (/匹配|相关|贴合|方向/.test(text)) priorities.push("fit");
  if (channels.length > 0) update.channels = channels;
  if (priorities.length > 0) update.priorities = priorities;
  if (!looksLikeQuestion && !looksLikePushback && /(按这个来|就这样|你决定|都可以|没问题|开始搜|搜吧|可以开始|可以搜|就按这个搜)/.test(text)) {
    const defaults = getDefaultSearchStrategy(state);
    update.channels = update.channels || defaults.channels;
    update.priorities = update.priorities || defaults.priorities;
    update.confirmed = true;
  }
  return update;
}

function loadCollaborationBoard(): CollaborationRow[] {
  try {
    if (existsSync(COLLAB_BOARD_FILE)) {
      return JSON.parse(readFileSync(COLLAB_BOARD_FILE, "utf-8"));
    }
  } catch {}
  return [];
}

function saveCollaborationBoard(rows: CollaborationRow[]) {
  try { writeFileSync(COLLAB_BOARD_FILE, JSON.stringify(rows, null, 2)); } catch {}
}

function upsertCollaborationRow(partial: Partial<CollaborationRow> & { company?: string; role?: string; jdUrl?: string }) {
  const rows = loadCollaborationBoard();
  const id = partial.id || buildBoardRowId(partial);
  const now = new Date().toISOString();
  const existingIndex = rows.findIndex((row) => row.id === id);
  const base: CollaborationRow = existingIndex >= 0 ? rows[existingIndex] : {
    id,
    company: partial.company || "",
    role: partial.role || "",
    source: partial.source || "",
    jdUrl: partial.jdUrl || "",
    salary: partial.salary || "",
    location: partial.location || "",
    deadline: partial.deadline || "",
    jdSummary: partial.jdSummary || "",
    skillHighlights: partial.skillHighlights || "",
    resumeVersion: partial.resumeVersion || "",
    applicationStatus: partial.applicationStatus || "pending",
    appliedAt: partial.appliedAt || "",
    followUpDate: partial.followUpDate || "",
    contacts: partial.contacts || [],
    outreachDraft: partial.outreachDraft || "",
    outreachStatus: partial.outreachStatus || "",
    interviewRecord: partial.interviewRecord || null,
    workflowStage: partial.workflowStage || "new",
    notes: partial.notes || "",
    createdAt: now,
    updatedAt: now,
  };
  const merged: CollaborationRow = {
    ...base,
    ...partial,
    contacts: partial.contacts || base.contacts,
    interviewRecord: partial.interviewRecord ?? base.interviewRecord,
    updatedAt: now,
  };
  if (existingIndex >= 0) rows[existingIndex] = merged;
  else rows.push(merged);
  saveCollaborationBoard(rows);
  return merged;
}

function saveLastSearchResults(rows: SearchResultRow[]) {
  try { writeFileSync(LAST_SEARCH_RESULTS_FILE, JSON.stringify(rows, null, 2)); } catch {}
}

function loadLastSearchResults(): SearchResultRow[] {
  try {
    if (existsSync(LAST_SEARCH_RESULTS_FILE)) return JSON.parse(readFileSync(LAST_SEARCH_RESULTS_FILE, "utf-8"));
  } catch {}
  return [];
}

function parseSearchMarkdownTable(markdown: string): SearchResultRow[] {
  const rows = markdown.split("\n").filter((line) => /^\|\s*\d+\s*\|/.test(line));
  return rows.map((line) => {
    const cells = line.split("|").map((part) => part.trim()).filter(Boolean);
    const linkMatch = line.match(/\[投递\]\((https?:\/\/[^)]+)\)/);
    return {
      index: Number(cells[0] || 0),
      role: cells[1] || "",
      company: cells[2] || "",
      salary: cells[3] || "",
      location: cells[4] || "",
      jdUrl: linkMatch?.[1] || "",
      source: "boss",
    };
  }).filter((row) => row.index > 0 && row.company && row.role);
}

function parseSelectionIndices(text: string) {
  const compact = text.replace(/[，、]/g, " ").replace(/\s+/g, " ").trim();
  const matches = compact.match(/\d+/g) || [];
  return Array.from(new Set(matches.map((n) => Number(n)).filter((n) => n > 0 && n <= 20)));
}

function looksLikeJobSelection(text: string) {
  return /(都投|想投|投这|选|就投|要这|这几个)/.test(text) || parseSelectionIndices(text).length > 0;
}

function detectPipelineSignal(text: string): "interview" | "offer" | "rejected" | null {
  if (/(面试邀请|约面|收到面试|进入面试|面试通知|interview)/i.test(text)) return "interview";
  if (/(offer|拿到 offer|录用|录取|给了 offer)/i.test(text)) return "offer";
  if (/(拒信|被拒|没过|rejected|reject)/i.test(text)) return "rejected";
  return null;
}

function findBoardRowsFromText(text: string) {
  const board = loadCollaborationBoard();
  const directMatches = board.filter((row) =>
    (row.company && text.includes(row.company)) ||
    (row.role && text.includes(row.role))
  );
  if (directMatches.length > 0) return directMatches;
  return board
    .filter((row) => ["submitted", "interview"].includes(row.applicationStatus))
    .sort((a, b) => String(b.updatedAt).localeCompare(String(a.updatedAt)))
    .slice(0, 1);
}

function updateApplicationStatusFiles(row: CollaborationRow, status: "interview" | "offer" | "rejected") {
  try {
    const apps = existsSync(APPLICATIONS_FILE) ? JSON.parse(readFileSync(APPLICATIONS_FILE, "utf-8")) as any[] : [];
    const idx = apps.findIndex((app) =>
      (row.jdUrl && app.url === row.jdUrl) ||
      ((app.company || "") === row.company && (app.role || "") === row.role)
    );
    if (idx >= 0) {
      apps[idx].status = status;
      apps[idx].timeline = Array.isArray(apps[idx].timeline) ? apps[idx].timeline : [];
      apps[idx].timeline.push({ date: new Date().toISOString().slice(0, 10), action: status });
      writeFileSync(APPLICATIONS_FILE, JSON.stringify(apps, null, 2));
    }
  } catch {}
}

function syncJobsToCollaborationBoard() {
  try {
    const jobs = existsSync(JOBS_FILE) ? JSON.parse(readFileSync(JOBS_FILE, "utf-8")) as any[] : [];
    for (const job of jobs) {
      upsertCollaborationRow({
        company: job.company || "",
        role: job.title || job.role || "",
        jdUrl: job.url || job.jd_url || "",
        salary: job.salary || "",
        location: job.city || job.location || "",
        source: job.source || "",
        applicationStatus: job.applied ? "submitted" : "pending",
      });
    }
  } catch {}
}

function syncApplicationsToCollaborationBoard() {
  try {
    const apps = existsSync(APPLICATIONS_FILE) ? JSON.parse(readFileSync(APPLICATIONS_FILE, "utf-8")) as any[] : [];
    for (const app of apps) {
      upsertCollaborationRow({
        company: app.company || "",
        role: app.role || app.title || "",
        jdUrl: app.url || "",
        source: app.source || "",
        applicationStatus:
          app.status === "contact_started" ? "contact_started" :
          app.status === "applied" ? "submitted" :
          app.status === "interview" ? "interview" :
          app.status === "rejected" ? "rejected" :
          app.status === "offer" ? "offer" : "pending",
        appliedAt: app.appliedDate || "",
        followUpDate: app.followUpDate || "",
        notes: app.notes || "",
      });
    }
  } catch {}
}

function syncContactsToCollaborationBoard() {
  try {
    const contacts = existsSync(CONTACTS_FILE) ? JSON.parse(readFileSync(CONTACTS_FILE, "utf-8")) as any[] : [];
    for (const contact of contacts) {
      const relatedUrl = contact.jobUrl || contact.url || "";
      upsertCollaborationRow({
        company: contact.company || "",
        role: contact.role || "",
        jdUrl: relatedUrl,
        contacts: [{
          name: contact.name || "",
          title: contact.title || "",
          channel: contact.channel || contact.platform || "",
          value: contact.email || contact.profileUrl || "",
        }],
        outreachDraft: contact.draft || "",
        outreachStatus: contact.status || "",
      });
    }
  } catch {}
}

function loadOnboardingState(): OnboardingState {
  try {
    if (existsSync(ONBOARDING_STATE_FILE)) {
      const raw = JSON.parse(readFileSync(ONBOARDING_STATE_FILE, "utf-8"));
      return {
        ...createDefaultOnboardingState(),
        ...raw,
        slots: { ...createDefaultOnboardingState().slots, ...(raw?.slots || {}) },
        searchStrategy: { ...createDefaultOnboardingState().searchStrategy, ...(raw?.searchStrategy || {}) },
      };
    }
  } catch {}
  if (existsSync(PROFILE_FILE)) {
    return {
      ...createDefaultOnboardingState(),
      phase: "completed",
      currentStep: null,
      completed: true,
      resumeUploaded: existsSync(RESUME_MASTER_FILE),
    };
  }
  return createDefaultOnboardingState();
}

function saveOnboardingState(state: OnboardingState, io?: Server) {
  try { writeFileSync(ONBOARDING_STATE_FILE, JSON.stringify(state, null, 2)); } catch {}
  // 通知前端更新进度条
  if (io) io.emit("onboarding_phase", { phase: state.phase, completed: state.completed });
}

function handleOnboardingNavigationCommand(
  state: OnboardingState,
  userMsg: string,
  petName: string,
  io?: Server
): { handled: boolean; prompt?: string } {
  const text = userMsg.trim();
  if (!text) return { handled: false };

  if (/(重新建档|重新开始|全部重来|从头开始|reset)/i.test(text)) {
    const fresh = createDefaultOnboardingState();
    saveOnboardingState(fresh, io);
    return {
      handled: true,
      prompt: `${petName}：好的，我们从头重新建档。先把你的简历重新发我一下，我按新的信息来整理。`,
    };
  }

  if (/(改目标岗位|修改目标岗位|重设目标岗位|目标岗位改成)/.test(text)) {
    state.completed = false;
    state.phase = "profile_collection";
    state.transitionInFlight = false;
    state.lastError = "";
    state.currentStep = "target_role";
    clearOnboardingStepValue(state, "target_role");
    saveOnboardingState(state, io);
    return {
      handled: true,
      prompt: `${petName}：可以，我们先把目标岗位重新确认一下。你现在最想找什么方向的工作？比如 AI 产品经理、开发工程师、数据分析师。`,
    };
  }

  if (/(返回上一步|上一步|退一步|go back|goback)/i.test(text)) {
    state.completed = false;
    state.transitionInFlight = false;
    state.lastError = "";

    if (state.phase === "profile_collection") {
      const prev = previousOnboardingStep(state.currentStep);
      if (prev) {
        clearOnboardingStepValue(state, prev);
        state.currentStep = prev;
        saveOnboardingState(state, io);
        return { handled: true, prompt: `${petName}：好的，我们回到上一步，你再跟我说说这个部分。` };
      }
      state.phase = "resume_collection";
      state.currentStep = "target_role";
      state.resumeUploaded = false;
      saveOnboardingState(state, io);
      return {
        handled: true,
        prompt: `${petName}：我们先退回到简历这一步。把最新简历重新发我一下，我按新的版本继续。`,
      };
    }

    if (state.phase === "professional_positioning" || state.phase === "resume_diagnosis" || state.phase === "resume_review" || state.phase === "search_strategy" || state.phase === "first_job_search" || state.phase === "first_application" || state.phase === "completed") {
      state.phase = "profile_collection";
      state.currentStep = "skills";
      saveOnboardingState(state, io);
      return {
        handled: true,
        prompt: `${petName}：可以，我们先回到档案确认的最后一步。你也可以直接告诉我想改哪一项信息，我会重新整理。`,
      };
    }
  }

  return { handled: false };
}

function persistProfileFromOnboarding(state: OnboardingState) {
  try {
    writeFileSync(PROFILE_FILE, renderProfileMarkdown(state), "utf-8");
  } catch {}
}

function saveInitialResumeMaster(rawContent: string, fileName: string) {
  const cleaned = rawContent
    .replace(/^\[附件[:：][^\n]+\]\s*/m, "")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
  if (!cleaned) return;
  try {
    writeFileSync(RESUME_MASTER_FILE, `# 原始简历\n\n来源文件: ${fileName}\n\n## 提取文本\n\n${cleaned}\n`, "utf-8");
  } catch {}
}

function hasResumeAttachment(content: string) {
  return /\[附件[:：]\s*.+\]/.test(content);
}

function extractResumeFileName(content: string) {
  return content.match(/\[附件[:：]\s*([^\]]+)\]/)?.[1]?.trim() || "用户简历";
}

function getMessageResumePayload(msg: any) {
  const content = String(msg?.content || "");
  const attachmentText = String(msg?.attachmentText || "").trim();
  return {
    fileName: String(msg?.attachmentName || extractResumeFileName(content) || "用户简历"),
    rawText: attachmentText || content,
  };
}

function sanitizeProfileCardRoleScope(value: string) {
  const text = String(value || "").trim();
  if (!text) return "";
  if (/(北京|上海|广州|深圳|杭州|成都|remote|远程)/i.test(text)) return "";
  return text;
}

function applyHeuristicOnboardingUpdate(state: OnboardingState, text: string): OnboardingSlotPatch {
  const trimmed = text.replace(/^> 回复[\s\S]*?\n\n/, "").trim();
  const patch: OnboardingSlotPatch = {};
  switch (state.currentStep) {
    case "target_role":
      patch.targetRole = trimmed;
      break;
    case "market":
      if (/两边|都看|都投/.test(trimmed)) patch.market = "国内和海外都看";
      else if (/海外|国外|美国|欧洲|新加坡|英.?国|remote abroad/i.test(trimmed)) patch.market = trimmed;
      else if (/国内|大陆|北京|上海|深圳|杭州|广州/.test(trimmed)) patch.market = trimmed;
      else patch.market = trimmed;
      break;
    case "job_type_time": {
      const typeMatch = trimmed.match(/暑期实习|日常实习|全职|实习|校招|社招/);
      const rangeMatch = trimmed.match(/\d{1,2}\s*月\s*(?:到|[-~至])\s*\d{1,2}\s*月|\d{1,2}\/\d{1,2}\s*(?:到|[-~至])\s*\d{1,2}\/\d{1,2}/);
      patch.jobType = typeMatch?.[0] || trimmed;
      patch.timeRange = rangeMatch?.[0] || trimmed;
      if (/转正|return/.test(trimmed)) {
        patch.returnOfferPreference = /不要|不用|无所谓/.test(trimmed) ? "不强求转正" : "希望有转正机会";
      }
      break;
    }
    case "target_city":
      patch.targetCity = trimmed;
      break;
    case "role_scope":
      patch.roleScope = /只看|仅看|就看/.test(trimmed) ? "只看这个岗位 title" : trimmed;
      break;
    case "company_preference":
      if (/都行|都可以|不限/.test(trimmed)) patch.companyPreference = "大厂和创业都可以";
      else patch.companyPreference = trimmed;
      break;
    case "traits":
      patch.traits = trimmed;
      break;
    case "skills":
      patch.skills = normalizeSkills(trimmed);
      break;
  }
  return patch;
}

async function extractOnboardingSlotPatch(state: OnboardingState, text: string): Promise<OnboardingSlotPatch> {
  const heuristic = applyHeuristicOnboardingUpdate(state, text);
  const trimmed = text.replace(/^> 回复[\s\S]*?\n\n/, "").trim();
  if (!trimmed || !state.currentStep) return heuristic;
  try {
    const res = await fetch(`${GATEWAY_BASE}/v1/chat/completions`, {
      method: "POST",
      headers: {
        "Authorization": `Bearer ${getGatewayToken()}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        model: "auto",
        messages: [
          {
            role: "system",
            content: `你是求职建档信息抽取器。当前步骤是 ${state.currentStep}。
从用户自然语言里提取本步骤相关字段，返回 JSON。
只允许返回这些键：targetRole, market, jobType, timeRange, returnOfferPreference, targetCity, roleScope, companyPreference, traits, skills。
skills 必须是字符串数组。无法确定就返回空对象 {}。不要输出解释。`
          },
          {
            role: "user",
            content: `已知档案：${JSON.stringify(state.slots, null, 2)}\n\n用户回答：${trimmed}`
          }
        ],
        max_tokens: 220,
      }),
      signal: AbortSignal.timeout(12000),
    });
    const data = await res.json() as any;
    const content = data.choices?.[0]?.message?.content || "";
    const match = String(content).match(/\{[\s\S]*\}/);
    if (!match) return heuristic;
    const parsed = JSON.parse(match[0]) as OnboardingSlotPatch;
    return {
      ...heuristic,
      ...parsed,
      ...(Array.isArray(parsed.skills) ? { skills: normalizeSkills(parsed.skills.join("、")) } : {}),
    };
  } catch {
    return heuristic;
  }
}

// ── Onboarding 上下文注入（让 agent 理解当前处于哪个阶段）─────────────────
function buildOnboardingContext(state: OnboardingState, petName: string): string {
  const filledSlots: string[] = [];
  const missingSlots: string[] = [];
  const slotLabels: Record<string, string> = {
    targetRole: "目标岗位方向",
    market: "国内/海外偏好",
    jobType: "实习类型",
    timeRange: "时间范围",
    targetCity: "目标城市",
    roleScope: "岗位范围（只看本岗位 or 相关方向也看）",
    companyPreference: "公司偏好（大厂/创业/都行）",
    traits: "个人特质/风格",
    skills: "核心技能/工具",
  };

  for (const [key, label] of Object.entries(slotLabels)) {
    const val = key === "skills" ? state.slots.skills : (state.slots as any)[key];
    if (key === "skills" ? val?.length > 0 : !!val) {
      filledSlots.push(`- ${label}：${Array.isArray(val) ? val.join("、") : val}`);
    } else {
      missingSlots.push(`- ${label}`);
    }
  }

  if (state.phase === "resume_collection") {
    return `【Onboarding 上下文】\n当前阶段：简历收集\n用户还没上传简历，请温暖地引导用户发送简历（PDF 或 Word）。`;
  }

  if (state.phase === "profile_collection") {
    return `【Onboarding 上下文 — 用户画像采集中】
你正在帮用户建立求职档案。通过自然对话收集以下信息，每次只问1-2个问题。

已收集：
${filledSlots.length > 0 ? filledSlots.join("\n") : "（还没开始）"}

待收集：
${missingSlots.length > 0 ? missingSlots.join("\n") : "（全部收集完毕）"}

自然对话规则：
- 用户在回答就提取信息推进，在纠正就覆盖更新，在追问就解释，在吐槽就先回应感受再引导
- 用户可能一句话包含多个信息，一并提取
- 像朋友聊天一样自然，不要一次列出所有问题

结构化回写协议（必须遵守）：
1. 收集到新信息时，在回复末尾另起一行写：SLOT_UPDATE::{"key":"value"}
   key 用英文：targetRole/market/jobType/timeRange/targetCity/roleScope/companyPreference/traits/skills
   skills 是字符串数组，如 ["Python","SQL","Figma"]
2. 如果用户在纠正之前的信息，同样用 SLOT_UPDATE:: 覆盖
3. 当所有待收集信息都齐了，额外附加一行：PHASE_COMPLETE
4. 如果用户没提供新信息（追问/质疑/闲聊），不要写 SLOT_UPDATE::，只写 NEEDS_CLARIFICATION
5. 这些标签不会展示给用户，只用于系统状态更新`;
  }

  if (state.phase === "professional_positioning") {
    return `【Onboarding 上下文】\n当前阶段：专业定位分析\n用户画像已收集完成，现在需要做深度定位分析。请基于 profile.md 输出定位建议并写入 skills_gap.md。`;
  }

  if (state.phase === "resume_diagnosis") {
    return `【Onboarding 上下文】\n当前阶段：简历首次诊断\n定位分析已完成。请结合 profile.md 和 skills_gap.md 对简历做首次诊断。`;
  }

  return "";
}

async function runAgentChainWithTimeout(
  agent: typeof JOB_AGENTS[0],
  messages: { role: string; content: string; name?: string }[],
  depth: number,
  io: Server,
  groupId: string,
  allMessages: any[],
  petName: string,
  petPersonality: string
) {
  let lastError: any = null;
  for (let attempt = 0; attempt <= AGENT_PHASE_RETRIES; attempt += 1) {
    try {
      await Promise.race([
        runAgentChain(agent, messages, depth, io, groupId, allMessages, petName, petPersonality),
        new Promise((_, reject) => {
          setTimeout(() => reject(new Error(`${agent.id} timed out after ${AGENT_PHASE_TIMEOUT_MS}ms`)), AGENT_PHASE_TIMEOUT_MS);
        }),
      ]);
      return { ok: true as const };
    } catch (error: any) {
      lastError = error;
      console.warn(`[agent-phase] ${agent.id} attempt ${attempt + 1} failed:`, error?.message || error);
      if (attempt >= AGENT_PHASE_RETRIES) break;
    }
  }
  return { ok: false as const, error: lastError };
}

function scheduleOnboardingAdvance(
  io: Server,
  allMessages: any[],
  petName: string,
  petPersonality: string,
  delayMs = 200
) {
  setTimeout(() => {
    void handleJobOnboarding(io, allMessages, "", petName, petPersonality).catch((error) => {
      console.warn("[onboarding] auto advance failed:", error);
    });
  }, delayMs);
}

function emitBotMessage(
  io: Server,
  messages: any[],
  payload: { sender: string; avatar: string; content: string; groupId: string; isChiefBot?: boolean }
) {
  const botMsg = {
    id: `bot-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`,
    sender: payload.sender,
    avatar: payload.avatar,
    content: payload.content,
    groupId: payload.groupId,
    timestamp: new Date().toISOString(),
    isBot: true,
    isChiefBot: !!payload.isChiefBot,
  };
  messages.push(botMsg);
  saveMessages(messages);
  io.emit("receive_message", botMsg);
}

function applyBoardUpdate(update: any) {
  if (!update || (!update.company && !update.role && !update.jdUrl && !update.id)) return;
  const contacts = Array.isArray(update.contacts)
    ? update.contacts
        .filter((c: any) => c && (c.name || c.title || c.channel || c.value))
        .map((c: any) => ({
          name: c.name || "",
          title: c.title || "",
          channel: c.channel || "",
          value: c.value || "",
        }))
    : undefined;
  upsertCollaborationRow({
    id: update.id,
    company: update.company,
    role: update.role,
    jdUrl: update.jdUrl,
    source: update.source,
    salary: update.salary,
    location: update.location,
    deadline: update.deadline,
    jdSummary: update.jdSummary,
    skillHighlights: update.skillHighlights,
    resumeVersion: update.resumeVersion,
    applicationStatus: update.applicationStatus,
    appliedAt: update.appliedAt,
    followUpDate: update.followUpDate,
    contacts,
    outreachDraft: update.outreachDraft,
    outreachStatus: update.outreachStatus,
    interviewRecord: update.interviewRecord,
    notes: update.notes,
  });
}

function formatWorkflowStageLabel(stage: CollaborationRow["workflowStage"]) {
  switch (stage) {
    case "new": return "新入库";
    case "selected": return "已选中";
    case "tailoring": return "定制中";
    case "tailored": return "已定制";
    case "apply_ready": return "待投递";
    case "applied": return "已推进";
    default: return stage || "未记录";
  }
}

function formatApplicationStatusLabel(status: CollaborationRow["applicationStatus"]) {
  switch (status) {
    case "pending": return "待处理";
    case "contact_started": return "已发起沟通";
    case "submitted": return "已提交";
    case "interview": return "面试中";
    case "rejected": return "已拒绝";
    case "offer": return "已拿 offer";
    default: return status || "未记录";
  }
}

function renderCollaborationBoardChatTable(rows: CollaborationRow[], title = "协作进度表") {
  if (!rows.length) return "";
  const lines = [
    `📋 ${title}`,
    "",
    "| 公司 | 岗位 | 阶段 | 状态 | 简历版本 |",
    "| --- | --- | --- | --- | --- |",
  ];
  for (const row of rows) {
    lines.push(
      `| ${row.company || "-"} | ${row.role || "-"} | ${formatWorkflowStageLabel(row.workflowStage)} | ${formatApplicationStatusLabel(row.applicationStatus)} | ${row.resumeVersion || "-"} |`
    );
  }
  return lines.join("\n");
}

function getStructuredBoardInstruction(agentId: string) {
  if (agentId === "professional-teacher") {
    return "【协作表格指令】当你明确分析某个具体岗位/JD时，在回复最后单独追加一行 BOARD_UPDATE::{\"company\":\"公司名\",\"role\":\"岗位名\",\"jdUrl\":\"链接可留空\",\"skillHighlights\":\"一句话写清要强调的技能点\",\"notes\":\"可选\"}。必须是一行紧凑 JSON，不要换行。用户看不到这行。";
  }
  if (agentId === "resume-expert") {
    return "【协作表格指令】当你完成某个具体岗位的简历诊断或定制时，在回复最后单独追加一行 BOARD_UPDATE::{\"company\":\"公司名\",\"role\":\"岗位名\",\"resumeVersion\":\"如 v2.1-anthropic\",\"notes\":\"评分或改动摘要\"}。必须是一行紧凑 JSON，不要换行。用户看不到这行。";
  }
  if (agentId === "networker") {
    return "【协作表格指令】当你找到联系人或生成冷邮件时，在回复最后单独追加一行 BOARD_UPDATE::{\"company\":\"公司名\",\"role\":\"岗位名\",\"contacts\":[{\"name\":\"联系人\",\"title\":\"职位\",\"channel\":\"LinkedIn或邮箱\",\"value\":\"链接或邮箱\"}],\"outreachDraft\":\"邮件正文可简写\",\"outreachStatus\":\"draft\"}。必须是一行紧凑 JSON。";
  }
  if (agentId === "interview-coach") {
    return "【协作表格指令】当你完成某岗位面试点评时，在回复最后单独追加一行 BOARD_UPDATE::{\"company\":\"公司名\",\"role\":\"岗位名\",\"interviewRecord\":{\"score\":7.5,\"strengths\":[\"点1\"],\"weaknesses\":[\"点2\"],\"notes\":\"简评\"}}。必须是一行紧凑 JSON。";
  }
  return "";
}

// ── OpenClaw 多 Agent 工作区文件加载 ─────────────────────────────────────
// 每个 Agent 的 SOUL.md 存储在 career/workspaces/<agentId>/SOUL.md
// 这是 OpenClaw 多 Agent 架构的核心：Agent 身份和行为从工作区文件读取，而非硬编码
function loadAgentSoul(agentId: string): string {
  const soulPath = path.join(CAREER_DIR, "workspaces", agentId, "SOUL.md");
  try {
    if (existsSync(soulPath)) return readFileSync(soulPath, "utf-8").trim();
  } catch {}
  return "";
}

function loadAgentUserContext(agentId: string): string {
  const userPath = path.join(CAREER_DIR, "workspaces", agentId, "USER.md");
  try {
    if (existsSync(userPath)) return readFileSync(userPath, "utf-8").trim();
  } catch {}
  return "";
}

// 从 profile.md 动态读取用户信息（姓名、邮箱、目标岗位、求职类型、技能等）
function loadProfileInfo(): {
  name: string; email: string; summary: string;
  targetRoles: string[]; jobType: string; skills: string[];
} {
  const empty = { name: "", email: "", summary: "", targetRoles: [], jobType: "", skills: [] };
  try {
    const profilePath = path.join(CAREER_DIR, "profile.md");
    if (!existsSync(profilePath)) return empty;
    const md = readFileSync(profilePath, "utf-8");

    const nameMatch = md.match(/姓名[：:]\s*(.+)/);
    const emailMatch = md.match(/[a-zA-Z0-9._%+\-]+@[a-zA-Z0-9.\-]+\.[a-zA-Z]{2,}/);
    const dirMatch  = md.match(/方向[：:]\s*(.+)/);
    const typeMatch = md.match(/类型[：:]\s*(.+)/);

    // 目标岗位：把 "AI PM / 产品经理 / Technical PM" 拆成数组
    const targetRoles = (dirMatch?.[1] || "").split(/[\/,，、]+/).map(s => s.trim()).filter(Boolean);
    const jobType     = (typeMatch?.[1] || "").includes("实习") ? "实习" : (typeMatch?.[1] || "").trim();

    // 技能：从"技能自评"或技能列表里提取关键词
    const skillSection = md.match(/##\s*技能[^\n]*\n([\s\S]*?)(?=\n##|$)/)?.[1] || "";
    const skills = skillSection.match(/[\u4e00-\u9fa5A-Za-z\d]{2,12}/g)
      ?.filter(s => !/强项|弱项|优势|劣势|背景|经验|能力/.test(s))
      .slice(0, 8) || [];

    return {
      name:        nameMatch?.[1]?.trim() || "",
      email:       emailMatch?.[0]?.trim() || "",
      summary:     md.slice(0, 1500),
      targetRoles,
      jobType,
      skills,
    };
  } catch {
    return empty;
  }
}

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

type MailWatcherState = {
  processedThreadIds: string[];
  lastCheckedAt: number;
  lastSuccessAt: number;
  lastEventAt: number;
  lastEventSummary: string;
  lastError: string;
};

const MAIL_WATCH_QUERY = [
  "in:inbox",
  "(is:unread OR newer_than:2d)",
  "(",
  "subject:interview OR subject:\"next steps\" OR subject:offer OR subject:rejected OR",
  "subject:unfortunately OR subject:assessment OR subject:\"online assessment\" OR",
  "\"not moving forward\" OR \"phone screen\" OR recruiter OR application",
  ")",
].join(" ");
const MAIL_WATCH_INTERVAL_MS = Math.max(60_000, Number(process.env.PAWPALS_MAIL_WATCH_INTERVAL_MS || 5 * 60_000));
let mailWatcherBusy = false;

function loadMailWatcherState(): MailWatcherState {
  try {
    if (existsSync(MAIL_WATCH_STATE_FILE)) {
      const raw = JSON.parse(readFileSync(MAIL_WATCH_STATE_FILE, "utf-8"));
      return {
        processedThreadIds: Array.isArray(raw?.processedThreadIds) ? raw.processedThreadIds.slice(-500) : [],
        lastCheckedAt: Number(raw?.lastCheckedAt || 0),
        lastSuccessAt: Number(raw?.lastSuccessAt || 0),
        lastEventAt: Number(raw?.lastEventAt || 0),
        lastEventSummary: String(raw?.lastEventSummary || ""),
        lastError: String(raw?.lastError || ""),
      };
    }
  } catch {}
  return {
    processedThreadIds: [],
    lastCheckedAt: 0,
    lastSuccessAt: 0,
    lastEventAt: 0,
    lastEventSummary: "",
    lastError: "",
  };
}

function saveMailWatcherState(state: MailWatcherState) {
  try {
    writeFileSync(MAIL_WATCH_STATE_FILE, JSON.stringify({
      ...state,
      processedThreadIds: state.processedThreadIds.slice(-500),
    }, null, 2), "utf-8");
  } catch {}
}

function loadPetRuntimeProfile() {
  try {
    if (existsSync(PET_FILE)) {
      const raw = JSON.parse(readFileSync(PET_FILE, "utf-8"));
      return {
        name: String(raw?.name || raw?.petName || "团团"),
        personality: String(raw?.personality || raw?.petPersonality || "温柔体贴，偶尔有点小调皮，最喜欢看你认真学习的样子。"),
      };
    }
  } catch {}
  return {
    name: "团团",
    personality: "温柔体贴，偶尔有点小调皮，最喜欢看你认真学习的样子。",
  };
}

function execFileJson(cmd: string, args: string[], timeout = 45_000): Promise<any> {
  return new Promise((resolve, reject) => {
    execFile(cmd, args, { timeout, maxBuffer: 8 * 1024 * 1024 }, (error, stdout, stderr) => {
      if (error) {
        reject(new Error(stderr?.trim() || error.message));
        return;
      }
      try {
        resolve(JSON.parse(String(stdout || "").trim() || "null"));
      } catch (parseError: any) {
        reject(new Error(parseError?.message || "Invalid JSON from gog"));
      }
    });
  });
}

function decodeBase64Url(data: string) {
  try {
    const normalized = data.replace(/-/g, "+").replace(/_/g, "/");
    return Buffer.from(normalized, "base64").toString("utf-8");
  } catch {
    return "";
  }
}

function extractHeaderValue(headers: any, name: string) {
  if (!Array.isArray(headers)) return "";
  const match = headers.find((header: any) => String(header?.name || "").toLowerCase() === name.toLowerCase());
  return String(match?.value || "");
}

function collectMailBodyText(node: any): string[] {
  if (!node) return [];
  const direct = [
    typeof node.text === "string" ? node.text : "",
    typeof node.bodyPlain === "string" ? node.bodyPlain : "",
    typeof node.bodyText === "string" ? node.bodyText : "",
    typeof node.snippet === "string" ? node.snippet : "",
    typeof node.body?.text === "string" ? node.body.text : "",
    typeof node.body?.data === "string" ? decodeBase64Url(node.body.data) : "",
    typeof node.data === "string" ? decodeBase64Url(node.data) : "",
  ].filter(Boolean);
  const childParts = Array.isArray(node.parts)
    ? node.parts.flatMap((part: any) => collectMailBodyText(part))
    : [];
  const payloadParts = Array.isArray(node.payload?.parts)
    ? node.payload.parts.flatMap((part: any) => collectMailBodyText(part))
    : [];
  return [...direct, ...childParts, ...payloadParts];
}

function normalizeSearchThreads(result: any): any[] {
  if (Array.isArray(result)) return result;
  if (Array.isArray(result?.threads)) return result.threads;
  if (Array.isArray(result?.messages)) return result.messages;
  if (Array.isArray(result?.items)) return result.items;
  if (Array.isArray(result?.results)) return result.results;
  return [];
}

function parseMailThread(thread: any) {
  const messages = Array.isArray(thread?.messages) ? thread.messages : [];
  const firstMessage = messages[0] || {};
  const headers = firstMessage?.payload?.headers || firstMessage?.headers || [];
  const subject = extractHeaderValue(headers, "Subject") || String(thread?.subject || "");
  const from = extractHeaderValue(headers, "From") || String(thread?.from || "");
  const body = Array.from(new Set([
    ...collectMailBodyText(thread),
    ...messages.flatMap((message: any) => collectMailBodyText(message)),
  ])).join("\n").replace(/\s+\n/g, "\n").trim();
  return {
    id: String(thread?.id || thread?.threadId || thread?.thread_id || ""),
    subject,
    from,
    snippet: String(thread?.snippet || firstMessage?.snippet || body.slice(0, 280) || ""),
    body,
  };
}

function normalizeCompanyToken(value: string) {
  return value.toLowerCase().replace(/[^a-z0-9\u4e00-\u9fa5]/g, "");
}

function findRowsForMailSignal(subject: string, from: string, body: string) {
  const board = loadCollaborationBoard();
  const haystack = `${subject}\n${from}\n${body}`.toLowerCase();
  const normalizedHaystack = normalizeCompanyToken(haystack);
  const senderDomain = from.match(/@([a-z0-9.-]+)/i)?.[1]?.toLowerCase() || "";

  const directMatches = board.filter((row) => {
    const company = row.company.trim().toLowerCase();
    const role = row.role.trim().toLowerCase();
    const normalizedCompany = normalizeCompanyToken(row.company);
    return (!!company && haystack.includes(company))
      || (!!role && haystack.includes(role))
      || (!!normalizedCompany && normalizedHaystack.includes(normalizedCompany))
      || (!!senderDomain && senderDomain.includes(normalizedCompany));
  });
  if (directMatches.length) return directMatches;

  return board
    .filter((row) => ["submitted", "interview"].includes(row.applicationStatus))
    .sort((a, b) => (b.updatedAt || "").localeCompare(a.updatedAt || ""))
    .slice(0, 1);
}

async function runMailboxWatcher(io: Server, allMessages: any[]) {
  if (mailWatcherBusy) return { ok: true as const, skipped: "busy", events: 0 };
  mailWatcherBusy = true;
  const state = loadMailWatcherState();
  state.lastCheckedAt = Date.now();
  saveMailWatcherState(state);

  try {
    const profile = loadProfileInfo();
    if (!profile.email) {
      state.lastError = "profile.md 中没有邮箱，跳过邮件监控";
      saveMailWatcherState(state);
      return { ok: false as const, skipped: "missing_email", events: 0 };
    }

    const searchPayload = await execFileJson("gog", [
      "gmail",
      "search",
      MAIL_WATCH_QUERY,
      "--account", profile.email,
      "--json",
      "--results-only",
      "--max", "20",
    ], 45_000);
    const threads = normalizeSearchThreads(searchPayload);
    const processed = new Set(state.processedThreadIds);
    let events = 0;
    const pet = loadPetRuntimeProfile();
    const tracker = JOB_AGENTS.find((agent) => agent.id === "app-tracker");

    for (const thread of threads) {
      const threadId = String(thread?.id || thread?.threadId || thread?.thread_id || "");
      if (!threadId || processed.has(threadId)) continue;
      processed.add(threadId);

      let parsed = parseMailThread(thread);
      try {
        const fullThread = await execFileJson("gog", [
          "gmail",
          "thread",
          "get",
          threadId,
          "--account", profile.email,
          "--json",
          "--results-only",
          "--full",
        ], 45_000);
        parsed = parseMailThread(fullThread);
      } catch (error) {
        console.warn("[mail-watcher] failed to read thread:", threadId, error);
      }

      const signal = detectPipelineSignal(`${parsed.subject}\n${parsed.from}\n${parsed.snippet}\n${parsed.body}`);
      if (!signal) continue;

      const matchedRows = findRowsForMailSignal(parsed.subject, parsed.from, parsed.body);
      const latestRow = matchedRows[0];
      const companyRole = latestRow
        ? `${latestRow.company} - ${latestRow.role}`
        : "某个已投岗位";
      if (tracker) {
        emitBotMessage(io, allMessages, {
          sender: tracker.name,
          avatar: tracker.avatar,
          content: `${tracker.name}：我在邮箱里捕捉到新的进展啦。\n- 岗位：${companyRole}\n- 标题：${parsed.subject || "（无标题）"}\n- 判断：${signal === "interview" ? "面试邀请" : signal === "offer" ? "offer" : "拒信"}`,
          groupId: "job",
        });
      }

      const syntheticMessage = latestRow
        ? `邮箱监控发现 ${latestRow.company} ${latestRow.role} 收到${signal === "interview" ? "面试邀请" : signal === "offer" ? "offer" : "拒信"}。邮件标题：${parsed.subject}。发件人：${parsed.from}。摘要：${parsed.snippet || parsed.body.slice(0, 240)}`
        : `邮箱监控发现收到${signal === "interview" ? "面试邀请" : signal === "offer" ? "offer" : "拒信"}。邮件标题：${parsed.subject}。发件人：${parsed.from}。摘要：${parsed.snippet || parsed.body.slice(0, 240)}`;
      await handlePipelineSignalWorkflow(io, allMessages, syntheticMessage, pet.name, pet.personality);
      state.lastEventAt = Date.now();
      state.lastEventSummary = `${companyRole} -> ${signal}`;
      events += 1;
    }

    state.processedThreadIds = Array.from(processed).slice(-500);
    state.lastSuccessAt = Date.now();
    state.lastError = "";
    saveMailWatcherState(state);
    return { ok: true as const, events };
  } catch (error: any) {
    state.lastError = error?.message || "mail watcher failed";
    saveMailWatcherState(state);
    return { ok: false as const, events: 0, skipped: state.lastError };
  } finally {
    mailWatcherBusy = false;
  }
}

function startMailWatcher(io: Server, allMessages: any[]) {
  if (String(process.env.PAWPALS_MAIL_WATCHER_DISABLED || "").toLowerCase() === "true") {
    console.log("[mail-watcher] disabled by env");
    return;
  }
  setTimeout(() => {
    void runMailboxWatcher(io, allMessages).catch((error) => console.warn("[mail-watcher] initial run failed:", error));
  }, 45_000);
  setInterval(() => {
    void runMailboxWatcher(io, allMessages).catch((error) => console.warn("[mail-watcher] interval run failed:", error));
  }, MAIL_WATCH_INTERVAL_MS);
  console.log(`[mail-watcher] started, polling every ${Math.round(MAIL_WATCH_INTERVAL_MS / 1000)}s`);
}


// ── 各 agent 可用工具分配 ─────────────────────────────────────────────
// 每个 agent 只能调用自己职责范围内的工具，防止越权操作
const AGENT_TOOLS: Record<string, string[]> = {
  "career-planner":  ["trigger_boss_login"],  // 十二只做登录弹窗，其他工具由专家执行
  "job-hunter":      ["trigger_boss_login", "search_jobs", "read_jobs", "read_collaboration_board"],
  "app-tracker":     ["trigger_boss_login", "apply_job", "record_application", "read_applications", "get_followups", "read_collaboration_board"],
  "networker":       ["read_collaboration_board"],
  "professional-teacher": ["read_collaboration_board"],
  "resume-expert":   ["read_collaboration_board"],
  "interview-coach": ["read_collaboration_board"],
};

// 投递前必须先确认的工具（调用前要求用户明确同意）
const CONFIRM_REQUIRED_TOOLS = new Set(["apply_job"]);

// ── 每个 Agent 的自动上下文注入配置（不靠关键词，按职责自动注入）────────
// files: 启动时自动读取并注入的文件（相对于 CAREER_DIR）
// tools: 启动时自动执行并注入结果的工具
const AGENT_CONTEXT_CONFIG: Record<string, {
  files?: Array<{ path: string; label: string; lines?: number }>;
  tools?: Array<"read_applications" | "get_followups" | "read_jobs" | "read_collaboration_board">;
}> = {
  "career-planner": {
    files: [
      { path: "profile.md",    label: "用户档案" },
      { path: "chat_log.md",   label: "最近协作记录", lines: 60 },
      { path: "../PLAYBOOK.md", label: "团队协作手册" },
    ],
  },
  "job-hunter": {
    files: [
      { path: "profile.md", label: "用户档案" },
      { path: "jobs.json",  label: "岗位库" },
    ],
    tools: ["read_jobs"],
  },
  "app-tracker": {
    files: [
      { path: "profile.md", label: "用户档案" },
    ],
    tools: ["read_applications", "get_followups"],
  },
  "professional-teacher": {
    files: [
      { path: "profile.md",    label: "用户档案" },
      { path: "skills_gap.md", label: "技能分析" },
    ],
    tools: ["read_collaboration_board"],
  },
  "resume-expert": {
    files: [
      { path: "profile.md",       label: "用户档案" },
      { path: "resume_master.md", label: "原始简历" },
      { path: "skills_gap.md",    label: "技能分析" },
    ],
    tools: ["read_collaboration_board"],
  },
  "networker": {
    files: [
      { path: "profile.md",   label: "用户档案" },
      { path: "contacts.json", label: "联系人库" },
    ],
    tools: ["read_collaboration_board"],
  },
  "interview-coach": {
    files: [
      { path: "resume_master.md", label: "原始简历" },
      { path: "skills_gap.md",    label: "技能分析" },
    ],
    tools: ["read_collaboration_board"],
  },
};

// ── 工具定义（Gemini Function Calling）────────────────────────────────
const TOOLS = [
  {
    type: "function",
    function: {
      name: "search_jobs",
      description: "根据用户求职意向搜索匹配的岗位，返回岗位列表（公司、职位、薪资、链接）",
      parameters: {
        type: "object",
        properties: {
          query:    { type: "string", description: "搜索关键词，从 profile.md 的目标岗位和求职类型动态生成" },
          location: { type: "string", description: "城市，如 'San Francisco' 或 '北京'，从 profile.md 的求职意向读取" },
          channels: {
            type: "array",
            items: { type: "string" },
            description: "搜索渠道，如 ['boss']、['web'] 或 ['boss','web']",
          },
        },
        required: ["query"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "read_collaboration_board",
      description: "读取协作投递表格，查看岗位的简历版本、投递状态、联系人、面试记录等汇总信息",
      parameters: { type: "object", properties: {} },
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
  {
    type: "function",
    function: {
      name: "trigger_boss_login",
      description: "弹出 Boss直聘登录窗口（Electron BrowserWindow），让用户扫码或账号密码登录。搜索岗位前必须先调用此工具确保已登录。",
      parameters: { type: "object", properties: {} },
    },
  },
];

// ── JD 内容抓取（通过 Electron BrowserWindow，复用已登录的 cookie）─────
async function fetchJdContent(url: string): Promise<string> {
  if (!url) return "";
  return new Promise<string>((resolve) => {
    const id = `jd_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`;
    const timer = setTimeout(() => {
      if (pendingJdFetchQueue.has(id)) {
        pendingJdFetchQueue.delete(id);
        resolve("");
      }
    }, 20000);
    pendingJdFetchQueue.set(id, {
      url,
      resolve: (r) => { clearTimeout(timer); resolve(r); },
    });
  });
}

// ── 工具执行器 ────────────────────────────────────────────────────────
async function executeTool(name: string, args: any): Promise<string> {
  try {
    if (name === "search_jobs") {
      const query = args.query || "";
      const city  = args.location || "101010100"; // 默认北京
      const channels = normalizeSearchChannels(Array.isArray(args.channels) ? args.channels : ["boss"]);
      const cityText = args.cityText || "";

      let bossRows: SearchResultRow[] = [];
      let webRows: SearchResultRow[] = [];
      let bossNeedsLogin = false;

      if (channels.includes("boss")) {
        const bossResult = await new Promise<string>((resolve) => {
          const id = `search_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`;
          const timer = setTimeout(() => {
            if (pendingSearchQueue.has(id)) {
              pendingSearchQueue.delete(id);
              resolve("BOSS_FAILED");
            }
          }, 35000); // 35 秒超时
          pendingSearchQueue.set(id, {
            query, city, cookieFile: COOKIE_FILE,
            resolve: (r) => { clearTimeout(timer); resolve(r); },
          });
        });
        console.log("[search_jobs] result length=" + bossResult.length + ", preview=" + JSON.stringify(bossResult.slice(0, 80)));
        if (bossResult.includes("NEED_LOGIN")) {
          bossNeedsLogin = true;
        } else if (bossResult !== "BOSS_FAILED") {
          bossRows = parseSearchMarkdownTable(bossResult).map((row) => ({ ...row, source: row.source || "boss" }));
        }
      }

      // ── 全网搜索：Tavily ─────────────────────────────────────────────
      const TAVILY_SCRIPT = path.join(
        os.homedir(),
        "Library", "Application Support", "pawpals",
        "openclaw", "workspace", "skills", "openclaw-tavily-search", "scripts", "tavily_search.py"
      );
      const tavilyKey = (() => {
        try {
          const envFile = path.join(os.homedir(), ".openclaw", ".env");
          if (existsSync(envFile)) {
            const m = readFileSync(envFile, "utf8").match(/TAVILY_API_KEY\s*=\s*(.+)/);
            if (m) return m[1].trim();
          }
        } catch {}
        return process.env.TAVILY_API_KEY || "";
      })();

      if (channels.includes("web") && existsSync(TAVILY_SCRIPT) && tavilyKey) {
        const webRaw = await new Promise<string>((resolve) => {
          const child = spawn(PYTHON_BIN, [
            TAVILY_SCRIPT,
            "--query", `${query} ${cityText || ""} 招聘 site:linkedin.com OR site:greenhouse.io OR site:lever.co OR site:jobs.ashbyhq.com OR site:myworkdayjobs.com`,
            "--max-results", "10",
            "--format", "brave",
          ], {
            stdio: ["ignore", "pipe", "pipe"],
            env: { ...process.env, TAVILY_API_KEY: tavilyKey },
          });
          let out = "", err = "";
          child.stdout.on("data", (d: Buffer) => { out += d.toString(); });
          child.stderr.on("data", (d: Buffer) => { err += d.toString(); });
          child.on("close", () => {
            resolve(out.trim() || err.slice(0, 200) || "");
          });
        });
        webRows = parseTavilyJobRows(webRaw);
      }

      if (bossNeedsLogin) {
        bossLoginPending = true;
        bossLoginPlatform = "boss";
        pendingResumableSearchTask = {
          query,
          location: city,
          cityText,
          channels,
        };
      }

      const mergedRows = [...bossRows, ...webRows].filter((row, index, list) =>
        list.findIndex((item) => item.jdUrl === row.jdUrl || `${item.company}-${item.role}` === `${row.company}-${row.role}`) === index
      );
      if (mergedRows.length > 0) {
        saveLastSearchResults(mergedRows.map((row, index) => ({ ...row, index: index + 1 })));
        syncJobsToCollaborationBoard();
        return renderSearchMarkdownTable(mergedRows.map((row, index) => ({ ...row, index: index + 1 })));
      }

      if (bossNeedsLogin) return "【NEED_LOGIN】用户尚未登录 Boss直聘，已自动弹出登录窗口。";

      return "未找到相关岗位，请重试。";
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

    if (name === "read_collaboration_board") {
      syncJobsToCollaborationBoard();
      syncApplicationsToCollaborationBoard();
      syncContactsToCollaborationBoard();
      const rows = loadCollaborationBoard();
      if (!rows.length) return "协作投递表格还是空的。";
      const top = rows.slice(-12).reverse();
      return top.map((row, idx) => [
        `${idx + 1}. ${row.company || "未知公司"} — ${row.role || "未知岗位"}`,
        `   状态：${row.applicationStatus}｜阶段：${row.workflowStage || "未记录"}｜简历：${row.resumeVersion || "未记录"}｜来源：${row.source || "未记录"}`,
        `   地点/薪资：${row.location || "未记录"}｜${row.salary || "薪资未知"}`,
        `   联系人：${row.contacts?.length || 0} 个｜外联：${row.outreachStatus || "未开始"}｜跟进：${row.followUpDate || "未设置"}`,
      ].join("\n")).join("\n\n");
    }

    if (name === "get_followups") {
      if (!existsSync(APPLICATIONS_FILE)) return "暂无投递记录。";
      const apps = JSON.parse(readFileSync(APPLICATIONS_FILE, "utf-8")) as any[];
      const today = new Date().toISOString().slice(0, 10);
      const overdue = apps.filter(a =>
        ["contact_started", "submitted", "applied"].includes(a.status) && a.followUpDate && a.followUpDate <= today
      );
      if (!overdue.length) return "[OK] 没有逾期的 follow-up！";
      return `⏰ 需要 follow-up 的投递（${overdue.length} 条）：\n\n` +
        overdue.map(a => `· **${a.company}** — ${a.role}（follow-up 日期：${a.followUpDate}）`).join("\n");
    }

    if (name === "record_application") {
      const apps = existsSync(APPLICATIONS_FILE) ? JSON.parse(readFileSync(APPLICATIONS_FILE, "utf-8")) : [];
      const existing = apps.find((app: any) =>
        (args.url && app.url && app.url === args.url) ||
        ((app.company || "") === (args.company || "") && (app.role || "") === (args.role || ""))
      );
      if (existing) {
        syncApplicationsToCollaborationBoard();
        return `[INFO] 投递记录已存在：${args.company} — ${args.role}。`;
      }
      const followUpDate = new Date(Date.now() + 7 * 86400000).toISOString().slice(0, 10);
      const status = String(args.status || "submitted").trim() || "submitted";
      const timelineAction = String(args.timelineAction || (status === "contact_started" ? "Contact started" : "Applied")).trim();
      const newApp = {
        id: `${Date.now()}`,
        company: args.company, role: args.role,
        status,
        appliedDate: new Date().toISOString().slice(0, 10),
        followUpDate,
        source: args.source || "direct",
        url: args.url || "",
        notes: args.notes || "",
        timeline: [{ date: new Date().toISOString().slice(0, 10), action: timelineAction }],
      };
      apps.push(newApp);
      writeFileSync(APPLICATIONS_FILE, JSON.stringify(apps, null, 2));
      syncApplicationsToCollaborationBoard();
      return `[OK] 已记录状态：${args.company} — ${args.role}（${status === "contact_started" ? "已发起沟通" : "已提交"}），follow-up 提醒设在 ${followUpDate}。`;
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
      const platform = isBossJobUrl(job_url) ? "boss" : "web-form";
      let safeGreeting = greeting;
      try {
        const profileMd = readFileSync(path.join(CAREER_DIR, "profile.md"), "utf-8");
        const nameMatch = profileMd.match(/姓名[：:]\s*(.+)/) || profileMd.match(/^#[^—\n]+—\s*(.+)/m);
        const expMatch = profileMd.match(/\*\*([^*]+)\*\*\s*—\s*AI PM[^,\n]*/m);
        const profileName = nameMatch?.[1]?.trim() || "";
        if (!safeGreeting) {
          const latestExp = expMatch?.[1]?.trim() || "";
          const nameDisplay = profileName || "我";
          safeGreeting = `您好！我是${nameDisplay}${latestExp ? `，曾在${latestExp}担任AI产品经理` : ""}，对「${title}」岗位非常感兴趣，期待与您进一步沟通！`;
        }
      } catch {
        if (!safeGreeting) safeGreeting = `您好！对「${title}」岗位非常感兴趣，期待与您沟通！`;
      }
      return await new Promise<string>((resolve) => {
        const id = `apply_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`;
        pendingApplyQueue.set(id, {
          id,
          platform,
          jobUrl: job_url,
          company,
          title,
          greeting: safeGreeting,
          queuedAt: new Date().toISOString(),
        });
        const timer = setTimeout(() => {
          if (pendingApplyQueue.has(id)) pendingApplyQueue.delete(id);
          if (applyResultStore.has(id)) applyResultStore.delete(id);
          clearInterval(poll);
          resolve("[ERR] Boss直聘 自动投递超时，请重试。");
        }, 90_000);

        const poll = setInterval(() => {
          if (!applyResultStore.has(id)) return;
          const raw = String(applyResultStore.get(id) || "");
          applyResultStore.delete(id);
          clearInterval(poll);
          clearTimeout(timer);
          if (platform === "boss" && (raw === "SUCCESS" || raw === "SUCCESS_WITH_RESUME")) {
            resolve(`[OK] 已在 Boss直聘 向 **${company}** 的「${title}」发起沟通。`);
            return;
          }
          if (platform === "boss" && raw === "ALREADY_APPLIED") {
            resolve(`[INFO] 你之前已经和 **${company}** 沟通过了，无需重复打招呼。`);
            return;
          }
          if (platform === "boss" && raw === "NEED_LOGIN") {
            bossLoginPending = true;
            bossLoginPlatform = "boss";
            resolve("[ERR] Boss直聘 当前未登录，已自动弹出桌面登录窗口。请登录后重试。");
            return;
          }
          if (platform === "boss" && raw.startsWith("NO_BUTTON")) {
            resolve("[ERR] 这个 Boss 岗位当前没有可用的「立即沟通」入口，可能已下线或不支持直接打招呼。");
            return;
          }
          if (platform === "boss" && raw.startsWith("NO_INPUT")) {
            resolve("[ERR] 已打开 Boss 聊天页，但没有找到输入框，可能页面结构有变。");
            return;
          }
          if (platform === "web-form" && raw === "SUCCESS") {
            resolve(`[OK] 已在官网申请页自动填写并提交 **${company}** 的「${title}」。`);
            return;
          }
          if (platform === "web-form" && raw === "FILLED_ONLY") {
            resolve(`[INFO] 已在官网申请页自动填好主要字段，请你检查后手动提交 **${company}** 的「${title}」。`);
            return;
          }
          if (platform === "web-form" && raw === "NO_FORM") {
            resolve("[ERR] 这个官网申请页没有识别到可填写的表单。");
            return;
          }
          if (platform === "web-form" && raw === "NO_FORM_DATA") {
            resolve("[ERR] 识别到了官网表单，但当前档案里缺少足够的自动填写信息。");
            return;
          }
          if (raw.startsWith("ERROR:")) {
            resolve(`[ERR] 自动投递失败：${raw.slice(6) || "未知原因"}`);
            return;
          }
          resolve(`[ERR] 自动投递失败：${raw || "未知原因"}`);
        }, 800);
      });
    }

    if (name === "trigger_boss_login") {
      // 直接弹出 Electron BrowserWindow 让用户扫码登录
      bossLoginPending = true;
      return "【LOGIN_WINDOW_OPENED】已弹出 Boss直聘 登录窗口（Electron 内置浏览器），请用手机扫码或账号密码登录，登录成功后窗口会自动关闭。";
    }

    return `工具 ${name} 暂未实现。`;
  } catch (e: any) {
    return `工具执行失败：${e.message}`;
  }
}

const JOB_AGENTS = [
  { id: "career-planner",  role: "首席伴学官", name: "首席伴学官", avatar: "", default: true, isChief: true },
  { id: "professional-teacher", role: "专业老师", name: "专业老师", avatar: "/avatars/professional-teacher.jpg" },
  { id: "resume-expert",   role: "简历专家",   name: "简历专家",   avatar: "/avatars/resume-expert.jpg" },
  { id: "job-hunter",      role: "岗位猎手",   name: "岗位猎手",   avatar: "/avatars/job-hunter.jpg" },
  { id: "app-tracker",     role: "投递管家",   name: "投递管家",   avatar: "/avatars/app-tracker.jpg" },
  { id: "networker",       role: "人脉顾问",   name: "人脉顾问",   avatar: "/avatars/networker.jpg" },
  { id: "interview-coach", role: "面试教练",   name: "面试教练",   avatar: "/avatars/interview-coach.jpg" },
];

const agentByName: Record<string, typeof JOB_AGENTS[0]> = {};
JOB_AGENTS.forEach(a => { agentByName[a.name] = a; });
agentByName["职业规划师"] = JOB_AGENTS.find(a => a.id === "career-planner")!;
agentByName["技能分析师"] = JOB_AGENTS.find(a => a.id === "professional-teacher")!;
agentByName["技能成长师"] = JOB_AGENTS.find(a => a.id === "professional-teacher")!;
agentByName["JD分析师"] = JOB_AGENTS.find(a => a.id === "professional-teacher")!;
const agentIdAliases: Record<string, string> = {
  "jd-analyst": "professional-teacher",
};

function detectTargetAgent(text: string) {
  // 1. 优先：「回复 某人」（引用回复格式，取被回复对象作为目标）
  const replyMatch = text.match(/回复\s+\*{0,2}([\u4e00-\u9fa5A-Za-z\d]+)\*{0,2}[：:]/);
  if (replyMatch) {
    const a = agentByName[replyMatch[1]];
    if (a) return a;
  }

  // 2. 明确 @某人
  for (const [name, agent] of Object.entries(agentByName)) {
    if (text.includes("@" + name)) return agent;
  }

  // 3. 其他情况一律由团团（career-planner）接收，由团团决定是否分配给 subagent
  return JOB_AGENTS.find(a => a.default)!;
}

function detectMentionedAgents(text: string, sender: typeof JOB_AGENTS[0]) {
  const mentioned: typeof JOB_AGENTS[0][] = [];
  const seen = new Set<string>();

  // 检测 @名字 格式
  for (const m of text.matchAll(/@([\u4e00-\u9fa5A-Za-z\d]+)/g)) {
    const a = agentByName[m[1]];
    if (a && a.id !== sender.id && !seen.has(a.id)) {
      seen.add(a.id);
      mentioned.push(a);
    }
  }

  // 检测 sessions_spawn agent-id 格式（SOUL.md 里用的）
  for (const m of text.matchAll(/sessions_spawn\s+([\w-]+)/g)) {
    const agentId = agentIdAliases[m[1]] || m[1];
    const a = JOB_AGENTS.find(ag => ag.id === agentId);
    if (a && a.id !== sender.id && !seen.has(a.id)) {
      seen.add(a.id);
      mentioned.push(a);
    }
  }

  // 语义检测：career-planner 提到专家但没用 sessions_spawn 时自动补
  // job-hunter / app-tracker / networker 已合并，不再路由给它们
  if (sender.id === "career-planner") {
    const semanticMap: { pattern: RegExp; agentId: string }[] = [
      { pattern: /简历专家|resume.?expert|简历来了|诊断简历/, agentId: "resume-expert" },
      { pattern: /专业老师|技能分析|jd.?analyst|深度定位|技能定位|市场研究/, agentId: "professional-teacher" },
      { pattern: /面试教练|interview.?coach|模拟面试/, agentId: "interview-coach" },
    ];
    for (const { pattern, agentId } of semanticMap) {
      if (pattern.test(text) && !seen.has(agentId)) {
        const a = JOB_AGENTS.find(ag => ag.id === agentId);
        if (a) { seen.add(a.id); mentioned.push(a); }
      }
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
  petPersonality = "温柔体贴，偶尔有点小调皮，最喜欢看你认真学习的样子。",
  extraSystemPrompt = "",
  allowedToolNamesOverride?: string[]
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
    // ── 从工作区 SOUL.md 加载 Agent 身份（OpenClaw 多 Agent 架构）────────
    // 每个 Agent 的人格/职责在 career/workspaces/<agentId>/SOUL.md 中定义
    const soulMd = loadAgentSoul(agent.id);
    const userCtx = loadAgentUserContext(agent.id);

    // 该 agent 可用的工具列表
    const allowedToolNames = allowedToolNamesOverride ?? (AGENT_TOOLS[agent.id] ?? []);
    const agentTools = TOOLS.filter(t => allowedToolNames.includes(t.function.name));

    const lastUserMsg = [...messages].reverse().find(m => m.role === "user")?.content ?? "";

    // Gateway 请求头（复用）
    const gatewayHeaders = {
      "Authorization": `Bearer ${getGatewayToken()}`,
      "Content-Type": "application/json",
      "x-openclaw-session-key": agent.id === "career-planner" ? `pawpals-main` : `pawpals-${agent.id}`,
    };

    // ── 预执行工具（Agent 职责驱动，不靠关键词）────────────────────────────
    // Step 1+2: 按 AGENT_CONTEXT_CONFIG 自动注入文件 + 工具结果
    let calledApply = false;
    const toolInjections: string[] = [];

    // 去掉 @mention 和引用块再做关键词判断（仅用于 search_jobs）
    const userMsgNoMention = lastUserMsg
      .replace(/^>.*$/gm, "")
      .replace(/@[\u4e00-\u9fa5A-Za-z\d]+/g, "")
      .trim();

    const agentCtx = AGENT_CONTEXT_CONFIG[agent.id] ?? {};

    // 自动注入文件（profile.md / skills_gap.md / chat_log 等）
    for (const fileConf of agentCtx.files ?? []) {
      try {
        const filePath = path.join(CAREER_DIR, fileConf.path);
        let content = readFileSync(filePath, "utf8");
        if (fileConf.lines) {
          // 只取末尾 N 行（chat_log 等只需要最近记录）
          content = content.split("\n").slice(-fileConf.lines).join("\n");
        }
        if (content.trim()) {
          toolInjections.push(`【${fileConf.label}】\n${content.trim()}`);
        }
      } catch { /* 文件不存在则跳过 */ }
    }

    // 自动执行工具（read_applications / get_followups / read_jobs）
    for (const toolName of agentCtx.tools ?? []) {
      if (!allowedToolNames.includes(toolName)) continue;
      const labels: Record<string, string> = {
        read_applications: "投递记录",
        get_followups:     "Follow-up 提醒",
        read_jobs:         "岗位库",
        read_collaboration_board: "协作投递表格",
      };
      const permLabels: Record<string, "workspace" | "network" | "boss"> = {
        read_applications: "workspace",
        get_followups:     "workspace",
        read_jobs:         "workspace",
        read_collaboration_board: "workspace",
      };
      emitToolActivity(toolName, `读取${labels[toolName]}`, permLabels[toolName]);
      const result = await executeTool(toolName, {});
      if (result.trim()) {
        toolInjections.push(`【${labels[toolName]}】\n${result}`);
      }
    }

    // search_jobs：关键词触发，用 LLM 从 profile + 用户消息生成搜索关键词
    if (allowedToolNames.includes("search_jobs") &&
        /boss|搜|找工作|岗位|实习|intern|job|职位|帮我搜|重新搜/i.test(userMsgNoMention)) {
      let profileText = "";
      try { profileText = readFileSync(path.join(CAREER_DIR, "profile.md"), "utf8"); } catch {}

      // 如果 profile.md 是空的，从最近聊天记录里补充上下文
      if (!profileText.trim() || profileText.trim().length < 30) {
        try {
          const chatLog = readFileSync(path.join(CAREER_DIR, "chat_log.md"), "utf8");
          profileText = "【从聊天记录提取的用户信息】\n" + chatLog.slice(-2000);
        } catch {}
      }

      const roleMatch = profileText.match(/目标岗位[：:]\s*(.+)/) || profileText.match(/方向[：:]\s*(.+)/);
      const typeMatch = profileText.match(/类型[：:]\s*(.+)/);
      const cityMatch = profileText.match(/城市[：:]\s*(.+)/);
      const companyPreferenceMatch = profileText.match(/公司偏好[：:]\s*(.+)/);
      const queryResult = await generateSearchQueryAndCity({
        profileText,
        userMessage: lastUserMsg,
        fallbackRole: (roleMatch?.[1] || "").split(/[,，\/]/)[0].trim(),
        jobType: typeMatch?.[1] || "",
        targetCity: cityMatch?.[1] || "",
        companyPreference: companyPreferenceMatch?.[1] || "",
      });
      const query = queryResult.query;
      const cityCode = queryResult.cityCode;

      if (!query) {
        toolInjections.push("【搜索提示】未能确定求职方向，请告诉我你想找什么类型的岗位。");
        return { reply: null, calledApply: false };
      }
      console.log(`[search_jobs] query="${query}", city="${cityCode}"`);
      emitToolActivity("search_jobs", "搜索岗位", "network", query);
      const result = await executeTool("search_jobs", { query, location: cityCode });
      console.log(`[search_jobs] result length=${result.length}, preview="${result.slice(0,100)}"`);
      toolInjections.push(`【搜索结果】\n${result}`);
    }

    // apply_job: 投递管家收到投递任务时，自动从协作表查 URL 并执行
    if (allowedToolNames.includes("apply_job")) {
      // 方式 1: AI 回复中的 APPLY_JOB:: 指令 + 用户确认
      const sessionKey = agent.id;
      const pending = pendingApplyCommands.get(sessionKey);
      const userConfirmedApply = /^(确认|投递|投|好的|是的|ok|yes|apply)$/i.test(lastUserMsg.trim());
      if (pending && userConfirmedApply) {
        emitToolActivity("apply_job", "自动投递岗位", "boss", pending.url);
        const result = await executeTool("apply_job", {
          job_url: pending.url,
          company: pending.company,
          title:   pending.title,
        });
        toolInjections.push(`【投递结果】\n${result}`);
        pendingApplyCommands.delete(sessionKey);
        calledApply = true;
      }

      // 方式 2: 消息里包含投递意图（首席 @投递管家 说"帮我投"），从协作表查 URL
      if (!calledApply && /投递|投这|帮.*投|请.*投|apply/i.test(lastUserMsg)) {
        const board = loadCollaborationBoard();
        // 从消息里匹配公司名或岗位名
        const matchedRow = board.find((row: any) => {
          return row.jdUrl && (
            (row.company && lastUserMsg.includes(row.company)) ||
            (row.role && lastUserMsg.includes(row.role))
          );
        }) || board.find((row: any) => row.jdUrl && row.workflowStage === "selected");
        // 如果没匹配到具体岗位，用最近搜索结果的第一个
        const searchResults = loadLastSearchResults();
        const targetRow = matchedRow || (searchResults.length > 0 ? {
          company: searchResults[0].company,
          role: searchResults[0].role,
          jdUrl: searchResults[0].jdUrl,
        } : null);

        if (targetRow?.jdUrl) {
          emitToolActivity("apply_job", "自动投递岗位", "boss", targetRow.jdUrl);
          const result = await executeTool("apply_job", {
            job_url: targetRow.jdUrl,
            company: targetRow.company || "",
            title: targetRow.role || "",
          });
          toolInjections.push(`【投递结果】\n${result}`);
          calledApply = true;
        } else {
          toolInjections.push("【投递提示】未在协作表中找到该岗位的投递链接，请先让岗位猎手搜索岗位。");
        }
      }
    }

    // 构建发给 Gateway 的消息（工具结果以 system 注入）
    const agentRole = (agent as any).role || agent.name;

    // ── 优先从工作区 SOUL.md 读取 Agent 系统 prompt（OpenClaw 多 Agent 架构）
    // 如果 SOUL.md 不存在则回退到内联 prompt
    const systemParts: string[] = [];
    if (soulMd) {
      // 替换 SOUL.md 中的占位符（路径、名字、性格等）
      const resolvedSoul = soulMd
        .replace(/\{\{petName\}\}/g, petName)
        .replace(/\{\{petPersonality\}\}/g, petPersonality)
        .replace(/\{\{OPENCLAW_HOME\}\}/g, OPENCLAW_HOME)
        .replace(/\{\{CAREER_DIR\}\}/g, CAREER_DIR)
        .replace(/\{\{APP_DATA_DIR\}\}/g, APP_DATA_DIR);
      systemParts.push(resolvedSoul);
      if (userCtx) systemParts.push(`【用户背景】\n${userCtx}`);
    } else {
      // 回退：SOUL.md 不存在时用内联 prompt
      const petIdentity = agent.id === "career-planner"
        ? `你叫「${petName}」，是用户的首席AI伴学官。性格设定：${petPersonality}。`
        : `你是「${petName}」召集的专业助手「${agentRole}」，协助用户求职。`;
      const silentRule = "【严格规则】直接给出结果，绝对不要说出内部操作步骤（如'读取文件'、'调用工具'、'追加日志'等）。不要在回复中显示任何文件路径。不要输出协作日志内容。不要写代码块。";
      systemParts.push(petIdentity, silentRule);
    }
    // 强制身份声明：防止 agent 混淆自己是谁
    if (!isChief) {
      const agentDisplayName = (agent as any).role || agent.name;
      systemParts.push(`【身份约束 — 必须遵守】\n你是「${agentDisplayName}」，不是「${petName}」。「${petName}」是首席伴学官（用户的宠物），你是 ta 召集的专家团队成员。\n- 你必须以「${agentDisplayName}」的身份说话\n- 绝对不要自称「${petName}」或「主人」\n- 不要重复首席伴学官已经说过的内容`);
    } else if (groupId === "job") {
      systemParts.push(`【搜岗职责边界 — 必须遵守】\n在求职群里，搜岗职责只属于「岗位猎手」。\n- 你绝对不能自己搜索岗位\n- 当用户要搜岗时，你负责承接、确认、交接给岗位猎手\n\n【流程推进 — 你是总调度】\n每当有专家完成了任务（比如简历专家解析完、专业老师定位完），你必须主动接话、总结结果、推进下一步。不要等用户催你。你是团队的发动机，所有人做完事都要经过你汇总和推进。\n\n【档案确认协议】\n当你认为用户画像采集完毕（目标方向、城市、实习类型、公司偏好等都聊到了），在回复末尾写：PROFILE_CONFIRM\n系统会自动弹出一张可编辑的档案确认卡让用户查看和修改。\n\n【进度追踪协议】\n当你推进了求职流程的阶段时，在回复末尾写一行：\nPHASE_UPDATE::{"phase":"阶段名"}\n可用阶段：resume_collection（建档）、profile_collection（采集画像）、professional_positioning（定位分析）、resume_diagnosis（简历优化）、search_strategy（搜索策略）、first_job_search（搜岗）、first_application（投递）、completed（完成）\n只在阶段真正推进时才写，不要每条消息都写。`);
    }

    const boardInstruction = getStructuredBoardInstruction(agent.id);
    if (boardInstruction) systemParts.push(boardInstruction);
    if (extraSystemPrompt) systemParts.push(extraSystemPrompt);
    // 岗位猎手：特殊结果直接发出不走 LLM
    if (agent.id === "job-hunter" && toolInjections.length > 0) {
      const searchResult = toolInjections.find(t => t.startsWith("【搜索结果】"));
      if (searchResult) {
        const rawResult = searchResult.replace("【搜索结果】\n", "").trim();

        // NEED_LOGIN：直接发登录引导消息，不走 LLM（同时 Electron 登录窗口已自动弹出）
        if (rawResult.includes("NEED_LOGIN")) {
          bossLoginPending = true; // 确保触发 Electron 登录窗口
          const loginMsg = "搜 Boss直聘 前需要先登录一下～ 我已经在桌面端帮你弹出 Boss直聘 登录窗口了，你直接扫码或输入账号密码就行。登录成功后窗口会自动关闭，我这边也会自动继续搜索，不用再手动回我。";
          const idx = allMessages.findIndex(m => m.id === msgId);
          if (idx !== -1) {
            allMessages[idx].content = loginMsg;
            allMessages[idx].isLoading = false;
          }
          for (const char of loginMsg) {
            io.emit("stream_chunk", { id: msgId, token: char, groupId });
          }
          io.emit("stream_done", { id: msgId });
          saveMessages(allMessages);
          return { reply: loginMsg, calledApply: false };
        }

        // 判断是否已经是 Markdown 表格（Boss直聘 API 直接返回）
        const isTable = rawResult.startsWith("| #") || rawResult.startsWith("|#") || rawResult.includes("|---");
        if (isTable) {
          const tableContent = rawResult;
          const idx = allMessages.findIndex(m => m.id === msgId);
          if (idx !== -1) {
            allMessages[idx].content = tableContent;
            allMessages[idx].isLoading = false;
          }
          for (const char of tableContent) {
            io.emit("stream_chunk", { id: msgId, token: char, groupId });
          }
          io.emit("stream_done", { id: msgId });
          saveMessages(allMessages);
          appendChatLog(agent, messages[messages.length-1]?.content ?? "", tableContent);
          return { reply: tableContent, calledApply: false };
        }
        // 否则（Tavily 返回的纯文本）继续走 LLM 整理成表格
      }
    }

    if (toolInjections.length > 0) {
      systemParts.push(
        "以下是已执行的工具结果，请**只**基于这些数据回答用户。" +
        "禁止再调用任何 web_search、tavily、browse 等外部搜索——数据已齐全，无需补充：\n\n" +
        toolInjections.join("\n\n")
      );
    }

    // 在 system prompt 最前面注入固定身份 ID
    const agentIdentityHeader = isChief
      ? `[AGENT_ID: ${agent.id}] [DISPLAY_NAME: ${petName}] [ROLE: 首席伴学官]`
      : `[AGENT_ID: ${agent.id}] [DISPLAY_NAME: ${(agent as any).role || agent.name}] [ROLE: ${(agent as any).role || agent.name}]`;

    const apiMessages: any[] = [
      { role: "system", content: agentIdentityHeader + "\n\n" + systemParts.join("\n\n"), name: agent.id },
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

    if (!streamRes.ok || !streamRes.body) {
      const errBody = await streamRes.text().catch(() => "");
      console.error(`[stream] ${agent.id} HTTP ${streamRes.status}:`, errBody.slice(0, 300));
      throw new Error(`HTTP ${streamRes.status}`);
    }

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

    // ── Step 3: 解析 AI 回复中的结构化投递命令 ────────────────────────────
    // AI 可在回复中嵌入：APPLY_JOB::{"url":"...","company":"...","title":"..."}
    // 匹配后存入 pendingApplyCommands，等用户下一条"确认"消息触发实际投递
    const applyCommandMatch = fullText.match(/APPLY_JOB::(\{[^}]+\})/);
    if (applyCommandMatch) {
      try {
        const cmd = JSON.parse(applyCommandMatch[1]) as { url: string; company: string; title: string };
        if (cmd.url) {
          pendingApplyCommands.set(agent.id, {
            url:       cmd.url,
            company:   cmd.company || "",
            title:     cmd.title   || "",
            timestamp: Date.now(),
          });
          console.log(`[apply_cmd] stored pending apply for ${agent.id}: ${cmd.url}`);
          // 从展示给用户的文本中隐藏原始指令行
          fullText = fullText.replace(/APPLY_JOB::\{[^}]+\}\n?/g, "").trim();
        }
      } catch (e) {
        console.warn("[apply_cmd] failed to parse APPLY_JOB command:", applyCommandMatch[1]);
      }
    }

    for (const line of fullText.split("\n")) {
      const trimmed = line.trim();
      if (!trimmed.startsWith("BOARD_UPDATE::")) continue;
      const jsonText = trimmed.slice("BOARD_UPDATE::".length).trim();
      try {
        const update = JSON.parse(jsonText);
        applyBoardUpdate(update);
        fullText = fullText.replace(line, "").trim();
      } catch (e) {
        console.warn("[board_update] failed to parse:", jsonText);
      }
    }

    // 保留原始回复用于标签检测（SLOT_UPDATE / PHASE_COMPLETE / NEEDS_CLARIFICATION）
    const rawReply = fullText;

    // 解析 PHASE_UPDATE / PROFILE_CONFIRM 标签
    await parseAndUpdatePhase(fullText, io, allMessages, petName);

    // 清理结构化标签，不展示给用户
    fullText = fullText
      .replace(/SLOT_UPDATE::\{[^}]*\}\n?/g, "")
      .replace(/PHASE_UPDATE::\{[^}]*\}\n?/g, "")
      .replace(/PHASE_COMPLETE\n?/g, "")
      .replace(/NEEDS_CLARIFICATION\n?/g, "")
      .replace(/STRATEGY_UPDATE::\{[^}]*\}\n?/g, "")
      .replace(/STRATEGY_CONFIRMED\n?/g, "")
      .replace(/RESUME_DECISION::\w+\n?/g, "")
      .trim();

    // 流结束，更新内存中消息并通知前端完成
    const idx = allMessages.findIndex(m => m.id === msgId);
    if (idx !== -1) {
      allMessages[idx].content = fullText;
      allMessages[idx].isLoading = false;
    }
    console.log(`[stream] ${agent.id} done, fullText length=${fullText.length}, preview="${fullText.slice(0,100)}"`);
    io.emit("stream_done", { id: msgId });
    saveMessages(allMessages);
    // 把这轮对话写入 chat_log，飞书 agents 也能看到 PawPals 的上下文
    const lastUser = [...messages].reverse().find(m => m.role === "user")?.content ?? "";
    appendChatLog(agent, lastUser, fullText);
    // 返回原始回复（含标签），调用方用 rawReply 检测 PHASE_COMPLETE 等信号
    return { reply: rawReply, calledApply };
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
        "Authorization": `Bearer ${getGatewayToken()}`,
        "Content-Type": "application/json",
        "x-openclaw-session-key": "pawpals-main",
      },
      body: JSON.stringify({
        model: "auto",
        messages: [
          { role: "system", content: `你是${petName}，求职助手的协调者。判断用户请求是否需要多个专家协作。
可用专家：job-hunter（搜岗）、resume-expert（简历）、interview-coach（面试）、app-tracker（投递记录）、networker（人脉）、professional-teacher（专业定位）。
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

    // ── 十二用 LLM 回复，sessions_spawn 由 LLM 自行决定 ──
    io.emit("agent_thinking", { agentName: petName, groupId });

    // 多专家并行判断：只有消息里明确同时提到多个任务领域时才调 orchestrate（避免额外 LLM 调用）
    const needsMultiAgent = /(?:简历|resume).*(?:搜|岗位|job)|(?:搜|岗位|job).*(?:简历|resume)|(?:面试|interview).*(?:投递|apply)|同时|一起帮我.*和/.test(userMsg);
    const tasks = needsMultiAgent ? await orchestrate(userMsg, contextSummary, petName) : null;

    if (tasks && tasks.length > 1) {
      // ── 多专家并行模式 ──
      const expertResults: { agentId: string; reply: string }[] = [];

      // 读取档案和简历注入上下文
      let sharedProfileCtx = "";
      try {
        const profile = existsSync(path.join(CAREER_DIR, "profile.md")) ? readFileSync(path.join(CAREER_DIR, "profile.md"), "utf8") : "";
        const resume = existsSync(path.join(CAREER_DIR, "resume_master.md")) ? readFileSync(path.join(CAREER_DIR, "resume_master.md"), "utf8") : "";
        if (profile) sharedProfileCtx += `\n【用户档案】\n${profile}`;
        if (resume) sharedProfileCtx += `\n\n【简历原文】\n${resume.slice(0, 3000)}`;
      } catch {}

      await Promise.all(tasks.map(async ({ agentId, task }) => {
        const expert = JOB_AGENTS.find(a => a.id === agentId);
        if (!expert) return;
        io.emit("agent_thinking", { agentName: expert.name, groupId });
        const expertMessages = [
          { role: "user", content: `【来自${petName}的任务】\n背景：\n${contextSummary}${sharedProfileCtx}\n\n你的任务：${task}` }
        ];
        const { reply } = await streamAgent(expert, expertMessages, depth, io, groupId, allMessages, petName, petPersonality);
        io.emit("agent_done", { groupId });
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
          [...messages, { role: "user", content: `各专家已直接向用户展示了分析结果，用户已经看到了。你只需要用 1-2 句话做简短收尾（比如：确认完成、说下一步），绝对不要重复专家的内容。专家结果供你参考（不要复述）：\n\n${summaryContext}` }],
          depth, io, groupId, allMessages, petName, petPersonality
        );
      }
      return;
    }

    // 路由：@提到具体专家时直接路由，否则都先经过 career-planner（十二）协调
    const targetAgent = detectTargetAgent(userMsg);
    const routeTarget = targetAgent;
    if (routeTarget.id !== "career-planner") {
      io.emit("agent_thinking", { agentName: routeTarget.name, groupId });
      let profileCtx = "";
      try {
        const profile = existsSync(path.join(CAREER_DIR, "profile.md")) ? readFileSync(path.join(CAREER_DIR, "profile.md"), "utf8") : "";
        if (profile) profileCtx = `\n\n【用户档案】\n${profile}`;
      } catch {}
      const expertMessages = [
        { role: "user", content: `【来自${petName}的任务】\n背景：\n${contextSummary}${profileCtx}\n\n请处理：${userMsg}` }
      ];
      await streamAgent(routeTarget, expertMessages, depth, io, groupId, allMessages, petName, petPersonality);
      io.emit("agent_done", { groupId });
      return;
    }
  }

  // 团团直接回复，或专家被直接 @ 时
  const { reply, calledApply } = await streamAgent(agent, messages, depth, io, groupId, allMessages, petName, petPersonality);
  if (!reply || calledApply || depth >= MAX_CHAIN_DEPTH) return;

  const nextAgents = detectMentionedAgents(reply, agent);
  if (nextAgents.length > 0) {
    // 读取用户档案和简历，注入给子 agent
    let profileCtx = "";
    try {
      const profilePath = path.join(CAREER_DIR, "profile.md");
      const resumePath = path.join(CAREER_DIR, "resume_master.md");
      const profile = existsSync(profilePath) ? readFileSync(profilePath, "utf8") : "";
      const resume = existsSync(resumePath) ? readFileSync(resumePath, "utf8") : "";
      if (profile) profileCtx += `\n【用户档案】\n${profile}`;
      if (resume) profileCtx += `\n\n【简历原文】\n${resume.slice(0, 3000)}`;
    } catch {}

    // 原始用户消息（用于给子 agent 明确任务）
    const originalUserMsg = messages.filter(m => m.role === "user").slice(-1)[0]?.content ?? "";
    for (const nextAgent of nextAgents) {
      await new Promise(r => setTimeout(r, 150));
      io.emit("agent_thinking", { agentName: nextAgent.name, groupId });
      const spawnMatch = reply.match(new RegExp(`sessions_spawn\\s+${nextAgent.id}[^\\n]*\\n?([^\\n]+)?`));
      const spawnTask = spawnMatch?.[1]?.trim() || "";
      // 优先用 sessions_spawn 里的描述，其次用原始用户消息
      const taskDesc = spawnTask || originalUserMsg || `${petName} 派给你任务，请根据用户档案和简历认真完成`;
      await runAgentChain(
        nextAgent,
        [...messages,
          { role: "assistant", content: reply, name: agent.name },
          { role: "user", content: `用户原始请求：${taskDesc}${profileCtx}` }],
        depth + 1, io, groupId, allMessages, petName, petPersonality
      );
      io.emit("agent_done", { groupId });
    }
  }
}


// ── handleJobOnboarding: 降级为「记录器」──────────────────────────────
// 不拦截消息、不做正则判断、不控制流转
// 只从 LLM 回复中解析 PHASE_UPDATE:: 标签，更新 phase 供进度条读取
// 最小 guard: 附件上传时保存简历文件
async function handleJobOnboarding(
  io: Server,
  allMessages: any[],
  userMsg: string,
  petName: string,
  petPersonality: string,
  attachmentText = "",
  attachmentName = ""
) {
  // Guard 1: 如果用户上传了简历附件，保存到 resume_master.md + media/inbound
  if (hasResumeAttachment(userMsg)) {
    const resumePayload = getMessageResumePayload({ content: userMsg, attachmentText, attachmentName });
    saveInitialResumeMaster(resumePayload.rawText, resumePayload.fileName);
  }

  // 不拦截 — 所有消息都交给 runAgentChain 处理
  return false;
}

// ── 从 agent 回复中解析 PHASE_UPDATE 并更新进度条 ─────────────────────
async function parseAndUpdatePhase(reply: string, io: Server, allMessages?: any[], petName?: string) {
  // PHASE_UPDATE:: — 更新进度条
  const match = reply.match(/PHASE_UPDATE::\{"phase":"([^"]+)"\}/);
  if (match) {
    const newPhase = match[1];
    const validPhases = [
      "resume_collection", "profile_collection", "profile_confirm",
      "professional_positioning", "resume_diagnosis", "resume_review",
      "search_strategy", "first_job_search", "first_application", "completed"
    ];
    if (validPhases.includes(newPhase)) {
      const state = loadOnboardingState();
      if (state.phase !== newPhase) {
        state.phase = newPhase as any;
        if (newPhase === "completed") state.completed = true;
        saveOnboardingState(state, io);
        console.log(`[phase] updated to ${newPhase}`);
      }
    }
  }

  // PROFILE_CONFIRM:: — LLM 认为画像收集完毕，用 LLM 从聊天记录提取画像并写入 profile.md
  if (reply.includes("PROFILE_CONFIRM") && allMessages) {
    const state = loadOnboardingState();
    const chiefAvatar = `https://api.dicebear.com/7.x/adventurer/svg?seed=${encodeURIComponent(petName || "团团")}`;

    // 从最近聊天记录中用 LLM 提取画像
    let profileData: any = {};
    try {
      const recentChat = allMessages
        .filter((m: any) => m.groupId === "job")
        .slice(-20)
        .map((m: any) => `${m.sender}: ${(m.content || "").slice(0, 300)}`)
        .join("\n");

      const extractRes = await fetch(`${GATEWAY_BASE}/v1/chat/completions`, {
        method: "POST",
        headers: { "Authorization": `Bearer ${getGatewayToken()}`, "Content-Type": "application/json" },
        body: JSON.stringify({
          model: "auto",
          messages: [{
            role: "system",
            content: `从对话记录中提取用户求职画像。返回 JSON：{"targetRole":"目标岗位","market":"国内/海外","jobType":"实习/全职","timeRange":"时间","targetCity":"城市","roleScope":"范围","companyPreference":"公司偏好","traits":"个人特质","skills":["技能1","技能2"]}。只返回 JSON。`
          }, {
            role: "user",
            content: recentChat
          }],
          max_tokens: 300,
        }),
        signal: AbortSignal.timeout(15000),
      });
      const extractData = await extractRes.json() as any;
      const extractText = extractData.choices?.[0]?.message?.content || "";
      const jsonMatch = extractText.match(/\{[\s\S]*\}/);
      if (jsonMatch) profileData = JSON.parse(jsonMatch[0]);
    } catch (e) {
      console.warn("[profile_confirm] LLM extraction failed:", (e as any)?.message);
    }

    // 写入 profile.md
    if (profileData.targetRole) {
      const profileMd = `# 用户档案\n\n方向: ${profileData.targetRole || ""}\n类型: ${profileData.jobType || ""}\n市场: ${profileData.market || ""}\n时间: ${profileData.timeRange || ""}\n城市: ${profileData.targetCity || ""}\n范围: ${profileData.roleScope || ""}\n公司偏好: ${profileData.companyPreference || ""}\n个人特质: ${profileData.traits || ""}\n\n## 技能\n${(profileData.skills || []).map((s: string) => `- ${s}`).join("\n")}\n`;
      try {
        writeFileSync(path.join(CAREER_DIR, "profile.md"), profileMd, "utf8");
        console.log("[profile_confirm] wrote profile.md");
      } catch {}
    }

    const cardMsg = {
      id: `profile-card-${Date.now()}`,
      sender: petName || "团团",
      avatar: chiefAvatar,
      content: "帮你整理了一张档案卡，看看有没有需要改的地方～",
      groupId: "job",
      timestamp: new Date().toISOString(),
      isBot: true,
      isChiefBot: true,
      type: "profile_card",
      profileData,
    };
    allMessages.push(cardMsg);
    io.emit("receive_message", cardMsg);
    console.log("[phase] emitted profile_card");
  }
}


async function handleSelectedJobsWorkflow(
  io: Server,
  allMessages: any[],
  userMsg: string,
  petName: string,
  petPersonality: string
) {
  if (!looksLikeJobSelection(userMsg)) return false;
  const selectedIndices = parseSelectionIndices(userMsg);
  if (!selectedIndices.length) return false;

  const recentResults = loadLastSearchResults();
  if (!recentResults.length) return false;

  const selectedRows = recentResults.filter((row) => selectedIndices.includes(row.index));
  if (!selectedRows.length) return false;

  const chiefAvatar = `https://api.dicebear.com/7.x/adventurer/svg?seed=${encodeURIComponent(petName)}`;
  for (const row of selectedRows) {
    upsertCollaborationRow({
      company: row.company,
      role: row.role,
      jdUrl: row.jdUrl,
      source: row.source,
      salary: row.salary,
      location: row.location,
      workflowStage: "selected",
      applicationStatus: "pending",
      notes: "用户已选中该岗位，进入 tailor 流程。",
    });
  }

  emitBotMessage(io, allMessages, {
    sender: petName,
    avatar: chiefAvatar,
    content: `${petName}：收到，你选了 ${selectedRows.map((row) => `${row.company} - ${row.role}`).join("、")}。\n我先让专业老师拆 JD 重点，再让简历专家按岗位顺序定制简历。`,
    groupId: "job",
    isChiefBot: true,
  });
  const selectedBoardText = renderCollaborationBoardChatTable(
    loadCollaborationBoard().filter((row) => selectedRows.some((selected) => buildBoardRowId(selected) === row.id)),
    "这些岗位已经进入协作推进"
  );
  if (selectedBoardText) {
    emitBotMessage(io, allMessages, {
      sender: petName,
      avatar: chiefAvatar,
      content: selectedBoardText,
      groupId: "job",
      isChiefBot: true,
    });
  }

  const professionalTeacher = JOB_AGENTS.find(a => a.id === "professional-teacher")!;
  const resumeExpert = JOB_AGENTS.find(a => a.id === "resume-expert")!;

  for (const row of selectedRows) {
    const companySlug = row.company.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "") || "company";
    const boardTarget = JSON.stringify({
      company: row.company,
      role: row.role,
      jdUrl: row.jdUrl || "",
    });
    const skillUpdate = JSON.stringify({
      company: row.company,
      role: row.role,
      jdUrl: row.jdUrl || "",
      skillHighlights: "一句话写清要强调的技能点",
    });
    const resumeUpdate = JSON.stringify({
      company: row.company,
      role: row.role,
      jdUrl: row.jdUrl || "",
      resumeVersion: `v2.1-${companySlug}`,
      notes: "tailor 初稿已完成",
    });
    upsertCollaborationRow({
      company: row.company,
      role: row.role,
      jdUrl: row.jdUrl,
      workflowStage: "tailoring",
    });

    // 先通过 Electron BrowserWindow 抓取 JD 正文
    let jdContent = "";
    if (row.jdUrl) {
      emitBotMessage(io, allMessages, {
        sender: professionalTeacher.name,
        avatar: professionalTeacher.avatar || `https://api.dicebear.com/7.x/adventurer/svg?seed=${professionalTeacher.id}`,
        content: `正在抓取 ${row.company} - ${row.role} 的 JD 详情...`,
        groupId: "job",
        isChiefBot: false,
      });
      jdContent = await fetchJdContent(row.jdUrl);
    }
    const jdSection = jdContent
      ? `\n\n【JD 正文】\n${jdContent.slice(0, 3000)}`
      : "\n\n（未能抓取到 JD 正文，请根据岗位名称和公司信息做分析）";

    io.emit("agent_thinking", { agentName: professionalTeacher.name, groupId: "job" });
    await runAgentChain(
      professionalTeacher,
      [{
        role: "user",
        content: `【来自${petName}的任务】
现在开始针对具体岗位做 JD 定位分析。
公司：${row.company}
岗位：${row.role}
链接：${row.jdUrl || "无"}
地点：${row.location || "未知"}
薪资：${row.salary || "未知"}
${jdSection}

协作表格目标行：${boardTarget}

请输出：
1. 这个岗位最该强调的 3 个技能点
2. 用户现有背景里最该前置的经历
3. 一句简短结论

最后必须追加一行 BOARD_UPDATE::${skillUpdate}`
      }],
      0,
      io,
      "job",
      allMessages,
      petName,
      petPersonality
    );
    io.emit("agent_done", { groupId: "job" });

    io.emit("agent_thinking", { agentName: resumeExpert.name, groupId: "job" });
    await runAgentChain(
      resumeExpert,
      [{
        role: "user",
        content: `【来自${petName}的任务】
现在针对这个岗位做一版定制简历方案。
公司：${row.company}
岗位：${row.role}
链接：${row.jdUrl || "无"}

协作表格目标行：${boardTarget}

请读取协作投递表格中这个岗位行的 skillHighlights，再结合 resume_master.md 和 skills_gap.md，给出：
1. 简历该怎么重排
2. 该补哪些关键词
3. 这版简历的版本号（格式如 v2.1-${companySlug}）

最后必须追加一行 BOARD_UPDATE::${resumeUpdate}`
      }],
      0,
      io,
      "job",
      allMessages,
      petName,
      petPersonality
    );
    io.emit("agent_done", { groupId: "job" });

    const latest = loadCollaborationBoard().find((item) => item.id === buildBoardRowId({ company: row.company, role: row.role, jdUrl: row.jdUrl }));
    upsertCollaborationRow({
      company: row.company,
      role: row.role,
      jdUrl: row.jdUrl,
      workflowStage: latest?.skillHighlights && latest?.resumeVersion ? "apply_ready" : "tailoring",
    });
  }

  const tailoredRows = loadCollaborationBoard().filter((row) =>
    selectedRows.some((selected) => buildBoardRowId(selected) === row.id)
  );
  pendingWorkflowSelections.set("job", {
    rowIds: tailoredRows.map((row) => row.id),
    timestamp: Date.now(),
  });

  emitBotMessage(io, allMessages, {
    sender: petName,
    avatar: chiefAvatar,
    content: `${petName}：这几份岗位的 tailor 已经推进好了。\n${tailoredRows.map((row) => `- ${row.company} - ${row.role}｜重点：${row.skillHighlights || "待补充"}｜简历：${row.resumeVersion || "待生成"}`).join("\n")}\n\n如果你确认要投，直接回我"确认投递"或"投吧"，我下一步就让投递管家和人脉顾问接上。`,
    groupId: "job",
    isChiefBot: true,
  });
  const tailoredBoardText = renderCollaborationBoardChatTable(tailoredRows, "这几份岗位当前的协作进度");
  if (tailoredBoardText) {
    emitBotMessage(io, allMessages, {
      sender: petName,
      avatar: chiefAvatar,
      content: tailoredBoardText,
      groupId: "job",
      isChiefBot: true,
    });
  }

  return true;
}

async function handleApplyReadyWorkflow(
  io: Server,
  allMessages: any[],
  userMsg: string,
  petName: string,
  petPersonality: string
) {
  if (!/^(确认投递|投吧|投递吧|可以投|开始投|好，投|好 投|投)$/i.test(userMsg.trim())) return false;
  const pending = pendingWorkflowSelections.get("job");
  if (!pending?.rowIds?.length) return false;

  const board = loadCollaborationBoard();
  const targetRows = board.filter((row) => pending.rowIds.includes(row.id));
  if (!targetRows.length) return false;

  pendingWorkflowSelections.delete("job");
  const chiefAvatar = `https://api.dicebear.com/7.x/adventurer/svg?seed=${encodeURIComponent(petName)}`;
  emitBotMessage(io, allMessages, {
    sender: petName,
    avatar: chiefAvatar,
    content: `${petName}：收到，我现在让投递管家按岗位来源分别处理。\n- Boss直聘岗位会直接去打招呼\n- 其他渠道岗位会按正常简历投递来记录和推进\n同时我也会让人脉顾问准备需要的外联草稿。`,
    groupId: "job",
    isChiefBot: true,
  });

  const appTracker = JOB_AGENTS.find((a) => a.id === "app-tracker")!;
  const networker = JOB_AGENTS.find((a) => a.id === "networker")!;
  const profileText = existsSync(PROFILE_FILE) ? readFileSync(PROFILE_FILE, "utf8") : "";
  const shouldRunNetworker = /海外|国外|美国|欧洲|新加坡|remote/i.test(profileText);

  for (const row of targetRows) {
    const applicationChannel = getApplicationChannel(row);
    let applySummary = "";
    let recordSummary = "";
    let nextWorkflowStage: CollaborationRow["workflowStage"] = row.workflowStage || "apply_ready";
    let nextApplicationStatus: CollaborationRow["applicationStatus"] = row.applicationStatus || "pending";

    if (applicationChannel === "boss_chat") {
      try {
        applySummary = await executeTool("apply_job", {
          job_url: row.jdUrl,
          company: row.company,
          title: row.role,
        });
      } catch {}
      if (applySummary.startsWith("[OK]") || applySummary.startsWith("[INFO]")) {
        try {
          recordSummary = await executeTool("record_application", {
            company: row.company,
            role: row.role,
            url: row.jdUrl,
            source: row.source || "boss",
            status: "contact_started",
            timelineAction: "Boss直聘发起沟通",
            notes: `渠道：Boss直聘打招呼；当前阶段仅完成发消息，暂未进入简历投递；简历版本：${row.resumeVersion || "未记录"}`,
          });
        } catch {}
        nextWorkflowStage = "applied";
        nextApplicationStatus = "contact_started";
      } else {
        nextWorkflowStage = "apply_ready";
        nextApplicationStatus = "pending";
      }
    } else {
      try {
        applySummary = await executeTool("apply_job", {
          job_url: row.jdUrl,
          company: row.company,
          title: row.role,
        });
      } catch {}
      if (applySummary.startsWith("[OK]")) {
        try {
          recordSummary = await executeTool("record_application", {
            company: row.company,
            role: row.role,
            url: row.jdUrl,
            source: row.source || "company",
            status: "submitted",
            timelineAction: "官网自动提交",
            notes: `渠道：官网/ATS 自动填写并提交；简历版本：${row.resumeVersion || "未记录"}`,
          });
        } catch {}
        nextWorkflowStage = "applied";
        nextApplicationStatus = "submitted";
      } else {
        nextWorkflowStage = "apply_ready";
        nextApplicationStatus = "pending";
      }
    }

    syncApplicationsToCollaborationBoard();
    upsertCollaborationRow({
      id: row.id,
      company: row.company,
      role: row.role,
      jdUrl: row.jdUrl,
      workflowStage: nextWorkflowStage,
      applicationStatus: nextApplicationStatus,
      notes: [row.notes, `渠道：${applicationChannel === "boss_chat" ? "Boss直聘打招呼" : "简历投递"}`, recordSummary, applySummary].filter(Boolean).join(" | "),
    });

    io.emit("agent_thinking", { agentName: appTracker.name, groupId: "job" });
    await runAgentChain(
      appTracker,
      [{
        role: "user",
        content: `【来自${petName}的任务】
用户已确认投递这个岗位，请汇报当前投递状态并提醒 follow-up 节点。
公司：${row.company}
岗位：${row.role}
链接：${row.jdUrl || "无"}
简历版本：${row.resumeVersion || "未记录"}
投递渠道：${applicationChannel === "boss_chat" ? "Boss直聘打招呼（不需要单独上传简历）" : "普通简历投递"}
系统执行结果：${[recordSummary, applySummary].filter(Boolean).join("；") || "已记录，等待你汇报"}

如果是 Boss直聘，就明确告诉用户这是"已打招呼/已发起沟通"，不要说成"还需要手动投简历"。
如果不是 Boss直聘，要明确告诉用户：当前还没有自动代投，仍然处于待用户手动投递状态，不要说成"已经投递成功"。`
      }],
      0,
      io,
      "job",
      allMessages,
      petName,
      petPersonality
    );
    io.emit("agent_done", { groupId: "job" });

    if (shouldRunNetworker) {
      io.emit("agent_thinking", { agentName: networker.name, groupId: "job" });
      await runAgentChain(
        networker,
        [{
          role: "user",
          content: `【来自${petName}的任务】
用户已确认投递这个岗位，请为这个岗位找 1-2 个潜在联系人并起草一版冷邮件草稿。
公司：${row.company}
岗位：${row.role}
链接：${row.jdUrl || "无"}
简历版本：${row.resumeVersion || "未记录"}
投递渠道：${applicationChannel === "boss_chat" ? "Boss直聘打招呼" : "普通简历投递"}

如果生成了联系人或草稿，请按系统要求写入协作表。`
        }],
        0,
        io,
        "job",
        allMessages,
        petName,
        petPersonality
      );
      io.emit("agent_done", { groupId: "job" });
    }
  }

  const latestRows = loadCollaborationBoard().filter((row) => targetRows.some((target) => target.id === row.id));
  emitBotMessage(io, allMessages, {
    sender: petName,
    avatar: chiefAvatar,
    content: `${petName}：这批岗位已经进入投递阶段啦。\n${latestRows.map((row) => `- ${row.company} - ${row.role}｜状态：${row.applicationStatus === "contact_started" ? "已发起沟通" : row.applicationStatus}｜跟进：${row.followUpDate || "待同步"}｜外联：${row.outreachStatus || "未开始"}`).join("\n")}`,
    groupId: "job",
    isChiefBot: true,
  });
  const appliedBoardText = renderCollaborationBoardChatTable(latestRows, "投递后的协作进度表");
  if (appliedBoardText) {
    emitBotMessage(io, allMessages, {
      sender: petName,
      avatar: chiefAvatar,
      content: appliedBoardText,
      groupId: "job",
      isChiefBot: true,
    });
  }

  return true;
}

async function handlePipelineSignalWorkflow(
  io: Server,
  allMessages: any[],
  userMsg: string,
  petName: string,
  petPersonality: string
) {
  const signal = detectPipelineSignal(userMsg);
  if (!signal) return false;

  const matchedRows = findBoardRowsFromText(userMsg);
  if (!matchedRows.length) return false;
  const chiefAvatar = `https://api.dicebear.com/7.x/adventurer/svg?seed=${encodeURIComponent(petName)}`;

  if (signal === "interview") {
    for (const row of matchedRows) {
      upsertCollaborationRow({
        id: row.id,
        company: row.company,
        role: row.role,
        jdUrl: row.jdUrl,
        applicationStatus: "interview",
        notes: [row.notes, "用户/系统反馈：已收到面试邀请。"].filter(Boolean).join(" | "),
      });
      updateApplicationStatusFiles(row, "interview");
    }
    emitBotMessage(io, allMessages, {
      sender: petName,
      avatar: chiefAvatar,
      content: `${petName}：太棒了！！！真的收到面试邀请了 🎉\n${matchedRows.map((row) => `- ${row.company} - ${row.role}`).join("\n")}\n我先替你开心一下，然后马上叫面试教练来给你准备。`,
      groupId: "job",
      isChiefBot: true,
    });

    const interviewCoach = JOB_AGENTS.find((a) => a.id === "interview-coach")!;
    for (const row of matchedRows) {
      io.emit("agent_thinking", { agentName: interviewCoach.name, groupId: "job" });
      await runAgentChain(
        interviewCoach,
        [{
          role: "user",
          content: `【来自${petName}的任务】
用户已经拿到面试邀请，请根据这个岗位开始准备模拟面试。
公司：${row.company}
岗位：${row.role}
链接：${row.jdUrl || "无"}
投递时简历版本：${row.resumeVersion || "未记录"}
技能重点：${row.skillHighlights || "未记录"}

请输出：
1. 4-6 个定制面试题
2. 重点考察能力
3. 准备建议

最后必须追加一行 BOARD_UPDATE::${JSON.stringify({
  company: row.company,
  role: row.role,
  jdUrl: row.jdUrl || "",
  interviewRecord: {
    notes: "面试准备已启动",
  },
})}`
        }],
        0,
        io,
        "job",
        allMessages,
        petName,
        petPersonality
      );
      io.emit("agent_done", { groupId: "job" });
    }
    return true;
  }

  if (signal === "offer") {
    for (const row of matchedRows) {
      upsertCollaborationRow({
        id: row.id,
        company: row.company,
        role: row.role,
        jdUrl: row.jdUrl,
        applicationStatus: "offer",
        notes: [row.notes, "用户/系统反馈：已拿到 offer。"].filter(Boolean).join(" | "),
      });
      updateApplicationStatusFiles(row, "offer");
    }
    emitBotMessage(io, allMessages, {
      sender: petName,
      avatar: chiefAvatar,
      content: `${petName}：这也太厉害了吧！！！offer 来了 🎉\n${matchedRows.map((row) => `- ${row.company} - ${row.role}`).join("\n")}\n先好好开心一下，我们后面再一起看怎么做选择。`,
      groupId: "job",
      isChiefBot: true,
    });
    return true;
  }

  if (signal === "rejected") {
    for (const row of matchedRows) {
      upsertCollaborationRow({
        id: row.id,
        company: row.company,
        role: row.role,
        jdUrl: row.jdUrl,
        applicationStatus: "rejected",
        notes: [row.notes, "用户/系统反馈：收到拒信或流程终止。"].filter(Boolean).join(" | "),
      });
      updateApplicationStatusFiles(row, "rejected");
    }
    emitBotMessage(io, allMessages, {
      sender: petName,
      avatar: chiefAvatar,
      content: `${petName}：看到了，这次没成确实会难受一下。但这不代表你不行，只是这一条线先关掉了。\n${matchedRows.map((row) => `- ${row.company} - ${row.role}`).join("\n")}\n我会把状态记好，我们继续推进别的机会。`,
      groupId: "job",
      isChiefBot: true,
    });
    return true;
  }

  return false;
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
  // 静态头像文件
  const avatarsDir = path.join(process.env.PAWPALS_APP_UNPACKED_ROOT || process.env.PAWPALS_APP_ROOT || process.cwd(), "resources", "avatars");
  app.use("/avatars", express.static(avatarsDir));
  syncJobsToCollaborationBoard();
  syncApplicationsToCollaborationBoard();
  syncContactsToCollaborationBoard();

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

  // ── 宠物档案持久化 ──────────────────────────────────────────────────
  app.get("/api/pet", (_req: any, res: any) => {
    if (existsSync(PET_FILE)) {
      try { return res.json(JSON.parse(readFileSync(PET_FILE, "utf-8"))); } catch {}
    }
    res.json(null);
  });
  app.post("/api/pet", (req: any, res: any) => {
    try {
      writeFileSync(PET_FILE, JSON.stringify(req.body, null, 2), "utf-8");
      res.json({ ok: true });
    } catch (e: any) {
      res.status(500).json({ ok: false, error: e.message });
    }
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
      res.json({ ok: true, path: dest, message: "备份成功 [OK]" });
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

  // 从文件加载历史消息，没有则用默认欢迎消息（求职群不预置消息，由 wake_job_session 动态触发）
  const defaultMessages = [
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

    // 清空聊天记录（前端设置页调用）
    socket.on("clear_messages", () => {
      messages.splice(0, messages.length);
      saveMessages(messages);
      io.emit("init_messages", messages);
      console.log("[PawPals] 聊天记录已清空");
    });

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

    let jobSessionGreeted = false; // 每次 socket 连接最多在求职群打一次招呼
    socket.on("wake_job_session", async ({ petName, petPersonality, userNickname }: { petName?: string; petPersonality?: string; userNickname?: string }) => {
      if (jobSessionGreeted) return;
      jobSessionGreeted = true;
      const savedPet = loadPetRuntimeProfile();
      const chiefName = petName || savedPet.name;
      const userName = userNickname || "主人";
      const hasJobHistory = messages.some(m => m.groupId === "job");

      // 有历史记录时不主动打招呼，安静等用户开口
      if (hasJobHistory) return;
      const chiefAgent = {
        id: "career-planner",
        role: "首席伴学官",
        name: chiefName,
        avatar: `https://api.dicebear.com/7.x/adventurer/svg?seed=${encodeURIComponent(chiefName)}`,
        isChief: true,
        default: true,
      };

      try {
        await streamAgent(
          chiefAgent,
          [{
            role: "user",
            content: `【求职群亮相】你刚带着 ${userName} 进入求职群，这是第一次群里亮相。
请你用 1-2 句话完成开场：
1. 用 ${chiefName} 自称
2. 说明你是 ${userName} 的首席伴学官
3. 说明接下来会带着大家一起建档、定位、改简历、搜岗和投递
不要让用户发简历，那个留到最后一句再说。不要调用任何工具，不要派任专家。`
          }],
          0,
          io,
          "job",
          messages,
          chiefName,
          petPersonality,
          "【求职群开场】你现在只负责群聊亮相。不要暴露内部流程，不要调用工具，不要派任专家。"
        );

        const introOrder = [
          "job-hunter",
          "professional-teacher",
          "resume-expert",
          "app-tracker",
          "networker",
          "interview-coach",
        ];
        for (const agentId of introOrder) {
          const agent = JOB_AGENTS.find((item) => item.id === agentId);
          if (!agent) continue;
          await streamAgent(
            agent,
            [{
              role: "user",
              content: `【求职群亮相】你正在第一次和 ${userName} 见面。
请只用 1 句话做自我介绍：
1. 说清你是谁
2. 说清你负责什么
3. 语气自然，不要模板，不要列表
不要调用工具，不要分析用户，不要派任其他专家。`
            }],
            0,
            io,
            "job",
            messages,
            chiefName,
            petPersonality,
            "【求职群亮相】这里只做一句自我介绍。不要调用工具，不要派任其他专家，不要输出结构化标签。"
          );
          await new Promise((resolve) => setTimeout(resolve, 120));
        }

        await streamAgent(
          chiefAgent,
          [{
            role: "user",
            content: `【求职群亮相收尾】团队已经自我介绍完了。
请你自然收尾，并引导 ${userName} 把简历发上来：
1. 1-2 句话
2. 明确说 PDF 或 Word 都可以
3. 语气像在带着大家正式开始，不要重复刚才的介绍，不要派任专家。`
          }],
          0,
          io,
          "job",
          messages,
          chiefName,
          petPersonality,
          "【求职群亮相收尾】这里只负责自然收尾并让用户发简历。不要调用工具，不要派任专家。"
        );
      } catch (e) {
        const chiefAvatar = `https://api.dicebear.com/7.x/adventurer/svg?seed=${encodeURIComponent(chiefName)}`;
        emitBotMessage(io, messages, {
          sender: chiefName,
          avatar: chiefAvatar,
          content: `大家好呀，我是${chiefName}，也是 ${userName} 这次求职路上的首席伴学官。今天我们先把档案建起来，${userName} 把现在的简历直接发给我就行，PDF 或 Word 都可以。`,
          groupId: "job",
          isChiefBot: true,
        });
      }
    });

    let chiefSessionGreeted = false; // 每次 socket 连接最多打一次招呼
    socket.on("wake_chief_session", ({ petName, userNickname }: { petName?: string; userNickname?: string }) => {
      if (chiefSessionGreeted) return; // 本次 session 已经打过招呼了
      chiefSessionGreeted = true;
      const savedPet = loadPetRuntimeProfile();
      const chiefName = petName || savedPet.name;
      const userName = userNickname || "主人";
      const chiefAgent = {
        id: "career-planner",
        role: "首席伴学官",
        name: chiefName,
        avatar: `https://api.dicebear.com/7.x/adventurer/svg?seed=${encodeURIComponent(chiefName)}`,
        isChief: true,
        default: true,
      };
      const hasHistory = messages.some(m => m.groupId === "pixel" && m.isBot);
      const pp = (messages.find(m => m.groupId === "pixel")as any)?.petPersonality || "";
      const personalityLayer = pp
        ? `\n【你的人设（第二层，决定你怎么表达）】\n${pp}\n所有内容都要通过这个人设的语气、措辞、风格来呈现。`
        : "";
      // 读取求职进度上下文
      let progressCtx = "";
      try {
        const chatLog = existsSync(CHAT_LOG) ? readFileSync(CHAT_LOG, "utf8").slice(-1500) : "";
        const profile = existsSync(path.join(CAREER_DIR, "profile.md")) ? readFileSync(path.join(CAREER_DIR, "profile.md"), "utf8").slice(0, 800) : "";
        const apps = existsSync(APPLICATIONS_FILE) ? JSON.parse(readFileSync(APPLICATIONS_FILE, "utf8")) : [];
        if (chatLog || profile || apps.length > 0) {
          progressCtx = `\n\n【求职进度参考（用来说具体的话，不要说模板）】\n`;
          if (profile) progressCtx += `用户档案摘要：${profile.slice(0, 300)}\n`;
          if (apps.length > 0) progressCtx += `已投递 ${apps.length} 个岗位。\n`;
          if (chatLog) progressCtx += `最近对话记录：${chatLog.slice(-600)}`;
        }
      } catch {}

      const startupPrompt = hasHistory
        ? `【每次打开 app 主动打招呼 — 立即执行】
你是 ta 的专属伴学官「${chiefName}」，用户叫「${userName}」。

根据下面的求职进度，说一句有针对性的话（不要说"有什么需要我帮忙的吗"这种模板）：
- 如果有待跟进的岗位，提醒 ta
- 如果有最近搜到的岗位没看，催一下
- 如果进展顺利，夸 ta 然后问下一步怎么打算
- 说完后可以顺势提一个具体行动（比如"要不要今天投一批？"）

1-2句话，自然口语，有个性，不模板。${progressCtx}${personalityLayer}`
        : `【私聊破冰 — 立即执行】
【第一层：行为结构（必须执行）】
用户刚刚给你起了名字「${chiefName}」，这是你们第一次见面。
用户希望你叫 ta「${userName}」。

发一条温暖的私信：
1. 用「${chiefName}」自称，表达收到名字超开心
2. 叫一声「${userName}」，说你会一直陪着 ta，有你在 🐾

结构要求：2-3句话，私聊只聊陪伴，不提求职简历。${personalityLayer}`;

      // 检查模型是否已配置，没配好就不 wake（避免空白气泡）
      const setupState = loadJsonFile<any>(SETUP_STATE_FILE, {});
      if (!setupState.completed) {
        console.log("[wake] skipped: model not configured yet");
        return;
      }

      // 重试逻辑：gateway 可能还未就绪，最多重试 5 次，间隔递增
      const tryWakeChief = async (attempt = 0) => {
        const { reply } = await streamAgent(
          chiefAgent,
          [{ role: "user", content: startupPrompt }],
          0, io, "pixel", messages, chiefName,
        );
        if (!reply && attempt < 5) {
          const delay = [3000, 6000, 10000, 15000, 20000][attempt];
          setTimeout(() => tryWakeChief(attempt + 1), delay);
        }
      };
      setTimeout(() => tryWakeChief(), 250);
    });

    // 档案确认卡：用户点击确认后
    socket.on("profile_confirm", (profileData: any) => {
      const state = loadOnboardingState();
      if (state.phase !== "profile_confirm") return;

      // 用确认后的数据更新 slots
      if (profileData) {
        applyOnboardingSlotPatch(state, profileData);
      }
      state.phase = "professional_positioning";
      persistProfileFromOnboarding(state);
      saveOnboardingState(state, io);

      const petData = loadPetRuntimeProfile();
      const pn = petData?.name || "团团";
      const pp = petData?.personality || "";

      // 档案确认后，让首席自然继续推进（不用状态机调度）
      const careerPlanner = JOB_AGENTS.find(a => a.id === "career-planner")!;
      setTimeout(async () => {
        await runAgentChain(
          { ...careerPlanner, name: pn },
          [{ role: "user", content: "用户已确认档案。请继续按 SOUL.md 推进下一步（专业定位分析）。" }],
          0, io, "job", messages, pn, pp
        );
      }, 500);
    });

    socket.on("send_message", (msg) => {
      const newMessage = { ...msg, id: Date.now().toString(), timestamp: new Date().toISOString() };
      messages.push(newMessage);
      saveMessages(messages);
      io.emit("receive_message", newMessage);

      const savedPet = loadPetRuntimeProfile();
      const pn = msg.petName || savedPet.name;
      const pp = msg.petPersonality || savedPet.personality;

      if (msg.groupId === "pixel") {
        // ── 像素私聊：温暖陪伴，工作话题直接引导去求职群 ──
        const isWorkTopic = /搜.*(岗|工作|实习)|找工作|投递|简历|面试|岗位|offer|招聘|boss直聘/i.test(msg.content);
        if (isWorkTopic) {
          const redirectId = `redirect-${Date.now()}`;
          io.emit("receive_message", {
            id: redirectId, sender: pn,
            avatar: `https://api.dicebear.com/7.x/adventurer/svg?seed=${encodeURIComponent(pn)}`,
            content: `求职的事咱们去群里说吧～ 去「求职汪成长营」找我，专家团队都在那里等你 🐾`,
            groupId: "pixel", timestamp: new Date().toISOString(), isBot: true,
          });
          return;
        }

        const pixelAgent = { id: "career-planner", role: "首席伴学官", name: pn, avatar: `https://api.dicebear.com/7.x/adventurer/svg?seed=${encodeURIComponent(pn)}`, isChief: true, default: true };
        const pixelHistory = messages.filter(m => m.groupId === "pixel").slice(-20).map(m => ({
          role: m.isBot ? "assistant" : "user",
          content: m.content,
        }));
        const privateSystemAddition = "【私聊模式】只做温暖陪伴和情绪支持，绝对不讨论求职/简历/岗位搜索，那些在求职群里进行。";
        setTimeout(async () => {
          await streamAgent(
            pixelAgent,
            [...pixelHistory, { role: "user", content: msg.content }],
            0, io, msg.groupId, messages, pn, pp,
            privateSystemAddition
          );
        }, 400);
      } else if (msg.groupId === "job") {
        // ── 求职群：接入真实 OpenClaw Agents ──
        // career-planner 在求职群里用宠物名显示
        const jobAgentsWithPetName = JOB_AGENTS.map(a =>
          a.id === "career-planner"
            ? { ...a, name: pn, avatar: `https://api.dicebear.com/7.x/adventurer/svg?seed=${encodeURIComponent(pn)}` }
            : a
        );
        const isAtAll = msg.content.includes("@all");
        setTimeout(async () => {
          if (await handleJobOnboarding(io, messages, msg.content, pn, pp, String(msg.attachmentText || ""), String(msg.attachmentName || ""))) {
            io.emit("agent_done", { groupId: msg.groupId });
            return;
          }
          if (await handleSelectedJobsWorkflow(io, messages, msg.content, pn, pp)) {
            io.emit("agent_done", { groupId: msg.groupId });
            return;
          }
          if (await handleApplyReadyWorkflow(io, messages, msg.content, pn, pp)) {
            io.emit("agent_done", { groupId: msg.groupId });
            return;
          }
          if (await handlePipelineSignalWorkflow(io, messages, msg.content, pn, pp)) {
            io.emit("agent_done", { groupId: msg.groupId });
            return;
          }
          if (isAtAll) {
            const thread = [{ role: "user", content: msg.content }];
            for (const agent of jobAgentsWithPetName) {
              io.emit("agent_thinking", { agentName: agent.name, groupId: msg.groupId });
              await runAgentChain(agent, thread, MAX_CHAIN_DEPTH, io, msg.groupId, messages, pn, pp);
              io.emit("agent_done", { groupId: msg.groupId });
            }
          } else {
            const targetAgent = detectTargetAgent(msg.content);
            const resolvedAgent = targetAgent.id === "career-planner"
              ? { ...targetAgent, name: pn, avatar: `https://api.dicebear.com/7.x/adventurer/svg?seed=${encodeURIComponent(pn)}` }
              : targetAgent;
            await runAgentChain(
              resolvedAgent,
              [{ role: "user", content: msg.content }],
              0, io, msg.groupId, messages, pn, pp
            );
            io.emit("agent_done", { groupId: msg.groupId });
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

  app.get("/api/onboarding/status", (_req, res) => {
    const state = loadOnboardingState();
    res.json({
      phase: state.phase,
      completed: state.completed,
      slots: state.slots,
      searchStrategy: state.searchStrategy,
    });
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

  app.get("/api/collaboration-board", (_req: any, res: any) => {
    try {
      syncJobsToCollaborationBoard();
      syncApplicationsToCollaborationBoard();
      syncContactsToCollaborationBoard();
      const rows = loadCollaborationBoard().sort((a, b) => String(b.updatedAt).localeCompare(String(a.updatedAt)));
      res.json({ ok: true, rows });
    } catch (e: any) {
      res.status(500).json({ ok: false, error: e?.message || "无法读取协作投递表格", rows: [] });
    }
  });

  app.get("/api/mail-watcher/status", (_req: any, res: any) => {
    res.json({
      ok: true,
      ...loadMailWatcherState(),
      intervalMs: MAIL_WATCH_INTERVAL_MS,
      enabled: String(process.env.PAWPALS_MAIL_WATCHER_DISABLED || "").toLowerCase() !== "true",
      busy: mailWatcherBusy,
      profileEmail: loadProfileInfo().email || "",
    });
  });

  app.post("/api/mail-watcher/run", async (_req: any, res: any) => {
    const result = await runMailboxWatcher(io, messages);
    res.json(result);
  });

  app.patch("/api/collaboration-board/:id", (req: any, res: any) => {
    try {
      const id = String(req.params?.id || "").trim();
      if (!id) return res.status(400).json({ ok: false, error: "缺少岗位 id" });
      const rows = loadCollaborationBoard();
      const existing = rows.find((row) => row.id === id);
      if (!existing) return res.status(404).json({ ok: false, error: "未找到岗位记录" });

      const patch = req.body || {};
      const next = upsertCollaborationRow({
        id,
        company: existing.company,
        role: existing.role,
        jdUrl: existing.jdUrl,
        workflowStage: typeof patch.workflowStage === "string" ? patch.workflowStage : existing.workflowStage,
        applicationStatus: typeof patch.applicationStatus === "string" ? patch.applicationStatus : existing.applicationStatus,
        resumeVersion: typeof patch.resumeVersion === "string" ? patch.resumeVersion : existing.resumeVersion,
        followUpDate: typeof patch.followUpDate === "string" ? patch.followUpDate : existing.followUpDate,
        skillHighlights: typeof patch.skillHighlights === "string" ? patch.skillHighlights : existing.skillHighlights,
        outreachStatus: typeof patch.outreachStatus === "string" ? patch.outreachStatus : existing.outreachStatus,
        outreachDraft: typeof patch.outreachDraft === "string" ? patch.outreachDraft : existing.outreachDraft,
        notes: typeof patch.notes === "string" ? patch.notes : existing.notes,
        interviewRecord: patch.interviewRecord && typeof patch.interviewRecord === "object" ? patch.interviewRecord : existing.interviewRecord,
      });

      if (["interview", "offer", "rejected"].includes(next.applicationStatus)) {
        updateApplicationStatusFiles(next, next.applicationStatus as "interview" | "offer" | "rejected");
      }
      syncApplicationsToCollaborationBoard();
      res.json({ ok: true, row: next });
    } catch (e: any) {
      res.status(500).json({ ok: false, error: e?.message || "保存失败" });
    }
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
      exec(`pgrep -x openclaw-gateway | xargs kill -TERM 2>/dev/null || lsof -ti :${gatewayPort} | head -1 | xargs kill -TERM 2>/dev/null || true`, () => {});

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
      exec(`pgrep -x openclaw-gateway | xargs kill -TERM 2>/dev/null || lsof -ti :${gatewayPort} | head -1 | xargs kill -TERM 2>/dev/null || true`, () => {});

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

  // ── 自动投递队列 & 搜索队列（已提升到模块顶层，此处仅保留注释）──

  app.get("/api/internal/browser-search-task", (_req: any, res: any) => {
    const entry = pendingSearchQueue.entries().next().value;
    if (!entry) return res.json({ task: null });
    const [id, { query, city, cookieFile }] = entry;
    res.json({ task: { id, query, city, careerDir: CAREER_DIR, cookieFile } });
  });

  app.post("/api/internal/browser-search-done", (req: any, res: any) => {
    const { id, result } = req.body || {};
    const pending = pendingSearchQueue.get(id);
    if (pending) {
      pendingSearchQueue.delete(id);
      pending.resolve(result || "未找到相关岗位，请换个关键词试试。");
    }
    res.json({ ok: true });
  });

  // ── JD 内容抓取（Electron BrowserWindow 执行）──────────────────────────
  app.get("/api/internal/browser-jd-task", (_req: any, res: any) => {
    const entry = pendingJdFetchQueue.entries().next().value;
    if (!entry) return res.json({ task: null });
    const [id, { url }] = entry;
    res.json({ task: { id, url } });
  });

  app.post("/api/internal/browser-jd-done", (req: any, res: any) => {
    const { id, result } = req.body || {};
    const pending = pendingJdFetchQueue.get(id);
    if (pending) {
      pendingJdFetchQueue.delete(id);
      pending.resolve(result || "");
    }
    res.json({ ok: true });
  });

  // ── Electron 主进程内部接口（main.mjs 轮询用）──────────────────────────
  // main.mjs 取下一个待执行任务（含 cookie 路径）
  app.get("/api/internal/browser-task", (_req: any, res: any) => {
    const task = pendingApplyQueue.values().next().value;
    if (!task) return res.json({ task: null });
    res.json({ task: { ...task, cookieFile: COOKIE_FILE } });
  });

  // main.mjs 执行完毕回报结果
  app.post("/api/internal/browser-task-done", (req: any, res: any) => {
    const { id, result } = req.body || {};
    if (!id) return res.status(400).json({ ok: false });
    pendingApplyQueue.delete(id);
    applyResultStore.set(id, result || "SUCCESS");
    setTimeout(() => applyResultStore.delete(id), 120000);
    res.json({ ok: true });
  });

  app.post("/api/internal/browser-fill-form", (req: any, res: any) => {
    const { fields, title, company } = req.body || {};
    const profile = extractAutofillProfile();
    const values = (Array.isArray(fields) ? fields : [])
      .map((field: any) => ({
        index: field.index,
        value: pickAutofillValue(field, profile, String(title || ""), String(company || "")),
      }))
      .filter((item: any) => item.value);
    res.json({ ok: true, values });
  });


  // Boss直聘登录：bossLoginPending 已提升到模块顶层
  app.post("/api/boss-login", async (req, res) => {
    res.json({ ok: true });
    bossLoginPending = true;
    bossLoginPlatform = "boss";
    io.emit("receive_message", {
      id: `boss-remind-${Date.now()}`,
      sender: "岗位猎手",
      avatar: "/avatars/job-hunter.jpg",
      content: "🔑 我正在桌面端打开 Boss直聘 登录窗口，请直接扫码或输入账号密码。登录成功后窗口会自动关闭，我这边会自动继续后面的流程 ✨",
      groupId: "job",
      timestamp: new Date().toISOString(),
      isBot: true,
    });
  });

  // Electron main.mjs 轮询：是否有登录任务
  app.get("/api/internal/boss-login-task", (_req: any, res: any) => {
    if (bossLoginPending) {
      res.json({ pending: true, cookieFile: COOKIE_FILE, platform: bossLoginPlatform });
    } else {
      res.json({ pending: false });
    }
  });

  // Electron main.mjs 完成登录后回报
  app.post("/api/internal/boss-login-done", (req: any, res: any) => {
    const { ok, error } = req.body || {};
    bossLoginPending = false;
    io.emit("boss_login_result", { ok });
    if (!ok) console.warn("[boss-login] failed:", error || "unknown error");
    if (ok) {
      const petData = (() => { try { return existsSync(PET_FILE) ? JSON.parse(readFileSync(PET_FILE, "utf8")) : {}; } catch { return {}; } })();
      const pn = petData.name || "团团";
      const pp = petData.personality || "";

      // 检查是否处于 onboarding 的 first_job_search 阶段
      const onboardingState = loadOnboardingState();
      if (onboardingState.phase === "first_job_search" && !onboardingState.completed) {
        // onboarding 流程中登录成功 → 重新触发 first_job_search（这次有 cookie 了）
        const chiefMsgId = `chief-retry-${Date.now()}`;
        const jobHunter = JOB_AGENTS.find(a => a.id === "job-hunter");
        io.emit("receive_message", {
          id: chiefMsgId,
          sender: jobHunter?.name || "岗位猎手",
          avatar: jobHunter?.avatar || "/avatars/job-hunter.jpg",
          content: "登录成功啦，我已经接着在桌面端帮你搜索匹配岗位了。",
          groupId: "job", timestamp: new Date().toISOString(), isBot: true, isChiefBot: false,
        });
        messages.push({
          id: chiefMsgId,
          sender: jobHunter?.name || "岗位猎手",
          avatar: jobHunter?.avatar || "/avatars/job-hunter.jpg",
          content: "登录成功啦，我已经接着在桌面端帮你搜索匹配岗位了。",
          groupId: "job", timestamp: new Date().toISOString(), isBot: true, isChiefBot: false,
        });
        // 登录成功后让首席继续推进
        setTimeout(async () => {
          const cp = JOB_AGENTS.find(a => a.id === "career-planner")!;
          await runAgentChain({ ...cp, name: pn }, [{ role: "user", content: "Boss直聘登录成功了，请继续帮用户搜索岗位。" }], 0, io, "job", messages, pn, pp);
        }, 500);
      } else {
        const jobHunter = JOB_AGENTS.find(a => a.id === "job-hunter");
        if (jobHunter && pendingResumableSearchTask) {
          const chiefMsgId = `chief-retry-${Date.now()}`;
          io.emit("receive_message", {
            id: chiefMsgId,
            sender: jobHunter.name,
            avatar: jobHunter.avatar,
            content: "登录成功啦，我继续按刚才确认好的条件帮你搜岗位。",
            groupId: "job", timestamp: new Date().toISOString(), isBot: true, isChiefBot: false,
          });
          messages.push({
            id: chiefMsgId,
            sender: jobHunter.name,
            avatar: jobHunter.avatar,
            content: "登录成功啦，我继续按刚才确认好的条件帮你搜岗位。",
            groupId: "job",
            timestamp: new Date().toISOString(),
            isBot: true,
            isChiefBot: false,
          });
          const resumeTask = pendingResumableSearchTask;
          pendingResumableSearchTask = null;
          setTimeout(async () => {
            io.emit("agent_thinking", { agentName: jobHunter.name, groupId: "job" });
            const searchResultText = await executeTool("search_jobs", resumeTask);
            io.emit("agent_done", { groupId: "job" });
            if (searchResultText.includes("NEED_LOGIN")) {
              bossLoginPending = true;
              bossLoginPlatform = "boss";
              pendingResumableSearchTask = resumeTask;
              return;
            }
            emitBotMessage(io, messages, {
              sender: jobHunter.name,
              avatar: jobHunter.avatar,
              content: searchResultText,
              groupId: "job",
              isChiefBot: false,
            });
            emitBotMessage(io, messages, {
              sender: pn,
              avatar: `https://api.dicebear.com/7.x/adventurer/svg?seed=${encodeURIComponent(pn)}`,
              content: `${pn}：你可以直接回我想推进的编号，比如「投 1、3、5」或「先看 2、4」。如果这一批不够对口，也可以直接说你想调整城市、方向、公司类型，或者改成 Boss / 全网 / 混合搜。`,
              groupId: "job",
              isChiefBot: true,
            });
          }, 500);
        }
      }
    } else {
      io.emit("receive_message", {
        id: `boss-login-${Date.now()}`,
        sender: "岗位猎手",
        avatar: "/avatars/job-hunter.jpg",
        content: `❌ 登录失败或超时，请重试（${error || "窗口被关闭"}）`,
        groupId: "job", timestamp: new Date().toISOString(), isBot: true,
      });
    }
    res.json({ ok: true });
  });

  // 保留兼容旧版本的 save-cookies 接口（用于手动 cookie 注入场景）
  app.post("/api/boss-save-cookies", (_req: any, res: any) => res.json({ ok: true, note: "login is now automatic" }));

  // Dashboard: real agents list from openclaw config
  app.get("/api/gw/agents", (_req: any, res: any) => {
    try {
      const config = JSON.parse(readFileSync(OPENCLAW_CONFIG_FILE, "utf8"));
      const agents = (config?.agents?.list || []).filter((a: any) => a.id !== "main");
      res.json({ agents });
    } catch {
      res.json({ agents: [] });
    }
  });

  // Dashboard: cron jobs from openclaw cron state
  const CRON_FILE = path.join(OPENCLAW_HOME, "cron", "jobs.json");
  const readCronJobs = () => {
    try {
      const raw = JSON.parse(readFileSync(CRON_FILE, "utf8"));
      return (raw?.jobs || []).map((j: any) => ({
        id: j.id,
        name: j.name,
        enabled: j.enabled,
        schedule: j.schedule?.expr || j.schedule || "",
      }));
    } catch { return []; }
  };
  const writeCronJobs = (jobs: any[]) => {
    try {
      const raw = JSON.parse(readFileSync(CRON_FILE, "utf8"));
      raw.jobs = jobs;
      writeFileSync(CRON_FILE, JSON.stringify(raw, null, 2));
    } catch {}
  };

  app.get("/api/gw/cron/jobs", (_req: any, res: any) => res.json(readCronJobs()));

  app.post("/api/gw/cron/toggle", (req: any, res: any) => {
    try {
      const { id, enabled } = req.body;
      const raw = JSON.parse(readFileSync(CRON_FILE, "utf8"));
      const job = (raw?.jobs || []).find((j: any) => j.id === id);
      if (job) { job.enabled = enabled; writeFileSync(CRON_FILE, JSON.stringify(raw, null, 2)); }
      res.json({ ok: true });
    } catch { res.json({ ok: false }); }
  });

  app.delete("/api/gw/cron/jobs/:id", (req: any, res: any) => {
    try {
      const { id } = req.params;
      const raw = JSON.parse(readFileSync(CRON_FILE, "utf8"));
      raw.jobs = (raw?.jobs || []).filter((j: any) => j.id !== id);
      writeFileSync(CRON_FILE, JSON.stringify(raw, null, 2));
      res.json(readCronJobs());
    } catch { res.json([]); }
  });

  app.post("/api/gw/cron/jobs", (req: any, res: any) => {
    try {
      const { name, message, schedule, enabled } = req.body;
      const raw = JSON.parse(readFileSync(CRON_FILE, "utf8"));
      raw.jobs = raw.jobs || [];
      raw.jobs.push({
        id: `pawpals-${Date.now()}`,
        name,
        enabled: enabled !== false,
        createdAtMs: Date.now(),
        updatedAtMs: Date.now(),
        schedule: { kind: "cron", expr: schedule, tz: "Asia/Shanghai" },
        sessionTarget: "isolated",
        wakeMode: "now",
        payload: { kind: "agentTurn", message },
        delivery: { mode: "announce", channel: "feishu", to: "chat:oc_db61de856d9dd58df095f46c044c2231", accountId: "job-hunter" },
        state: {},
      });
      writeFileSync(CRON_FILE, JSON.stringify(raw, null, 2));
      res.json(readCronJobs());
    } catch { res.json([]); }
  });

  // Dashboard: usage history — reads from openclaw session JSONL files directly
  app.get("/api/gw/usage/recent-token-history", (_req: any, res: any) => {
    try {
      const agentsDir = path.join(OPENCLAW_HOME, "agents");
      const results: any[] = [];
      if (!existsSync(agentsDir)) return res.json([]);
      for (const agentId of readdirSync(agentsDir)) {
        const sessionsDir = path.join(agentsDir, agentId, "sessions");
        if (!existsSync(sessionsDir)) continue;
        for (const fname of readdirSync(sessionsDir)) {
          if (!fname.endsWith(".jsonl")) continue;
          const fpath = path.join(sessionsDir, fname);
          const lines = readFileSync(fpath, "utf8").split("\n").filter(Boolean);
          for (const line of lines) {
            try {
              const entry = JSON.parse(line);
              if (entry.type !== "message" || entry.message?.role !== "assistant") continue;
              const u = entry.message?.usage;
              if (!u) continue;
              results.push({
                timestamp: entry.timestamp || new Date().toISOString(),
                sessionId: fname.replace(".jsonl", ""),
                agentId,
                model: entry.message?.model || "",
                provider: entry.message?.provider || entry.message?.api || "",
                inputTokens: u.input || 0,
                outputTokens: u.output || 0,
                cacheReadTokens: u.cacheRead || 0,
                cacheWriteTokens: u.cacheWrite || 0,
                totalTokens: u.totalTokens || (u.input || 0) + (u.output || 0),
                costUsd: u.cost?.total || 0,
              });
            } catch { /* skip malformed line */ }
          }
        }
      }
      // Sort by timestamp desc, return last 200 entries
      results.sort((a, b) => new Date(b.timestamp).getTime() - new Date(a.timestamp).getTime());
      res.json(results.slice(0, 200));
    } catch (e: any) { res.json([]); }
  });

  // ── Manage Panel ──────────────────────────────────────────────────────────
  const MANAGE_CONFIG_FILE = path.join(CAREER_DIR, "manage_config.json");
  const MANAGE_UPLOADS_DIR = path.join(CAREER_DIR, "uploads");
  ensureDir(MANAGE_UPLOADS_DIR);

  function readManageConfig() {
    try {
      if (existsSync(MANAGE_CONFIG_FILE)) return JSON.parse(readFileSync(MANAGE_CONFIG_FILE, "utf8"));
    } catch {}
    return { allowedPaths: [] };
  }
  function writeManageConfig(cfg: any) {
    writeFileSync(MANAGE_CONFIG_FILE, JSON.stringify(cfg, null, 2));
  }

  app.get("/api/manage/paths", (_req: any, res: any) => {
    const cfg = readManageConfig();
    res.json({ paths: cfg.allowedPaths || [] });
  });

  app.post("/api/manage/paths", (req: any, res: any) => {
    const { path: newPath } = req.body;
    if (!newPath || typeof newPath !== "string") return res.status(400).json({ error: "path required" });
    const cfg = readManageConfig();
    const paths: string[] = cfg.allowedPaths || [];
    if (!paths.includes(newPath)) paths.push(newPath);
    cfg.allowedPaths = paths;
    writeManageConfig(cfg);
    res.json({ ok: true, paths });
  });

  app.delete("/api/manage/paths", (req: any, res: any) => {
    const { path: rmPath } = req.body;
    const cfg = readManageConfig();
    cfg.allowedPaths = (cfg.allowedPaths || []).filter((p: string) => p !== rmPath);
    writeManageConfig(cfg);
    res.json({ ok: true, paths: cfg.allowedPaths });
  });

  // List uploaded files
  app.get("/api/manage/files", (_req: any, res: any) => {
    try {
      const files = readdirSync(MANAGE_UPLOADS_DIR).map(name => {
        const full = path.join(MANAGE_UPLOADS_DIR, name);
        const s = statSync(full);
        return { name, path: full, size: s.size, mtime: s.mtime.toISOString() };
      });
      res.json({ files });
    } catch {
      res.json({ files: [] });
    }
  });

  // Upload file to workspace uploads dir
  const upload = multer({ dest: MANAGE_UPLOADS_DIR });
  app.post("/api/manage/upload", upload.single("file"), (req: any, res: any) => {
    if (!req.file) return res.status(400).json({ error: "no file" });
    const ext = path.extname(req.file.originalname);
    const destName = req.file.originalname.replace(/[^a-zA-Z0-9.\-_\u4e00-\u9fa5]/g, "_");
    const destPath = path.join(MANAGE_UPLOADS_DIR, destName);
    copyFileSync(req.file.path, destPath);
    // remove multer tmp file
    try { unlinkSync(req.file.path); } catch {}
    res.json({ ok: true, filename: destName, path: destPath });
  });

  // Resume / document upload — saves to inbound dir and parses text server-side
  const INBOUND_DIR = path.join(CAREER_DIR, "media", "inbound");
  ensureDir(INBOUND_DIR);
  const resumeUpload = multer({ dest: os.tmpdir() });
  app.post("/api/upload/resume", resumeUpload.single("file"), async (req: any, res: any) => {
    if (!req.file) return res.status(400).json({ error: "no file" });
    const origName = req.file.originalname;
    const ext = path.extname(origName).toLowerCase();
    const safeName = origName.replace(/[^a-zA-Z0-9.\-_\u4e00-\u9fa5 ()]/g, "_");
    const destPath = path.join(INBOUND_DIR, safeName);
    try { copyFileSync(req.file.path, destPath); } catch {}
    try { unlinkSync(req.file.path); } catch {}

    let text = "";
    try {
      if (ext === ".pdf") {
        // 用 pdfjs-dist（Node.js，不依赖 Python）提取 PDF 文本
        try {
          const pdfjsLib = await import("pdfjs-dist/legacy/build/pdf.mjs");
          const data = new Uint8Array(readFileSync(destPath));
          const doc = await pdfjsLib.getDocument({ data }).promise;
          const pages: string[] = [];
          for (let i = 1; i <= Math.min(doc.numPages, 10); i++) {
            const page = await doc.getPage(i);
            const content = await page.getTextContent();
            const pageText = content.items
              .map((item: any) => item.str || "")
              .join(" ")
              .replace(/\s+/g, " ")
              .trim();
            if (pageText) pages.push(pageText);
          }
          text = pages.join("\n\n");
        } catch (pdfErr) {
          console.warn("pdfjs extraction failed, trying Python fallback:", (pdfErr as any)?.message);
          // Fallback: 尝试 Python（dev 环境可能有）
          try {
            const pyExtract = `
import sys, json
try:
    from pypdf import PdfReader
except ImportError:
    try:
        from PyPDF2 import PdfReader
    except ImportError:
        print(json.dumps({"text": ""})); sys.exit(0)
reader = PdfReader(sys.argv[1])
pages = [page.extract_text() or "" for page in reader.pages]
print(json.dumps({"text": "\\n\\n".join(pages)}))
`;
            const extractResult = await new Promise<string>((resolve) => {
              const py = spawn(PYTHON_BIN, ["-c", pyExtract, destPath]);
              let out = "";
              py.stdout.on("data", (d: Buffer) => { out += d.toString(); });
              py.on("close", () => resolve(out.trim()));
              setTimeout(() => resolve(""), 15000);
            });
            text = JSON.parse(extractResult || "{}").text || "";
          } catch {}
        }
      } else if (ext === ".docx") {
        const mammoth = await import("mammoth");
        const r = await mammoth.extractRawText({ path: destPath });
        text = r.value || "";
      }
    } catch (e) {
      console.error("resume parse error", e);
    }

    res.json({ ok: true, filename: safeName, path: destPath, text });
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
    startMailWatcher(io, messages);
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

  // 每天 9:00 AM（洛杉矶时间）— 岗位猎手搜岗 + 投递管家 follow-up
  schedule.scheduleJob({ hour: 9, minute: 0, tz: "America/Los_Angeles" }, () => {
    proactivePost("job-hunter",
      "执行每日搜岗任务：根据 profile.md 搜索新岗位，去重后推送给用户，让用户选择感兴趣的岗位。",
      "每日早报"
    );
    proactivePost("app-tracker",
      "执行每日 follow-up 检查：读取 applications.json，找出超过 7 天未回复的投递，提醒用户是否要跟进。",
      "每日早报"
    );
  });

  // 每天 10:00 AM（洛杉矶时间）— 专业老师每日学习
  schedule.scheduleJob({ hour: 10, minute: 0, tz: "America/Los_Angeles" }, () => {
    proactivePost("professional-teacher",
      "执行每日行业学习：搜索用户求职方向的最新行业动态（新技术、招聘趋势、目标公司动态），在群里分享 1-2 条有价值的信息。",
      "每日行业简报"
    );
  });

  // 每天 14:00 PM — 专业老师：午间行业速递
  schedule.scheduleJob({ hour: 14, minute: 0, tz: "America/Los_Angeles" }, () => {
    proactivePost("professional-teacher",
      "执行午间行业速递：搜索用户求职方向最新动态，如果发现和用户正在投递的岗位相关的信息（公司新闻、行业变化、面试趋势），主动分享到群里。格式：📰 行业速递｜[标题]：[和用户的关联]",
      "午间行业速递"
    );
  });

  // 每天 15:00 PM — 首席伴学官：主动跟进
  schedule.scheduleJob({ hour: 15, minute: 0, tz: "America/Los_Angeles" }, () => {
    proactivePost("career-planner",
      "主动跟进：检查用户今天有没有新进展，如果超过几个小时没说话，温暖地问一句进展如何。如果有待推进的事项（比如有岗位还没选、有简历还没确认），主动提醒。控制在2-3句。",
      "主动跟进"
    );
  });

  // 每天 18:00 PM — 首席伴学官：每日求职进度简报
  schedule.scheduleJob({ hour: 18, minute: 0, tz: "America/Los_Angeles" }, () => {
    proactivePost("career-planner",
      "生成今日求职进度简报：读取 applications.json 统计投递数/回复率，读取 jobs.json 看今天新增了多少岗位，给出今明两天的行动建议。控制在5行以内。",
      "每日进度简报"
    );
  });

  // 每天 21:00 PM — 专业老师：晚间学习分享
  schedule.scheduleJob({ hour: 21, minute: 0, tz: "America/Los_Angeles" }, () => {
    proactivePost("professional-teacher",
      "执行晚间学习分享：搜索用户求职方向的深度内容（技术博客、面经、行业分析），挑一条最有价值的分享到群里，帮用户积累行业认知。",
      "晚间学习分享"
    );
  });

  console.log("⏰ 定时任务已注册：9AM 搜岗+follow-up | 10AM 行业学习 | 14PM 午间速递 | 15PM 主动跟进 | 18PM 进度简报 | 21PM 晚间分享（洛杉矶时间）");
}

startServer();
