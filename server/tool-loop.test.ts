import { describe, it, expect } from "vitest";
import { runToolLoop } from "./tool-loop.ts";

/**
 * 工具调用循环。
 *
 * 之前工具是**正则触发**的：用户消息匹配 /投递|帮.*投/ 就调 apply_job，结果拼成
 * 文本塞进 prompt。模型从头到尾没选过工具。这一层换成模型自己选。
 *
 * 但工具里有不可逆的东西（网申提交），所以这个循环的重点不是「让模型自由」，
 * 是**让模型选、让代码决定能不能执行**：
 *   1. 工具名是白名单，不认识的拒绝执行，不做「尽力照做」
 *   2. 每个 agent 只能用分配给它的工具——投递管家能投递，简历专家不能
 *   3. 轮数有上限，不能无限调下去
 *   4. submit 类的动作**永远不在工具表里**，模型看不见也就选不了
 */
function harness(over: any = {}) {
  const executed: Array<{ name: string; args: any }> = [];
  const replies: any[] = over.replies ?? [];
  let turn = 0;
  return {
    executed,
    run: (o: any = {}) =>
      runToolLoop({
        messages: [{ role: "user", content: "帮我投递帆软" }],
        tools: over.tools ?? [{ name: "apply_job", description: "投递", parameters: {} }],
        allowed: over.allowed ?? ["apply_job"],
        callModel: async () => replies[turn++] ?? { content: "好了" },
        executeTool: async (name: string, args: any) => {
          executed.push({ name, args });
          return `已执行 ${name}`;
        },
        maxRounds: over.maxRounds ?? 3,
        ...o,
      }),
  };
}

describe("runToolLoop", () => {
  it("模型选了工具就执行，结果回给它，再让它作答", async () => {
    const h = harness({
      replies: [
        { toolCalls: [{ id: "c1", name: "apply_job", args: { job_url: "https://a.com" } }] },
        { content: "已经帮你填好了，请核对" },
      ],
    });
    const out = await h.run();
    expect(h.executed).toEqual([{ name: "apply_job", args: { job_url: "https://a.com" } }]);
    expect(out.content).toBe("已经帮你填好了，请核对");
  });

  it("模型不调工具时直接返回它的话", async () => {
    const h = harness({ replies: [{ content: "你想投哪个岗位？" }] });
    const out = await h.run();
    expect(h.executed).toEqual([]);
    expect(out.content).toBe("你想投哪个岗位？");
  });

  it("不在白名单的工具**拒绝执行**，并把拒绝原因告诉模型", async () => {
    const h = harness({
      replies: [
        { toolCalls: [{ id: "c1", name: "submit_application", args: {} }] },
        { content: "好的，我不提交" },
      ],
    });
    const out = await h.run();
    expect(h.executed).toEqual([]);
    expect(out.rejected).toContainEqual({ name: "submit_application", reason: "not_allowed" });
  });

  it("这个 agent 没被分配的工具也拒绝——投递管家能投，简历专家不能", async () => {
    const h = harness({
      tools: [{ name: "apply_job", description: "", parameters: {} }],
      allowed: [],   // 这个 agent 一个工具都没有
      replies: [{ toolCalls: [{ id: "c1", name: "apply_job", args: {} }] }, { content: "我不能投递" }],
    });
    await h.run();
    expect(h.executed).toEqual([]);
  });

  it("轮数有上限——模型一直调工具也会停", async () => {
    const h = harness({
      maxRounds: 2,
      replies: Array.from({ length: 9 }, () => ({ toolCalls: [{ id: "c", name: "apply_job", args: {} }] })),
    });
    const out = await h.run();
    expect(h.executed.length).toBeLessThanOrEqual(2);
    expect(out.stoppedBy).toBe("max_rounds");
  });

  it("一次选多个工具，按顺序执行", async () => {
    const h = harness({
      tools: [
        { name: "apply_job", description: "", parameters: {} },
        { name: "read_jobs", description: "", parameters: {} },
      ],
      allowed: ["apply_job", "read_jobs"],
      replies: [
        { toolCalls: [
          { id: "c1", name: "read_jobs", args: {} },
          { id: "c2", name: "apply_job", args: { job_url: "https://a.com" } },
        ] },
        { content: "都做完了" },
      ],
    });
    await h.run();
    expect(h.executed.map((e) => e.name)).toEqual(["read_jobs", "apply_job"]);
  });

  it("工具执行抛错不会让整轮崩掉——把错误告诉模型让它接着说", async () => {
    const h = harness({
      replies: [{ toolCalls: [{ id: "c1", name: "apply_job", args: {} }] }, { content: "投递失败了，原因是…" }],
    });
    const out = await h.run({
      executeTool: async () => { throw new Error("扩展没连上"); },
    });
    expect(out.content).toContain("投递失败");
  });
});

/**
 * 写回历史的工具调用必须是接口认的形状。
 *
 * 真机 400「Request contains an invalid argument」：第一轮好好的，第二轮就炸。
 * 因为把工具调用记回对话历史时用的是循环内部的简化形状 {id, name, args}，而接口
 * 要的是 OpenAI 原始格式 {id, type:"function", function:{name, arguments}}——
 * arguments 还得是 JSON **字符串**，不是对象。
 *
 * 单测里 callModel 是假的，怎么写都不会报错，所以这一条必须显式断言形状。
 */
describe("写回历史的形状", () => {
  it("assistant 消息里的 tool_calls 用 OpenAI 原始格式", async () => {
    const seen: any[] = [];
    await runToolLoop({
      messages: [{ role: "user", content: "投递" }],
      tools: [{ name: "apply_job", description: "", parameters: {} }],
      allowed: ["apply_job"],
      callModel: async (history) => {
        seen.push(history);
        return seen.length === 1
          ? { toolCalls: [{ id: "c1", name: "apply_job", args: { job_url: "https://a.com" } }] }
          : { content: "好了" };
      },
      executeTool: async () => "done",
      maxRounds: 3,
    });

    const second = seen[1];
    const assistant = second.find((m: any) => m.role === "assistant");
    expect(assistant.tool_calls[0]).toEqual({
      id: "c1",
      type: "function",
      function: { name: "apply_job", arguments: '{"job_url":"https://a.com"}' },
    });
    // tool 结果消息也要带上 tool_call_id，接口靠它对上是哪一次调用
    const toolMsg = second.find((m: any) => m.role === "tool");
    expect(toolMsg).toMatchObject({ tool_call_id: "c1", content: "done" });
  });
});
