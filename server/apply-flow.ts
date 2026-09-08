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
/**
 * 补探的层数上限。
 *
 * 帆软那张表是三级：意向岗位大类 → 意向岗位 → 意向工作地点。留点余量给更深的表，
 * 但要有上限——每一层都要真机往返若干次，不能因为某个控件永远探不到就无限转。
 */
/**
 * 「先跳过、稍后重试」最多来回几遍。
 *
 * DOM 顺序不保证等于依赖顺序，子控件可能排在父控件前面。留几遍余量让依赖链自然
 * 解开，但要有上限——不能因为某个控件永远探不到就无限转。
 */
const CASCADE_PASSES = 4;

/** 一轮里最多处理多少个自定义控件。逐个处理很慢，给个上限别让一轮无限长。 */
const MAX_WIDGETS_PER_ROUND = 20;



/** 快照控件 → 决策用的字段。补 signature/label 两个别名，下游按它们认字段。 */
const toFields = (snapshot: any[]) =>
  (Array.isArray(snapshot) ? snapshot : []).map((c: any) => ({ ...c, signature: c.handle, label: c.context }));

/** 填写的预算：逐个字段「填 → 失焦 → 回读」，widget 还要点开面板选中。 */
const fillBudget = (n: number) => Math.min(180_000, 20_000 + n * 15_000);

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
    /**
     * 文本框批量走：它们之间没有依赖，探也不用探。
     */
    const texts = stillOpen(fields, []).filter((f: any) => f.type !== "widget");
    const textValues = await askModel(fieldsForModel(texts), fields);
    if (textValues.length) {
      recordFailures(await runFill(textValues, { task, runTask }, fields), failures);
      const seen = await runTask(task("inspect"));
      if (seen?.ok) fields = toFields(seen.snapshot);
    }

    /**
     * 自定义控件**逐个处理**：探一个、问一个、填一个，再看下一个。
     *
     * 不能先全探完再全填。真机三步实验证实：父级没填时探「意向岗位」返回空状态
     * 「没有可选择的数据」，填上「意向岗位大类 = 产品类」后再探同一个控件，立刻
     * 拿到「全选/产品经理/产品运营」。批量探的话，子控件永远是在父级还没填的
     * 状态下被探的，探到的必然是空。
     *
     * 而这张表是**三级**：意向岗位大类 → 意向岗位 → 意向工作地点（页面原话
     * 「请先选择【意向岗位】，再查看可选工作地点」）。逐个处理不必知道依赖图有
     * 几层，也不必为每张表写死它的依赖关系——填完上一个，下一个的选项自然就在了。
     *
     * 代价是每个控件一次探测 + 一次模型调用 + 一次填写，比批量慢。值得：批量快
     * 但填不上，慢一点但填得上。
     */
    let widgetFilled = 0;
    /**
     * 「探不到选项」不等于「这个控件不行」——很可能只是它的父级还没轮到。
     *
     * DOM 顺序不保证等于依赖顺序：子控件完全可能排在父控件前面。第一遍遇到探不到
     * 的就永久跳过，那种表单会整片填不上。所以先记进 deferred，等这一遍填成了东西
     * 再回头重试；一遍下来一个都没填成，才认定它们是真的不行。
     */
    let deferred: string[] = [];
    for (let sweep = 0; sweep < CASCADE_PASSES; sweep += 1) {
      const skipThisSweep = new Set(deferred);
      deferred = [];
      let filledThisSweep = 0;

      for (let i = 0; i < MAX_WIDGETS_PER_ROUND; i += 1) {
        const pending = stillOpen(fields, []).filter(
          (f: any) => f.type === "widget" && !failures.has(f.signature) && !skipThisSweep.has(f.signature)
        );
        if (!pending.length) break;
        const target = pending[0];

        // 没有选项就先探它——此刻它的父级（如果有）多半已经填好了
        let current = target;
        if (!(current.options?.length)) {
          fields = await probeAll([current], fields, { task, runTask });
          current = fields.find((f: any) => f.signature === target.signature) ?? current;
        }
        if (!(current.options?.length)) {
          // 必须同时进本轮跳过集，否则下一次循环重新算 pending 时它还排在最前面，
          // 会被反复挑中——真机上就是这样：探不到的那两个被原地试了一遍又一遍，
          // 而它们真正缺的是上面那个还没填的父级。探不动就换下一个。
          deferred.push(target.signature);
          skipThisSweep.add(target.signature);
          continue;
        }

        const [value] = await askModel(fieldsForModel([current]), fields);
        if (!value) {
          // 模型答不出（档案里没依据）：这不是控件失败，交给收尾按「缺资料」归类
          failures.set(target.signature, "__ask_user__");
          continue;
        }

        recordFailures(await runFill([value], { task, runTask }, fields), failures);
        widgetFilled += 1;
        filledThisSweep += 1;
        // 填完重新采页面：下一个控件的选项可能刚刚解锁
        const after = await runTask(task("inspect"));
        if (after?.ok) fields = toFields(after.snapshot);
      }

      if (!deferred.length) break;
      // 这一遍什么都没填成，再来一遍也是同样的结果：认定它们探不到选项
      if (!filledThisSweep) {
        for (const signature of deferred) failures.set(signature, "no_options");
        break;
      }
    }

    const claimedFilled = textValues.length + widgetFilled;

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
    log(`[apply] 第 ${round} 轮：字段 ${fields.length} 待填 ${open.length} 文本 ${textValues.length} 控件 ${widgetFilled} → 自报 ${claimedFilled} / 页面推进 ${filledThisRound}`);
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

/**
 * 每批最多填几个。
 *
 * widget 慢是本质的：点开面板 → 选中 → 收起 → 回读，每个 5~15 秒。真机上 13 个
 * 值一次填，走到第 9 个（第一个 widget）就超出预算被判超时，任务报 ok=false——
 * 可 content script 还在继续填，progress=filling 10/13 是在 ok=false 之后才到的。
 * 值填进去了，结果被丢弃，失败也无从归类。
 *
 * 把预算越调越大只是把问题推后。分批让每个任务稳稳落在预算内，一批失败也不影响
 * 其余。文本框快，可以多装几个；widget 单独小批走。
 */
const TEXT_BATCH = 6;
const WIDGET_BATCH = 2;

const chunk = <T,>(list: T[], size: number): T[][] => {
  const out: T[][] = [];
  for (let i = 0; i < list.length; i += size) out.push(list.slice(i, i + size));
  return out;
};

/** 按「快的一起、慢的分开」切批。 */
function fillBatches(values: Array<{ signature: string; value: string }>, fields: any[]) {
  const byHandle = new Map(fields.map((f: any) => [f.signature, f]));
  const slow = values.filter((v) => byHandle.get(v.signature)?.type === "widget");
  const fast = values.filter((v) => byHandle.get(v.signature)?.type !== "widget");
  return [...chunk(fast, TEXT_BATCH), ...chunk(slow, WIDGET_BATCH)];
}

/**
 * 分批填。每批单独派任务、单独声明预算，结果合并返回。
 *
 * 预算别用「掉线检测」那把 20 秒的尺子量——那个上限是接「标签页被丢弃、
 * content script 没了」的，正常的长任务会被它误判。
 */
async function runFill(values: Array<{ signature: string; value: string }>, io: any, fields: any[] = []) {
  const merged = { ok: true, filled: [] as string[], skipped: [] as any[] };
  for (const batch of fillBatches(values, fields)) {
    if (!batch.length) continue;
    const budgetMs = fillBudget(batch.length);
    const result = await io.runTask(io.task("fill", { values: batch, budgetMs }), budgetMs + 30_000);
    if (Array.isArray(result?.filled)) merged.filled.push(...result.filled);
    if (Array.isArray(result?.skipped)) merged.skipped.push(...result.skipped);
    // 一批超时不影响其余：把这一批的字段记成超时，继续下一批
    if (result?.timedOut) {
      for (const item of batch) {
        if (!merged.filled.includes(item.signature)) merged.skipped.push({ signature: item.signature, reason: "dispatch_timeout" });
      }
    }
  }
  return merged;
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
