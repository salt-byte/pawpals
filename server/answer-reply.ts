/**
 * 从用户的一句回复里认出他答了哪些字段。
 *
 * 我们问的时候列的是「· 民族（必填）」「· 出差意向（必填）：接受 / 不接受」，
 * 用户回过来多半是随手一行行写，或者一句话里带上几个。认出来才能存进档案，
 * 下一张表就不用再问——「求职信息需要反复填写」正是这个产品要解决的痛点。
 *
 * 认不出的一律不收：存错了比不存更糟，那会变成一条假信息跟着他一路投出去。
 * 所以只认**我们问过的那几个字段名**，不做开放式抽取。
 */
const SEP = "[：:＝=\\s]+";

export function parseUserAnswers(reply: string, askedLabels: string[]): Record<string, string> {
  const text = String(reply || "");
  const out: Record<string, string> = {};
  if (!text.trim() || !askedLabels?.length) return out;

  // 长的标签先匹配：「是否接受岗位调剂」要先于可能的短标签命中
  const labels = [...askedLabels].filter(Boolean).sort((a, b) => b.length - a.length);

  for (const label of labels) {
    const escaped = label.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    // 答案取到行尾或下一个逗号/分号；句号不作分隔——「1-2次短期出差」这类会被截断
    const hit = text.match(new RegExp(`${escaped}${SEP}([^\\n，,；;]+)`));
    if (!hit) continue;
    const value = hit[1].trim().replace(/[。.]$/, "");
    if (value) out[label] = value;
  }
  return out;
}
