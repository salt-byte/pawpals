import { describe, expect, it, vi } from 'vitest';
import { parsePairingForm, pair } from './pairing.js';

describe('parsePairingForm', () => {
  it('地址去尾部斜杠、配对码去空格转大写', () => {
    expect(parsePairingForm({ serverBase: ' https://paw.example.com/ ', code: ' abcd 2345 ' }))
      .toEqual({ ok: true, base: 'https://paw.example.com', code: 'ABCD2345' });
  });
  it('地址必须以 http(s):// 开头', () => {
    expect(parsePairingForm({ serverBase: 'paw.example.com', code: 'ABCD2345' })).toMatchObject({ ok: false, error: expect.stringContaining('http') });
  });
  it('配对码必须是 8 位', () => {
    expect(parsePairingForm({ serverBase: 'http://localhost:3000', code: 'ABC' })).toMatchObject({ ok: false, error: expect.stringContaining('8') });
  });
});

describe('pair', () => {
  it('POST /api/extension/pair，成功返回 token', async () => {
    const fetchImpl = vi.fn().mockResolvedValue({ ok: true, json: async () => ({ ok: true, token: 'ext_x' }) });
    expect(await pair({ fetchImpl, base: 'https://paw.example.com', code: 'ABCD2345' })).toEqual({ ok: true, token: 'ext_x' });
    const [url, request] = fetchImpl.mock.calls[0];
    expect(url).toBe('https://paw.example.com/api/extension/pair');
    expect(JSON.parse(request.body)).toEqual({ code: 'ABCD2345' });
  });
  it('服务端拒绝时带回它的错误文案', async () => {
    const fetchImpl = vi.fn().mockResolvedValue({ ok: false, json: async () => ({ ok: false, error: '配对码不对或已过期' }) });
    expect(await pair({ fetchImpl, base: 'https://paw.example.com', code: 'ABCD2345' })).toEqual({ ok: false, error: '配对码不对或已过期' });
  });
  it('连不上服务器时不抛错', async () => {
    const fetchImpl = vi.fn().mockRejectedValue(new Error('offline'));
    expect(await pair({ fetchImpl, base: 'https://paw.example.com', code: 'ABCD2345' })).toMatchObject({ ok: false, error: expect.stringContaining('连不上') });
  });
});
