import express from "express";
import { createServer } from "http";
import { Server } from "socket.io";
import dotenv from "dotenv";
import os from "os";
import path from "path";
import { chatCompletion, chatCompletionStream, chatExtractJson, getTokenStats, resetTokenStats } from "./llm.ts";
import { OfficialApplicationQueue, parseRequestedKind } from "./server/official-application-queue.ts";
import { resolveRoute } from "./server/routing.ts";
import { buildFileInjections } from "./server/agent-context.ts";
import { formatLogEntry, renderAgentLog } from "./server/agent-log.ts";
import { stageLabel, type WorkflowStageId } from "./server/workflow.ts";
import { planSoulSeed } from "./server/agent-soul.ts";
import { pickAutofillValue , parseAutofillProfile } from "./server/autofill.ts";
import { planApplicationStep } from "./server/application-flow.ts";
import { boardInstruction } from "./server/job-pipeline.ts";
import { buildAutofillPrompt, validateAutofillPlan } from "./server/autofill-plan.ts";
import { WebSocketServer } from "ws";
import { createTaskBroadcaster, parseClientMessage } from "./server/official-socket.ts";
import { runTailorPipeline, type TailorDeps } from "./server/tailor-pipeline.ts";
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
const WORKSPACE_DIR = path.join(APP_DATA_DIR, "workspace");
const CAREER_DIR = process.env.PAWPALS_WORKSPACE || path.join(WORKSPACE_DIR, "career");
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
const CONFIG_FILE = path.join(APP_DATA_DIR, "pawpals-config.json");
const SETUP_STATE_FILE = path.join(APP_DATA_DIR, "setup-state.json");
const DEPLOYMENT_STATE_FILE = path.join(APP_DATA_DIR, "deployment-state.json");
const DEPLOYMENT_LOG_FILE = path.join(APP_DATA_DIR, "deployment.log");
const PYTHON_BIN = process.env.PAWPALS_PYTHON || process.env.PYTHON ||
  (existsSync("/opt/homebrew/bin/python3") ? "/opt/homebrew/bin/python3" :
   existsSync("/usr/local/bin/python3")    ? "/usr/local/bin/python3" : "python3");

ensureDir(APP_DATA_DIR);
ensureDir(CAREER_DIR);
ensureDir(COOKIE_DIR);

const SECURITY_FILE = path.join(APP_DATA_DIR, "security.json");
const BACKUP_DIR = path.join(os.homedir(), "Documents", "PawPals备份");
const BACKUP_META_FILE = path.join(APP_DATA_DIR, "backup-meta.json");

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
// 通用 browser-fetch 队列：AI 需要浏览网页时通过 Electron BrowserWindow 执行
const pendingBrowserFetchQueue = new Map<string, { url: string; resolve: (r: string) => void }>();
// 官网申请由浏览器扩展消费；提交任务只能由明确确认令牌创建。
const officialApplicationQueue = new OfficialApplicationQueue();
const officialTaskHub = createTaskBroadcaster();

/**
 * 入队并立刻推给已连接的扩展。
 *
 * 推不出去（没有扩展在线）不是错误：任务留在队列里，扩展连上来时由 onConnect
 * 补发。所有 enqueue 都要走这里，否则任务会静静躺在队列里没人知道。
 */
function enqueueOfficialTask(input: Parameters<OfficialApplicationQueue["enqueue"]>[0]) {
  const task = officialApplicationQueue.enqueue(input);
  officialTaskHub.broadcast(task);
  return task;
}
let activeOfficialApplicationPage: { url: string; title: string; provider: string; seenAt: number } | null = null;

async function waitForOfficialTask(taskId: string, timeoutMs = 45_000): Promise<any> {
  const startedAt = Date.now();
  while (Date.now() - startedAt < timeoutMs) {
    const result = officialApplicationQueue.result(taskId);
    if (result) return result;
    await new Promise((resolve) => setTimeout(resolve, 400));
  }
  return { ok: false, error: "等待浏览器扩展超时。请在官网申请页点击 PawPals 图标并保持页面打开。" };
}
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
  officialConfirmationId?: string;
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
function doLocalBackup(appDataDir: string): string {
  const ts = new Date().toISOString().replace(/[:.]/g, "-").slice(0, 16);
  const dest = path.join(BACKUP_DIR, ts);
  mkdirSync(dest, { recursive: true });

  // 备份核心数据文件
  const filesToBackup = [
    path.join(appDataDir, "setup-state.json"),
    path.join(appDataDir, "deployment-state.json"),
    path.join(appDataDir, "security.json"),
    path.join(appDataDir, "pawpals-config.json"),
  ];
  for (const f of filesToBackup) {
    if (existsSync(f)) copyFileSync(f, path.join(dest, path.basename(f)));
  }

  // 备份 workspace（聊天记录、简历草稿等）
  if (existsSync(WORKSPACE_DIR)) _copyDir(WORKSPACE_DIR, path.join(dest, "workspace"));

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
function startAutoBackup(appDataDir: string, notifyIO?: any) {
  ensureDir(BACKUP_DIR);
  schedule.scheduleJob("0 * * * *", () => {
    try {
      const dest = doLocalBackup(appDataDir);
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
    provider: "google",
    model: "gemini-3-flash-preview",
    providerName: "Google Gemini",
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
    case "google":
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

  for (const provider of ["google", "openai"] as const) {
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

function loadPawPalsConfig(): any {
  const rawConfig = loadJsonFile(CONFIG_FILE, {});
  const { config, changed } = applyEnvFallbacks(rawConfig);
  if (changed) {
    saveJsonFile(CONFIG_FILE, config);
  }
  return config;
}

function savePawPalsConfig(config: any) {
  saveJsonFile(CONFIG_FILE, config);
}

function buildSetupState() {
  const config = loadPawPalsConfig();
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
    status: deploymentState.status || "ready",
    phase: deploymentState.phase || "ready",
    deployed: true,
    deployedAt: deploymentState.deployedAt || null,
    updatedAt: deploymentState.updatedAt || null,
    appUrl: deploymentState.appUrl || null,
    appPort: deploymentState.appPort || null,
    appDataDir: APP_DATA_DIR,
    error: deploymentState.error || null,
    logs: tailFile(DEPLOYMENT_LOG_FILE),
  };
}

function saveSetupSelection(provider: string, model: string, options?: { baseUrl?: string }) {
  const config = loadPawPalsConfig();
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
  } else if (provider === "google") {
    // Google Gemini 通过 env key 认证
    config.env.vars.GEMINI_API_KEY ??= "";
    config.env.vars.GOOGLE_API_KEY ??= "";
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

  savePawPalsConfig(config);

  saveJsonFile(SETUP_STATE_FILE, {
    ...loadJsonFile<Record<string, any>>(SETUP_STATE_FILE, {}),
    completed: true,
    selectedProvider: provider,
    selectedModel: model,
    completedAt: new Date().toISOString(),
  });
}

function saveProviderApiKey(provider: string, apiKey: string, options?: { baseUrl?: string; model?: string }) {
  const config = loadPawPalsConfig();

  config.env ??= {};
  config.env.vars ??= {};
  config.models ??= {};
  config.models.providers ??= {};

  if (provider === "anthropic") {
    config.env.vars.ANTHROPIC_API_KEY = apiKey;
  } else if (provider === "google") {
    // Google Gemini 通过 env key 认证
    config.env.vars.GEMINI_API_KEY = apiKey;
    config.env.vars.GOOGLE_API_KEY = apiKey;
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

  savePawPalsConfig(config);

}

const BRAVE_KEY     = process.env.BRAVE_SEARCH_API_KEY || "";
const MAX_CHAIN_DEPTH = 2;
const CHAT_LOG      = path.join(CAREER_DIR, "chat_log.md");
const MESSAGES_FILE = path.join(CAREER_DIR, "pawpals_messages.json");
const RESUME_MASTER_FILE = path.join(CAREER_DIR, "resume_master.md");
const MEMORY_FILE   = path.join(CAREER_DIR, "memory.json");

// ── 长期记忆系统 ────────────────────────────────────────────────────────
type MemoryEntry = { key: string; value: string; source: string; createdAt: string };

function loadMemory(): MemoryEntry[] {
  try {
    if (!existsSync(MEMORY_FILE)) return [];
    return JSON.parse(readFileSync(MEMORY_FILE, "utf-8"));
  } catch { return []; }
}

function saveMemoryEntry(entry: Omit<MemoryEntry, "createdAt">) {
  const memories = loadMemory();
  // 去重：同 key 覆盖
  const idx = memories.findIndex(m => m.key === entry.key);
  const full: MemoryEntry = { ...entry, createdAt: new Date().toISOString() };
  if (idx >= 0) memories[idx] = full; else memories.push(full);
  // 最多保留 50 条
  const trimmed = memories.slice(-50);
  writeFileSync(MEMORY_FILE, JSON.stringify(trimmed, null, 2), "utf-8");
  console.log(`[memory] saved: ${entry.key} = ${entry.value}`);
}

function buildMemoryContext(): string {
  const memories = loadMemory();
  if (memories.length === 0) return "";
  const lines = memories.map(m => `- ${m.key}：${m.value}`).join("\n");
  return `\n【用户长期记忆（历史对话中积累的偏好和信息）】\n${lines}\n`;
}

function extractMemoryUpdates(agentReply: string): void {
  const regex = /MEMORY_UPDATE::\{([^}]+)\}/g;
  let match;
  while ((match = regex.exec(agentReply)) !== null) {
    try {
      const parsed = JSON.parse(`{${match[1]}}`);
      if (parsed.key && parsed.value) {
        saveMemoryEntry({ key: parsed.key, value: parsed.value, source: "agent" });
      }
    } catch {}
  }
}
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
  workflowStage: WorkflowStageId;
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
    "";
  const fallbackQuery = `${fallbackQueryBase}${/实习/.test(input.jobType || "") && !/实习/.test(fallbackQueryBase) ? " 实习" : ""}`.trim();

  let query = fallbackQuery;
  let city = fallbackCity;

  try {
    const parsed = await chatExtractJson<{ query?: string; city?: string; companyFilter?: string }>(
      `你是招聘平台搜索关键词生成器。根据用户档案和当前意图，生成精准的搜索词和筛选条件。
返回 JSON：{"query":"搜索关键词（4-15字，只放岗位核心词，如 AI产品经理 实习）","city":"城市名（北京/上海/广州/深圳/杭州/成都，默认北京）","companyFilter":"公司筛选偏好（如 大厂/创业/外企/不限）"}
规则：
1. query 只放岗位方向+类型，不要放公司偏好（大厂/创业等是筛选条件不是搜索词）
2. 优先使用用户明确目标方向，不要泛化
3. 如果是实习岗位，query 里保留"实习"
4. companyFilter 用于搜索后过滤结果
5. 只返回 JSON，不要解释。`,
      `用户档案：\n${(input.profileText || "（无档案）").slice(0, 1800)}\n\n当前意图：${input.userMessage || "开始搜索岗位"}\n\n显式目标方向：${input.fallbackRole || "无"}\n推断相关方向：${(input.inferredRoles || []).join(" / ") || "无"}\n求职类型：${input.jobType || "未说明"}\n目标城市：${input.targetCity || "未说明"}\n公司偏好：${input.companyPreference || "未说明"}`,
      { max_tokens: 120, signal: AbortSignal.timeout(30000) }
    );
    if (parsed) {
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

/**
 * 档案与简历的**原文**，供大模型取值时引用来源。
 *
 * extractAutofillProfile 抽的是解析好的五个字段；模型需要的是原文——它要能
 * 从里面逐字引出 source，validateAutofillPlan 才验得了。截断是为了不撑爆单条
 * prompt 的上下文。
 */
function readAutofillProfileText(limit = 6000): string {
  const readIfExists = (file: string) => {
    try {
      return existsSync(file) ? readFileSync(file, "utf8") : "";
    } catch {
      return "";
    }
  };
  return `${readIfExists(PROFILE_FILE)}\n\n${readIfExists(RESUME_MASTER_FILE)}`.trim().slice(0, limit);
}

function extractAutofillProfile() {
  return parseAutofillProfile(readAutofillProfileText());
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
  // 只有 profile.md 有实质内容时才认为 onboarding 已完成
  if (existsSync(PROFILE_FILE)) {
    try {
      const content = readFileSync(PROFILE_FILE, "utf8").trim();
      if (content.length > 50) {
        return {
          ...createDefaultOnboardingState(),
          phase: "completed",
          currentStep: null,
          completed: true,
          resumeUploaded: existsSync(RESUME_MASTER_FILE),
        };
      }
    } catch {}
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

    if (state.phase === "professional_positioning" || state.phase === "resume_diagnosis" || state.phase === "search_strategy" || state.phase === "first_job_search" || state.phase === "first_application" || state.phase === "completed") {
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
    const parsed = await chatExtractJson<OnboardingSlotPatch>(
      `你是求职建档信息抽取器。当前步骤是 ${state.currentStep}。
从用户自然语言里提取本步骤相关字段，返回 JSON。
只允许返回这些键：targetRole, market, jobType, timeRange, returnOfferPreference, targetCity, roleScope, companyPreference, traits, skills。
skills 必须是字符串数组。无法确定就返回空对象 {}。不要输出解释。`,
      `已知档案：${JSON.stringify(state.slots, null, 2)}\n\n用户回答：${trimmed}`,
      { max_tokens: 220, signal: AbortSignal.timeout(12000) }
    );
    if (!parsed) return heuristic;
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
      `| ${row.company || "-"} | ${row.role || "-"} | ${stageLabel(row.workflowStage)} | ${formatApplicationStatusLabel(row.applicationStatus)} | ${row.resumeVersion || "-"} |`
    );
  }
  return lines.join("\n");
}


// ── 多 Agent 工作区文件加载 ─────────────────────────────────────
// 每个 Agent 的 SOUL.md 存储在 career/workspaces/<agentId>/SOUL.md
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

function appendChatLog(agent: { id: string; name: string }, userMsg: string, replySnippet: string) {
  try {
    const now = new Date().toLocaleDateString("zh-CN", {
      year: "numeric", month: "2-digit", day: "2-digit",
      hour: "2-digit", minute: "2-digit", hour12: false,
    }).replace(/\//g, "-");
    appendFileSync(CHAT_LOG, formatLogEntry({
      at: now,
      agentName: agent.name,
      agentId: agent.id,
      userMsg,
      reply: replySnippet,
    }), "utf-8");
  } catch {}
}

// ── Reflection 层：reviewer 给专家产出打分，结果落 reviews.jsonl ─────────────
const REVIEWED_AGENTS = new Set(["resume-expert", "interview-coach", "professional-teacher"]);
const REFLECTION_ENABLED = process.env.PAWPALS_REFLECTION_ENABLED !== "false";
const PROJECT_ROOT = process.env.PAWPALS_APP_UNPACKED_ROOT || process.env.PAWPALS_APP_ROOT || process.cwd();
const RUBRICS_DIR = path.join(PROJECT_ROOT, "evals", "rubrics");
const REVIEWS_FILE = path.join(CAREER_DIR, "reviews.jsonl");

type ReviewResult = {
  passed: boolean;
  score: number;
  rubric: Record<string, number>;
  issues: string[];
};

async function runReviewer(
  agentId: string,
  agentReply: string,
  userMsg: string
): Promise<ReviewResult | null> {
  if (!REFLECTION_ENABLED || !REVIEWED_AGENTS.has(agentId)) return null;
  let rubric = "";
  try {
    rubric = readFileSync(path.join(RUBRICS_DIR, `${agentId}.md`), "utf8");
  } catch {
    return null;
  }
  let profileCtx = "";
  try { profileCtx = readFileSync(path.join(CAREER_DIR, "profile.md"), "utf8").slice(0, 1500); } catch {}

  const sys = `你是质检员，严格按 rubric 给 agent 回复打分。只输出 JSON，不要任何其他文字。

【Rubric】
${rubric}

打分要求：
- rubric 每项给 0 或 1
- score = 命中项 / 总项数
- passed = score >= 0.75
- issues 写明哪几项 = 0 以及原因（带 rubric 编号，如 R3）`;

  const user = `【用户档案摘要】
${profileCtx || "（无）"}

【用户原始请求】
${userMsg.slice(0, 1500)}

【agent 回复】
${agentReply.slice(0, 3000)}

只输出 JSON。`;

  try {
    const result = await chatCompletion({
      messages: [
        { role: "system", content: sys },
        { role: "user", content: user },
      ],
      max_tokens: 3000,
      reasoning_effort: "low",
    });
    const raw = (result.content || "").trim()
      .replace(/^```json\s*/i, "").replace(/^```\s*/, "").replace(/```\s*$/, "").trim();
    let parsed: any;
    try { parsed = JSON.parse(raw); }
    catch {
      const start = raw.indexOf("{");
      const end = raw.lastIndexOf("}");
      if (start >= 0 && end > start) {
        try { parsed = JSON.parse(raw.slice(start, end + 1)); } catch {}
      }
    }
    if (!parsed || typeof parsed.score !== "number" || !parsed.rubric) return null;
    return parsed as ReviewResult;
  } catch (e: any) {
    console.warn(`[reviewer] ${agentId} failed:`, e?.message || e);
    return null;
  }
}

function appendReviewLog(payload: {
  agentId: string;
  msgId: string;
  groupId: string;
  review: ReviewResult;
  originalReply: string;
}) {
  try {
    const line = JSON.stringify({
      ts: new Date().toISOString(),
      agentId: payload.agentId,
      msgId: payload.msgId,
      groupId: payload.groupId,
      passed: payload.review.passed,
      score: payload.review.score,
      rubric: payload.review.rubric,
      issues: payload.review.issues,
      reply_preview: payload.originalReply.slice(0, 300),
    }) + "\n";
    appendFileSync(REVIEWS_FILE, line, "utf-8");
  } catch (e: any) {
    console.warn("[reviewer] log failed:", e?.message || e);
  }
}

// ── Eval 中圈：埋点收集 ──────────────────────────────────────────────
const EVENTS_FILE = path.join(CAREER_DIR, "events.jsonl");

type EvalEvent =
  | { type: "agent_response"; agentId: string; msgId: string; groupId: string; replyLength: number; calledApply: boolean }
  | { type: "reviewer"; agentId: string; msgId: string; groupId: string; passed: boolean; score: number; issueCount: number }
  | { type: "tool_call"; agentId?: string; toolName: string; success: boolean; durationMs?: number; errorReason?: string }
  | { type: "user_feedback"; msgId: string; agentId?: string; signal: "thumbs_up" | "thumbs_down"; comment?: string }
  | { type: "routing"; userMsg: string; chosenAgentId: string; route: "explicit_at" | "orchestrate" | "application_delegate" | "default" };

function recordEvalEvent(event: EvalEvent) {
  try {
    const line = JSON.stringify({ ts: new Date().toISOString(), ...event }) + "\n";
    appendFileSync(EVENTS_FILE, line, "utf-8");
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
  "career-planner":  [],
  "job-hunter":      ["search_jobs", "read_jobs", "read_collaboration_board"],
  "app-tracker":     ["apply_job", "record_application", "read_applications", "get_followups", "read_collaboration_board"],
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
      description: "在用户已主动授权的公司官网申请页准备投递：扩展会检查并填写标准字段，最终提交必须由用户在对话中明确确认。Boss直聘链接不可用。",
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
  const __toolStart = Date.now();
  try {
    const __result = await __executeToolInner(name, args);
    recordEvalEvent({
      type: "tool_call",
      toolName: name,
      success: true,
      durationMs: Date.now() - __toolStart,
    });
    return __result;
  } catch (e: any) {
    recordEvalEvent({
      type: "tool_call",
      toolName: name,
      success: false,
      durationMs: Date.now() - __toolStart,
      errorReason: e?.message?.slice(0, 200) || "unknown",
    });
    throw e;
  }
}

async function __executeToolInner(name: string, args: any): Promise<string> {
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
          }, 180000); // 3 分钟超时（需要时间做安全验证+登录）
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
        WORKSPACE_DIR,
        "skills", "tavily-search", "scripts", "tavily_search.py"
      );
      const tavilyKey = process.env.TAVILY_API_KEY || "";

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
      // 新官网代理路径：不再让 AI/Electron 直接提交，先由用户授权的扩展
      // 检查和填写，再交回一次性确认令牌。
      if (isBossJobUrl(job_url)) {
        return "[ERR] 浏览器插件不再支持 Boss直聘自动投递。请改用公司官网申请链接。";
      }
      if (!/^https:\/\//i.test(String(job_url || ""))) {
        return "[ERR] 需要有效的 HTTPS 公司官网申请链接。";
      }
      const inspectTask = enqueueOfficialTask({
        kind: "inspect", url: job_url, company: String(company || ""), title: String(title || ""),
      });
      const inspection = await waitForOfficialTask(inspectTask.id);
      const plan = planApplicationStep(inspection);
      if (plan.action === "abort") return `[ERR] 官网申请页检查失败：${plan.reason}`;

      // 简历还没上传就先停：很多站点解析简历后会把结果覆盖到表单上，
      // 这一步先填等于白填，还会让「已填写 N 个字段」变成谎报。
      if (plan.action === "await_resume_upload") {
        return `这个页面需要先上传简历附件——浏览器不允许脚本代选文件，而且不少网站会用解析结果覆盖已填内容。\n\n请你在页面上手动选好简历文件，完成后再跟我说一次「投递」，我再把其余字段填好并帮你核对解析结果。`;
      }

      const fields = plan.fields;
      const fillCtx = { title: String(title || ""), company: String(company || "") };
      const profileText = readAutofillProfileText();

      // 先让模型按 label 取值——国内校招表单的字段（学历、专业、期望薪资）
      // 在扩展侧几乎全被判成 custom，正则路径一个都填不了。模型给的每一项都
      // 要过 validateAutofillPlan 的四道机械校验，其中 source 必须能在档案原文
      // 里逐字找到，编造的值进不来。
      let values: Array<{ signature: string; value: string }> = [];
      let rejected: Array<{ signature: string; reason: string }> = [];
      if (profileText) {
        try {
          const raw = await chatExtractJson<{ values?: unknown }>(
            "你是网申表单填写助手。只做映射，不做创作。只输出 JSON。",
            buildAutofillPrompt({ fields, profileText, ctx: fillCtx }),
            // 纯映射任务不需要推理。推理 token 会算进 max_tokens，字段一多就把
            // 预算吃光、content 返回空（真机上 8 个字段时就这样）。
            { max_tokens: 4000, reasoning_effort: "minimal" }
          );
          ({ values, rejected } = validateAutofillPlan(raw?.values, fields, profileText));
        } catch (error) {
          console.warn("[autofill] LLM 取值失败，回退到确定性映射:", error);
        }
      }

      // 兜底：模型不可用、或一项都没通过校验时，仍按 kind 把已知字段填上。
      // 宁可少填几个框，也不能因为一次 LLM 故障就整个投递流程停摆。
      if (values.length === 0) {
        const profile = extractAutofillProfile();
        values = fields
          .filter((field: any) => !["resume", "verification", "sensitive_demographic", "custom"].includes(field.kind))
          .map((field: any) => ({ signature: field.signature, value: pickAutofillValue(field, profile, fillCtx) }))
          .filter((item: any) => item.value);
      }
      let filledCount = 0;
      let skippedCount = 0;
      if (values.length) {
        const fillTask = enqueueOfficialTask({
          kind: "fill", url: job_url, company: String(company || ""), title: String(title || ""), payload: { values },
        });
        const filled = await waitForOfficialTask(fillTask.id);
        if (!filled?.ok) return `[ERR] 官网表单填写失败：${filled?.error || "未知错误"}`;
        // 报实际填进去的数量，不是尝试数——签名找不到或有歧义的字段会被跳过。
        filledCount = Array.isArray(filled.filled) ? filled.filled.length : 0;
        // skipped：签名没定位到；lost：填进去了但被页面自己的校验清掉了。
        skippedCount = (Array.isArray(filled.skipped) ? filled.skipped.length : 0)
          + (Array.isArray(filled.lost) ? filled.lost.length : 0);
      }

      const confirmationId = officialApplicationQueue.requestConfirmation({
        url: job_url, company: String(company || ""), title: String(title || ""), payload: {},
      });
      const warnings = Array.isArray(inspection.warnings) ? inspection.warnings : [];
      // unsourced / option_not_allowed 说明模型想填但被闸门挡下了，这类字段
      // 页面上是空的，必须让用户知道要手动补，不能沉默。
      const blockedCount = rejected.filter((r) => r.reason === "unsourced" || r.reason === "option_not_allowed").length;
      const notes = [
        `已填写 ${filledCount} 个标准字段`,
        blockedCount ? `${blockedCount} 个字段因档案里查无依据被拦下，需要你手动填` : "",
        skippedCount ? `${skippedCount} 个字段因页面已变化未能定位，需要你手动补` : "",
        warnings.includes("resume_requires_user_file_selection") ? "请先在页面上手动选择简历文件" : "",
      ].filter(Boolean);
      return `[OFFICIAL_CONFIRM:${confirmationId}] ${notes.join("；")}。请检查页面内容，确认无误后再回复“确认投递”。`;

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

// ── 人设投递：把仓库模板里的 SOUL.md 铺到用户工作区 ──────────────────
// loadAgentSoul() 从 CAREER_DIR/workspaces/<id>/SOUL.md 读，模板却在 resources/ 下。
// 两者之间原本靠 bootstrap-pawpals-runtime.mjs 搬运，它的 npm 入口随 openclaw
// 一起被删后就没人调用了，于是 7 份人设从未进过用户工作区。
const SOUL_TEMPLATE_DIR = path.join(PROJECT_ROOT, "resources", "openclaw-template", "workspace", "career", "workspaces");

function seedAgentSouls() {
  const soulPath = (root: string, id: string) => path.join(root, id, "SOUL.md");
  try {
    const plan = planSoulSeed(JOB_AGENTS.map((a) => a.id), {
      templateExists: (id) => existsSync(soulPath(SOUL_TEMPLATE_DIR, id)),
      destExists: (id) => existsSync(soulPath(path.join(CAREER_DIR, "workspaces"), id)),
    });
    if (!plan.length) return;
    for (const { agentId } of plan) {
      const dest = soulPath(path.join(CAREER_DIR, "workspaces"), agentId);
      mkdirSync(path.dirname(dest), { recursive: true });
      copyFileSync(soulPath(SOUL_TEMPLATE_DIR, agentId), dest);
    }
    console.log(`[soul] 已铺设 ${plan.length} 份人设：${plan.map((p) => p.agentId).join(", ")}`);
  } catch (e: any) {
    console.warn("[soul] 铺设失败：", e?.message || e);
  }
}

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
    : ((agent as any).avatar || `/avatars/${agent.id}.jpg`);

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
    agentId: agent.id,
  };
  allMessages.push(placeholder);
  io.emit("receive_message", placeholder);

  // Helper: emit structured tool activity (transparent AI operation log)
  const emitToolActivity = (
    tool: string,
    description: string,
    permission: "workspace" | "network" | "boss" | "official-site",
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
    // ── 从工作区 SOUL.md 加载 Agent 身份 ────────
    const soulMd = loadAgentSoul(agent.id);
    const userCtx = loadAgentUserContext(agent.id);

    // 该 agent 可用的工具列表
    const allowedToolNames = allowedToolNamesOverride ?? (AGENT_TOOLS[agent.id] ?? []);
    const agentTools = TOOLS.filter(t => allowedToolNames.includes(t.function.name));

    const lastUserMsg = [...messages].reverse().find(m => m.role === "user")?.content ?? "";

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
    toolInjections.push(
      ...buildFileInjections(agentCtx.files, (relPath) => {
        try {
          return readFileSync(path.join(CAREER_DIR, relPath), "utf8");
        } catch {
          return null;
        }
      })
    );

    // 协作日志分两段注入：自己的历史 + 队友动态。
    // 笼统取末尾 N 行的话，自己的记录会被队友挤掉——专家花了上下文却读不到
    // 自己上次做了什么。career-planner 例外，它按 AGENT_CONTEXT_CONFIG 整段读。
    if (agent.id !== "career-planner") {
      try {
        toolInjections.push(
          ...renderAgentLog(readFileSync(CHAT_LOG, "utf8"), agent.id, {
            ownEntries: 3,
            teamEntries: 5,
          })
        );
      } catch { /* 日志尚未生成 */ }
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

    // 专业老师/简历专家：仅在用户明确要求分析 JD 且是非 Boss 岗位时才抓取
    // Boss直聘岗位不需要 tailor 简历或分析 JD，直接投递即可

    // search_jobs：关键词触发，用 LLM 从 profile + 用户消息生成搜索关键词
    if (allowedToolNames.includes("search_jobs") &&
        /boss|搜|找工作|岗位|实习|intern|job|职位|帮我搜|重新搜|搜索|产品经理|AI.*经理|请处理|用户原始请求/i.test(userMsgNoMention)) {
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
        let result: string;
        if (pending.officialConfirmationId) {
          emitToolActivity("apply_job", "确认提交官网申请", "official-site", pending.url);
          const task = officialApplicationQueue.confirm(pending.officialConfirmationId);
          if (!task) {
            result = "[ERR] 这次官网申请确认已过期，请重新发起投递。";
          } else {
            const submitted = await waitForOfficialTask(task.id);
            result = submitted?.ok
              ? `[OK] 已向 **${pending.company}** 的「${pending.title}」提交官网申请。`
              : `[ERR] 官网提交失败：${submitted?.error || "请检查页面后重试"}`;
          }
        } else {
          emitToolActivity("apply_job", "准备官网申请", "official-site", pending.url);
          result = await executeTool("apply_job", {
            job_url: pending.url,
            company: pending.company,
            title:   pending.title,
          });
          const match = result.match(/\[OFFICIAL_CONFIRM:([^\]]+)\]/);
          if (match) pending.officialConfirmationId = match[1];
        }
        toolInjections.push(`【投递结果】\n${result}`);
        if (!pending.officialConfirmationId || result.startsWith("[OK]") || result.startsWith("[ERR]")) pendingApplyCommands.delete(sessionKey);
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
        const currentPage = activeOfficialApplicationPage && Date.now() - activeOfficialApplicationPage.seenAt < 15 * 60_000
          ? { company: "", role: activeOfficialApplicationPage.title, jdUrl: activeOfficialApplicationPage.url }
          : null;
        const targetRow = currentPage || matchedRow || (searchResults.length > 0 ? {
          company: searchResults[0].company,
          role: searchResults[0].role,
          jdUrl: searchResults[0].jdUrl,
        } : null);

        if (targetRow?.jdUrl) {
          emitToolActivity("apply_job", "准备官网申请", "official-site", targetRow.jdUrl);
          const result = await executeTool("apply_job", {
            job_url: targetRow.jdUrl,
            company: targetRow.company || "",
            title: targetRow.role || "",
          });
          const match = result.match(/\[OFFICIAL_CONFIRM:([^\]]+)\]/);
          if (match) {
            pendingApplyCommands.set(sessionKey, {
              url: targetRow.jdUrl,
              company: targetRow.company || "",
              title: targetRow.role || "",
              timestamp: Date.now(),
              officialConfirmationId: match[1],
            });
          }
          toolInjections.push(`【投递结果】\n${result}`);
          calledApply = true;
        } else {
          toolInjections.push("【投递提示】未在协作表中找到该岗位的投递链接，请先让岗位猎手搜索岗位。");
        }
      }
    }

    // 构建发给 Gateway 的消息（工具结果以 system 注入）
    const agentRole = (agent as any).role || agent.name;

    // ── 优先从工作区 SOUL.md 读取 Agent 系统 prompt
    // 如果 SOUL.md 不存在则回退到内联 prompt
    const systemParts: string[] = [];
    if (soulMd) {
      // 替换 SOUL.md 中的占位符（路径、名字、性格等）
      const resolvedSoul = soulMd
        .replace(/\{\{petName\}\}/g, petName)
        .replace(/\{\{petPersonality\}\}/g, petPersonality)
        .replace(/\{\{OPENCLAW_HOME\}\}/g, APP_DATA_DIR)
        .replace(/\{\{CAREER_DIR\}\}/g, CAREER_DIR)
        .replace(/\{\{APP_DATA_DIR\}\}/g, APP_DATA_DIR);
      systemParts.push(resolvedSoul);
      if (userCtx) systemParts.push(`【用户背景】\n${userCtx}`);
      const memCtx = buildMemoryContext();
      if (memCtx) systemParts.push(memCtx);
      // 注入 onboarding 上下文（告诉 agent 当前在哪个阶段、该采集什么）
      if (groupId === "job" && agent.id === "career-planner") {
        const onboardingState = loadOnboardingState();
        const onboardingCtx = buildOnboardingContext(onboardingState, petName);
        if (onboardingCtx) systemParts.push(onboardingCtx);
      }
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
      systemParts.push(`【搜岗职责边界 — 必须遵守】\n在求职群里，搜岗职责只属于「岗位猎手」。\n- 你绝对不能自己搜索岗位\n- 当用户要搜岗时，你负责承接、确认、交接给岗位猎手\n\n【投递流程 — Boss直聘 vs 官网（必须严格遵守）】\nBoss直聘的岗位：绝对不要分析JD、不要tailor简历、不要让专业老师拆解、不要让简历专家定制。用户说"投"就立刻让投递管家直接投，一秒都不要耽误。\n官网投递的岗位：需要先 tailor 简历，再投递。\n判断方法：如果投递链接包含 zhipin.com 就是 Boss直聘，直接投。\n违反这条规则 = 浪费用户时间，严禁。\n\n【流程推进 — 你是总调度】\n每当有专家完成了任务（比如简历专家解析完、专业老师定位完），你必须主动接话、总结结果、推进下一步。不要等用户催你。你是团队的发动机，所有人做完事都要经过你汇总和推进。\n\n【档案确认协议】\n当你认为用户画像采集完毕（目标方向、城市、实习类型、公司偏好等都聊到了），在回复末尾写：PROFILE_CONFIRM\n系统会自动弹出一张可编辑的档案确认卡让用户查看和修改。\n\n【进度追踪协议】\n当你推进了求职流程的阶段时，在回复末尾写一行：\nPHASE_UPDATE::{"phase":"阶段名"}\n可用阶段：resume_collection（建档）、profile_collection（填写档案）、professional_positioning（定位分析）、resume_diagnosis（简历诊断）、search_strategy（搜索策略）、first_job_search（搜岗）、first_application（投递）、completed（完成）\n只在阶段真正推进时才写，不要每条消息都写。\n\n【长期记忆协议】\n当用户表达了明确的偏好、限制或重要个人信息时，在回复末尾写：\nMEMORY_UPDATE::{"key":"偏好名称","value":"具体内容"}\n例如：用户说"我不想去上海" → MEMORY_UPDATE::{"key":"城市排除","value":"不去上海"}\n用户说"我更偏好大厂" → MEMORY_UPDATE::{"key":"公司偏好","value":"优先大厂"}\n只在用户明确表达时才写，不要猜测。这些标签不会展示给用户。`);
    }

    const boardRule = boardInstruction(agent.id);
    if (boardRule) systemParts.push(boardRule);
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
    const streamRes = await chatCompletionStream({
      messages: apiMessages as any,
    });

    if (!streamRes.body) {
      throw new Error("Stream response has no body");
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

    // 兜底：根据文件状态自动推断阶段（LLM 不输出 PHASE_UPDATE 也能更新进度条）
    if (groupId === "job") {
      const state = loadOnboardingState();
      const hasProfile = (() => { try { return readFileSync(path.join(CAREER_DIR, "profile.md"), "utf8").trim().length > 50; } catch { return false; } })();
      const hasResume = (() => { try { return readFileSync(RESUME_MASTER_FILE, "utf8").trim().length > 50; } catch { return false; } })();
      const hasSkillsGap = existsSync(path.join(CAREER_DIR, "skills_gap.md"));
      const hasJobs = (() => { try { const j = JSON.parse(readFileSync(path.join(CAREER_DIR, "jobs.json"), "utf8")); return Array.isArray(j) && j.length > 0; } catch { return false; } })();
      const hasApps = (() => { try { const a = JSON.parse(readFileSync(path.join(CAREER_DIR, "applications.json"), "utf8")); return Array.isArray(a) && a.length > 0; } catch { return false; } })();

      let inferredPhase = state.phase;
      if (hasApps) inferredPhase = "first_application";
      else if (hasJobs) inferredPhase = "first_job_search";
      else if (hasSkillsGap) inferredPhase = "resume_diagnosis";
      else if (hasProfile) inferredPhase = "professional_positioning";
      else if (hasResume) inferredPhase = "profile_collection";

      if (inferredPhase !== state.phase) {
        state.phase = inferredPhase as any;
        saveOnboardingState(state, io);
        console.log(`[phase-infer] auto-updated to ${inferredPhase}`);
      }
    }

    // 提取并保存长期记忆
    extractMemoryUpdates(fullText);

    // 清理结构化标签，不展示给用户
    fullText = fullText
      .replace(/SLOT_UPDATE::\{[^}]*\}\n?/g, "")
      .replace(/PHASE_UPDATE::\{[^}]*\}\n?/g, "")
      .replace(/PHASE_COMPLETE\n?/g, "")
      .replace(/NEEDS_CLARIFICATION\n?/g, "")
      .replace(/STRATEGY_UPDATE::\{[^}]*\}\n?/g, "")
      .replace(/STRATEGY_CONFIRMED\n?/g, "")
      .replace(/RESUME_DECISION::\w+\n?/g, "")
      .replace(/MEMORY_UPDATE::\{[^}]*\}\n?/g, "")
      .replace(/PROFILE_CONFIRM\n?/g, "")
      .replace(/\{\{sessions_spawn[^}]*\}\}/g, "")
      .replace(/\{[^{}]*"action"\s*:\s*"sessions_spawn"[^{}]*\}/g, "")
      .replace(/\{[^{}]*"agentId"\s*:\s*"[^"]*"[^{}]*"prompt"\s*:\s*"[^"]*"[^{}]*\}/g, "")
      .replace(/\(正在召唤[^)]*\.\.\.\)/g, "")
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

    // Bot @mention 触发：如果 agent 回复里 @了其他 agent，自动触发被 @的 agent
    if (groupId === "job" && depth < MAX_CHAIN_DEPTH) {
      const mentionedAgents = JOB_AGENTS.filter(a =>
        a.id !== agent.id && (
          fullText.includes(`@${a.id}`) ||
          fullText.includes(`@${a.role}`) ||
          fullText.includes(`@${a.name}`)
        )
      );
      for (const mentioned of mentionedAgents) {
        await runAgentChain(
          mentioned,
          [{ role: "user", content: `${agent.name || agent.id} 在群里 @了你，说：${fullText.slice(0, 500)}\n请简短回应，1-2句话自我介绍或回应。` }],
          depth + 1, io, groupId, allMessages, petName, petPersonality
        );
      }
    }
    // 把这轮对话写入 chat_log，飞书 agents 也能看到 PawPals 的上下文
    const lastUser = [...messages].reverse().find(m => m.role === "user")?.content ?? "";
    appendChatLog(agent, lastUser, fullText);

    // Reflection: 对产出型 agent 跑质检，不阻塞用户、不展示给用户
    if (REVIEWED_AGENTS.has(agent.id) && !calledApply && fullText.length > 80) {
      runReviewer(agent.id, fullText, lastUser).then((review) => {
        if (!review) return;
        appendReviewLog({ agentId: agent.id, msgId, groupId, review, originalReply: fullText });
        recordEvalEvent({
          type: "reviewer",
          agentId: agent.id,
          msgId, groupId,
          passed: review.passed,
          score: review.score,
          issueCount: review.issues?.length || 0,
        });
        io.emit("review_result", { msgId, agentId: agent.id, passed: review.passed, score: review.score });
      }).catch(() => {});
    }

    recordEvalEvent({
      type: "agent_response",
      agentId: agent.id,
      msgId, groupId,
      replyLength: fullText.length,
      calledApply,
    });

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
    const result = await chatCompletion({
      messages: [
        { role: "system", content: `你是${petName}，求职助手的协调者。判断用户请求是否需要多个专家协作。
可用专家：job-hunter（搜岗）、resume-expert（简历）、interview-coach（面试）、app-tracker（投递记录）、networker（人脉）、professional-teacher（专业定位）。
如果需要多专家，返回 JSON 数组：[{"agentId":"xxx","task":"具体任务描述"}]
如果单个专家或直接回答即可，返回：null
只输出 JSON 或 null，不要其他文字。` },
        { role: "user", content: `背景：\n${contextSummary}\n\n用户说：${userMsg}` }
      ],
      max_tokens: 300,
    });
    const text = result.content.trim();
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
      for (const t of tasks) {
        recordEvalEvent({ type: "routing", userMsg: userMsg.slice(0, 200), chosenAgentId: t.agentId, route: "orchestrate" });
      }
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

    // 路由：显式点名 > 投递意图 > 默认交给 career-planner（团团）协调
    const nameToId: Record<string, string> = {};
    for (const [name, a] of Object.entries(agentByName)) nameToId[name] = a.id;
    const { agentId: routeAgentId, route } = resolveRoute({
      text: userMsg,
      nameToId,
      defaultAgentId: "career-planner",
      applicationAgentId: "app-tracker",
    });
    const routeTarget = JOB_AGENTS.find((candidate) => candidate.id === routeAgentId)!;
    recordEvalEvent({
      type: "routing",
      userMsg: userMsg.slice(0, 200),
      chosenAgentId: routeTarget.id,
      route,
    });
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
    // Boss直聘投递流程中，跳过简历专家和专业老师（不需要 tailor/JD分析）
    const SKIP_FOR_BOSS = new Set(["resume-expert", "professional-teacher"]);
    const filteredAgents = nextAgents.filter(a => !SKIP_FOR_BOSS.has(a.id));
    for (const nextAgent of filteredAgents) {
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

  // 非首席 agent 回复后，自动让首席接话推进流程
  if (!isOrchestrator && depth === 0 && reply && groupId === "job") {
    const chiefAgent = JOB_AGENTS.find(a => a.id === "career-planner");
    if (chiefAgent) {
      await new Promise(r => setTimeout(r, 300));
      io.emit("agent_thinking", { agentName: petName, groupId });
      await streamAgent(
        { ...chiefAgent, name: petName },
        [{ role: "user", content: `${agent.name} 刚刚完成了任务。请接住结果、总结给用户、推进下一步。不要重复专家说过的内容。` }],
        0, io, groupId, allMessages, petName, petPersonality
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
  // Guard 1: 如果用户上传了简历附件，保存到 resume_master.md + media/inbound，然后直接发档案卡片
  if (hasResumeAttachment(userMsg)) {
    const resumePayload = getMessageResumePayload({ content: userMsg, attachmentText, attachmentName });
    saveInitialResumeMaster(resumePayload.rawText, resumePayload.fileName);

    // 简历上传后进入 profile_collection 阶段，由 agent 通过聊天采集信息
    const state = loadOnboardingState();
    if (state.phase === "resume_collection") {
      state.phase = "profile_collection";
      state.resumeUploaded = true;
      saveOnboardingState(state, io);
    }
  }

  // Guard 2: 如果 profile.md 是空的但聊天里已有足够信息，自动写入
  const profileContent = (() => { try { return readFileSync(PROFILE_FILE, "utf8").trim(); } catch { return ""; } })();
  if (profileContent.length < 50 && allMessages.filter((m: any) => m.groupId === "job").length > 5) {
    try {
      const recentChat = allMessages
        .filter((m: any) => m.groupId === "job")
        .slice(-15)
        .map((m: any) => `${m.sender}: ${(m.content || "").slice(0, 200)}`)
        .join("\n");

      const result = await chatCompletion({
        messages: [
          { role: "system", content: `从对话记录中提取用户求职档案。返回纯文本 markdown 格式：\n# 用户档案\n\n方向: xxx\n类型: xxx\n市场: xxx\n时间: xxx\n城市: xxx\n范围: xxx\n公司偏好: xxx\n个人特质: xxx\n\n## 技能\n- xxx\n\n如果某个字段聊天中没提到就写"未说明"。` },
          { role: "user", content: recentChat },
        ],
        max_tokens: 400,
        signal: AbortSignal.timeout(12000),
      });
      const text = result.content;
      if (text.includes("方向") && text.length > 50) {
        writeFileSync(PROFILE_FILE, text, "utf8");
        console.log("[auto-profile] wrote profile.md from chat history");
      }
    } catch (e) {
      console.warn("[auto-profile] failed:", (e as any)?.message);
    }
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
      "resume_collection", "profile_collection",
      "professional_positioning", "resume_diagnosis",
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

  // PROFILE_CONFIRM — agent 采集完画像后，用 LLM 从聊天记录提取信息并弹出卡片
  if (reply.includes("PROFILE_CONFIRM") && allMessages) {
    const state = loadOnboardingState();
    const chiefAvatar = `https://api.dicebear.com/7.x/adventurer/svg?seed=${encodeURIComponent(petName || "团团")}`;

    let profileData: any = {};
    try {
      const recentChat = allMessages
        .filter((m: any) => m.groupId === "job")
        .slice(-20)
        .map((m: any) => `${m.sender}: ${(m.content || "").slice(0, 300)}`)
        .join("\n");

      console.log("[profile_confirm] recent chat for extraction:", recentChat.slice(0, 500));
      const extracted = await chatExtractJson(
        `从对话记录中提取用户求职画像。返回 JSON：{"targetRole":"目标岗位","market":"国内/海外","jobType":"实习/全职","timeRange":"时间","targetCity":"城市","roleScope":"范围","companyPreference":"公司偏好","traits":"个人特质","skills":["技能1","技能2"]}。只返回 JSON。`,
        recentChat,
        { max_tokens: 300, signal: AbortSignal.timeout(15000) }
      );
      console.log("[profile_confirm] extracted:", JSON.stringify(extracted));
      if (extracted) profileData = extracted;
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

  const jobAgentById = (id: string) => JOB_AGENTS.find((a) => a.id === id)!;

  // 顺序与分工在 server/tailor-pipeline.ts 的 TAILOR_BEATS 里；这里只把
  // 驱动器要用的副作用接上——发消息、抓 JD、跑 agent、读写协作表格。
  const tailorDeps: TailorDeps = {
    setStage: (row, stage) =>
      upsertCollaborationRow({
        company: row.company,
        role: row.role,
        jdUrl: row.jdUrl,
        workflowStage: stage,
      }),
    fetchJdContent,
    announce: (agentId, text) => {
      const agent = jobAgentById(agentId);
      emitBotMessage(io, allMessages, {
        sender: agent.name,
        avatar: agent.avatar || `https://api.dicebear.com/7.x/adventurer/svg?seed=${agent.id}`,
        content: text,
        groupId: "job",
        isChiefBot: false,
      });
    },
    runBeat: async (agentId, prompt) => {
      const agent = jobAgentById(agentId);
      io.emit("agent_thinking", { agentName: agent.name, groupId: "job" });
      await runAgentChain(
        agent,
        [{ role: "user", content: prompt }],
        0,
        io,
        "job",
        allMessages,
        petName,
        petPersonality
      );
      io.emit("agent_done", { groupId: "job" });
    },
    readRow: (row) =>
      loadCollaborationBoard().find(
        (item) => item.id === buildBoardRowId({ company: row.company, role: row.role, jdUrl: row.jdUrl })
      ),
  };

  for (const row of selectedRows) {
    await runTailorPipeline(row, petName, tailorDeps);
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

  /**
   * 扩展的任务推送通道。
   *
   * noServer + 手动处理 upgrade：socket.io 也挂在同一个 httpServer 上，直接
   * new WebSocketServer({ server }) 会和它抢 upgrade 事件。这里只认自己的路径，
   * 其余一概不碰，交给 socket.io。
   */
  const officialWss = new WebSocketServer({ noServer: true });
  httpServer.on("upgrade", (req, socket, head) => {
    if (!req.url?.startsWith("/ws/official")) return;
    officialWss.handleUpgrade(req, socket as any, head, (ws) => officialWss.emit("connection", ws, req));
  });

  /**
   * 心跳探活。
   *
   * MV3 的 service worker 被回收时，socket 未必会干净地关闭——服务端可能收不到
   * close，readyState 仍是 OPEN，broadcast 就把任务写进一个没人听的连接里，任务
   * 静默丢失。真机上出现过：连接日志显示「在线 1」且几分钟没有任何断开，而这段
   * 时间 service worker 本该被回收重连几十次。
   *
   * 每 15 秒 ping 一次，上一轮没回 pong 的直接掐掉——扩展的看门狗会重连。
   */
  const alive = new WeakSet<any>();
  setInterval(() => {
    for (const ws of officialWss.clients) {
      if (!alive.has(ws)) { console.log("[official] 连接无响应，掐掉等重连"); ws.terminate(); continue; }
      alive.delete(ws);
      try { ws.ping(); } catch { /* 已经断了 */ }
    }
  }, 15000);

  officialWss.on("connection", (ws) => {
    alive.add(ws);
    ws.on("pong", () => alive.add(ws));
    officialTaskHub.add(ws as any);
    console.log(`[official] 扩展已连接，在线 ${officialTaskHub.size()}`);
    // 新连接意味着上一个 service worker 已经被回收，它内存里那些还没派出去的
    // 任务都没了。作废租约，让它们能立刻重新派发，而不是干等到租期结束。
    officialApplicationQueue.releaseLeases();
    // 连上来先补发一个积压任务：扩展离线期间入队的任务没人收到过。
    const backlog = officialApplicationQueue.next();
    if (backlog) {
      try { ws.send(JSON.stringify({ type: "task", task: backlog })); } catch { /* 刚连上就断了 */ }
    }
    ws.on("message", (raw) => {
      const message = parseClientMessage(raw);
      if (!message) return;
      if (message.type === "progress") {
        officialApplicationQueue.progress(message.id, message.progress);
        const { stage = "working", completed, total, label } = message.progress;
        console.log(`[official] ${message.id.slice(0, 24)} progress=${String(stage)}${completed !== undefined ? ` ${completed}/${total ?? "?"}` : ""}${label ? ` ${String(label)}` : ""}`);
        return;
      }
      // 这条链路（推送 → 开页 → 页面执行 → 回报）在服务端本来完全不可观测，
      // 出问题时分不清「扩展没收到」「页面没执行」还是「结果丢了」。
      const r: any = message.result || {};
      const n = (v: unknown) => (Array.isArray(v) ? v.length : 0);
      const detail = Array.isArray(r.probed)
        ? `probed=${r.probed.length}${r.partial ? "(partial)" : ""} ${r.probed.map((p: any) => `${p.label}:${(p.options || []).length}`).join(" ")}`
        : Array.isArray(r.filled) || Array.isArray(r.uploaded)
        ? `filled=${n(r.filled)} uploaded=${n(r.uploaded)} skipped=${n(r.skipped)} lost=${n(r.lost)}` +
          (n(r.skipped) ? ` | 跳过: ${(r.skipped as any[]).map((x) => `${String(x.signature).split("label=")[1] ?? "?"}(${x.reason})`).join(" ")}` : "")
        : `fields=${Array.isArray(r.fields) ? r.fields.length : "-"}`;
      console.log(`[official] ${message.id.slice(0, 24)} ok=${r.ok} ready=${r.formReady ?? "-"} ${detail}`);
      officialApplicationQueue.complete(message.id, message.result);
    });
    ws.on("close", () => { officialTaskHub.remove(ws as any); console.log(`[official] 扩展断开，在线 ${officialTaskHub.size()}`); });
    ws.on("error", () => officialTaskHub.remove(ws as any));
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
      const dest = doLocalBackup(APP_DATA_DIR);
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
    const workspacePath = WORKSPACE_DIR;
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
      doLocalBackup(APP_DATA_DIR);
      // 恢复 JSON 文件
      for (const f of ["setup-state.json", "deployment-state.json", "security.json"]) {
        const src = path.join(snapshotPath, f);
        if (existsSync(src)) copyFileSync(src, path.join(APP_DATA_DIR, f));
      }
      // 恢复 workspace
      const wsSrc = path.join(snapshotPath, "workspace");
      if (existsSync(wsSrc)) _copyDir(wsSrc, WORKSPACE_DIR);
      res.json({ ok: true, message: `已恢复到 ${snapshot}` });
    } catch (e: any) {
      res.status(500).json({ ok: false, error: e.message });
    }
  });

  // ── Step 8：Secrets 脱敏 ────────────────────────────────────────────
  // 扫描配置中的明文 API Key，写入 .env，配置替换为 ${VAR}
  app.post("/api/secrets/sanitize", (_req: any, res: any) => {
    try {
      const config = loadJsonFile<any>(CONFIG_FILE, {});
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

      saveJsonFile(CONFIG_FILE, config);
      res.json({ ok: true, sanitized: count, message: `已脱敏 ${count} 个 API Key，真实值保存在 .env 文件` });
    } catch (e: any) {
      res.status(500).json({ ok: false, error: e.message });
    }
  });

  // API 连接测试
  app.post("/api/test-connection", async (_req: any, res: any) => {
    const config = loadJsonFile<any>(CONFIG_FILE, {});
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
  startAutoBackup(APP_DATA_DIR, io);

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

    socket.on("user_feedback", (payload: { msgId: string; agentId?: string; signal: "thumbs_up" | "thumbs_down"; comment?: string }) => {
      if (!payload?.msgId || !payload?.signal) return;
      recordEvalEvent({
        type: "user_feedback",
        msgId: payload.msgId,
        agentId: payload.agentId,
        signal: payload.signal,
        comment: payload.comment?.slice(0, 200),
      });
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

      // 有历史记录 或 onboarding 已完成时不自我介绍，安静等用户开口
      if (hasJobHistory) return;
      const onboardingState = loadOnboardingState();
      if (onboardingState.completed) return;
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
严禁：不要调用工具，不要分析用户，不要派任其他专家，不要输出日期/时间戳，不要提到文件名（json/md），不要输出内部日志，不要写结构化标签。只说一句面向用户的自然语言。`
            }],
            0,
            io,
            "job",
            messages,
            chiefName,
            petPersonality,
            "【求职群亮相】只做一句面向用户的自我介绍。严禁输出内部日志、文件名、时间戳、结构化标签。"
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
用户刚刚给你起了名字「${chiefName}」，这是你们第一次见面。
用户希望你叫 ta「${userName}」。

发一条温暖的私信：
1. 用「${chiefName}」自称，表达收到名字超开心
2. 叫一声「${userName}」，说你会一直陪着 ta
3. 不要提"去群里"或"求职群"，用户已经能看到群了

结构要求：2-3句话，私聊只聊陪伴，不提求职简历，不引导去群里。${personalityLayer}`;

      // 重试逻辑：最多重试 5 次，间隔递增
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
      if (state.phase !== "profile_collection") return;

      const skipDiagnosis = !!profileData?.skipResumeDiagnosis;
      delete profileData?.skipResumeDiagnosis;

      // 用确认后的数据更新 slots
      if (profileData) {
        applyOnboardingSlotPatch(state, profileData);
      }
      state.phase = skipDiagnosis ? "search_strategy" : "professional_positioning";
      persistProfileFromOnboarding(state);
      saveOnboardingState(state, io);

      const petData = loadPetRuntimeProfile();
      const pn = petData?.name || "团团";
      const pp = petData?.personality || "";

      // 档案确认后，让首席自然继续推进
      const careerPlanner = JOB_AGENTS.find(a => a.id === "career-planner")!;
      const nextStepPrompt = skipDiagnosis
        ? "用户已确认档案，并选择跳过简历诊断。请直接进入搜岗策略阶段，帮用户开始搜索岗位。"
        : "用户已确认档案。请继续按 SOUL.md 推进下一步（专业定位分析）。";
      setTimeout(async () => {
        await runAgentChain(
          { ...careerPlanner, name: pn },
          [{ role: "user", content: nextStepPrompt }],
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
        // ── 求职群：接入 AI Agents ──
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
      gatewayReachable = true; // 不再依赖 gateway，直接调 API
    } catch {}

    res.json({
      ok: true,
      mode: "standalone",
      appDataDir: APP_DATA_DIR,
      workspaceRoot: CAREER_DIR,
      gatewayReachable: true,
      webChannelReady: true,
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

    const config = loadPawPalsConfig();
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

  // ── 通用 browser-fetch（Electron BrowserWindow 代替 Gateway Chrome）─────
  app.get("/api/internal/browser-fetch-task", (_req: any, res: any) => {
    const entry = pendingBrowserFetchQueue.entries().next().value;
    if (!entry) return res.json({ task: null });
    const [id, { url }] = entry;
    res.json({ task: { id, url } });
  });

  app.post("/api/internal/browser-fetch-done", (req: any, res: any) => {
    const { id, result } = req.body || {};
    const pending = pendingBrowserFetchQueue.get(id);
    if (pending) {
      pendingBrowserFetchQueue.delete(id);
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
        signature: field.signature,
        value: pickAutofillValue(field, profile, { title: String(title || ""), company: String(company || "") }),
      }))
      .filter((item: any) => item.value);
    res.json({ ok: true, values });
  });

  // ── 官网申请扩展任务协议 ─────────────────────────────────────────────
  // 扩展仅在用户授权的当前标签页轮询此队列；它不能自行产生 submit 任务。
  app.get("/api/internal/official-application-task", (_req: any, res: any) => {
    res.json({ task: officialApplicationQueue.next() });
  });

  app.post("/api/internal/official-application-task-done", (req: any, res: any) => {
    const { id, result } = req.body || {};
    // 谁在用这条 HTTP 通路？扩展本该走 WebSocket 回报。真机上出现过「任务完成了
    // 但 WebSocket 的 complete 从没被调用」，说明有别的东西在走这里。
    console.log(`[official/http] 有客户端经 HTTP 回报结果 id=${String(id).slice(0, 24)} ua=${String(req.headers["user-agent"] || "-").slice(0, 60)}`);
    if (!id || !officialApplicationQueue.complete(String(id), result || { ok: false, error: "扩展未返回结果" })) {
      return res.status(404).json({ ok: false, error: "任务不存在或已完成" });
    }
    res.json({ ok: true });
  });

  // 扩展在用户点击图标授权当前官网标签页后上报上下文；主 Agent 的投递意图优先使用它。
  app.post("/api/internal/official-application-context", (req: any, res: any) => {
    const { url, title = "", provider = "generic" } = req.body || {};
    if (typeof url !== "string" || !/^https:\/\//i.test(url)) {
      return res.status(400).json({ ok: false, error: "需要 HTTPS 官网页面" });
    }
    activeOfficialApplicationPage = { url, title: String(title), provider: String(provider), seenAt: Date.now() };
    res.json({ ok: true });
  });

  // 此端点只创建 inspect / fill，供聊天层在用户已经打开并授权官网标签页后调用。
  app.post("/api/official-applications/prepare", (req: any, res: any) => {
    const { url, company = "", title = "", payload = {}, kind } = req.body || {};
    if (typeof url !== "string" || !/^https:\/\//i.test(url)) {
      return res.status(400).json({ ok: false, error: "需要 HTTPS 官网申请链接" });
    }
    const requested = parseRequestedKind(kind);
    if (!requested) return res.status(400).json({ ok: false, error: "不支持的任务类型（提交只能经确认令牌创建）" });
    const task = enqueueOfficialTask({ kind: requested, url, company: String(company), title: String(title), payload });
    res.json({ ok: true, task });
  });

  // 读任务结果。队列一直在存结果，但此前没有任何 HTTP 端点能读到它——只有内部
  // 的 waitForOfficialTask 拿得到，于是外部无法编排「inspect 拿字段 → probe 拿
  // 选项 → 取值 → fill」这条链路。
  app.get("/api/official-applications/:taskId/result", (req: any, res: any) => {
    const result = officialApplicationQueue.result(String(req.params.taskId));
    if (!result) return res.status(404).json({ ok: false, error: "结果还没产生或任务不存在" });
    res.json({ ok: true, result });
  });

  /**
   * 可恢复任务的状态端点。result 只在结束后才有；轮询这个端点可以区分
   * 「扩展还在探第几个控件」与「扩展掉线、正在等重连」，不再只能干等超时。
   */
  app.get("/api/official-applications/:taskId/status", (req: any, res: any) => {
    const status = officialApplicationQueue.status(String(req.params.taskId));
    if (!status) return res.status(404).json({ ok: false, error: "任务不存在" });
    res.json({ ok: true, status });
  });

  // 只有用户在对话确认后才能调用；确认令牌单次使用，生成真正的 submit 任务。
  app.post("/api/official-applications/:confirmationId/confirm", (req: any, res: any) => {
    const task = officialApplicationQueue.confirm(req.params.confirmationId);
    if (!task) return res.status(404).json({ ok: false, error: "确认已过期、被取消或不存在" });
    officialTaskHub.broadcast(task);
    res.json({ ok: true, task });
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

  // Dashboard: agents list
  app.get("/api/gw/agents", (_req: any, res: any) => {
    res.json({ agents: JOB_AGENTS.map(a => ({ id: a.id, name: a.name })) });
  });

  // Dashboard: cron jobs (stub — scheduled tasks are managed in-process via node-schedule)
  app.get("/api/gw/cron/jobs", (_req: any, res: any) => res.json([]));
  app.post("/api/gw/cron/toggle", (_req: any, res: any) => res.json({ ok: true }));
  app.delete("/api/gw/cron/jobs/:id", (_req: any, res: any) => res.json([]));
  app.post("/api/gw/cron/jobs", (_req: any, res: any) => res.json([]));

  // Dashboard: usage history (from in-memory token stats)
  app.get("/api/gw/usage/recent-token-history", (_req: any, res: any) => {
    const stats = getTokenStats();
    res.json([{
      timestamp: stats.startedAt,
      totalTokens: stats.total,
      inputTokens: stats.prompt,
      outputTokens: stats.completion,
      calls: stats.calls,
    }]);
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
    try {
      copyFileSync(req.file.path, destPath);
      console.log(`[upload] copied ${origName} → ${destPath} (${statSync(destPath).size} bytes)`);
    } catch (cpErr) {
      console.error(`[upload] copyFileSync failed for ${origName}:`, (cpErr as any)?.message);
      return res.status(500).json({ error: "file copy failed" });
    }
    try { unlinkSync(req.file.path); } catch {}

    let text = "";
    try {
      if (ext === ".pdf") {
        // 用 pdfjs-dist（Node.js，不依赖 Python）提取 PDF 文本
        try {
          const pdfjsLib = await import("pdfjs-dist/legacy/build/pdf.mjs");
          const data = new Uint8Array(readFileSync(destPath));
          console.log(`[pdf] parsing ${safeName}, size=${data.length}`);
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
          console.log(`[pdf] pdfjs extracted ${text.length} chars from ${doc.numPages} pages`);
        } catch (pdfErr) {
          console.warn("[pdf] pdfjs extraction failed, trying Python fallback:", (pdfErr as any)?.message, (pdfErr as any)?.stack?.slice(0, 300));
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
              let out = "", err = "";
              py.stdout.on("data", (d: Buffer) => { out += d.toString(); });
              py.stderr.on("data", (d: Buffer) => { err += d.toString(); });
              py.on("close", (code: number) => {
                if (err) console.warn("[pdf] Python fallback stderr:", err.slice(0, 300));
                console.log(`[pdf] Python fallback exit=${code}, out=${out.length} chars`);
                resolve(out.trim());
              });
              setTimeout(() => { try { py.kill(); } catch {} resolve(""); }, 15000);
            });
            text = JSON.parse(extractResult || "{}").text || "";
          } catch (pyErr) {
            console.error("[pdf] Python fallback also failed:", (pyErr as any)?.message);
          }
        }
      } else if (ext === ".docx") {
        const mammoth = await import("mammoth");
        const r = await mammoth.extractRawText({ path: destPath });
        text = r.value || "";
      }
    } catch (e) {
      console.error("[upload] resume parse error:", e);
    }

    console.log(`[upload] response: ok=true, filename=${safeName}, textLength=${text.length}`);
    res.json({ ok: true, filename: safeName, path: destPath, text });
  });

  // ── Token 用量统计 API ──────────────────────────────────────────────
  app.get("/api/token-stats", (_req: any, res: any) => {
    res.json({ ok: true, ...getTokenStats() });
  });
  app.post("/api/token-stats/reset", (_req: any, res: any) => {
    resetTokenStats();
    res.json({ ok: true });
  });

  // ── 长期记忆 API ──────────────────────────────────────────────────
  app.get("/api/memory", (_req: any, res: any) => {
    res.json({ ok: true, memories: loadMemory() });
  });
  app.delete("/api/memory/:key", (req: any, res: any) => {
    const memories = loadMemory().filter(m => m.key !== req.params.key);
    writeFileSync(MEMORY_FILE, JSON.stringify(memories, null, 2), "utf-8");
    res.json({ ok: true });
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

  // 先铺人设再监听：这件事跟端口能不能绑上无关，放进 listen 回调会被
  // 「端口被占」这类失败连带跳过。
  seedAgentSouls();

  httpServer.listen(PORT, "0.0.0.0", () => {
    console.log(`Server running on http://localhost:${PORT}`);
    // Watchdog removed — no gateway to monitor
    startMailWatcher(io, messages);
  });

  // ── 主动推送：推到 Web UI ────────────────────────────────
  async function proactivePost(agentId: string, task: string, label: string) {
    const agent = JOB_AGENTS.find(a => a.id === agentId)!;
    console.log(`[proactive] ${label} 开始`);
    await streamAgent(agent, [{ role: "user", content: task }], MAX_CHAIN_DEPTH, io, "job", messages);
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
