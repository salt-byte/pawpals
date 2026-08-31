import { createOfficialTaskClient } from '../background/official-task-client.js';
import { collectApplicationFields, fillApplicationFields, findSubmitControl, formWarnings } from '../application/form.js';
import { detectApplicationProvider } from '../application/schema.js';
import { mergeSiteMemory, siteKey } from '../application/site-memory.js';

const client = createOfficialTaskClient();
let busy = false;

async function reportActivePage() {
  try {
    await fetch('http://localhost:3000/api/internal/official-application-context', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ url: location.href, title: document.title, provider: detectApplicationProvider(location.href) }),
    });
  } catch (error) {
    console.warn('[pawpals official agent] cannot report current page', error);
  }
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
  if (task.kind === 'fill') {
    const { filled, skipped } = fillApplicationFields(document, task.payload?.values || []);
    const warnings = formWarnings(fields, document);
    return {
      ok: true, filled, skipped, warnings,
      requiresUserFileSelection: warnings.includes('resume_requires_user_file_selection'),
    };
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

async function poll() {
  if (busy) return;
  busy = true;
  try {
    const task = await client.next();
    if (!task || !samePage(task)) return;
    const result = await execute(task);
    await client.complete(task.id, result);
  } catch (error) {
    console.warn('[pawpals official agent]', error);
  } finally { busy = false; }
}

chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  if (message?.type !== 'OFFICIAL_AGENT_STATUS') return false;
  sendResponse({ ok: true, url: location.href, provider: detectApplicationProvider(location.href) });
  return false;
});

void reportActivePage();
void poll();
setInterval(poll, 1500);
