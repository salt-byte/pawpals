import { collectApplicationFields, fillApplicationFields, findSubmitControl, formWarnings, verifyFilledFields, collectWidgetTargets } from '../application/form.js';
import { detectApplicationProvider } from '../application/schema.js';
import { mergeSiteMemory, siteKey } from '../application/site-memory.js';
import { applyFileUploads } from '../application/file-upload.js';
import { applyWidgetValues, createPageWidgetDriver, probeWidgets } from '../application/widget.js';
import { syntheticImpl } from '../act/synthetic.js';

/** 驱动纯 div 模拟控件用的点击实现。合成事件在真机上验证过是有效的。 */
const widgetDriver = createPageWidgetDriver({ click: (el) => syntheticImpl.click(el, { fast: true }) });
import { sendToBackground } from './bg-bridge.js';

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
  const fields = collectApplicationFields(document);
  if (task.kind === 'inspect') {
    const provider = detectApplicationProvider(location.href);
    const warnings = formWarnings(fields, document);
    await remember({ url: location.href, provider, fields });
    return { ok: true, provider, url: location.href, title: document.title, fields, warnings, hasSubmit: Boolean(findSubmitControl(document)) };
  }
  if (task.kind === 'upload') {
    // 上传单独成一拍：不少站点解析简历后会把结果覆盖到表单上，上传完立刻填
    // 等于白填。这一拍只装文件，等页面解析完再由后续的 inspect + fill 接手。
    const { uploaded, skipped } = applyFileUploads(document, task.payload?.uploads || []);
    return { ok: true, uploaded, skipped, warnings: formWarnings(collectApplicationFields(document), document) };
  }

  if (task.kind === 'fill') {
    const values = task.payload?.values || [];
    const { filled, skipped } = fillApplicationFields(document, values);

    // 失焦一次再回读：带延迟校验的表单（Moka 这类）会在失焦时才决定要不要
    // 保留脚本写入的值，不回读就分不清「填进去了」和「填了又被清掉」。
    document.activeElement?.blur?.();
    const { stuck, lost } = verifyFilledFields(document, filled);

    // 纯 div 模拟的下拉/多选：fillApplicationFields 按 unsupported_widget 跳过
    // 了它们，这里改用驱动器点开面板选中。放在原生字段之后，因为点开面板会滚动
    // 页面，先做会干扰上面的回读。
    const widgetTargets = skipped
      .filter((item) => item.reason === 'unsupported_widget')
      .map((item) => values.find((value) => value.signature === item.signature))
      .filter(Boolean);
    const widgets = await applyWidgetValues(document, widgetTargets, { driver: widgetDriver });

    const warnings = formWarnings(collectApplicationFields(document), document);
    return {
      ok: true,
      filled: [...stuck, ...widgets.filled],
      // widget 的失败带着可选项一起报上去，用户能看到「可选的是这几个」
      skipped: [...skipped.filter((item) => item.reason !== 'unsupported_widget'), ...widgets.skipped],
      lost, warnings,
      requiresUserFileSelection: warnings.includes('resume_requires_user_file_selection'),
    };
  }

  if (task.kind === 'probe') {
    // 探测自定义控件的可选项：这类控件的选项是点开时才渲染的，inspect 采不到。
    // 服务端拿到之后才能让模型在合法值里选，而不是自由发挥。
    //
    // 带边界：单个控件真机实测约 2.8 秒，全量探完会让任务超时并把队列堵死。
    const { probed, partial } = await probeWidgets(collectWidgetTargets(document), {
      driver: widgetDriver,
      signatures: task.payload?.signatures,
      budgetMs: Number(task.payload?.budgetMs) || 20000,
    });
    return { ok: true, probed, partial };
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
      sendResponse({ ok: false, error: '任务与当前页面不同源' });
      return false;
    }
    execute(message.task)
      .then(sendResponse)
      .catch((error) => sendResponse({ ok: false, error: String(error?.message || error) }));
    return true;
  }
  return false;
});

void reportPageReady();
