/** HTTP client for the locally running PawPals server. */
// The desktop/web server defaults to port 3000 (PAWPALS_PORT can override it).
export const SERVER_BASE = 'http://localhost:3000';

export function createSessionClient({ fetchImpl, base = SERVER_BASE } = {}) {
  const doFetch = fetchImpl ?? globalThis.fetch;
  return {
    async ping() {
      try {
        return (await doFetch(`${base}/api/health`, { method: 'GET' })).ok === true;
      } catch {
        return false;
      }
    },
    async report(sessionId, payload) {
      try {
        const response = await doFetch(`${base}/api/internal/browser-task-done`, {
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
