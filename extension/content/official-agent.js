import { collectApplicationFields, fillApplicationFields, findSubmitControl, formWarnings, verifyFilledFields, collectWidgetTargets, widgetContainerFor } from '../application/form.js';
import { detectApplicationProvider } from '../application/schema.js';
import { mergeSiteMemory, siteKey } from '../application/site-memory.js';
import { applyFileUploads } from '../application/file-upload.js';
import { applyWidgetValues, createPageWidgetDriver, probeWidgets } from '../application/widget.js';
import { waitForFormReady } from '../application/ready.js';
import { snapshotControls, elementForHandle, fillByHandle, widgetTargets } from '../application/snapshot.js';
import { createAdapterRegistry } from '../application/adapters.js';
import { syntheticImpl } from '../act/synthetic.js';

/** 驱动纯 div 模拟控件用的点击实现。合成事件在真机上验证过是有效的。 */
/**
 * 点击与打字：**合成事件优先，CDP 兜底**。
 *
 * 合成事件在简道云上验证过可用，而且不会让 Chrome 挂「已开始调试此浏览器」的
 * 横幅。只有当合成事件没能让页面产生反应时，才请 service worker 用
 * chrome.debugger 派发真实事件（Claude in Chrome 全程走的就是这条路，代价就是
 * 那条横幅）。
 *
 * chrome.debugger 只能在 service worker 里用，所以这里负责算视口坐标。
 */
async function cdpClick(el) {
  el.scrollIntoView?.({ block: 'center' });
  await new Promise((r) => setTimeout(r, 120));
  const box = el.getBoundingClientRect();
  const x = box.left + box.width / 2;
  const y = box.top + box.height / 2;
  if (x < 0 || y < 0 || x > innerWidth || y > innerHeight) return false;
  const reply = await toBackground({ type: 'OFFICIAL_CDP_CLICK', x, y });
  return Boolean(reply?.ok);
}

const widgetDriver = createPageWidgetDriver({
  click: async (el) => {
    await syntheticImpl.click(el, { fast: true });
    return { cdpFallback: () => cdpClick(el) };
  },
  // 搜索框打字：面板带搜索时不枚举，直接搜
  type: async (el, text) => {
    el.focus?.();
    await syntheticImpl.type(el, text, { fast: true });
    if (!el.value || !String(el.value).includes(String(text))) {
      // 合成打字没落到框里，改用 CDP 往当前焦点插入
      await toBackground({ type: 'OFFICIAL_CDP_TYPE', text });
    }
  },
});
import { sendToBackground } from './bg-bridge.js';

/**
 * 站点适配器：三层里的第一层。命中已知平台就用确定的选择器，不必每次让模型
 * 现场推理；没命中就退回通用启发式，行为和加它之前完全一致。
 */
const adapters = createAdapterRegistry();
const siteSelectors = () => adapters.selectorsFor(location.href);
/**
 * 快照选项。采集（inspect）和填写（fill）必须用同一份——句柄是从 context 派生的，
 * 两边用不同的 labelSelector 会算出两套句柄，模型作答后一个都定位不到。
 */
const snapOpts = () => ({ labelSelector: siteSelectors().labelSelector });

/**
 * 页面侧的执行器。这里**不碰网络**——MV3 的 content script 跨域 fetch 走页面
 * 的 origin、受 CORS 管，直连 localhost:3000 会稳定拿到 Failed to fetch。
 * 网络全部交给 service worker（见 background/official-task-router.js）。
 *
 * 本文件只做两件事：页面加载完成时上报一次「我上线了」；收到派下来的任务就在
 * 页面里执行并把结果回给它。
 *
 * 原先这里还有一个每 1.5 秒的心跳，用来唤醒 service worker 去轮询任务。任务
 * 改成 WebSocket 推送之后不再需要——service worker 由连接保活，任务来了直接
 * 派下来。
 */

function toBackground(message) {
  return sendToBackground((m) => chrome.runtime.sendMessage(m), message);
}

/**
 * 页面不能直连本地服务（受页面 CORS 约束），进度和最终结果一样经 service
 * worker 的 WebSocket 回传。它只记录最近一个安全步骤，掉线后仍由服务端保留。
 */
function reportTaskProgress(task, progress) {
  if (!task?.id) return;
  void toBackground({ type: 'OFFICIAL_TASK_PROGRESS', id: task.id, progress });
}

/**
 * 告诉 service worker 这个页面上线了。
 *
 * 带上 origin 是因为任务可能在本页加载完成之前就被推过来了——那时还没有
 * content script 可派，任务在 service worker 那边挂着，等这条消息来了才补派。
 */
function reportPageReady() {
  return toBackground({
    type: 'OFFICIAL_PAGE_READY',
    origin: location.origin,
    payload: { url: location.href, title: document.title, provider: detectApplicationProvider(location.href) },
  });
}

function samePage(task) {
  try { return new URL(task.url).origin === location.origin; } catch { return false; }
}

async function remember(observation) {
  const key = `official-site:${siteKey(location.href)}`;
  const existing = (await chrome.storage.local.get(key))[key];
  await chrome.storage.local.set({ [key]: mergeSiteMemory(existing, observation) });
}

async function execute(task) {
  reportTaskProgress(task, { stage: 'page_ready', url: location.href });
  // 先等表单渲染完。扩展自主开页后 PAGE_READY 在 document_idle 就发了，而简道云
  // 这类 SPA 那时还没把控件渲染出来——真机上因此出过一次 ok=true 但 probed=0 的
  // 假成功。等不到就带着 formReady:false 继续，让上游知道结果可能不完整。
  const readiness = await waitForFormReady({ countFields: () => collectApplicationFields(document).length });
  const fields = collectApplicationFields(document);
  if (task.kind === 'inspect') {
    reportTaskProgress(task, { stage: 'inspecting' });
    // provider 以适配器为准：它是真机抓过 DOM 才收录的，比 URL 启发式可靠
    const provider = siteSelectors().provider !== 'generic'
      ? siteSelectors().provider
      : detectApplicationProvider(location.href);
    const warnings = formWarnings(fields, document);
    await remember({ url: location.href, provider, fields });
    // 快照与 fields 并存：fields 是旧的启发式解析，snapshot 是给模型看的原文。
    // 模型按 snapshot 的句柄作答，填写也按同一套句柄定位——两边必须同源。
    return { ok: true, provider, url: location.href, title: document.title, fields,
      snapshot: snapshotControls(document, snapOpts()),
      warnings, formReady: readiness.ready, hasSubmit: Boolean(findSubmitControl(document)) };
  }
  if (task.kind === 'upload') {
    reportTaskProgress(task, { stage: 'uploading' });
    // 上传单独成一拍：不少站点解析简历后会把结果覆盖到表单上，上传完立刻填
    // 等于白填。这一拍只装文件，等页面解析完再由后续的 inspect + fill 接手。
    const { uploaded, skipped } = applyFileUploads(document, task.payload?.uploads || [], { snapshotOpts: snapOpts() });
    return { ok: true, uploaded, skipped, formReady: readiness.ready, warnings: formWarnings(collectApplicationFields(document), document) };
  }

  if (task.kind === 'fill') {
    reportTaskProgress(task, { stage: 'filling', total: Array.isArray(task.payload?.values) ? task.payload.values.length : 0 });
    const values = task.payload?.values || [];
    // 模型是按快照的句柄作答的，先用快照定位；快照里没有的再交给旧的签名路径，
    // 迁移期两套并存，任何一套能定位到就算数。
    const bySnapshot = [];
    const rest = [];
    for (const item of values) {
      (elementForHandle(document, item.signature, snapOpts()) ? bySnapshot : rest).push(item);
    }
    const snap = fillByHandle(document, bySnapshot, snapOpts());
    const legacy = fillApplicationFields(document, rest);
    const filled = [...snap.filled, ...legacy.filled];
    const skipped = [...snap.skipped, ...legacy.skipped];

    // 失焦一次再回读：带延迟校验的表单（Moka 这类）会在失焦时才决定要不要
    // 保留脚本写入的值，不回读就分不清「填进去了」和「填了又被清掉」。
    document.activeElement?.blur?.();
    const { stuck, lost } = verifyFilledFields(document, filled);

    // 纯 div 模拟的下拉/多选：fillApplicationFields 按 unsupported_widget 跳过
    // 了它们，这里改用驱动器点开面板选中。放在原生字段之后，因为点开面板会滚动
    // 页面，先做会干扰上面的回读。
    const widgetTargets = [
      ...snap.widgets,
      ...skipped
        .filter((item) => item.reason === 'unsupported_widget')
        .map((item) => values.find((value) => value.signature === item.signature))
        .filter(Boolean),
    ];
    const widgets = await applyWidgetValues(document, widgetTargets, {
      driver: widgetDriver,
      // 快照句柄优先；找不到再退回旧签名，迁移期两套并存
      findContainer: (signature) => elementForHandle(document, signature, snapOpts()) || widgetContainerFor(document, signature),
    });

    const warnings = formWarnings(collectApplicationFields(document), document);
    return {
      ok: true,
      filled: [...stuck, ...widgets.filled],
      // widget 的失败带着可选项一起报上去，用户能看到「可选的是这几个」
      skipped: [...skipped.filter((item) => item.reason !== 'unsupported_widget'), ...widgets.skipped],
      lost, warnings, formReady: readiness.ready,
      requiresUserFileSelection: warnings.includes('resume_requires_user_file_selection'),
    };
  }

  if (task.kind === 'probe') {
    // 探测自定义控件的可选项：这类控件的选项是点开时才渲染的，inspect 采不到。
    // 服务端拿到之后才能让模型在合法值里选，而不是自由发挥。
    //
    // 带边界：单个控件真机实测约 2.8 秒，全量探完会让任务超时并把队列堵死。
    // 目标来自**快照**，不是 form.js 的签名表：inspect 和 fill 都按快照句柄
    // 寻址，探测再用另一套签名的话，探回来的选项并不回字段表，模型就永远在
    // 不知道有哪些选项的情况下作答。快照没有 widget 时退回旧路径。
    const targets = widgetTargets(document, snapOpts());
    const { probed, partial } = await probeWidgets(targets.length ? targets : collectWidgetTargets(document), {
      driver: widgetDriver,
      signatures: task.payload?.signatures,
      budgetMs: Number(task.payload?.budgetMs) || 20000,
      onProgress: (progress) => reportTaskProgress(task, progress),
    });
    return { ok: true, probed, partial, formReady: readiness.ready };
  }
  /**
   * 视觉兜底第一拍：把目标控件滚进视口，截图，连同它的视口坐标一起交回服务端。
   *
   * 用在 DOM 驱动不了的控件上——真机上帆软那 5 个「是否有…经历」probe 探回来
   * 0 个选项，面板压根没开。那时候唯一还成立的信息源就是「它在屏幕上长什么样」。
   *
   * 这一拍只负责「看」，不动页面。点由服务端把坐标算出来后的 cdp_click 那一拍做，
   * 而且坐标必须落在这里报上去的框内（服务端校验，见 vision-click.ts）。
   */
  if (task.kind === 'vision') {
    const el = elementForHandle(document, task.payload?.signature, snapOpts());
    if (!el) return { ok: false, error: 'handle_not_found' };
    el.scrollIntoView({ block: 'center' });
    await new Promise((r) => setTimeout(r, 350));
    const box = el.getBoundingClientRect();
    if (box.width <= 0 || box.height <= 0) return { ok: false, error: 'element_not_visible' };
    const shot = await toBackground({ type: 'OFFICIAL_CAPTURE' });
    if (!shot?.ok) return { ok: false, error: shot?.error || 'capture_failed' };
    return {
      ok: true,
      screenshot: shot.dataUrl,
      box: { x: Math.round(box.x), y: Math.round(box.y), width: Math.round(box.width), height: Math.round(box.height) },
      viewport: { width: innerWidth, height: innerHeight },
      formReady: readiness.ready,
    };
  }

  /**
   * 视觉兜底第二拍：在服务端算出的坐标上点一下。
   *
   * 走 chrome.debugger 派发真实事件而不是合成事件——这类控件本来就是合成事件驱动
   * 不了才走到视觉这条路的，再用合成事件点等于绕回原地。
   */
  if (task.kind === 'cdp_click') {
    const { x, y } = task.payload || {};
    if (typeof x !== 'number' || typeof y !== 'number') return { ok: false, error: 'bad_coordinate' };
    const clicked = await toBackground({ type: 'OFFICIAL_CDP_CLICK', x, y });
    await new Promise((r) => setTimeout(r, 400));
    return { ok: Boolean(clicked?.ok), clickedAt: { x, y } };
  }

  if (task.kind === 'submit') {
    const warnings = formWarnings(fields, document);
    if (warnings.includes('verification_required') || warnings.includes('sensitive_questions_require_user_choice') || warnings.includes('resume_requires_user_file_selection')) {
      return { ok: false, error: '页面仍有需要用户处理的验证或敏感问题', warnings };
    }
    const control = findSubmitControl(document);
    if (!control) return { ok: false, error: '未找到提交按钮' };
    control.click();
    return { ok: true, submittedAt: new Date().toISOString(), control: String(control.textContent || control.getAttribute('value') || '').trim() };
  }
  return { ok: false, error: `未知官网任务：${task.kind}` };
}

chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  if (message?.type === 'OFFICIAL_AGENT_STATUS') {
    sendResponse({ ok: true, url: location.href, provider: detectApplicationProvider(location.href) });
    return false;
  }
  if (message?.type === 'OFFICIAL_TASK') {
    // service worker 已按 origin 选过标签页，这里再挡一道：跨站任务绝不执行。
    if (!message.task || !samePage(message.task)) {
      console.log('[pawpals] 收到跨站任务，拒绝执行', message.task?.url);
      sendResponse({ ok: false, error: '任务与当前页面不同源' });
      return false;
    }
    // 扩展侧此前完全无日志：任务到没到页面、执行了多久，只能靠服务端超时反推。
    const startedAt = Date.now();
    console.log(`[pawpals] 收到任务 ${message.task.kind} ${String(message.task.id).slice(0, 20)}`);
    execute(message.task)
      .then((result) => {
        console.log(`[pawpals] 任务完成 ${message.task.kind} 耗时 ${Date.now() - startedAt}ms`, result);
        sendResponse(result);
      })
      .catch((error) => {
        console.warn(`[pawpals] 任务失败 ${message.task.kind} 耗时 ${Date.now() - startedAt}ms`, error);
        sendResponse({ ok: false, error: String(error?.message || error) });
      });
    return true;
  }
  return false;
});

console.log('[pawpals] content script 上线', location.href.slice(0, 60));
void reportPageReady();
