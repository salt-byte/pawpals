import fs from "fs";
import path from "path";
import { spawn } from "child_process";
import net from "net";
import { resolveAppPaths } from "./app-paths.mjs";
import {
  appendDeploymentLog,
  getDeploymentFiles,
  markDeploymentFailed,
  markDeploymentReady,
  markDeploymentStep,
  resetDeploymentState,
} from "./deployment-state.mjs";
import { resolveRuntimePaths } from "./runtime-paths.mjs";

function wait(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function waitForUrl(url, timeoutMs = 30000) {
  const startedAt = Date.now();
  while (Date.now() - startedAt < timeoutMs) {
    try {
      const res = await fetch(url);
      if (res.ok) return;
    } catch {}
    await wait(500);
  }
  throw new Error(`Timed out waiting for ${url}`);
}

function canListenOnPort(port) {
  return new Promise((resolve) => {
    const server = net.createServer();
    server.once("error", () => resolve(false));
    server.once("listening", () => {
      server.close(() => resolve(true));
    });
    server.listen(port, "127.0.0.1");
  });
}

async function resolveAppPort() {
  if (process.env.PAWPALS_PORT || process.env.PORT) {
    return process.env.PAWPALS_PORT || process.env.PORT;
  }

  for (const candidate of [3010, 3011, 3100, 3200]) {
    if (await canListenOnPort(candidate)) return String(candidate);
  }

  const ephemeral = await new Promise((resolve, reject) => {
    const server = net.createServer();
    server.once("error", reject);
    server.once("listening", () => {
      const address = server.address();
      if (address && typeof address === "object") {
        const port = address.port;
        server.close(() => resolve(String(port)));
      } else {
        server.close(() => reject(new Error("Failed to allocate an app port")));
      }
    });
    server.listen(0, "127.0.0.1");
  });

  return ephemeral;
}

function resolveTsxCli(appPaths) {
  if (appPaths.tsxCli && fs.existsSync(appPaths.tsxCli)) return appPaths.tsxCli;
  throw new Error("tsx runtime not found. Run npm install before starting PawPals desktop.");
}

function spawnNodeScript(entry, args, options = {}) {
  const env = { ...process.env, ...options.env, ELECTRON_RUN_AS_NODE: "1" };
  return spawn(process.execPath, [entry, ...args], {
    ...options,
    env,
  });
}

function pipeChildLogs(child, stdoutFile, stderrFile, deployLogFile) {
  if (deployLogFile) {
    try { fs.mkdirSync(path.dirname(deployLogFile), { recursive: true }); } catch {}
  }
  const out = fs.createWriteStream(stdoutFile, { flags: "a" });
  const err = fs.createWriteStream(stderrFile, { flags: "a" });
  child.stdout?.on("data", (chunk) => {
    out.write(chunk);
    if (deployLogFile) fs.appendFileSync(deployLogFile, chunk);
  });
  child.stderr?.on("data", (chunk) => {
    err.write(chunk);
    if (deployLogFile) fs.appendFileSync(deployLogFile, chunk);
  });
  child.on("close", () => {
    out.end();
    err.end();
  });
}

export async function startIsolatedRuntime(options = {}) {
  const deploymentFiles = getDeploymentFiles();
  resetDeploymentState({
    usingBundledRuntime: true,
  });

  try {
    const appPaths = resolveAppPaths(options);
    const runtime = resolveRuntimePaths();
    const pawPalsPort = await resolveAppPort();
    const serverEntry = appPaths.serverEntry;
    const tsxCli = resolveTsxCli(appPaths);

    markDeploymentStep("preflight", `Found runtime files in ${appPaths.unpackedRoot}`);

    if (!serverEntry) {
      throw new Error("PawPals packaged runtime files are incomplete. Rebuild the desktop bundle.");
    }

    const childEnv = {
      ...process.env,
      PAWPALS_APP_ROOT: appPaths.repoRoot,
      PAWPALS_APP_UNPACKED_ROOT: appPaths.unpackedRoot,
      PAWPALS_HOME: runtime.pawPalsHome,
      PAWPALS_WORKSPACE: runtime.workspaceRoot,
      PAWPALS_COOKIE_DIR: runtime.cookieDir,
      PAWPALS_PORT: pawPalsPort,
    };

    const spawnCwd = appPaths.unpackedRoot;

    fs.mkdirSync(runtime.pawPalsHome, { recursive: true });
    fs.mkdirSync(runtime.workspaceRoot, { recursive: true });

    markDeploymentStep("app-server", `Starting PawPals app server on http://127.0.0.1:${childEnv.PAWPALS_PORT}`);
    const server = spawnNodeScript(tsxCli, [serverEntry], {
      cwd: spawnCwd,
      env: {
        ...childEnv,
        NODE_ENV: options.production ? "production" : (process.env.NODE_ENV || "development"),
      },
      stdio: options.stdio ? options.stdio : ["ignore", "pipe", "pipe"],
    });
    if (!options.stdio) {
      pipeChildLogs(server, deploymentFiles.serverLogFile, deploymentFiles.serverErrFile, deploymentFiles.logFile);
    }

    const appUrl = `http://127.0.0.1:${childEnv.PAWPALS_PORT}`;
    await waitForUrl(`${appUrl}/api/health`, 30000);
    markDeploymentReady({
      appUrl,
      appPort: childEnv.PAWPALS_PORT,
    });

    const stop = () => {
      if (!server.killed) server.kill("SIGTERM");
    };

    return {
      runtime,
      appUrl,
      server,
      stop,
    };
  } catch (error) {
    markDeploymentFailed(error);
    throw error;
  }
}
