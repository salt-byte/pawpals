import { describe, expect, it } from 'vitest';
import { formatElementRows, parseActionForm } from './panel-view.js';

describe('panel view helpers', () => {
  it('formats collected elements for display', () => {
    expect(formatElementRows([{ index: 0, type: 'button', label: '立即沟通' }, { index: 1, type: 'input', label: '' }]))
      .toEqual([{ index: 0, text: '[0] button "立即沟通"' }, { index: 1, text: '[1] input "（无文案）"' }]);
  });
  it('parses each manual action form shape', () => {
    expect(parseActionForm({ action: 'click', index: '3' })).toEqual({ action: 'click', index: 3 });
    expect(parseActionForm({ action: 'type', index: '1', text: 'AI产品经理' })).toEqual({ action: 'type', index: 1, text: 'AI产品经理' });
    expect(parseActionForm({ action: 'scroll', dy: '400' })).toEqual({ action: 'scroll', dy: 400 });
    expect(parseActionForm({ action: 'navigate', url: 'https://example.test/' })).toEqual({ action: 'navigate', url: 'https://example.test/' });
  });
});
