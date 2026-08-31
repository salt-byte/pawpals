import { SERVER_BASE } from './session-client.js';

export function createOfficialTaskClient({ fetchImpl, base = SERVER_BASE } = {}) {
  const doFetch = fetchImpl ?? globalThis.fetch;
  return {
    async next() {
      const response = await doFetch(`${base}/api/internal/official-application-task`);
      if (!response.ok) throw new Error(`任务服务返回 ${response.status}`);
      return (await response.json()).task || null;
    },
    async complete(id, result) {
      const response = await doFetch(`${base}/api/internal/official-application-task-done`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ id, result }),
      });
      if (!response.ok) throw new Error(`任务回报失败：${response.status}`);
      return response.json();
    },
  };
}
