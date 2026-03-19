import fs from "fs";
import path from "path";
import crypto from "crypto";
import { resolveAppPaths } from "./app-paths.mjs";
import { appendDeploymentLog, markDeploymentStep } from "./deployment-state.mjs";
import { resolveRuntimePaths } from "./runtime-paths.mjs";

const runtime = resolveRuntimePaths();
const { templateDir } = resolveAppPaths();
const fallbackLocalOpenClaw = path.join(process.env.HOME || "", ".openclaw");
const sourceRoot = fs.existsSync(templateDir)
  ? templateDir
  : (fs.existsSync(fallbackLocalOpenClaw) ? fallbackLocalOpenClaw : null);

const copySecrets =
  process.env.PAWPALS_COPY_SECRETS === "1" ||
  (!process.env.PAWPALS_COPY_SECRETS && sourceRoot === fallbackLocalOpenClaw);

const copyEntries = [
  ".env",
  "agents",
  "canvas",
  "cron",
  "devices",
  "extensions",
  "feishu",
  "identity",
  "openclaw.json",
  "skills",
  "workspace",
];

function ensureDir(dir) {
  fs.mkdirSync(dir, { recursive: true });
}

function copyEntry(srcRoot, destRoot, entry) {
  const src = path.join(srcRoot, entry);
  if (!fs.existsSync(src)) return;

  const dest = path.join(destRoot, entry);
  try {
    fs.cpSync(src, dest, {
      recursive: true,
      force: true,
      dereference: false,
      errorOnExist: false,
      filter: (s) => {
        // 跳过 symlink 循环和 node_modules
        try {
          const real = fs.realpathSync(s);
          if (real.startsWith(dest)) return false; // 自引用
        } catch {}
        if (s.includes("node_modules")) return false;
        return true;
      },
    });
  } catch (e) {
    console.warn(`[bootstrap] copyEntry warning: ${entry}: ${e.message}`);
  }
}

function rewritePaths(value, source, target) {
  if (typeof value === "string") {
    return value.split(source).join(target);
  }
  if (Array.isArray(value)) {
    return value.map((item) => rewritePaths(item, source, target));
  }
  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value).map(([key, child]) => [key, rewritePaths(child, source, target)]),
    );
  }
  return value;
}

function scrubSecrets(config) {
  if (!config || typeof config !== "object") return config;

  if (config.env?.vars) {
    for (const key of Object.keys(config.env.vars)) {
      if (/key|token|secret|password/i.test(key)) {
        config.env.vars[key] = "";
      }
    }
  }

  if (config.models?.providers) {
    for (const provider of Object.values(config.models.providers)) {
      if (provider && typeof provider === "object" && "apiKey" in provider) {
        provider.apiKey = "";
      }
    }
  }

  return config;
}

function removeInvalidProviders(config) {
  if (!config?.models?.providers || typeof config.models.providers !== "object") return config;

  const invalidProviders = [];
  for (const [providerName, provider] of Object.entries(config.models.providers)) {
    if (!provider || typeof provider !== "object") continue;
    const baseUrl = typeof provider.baseUrl === "string" ? provider.baseUrl.trim() : "";
    const api = typeof provider.api === "string" ? provider.api.trim() : "";
    if (api === "openai-completions" && !baseUrl) {
      invalidProviders.push(providerName);
    }
  }

  for (const providerName of invalidProviders) {
    delete config.models.providers[providerName];
  }

  if (invalidProviders.length > 0) {
    appendDeploymentLog(`Removed invalid providers from runtime config: ${invalidProviders.join(", ")}`);
  }

  return config;
}

function ensureCareerFiles() {
  const files = {
    "applications.json": "[]\n",
    "contacts.json": "[]\n",
    "jobs.json": "[]\n",
    "pawpals_messages.json": "[]\n",
    "chat_log.md": "",
  };

  ensureDir(runtime.workspaceRoot);
  for (const [name, initialContent] of Object.entries(files)) {
    const file = path.join(runtime.workspaceRoot, name);
    if (!fs.existsSync(file)) {
      fs.writeFileSync(file, initialContent, "utf8");
    }
  }
}

function collectSignatureEntries(root, base = root, entries = []) {
  if (!root || !fs.existsSync(root)) return entries;
  const stat = fs.statSync(root);
  if (stat.isFile()) {
    entries.push(`${path.relative(base, root)}:${stat.size}:${Math.floor(stat.mtimeMs)}`);
    return entries;
  }
  const children = fs.readdirSync(root).sort((a, b) => a.localeCompare(b));
  for (const child of children) {
    collectSignatureEntries(path.join(root, child), base, entries);
  }
  return entries;
}

function computeRuntimeBuildSignature() {
  const hash = crypto.createHash("sha256");
  const packageJsonPath = path.join(resolveAppPaths().repoRoot, "package.json");
  const roots = [
    packageJsonPath,
    path.join(resolveAppPaths().repoRoot, "server.ts"),
    path.join(resolveAppPaths().repoRoot, "server"),
    path.join(resolveAppPaths().repoRoot, "electron"),
    templateDir,
  ].filter(Boolean);

  for (const root of roots) {
    const base = fs.existsSync(root) && fs.statSync(root).isDirectory() ? root : path.dirname(root);
    for (const entry of collectSignatureEntries(root, base)) {
      hash.update(entry);
      hash.update("\n");
    }
  }

  return hash.digest("hex");
}

function resetVolatileCareerState(reason) {
  const filesToDelete = [
    path.join(runtime.workspaceRoot, "collaboration_board.json"),
    path.join(runtime.workspaceRoot, "last_search_results.json"),
    path.join(runtime.workspaceRoot, "onboarding_state.json"),
    path.join(runtime.workspaceRoot, "profile.md"),
    path.join(runtime.workspaceRoot, "resume_master.md"),
    path.join(runtime.workspaceRoot, "skills_gap.md"),
    path.join(runtime.pawPalsHome, "mail-watcher-state.json"),
  ];
  const filesToReinitialize = [
    path.join(runtime.workspaceRoot, "applications.json"),
    path.join(runtime.workspaceRoot, "contacts.json"),
    path.join(runtime.workspaceRoot, "jobs.json"),
    path.join(runtime.workspaceRoot, "pawpals_messages.json"),
    path.join(runtime.workspaceRoot, "chat_log.md"),
  ];

  for (const file of filesToDelete) {
    if (fs.existsSync(file)) {
      fs.rmSync(file, { force: true });
    }
  }

  for (const file of filesToReinitialize) {
    const ext = path.extname(file);
    const empty = ext === ".json" ? "[]\n" : "";
    fs.writeFileSync(file, empty, "utf8");
  }

  appendDeploymentLog(`Reset volatile career state (${reason})`);
}

function syncRuntimeBuildMarker() {
  const markerPath = path.join(runtime.pawPalsHome, "runtime-build-signature.json");
  const nextSignature = computeRuntimeBuildSignature();
  let previousSignature = "";

  if (fs.existsSync(markerPath)) {
    try {
      previousSignature = JSON.parse(fs.readFileSync(markerPath, "utf8"))?.signature || "";
    } catch {}
  }

  if (previousSignature && previousSignature !== nextSignature) {
    resetVolatileCareerState("build signature changed");
  }

  fs.writeFileSync(
    markerPath,
    `${JSON.stringify({ signature: nextSignature, updatedAt: new Date().toISOString() }, null, 2)}\n`,
    "utf8",
  );
}

function removeObsoleteRuntimeArtifacts(openClawHome) {
  const obsoleteDirs = [
    path.join(openClawHome, "workspace", "career", "workspaces", "jd-analyst"),
  ];
  const obsoleteFiles = [
    path.join(openClawHome, "workspace", "career", "workspaces", "career-planner", "SOUL.md.bak"),
  ];

  for (const dir of obsoleteDirs) {
    if (fs.existsSync(dir)) {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  }
  for (const file of obsoleteFiles) {
    if (fs.existsSync(file)) {
      fs.rmSync(file, { force: true });
    }
  }

  const workspacesRoot = path.join(openClawHome, "workspace", "career", "workspaces");
  if (!fs.existsSync(workspacesRoot)) return;

  const walk = (dir) => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        walk(full);
        continue;
      }
      if (entry.name.endsWith(".bak")) {
        fs.rmSync(full, { force: true });
      }
    }
  };
  walk(workspacesRoot);
}

ensureDir(runtime.pawPalsHome);
ensureDir(runtime.openClawHome);
ensureDir(runtime.cookieDir);
markDeploymentStep("prepare-directories", `Prepared PawPals home at ${runtime.pawPalsHome}`);

// 始终从 template 初始化/更新，保证 providers、agents 等配置完整
// 如果运行时已有 config，merge 用户已配的 apiKey
const runtimeConfigPath = path.join(runtime.openClawHome, "openclaw.json");
const existingConfig = fs.existsSync(runtimeConfigPath)
  ? (() => { try { return JSON.parse(fs.readFileSync(runtimeConfigPath, "utf8")); } catch { return null; } })()
  : null;

if (!sourceRoot) {
  if (!existingConfig) {
    throw new Error(
      "No OpenClaw template found. Set OPENCLAW_TEMPLATE_DIR or install/configure OpenClaw once on this machine first.",
    );
  }
  appendDeploymentLog(`No template found, keeping existing config at ${runtime.openClawHome}`);
} else {
  // 从 template 复制所有文件（agents、workspace、skills 等）
  for (const entry of copyEntries) {
    copyEntry(sourceRoot, runtime.openClawHome, entry);
  }
  appendDeploymentLog(`Initialized/updated OpenClaw home from ${sourceRoot}`);

  if (fs.existsSync(runtimeConfigPath)) {
    const raw = fs.readFileSync(runtimeConfigPath, "utf8");
    const rewritten = rewritePaths(JSON.parse(raw), sourceRoot, runtime.openClawHome);
    rewritten.agents ??= {};
    rewritten.agents.defaults ??= {};
    rewritten.agents.defaults.workspace = path.join(runtime.openClawHome, "workspace");
    rewritten.gateway ??= {};
    rewritten.gateway.mode = "local";
    rewritten.gateway.bind ??= "loopback";
    rewritten.gateway.http ??= {};
    rewritten.gateway.http.endpoints ??= {};
    rewritten.gateway.http.endpoints.chatCompletions ??= {};
    rewritten.gateway.http.endpoints.chatCompletions.enabled = true;

    // Merge：如果用户之前已经配过 apiKey，保留它们
    if (existingConfig?.models?.providers) {
      rewritten.models ??= {};
      rewritten.models.providers ??= {};
      for (const [providerName, providerCfg] of Object.entries(existingConfig.models.providers)) {
        const existing = providerCfg;
        const target = rewritten.models.providers[providerName];
        if (existing && typeof existing === "object" && target && typeof target === "object") {
          // 保留用户已配的 apiKey（template 里是空的）
          if (existing.apiKey && !target.apiKey) {
            target.apiKey = existing.apiKey;
          }
        }
      }
    }
    // 保留 gateway token（每次部署会重新生成，但以防万一）
    if (existingConfig?.gateway?.auth?.token) {
      rewritten.gateway.auth ??= {};
      rewritten.gateway.auth.token = existingConfig.gateway.auth.token;
    }

    if (!copySecrets) scrubSecrets(rewritten);
    removeInvalidProviders(rewritten);
    fs.writeFileSync(runtimeConfigPath, `${JSON.stringify(rewritten, null, 2)}\n`, "utf8");
    appendDeploymentLog("Rewrote OpenClaw config (template base + merged user keys)");
  }
}

// 始终确保 openclaw.json 开启了 HTTP chat completions（旧版部署可能没有这个配置）
const configPath = path.join(runtime.openClawHome, "openclaw.json");
if (fs.existsSync(configPath)) {
  try {
    const cfg = JSON.parse(fs.readFileSync(configPath, "utf8"));
    cfg.gateway ??= {};
    cfg.gateway.http ??= {};
    cfg.gateway.http.endpoints ??= {};
    cfg.gateway.http.endpoints.chatCompletions ??= {};
    removeInvalidProviders(cfg);
    cfg.gateway.http.endpoints.chatCompletions.enabled = true;
    fs.writeFileSync(configPath, `${JSON.stringify(cfg, null, 2)}\n`, "utf8");
    appendDeploymentLog("Normalized runtime openclaw.json");
  } catch {}
}

// 同步全局 provider auth 到每个 agent 的 auth-profiles.json
// 确保 gateway 执行任何 agent 时都能找到正确的 apiKey
try {
  const cfg = JSON.parse(fs.readFileSync(configPath, "utf8"));
  const providers = cfg?.models?.providers || {};
  const primaryModel = cfg?.agents?.defaults?.model?.primary || "";
  const [selectedProvider] = primaryModel.split("/");
  const agentsRoot = path.join(runtime.openClawHome, "agents");

  if (fs.existsSync(agentsRoot)) {
    // 收集所有有 apiKey 的 provider
    const providersWithKeys = [];
    for (const [name, p] of Object.entries(providers)) {
      if (!p || typeof p !== "object") continue;
      const key = name === "anthropic"
        ? (cfg?.env?.vars?.ANTHROPIC_API_KEY || "")
        : (p.apiKey || "");
      if (key) providersWithKeys.push({ name, key, config: p });
    }

    if (providersWithKeys.length > 0) {
      for (const agentId of fs.readdirSync(agentsRoot)) {
        const agentDir = path.join(agentsRoot, agentId, "agent");
        if (!fs.existsSync(agentDir)) continue;

        const authPath = path.join(agentDir, "auth-profiles.json");
        let auth = { version: 1, profiles: {}, usageStats: {} };
        try { auth = JSON.parse(fs.readFileSync(authPath, "utf8")); } catch {}
        auth.profiles ??= {};
        auth.usageStats ??= {};
        auth.lastGood ??= {};

        const modelsPath = path.join(agentDir, "models.json");
        let models = {};
        try { models = JSON.parse(fs.readFileSync(modelsPath, "utf8")); } catch {}
        models.providers ??= {};

        for (const { name, key, config } of providersWithKeys) {
          auth.profiles[`${name}:default`] = { type: "api_key", provider: name, key };
          auth.usageStats[`${name}:default`] ??= { errorCount: 0 };
          auth.lastGood[name] = `${name}:default`;
          models.providers[name] = JSON.parse(JSON.stringify(config));
        }

        fs.writeFileSync(authPath, JSON.stringify(auth, null, 2) + "\n", "utf8");
        fs.writeFileSync(modelsPath, JSON.stringify(models, null, 2) + "\n", "utf8");
      }
      appendDeploymentLog(`Synced ${providersWithKeys.map(p => p.name).join(", ")} auth to all agents`);
    }
  }
} catch (e) {
  console.warn("[bootstrap] provider sync warning:", e.message);
}

// 始终确保 workspace 子代理是最新的（openclaw.json 已存在时也要同步）
if (sourceRoot) {
  const templateWorkspaces = path.join(sourceRoot, "workspace", "career", "workspaces");
  const deployedWorkspaces = path.join(runtime.workspaceRoot, "workspaces");
  if (fs.existsSync(templateWorkspaces)) {
    ensureDir(path.dirname(deployedWorkspaces));
    if (fs.existsSync(deployedWorkspaces)) {
      fs.rmSync(deployedWorkspaces, { recursive: true, force: true });
    }
    fs.cpSync(templateWorkspaces, deployedWorkspaces, { recursive: true, force: true, dereference: false });
    appendDeploymentLog(`Synced sub-agent workspaces from template to ${deployedWorkspaces}`);
  }
}

removeObsoleteRuntimeArtifacts(runtime.openClawHome);

ensureCareerFiles();
syncRuntimeBuildMarker();
appendDeploymentLog(`Ensured PawPals workspace at ${runtime.workspaceRoot}`);

const summary = {
  pawPalsHome: runtime.pawPalsHome,
  openClawHome: runtime.openClawHome,
  workspaceRoot: runtime.workspaceRoot,
  cookieDir: runtime.cookieDir,
  sourceRoot,
  copySecrets,
};

console.log(JSON.stringify(summary, null, 2));
