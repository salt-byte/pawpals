/**
 * 「选中岗位 → 定制好简历」这一段的推进顺序。
 *
 * 原来是 handleSelectedJobsWorkflow 里一段五十多行的直线代码：置阶段、播报、
 * 抓 JD、跑专业老师、跑简历专家、结算阶段，和 socket 事件、Electron 抓取、
 * 协作表格读写缠在一起，想验证「顺序对不对」只能真跑一遍完整流程。
 *
 * 这里拆成两半：
 *   TAILOR_BEATS      顺序与分工的**数据**——哪一拍归谁、要不要 JD 正文、
 *                     开跑前播报什么。加一拍是往数组里加一项，不用碰驱动器。
 *   runTailorPipeline 驱动器，只负责按表推进。所有副作用（发消息、抓网页、
 *                     读写表格、调 LLM）都从 TailorDeps 注入，所以能在测试里
 *                     用假实现断言调用顺序，不需要起服务。
 *
 * 行为与抽出来之前保持一致，这是纯重构。
 */

import { jdAnalysisPrompt, tailorPrompt, canEnterApplyReady } from "./job-pipeline.ts";
import type { JobRow, BoardRowLike } from "./job-pipeline.ts";

export type BeatContext = { row: JobRow; petName: string; jdContent: string };

export type TailorBeat = {
  /** 这一拍归谁干。 */
  agentId: string;
  /** 这一拍的 prompt 要不要带上 JD 正文；整条流水线只会抓一次。 */
  needsJdContent?: boolean;
  /** 抓取 JD 前以这一拍的角色身份播报一句；不配就静默推进。 */
  announce?: (ctx: BeatContext) => string;
  buildPrompt: (ctx: BeatContext) => string;
};

/** 驱动器结算后落到协作表格的阶段。 */
export type TailorStage = "tailoring" | "apply_ready";

/**
 * 驱动器需要外界提供的能力。全部是 server.ts 那边已有的动作，这里只声明
 * 形状——驱动器不关心消息是怎么发出去的、JD 是用 Electron 还是 fetch 抓的。
 */
export type TailorDeps = {
  setStage: (row: JobRow, stage: TailorStage) => void;
  fetchJdContent: (url: string) => Promise<string>;
  announce: (agentId: string, text: string) => void;
  runBeat: (agentId: string, prompt: string) => Promise<void>;
  /** 读跑完之后的协作表格行，用来判断两个专家有没有把产出回写落盘。 */
  readRow: (row: JobRow) => BoardRowLike;
};

export const TAILOR_BEATS: readonly TailorBeat[] = [
  {
    agentId: "professional-teacher",
    needsJdContent: true,
    announce: ({ row }) => `正在抓取 ${row.company} - ${row.role} 的 JD 详情...`,
    buildPrompt: jdAnalysisPrompt,
  },
  {
    agentId: "resume-expert",
    buildPrompt: tailorPrompt,
  },
];

/**
 * 按配置表把一个岗位推过定制流程，返回结算后的阶段。
 *
 * 开跑就先落 tailoring：中途任何一拍崩了，表格里留下的是「定制中」而不是
 * 上一轮的旧阶段，用户看得出它卡在哪。结算读的是跑完之后的行——两个专家的
 * BOARD_UPDATE 是在各自那一拍里写进去的，读开跑前的快照必然判成没做完。
 */
export async function runTailorPipeline(
  row: JobRow,
  petName: string,
  deps: TailorDeps,
  beats: readonly TailorBeat[] = TAILOR_BEATS
): Promise<TailorStage> {
  deps.setStage(row, "tailoring");

  let jdContent = "";
  let jdFetched = false;

  for (const beat of beats) {
    if (beat.needsJdContent && row.jdUrl && !jdFetched) {
      const ctx: BeatContext = { row, petName, jdContent };
      if (beat.announce) deps.announce(beat.agentId, beat.announce(ctx));
      jdContent = await deps.fetchJdContent(row.jdUrl);
      jdFetched = true;
    }
    await deps.runBeat(beat.agentId, beat.buildPrompt({ row, petName, jdContent }));
  }

  const settled: TailorStage = canEnterApplyReady(deps.readRow(row)) ? "apply_ready" : "tailoring";
  deps.setStage(row, settled);
  return settled;
}
