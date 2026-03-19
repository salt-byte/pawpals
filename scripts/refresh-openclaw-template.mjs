import fs from "fs";
import os from "os";
import path from "path";
import { fileURLToPath } from "url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(__dirname, "..");
const defaultIsolatedOpenClaw = path.join(os.homedir(), "Library", "Application Support", "PawPals", "openclaw");
const defaultPersonalOpenClaw = path.join(os.homedir(), ".openclaw");
const sourceRoot = process.env.OPENCLAW_TEMPLATE_SOURCE ||
  (fs.existsSync(defaultIsolatedOpenClaw) ? defaultIsolatedOpenClaw : defaultPersonalOpenClaw);
const targetRoot = path.join(repoRoot, "resources", "openclaw-template");

const topLevelEntries = [
  "agents",
  "canvas",
  "extensions",
  "openclaw.json",
  "skills",
  "workspace",
];

const resetFiles = new Map([
  [path.join("workspace", "career", "applications.json"), "[]\n"],
  [path.join("workspace", "career", "contacts.json"), "[]\n"],
  [path.join("workspace", "career", "jobs.json"), "[]\n"],
  [path.join("workspace", "career", "pawpals_messages.json"), "[]\n"],
  [path.join("workspace", "career", "chat_log.md"), ""],
  [path.join("workspace", "career", "profile.md"), ""],
  [path.join("workspace", "career", "resume_master.md"), "# Resume Master\n\nFill in the user's resume content after onboarding.\n"],
]);

function ensureDir(dir) {
  fs.mkdirSync(dir, { recursive: true });
}

function removeDir(dir) {
  fs.rmSync(dir, { recursive: true, force: true });
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

function scrubConfig(config) {
  config.env ??= {};
  config.env.vars ??= {};
  for (const key of Object.keys(config.env.vars)) {
    if (/key|token|secret|password/i.test(key)) {
      config.env.vars[key] = "";
    }
  }

  if (config.models?.providers) {
    for (const provider of Object.values(config.models.providers)) {
      if (provider && typeof provider === "object" && "apiKey" in provider) {
        provider.apiKey = "";
      }
    }
  }

  if (config.tools?.web?.search && typeof config.tools.web.search === "object") {
    config.tools.web.search.apiKey = "";
  }

  config.gateway ??= {};
  config.gateway.mode = "local";
  config.gateway.bind = "loopback";
  if (config.gateway.auth && typeof config.gateway.auth === "object") {
    if ("token" in config.gateway.auth) config.gateway.auth.token = "";
    if ("password" in config.gateway.auth) config.gateway.auth.password = "";
  }

  config.bindings = [];
  if (config.channels && typeof config.channels === "object") {
    delete config.channels.feishu;
  }

  return config;
}

function scrubAgentFile(filePath) {
  const raw = fs.readFileSync(filePath, "utf8");
  const sanitized = raw.replace(
    /("(?:apiKey|key|token|password|secret)"\s*:\s*")[^"]*(")/gi,
    '$1$2',
  );
  const parsed = JSON.parse(sanitized);
  if (parsed.usageStats) {
    for (const value of Object.values(parsed.usageStats)) {
      if (value && typeof value === "object") {
        delete value.lastUsed;
        delete value.lastFailureAt;
        value.errorCount = 0;
      }
    }
  }
  fs.writeFileSync(filePath, `${JSON.stringify(parsed, null, 2)}\n`, "utf8");
}

function scrubTextFile(filePath) {
  const raw = fs.readFileSync(filePath, "utf8");
  const sanitized = raw
    .replaceAll("~/.openclaw", "{{OPENCLAW_HOME}}")
    .replaceAll("/Users/dengyudie/.openclaw", "{{OPENCLAW_HOME}}")
    .replaceAll(sourceRoot, "{{OPENCLAW_HOME}}")
    .replaceAll("yudieden@usc.edu", "your-email@example.com")
    .replaceAll("JjPDbDqflaMZfxsh7cTctYHZnve", "<bitable-app-token>")
    .replaceAll("OSyJfaCk4lpwI7dYepCc5CfGnxe", "<folder-token>")
    .replace(/https:\/\/my\.feishu\.cn\/[^\s)]+/g, "<feishu-link>");
  fs.writeFileSync(filePath, sanitized, "utf8");
}

function copyEntry(entry) {
  const src = path.join(sourceRoot, entry);
  if (!fs.existsSync(src)) return;

  const dest = path.join(targetRoot, entry);
  fs.cpSync(src, dest, {
    recursive: true,
    force: true,
    dereference: false,
    filter: (sourcePath) => {
      const relative = path.relative(sourceRoot, sourcePath);
      if (!relative) return true;

      const normalized = relative.split(path.sep).join("/");
      const blockedSegments = [
        ".git",
        ".DS_Store",
        ".env",
        "devices",
        "delivery-queue",
        "feishu",
        "identity",
        "logs",
        "media",
        "memory",
        "browser/openclaw/user-data",
        "workspace/.git",
        "workspace/.clawhub",
        "workspace/.openclaw",
        "workspace/memory",
        "workspace/career/context",
        "workspace/career/output",
      ];
      if (blockedSegments.some((segment) => normalized === segment || normalized.startsWith(`${segment}/`))) {
        return false;
      }
      if (/\/sessions(\/|$)/.test(normalized)) return false;
      if (/\/cron\/runs(\/|$)/.test(normalized)) return false;
      if (/\/workspace\/memory(\/|$)/.test(normalized)) return false;
      if (/\/workspace\/\.clawhub(\/|$)/.test(normalized)) return false;
      if (/\/workspace\/\.openclaw(\/|$)/.test(normalized)) return false;
      if (/\/workspaces\/[^/]+\/\.openclaw(\/|$)/.test(normalized)) return false;
      if (/\/skills\/[^/]+\/\.clawhub(\/|$)/.test(normalized)) return false;
      if (/\/brave_key\.txt$/.test(normalized)) return false;
      if (/\/workspace\/career\/(context|output)(\/|$)/.test(normalized)) return false;
      return true;
    },
  });
}

if (!fs.existsSync(sourceRoot)) {
  throw new Error(`Template source does not exist: ${sourceRoot}`);
}

removeDir(targetRoot);
ensureDir(targetRoot);

for (const entry of topLevelEntries) {
  copyEntry(entry);
}

for (const relativePath of [
  "workspace/.git",
  "workspace/.clawhub",
  "workspace/.openclaw",
  "workspace/memory",
  "workspace/career/context",
  "workspace/career/output",
  "workspace/.DS_Store",
  "workspace/skills/agent-browser/.clawhub",
  "workspace/skills/openclaw-tavily-search/.clawhub",
]) {
  removeDir(path.join(targetRoot, relativePath));
}

for (const workspaceId of ["professional-teacher", "app-tracker", "networker", "interview-coach", "resume-expert", "career-planner", "job-hunter"]) {
  removeDir(path.join(targetRoot, "workspace", "career", "workspaces", workspaceId, ".openclaw"));
}

const configPath = path.join(targetRoot, "openclaw.json");
if (fs.existsSync(configPath)) {
  const config = JSON.parse(fs.readFileSync(configPath, "utf8"));
  const sanitized = scrubConfig(rewritePaths(config, sourceRoot, targetRoot));
  fs.writeFileSync(configPath, `${JSON.stringify(sanitized, null, 2)}\n`, "utf8");
}

for (const agentId of fs.existsSync(path.join(targetRoot, "agents")) ? fs.readdirSync(path.join(targetRoot, "agents")) : []) {
  const agentDir = path.join(targetRoot, "agents", agentId, "agent");
  for (const fileName of ["auth-profiles.json", "models.json"]) {
    const filePath = path.join(agentDir, fileName);
    if (fs.existsSync(filePath)) scrubAgentFile(filePath);
  }
}

function walk(dir, visit) {
  if (!fs.existsSync(dir)) return;
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const fullPath = path.join(dir, entry.name);
    if (entry.isDirectory()) walk(fullPath, visit);
    else visit(fullPath);
  }
}

walk(targetRoot, (filePath) => {
  if (/\.(md|txt|py)$/i.test(filePath)) {
    scrubTextFile(filePath);
  }
});

for (const [relativeFile, content] of resetFiles.entries()) {
  const file = path.join(targetRoot, relativeFile);
  ensureDir(path.dirname(file));
  fs.writeFileSync(file, content, "utf8");
}

const summary = {
  sourceRoot,
  targetRoot,
  copiedEntries: topLevelEntries,
  resetFiles: [...resetFiles.keys()],
};

console.log(JSON.stringify(summary, null, 2));
