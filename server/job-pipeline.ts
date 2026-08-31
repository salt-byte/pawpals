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
 * 已知缺陷：只保留 a-z0-9，所以纯中文公司名会全部退化成 "company"，
 * 导致「字节跳动」和「阿里巴巴」的简历版本号都是 v2.1-company，
 * 无法区分岗位。修这个会改变已有数据里的版本号，需要单独决定。
 */
export function companySlug(company: string): string {
  return String(company || "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
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
