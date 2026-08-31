import { describe, expect, it } from 'vitest';
import { fillMokaTextFields, scanMokaFields, verifyMokaFields } from './mokahr.js';

describe('Moka form SOP', () => {
  it('classifies the whole form before changing values', () => {
    document.body.innerHTML = '<div class="string_info"><input aria-label="所在地"></div><div class="cascader"><input aria-label="校招站点"></div>';
    expect(scanMokaFields().map((field) => field.kind)).toEqual(['string_info', 'cascader']);
  });
  it('fills text fields in one pass and verifies after blur', () => {
    document.body.innerHTML = '<div class="string_info"><input></div><div class="select_info"><input></div>';
    expect(fillMokaTextFields(document, [{ index: 0, kind: 'string_info', value: '上海' }, { index: 1, kind: 'select_info', value: '忽略' }])).toEqual([0]);
    expect(verifyMokaFields()[0]).toMatchObject({ value: '上海', validValuePresent: true });
  });
});
