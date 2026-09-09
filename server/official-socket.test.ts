import { describe, it, expect, vi } from "vitest";
import { createTaskBroadcaster, parseClientMessage, OPEN } from "./official-socket.ts";

const task = { id: "official_1", kind: "inspect", url: "https://acme.mokahr.com/apply/1" };

function fakeClient(readyState = OPEN) {
  return { readyState, send: vi.fn(), sent: [] as string[] };
}

describe("createTaskBroadcaster（按用户定向）", () => {
  it("发给 A 的任务不会到达 B——这是多用户下最硬的一条", () => {
    const hub = createTaskBroadcaster();
    const a = fakeClient();
    const b = fakeClient();
    hub.add("A", a);
    hub.add("B", b);

    expect(hub.sendToUser("A", task)).toBe(1);
    expect(JSON.parse(a.send.mock.calls[0][0])).toEqual({ type: "task", task });
    expect(b.send).not.toHaveBeenCalled();
  });

  it("该用户没有插件在线时返回 0——任务留在队列里等重连补发", () => {
    const hub = createTaskBroadcaster();
    hub.add("B", fakeClient());
    expect(hub.sendToUser("A", task)).toBe(0);
    expect(hub.size("A")).toBe(0);
    expect(hub.size("B")).toBe(1);
  });

  it("同一用户两条连接只发最近活跃的一条——两台电脑同时执行等于重复提交", () => {
    let t = 0;
    const hub = createTaskBroadcaster({ now: () => t });
    const older = fakeClient();
    const newer = fakeClient();
    t = 1; hub.add("A", older);
    t = 2; hub.add("A", newer);

    expect(hub.sendToUser("A", task)).toBe(1);
    expect(newer.send).toHaveBeenCalledTimes(1);
    expect(older.send).not.toHaveBeenCalled();

    // older 上收到消息后它成了最近活跃的
    t = 3; hub.touch(older);
    expect(hub.sendToUser("A", task)).toBe(1);
    expect(older.send).toHaveBeenCalledTimes(1);
    expect(newer.send).toHaveBeenCalledTimes(1);
  });

  it("最近活跃的那条已关闭时退到下一条，并把死连接清掉", () => {
    let t = 0;
    const hub = createTaskBroadcaster({ now: () => t });
    const live = fakeClient();
    const dead = fakeClient(3); // CLOSED
    t = 1; hub.add("A", live);
    t = 2; hub.add("A", dead);

    expect(hub.sendToUser("A", task)).toBe(1);
    expect(live.send).toHaveBeenCalledTimes(1);
    expect(hub.size("A")).toBe(1);
  });

  it("send 抛错的连接清掉并退到下一条", () => {
    let t = 0;
    const hub = createTaskBroadcaster({ now: () => t });
    const live = fakeClient();
    const broken = fakeClient();
    broken.send.mockImplementation(() => { throw new Error("socket gone"); });
    t = 1; hub.add("A", live);
    t = 2; hub.add("A", broken);

    expect(hub.sendToUser("A", task)).toBe(1);
    expect(live.send).toHaveBeenCalledTimes(1);
    expect(hub.size("A")).toBe(1);
  });

  it("remove 之后不再收到推送；size() 不带参数时是全体在线数", () => {
    const hub = createTaskBroadcaster();
    const client = fakeClient();
    hub.add("A", client);
    hub.add("B", fakeClient());
    expect(hub.size()).toBe(2);
    hub.remove(client);
    expect(hub.sendToUser("A", task)).toBe(0);
    expect(hub.size()).toBe(1);
  });

  it("同一个客户端加两次只算一个", () => {
    const hub = createTaskBroadcaster();
    const client = fakeClient();
    hub.add("A", client);
    hub.add("A", client);
    expect(hub.size("A")).toBe(1);
  });

  it("同一用户开两条连接时 size(userId) 如实返回 2——server.ts 连接处理的补发闸门就靠这个数判断是不是唯一连接", () => {
    const hub = createTaskBroadcaster();
    hub.add("A", fakeClient());
    hub.add("A", fakeClient());
    expect(hub.size("A")).toBe(2);
  });
});

describe("parseClientMessage", () => {
  it("解析不结掉任务的进度帧", () => {
    expect(parseClientMessage(JSON.stringify({ type: "progress", id: "official_1", progress: { stage: "probing", completed: 2, total: 15 } }))).toEqual({
      type: "progress", id: "official_1", progress: { stage: "probing", completed: 2, total: 15 },
    });
  });

  it("进度必须是对象，避免垃圾帧污染任务状态", () => {
    expect(parseClientMessage(JSON.stringify({ type: "progress", id: "official_1", progress: "almost" }))).toBeNull();
  });

  it("解析扩展回报的任务结果", () => {
    const raw = JSON.stringify({ type: "result", id: "official_1", result: { ok: true, provider: "moka" } });
    expect(parseClientMessage(raw)).toEqual({
      type: "result",
      id: "official_1",
      result: { ok: true, provider: "moka" },
    });
  });

  it("非法 JSON 返回 null，不抛错——socket 上什么都可能来", () => {
    expect(parseClientMessage("не json")).toBe(null);
    expect(parseClientMessage("")).toBe(null);
  });

  it("缺 id 或 type 不对一律返回 null", () => {
    expect(parseClientMessage(JSON.stringify({ type: "result", result: { ok: true } }))).toBe(null);
    expect(parseClientMessage(JSON.stringify({ type: "hello", id: "x" }))).toBe(null);
  });

  it("没带 result 时补一个失败结果——任务必须被结掉，否则队列被永久堵住", () => {
    expect(parseClientMessage(JSON.stringify({ type: "result", id: "official_1" }))).toEqual({
      type: "result",
      id: "official_1",
      result: { ok: false, error: "扩展未返回结果" },
    });
  });

  it("Buffer 形式的帧也能解析——ws 在非 text 帧下给的是 Buffer", () => {
    const raw = Buffer.from(JSON.stringify({ type: "result", id: "official_1", result: { ok: true } }));
    expect(parseClientMessage(raw)).toMatchObject({ id: "official_1" });
  });
});

/**
 * 裸消息通道。
 *
 * broadcast 固定把内容包成 {type:"task", task}，那是任务专用的形状。开发期的
 * 「重载扩展」命令不是任务，包成任务会被扩展当成任务去派发。
 */
describe("sendRawToUser", () => {
  it("原样发出去，不套 task 外壳，且只发给该用户", () => {
    const hub = createTaskBroadcaster();
    const sentA: string[] = [];
    const sentB: string[] = [];
    hub.add("A", { readyState: 1, send: (m: string) => sentA.push(m) } as any);
    hub.add("B", { readyState: 1, send: (m: string) => sentB.push(m) } as any);
    expect(hub.sendRawToUser("A", { type: "reload" })).toBe(1);
    expect(JSON.parse(sentA[0])).toEqual({ type: "reload" });
    expect(sentB).toEqual([]);
  });
});
