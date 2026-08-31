import os from "os";
import path from "path";

export function resolvePawPalsHome() {
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

export function resolveRuntimePaths() {
  const pawPalsHome = resolvePawPalsHome();
  const workspaceRoot = process.env.PAWPALS_WORKSPACE || path.join(pawPalsHome, "workspace", "career");
  const cookieDir = process.env.PAWPALS_COOKIE_DIR || path.join(pawPalsHome, "jobclaw", "cookies");

  return {
    pawPalsHome,
    workspaceRoot,
    cookieDir,
  };
}
