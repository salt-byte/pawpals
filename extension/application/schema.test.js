import { describe, expect, it } from 'vitest';
import { detectApplicationProvider, fieldSignature, normaliseField } from './schema.js';

describe('official application schema', () => {
  it('recognises common ATS providers and falls back safely', () => {
    expect(detectApplicationProvider('https://boards.greenhouse.io/acme/jobs/1')).toBe('greenhouse');
    expect(detectApplicationProvider('https://jobs.lever.co/acme/1')).toBe('lever');
    expect(detectApplicationProvider('https://acme.myworkdayjobs.com/job/1')).toBe('workday');
    expect(detectApplicationProvider('https://careers.acme.example/job/1')).toBe('generic');
  });

  it('认得国内主流 ATS', () => {
    expect(detectApplicationProvider('https://app.mokahr.com/campus-recruitment/acme/1')).toBe('moka');
    expect(detectApplicationProvider('https://acme.mokahr.com/apply/1')).toBe('moka');
    expect(detectApplicationProvider('https://acme.zhiye.com/campus/job/1')).toBe('beisen');
    expect(detectApplicationProvider('https://acme.italent.cn/job/1')).toBe('beisen');
    expect(detectApplicationProvider('https://acme.dayeejob.com/job/1')).toBe('dayee');
  });

  it('URL 无法解析时安全回退', () => {
    expect(detectApplicationProvider('')).toBe('generic');
    expect(detectApplicationProvider('not a url')).toBe('generic');
  });

  it('classifies standard, sensitive, and user-only fields', () => {
    expect(normaliseField({ label: 'Email address', required: true }, 0)).toMatchObject({ kind: 'email', required: true });
    expect(normaliseField({ label: 'Upload resume', type: 'file' }, 1).kind).toBe('resume');
    expect(normaliseField({ label: 'Gender identity' }, 2).kind).toBe('sensitive_demographic');
  });
});

describe('fieldSignature', () => {
  it('同一字段在重渲染前后签名一致', () => {
    const raw = { name: 'email', id: 'e1', type: 'email', label: 'Email' };
    expect(fieldSignature(raw)).toBe(fieldSignature({ ...raw }));
  });

  it('索引不参与签名——位置变了签名不该变', () => {
    const raw = { name: 'email', id: 'e1', type: 'email', label: 'Email' };
    expect(normaliseField(raw, 0).signature).toBe(normaliseField(raw, 7).signature);
  });

  it('不同字段签名不同', () => {
    expect(fieldSignature({ name: 'email' })).not.toBe(fieldSignature({ name: 'phone' }));
  });

  it('大小写与多余空白不影响签名', () => {
    expect(fieldSignature({ label: '  Email  Address ' })).toBe(fieldSignature({ label: 'email address' }));
  });
});
