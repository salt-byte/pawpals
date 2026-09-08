/**
 * 单字段的「自己想办法」循环。
 *
 * 手写流程没有恢复能力：填砸了就记下、放弃、往前走。今天真机上这样丢掉的——
 *
 *   本科学校      option_not_found   可页面上明写着「未搜索到学校名称的同学，请搜索
 *                                    "其他"并选择，再填写学校名称」
 *   获奖时间      value_not_applied  换个日期格式就成了
 *   结束时间      想填「至今」，控件转成 1901-01-01
 *   研究生成绩排名 想填「前10%」，实际选中「前5%」
 *
 * 这些恢复策略是开放式的、随页面而变的，为每一种写一个分支永远写不完。给模型
 * 「刚才做了什么、结果是什么、页面现在长什么样、页面写了什么提示」，让它自己决定
 * 下一步——这正是模型比 if-else 强的地方。
 *
 * ── 三条边界，不因为交给模型而松动 ──
 *
 * 1. 尝试次数有上限。这是真实雇主的表单，不能无限试。
 * 2. 动作只能来自固定工具集。不认识的一律**拒绝执行**，不做「尽力照做」——
 *    模型要是回一个 submit_form，照做的后果不可撤销。
 * 3. 成功只以页面回读为准。模型说成了不算，fill 返回 ok 也不算。今天真机上
 *    「有值」和「填对了」差了 6 个字段，其中两个是错误的选项被当成了成功。
 */

export type FieldAction =
  /** source：这个值出自档案原文的哪一段。反编造的闸靠它——引不出原文就不放行。 */
  | { action: "fill"; value: string; source?: string }
  | { action: "search"; value: string; source?: string }
  | { action: "probe" }
  | { action: "give_up"; reason?: string };

const ALLOWED = new Set(["fill", "search", "probe", "give_up"]);

export type FieldTools = {
  /** 探这个控件的可选项。 */
  probe: () => Promise<{ options: string[] }>;
  /** 直接填值；返回页面回读到的实际值。 */
  fill: (value: string) => Promise<{ value: string }>;
  /** 在控件的搜索框里搜再选；返回页面回读到的实际值。 */
  search: (query: string) => Promise<{ value: string }>;
};

export type FieldOutcome = {
  ok: boolean;
  /** 页面上最终的值。 */
  value: string;
  /** 失败时的原因：模型给的、或机械判定的。 */
  reason?: string;
  attempts: number;
};

const strip = (text: unknown) => String(text ?? "").replace(/\s+/g, "");

/** 页面回读到的值算不算填对了。用「包含」——多选控件会显示成「A，B」。 */
const applied = (actual: string, wanted: string) =>
  Boolean(strip(wanted)) && strip(actual).includes(strip(wanted));

export function buildFieldPrompt(input: {
  field: { context?: string; hint?: string; options?: string[]; type?: string; required?: boolean };
  profile: string;
  attempt: number;
  lastResult: { ok: boolean; reason?: string; actual?: string } | null;
  options?: string[];
}): string {
  const { field, profile, attempt, lastResult, options } = input;
  const choices = options ?? field.options ?? [];
  return [
    `这是网申表单里的一个框，第 ${attempt} 次尝试。`,
    `标签：${field.context || "(无)"}`,
    field.hint ? `页面在它旁边写的说明：${field.hint}` : "",
    `控件类型：${field.type || "text"}${field.required ? "（必填）" : ""}`,
    choices.length ? `已知可选项：${choices.slice(0, 40).join(" / ")}` : "可选项未知（可以先 probe）",
    "",
    "【候选人档案】",
    profile,
    "",
    lastResult
      ? `上一次的结果：${lastResult.ok ? "成功" : `失败（${lastResult.reason || "未知"}），页面上现在是「${lastResult.actual ?? ""}」`}`
      : "还没试过。",
    "",
    "可以做的动作，只能选一个：",
    '  {"action":"fill","value":"要填的内容"}      直接填',
    '  {"action":"search","value":"搜索词"}        控件带搜索框时，搜了再选',
    '  {"action":"probe"}                          先看看有哪些可选项',
    '  {"action":"give_up","reason":"原因"}        档案里查无依据，或这个框只能由用户自己处理',
    "",
    "规则：",
    "1. 只做映射，不做创作。档案里没有的信息不要编——留空永远好过填错。",
    "2. fill / search 必须给 source：档案原文里**逐字出现**的一段，用来证明这个值有出处。引不出原文的，选 give_up。",
    "3. 有可选项时，value 必须是其中之一。",
    "4. 上一次失败了就换个办法，不要原样再来一遍：页面写的说明里常常就有答案。",
    "5. 只输出 JSON，不要解释。",
  ].filter(Boolean).join("\n");
}

export async function runFieldAgent(input: {
  field: { signature: string; context?: string; hint?: string; options?: string[]; type?: string; value?: string };
  profile: string;
  tools: FieldTools;
  /**
   * 反编造的闸。返回 ok:false 的值**绝不会写进页面**。
   *
   * 交给模型自己想办法之后，它可以直接给出任意值——原先那道「值必须能在档案原文
   * 里指出出处、有选项时必须命中其一」的校验，如果留在循环外面就等于没有了。而
   * 循环恰恰是执行动作的地方，闸门必须挡在执行之前。
   *
   * 没传 validate 时一律不放行：闸门不能因为调用方忘了传就消失。
   */
  validate?: (value: string, field: any, source: string) => { ok: boolean; reason?: string };
  /** 决策器。真实实现是一次模型调用；测试里注入假的。 */
  decide: (ctx: {
    field: any; profile: string; attempt: number;
    lastResult: { ok: boolean; reason?: string; actual?: string } | null;
    options: string[];
  }) => Promise<FieldAction>;
  maxAttempts?: number;
}): Promise<FieldOutcome> {
  const { field, profile, tools, decide, validate, maxAttempts = 4 } = input;
  let options = field.options ?? [];
  let last: { ok: boolean; reason?: string; actual?: string } | null = null;
  let attempts = 0;

  for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
    const action = await decide({ field, profile, attempt, lastResult: last, options });

    // 不认识的动作**拒绝执行**。模型回一个 submit_form 而我们「尽力照做」，
    // 后果不可撤销——工具集是白名单，不是建议。
    if (!action || !ALLOWED.has(String((action as any).action))) {
      return { ok: false, value: "", reason: "unknown_action", attempts };
    }

    if (action.action === "give_up") {
      return { ok: false, value: "", reason: action.reason || "give_up", attempts };
    }

    if (action.action === "probe") {
      // probe 不算一次尝试：它只是"看一眼"，没有对页面做任何写入
      const result = await tools.probe();
      options = result?.options ?? [];
      last = { ok: false, reason: "probed", actual: "" };
      continue;
    }

    const wanted = String((action as any).value ?? "");

    // 闸门：档案里查无依据、或不在真实选项里的值，绝不写进页面。
    // 没传 validate 就一律不放行——它不能因为调用方忘了传就消失。
    if (!validate) return { ok: false, value: "", reason: "no_validator", attempts };
    const gate = validate(wanted, field, String((action as any).source ?? ""));
    if (!gate.ok) {
      // 把拦下的原因告诉模型，让它换个答案，而不是原样再来一遍
      last = { ok: false, reason: gate.reason || "rejected", actual: "" };
      continue;
    }

    attempts += 1;
    const result = action.action === "fill" ? await tools.fill(wanted) : await tools.search(wanted);
    const actual = String(result?.value ?? "");

    // 成功只以页面回读为准。模型说成了不算，工具返回 ok 也不算。
    if (applied(actual, wanted)) return { ok: true, value: actual, attempts };
    last = { ok: false, reason: actual ? "value_rewritten" : "value_not_applied", actual };
  }

  return { ok: false, value: String(last?.actual ?? ""), reason: last?.reason || "max_attempts", attempts };
}
