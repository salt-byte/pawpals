/**
 * 扩展 WebSocket 的用户上下文——集成测试，不是纯函数测试。
 *
 * 为什么必须起真进程：这个 bug 熬过了十三轮评审，正是因为纯函数测试**结构上够
 * 不着它**。`ws.on("message")` 丢不丢上下文，取决于 ws 内部怎么调度每一帧，
 * 任何手写的假 socket 都会「继承」调用方的 AsyncLocalStorage，于是坏代码照样
 * 绿灯。所以这里 spawn 真的 server.ts、连真的 WebSocket、走真的握手。
 *
 * ── 这条测试覆盖什么 ──
 * 单人模式下，扩展经 WebSocket 回报结果时 `officialQueue.complete()` 确实跑到了
 * （表现为结果端点从 404 变成 200），并且进程还活着。
 *
 * ── 不覆盖什么（老实说清） ──
 * - 多用户模式：需要注册账号 + 配对 token，那是另一条握手路径。上下文丢失的机制
 *   与模式无关（单人模式那层 runWithUser(LOCAL_USER_ID) 一样传不进来），所以这里
 *   用成本最低的单人模式来钉住它。
 * - 不校验「结果没串到别的用户」——那是 official-socket.test.ts 的事。
 * - 不跑真实投递（submit 需要确认令牌），用 inspect 任务代表整条回报链路。
 */
import { describe, it, expect, afterEach } from "vitest";
import { spawn, type ChildProcess } from "node:child_process";
import { createServer } from "node:net";
import { mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { WebSocket } from "ws";

const REPO_ROOT = path.resolve(import.meta.dirname, "..");

function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const s = createServer();
    s.on("error", reject);
    s.listen(0, "127.0.0.1", () => {
      const port = (s.address() as any).port;
      s.close(() => resolve(port));
    });
  });
}

type Booted = { child: ChildProcess; port: number; home: string; log: () => string };

async function bootServer(): Promise<Booted> {
  const port = await freePort();
  const home = mkdtempSync(path.join(os.tmpdir(), "pawpals-ws-ctx-"));
  const child = spawn("npx", ["tsx", "server.ts"], {
    cwd: REPO_ROOT,
    env: {
      ...process.env,
      PAWPALS_HOME: home,
      PAWPALS_BACKUP_DIR: path.join(home, "backup"),
      PAWPALS_PORT: String(port),
      // 这两个会去敲外部世界（gog CLI、~/Documents），测试里一律关掉
      PAWPALS_MAIL_WATCHER_DISABLED: "true",
      PAWPALS_MULTI_USER: "",
    },
    stdio: ["ignore", "pipe", "pipe"],
  });
  let out = "";
  child.stdout!.on("data", (b) => { out += String(b); });
  child.stderr!.on("data", (b) => { out += String(b); });

  const deadline = Date.now() + 60_000;
  while (Date.now() < deadline) {
    if (out.includes(`Server running on http://localhost:${port}`)) {
      return { child, port, home, log: () => out };
    }
    if (child.exitCode !== null) throw new Error(`服务端启动即退出：\n${out}`);
    await new Promise((r) => setTimeout(r, 200));
  }
  throw new Error(`服务端 60 秒内没起来：\n${out}`);
}

let booted: Booted | null = null;

afterEach(() => {
  if (booted) {
    booted.child.kill("SIGKILL");
    try { rmSync(booted.home, { recursive: true, force: true }); } catch { /* 清不掉就算了 */ }
    booted = null;
  }
});

describe("扩展 WebSocket 的 message 回调（真进程 + 真 ws）", () => {
  it("回报结果时 officialQueue.complete() 真的跑了，进程没死", async () => {
    booted = await bootServer();
    const { port, child } = booted;
    const base = `http://127.0.0.1:${port}`;

    // 1) 扩展连上来（单人模式握手不需要 token，认成 local）
    const ws = new WebSocket(`ws://127.0.0.1:${port}/ws/official`);
    const taskFrames: any[] = [];
    await new Promise<void>((resolve, reject) => {
      ws.on("open", () => resolve());
      ws.on("error", reject);
    });
    ws.on("message", (raw) => {
      try {
        const m = JSON.parse(String(raw));
        if (m?.type === "task" && m?.task) taskFrames.push(m.task);
      } catch { /* 不是我们要的帧 */ }
    });

    // 2) 派一个任务出去，应该经 WebSocket 推到刚连上的这条
    const prepared = await fetch(`${base}/api/official-applications/prepare`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ url: "https://example.com/jobs/1", company: "示例公司", title: "示例岗位", kind: "inspect" }),
    }).then((r) => r.json() as any);
    expect(prepared.ok).toBe(true);
    const taskId: string = prepared.task.id;

    const gotTask = await waitFor(() => taskFrames.find((t) => t.id === taskId), 10_000);
    expect(gotTask, "任务没有经 WebSocket 推到扩展").toBeTruthy();

    // 3) 扩展回报结果——这一帧就是出事的地方
    ws.send(JSON.stringify({ type: "result", id: taskId, result: { ok: true, fields: [{ label: "姓名" }] } }));

    // 4) complete() 跑了才会有结果可读；没跑就是 404（服务端要么已经死了，
    //    要么活着但把这次真实提交的结果丢了 = 调用方会等到「超时」）
    const result = await waitFor(async () => {
      const r = await fetch(`${base}/api/official-applications/${taskId}/result`);
      if (r.status !== 200) return undefined;
      return (await r.json()) as any;
    }, 15_000);

    expect(result, `complete() 没有跑到，结果端点始终不是 200。服务端日志：\n${booted!.log()}`).toBeTruthy();
    expect(result.ok).toBe(true);
    expect(result.result.fields).toHaveLength(1);

    // 5) 进程必须还活着：一个用户的插件回一帧就把所有人的会话带走是最坏的结局
    expect(child.exitCode, `服务端进程退出了（code=${child.exitCode}）。日志：\n${booted!.log()}`).toBe(null);

    ws.close();
  }, 120_000);
});

/**
 * 轮询到有值为止。
 *
 * probe 抛错要当成「还没有」而不是让测试炸在这里：坏代码下服务端进程会**直接
 * 退出**，于是 fetch 抛 ECONNRESET——那是本次失败的症状，不是测试自身的故障，
 * 咽下去才能走到下面那句带服务端日志的断言。
 */
async function waitFor<T>(probe: () => T | Promise<T>, timeoutMs: number): Promise<T | undefined> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const v = await probe();
      if (v) return v;
    } catch { /* 服务端可能刚死，继续等到超时，由断言报出真正的原因 */ }
    await new Promise((r) => setTimeout(r, 200));
  }
  return undefined;
}
