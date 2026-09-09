/**
 * 官网申请相关的 HTTP 路由。
 *
 * 从 server.ts 的 startServer() 里抠出来的——那个函数有 1626 行、60 个路由挤在
 * 一起，改一处要在里面翻半天。这块是最内聚也最活跃的一部分（整个投递链路都走它），
 * 先拆它。
 *
 * 依赖全部显式注入，不再靠闭包捞模块级变量：这样这些路由的行为可以单独测，而
 * 不必把整个 server 跑起来。
 *
 * ── 一条安全边界 ──
 * parseRequestedKind 永远不放行 "submit"。提交任务只能由 confirm 令牌产生，
 * 不能从任何 HTTP 入口直接造出来——这是投递流程里最硬的那道闸。
 */
import type { OfficialApplicationQueue } from "./official-application-queue.ts";

export type OfficialRouteDeps = {
  app: any;
  /** 队列按用户分了，deps 拿到的是取当前用户队列的函数，不能是启动期的那一个实例。 */
  queue: () => OfficialApplicationQueue;
  hub: { sendToUser: (userId: string, task: unknown) => number; sendRawToUser: (userId: string, message: unknown) => number };
  enqueueOfficialTask: (input: any) => any;
  parseRequestedKind: (raw: unknown, fallback?: any) => any;
  /** 扩展上报「用户正开着哪个申请页」。投递时没别的线索就用它。 */
  setActivePage: (page: { url: string; title: string; provider: string; seenAt: number } | null) => void;
  log: (line: string) => void;
  /** 当前请求所属用户。任务只能发给这个人的插件，不能发给别人——见 confirm 路由。 */
  currentUserId: () => string | null;
};

export function registerOfficialRoutes(deps: OfficialRouteDeps) {
  const { app, hub: officialTaskHub, enqueueOfficialTask, parseRequestedKind, setActivePage, log } = deps;

app.get("/api/internal/official-application-task", (_req: any, res: any) => {
  res.json({ task: deps.queue().next() });
});

app.post("/api/internal/official-application-task-done", (req: any, res: any) => {
  const { id, result } = req.body || {};
  // 谁在用这条 HTTP 通路？扩展本该走 WebSocket 回报。真机上出现过「任务完成了
  // 但 WebSocket 的 complete 从没被调用」，说明有别的东西在走这里。
  console.log(`[official/http] 有客户端经 HTTP 回报结果 id=${String(id).slice(0, 24)} ua=${String(req.headers["user-agent"] || "-").slice(0, 60)}`);
  if (!id || !deps.queue().complete(String(id), result || { ok: false, error: "扩展未返回结果" })) {
    return res.status(404).json({ ok: false, error: "任务不存在或已完成" });
  }
  res.json({ ok: true });
});

// 扩展在用户点击图标授权当前官网标签页后上报上下文；主 Agent 的投递意图优先使用它。
app.post("/api/internal/official-application-context", (req: any, res: any) => {
  const { url, title = "", provider = "generic" } = req.body || {};
  if (typeof url !== "string" || !/^https:\/\//i.test(url)) {
    return res.status(400).json({ ok: false, error: "需要 HTTPS 官网页面" });
  }
  setActivePage({ url, title: String(title), provider: String(provider), seenAt: Date.now() });
  res.json({ ok: true });
});

// 此端点只创建 inspect / fill，供聊天层在用户已经打开并授权官网标签页后调用。
/**
 * 让扩展自己重载。
 *
 * 开发期改一次扩展代码就要手动去 chrome://extensions 点刷新，一天十几次；
 * Claude in Chrome 也帮不上——扩展不能注入 chrome:// 页面。
 *
 * 仅本机开发用途：它不改任何用户数据、不碰投递流程，最坏情况是扩展重启一次
 * （队列里的任务由重连补发，不会丢）。
 */
app.post("/api/dev/reload-extension", (_req: any, res: any) => {
  const userId = deps.currentUserId();
  const delivered = userId ? officialTaskHub.sendRawToUser(userId, { type: "reload" }) : 0;
  log(`[official] 下发重载命令，送达=${delivered}`);
  res.json({ ok: true, delivered });
});

app.post("/api/official-applications/prepare", (req: any, res: any) => {
  const { url, company = "", title = "", payload = {}, kind } = req.body || {};
  if (typeof url !== "string" || !/^https:\/\//i.test(url)) {
    return res.status(400).json({ ok: false, error: "需要 HTTPS 官网申请链接" });
  }
  const requested = parseRequestedKind(kind);
  if (!requested) return res.status(400).json({ ok: false, error: "不支持的任务类型（提交只能经确认令牌创建）" });
  const task = enqueueOfficialTask({ kind: requested, url, company: String(company), title: String(title), payload });
  res.json({ ok: true, task });
});

// 读任务结果。队列一直在存结果，但此前没有任何 HTTP 端点能读到它——只有内部
// 的 waitForOfficialTask 拿得到，于是外部无法编排「inspect 拿字段 → probe 拿
// 选项 → 取值 → fill」这条链路。
app.get("/api/official-applications/:taskId/result", (req: any, res: any) => {
  const result = deps.queue().result(String(req.params.taskId));
  if (!result) return res.status(404).json({ ok: false, error: "结果还没产生或任务不存在" });
  res.json({ ok: true, result });
});

/**
 * 可恢复任务的状态端点。result 只在结束后才有；轮询这个端点可以区分
 * 「扩展还在探第几个控件」与「扩展掉线、正在等重连」，不再只能干等超时。
 */
app.get("/api/official-applications/:taskId/status", (req: any, res: any) => {
  const status = deps.queue().status(String(req.params.taskId));
  if (!status) return res.status(404).json({ ok: false, error: "任务不存在" });
  res.json({ ok: true, status });
});

// 只有用户在对话确认后才能调用；确认令牌单次使用，生成真正的 submit 任务。
app.post("/api/official-applications/:confirmationId/confirm", (req: any, res: any) => {
  const task = deps.queue().confirm(req.params.confirmationId);
  if (!task) return res.status(404).json({ ok: false, error: "确认已过期、被取消或不存在" });
  // 这是投递流程里最硬的那道闸：submit 任务只能发给发起确认的这个用户的插件，
  // 绝不能广播——广播意味着别人的浏览器、别人的登录态替这个人把申请交上去。
  // 认不出用户就谁也不发，宁可任务留在队列里，也不能落到不知道是谁的连接上。
  const userId = deps.currentUserId();
  const delivered = userId ? officialTaskHub.sendToUser(userId, task) : 0;
  if (!userId) log(`[official] confirm 缺少用户上下文，submit 任务 ${task.id} 未下发`);
  res.json({ ok: true, task, delivered });
});
}
