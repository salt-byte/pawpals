/**
 * dev:isolated — starts the PawPals server directly (no external gateway needed).
 * Equivalent to `npm run dev` but with isolated runtime paths.
 */
import { spawn } from "child_process";
import { fileURLToPath } from "url";
import path from "path";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(__dirname, "..");

const server = spawn("node", ["--import", "tsx/esm", "server.ts"], {
  cwd: repoRoot,
  stdio: "inherit",
  env: { ...process.env },
});

const shutdown = () => {
  server.kill("SIGTERM");
};
process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);
server.on("exit", (code) => process.exit(code ?? 0));
