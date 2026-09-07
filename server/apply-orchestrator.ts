/**
 * 网申投递的编排决策。
 *
 * 顺序是这里的全部要点：**先让模型看到页面，再让它作答。**
 *
 * 真机上吃过亏：只探了前 8 个自定义控件，学历和学位不在其中，模型于是在不知道
 * 有哪些选项的情况下把两个都答成「硕士」。概念上它没错——硕士就是研究生——但
 * 两个选项列表里都没有这个词，执行时被拒。
 *
 * 根因不是模型的知识，是问的顺序。所以：打算填的每个控件，都必须先把选项探到
 * 手再问模型，不能只探一部分、也不能把「填不上」丢回去问用户——那是把模型该干
 * 的事推给人。
 *
 * 万一还是没对上（探测失败、页面选项动态变化），执行侧会带着真实选项报回
 * option_not_found，用 retryTargets 约束后重问一次，仍然不需要人介入。
 */

/** 由代码把关、绝不交给模型的字段。与 autofill-plan 的闸门保持一致。 */
const GATED_KINDS = ["resume", "verification", "sensitive_demographic"];

type Field = {
  signature: string;
  label?: string;
  kind?: string;
  type?: string;
  options?: string[];
  /** 选项被截断：这是个可搜索控件，完整列表不该进 prompt。 */
  truncated?: boolean;
  [k: string]: unknown;
};

const isGated = (field: Field) => GATED_KINDS.includes(String(field.kind || ""));

/**
 * 需要点开去探选项的控件。
 *
 * 只挑还不知道选项的：原生 select 的选项 inspect 时就带回来了，重复探一遍只是
 * 白白多点几次页面。没有标签的容器多半不是真字段，也不探。
 */
export function widgetsToProbe(fields: Field[] = []): string[] {
  return fields
    .filter((field) => field.type === "widget")
    .filter((field) => String(field.label || "").trim())
    .filter((field) => !isGated(field))
    .filter((field) => !(field.options?.length))
    .map((field) => field.signature);
}

/** 把探到的选项并回字段表，供模型作答时使用。探到空的保持原样，不编造。 */
export function mergeProbedOptions(
  fields: Field[] = [],
  probed: { signature?: string; options?: string[]; [k: string]: unknown }[] = []
): Field[] {
  const bySignature = new Map<string, { options: string[]; truncated: boolean }>();
  for (const item of probed) {
    if (item?.signature && item.options?.length) {
      bySignature.set(item.signature, { options: item.options, truncated: Boolean(item.truncated) });
    }
  }
  return fields.map((field) => {
    const hit = bySignature.get(field.signature);
    return hit ? { ...field, options: hit.options, truncated: hit.truncated } : field;
  });
}

/**
 * 值不在选项里而被执行侧拒掉的字段，带上真实选项重问一次。
 *
 * 只重试 option_not_found，而且必须带回了真实选项——没有选项就重问，模型还是
 * 在瞎猜。签名定位不到这类失败换个值也定位不到，不重试。
 */
export function retryTargets(
  skipped: { signature?: string; reason?: string; options?: string[]; [k: string]: unknown }[] = [],
  fields: Field[] = []
): Field[] {
  const out: Field[] = [];
  for (const item of skipped) {
    if (item?.reason !== "option_not_found" || !item.options?.length) continue;
    const field = fields.find((candidate) => candidate.signature === item.signature);
    if (!field) continue;
    out.push({ ...field, options: item.options });
  }
  return out;
}

/**
 * 交给模型作答的字段。
 *
 * 选项被截断的字段（全国高校、全国城市这类）**不再排除**，而是把 options 去掉、
 * 标成 searchable 后照样问模型。
 *
 * 原先是排除的，理由是「截断后的列表既不完整、也对模型没有帮助，完整列表又会
 * 把请求撑爆」——真机上两个学校字段合计 5208 个选项，直接 fetch failed。这个
 * 理由只对「枚举」成立。而驱动器早就有搜索分支：面板里有搜索框时先打字过滤再
 * 选中，一步到位。既然能搜，就不该因为「列表太长」把字段整个丢给用户——档案里
 * 写着清华大学，模型给得出，驱动器搜得到。
 *
 * options 必须去掉：留着截断后的 60 项，会让「值必须命中 options」这道校验把
 * 正确答案judge成越界。去掉之后走的是「引用必须在档案原文里」那条更合适的路。
 */
export function fieldsForModel(fields: Field[] = []): Field[] {
  return fields.map((field) => {
    if (!field.truncated) return field;
    const { options: _dropped, ...rest } = field;
    return { ...rest, searchable: true };
  });
}

/**
 * 只能由用户自己处理的字段。
 *
 * 选项探测失败、又不是可搜索控件的——我们既不知道有哪些值可选，也没有搜索框可
 * 用，让模型猜只会填错。单独列出来上报，而不是假装填了或静默跳过：用户得知道
 * 哪几个框还等着他。
 */
export function manualFields(fields: Field[] = []): Field[] {
  return fields.filter(
    (field) => field.type === "widget" && !field.truncated && !(field.options?.length) && !isGated(field)
  );
}

/**
 * 还要不要再看一眼页面。
 *
 * 级联下拉不该靠手写规则识别。帆软的「意向岗位」依赖「意向岗位大类」，页面自己
 * 就写着「请先选择【意向岗位大类】，再选择具体岗位~」——这句话本来就在快照的
 * context 里，模型看得见。缺的不是它的判断力，是「做一步、再看一眼页面」的机会：
 * 原先的流程是一次性的（采一次、探一次、问一次、填一次，结束），模型没有观察
 * 自己动作后果的余地。
 *
 * 分轮之后级联自然解决，而且不需要任何关于级联的代码——换一家表单、换一种依赖
 * 关系同样有效。
 *
 * 停止条件是「这一轮一个都没填进去」：页面不会因为把同样的问题再问一遍就变化，
 * 继续只是白烧 token。轮数上限是防呆，不是主要的停止手段。
 */
export function shouldRunAnotherRound(input: { round: number; filledThisRound: number; maxRounds: number }): boolean {
  const { round, filledThisRound, maxRounds } = input;
  if (round >= maxRounds) return false;
  return filledThisRound > 0;
}

/**
 * 这一轮还该问的字段：已经填成功的除外，安全闸字段永远除外。
 *
 * 最后这条要紧：分轮不能成为绕过闸门的路子——简历、人机验证、敏感人口统计
 * 在每一轮里都同样不交给模型。
 */
export function stillOpen(fields: Field[] = [], filledSignatures: string[] = []): Field[] {
  const done = new Set(filledSignatures);
  return fields.filter((field) => !isGated(field) && !done.has(field.signature));
}
