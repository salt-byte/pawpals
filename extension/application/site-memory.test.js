import { describe, expect, it } from 'vitest';
import { mergeSiteMemory, siteKey } from './site-memory.js';

describe('local site memory', () => {
  it('keys an observation by host and excludes sensitive mappings', () => {
    expect(siteKey('https://jobs.lever.co/Acme/1')).toBe('jobs.lever.co');
    const memory = mergeSiteMemory({}, { url: 'https://jobs.lever.co/acme/1', provider: 'lever', updatedAt: '2026-08-21T00:00:00Z', fields: [
      { label: 'Email', name: 'email', type: 'email', kind: 'email' },
      { label: 'Gender', name: 'gender', type: 'text', kind: 'sensitive_demographic' },
    ] });
    expect(memory.mappings).toEqual([{ label: 'Email', name: 'email', type: 'email', kind: 'email' }]);
  });
});
