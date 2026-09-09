import { formatElementRows, parseActionForm } from './panel-view.js';
import { parsePairingForm, pair } from './pairing.js';

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

// ── 连接服务器 ────────────────────────────────────────────────────────
async function refreshPairStatus() {
  const { serverBase, extensionToken } = await chrome.storage.local.get(['serverBase', 'extensionToken']);
  $('server-base').value = serverBase || '';
  $('pair-status').textContent = extensionToken
    ? `已绑定到 ${serverBase || 'http://localhost:3000'}`
    : '（本地单人版不需要配对）';
}
void refreshPairStatus();

$('pair').addEventListener('click', async () => {
  const parsed = parsePairingForm({ serverBase: $('server-base').value || 'http://localhost:3000', code: $('pair-code').value });
  if (!parsed.ok) return show(false, parsed.error);
  const result = await pair({ base: parsed.base, code: parsed.code });
  if (!result.ok) return show(false, result.error);
  await chrome.storage.local.set({ serverBase: parsed.base, extensionToken: result.token });
  await chrome.runtime.sendMessage({ type: 'RECONNECT_SERVER' });
  $('pair-code').value = '';
  await refreshPairStatus();
  show(true, '配对成功，插件已重新连接');
});

$('unpair').addEventListener('click', async () => {
  await chrome.storage.local.remove(['serverBase', 'extensionToken']);
  await chrome.runtime.sendMessage({ type: 'RECONNECT_SERVER' });
  await refreshPairStatus();
  show(true, '已清除，回到本地服务器');
});
