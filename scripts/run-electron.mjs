import { spawn } from "child_process";
import path from "path";
import { fileURLToPath } from "url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(__dirname, "..");
const electronBinary = path.join(repoRoot, "node_modules", ".bin", process.platform === "win32" ? "electron.cmd" : "electron");

const child = spawn(electronBinary, ["."], {
  cwd: repoRoot,
  env: {
    ...process.env,
    PAWPALS_ELECTRON_DEV: "1",
  },
  stdio: "inherit",
});

child.on("exit", (code) => process.exit(code ?? 0));
