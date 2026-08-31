import { formatElementRows, parseActionForm } from './panel-view.js';

const $ = (id) => document.getElementById(id);
async function activeTabId() { return (await chrome.tabs.query({ active: true, currentWindow: true }))[0]?.id; }
function show(ok, message) { const el = $('result'); el.className = ok ? 'ok' : 'bad'; el.textContent = message; }

$('perceive').addEventListener('click', async () => {
  try {
    const response = await chrome.tabs.sendMessage(await activeTabId(), { type: 'PERCEIVE' });
    const rows = formatElementRows(response.elements);
    $('elements').textContent = rows.length ? rows.map(({ text }) => text).join('\n') : '（页面上没有可交互元素）';
    show(true, `感知到 ${rows.length} 个元素 · ${response.title}`);
  } catch (error) {
    show(false, `感知失败：${error.message}。请先在官网申请页点击 PawPals 扩展图标，再重试。`);
  }
});

$('execute').addEventListener('click', async () => {
  try {
    const action = parseActionForm({ action: $('action').value, index: $('index').value, text: $('text').value, dy: $('dy').value, url: $('url').value });
    const result = await chrome.tabs.sendMessage(await activeTabId(), { type: 'EXECUTE', action });
    show(result.ok, result.ok ? '执行成功' : `执行失败：${result.error}`);
  } catch (error) { show(false, `执行失败：${error.message}`); }
});
