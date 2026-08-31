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

  const serverEntry = pickFirstExisting([
    path.join(unpackedRoot, "server.ts"),
    path.join(repoRoot, "server.ts"),
  ]);
  const tsxCli = pickFirstExisting([
    path.join(unpackedRoot, "node_modules", "tsx", "dist", "cli.mjs"),
    path.join(repoRoot, "node_modules", "tsx", "dist", "cli.mjs"),
  ]);

  return {
    repoRoot,
    unpackedRoot,
    serverEntry,
    tsxCli,
  };
}
