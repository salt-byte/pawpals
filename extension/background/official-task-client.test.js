import { describe, expect, it, vi } from 'vitest';
import { createOfficialTaskClient } from './official-task-client.js';

describe('official task client', () => {
  it('fetches a queued task and reports the result', async () => {
    const fetchImpl = vi.fn()
      .mockResolvedValueOnce({ ok: true, json: async () => ({ task: { id: 'official_1', kind: 'inspect' } }) })
      .mockResolvedValueOnce({ ok: true, json: async () => ({ ok: true }) });
    const client = createOfficialTaskClient({ fetchImpl, base: 'http://localhost:3000' });
    expect(await client.next()).toMatchObject({ id: 'official_1' });
    await client.complete('official_1', { ok: true });
    expect(fetchImpl.mock.calls[1][1]).toMatchObject({ method: 'POST' });
    expect(JSON.parse(fetchImpl.mock.calls[1][1].body)).toEqual({ id: 'official_1', result: { ok: true } });
  });

  it('上报当前页面上下文——content script 不能自己 fetch，只能经 service worker', async () => {
    const fetchImpl = vi.fn().mockResolvedValue({ ok: true, json: async () => ({ ok: true }) });
    const client = createOfficialTaskClient({ fetchImpl, base: 'http://localhost:3000' });
    await client.reportContext({ url: 'https://acme.mokahr.com/apply/1', title: 'Acme', provider: 'moka' });

    const [url, init] = fetchImpl.mock.calls[0];
    expect(url).toBe('http://localhost:3000/api/internal/official-application-context');
    expect(JSON.parse(init.body)).toMatchObject({ provider: 'moka' });
  });

  it('上报失败不抛错——页面上下文丢一次不该把轮询打断', async () => {
    const fetchImpl = vi.fn().mockRejectedValue(new Error('offline'));
    const client = createOfficialTaskClient({ fetchImpl, base: 'http://localhost:3000' });
    await expect(client.reportContext({ url: 'https://x.com/' })).resolves.toBeUndefined();
  });
});
