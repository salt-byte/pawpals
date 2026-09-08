/**
 * 「问一次，以后都记得」。
 *
 * 真机上每投一张表都会重复问同样几个：民族、学号、出生年月、是否接受岗位调剂、
 * 出差意向。前三个档案里确实没有；后两个问的是**意愿**而不是事实——简历不会写
 * 「我接受调剂」，模型拒绝替用户表态是对的，编一个上去等于替他答应了没答应的事，
 * 万一填「接受调剂」，人可能被分到完全不想去的岗位。
 *
 * 但每次都问，就没解决这个产品最初要解决的痛点——「求职信息需要反复填写」。
 * 答案存进 profile.md，下一张表自动就有了：readAutofillProfileText 本来就把
 * profile.md 和 resume_master.md 拼起来喂给模型。
 *
 * 存储是**加性**的：profile.md 里已经有 onboarding 写的搜岗偏好，绝不能覆盖。
 * 同一个字段再次回答就更新那一行，不重复追加。
 */
export const ANSWERS_HEADING = "## 网申补充信息";

const flatten = (text: unknown) => String(text ?? "").replace(/\s+/g, " ").trim();

/** 把已存的答案读回来。没有这一节就返回空。 */
export function parseAnswers(profileText: string): Record<string, string> {
  const body = String(profileText || "").split(ANSWERS_HEADING)[1];
  if (!body) return {};
  const out: Record<string, string> = {};
  for (const line of body.split("\n")) {
    // 下一个二级标题开始就不属于这一节了
    if (line.startsWith("## ")) break;
    const hit = line.match(/^-?\s*([^:：]+)\s*[:：]\s*(.+)$/);
    if (hit) out[hit[1].trim()] = hit[2].trim();
  }
  return out;
}

/**
 * 写入/更新答案，返回新的档案全文。
 *
 * 空答案不写：留空和答「无」是两回事——学号那栏页面明说「若无学号可填写"无"」，
 * 那是个真答案；而空字符串只说明用户没答，下次还要问。
 */
export function upsertAnswers(profileText: string, answers: Record<string, string>): string {
  const clean: Record<string, string> = {};
  for (const [key, value] of Object.entries(answers || {})) {
    const flat = flatten(value);
    if (flat) clean[flatten(key)] = flat;
  }

  const merged = { ...parseAnswers(profileText), ...clean };
  const section = [ANSWERS_HEADING, ...Object.entries(merged).map(([k, v]) => `- ${k}: ${v}`)].join("\n");

  const head = String(profileText || "").split(ANSWERS_HEADING)[0].trimEnd();
  // 这一节之后可能还有别的内容（将来加的），保留它
  const rest = String(profileText || "").split(ANSWERS_HEADING)[1] ?? "";
  const after = rest.split("\n").slice(1);
  const tailStart = after.findIndex((line) => line.startsWith("## "));
  const tail = tailStart >= 0 ? `\n\n${after.slice(tailStart).join("\n").trim()}` : "";

  return `${head ? `${head}\n\n` : ""}${section}${tail}\n`;
}
