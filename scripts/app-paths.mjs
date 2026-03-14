import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const defaultRepoRoot = path.resolve(__dirname, "..");

function pickFirstExisting(candidates) {
  for (const candidate of candidates) {
    if (candidate && fs.existsSync(candidate)) return candidate;
  }
  return candidates.find(Boolean) || null;
}

export function resolveAppPaths(options = {}) {
  const packagedAppRoot = process.env.PAWPALS_APP_ROOT || null;
  const unpackedAppRoot = process.env.PAWPALS_APP_UNPACKED_ROOT || null;
  const repoRoot = options.repoRoot || packagedAppRoot || defaultRepoRoot;
  const unpackedRoot = options.unpackedRoot || unpackedAppRoot || repoRoot;

  const bootstrapScript = pickFirstExisting([
    path.join(unpackedRoot, "scripts", "bootstrap-pawpals-runtime.mjs"),
    path.join(repoRoot, "scripts", "bootstrap-pawpals-runtime.mjs"),
  ]);
  const serverEntry = pickFirstExisting([
    path.join(unpackedRoot, "server.ts"),
    path.join(repoRoot, "server.ts"),
  ]);
  const templateDir = pickFirstExisting([
    process.env.OPENCLAW_TEMPLATE_DIR || "",
    path.join(repoRoot, "resources", "openclaw-template"),
    path.join(unpackedRoot, "resources", "openclaw-template"),
  ]);
  const tsxCli = pickFirstExisting([
    path.join(unpackedRoot, "node_modules", "tsx", "dist", "cli.mjs"),
    path.join(repoRoot, "node_modules", "tsx", "dist", "cli.mjs"),
  ]);
  const openClawCli = pickFirstExisting([
    path.join(unpackedRoot, "node_modules", "openclaw", "openclaw.mjs"),
    path.join(repoRoot, "node_modules", "openclaw", "openclaw.mjs"),
  ]);

  return {
    repoRoot,
    unpackedRoot,
    bootstrapScript,
    serverEntry,
    templateDir,
    tsxCli,
    openClawCli,
  };
}
