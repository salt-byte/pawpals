/** 侧边栏“连接服务器”的纯逻辑：表单解析与配对请求。DOM 在 panel.js。 */

export function parsePairingForm({ serverBase, code }) {
  const base = String(serverBase ?? '').trim().replace(/\/+$/, '');
  if (!/^https?:\/\//i.test(base)) return { ok: false, error: '服务器地址要以 http:// 或 https:// 开头' };
  const cleaned = String(code ?? '').replace(/\s+/g, '').toUpperCase();
  if (cleaned.length !== 8) return { ok: false, error: '配对码是 8 位，请照网页上显示的输入' };
  return { ok: true, base, code: cleaned };
}

export async function pair({ fetchImpl, base, code }) {
  const doFetch = fetchImpl ?? globalThis.fetch;
  try {
    const response = await doFetch(`${base}/api/extension/pair`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ code }),
    });
    const data = await response.json().catch(() => ({}));
    if (!response.ok || !data.ok || !data.token) return { ok: false, error: data.error || `服务端返回 ${response.status}` };
    return { ok: true, token: data.token };
  } catch (error) {
    return { ok: false, error: `连不上服务器：${String(error?.message || error)}` };
  }
}
