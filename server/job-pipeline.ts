/**
 * 岗位推进流水线里的取值与判断。
 *
 * 这些 prompt 模板和「够不够格进下一阶段」的条件原本内联在
 * handleSelectedJobsWorkflow / handleApplyReadyWorkflow 两个各两百行的过程
 * 函数里，跟 socket 事件、Electron 抓取、协作表格写入缠在一起，无法单独验证。
 * 抽出来之后它们是纯函数：给一个岗位行，就能断言 prompt 里有没有带上该带的
 * 信息、guard 在字段缺失时会不会误放行。
 */

export type JobRow = {
  company: string;
  role: string;
  jdUrl?: string;
  location?: string;
  salary?: string;
};

export type BoardRowLike = {
  skillHighlights?: string;
  resumeVersion?: string;
} | null | undefined;

/** JD 正文注入上限。超出部分截断，避免单条 prompt 撑爆上下文。 */
const JD_CONTENT_LIMIT = 3000;

/**
 * 公司名转成可放进简历版本号的标识。
 *
 * 保留任意语种的字母与数字（\p{L}\p{N}），只把标点和空白折成连字符，
 * 所以中文公司名保持原样：「字节跳动」→ 字节跳动，不再和「阿里巴巴」
 * 一起退化成 company。版本号只用于展示（协作表格、聊天播报、可编辑输入框），
 * 不做文件名或索引键，因此不需要限制在 ASCII。
 */
export function companySlug(company: string): string {
  return String(company || "")
    .toLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, "-")
    .replace(/^-+|-+$/g, "") || "company";
}

/** 协作表格的定位字段。BOARD_UPDATE 靠这三项找到要更新的行。 */
export function boardTarget(row: JobRow): string {
  return JSON.stringify({
    company: row.company,
    role: row.role,
    jdUrl: row.jdUrl || "",
  });
}

export function skillUpdatePayload(row: JobRow): string {
  return JSON.stringify({
    company: row.company,
    role: row.role,
    jdUrl: row.jdUrl || "",
    skillHighlights: "一句话写清要强调的技能点",
  });
}

export function resumeUpdatePayload(row: JobRow): string {
  return JSON.stringify({
    company: row.company,
    role: row.role,
    jdUrl: row.jdUrl || "",
    resumeVersion: `v2.1-${companySlug(row.company)}`,
    notes: "tailor 初稿已完成",
  });
}

/**
 * 专业老师的 JD 定位任务。
 *
 * 抓不到 JD 正文时要说明「未能抓取」而不是留空——留空模型会以为这个岗位
 * 没有具体要求，照着岗位名泛泛而谈。
 */
export function jdAnalysisPrompt(input: { row: JobRow; petName: string; jdContent: string }): string {
  const { row, petName, jdContent } = input;
  const jdSection = jdContent
    ? `\n\n【JD 正文】\n${jdContent.slice(0, JD_CONTENT_LIMIT)}`
    : "\n\n（未能抓取到 JD 正文，请根据岗位名称和公司信息做分析）";

  return `【来自${petName}的任务】
现在开始针对具体岗位做 JD 定位分析。
公司：${row.company}
岗位：${row.role}
链接：${row.jdUrl || "无"}
地点：${row.location || "未知"}
薪资：${row.salary || "未知"}
${jdSection}

协作表格目标行：${boardTarget(row)}

请输出：
1. 这个岗位最该强调的 3 个技能点
2. 用户现有背景里最该前置的经历
3. 一句简短结论

最后必须追加一行 BOARD_UPDATE::${skillUpdatePayload(row)}`;
}

/** 简历专家的定制任务。 */
export function tailorPrompt(input: { row: JobRow; petName: string }): string {
  const { row, petName } = input;
  return `【来自${petName}的任务】
现在针对这个岗位做一版定制简历方案。
公司：${row.company}
岗位：${row.role}
链接：${row.jdUrl || "无"}

协作表格目标行：${boardTarget(row)}

请读取协作投递表格中这个岗位行的 skillHighlights，再结合已提供的简历原文和技能分析，给出：
1. 简历该怎么重排
2. 该补哪些关键词
3. 这版简历的版本号（格式如 v2.1-${companySlug(row.company)}）

最后必须追加一行 BOARD_UPDATE::${resumeUpdatePayload(row)}`;
}

/**
 * 够不够格从「定制中」进入「待投递」。
 *
 * 技能要点与简历版本都写回协作表格才算这一轮真的做完了——两个专家里任何
 * 一个没有回写 BOARD_UPDATE，就说明它的产出没落盘，不能往下走。
 * 行不存在时返回 false：读不到不等于通过。
 */
export function canEnterApplyReady(row: BoardRowLike): boolean {
  return Boolean(row?.skillHighlights?.trim() && row?.resumeVersion?.trim());
}

/**
 * 各角色的 BOARD_UPDATE 回写协议。原先叫 getStructuredBoardInstruction，
 * 私有在 server.ts 里，没法单测——服务端入口一 import 就会把服务起起来。
 *
 * 简历专家那条的版本号示例特意用中文公司名：示例是 AI 最强的模仿对象，
 * 给 v2.1-anthropic 会诱导它把「字节跳动」写成拼音，跟 companySlug 算出来
 * 的 v2.1-字节跳动 对不上。
 *
 * 返回空串表示这个角色没有回写职责（团团只做路由，不写表格）。
 */
export function boardInstruction(agentId: string): string {
  if (agentId === "professional-teacher") {
    return "【协作表格指令】当你明确分析某个具体岗位/JD时，在回复最后单独追加一行 BOARD_UPDATE::{\"company\":\"公司名\",\"role\":\"岗位名\",\"jdUrl\":\"链接可留空\",\"skillHighlights\":\"一句话写清要强调的技能点\",\"notes\":\"可选\"}。必须是一行紧凑 JSON，不要换行。用户看不到这行。";
  }
  if (agentId === "resume-expert") {
    return "【协作表格指令】当你完成某个具体岗位的简历诊断或定制时，在回复最后单独追加一行 BOARD_UPDATE::{\"company\":\"公司名\",\"role\":\"岗位名\",\"resumeVersion\":\"如 v2.1-字节跳动，公司名用原文，中文不要转拼音\",\"notes\":\"评分或改动摘要\"}。必须是一行紧凑 JSON，不要换行。用户看不到这行。";
  }
  if (agentId === "networker") {
    return "【协作表格指令】当你找到联系人或生成冷邮件时，在回复最后单独追加一行 BOARD_UPDATE::{\"company\":\"公司名\",\"role\":\"岗位名\",\"contacts\":[{\"name\":\"联系人\",\"title\":\"职位\",\"channel\":\"LinkedIn或邮箱\",\"value\":\"链接或邮箱\"}],\"outreachDraft\":\"邮件正文可简写\",\"outreachStatus\":\"draft\"}。必须是一行紧凑 JSON。";
  }
  if (agentId === "interview-coach") {
    return "【协作表格指令】当你完成某岗位面试点评时，在回复最后单独追加一行 BOARD_UPDATE::{\"company\":\"公司名\",\"role\":\"岗位名\",\"interviewRecord\":{\"score\":7.5,\"strengths\":[\"点1\"],\"weaknesses\":[\"点2\"],\"notes\":\"简评\"}}。必须是一行紧凑 JSON。";
  }
  return "";
}
