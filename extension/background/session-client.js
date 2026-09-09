/** HTTP client for the PawPals server. */
// 默认仍是本地服务：本地单人版行为一字不变。云端部署时用户在侧边栏填地址并配对。
export const SERVER_BASE = 'http://localhost:3000';

/**
 * 从 chrome.storage.local 读服务器配置。没配过就是默认本地地址、无 token。
 * storage 可注入以便测试。
 */
export async function loadServerConfig({ storage } = {}) {
  const area = storage ?? globalThis.chrome?.storage?.local;
  if (!area) return { base: SERVER_BASE, token: null };
  try {
    const { serverBase, extensionToken } = await area.get(['serverBase', 'extensionToken']);
    return { base: (serverBase || SERVER_BASE).replace(/\/+$/, ''), token: extensionToken || null };
  } catch {
    return { base: SERVER_BASE, token: null };
  }
}

/** base 可以是字符串，也可以是返回字符串的（async）函数——后者每次请求时惰性读配置。 */
export const resolveBase = async (base) => (typeof base === 'function' ? await base() : base);

export function createSessionClient({ fetchImpl, base = SERVER_BASE } = {}) {
  const doFetch = fetchImpl ?? globalThis.fetch;
  return {
    async ping() {
      try {
        return (await doFetch(`${await resolveBase(base)}/api/health`, { method: 'GET' })).ok === true;
      } catch {
        return false;
      }
    },
    async report(sessionId, payload) {
      try {
        const response = await doFetch(`${await resolveBase(base)}/api/internal/browser-task-done`, {
          method: 'POST', headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ id: sessionId, result: payload }),
        });
        if (!response.ok) return { ok: false, error: `服务端返回 ${response.status}` };
        return await response.json();
      } catch (error) {
        return { ok: false, error: String(error?.message || error) };
      }
    },
  };
}
