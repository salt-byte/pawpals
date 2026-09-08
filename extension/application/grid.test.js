import { describe, expect, it } from 'vitest';
import { gridHeaderFor } from './grid.js';

/**
 * 表格里的格子，标签在列头上。
 *
 * 真机（简道云 .fx-subform）：获奖经历、社团干部经历、实习经历、项目经历都是
 * 子表单，每个格子周围一个字都没有——「向上找标题」那套完全失效，模型看到的
 * context 是空的或者是行号「1」，这些字段一个都填不了。
 *
 * 结构是规整的：
 *   .fx-subform
 *     .subform-head    > .subform-row    > .subform-cell > .subform-title   列头
 *     .subform-content > .fx-subform-row > .subform-cell                    数据行
 *
 * 数据行前面多一个 .error-tip-row、后面多一个 .row-head，所以**只数带 cell 的
 * 那些格子**，第 N 个正好对第 N 个列头。
 */
const build = () => {
  document.body.innerHTML = `
    <div class="fx-subform">
      <div class="subform-head">
        <div class="subform-row">
          <div class="subform-cell"><div class="subform-title">*获奖类型</div></div>
          <div class="subform-cell"><div class="subform-title">*奖项名称</div></div>
          <div class="subform-cell"><div class="subform-title">获奖时间</div></div>
        </div>
      </div>
      <div class="subform-content">
        <div class="fx-subform-row">
          <div class="error-tip-row"></div>
          <div class="subform-cell"><div class="x-combo">请选择</div></div>
          <div class="subform-cell"><input id="award-name" /></div>
          <div class="subform-cell"><input id="award-date" /></div>
          <div class="row-head">1</div>
        </div>
      </div>
    </div>`;
  return document.body;
};

describe('gridHeaderFor', () => {
  it('按序号对上列头，前后的杂项格子不参与计数', () => {
    build();
    expect(gridHeaderFor(document.getElementById('award-name'))).toBe('奖项名称');
    expect(gridHeaderFor(document.getElementById('award-date'))).toBe('获奖时间');
  });

  it('去掉必填星号', () => {
    build();
    const first = document.querySelector('.fx-subform-row .subform-cell .x-combo');
    expect(gridHeaderFor(first)).toBe('获奖类型');
  });

  it('不在表格里的控件返回空——不猜', () => {
    document.body.innerHTML = '<div class="fx-field"><div class="field-name">姓名</div><input id="n"></div>';
    expect(gridHeaderFor(document.getElementById('n'))).toBe('');
  });

  it('列头数量对不上时返回空，宁可没有也不给错标签', () => {
    build();
    document.querySelector('.subform-head .subform-row').innerHTML = '<div class="subform-cell"><div class="subform-title">*获奖类型</div></div>';
    expect(gridHeaderFor(document.getElementById('award-date'))).toBe('');
  });

  it('没有列头行时返回空', () => {
    build();
    document.querySelector('.subform-head').remove();
    expect(gridHeaderFor(document.getElementById('award-name'))).toBe('');
  });

  it('传 null 不炸', () => {
    expect(gridHeaderFor(null)).toBe('');
  });
});

import { snapshotControls } from './snapshot.js';

/**
 * 端到端：真实简道云子表单结构下，快照给模型的 context 应该是「表名 · 列名」。
 * 光给列名不行——四张经历表都有「开始时间」，模型分不清是哪张表的。
 */
describe('快照里的表格字段', () => {
  it('context 是「表名 · 列名」', () => {
    document.body.innerHTML = `
      <div class="fx-field">
        <div class="field-name">*获奖经历</div>
        <div class="fx-subform">
          <div class="subform-head">
            <div class="subform-row">
              <div class="subform-cell"><div class="subform-title">*奖项名称</div></div>
              <div class="subform-cell"><div class="subform-title">获奖时间</div></div>
            </div>
          </div>
          <div class="subform-content">
            <div class="fx-subform-row">
              <div class="error-tip-row"></div>
              <div class="subform-cell"><input name="a" /></div>
              <div class="subform-cell"><input name="b" /></div>
              <div class="row-head">1</div>
            </div>
          </div>
        </div>
      </div>`;
    const controls = snapshotControls(document.body);
    // 表名自己也带必填星号（真机上就是「*获奖经历」）。曾经用「开头是星号就跳过」
    // 来排除列头，把表名一起排掉了——两张表的同名列于是撞在一起。
    expect(controls.map((c) => c.context)).toEqual(['获奖经历 · 奖项名称', '获奖经历 · 获奖时间']);
  });

  it('两张表的同名列不会撞在一起——句柄也因此是唯一的', () => {
    const table = (name, col) => `
      <div class="fx-field"><div class="field-name">${name}</div>
        <div class="fx-subform">
          <div class="subform-head"><div class="subform-row">
            <div class="subform-cell"><div class="subform-title">${col}</div></div>
          </div></div>
          <div class="subform-content"><div class="fx-subform-row">
            <div class="subform-cell"><input /></div>
          </div></div>
        </div>
      </div>`;
    document.body.innerHTML = table('社团干部经历', '开始时间') + table('实习经历', '开始时间');
    const controls = snapshotControls(document.body);
    expect(controls.map((c) => c.context)).toEqual(['社团干部经历 · 开始时间', '实习经历 · 开始时间']);
    expect(new Set(controls.map((c) => c.handle)).size).toBe(2);
  });
});
