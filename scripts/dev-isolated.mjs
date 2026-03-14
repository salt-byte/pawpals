import { startIsolatedRuntime } from "./runtime-launcher.mjs";

const runtime = await startIsolatedRuntime({ stdio: "inherit" });

const shutdown = () => runtime.stop();
process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);
runtime.server.on("exit", (code) => {
  runtime.stop();
  process.exit(code ?? 0);
});
runtime.gateway.on("exit", (code) => {
  runtime.stop();
  process.exit(code ?? 0);
});
