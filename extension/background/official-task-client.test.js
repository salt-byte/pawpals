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
});
