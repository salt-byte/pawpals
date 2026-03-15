#!/usr/bin/env node
/**
 * PawPals OpenClaw 连接测试工具
 * 通过 OpenClaw gateway 测试每个 provider 的连通性
 *
 * 用法:
 *   node test-api.mjs              # 测试 gateway 健康 + 所有已配置 provider
 *   node test-api.mjs gemini       # 只测某个 provider
 *   node test-api.mjs --direct     # 绕过 gateway，直连每个 provider API
 */
import fs from "fs";
import path from "path";
import os from "os";

// ── 配置 ────────────────────────────────────────────────────────
const GATEWAY = process.env.OPENCLAW_BASE_URL || "http://127.0.0.1:18790";
const args = process.argv.slice(2); // skip node + script path
const DIRECT_MODE = args.includes("--direct");
const filterProvider = args.find((a) => !a.startsWith("-"));

function resolveConfigPath() {
  const pawpalsHome =
    process.env.PAWPALS_HOME ||
    (process.platform === "darwin"
      ? path.join(os.homedir(), "Library", "Application Support", "PawPals")
      : path.join(os.homedir(), ".pawpals"));
  const p1 = path.join(pawpalsHome, "openclaw", "openclaw.json");
  const p2 = path.join(os.homedir(), ".openclaw", "openclaw.json");
  if (fs.existsSync(p1)) return p1;
  if (fs.existsSync(p2)) return p2;
  return null;
}

// ── 读取配置 ────────────────────────────────────────────────────
const configPath = resolveConfigPath();
if (!configPath) {
  console.error("❌ 未找到 openclaw.json，请先完成 PawPals 初始化设置");
  process.exit(1);
}

let config;
try {
  config = JSON.parse(fs.readFileSync(configPath, "utf-8"));
} catch (e) {
  console.error("❌ 读取 openclaw.json 失败:", e.message);
  process.exit(1);
}

const providers = config?.models?.providers || {};

// ── 工具函数 ────────────────────────────────────────────────────
async function fetchWithTimeout(url, opts, timeoutMs = 15000) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const resp = await fetch(url, { ...opts, signal: controller.signal });
    clearTimeout(timer);
    return resp;
  } catch (e) {
    clearTimeout(timer);
    throw e;
  }
}

// ── 1. 检查 Gateway 是否在运行 ───────────────────────────────────
async function checkGateway() {
  try {
    const resp = await fetchWithTimeout(`${GATEWAY}/v1/models`, {}, 5000);
    if (resp.ok) {
      const data = await resp.json().catch(() => ({}));
      const modelCount = data?.data?.length || 0;
      return { ok: true, modelCount };
    }
    return { ok: false, reason: `HTTP ${resp.status}` };
  } catch (e) {
    if (e.name === "AbortError") return { ok: false, reason: "超时" };
    return { ok: false, reason: e.message };
  }
}

// ── 2. 通过 Gateway 测试某个 provider ───────────────────────────
async function testViaGateway(providerName, conf) {
  const models = conf.models || [];
  const firstModel = models[0]?.id;
  if (!firstModel) return { status: "skip", reason: "没有配置模型" };
  if (!conf.apiKey || conf.apiKey.startsWith("${"))
    return { status: "skip", reason: `apiKey 未配置 (${conf.apiKey || "空"})` };

  // OpenClaw 支持 "provider/model" 格式路由
  const modelId = `${providerName}/${firstModel}`;
  const url = `${GATEWAY}/v1/chat/completions`;

  const startTime = Date.now();
  try {
    const resp = await fetchWithTimeout(
      url,
      {
        method: "POST",
        headers: { "Content-Type": "application/json", Authorization: "Bearer openclaw" },
        body: JSON.stringify({
          model: modelId,
          messages: [{ role: "user", content: "Hi, reply with just OK" }],
          max_tokens: 10,
          stream: false,
        }),
      },
      20000
    );
    const elapsed = Date.now() - startTime;
    const data = await resp.json().catch(() => null);

    if (!resp.ok) {
      const errMsg = data?.error?.message || data?.message || JSON.stringify(data)?.slice(0, 200);
      return { status: "fail", reason: `HTTP ${resp.status}: ${errMsg}`, elapsed };
    }
    const reply = data?.choices?.[0]?.message?.content || "(无回复)";
    return { status: "ok", model: modelId, reply, elapsed };
  } catch (e) {
    const elapsed = Date.now() - startTime;
    return {
      status: "fail",
      reason: e.name === "AbortError" ? "超时（20秒无响应）" : e.message,
      elapsed,
    };
  }
}

// ── 3. 直连测试（绕过 gateway） ──────────────────────────────────
async function testDirect(name, conf) {
  const apiKey = conf.apiKey || "";
  const baseUrl = (conf.baseUrl || "").replace(/\/$/, "");
  const models = conf.models || [];
  const firstModel = models[0]?.id;

  if (!apiKey || apiKey.startsWith("${"))
    return { status: "skip", reason: `apiKey 为空或环境变量引用 (${apiKey || "空"})` };
  if (!baseUrl) return { status: "skip", reason: "baseUrl 未配置" };
  if (!firstModel) return { status: "skip", reason: "没有配置模型" };

  const url = `${baseUrl}/chat/completions`;
  const startTime = Date.now();
  try {
    const resp = await fetchWithTimeout(
      url,
      {
        method: "POST",
        headers: { "Content-Type": "application/json", Authorization: `Bearer ${apiKey}` },
        body: JSON.stringify({
          model: firstModel,
          messages: [{ role: "user", content: "Hi, reply with just OK" }],
          max_tokens: 10,
          stream: false,
        }),
      },
      20000
    );
    const elapsed = Date.now() - startTime;
    const data = await resp.json().catch(() => null);

    if (!resp.ok) {
      const errMsg = data?.error?.message || data?.message || JSON.stringify(data)?.slice(0, 200);
      return { status: "fail", reason: `HTTP ${resp.status}: ${errMsg}`, elapsed };
    }
    const reply = data?.choices?.[0]?.message?.content || "(无回复)";
    return { status: "ok", model: firstModel, reply, elapsed };
  } catch (e) {
    const elapsed = Date.now() - startTime;
    return {
      status: "fail",
      reason: e.name === "AbortError" ? "超时（20秒无响应）" : e.message,
      elapsed,
    };
  }
}

// ── 主流程 ──────────────────────────────────────────────────────
console.log("\n🐾 PawPals API 连接测试");
console.log(`📋 配置: ${configPath}`);
console.log(`🌐 Gateway: ${GATEWAY}`);
console.log(`🔧 模式: ${DIRECT_MODE ? "直连 (--direct)" : "通过 OpenClaw gateway"}`);
console.log("─".repeat(65));

// 步骤 1: 检查 Gateway（非 direct 模式）
if (!DIRECT_MODE) {
  process.stdout.write("检查 OpenClaw gateway...");
  const gw = await checkGateway();
  if (gw.ok) {
    console.log(` ✅ 在线 (${gw.modelCount} 个模型)`);
  } else {
    console.log(` ❌ 离线: ${gw.reason}`);
    console.log("\n💡 提示: 先启动 gateway 再测试，或用 --direct 模式绕过 gateway 直连 API");
    console.log(`   运行: cd ~/Downloads/萌爪伴学-\\(pawpals\\) && npm run dev:isolated\n`);
    process.exit(1);
  }
  console.log("─".repeat(65));
}

// 步骤 2: 测试每个 provider
const providerList = filterProvider
  ? [[filterProvider, providers[filterProvider]]]
  : Object.entries(providers);

if (filterProvider && !providers[filterProvider]) {
  console.error(`❌ 未找到 provider: ${filterProvider}`);
  console.log("可用:", Object.keys(providers).join(", "));
  process.exit(1);
}

const results = [];
for (const [name, conf] of providerList) {
  process.stdout.write(`[${name.padEnd(14)}] 测试中...`);
  const result = DIRECT_MODE
    ? await testDirect(name, conf || {})
    : await testViaGateway(name, conf || {});
  results.push({ name, ...result });

  if (result.status === "ok") {
    const replyShort = (result.reply || "").slice(0, 40);
    console.log(`\r[${name.padEnd(14)}] ✅ 成功 ${result.elapsed}ms  "${replyShort}"`);
  } else if (result.status === "fail") {
    console.log(`\r[${name.padEnd(14)}] ❌ 失败  ${result.reason}`);
  } else {
    console.log(`\r[${name.padEnd(14)}] ⏭️  跳过  ${result.reason}`);
  }
}

console.log("─".repeat(65));
const ok = results.filter((r) => r.status === "ok").length;
const fail = results.filter((r) => r.status === "fail").length;
const skip = results.filter((r) => r.status === "skip").length;
console.log(`\n📊 结果: ✅ ${ok} 成功  ❌ ${fail} 失败  ⏭️  ${skip} 跳过\n`);

if (fail > 0) process.exit(1);
