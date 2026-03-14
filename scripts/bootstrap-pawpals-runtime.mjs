import fs from "fs";
import path from "path";
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
  fs.cpSync(src, dest, {
    recursive: true,
    force: true,
    dereference: false,
  });
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

ensureDir(runtime.pawPalsHome);
ensureDir(runtime.openClawHome);
ensureDir(runtime.cookieDir);
markDeploymentStep("prepare-directories", `Prepared PawPals home at ${runtime.pawPalsHome}`);

if (!fs.existsSync(path.join(runtime.openClawHome, "openclaw.json"))) {
  if (!sourceRoot) {
    throw new Error(
      "No OpenClaw template found. Set OPENCLAW_TEMPLATE_DIR or install/configure OpenClaw once on this machine first.",
    );
  }

  for (const entry of copyEntries) {
    copyEntry(sourceRoot, runtime.openClawHome, entry);
  }
  appendDeploymentLog(`Initialized isolated OpenClaw home from ${sourceRoot}`);

  const configPath = path.join(runtime.openClawHome, "openclaw.json");
  if (fs.existsSync(configPath)) {
    const raw = fs.readFileSync(configPath, "utf8");
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
    if (!copySecrets) scrubSecrets(rewritten);
    fs.writeFileSync(configPath, `${JSON.stringify(rewritten, null, 2)}\n`, "utf8");
    appendDeploymentLog("Rewrote OpenClaw config paths and enabled HTTP chat completions for the PawPals local runtime");
  }
} else {
  appendDeploymentLog(`Reusing existing PawPals OpenClaw home at ${runtime.openClawHome}`);
}

ensureCareerFiles();
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
