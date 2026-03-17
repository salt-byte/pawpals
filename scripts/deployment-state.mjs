import fs from "fs";
import path from "path";
import { resolveRuntimePaths } from "./runtime-paths.mjs";

function ensureDir(dir) {
  fs.mkdirSync(dir, { recursive: true });
}

export function getDeploymentFiles() {
  const runtime = resolveRuntimePaths();
  const stateFile = path.join(runtime.pawPalsHome, "deployment-state.json");
  const firstRunFile = path.join(runtime.pawPalsHome, "first-run-complete");
  const logFile = path.join(runtime.pawPalsHome, "deployment.log");
  const serverLogFile = path.join(runtime.pawPalsHome, "pawpals-server.log");
  const serverErrFile = path.join(runtime.pawPalsHome, "pawpals-server.err.log");
  const gatewayLogFile = path.join(runtime.pawPalsHome, "pawpals-gateway.log");
  const gatewayErrFile = path.join(runtime.pawPalsHome, "pawpals-gateway.err.log");
  return { ...runtime, stateFile, firstRunFile, logFile, serverLogFile, serverErrFile, gatewayLogFile, gatewayErrFile };
}

function readState(stateFile) {
  try {
    if (!fs.existsSync(stateFile)) return {};
    return JSON.parse(fs.readFileSync(stateFile, "utf8"));
  } catch {
    return {};
  }
}

export function updateDeploymentState(patch) {
  const { pawPalsHome, stateFile } = getDeploymentFiles();
  ensureDir(pawPalsHome);
  const current = readState(stateFile);
  const next = {
    ...current,
    ...patch,
    updatedAt: new Date().toISOString(),
  };
  fs.writeFileSync(stateFile, `${JSON.stringify(next, null, 2)}\n`, "utf8");
  return next;
}

export function resetDeploymentState(initial = {}) {
  const { pawPalsHome, logFile } = getDeploymentFiles();
  ensureDir(pawPalsHome);
  fs.writeFileSync(logFile, "", "utf8");
  return updateDeploymentState({
    status: "running",
    phase: "preflight",
    error: null,
    deployed: false,
    ...initial,
  });
}

export function appendDeploymentLog(line) {
  const { pawPalsHome, logFile } = getDeploymentFiles();
  ensureDir(pawPalsHome);
  const timestamp = new Date().toISOString();
  fs.appendFileSync(logFile, `[${timestamp}] ${line}\n`, "utf8");
}

export function markDeploymentStep(phase, line, patch = {}) {
  appendDeploymentLog(line);
  return updateDeploymentState({
    phase,
    status: "running",
    ...patch,
  });
}

export function markDeploymentReady(patch = {}) {
  appendDeploymentLog("PawPals local engine is ready.");
  return updateDeploymentState({
    status: "ready",
    phase: "ready",
    deployed: true,
    deployedAt: new Date().toISOString(),
    error: null,
    ...patch,
  });
}

export function markDeploymentFailed(error) {
  const message = error instanceof Error ? error.message : String(error || "Unknown deployment error");
  appendDeploymentLog(`Deployment failed: ${message}`);
  return updateDeploymentState({
    status: "error",
    phase: "error",
    error: message,
  });
}
