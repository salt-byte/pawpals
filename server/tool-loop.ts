/**
 * 工具调用循环：让模型自己选工具，由代码决定能不能执行。
 *
 * 之前工具是**正则触发**的——用户消息匹配 /投递|帮.*投/ 就调 apply_job，结果拼成
 * 文本塞进 prompt。模型从头到尾没选过工具，所谓「agent」在工具这一层只是条件语句。
 *
 * 换成模型自选之后，重点不是「让模型自由」，而是把两件事分开：
 *
 *     模型决定做什么          代码决定什么被允许
 *
 * 这个产品的工具里有不可逆的动作（网申提交一次就留在别人的招聘系统里），所以
 * 循环本身要带四道约束，而且都在执行之前：
 *
 *   1. 工具名是白名单。不认识的**拒绝执行**，不做「尽力照做」——模型回一个
 *      submit_application 而我们照做，后果撤不回来。
 *   2. 每个 agent 只能用分配给它的工具。投递管家能投递，简历专家不能。
 *   3. 轮数有上限。模型可能一直调下去。
 *   4. 提交类动作**永远不出现在工具表里**——模型看不见，也就选不了。真正的提交
 *      只能由用户确认后的一次性令牌产生（见 official-application-queue）。
 */
export type ToolSpec = { name: string; description: string; parameters: Record<string, unknown> };

export type ToolCall = {
  id: string;
  name: string;
  args: Record<string, unknown>;
  /**
   * 服务端返回的原始工具调用对象。有就原样回放，没有才自己拼。
   *
   * Gemini 会在 extra_content.google.thought_signature 里塞一段不透明签名，
   * 回放时少了它第二轮直接 400。这类 provider 特有的字段不该由循环去理解，
   * 原样带回去就好。
   */
  raw?: unknown;
};

export type ModelReply = { content?: string; toolCalls?: ToolCall[] };

export type ToolLoopResult = {
  content: string;
  /** 实际执行过的工具，按顺序。 */
  executed: Array<{ name: string; result: string }>;
  /** 被拦下的工具调用，带原因。上报给用户，不静默。 */
  rejected: Array<{ name: string; reason: string }>;
  stoppedBy: "model" | "max_rounds";
  rounds: number;
};

export async function runToolLoop(input: {
  messages: Array<{ role: string; content: any; [k: string]: unknown }>;
  /** 交给模型看的工具表。提交类动作绝不放进来。 */
  tools: ToolSpec[];
  /** 这个 agent 被分配到的工具名。tools 之外再收一道。 */
  allowed: string[];
  callModel: (messages: any[], tools: ToolSpec[]) => Promise<ModelReply>;
  executeTool: (name: string, args: Record<string, unknown>) => Promise<string>;
  maxRounds?: number;
}): Promise<ToolLoopResult> {
  const { messages, tools, allowed, callModel, executeTool, maxRounds = 4 } = input;

  const history = [...messages];
  const executed: ToolLoopResult["executed"] = [];
  const rejected: ToolLoopResult["rejected"] = [];
  const allowSet = new Set(allowed ?? []);
  const declared = new Set(tools.map((t) => t.name));

  for (let round = 1; round <= maxRounds; round += 1) {
    const reply = await callModel(history, tools);

    const calls = reply?.toolCalls ?? [];
    if (!calls.length) {
      return { content: String(reply?.content ?? ""), executed, rejected, stoppedBy: "model", rounds: round };
    }

    // 写回历史时必须还原成接口认的 OpenAI 形状：{id, type, function:{name, arguments}}，
    // 且 arguments 是 JSON **字符串**。用循环内部的简化形状 {id, name, args} 写回去，
    // 第一轮不报错、第二轮直接 400（真机上就是这样）。
    history.push({
      role: "assistant",
      content: reply?.content ?? "",
      tool_calls: calls.map((call) =>
        call.raw ?? {
          id: call.id,
          type: "function",
          function: { name: call.name, arguments: JSON.stringify(call.args ?? {}) },
        }
      ),
    });

    for (const call of calls) {
      // 两道白名单：模型看得见的（declared）和这个 agent 被分配的（allowSet）。
      // 两者都过才执行——模型幻觉出一个工具名、或者越权用别人的工具，都挡在这里。
      if (!declared.has(call.name) || !allowSet.has(call.name)) {
        rejected.push({ name: call.name, reason: "not_allowed" });
        history.push({ role: "tool", tool_call_id: call.id, content: `[拒绝] 你没有 ${call.name} 这个工具。` });
        continue;
      }
      try {
        const result = await executeTool(call.name, call.args ?? {});
        executed.push({ name: call.name, result });
        history.push({ role: "tool", tool_call_id: call.id, content: result });
      } catch (error) {
        // 工具挂了不该让整轮崩掉：把错误如实告诉模型，让它跟用户交代
        const message = `[执行失败] ${String((error as any)?.message || error)}`;
        rejected.push({ name: call.name, reason: "execute_failed" });
        history.push({ role: "tool", tool_call_id: call.id, content: message });
      }
    }
  }

  // 轮数用完还在调工具：停下来，如实说明，别无限转
  return {
    content: "",
    executed,
    rejected,
    stoppedBy: "max_rounds",
    rounds: maxRounds,
  };
}
