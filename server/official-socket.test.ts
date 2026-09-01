import { describe, it, expect, vi } from "vitest";
import { createTaskBroadcaster, parseClientMessage, OPEN } from "./official-socket.ts";

const task = { id: "official_1", kind: "inspect", url: "https://acme.mokahr.com/apply/1" };

function fakeClient(readyState = OPEN) {
  return { readyState, send: vi.fn(), sent: [] as string[] };
}

describe("createTaskBroadcaster", () => {
  it("把任务推给所有在线的扩展，返回送达数", () => {
    const hub = createTaskBroadcaster();
    const a = fakeClient();
    const b = fakeClient();
    hub.add(a);
    hub.add(b);

    expect(hub.broadcast(task)).toBe(2);
    expect(JSON.parse(a.send.mock.calls[0][0])).toEqual({ type: "task", task });
    expect(b.send).toHaveBeenCalledTimes(1);
  });

  it("没有扩展在线时返回 0——调用方据此知道任务只能等在队列里", () => {
    const hub = createTaskBroadcaster();
    expect(hub.broadcast(task)).toBe(0);
    expect(hub.size()).toBe(0);
  });

  it("连接已经关闭的客户端跳过，并从集合里清掉", () => {
    const hub = createTaskBroadcaster();
    const dead = fakeClient(3); // CLOSED
    const live = fakeClient();
    hub.add(dead);
    hub.add(live);

    expect(hub.broadcast(task)).toBe(1);
    expect(dead.send).not.toHaveBeenCalled();
    expect(hub.size()).toBe(1);
  });

  it("某个客户端 send 抛错不影响其他客户端，并把它清掉", () => {
    const hub = createTaskBroadcaster();
    const broken = fakeClient();
    broken.send.mockImplementation(() => { throw new Error("socket gone"); });
    const live = fakeClient();
    hub.add(broken);
    hub.add(live);

    expect(hub.broadcast(task)).toBe(1);
    expect(live.send).toHaveBeenCalledTimes(1);
    expect(hub.size()).toBe(1);
  });

  it("remove 之后不再收到推送", () => {
    const hub = createTaskBroadcaster();
    const client = fakeClient();
    hub.add(client);
    hub.remove(client);

    expect(hub.broadcast(task)).toBe(0);
    expect(client.send).not.toHaveBeenCalled();
  });

  it("同一个客户端加两次只算一个——重连时不会收到双份", () => {
    const hub = createTaskBroadcaster();
    const client = fakeClient();
    hub.add(client);
    hub.add(client);

    expect(hub.broadcast(task)).toBe(1);
    expect(client.send).toHaveBeenCalledTimes(1);
  });
});

describe("parseClientMessage", () => {
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
