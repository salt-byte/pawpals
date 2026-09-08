/**
 * 决定「投哪个岗位」。
 *
 * 真机：用户发「帮我投递这个官网申请：https://…  公司：帆软  岗位：秋招」，投递
 * 管家只把要做的事复述了一遍，apply_job 一次都没被调用，服务端零条日志。
 *
 * 原因是目标 URL 只从三个地方找——扩展上报的当前页面、协作表、上次搜索结果——
 * **用户消息里自己贴的链接从来没被用过**。而那是任何人拿到内推链接后最自然的用法，
 * 整条端到端链路就断在这一步。
 *
 * 优先级从「意图最明确」到「最需要猜」：
 *   消息里的链接 > 扩展上报的当前页面 > 协作表里名字对得上的 > 上次搜索第一条
 * 都找不到就返回 null——宁可不投，也不能投错岗位：投递不可撤销。
 */
export type ApplyTarget = { jdUrl: string; company: string; role: string };

/** 只认 https：申请页会填个人信息，明文传输不接受。 */
const URL_RE = /https:\/\/[^\s，,。；;）)】\]"'<>]+/i;

const readLabelled = (message: string, labels: string[]) => {
  for (const label of labels) {
    const hit = message.match(new RegExp(`${label}\\s*[:：]\\s*([^\\s，,。；;]+)`));
    if (hit?.[1]) return hit[1].trim();
  }
  return "";
};

export function extractApplyTarget(input: {
  message: string;
  board: Array<{ company?: string; role?: string; jdUrl?: string; workflowStage?: string }>;
  searchResults: Array<{ company?: string; role?: string; jdUrl?: string }>;
  activePage: { url: string; title?: string } | null;
}): ApplyTarget | null {
  const { message, board = [], searchResults = [], activePage } = input;

  // 1) 消息里贴了链接：意图最明确，直接用
  const pasted = String(message || "").match(URL_RE)?.[0];
  if (pasted) {
    return {
      jdUrl: pasted,
      company: readLabelled(message, ["公司", "企业"]),
      role: readLabelled(message, ["岗位", "职位", "职务"]),
    };
  }

  // 2) 扩展上报的当前页面：用户正开着那个申请页
  if (activePage?.url) {
    return { jdUrl: activePage.url, company: "", role: String(activePage.title || "") };
  }

  // 3) 协作表里名字对得上的
  const matched = board.find(
    (row) => row.jdUrl && ((row.company && message.includes(row.company)) || (row.role && message.includes(row.role)))
  ) || board.find((row) => row.jdUrl && row.workflowStage === "selected");
  if (matched?.jdUrl) {
    return { jdUrl: matched.jdUrl, company: matched.company || "", role: matched.role || "" };
  }

  // 4) 上次搜索结果的第一条——最需要猜的一条，放最后
  const first = searchResults.find((row) => row.jdUrl);
  if (first?.jdUrl) return { jdUrl: first.jdUrl, company: first.company || "", role: first.role || "" };

  return null;
}
