import { describe, it, expect, vi } from "vitest";
import { registerOfficialRoutes, type OfficialRouteDeps } from "./official-routes.ts";
import { OfficialApplicationQueue } from "./official-application-queue.ts";

/**
 * 这个文件此前不存在——Task 4 把 `deps.queue` 从一个队列实例改成了取当前用户
 * 队列的 getter，五处调用点全部改成 `deps.queue()`，但没有任何测试盯着这件事。
 * tsc 看不出「getter 在注册时被捕获一次」和「每次请求都调用一次」的区别；而
 * 前者正是两个用户的投递任务互相串号的形状。
 *
 * 用一个记录 handler 的假 app 直接调用路由，不起真的 Express/HTTP。
 */

type FakeRes = {
  statusCode: number;
  body: unknown;
  status(code: number): FakeRes;
  json(payload: unknown): FakeRes;
};

function createRes(): FakeRes {
  return {
    statusCode: 200,
    body: undefined,
    status(code: number) { this.statusCode = code; return this; },
    json(payload: unknown) { this.body = payload; return this; },
  };
}

function createFakeApp() {
  const routes = new Map<string, (req: any, res: any) => unknown>();
  return {
    get(path: string, handler: (req: any, res: any) => unknown) { routes.set(`GET ${path}`, handler); },
    post(path: string, handler: (req: any, res: any) => unknown) { routes.set(`POST ${path}`, handler); },
    routes,
  };
}

function makeDeps(app: ReturnType<typeof createFakeApp>, queue: OfficialRouteDeps["queue"], currentUserId: OfficialRouteDeps["currentUserId"] = () => "A"): OfficialRouteDeps {
  return {
    app,
    queue,
    hub: { sendRawToUser: vi.fn(() => 0), sendToUser: vi.fn(() => 1) },
    enqueueOfficialTask: vi.fn(),
    parseRequestedKind: vi.fn(),
    setActivePage: vi.fn(),
    log: vi.fn(),
    currentUserId,
  };
}

describe("registerOfficialRoutes - queue 是每请求调用的 getter", () => {
  it("A 队列入队的任务，getter 切到 B 队列后查不到——不会跨用户串号", () => {
    const queueA = new OfficialApplicationQueue();
    const queueB = new OfficialApplicationQueue();
    let current = queueA;
    const app = createFakeApp();
    const deps = makeDeps(app, () => current);
    registerOfficialRoutes(deps);

    const task = queueA.enqueue({ kind: "inspect", url: "https://a.com/apply", company: "A公司", title: "" });

    const statusHandler = app.routes.get("GET /api/official-applications/:taskId/status")!;

    const res1 = createRes();
    statusHandler({ params: { taskId: task.id } }, res1);
    expect(res1.statusCode).toBe(200);
    expect((res1.body as any).status.id).toBe(task.id);

    // getter 换成另一个用户的队列——如果 deps.queue 在注册时被捕获过一次，
    // 这里仍会读到 queueA，测试就发现不了问题。
    current = queueB;

    const res2 = createRes();
    statusHandler({ params: { taskId: task.id } }, res2);
    expect(res2.statusCode).toBe(404);
    expect(res2.body).toEqual({ ok: false, error: "任务不存在" });
  });
});

describe("registerOfficialRoutes - confirm 路由", () => {
  it("confirm 消费 getter 返回的当前队列，创建的是 submit 任务，且落在同一个队列上", () => {
    const queueA = new OfficialApplicationQueue();
    const app = createFakeApp();
    const deps = makeDeps(app, () => queueA);
    registerOfficialRoutes(deps);

    const confirmationId = queueA.requestConfirmation({ url: "https://a.com/apply", company: "A公司", title: "投递" });

    const confirmHandler = app.routes.get("POST /api/official-applications/:confirmationId/confirm")!;
    const res = createRes();
    confirmHandler({ params: { confirmationId } }, res);

    expect(res.statusCode).toBe(200);
    const body = res.body as any;
    expect(body.ok).toBe(true);
    expect(body.task.kind).toBe("submit");

    // 这个 submit 任务必须真的落在 getter 返回的那个队列上（queueA），
    // 而不是别的实例——next() 能领到它就是证据。
    const dispatched = queueA.next();
    expect(dispatched?.id).toBe(body.task.id);
    expect(deps.hub.sendToUser).toHaveBeenCalledWith("A", body.task);
  });

  it("未知的确认 id 返回 404，不创建任何任务", () => {
    const queueA = new OfficialApplicationQueue();
    const app = createFakeApp();
    const deps = makeDeps(app, () => queueA);
    registerOfficialRoutes(deps);

    const confirmHandler = app.routes.get("POST /api/official-applications/:confirmationId/confirm")!;
    const res = createRes();
    confirmHandler({ params: { confirmationId: "confirm_does_not_exist" } }, res);

    expect(res.statusCode).toBe(404);
    expect(res.body).toEqual({ ok: false, error: "确认已过期、被取消或不存在" });
    expect(queueA.next()).toBeNull();
    expect(deps.hub.sendToUser).not.toHaveBeenCalled();
  });

  it("确认 id 用过一次之后不能重复使用", () => {
    const queueA = new OfficialApplicationQueue();
    const app = createFakeApp();
    const deps = makeDeps(app, () => queueA);
    registerOfficialRoutes(deps);

    const confirmationId = queueA.requestConfirmation({ url: "https://a.com/apply", company: "A公司", title: "投递" });
    const confirmHandler = app.routes.get("POST /api/official-applications/:confirmationId/confirm")!;

    const res1 = createRes();
    confirmHandler({ params: { confirmationId } }, res1);
    expect((res1.body as any).ok).toBe(true);

    const res2 = createRes();
    confirmHandler({ params: { confirmationId } }, res2);
    expect(res2.statusCode).toBe(404);
    expect((res2.body as any).ok).toBe(false);
  });

  /**
   * confirm 造出的是 submit——投递流程里最硬的那道闸。这里证明它按
   * currentUserId() 定向：只发给确认这次投递的用户，绝不发给别人。broadcast
   * 版本会把 A 的 submit 任务连姓名电话简历一起写进 B 的浏览器、由 B 的登录态
   * 提交，这个测试盯的就是这条回归。
   */
  it("confirm 只把 submit 任务发给发起确认的用户，不发给任何其他人", () => {
    const queueA = new OfficialApplicationQueue();
    const app = createFakeApp();
    const sentTo: Record<string, unknown[]> = { A: [], B: [] };
    const hub = {
      sendRawToUser: vi.fn(() => 0),
      sendToUser: vi.fn((userId: string, task: unknown) => {
        (sentTo[userId] ??= []).push(task);
        return 1;
      }),
    };
    const deps: OfficialRouteDeps = {
      app,
      queue: () => queueA,
      hub,
      enqueueOfficialTask: vi.fn(),
      parseRequestedKind: vi.fn(),
      setActivePage: vi.fn(),
      log: vi.fn(),
      currentUserId: () => "A",
    };
    registerOfficialRoutes(deps);

    const confirmationId = queueA.requestConfirmation({ url: "https://a.com/apply", company: "A公司", title: "投递" });
    const confirmHandler = app.routes.get("POST /api/official-applications/:confirmationId/confirm")!;
    const res = createRes();
    confirmHandler({ params: { confirmationId } }, res);

    expect(res.statusCode).toBe(200);
    expect(hub.sendToUser).toHaveBeenCalledTimes(1);
    expect(hub.sendToUser).toHaveBeenCalledWith("A", expect.objectContaining({ kind: "submit" }));
    expect(sentTo.A).toHaveLength(1);
    expect(sentTo.B).toHaveLength(0);
  });

  it("认不出当前用户时 confirm 不下发任务——宁可不发，也不能广播给不知道是谁的连接", () => {
    const queueA = new OfficialApplicationQueue();
    const app = createFakeApp();
    const deps = makeDeps(app, () => queueA, () => null);
    registerOfficialRoutes(deps);

    const confirmationId = queueA.requestConfirmation({ url: "https://a.com/apply", company: "A公司", title: "投递" });
    const confirmHandler = app.routes.get("POST /api/official-applications/:confirmationId/confirm")!;
    const res = createRes();
    confirmHandler({ params: { confirmationId } }, res);

    expect(res.statusCode).toBe(200);
    expect((res.body as any).delivered).toBe(0);
    expect(deps.hub.sendToUser).not.toHaveBeenCalled();
  });
});
