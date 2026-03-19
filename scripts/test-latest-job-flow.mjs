import fs from "fs";
import os from "os";
import path from "path";
import { spawn, execSync } from "child_process";
import { fileURLToPath } from "url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(__dirname, "..");

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

function ensureDir(dir) {
  fs.mkdirSync(dir, { recursive: true });
}

function writeJson(file, value) {
  ensureDir(path.dirname(file));
  fs.writeFileSync(file, `${JSON.stringify(value, null, 2)}\n`, "utf8");
}

function removeIfExists(file) {
  try {
    if (fs.existsSync(file)) fs.rmSync(file, { force: true, recursive: false });
  } catch {}
}

function removeDirIfExists(dir) {
  try {
    if (fs.existsSync(dir)) fs.rmSync(dir, { force: true, recursive: true });
  } catch {}
}

function emptyFile(file) {
  ensureDir(path.dirname(file));
  fs.writeFileSync(file, "", "utf8");
}

function killExistingDesktopDev() {
  if (process.platform === "darwin" || process.platform === "linux") {
    const commands = [
      `pkill -f "node scripts/run-electron.mjs|electron .*PawPals|electron \\\\." || true`,
      `pkill -f "tsx server.ts|node --import tsx/esm server.ts|openclaw-gateway" || true`,
    ];
    for (const command of commands) {
      try {
        execSync(command, { stdio: "ignore", shell: "/bin/zsh" });
      } catch {}
    }
  }
}

const appDataDir = resolveAppDataDir();
const openclawHome = process.env.OPENCLAW_STATE_DIR || process.env.OPENCLAW_HOME || path.join(appDataDir, "openclaw");
const careerDir = process.env.PAWPALS_WORKSPACE || path.join(openclawHome, "workspace", "career");
const cookieDir = process.env.PAWPALS_COOKIE_DIR || path.join(appDataDir, "jobclaw", "cookies");
const hardReset = process.argv.includes("--hard") || process.env.PAWPALS_HARD_RESET === "1";

const filesToResetJson = [
  path.join(careerDir, "pawpals_messages.json"),
  path.join(careerDir, "jobs.json"),
  path.join(careerDir, "applications.json"),
  path.join(careerDir, "contacts.json"),
  path.join(careerDir, "collaboration_board.json"),
  path.join(careerDir, "last_search_results.json"),
];

const filesToRemove = [
  path.join(careerDir, "profile.md"),
  path.join(careerDir, "resume_master.md"),
  path.join(careerDir, "skills_gap.md"),
  path.join(careerDir, "mail-watcher-state.json"),
  path.join(careerDir, "onboarding_state.json"),
  path.join(cookieDir, "boss.json"),
];

console.log("[test-flow] stopping existing desktop dev processes...");
killExistingDesktopDev();

console.log("[test-flow] resetting career workspace...");
ensureDir(careerDir);
for (const file of filesToResetJson) {
  writeJson(file, []);
}
emptyFile(path.join(careerDir, "chat_log.md"));
for (const file of filesToRemove) {
  removeIfExists(file);
}

if (hardReset) {
  console.log("[test-flow] hard reset enabled; clearing Electron session data...");
  [
    path.join(appDataDir, "Partitions"),
    path.join(appDataDir, "Session Storage"),
    path.join(appDataDir, "Local Storage"),
    path.join(appDataDir, "IndexedDB"),
    path.join(appDataDir, "GPUCache"),
    path.join(appDataDir, "Code Cache"),
    path.join(appDataDir, "DawnCache"),
  ].forEach(removeDirIfExists);
}

console.log("[test-flow] preserved pet profile and model config");
console.log(`[test-flow] workspace reset: ${careerDir}`);
console.log(`[test-flow] boss cookie removed: ${path.join(cookieDir, "boss.json")}`);
if (hardReset) {
  console.log(`[test-flow] electron session storage removed under: ${appDataDir}`);
}
console.log("[test-flow] launching desktop dev...");

const child = spawn(process.execPath, [path.join(repoRoot, "scripts/run-electron.mjs")], {
  cwd: repoRoot,
  env: {
    ...process.env,
    PAWPALS_ELECTRON_DEV: "1",
  },
  stdio: "inherit",
});

child.on("exit", (code) => {
  process.exit(code ?? 0);
});
