import { describe, expect, it } from 'vitest';
import { detectApplicationProvider, normaliseField } from './schema.js';

describe('official application schema', () => {
  it('recognises common ATS providers and falls back safely', () => {
    expect(detectApplicationProvider('https://boards.greenhouse.io/acme/jobs/1')).toBe('greenhouse');
    expect(detectApplicationProvider('https://jobs.lever.co/acme/1')).toBe('lever');
    expect(detectApplicationProvider('https://acme.myworkdayjobs.com/job/1')).toBe('workday');
    expect(detectApplicationProvider('https://careers.acme.example/job/1')).toBe('generic');
  });
  it('classifies standard, sensitive, and user-only fields', () => {
    expect(normaliseField({ label: 'Email address', required: true }, 0)).toMatchObject({ kind: 'email', required: true });
    expect(normaliseField({ label: 'Upload resume', type: 'file' }, 1).kind).toBe('resume');
    expect(normaliseField({ label: 'Gender identity' }, 2).kind).toBe('sensitive_demographic');
  });
});
