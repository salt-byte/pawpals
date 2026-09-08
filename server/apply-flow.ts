/**
 * 投递主流程：从一个申请链接，走到「填好了、剩下这些要你处理」。
 *
 * 为什么单独成文件：它原先是 server.ts 里 __executeToolInner 中的 300 行内联
 * 代码，没法单测。于是每验一次「中途断线还能不能接着填」都要真机跑十分钟，而
 * 真机一次只覆盖一条路径——断线、探测超时、控件点不动这些分支基本靠运气撞。
 *
 * 所有外部动作走注入接缝（派任务、问模型、读文件），这里只做**决策**：
 *
 *   先看页面 → 探到真实选项 → 才问模型 → 填 → 按页面回读定性 → 还有剩就再来一轮
 *
 * 三条不变量，每一轮都成立，不因为分轮而松动：
 *   1. 安全闸字段永不进模型（简历、人机验证、敏感人口统计）
 *   2. 这里永远不产生 submit 任务——提交只能由用户确认后的一次性令牌造出来
 *   3. 「填上了」只以页面回读为准，不采信任务自报的条数
 */
import {
  widgetsToProbe, mergeProbedOptions, retryTargets, fieldsForModel,
  manualFields, shouldRunAnotherRound, stillOpen, questionsForUser, unprobed,
} from "./apply-orchestrator.ts";
import { parseSizeLimit, pickResumeTarget, checkUploadFits } from "./upload-plan.ts";
import { createRunLog } from "./apply-log.ts";

export type JobRef = { url: string; company: string; title: string };

export type ApplyDeps = {
  /** 派一个任务给扩展并等结果。失败/超时返回 ok:false，不抛。 */
  runTask: (task: { kind: string; url: string; company: string; title: string; payload?: any }, timeoutMs?: number) => Promise<any>;
  /** 问模型要值。已经过完校验，返回的都是可填的。 */
  askModel: (fields: any[], allFields: any[]) => Promise<Array<{ signature: string; value: string }>>;
  readProfile: () => string;
  findResume: () => string | null;
  readFile: (path: string) => Buffer;
  fileSize: (path: string) => number;
  log: (line: string) => void;
};

export type ApplyOutcome = {
  /** 页面上回读确认有值的字段。 */
  confirmed: any[];
  /** 控件操作失败的（带原因）。 */
  broken: Array<{ field: any; reason: string }>;
  /** 档案里没有、要问用户的。 */
  questions: Array<{ signature: string; label: string; required: boolean; options?: string[] }>;
  /** 简历上传的结论，一句话。 */
  uploadNotes: string[];
  totalFields: number;
  rounds: number;
  /** 账本：每一步「声称」和「实际」的差，对不上的都在 suspicious 里。 */
  runLog: ReturnType<ReturnType<typeof createRunLog>["snapshot"]>;
};

const MAX_ROUNDS = 4;
const PROBE_BATCH = 5;
const PROBE_PASSES = 3;

/** 快照控件 → 决策用的字段。补 signature/label 两个别名，下游按它们认字段。 */
const toFields = (snapshot: any[]) =>
  (Array.isArray(snapshot) ? snapshot : []).map((c: any) => ({ ...c, signature: c.handle, label: c.context }));

/** 填写的预算：逐个字段「填 → 失焦 → 回读」，widget 还要点开面板选中。 */
const fillBudget = (n: number) => Math.min(180_000, 15_000 + n * 6_000);

export async function runApplyFlow(job: JobRef, deps: ApplyDeps): Promise<ApplyOutcome> {
  const { runTask, askModel, readProfile, findResume, readFile, fileSize, log } = deps;
  const task = (kind: string, payload?: any) => ({ kind, url: job.url, company: job.company, title: job.title, payload });
  const profileText = readProfile();

  const uploadNotes: string[] = [];
  const failures = new Map<string, string>();
  // 账本：只记「声称的结果」和「页面实际状态」的差。这个项目栽过太多次
  // 「所有指标都说成功、只有结果是错的」，那类静默失败不记差就看不出来。
  const runLog = createRunLog(`${job.company}-${Date.now().toString(36)}`);
  let rounds = 0;
  let fields: any[] = [];

  // ── 简历先传，单独成一拍 ─────────────────────────────────────────
  // 不少站点解析简历后会把结果覆盖到表单上，上传完立刻填等于白填。
  const first = await runTask(task("inspect"));
  fields = toFields(first?.snapshot);
  await uploadResume(fields, uploadNotes, { task, runTask, findResume, readFile, fileSize });

  // ── 分轮：填一步，重新看一眼页面，再填下一步 ──────────────────────
  // 级联下拉（「意向岗位」依赖「意向岗位大类」）因此自然解决，不需要任何关于
  // 级联的代码：父级填上之后，下一轮重新采页面就能看到子级解锁的选项。
  let fresh = first;
  for (let round = 1; round <= MAX_ROUNDS; round += 1) {
    rounds = round;
    if (fresh?.ok) fields = toFields(fresh.snapshot);

    // stillOpen 以**页面当前值**为准，不靠「记得填过哪些句柄」：service worker
    // 被回收、页面重渲染都会让记忆失效，而页面自己不会说谎。断线续填全靠这条。
    const open = stillOpen(fields, []);
    if (!open.length) break;

    const wantProbe = widgetsToProbe(open).length;
    fields = await probeAll(open, fields, { task, runTask });
    const gotOptions = fields.filter((f: any) => f.type === "widget" && f.options?.length).length;
    runLog.claim(`probe#${round}`, { claimed: wantProbe, actual: gotOptions });

    const refreshed = stillOpen(fields, []);
    const values = await askModel(fieldsForModel(refreshed), fields);

    let claimedFilled = 0;
    if (values.length) {
      const result = await runFill(values, { task, runTask });
      claimedFilled += countFilled(result);
      recordFailures(result, failures);

      // 值不在选项里而被拒的，带**真实选项**重问一次——不把模型该干的事推给人。
      const retryable = retryTargets(result?.skipped ?? [], fields);
      if (retryable.length) {
        const second = await askModel(retryable, fields);
        if (second.length) {
          const again = await runFill(second, { task, runTask });
          claimedFilled += countFilled(again);
          recordFailures(again, failures);
        }
      }
    }

    /**
     * 本轮推进了多少，**以页面为准**。
     *
     * 不能数任务自报的 filled：派发超时返回的是 {ok:false}，一条 filled 都没有，
     * 可页面上其实已经填进去几个了。按自报数判定「没推进」就会当场停掉，前面填好
     * 的还在、后面的永远填不上——这正是「填上了只以页面回读为准」这条原则要挡的。
     */
    fresh = await runTask(task("inspect"));
    if (fresh?.ok) fields = toFields(fresh.snapshot);
    const filledThisRound = open.length - stillOpen(fields, []).length;

    // 自报数和页面推进数对不上就是线索——真机上派发超时那次自报 0、页面其实
    // 填进去 10 个，按自报数判定「没推进」当场就停了。
    runLog.claim(`fill#${round}`, { claimed: claimedFilled, actual: filledThisRound });
    log(`[apply] 第 ${round} 轮：字段 ${fields.length} 待填 ${open.length} 模型给 ${values.length} → 自报 ${claimedFilled} / 页面推进 ${filledThisRound}`);
    if (!shouldRunAnotherRound({ round, filledThisRound, maxRounds: MAX_ROUNDS })) break;
  }

  // ── 验收：以页面实际状态为准 ─────────────────────────────────────
  // 上面每轮结束都刚采过一次，直接用，不再多派一个任务
  if (fresh?.ok) fields = toFields(fresh.snapshot);
  const confirmed = fields.filter((f: any) => String(f.value ?? "").trim());
  const open = stillOpen(fields, []);
  const broken = open
    .filter((f: any) => failures.has(f.signature))
    .map((f: any) => ({ field: f, reason: failures.get(f.signature) as string }));
  const questions = questionsForUser(open.filter((f: any) => !failures.has(f.signature)), []);

  log(runLog.summary());
  return { confirmed, broken, questions, uploadNotes, totalFields: fields.length, rounds, runLog: runLog.snapshot() };
}

/** 填一批，返回执行结果。预算按字段数声明，别用「掉线检测」那把尺子量长任务。 */
async function runFill(values: Array<{ signature: string; value: string }>, io: any) {
  const budgetMs = fillBudget(values.length);
  return io.runTask(io.task("fill", { values, budgetMs }), budgetMs + 30_000);
}

const countFilled = (result: any) => (Array.isArray(result?.filled) ? result.filled.length : 0);

function recordFailures(result: any, into: Map<string, string>) {
  for (const item of result?.skipped ?? []) {
    if (item?.signature) into.set(item.signature, String(item.reason || "unknown"));
  }
}

/**
 * 探到所有能探的选项。
 *
 * 补探是必须的：探测返回 partial 很常见（单控件真机约 2.8 秒，一批预算有限）。
 * 把 partial 当成「探完了」，没轮到的控件就永远没有选项，模型永远答不对它们。
 * 一轮下来一个都没推进就停——再试也是同样的结果。
 */
async function probeAll(open: any[], fields: any[], io: any) {
  let list = widgetsToProbe(open);
  let merged = fields;
  for (let pass = 0; pass < PROBE_PASSES && list.length; pass += 1) {
    const got: any[] = [];
    for (let i = 0; i < list.length; i += PROBE_BATCH) {
      const result = await io.runTask(
        io.task("probe", { signatures: list.slice(i, i + PROBE_BATCH), budgetMs: 15_000 }),
        40_000
      );
      if (Array.isArray(result?.probed)) {
        got.push(...result.probed);
        merged = mergeProbedOptions(merged, result.probed);
      }
    }
    const left = unprobed(list, got);
    if (left.length === list.length) break;
    list = left;
  }
  return merged;
}

/**
 * 简历上传。
 *
 * 三种情况都如实上报，不含糊过去——用户以为传好了却没传，是投递里代价最大的
 * 一种误解。超限时当场说清楚，而不是传上去被网站默默拒掉。
 */
async function uploadResume(fields: any[], notes: string[], io: any) {
  const target = pickResumeTarget(fields);
  if (!target) return;

  const path = io.findResume();
  if (!path) {
    notes.push("没找到你的简历原件（只有抽出来的文本），简历附件需要你自己选一下");
    return;
  }
  const fits = checkUploadFits(io.fileSize(path), parseSizeLimit(String((target as any).context || "")));
  if (!fits.ok) {
    notes.push(`简历没传：${fits.reason}，请换一份小一点的`);
    return;
  }
  const name = String(path).split("/").pop() || "resume";
  const result = await io.runTask(io.task("upload", {
    uploads: [{
      signature: (target as any).handle,
      name,
      type: name.toLowerCase().endsWith(".pdf") ? "application/pdf" : "application/octet-stream",
      dataBase64: io.readFile(path).toString("base64"),
    }],
  }), 60_000);
  notes.push(result?.uploaded?.length
    ? `已上传简历 ${name}`
    : `简历上传失败（${result?.skipped?.[0]?.reason || "未知原因"}），需要你自己选一下`);
}
