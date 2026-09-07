/**
 * 用大模型给网申表单取值。
 *
 * 此前是 autofill.ts 里按 field.kind 查表：扩展侧 fieldKind 认出 email/phone
 * 这类已知字段，服务端映射到档案里的对应项。问题是国内校招表单的字段——期望
 * 薪资、毕业院校、实习经历、学历、专业——几乎全部落进 custom，而 custom 一
 * 律不填，那些框就是死的。
 *
 * 模型能读懂 label，正则读不懂。但让模型往**真实雇主的申请表**里写值，风险
 * 跟让它在浏览器里点来点去完全不同：错误会留在别人的招聘系统里。所以这里
 * 的设计原则是——
 *
 *   模型只做「映射」，不做「创作」。
 *
 * 落实成四条机械校验（不是 prompt 里的一句叮嘱，是代码里的门）：
 *   1. signature 必须在字段表里且唯一        —— 不能凭空指一个框
 *   2. 有 options 的字段，值必须命中其一      —— 下拉框不能自由发挥
 *   3. 每个值必须给出 source，且 source 能在档案原文里逐字找到  —— 反编造的执行点
 *   4. 三类字段永不交给模型                  —— 见 GATED_KINDS
 *
 * 第 3 条是核心：模型必须**引用它从哪里读到的**，引不出来就丢弃。这样「不许
 * 编造学历和毕业时间」就不再依赖模型自觉。
 */

/**
 * 安全闸：这三类字段永远不进 prompt、也永远不填。
 *
 * resume                 浏览器不允许脚本设置文件框，且解析结果会覆盖已填内容
 * verification           人机验证必须由用户本人完成
 * sensitive_demographic  敏感人口统计问题必须由用户本人回答，代答是越权
 *
 * 注意这三项仍由确定性的 fieldKind 判定，不交给模型——不能让模型来判断
 * 「这页没有人机验证」。
 */
export const GATED_KINDS = ["resume", "verification", "sensitive_demographic"] as const;

export type PlannableField = {
  /** 可选是因为它来自扩展这个不受信边界；缺签名的字段无法寻址，一律排除。 */
  signature?: string;
  label?: string;
  kind?: string;
  type?: string;
  required?: boolean;
  options?: string[];
};

export type AutofillPlan = {
  values: Array<{ signature: string; value: string }>;
  rejected: Array<{ signature: string; reason: string }>;
};

/** 来源短于这个长度不算来源——两三个字随便都能在档案里撞上。 */
/**
 * 引用的最短长度。只用来挡掉单字符这种退化匹配，不承担「证明有出处」的职责——
 * 那由「引用必须包含值」来保证。
 *
 * 原先这里是 4，对中文是错的：4 个拉丁字母几乎不携带信息，3 个汉字的姓名却
 * 高度特异，而大多数中文姓名就是 2-3 个字。真机上「邓雨蝶」因此被判 unsourced，
 * 最基本的字段填不上。
 */
const SOURCE_MIN_LENGTH = 2;

/**
 * 由代码把关、绝不交给模型的字段。
 *
 * 旧字段表按 kind 判断；快照没有 kind，按 type=file 判断——文件框永远是安全闸
 * （简历先传、提交前拦截），这一条不能建立在模型的判断上。
 */
const isGated = (field: PlannableField) =>
  (GATED_KINDS as readonly string[]).includes(String(field.kind || "")) ||
  String((field as any).type || "") === "file";

/** 去掉全部空白再比对：档案里的换行缩进不该影响引用是否成立。 */
const strip = (text: unknown) => String(text ?? "").replace(/\s+/g, "");

/**
 * 交给模型的字段。安全闸之外全给——包括 custom，那正是模型要接管的桶。
 * 没有 signature 的字段一并排除：fillApplicationFields 按签名定位，无签名的
 * 框即便模型给了值也填不进去，放进 prompt 只会诱导它做无用功。
 */
export function fillableFields(fields: PlannableField[]): PlannableField[] {
  return (fields ?? []).filter((field) => Boolean(field.signature) && !isGated(field));
}

/** 快照里的一个控件。给的是周围**原文**，不是猜出来的标签。 */
export type SnapshotControl = {
  handle: string;
  type?: string;
  required?: boolean;
  options?: string[];
  context?: string;
};

/**
 * 快照控件转成待填行。
 *
 * 真机：帆软那页 39 个字段里 16 个「没有标签」——启发式没猜出来，模型于是根本
 * 看不到这些框，30/39 填不上。快照不猜标签，直接把控件周围的原文给模型，它看得
 * 懂「* 姓名」这种排布。
 *
 * 文件框不进 prompt：那是安全闸（简历先传、提交前拦截），由代码把关。
 * 没有 context 的控件也不进：模型无从判断，给了也是瞎猜。
 */
function snapshotRows(controls: SnapshotControl[]) {
  return (controls ?? [])
    .filter((control) => control.handle && String(control.context || "").trim())
    .filter((control) => control.type !== "file")
    .map((control) => ({
      signature: control.handle,
      context: control.context,
      type: control.type || "text",
      required: control.required === true,
      options: control.options?.length ? control.options : undefined,
    }));
}

export function buildAutofillPrompt(input: {
  fields?: PlannableField[];
  controls?: SnapshotControl[];
  profileText: string;
  ctx?: { company?: string; title?: string };
}): string {
  const { fields, controls, profileText, ctx = {} } = input;
  // 迁移期两条路并存：有快照就用快照的原文，没有就退回旧的启发式字段表。
  const rows = controls?.length
    ? snapshotRows(controls)
    : fillableFields(fields ?? []).map((field) => ({
        signature: field.signature as string,
        context: field.label || "",
        type: field.type || "text",
        required: field.required === true,
        options: field.options?.length ? field.options : undefined,
      }));

  return [
    `岗位：${ctx.company || "未知公司"} - ${ctx.title || "未知岗位"}`,
    "",
    "【候选人档案原文】",
    profileText,
    "",
    "【待填字段】（context 是这个框周围的页面原文，请据此判断它要什么）",
    JSON.stringify(rows, null, 2),
    "",
    "把档案里已有的信息映射到上面的字段，返回：",
    '{"values":[{"signature":"原样照抄","value":"要填的内容","source":"档案原文里的一段原话"}]}',
    "",
    "规则：",
    "1. 只做映射，不做创作。雇主、日期、指标、奖项、学历、署名、资质一律不得编造。",
    "2. 每一项都必须给出 source，且必须是档案原文里**逐字出现**的一段（至少四个字）。引不出原文的，这一项就不要给。",
    "3. 档案里没有的信息，就不要给这个字段——留空永远好过填错。",
    "4. options 存在时，value 必须是其中之一，不得自造措辞。",
    "5. 允许的加工只有：重组已有内容、改写成「行动-方法-结果」、提取已展示的技能、缩写或翻译。改写不得改变事实。",
    "6. signature 必须从上面的字段表里原样照抄，不得改动或新造。",
  ].join("\n");
}

/**
 * 校验模型给的填写计划。通过的进 values，其余带原因进 rejected 供上报。
 *
 * 这里不信任模型的任何自述——source 是否成立由代码在档案原文里查，不看模型
 * 说得多有把握。
 */
export function validateAutofillPlan(
  items: unknown,
  fields: PlannableField[],
  profileText: string
): AutofillPlan {
  const values: AutofillPlan["values"] = [];
  const rejected: AutofillPlan["rejected"] = [];
  if (!Array.isArray(items)) return { values, rejected };

  const haystack = strip(profileText);
  const seen = new Set<string>();

  for (const raw of items) {
    const item = (raw ?? {}) as { signature?: unknown; value?: unknown; source?: unknown };
    const signature = typeof item.signature === "string" ? item.signature : "";
    const reject = (reason: string) => rejected.push({ signature, reason });

    // 迁移期两套并存：快照控件用 handle，旧字段表用 signature。
    const matches = (fields ?? []).filter(
      (field) => field.signature === signature || (field as any).handle === signature
    );
    if (!signature || matches.length === 0) { reject("unknown_signature"); continue; }
    if (matches.length > 1) { reject("ambiguous_signature"); continue; }

    if (seen.has(signature)) { reject("duplicate"); continue; }

    const field = matches[0];
    if (isGated(field)) { reject("gated_field"); continue; }

    const value = typeof item.value === "string" ? item.value.trim() : "";
    if (!value) { reject("empty_value"); continue; }

    if (field.options?.length && !field.options.includes(value)) { reject("option_not_allowed"); continue; }

    const source = strip(item.source);
    const quoted = source.length >= SOURCE_MIN_LENGTH && haystack && haystack.includes(source);
    // 引用必须包含要填的值——「指给我看这个值出自哪里」。
    // 有 options 的字段例外：值来自表单给的选项（已在上面校验过命中），引用的
    // 职责只是证明选这个选项的依据在档案里，比如据「双硕士项目」选「研究生」。
    const anchored = Boolean(field.options?.length) || source.includes(strip(value));
    if (!quoted || !anchored) { reject("unsourced"); continue; }

    values.push({ signature, value });
    seen.add(signature);
  }

  return { values, rejected };
}
