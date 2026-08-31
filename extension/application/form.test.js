import { beforeEach, describe, expect, it } from 'vitest';
import { collectApplicationFields, fillApplicationFields, findSubmitControl, formWarnings } from './form.js';

beforeEach(() => { document.body.innerHTML = ''; });
describe('generic official application form', () => {
  it('extracts fields, warnings, and the final submission control', () => {
    document.body.innerHTML = '<label for="email">Email</label><input id="email" required><input type="file" aria-label="Resume"><button>Submit application</button>';
    const fields = collectApplicationFields();
    expect(fields.map((field) => field.kind)).toEqual(['email', 'resume']);
    expect(formWarnings(fields)).toContain('resume_requires_user_file_selection');
    expect(findSubmitControl()?.textContent).toContain('Submit');
  });
  it('fills only explicitly provided, non-file fields', () => {
    document.body.innerHTML = '<input><input type="file">';
    expect(fillApplicationFields(document, [{ index: 0, value: 'a@example.com' }, { index: 1, value: 'resume.pdf' }])).toEqual([0]);
    expect(document.querySelector('input').value).toBe('a@example.com');
  });
});
