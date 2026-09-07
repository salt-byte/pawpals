import { describe, expect, it } from 'vitest';
import {
  BUILTIN_ADAPTERS,
  GENERIC_SELECTORS,
  createAdapterRegistry,
  normalizeAdapter,
} from './adapters.js';

/**
 * 站点适配器是三层里的第一层：命中已知平台就用确定的选择器，不必每次让模型
 * 现场推理。中国校招网申集中在少数几个 ATS，踩通一家 = 这家以后全对。
 *
 * 但适配器要能从服务端热下发，所以它是**不受信的数据**：不能声明 kind（否则
 * 安全闸可被绕过）、host 匹配必须严格（否则注册个域名就能指定选择器）。
 */
describe('normalizeAdapter', () => {
  it('留下选择器', () => {
    const adapter = normalizeAdapter({ id: 'x', hosts: ['a.com'], panel: '.p', option: '.o', labelSelector: '.l' });
    expect(adapter).toMatchObject({ id: 'x', panel: '.p', option: '.o', labelSelector: '.l' });
  });

  it('丢掉 kind——安全闸不能被下发的数据改写', () => {
    const adapter = normalizeAdapter({ id: 'x', hosts: ['a.com'], kind: 'text', fields: [{ kind: 'text' }] });
    expect(adapter).not.toHaveProperty('kind');
    expect(adapter).not.toHaveProperty('fields');
  });

  it('没有 id 或 hosts 就当它不存在——宁可回退到通用路径', () => {
    expect(normalizeAdapter({ hosts: ['a.com'] })).toBeNull();
    expect(normalizeAdapter({ id: 'x', hosts: [] })).toBeNull();
    expect(normalizeAdapter(null)).toBeNull();
    expect(normalizeAdapter('nope')).toBeNull();
  });

  it('host 归一化：大小写和 www. 不该影响命中', () => {
    expect(normalizeAdapter({ id: 'x', hosts: ['WWW.A.COM'] }).hosts).toEqual(['a.com']);
  });
});

describe('createAdapterRegistry', () => {
  const registry = createAdapterRegistry([
    { id: 'jdy', hosts: ['jiandaoyun.com'], panel: '.x-popup', labelSelector: '.field-name' },
  ]);

  it('子域命中', () => {
    expect(registry.for('https://t6ixa9nyl6.jiandaoyun.com/f/65e1')?.id).toBe('jdy');
  });

  it('主域本身命中', () => {
    expect(registry.for('https://jiandaoyun.com/f/1')?.id).toBe('jdy');
  });

  it('相似域名不命中——不能建个域名就冒充平台', () => {
    expect(registry.for('https://evil-jiandaoyun.com/f/1')).toBeNull();
    expect(registry.for('https://jiandaoyun.com.attacker.net/f/1')).toBeNull();
  });

  it('陌生站点返回 null，调用方走通用路径', () => {
    expect(registry.for('https://careers.example.com/apply')).toBeNull();
  });

  it('URL 不合法不炸', () => {
    expect(registry.for('not a url')).toBeNull();
    expect(registry.for(undefined)).toBeNull();
  });

  it('命中时用适配器的选择器收窄通用选择器', () => {
    const s = registry.selectorsFor('https://a.jiandaoyun.com/f/1');
    expect(s).toMatchObject({ provider: 'jdy', panel: '.x-popup', labelSelector: '.field-name' });
  });

  it('没命中时退回通用选择器，行为和加适配器之前一致', () => {
    const s = registry.selectorsFor('https://careers.example.com/apply');
    expect(s.provider).toBe('generic');
    expect(s.panel).toBe(GENERIC_SELECTORS.panel);
  });

  it('适配器没写某一项时，那一项退回通用值——可以只覆盖一部分', () => {
    const partial = createAdapterRegistry([{ id: 'p', hosts: ['p.com'], labelSelector: '.l' }]);
    const s = partial.selectorsFor('https://p.com/x');
    expect(s.panel).toBe(GENERIC_SELECTORS.panel);
    expect(s.labelSelector).toBe('.l');
  });

  it('坏数据被跳过，好数据仍然生效', () => {
    const mixed = createAdapterRegistry([null, { id: '' }, { id: 'ok', hosts: ['ok.com'], panel: '.k' }]);
    expect(mixed.all()).toHaveLength(1);
    expect(mixed.selectorsFor('https://ok.com/a').panel).toBe('.k');
  });
});

describe('BUILTIN_ADAPTERS', () => {
  it('内置表本身是合法的', () => {
    for (const raw of BUILTIN_ADAPTERS) expect(normalizeAdapter(raw)).not.toBeNull();
  });

  it('只收录真机抓过 DOM 的平台——猜出来的选择器会顶掉通用兜底且失败得很安静', () => {
    expect(createAdapterRegistry().all().map((a) => a.id).sort()).toEqual(['jiandaoyun', 'moka']);
  });
});
