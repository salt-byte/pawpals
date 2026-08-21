import { describe, expect, it, vi } from 'vitest';
import { createSessionClient, SERVER_BASE } from './session-client.js';

describe('local session client', () => {
  it('uses the documented local service endpoint and handles health errors', async () => {
    expect(SERVER_BASE).toBe('http://localhost:3000');
    const live = createSessionClient({ fetchImpl: vi.fn().mockResolvedValue({ ok: true }) });
    expect(await live.ping()).toBe(true);
    const offline = createSessionClient({ fetchImpl: vi.fn().mockRejectedValue(new Error('offline')) });
    expect(await offline.ping()).toBe(false);
  });

  it('reports a browser result as a JSON POST without throwing on server failure', async () => {
    const fetchImpl = vi.fn().mockResolvedValue({ ok: true, json: async () => ({ ok: true }) });
    const client = createSessionClient({ fetchImpl });
    expect(await client.report('sess-1', { ok: true, step: 3 })).toEqual({ ok: true });
    const [url, request] = fetchImpl.mock.calls[0];
    expect(url).toBe(`${SERVER_BASE}/api/internal/browser-task-done`);
    expect(request.method).toBe('POST');
    expect(JSON.parse(request.body)).toEqual({ id: 'sess-1', result: { ok: true, step: 3 } });
  });
});
