import { beforeEach, describe, expect, it, vi } from 'vitest';
import { createWidgetDriver } from './widget.js';

beforeEach(() => { document.body.innerHTML = ''; });

const COMBO =
  '<div class="fx-field"><span class="field-required">*</span><div class="field-name">学历</div>' +
  '<div class="field-component"><div class="fx-form-combo"><div class="x-combo">' +
  '<div class="x-combo-dropdown-label"><div class="value-wrapper"></div></div>' +
  '</div></div></div></div>';

/**
 * 假点击模拟页面的反应：点触发器就把选项面板插进 DOM，点选项就把值写进
 * value-wrapper 并收起面板。这正是真实控件的契约——jsdom 没有布局，可见性和
 * 命中测试只能注入。真实行为已在帆软页上验证：合成事件能展开面板。
 */
function driverFor({ options = ['本科', '研究生'], onOptionClick } = {}) {
  const clicked = [];
  const panelHtml = () =>
    `<div class="x-popup x-combo-dropdown"><div class="x-combo-dropdown-list">` +
    options.map((o) => `<div class="x-combo-dropdown-item">${o}</div>`).join('') +
    `</div></div>`;

  // 真实页面按 Esc / 点外部会收起面板，假页面也要照做，否则「探测完要收起」
  // 这条断言验的是假实现而不是驱动器。
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') document.querySelector('.x-popup')?.remove();
  });

  const click = vi.fn(async (el) => {
    clicked.push((el.className || '').toString());
    if (el.closest('.x-combo')) {
      document.body.insertAdjacentHTML('beforeend', panelHtml());
      return;
    }
    if (el.classList.contains('x-combo-dropdown-item')) {
      if (onOptionClick) return onOptionClick(el);
      document.querySelector('.value-wrapper').textContent = el.textContent;
      document.querySelector('.x-popup')?.remove();
    }
  });

  const driver = createWidgetDriver({
    click,
    wait: async () => {},
    // jsdom 没有布局：把「中心点最顶层元素」和「是否可见」替换成结构性判断
    elementAtCenter: (el) => el.querySelector('.x-combo-dropdown-label') || el,
    isVisible: (el) => document.body.contains(el),
  });
  return { driver, click, clicked };
}

const container = () => document.querySelector('.fx-field');

describe('probeOptions', () => {
  it('点开控件，把选项读出来，再收起', async () => {
    document.body.innerHTML = COMBO;
    const { driver } = driverFor();
    const options = await driver.probeOptions(container());

    expect(options).toEqual(['本科', '研究生']);
    expect(document.querySelector('.x-popup')).toBe(null); // 探测完要收起，不留残留面板
  });

  it('点的是控件中心那个元素，不是外层容器', async () => {
    document.body.innerHTML = COMBO;
    const { driver, clicked } = driverFor();
    await driver.probeOptions(container());
    expect(clicked[0]).toContain('x-combo-dropdown-label');
  });

  it('点开后没有出现新面板时返回空数组，不抛错', async () => {
    document.body.innerHTML = COMBO;
    const driver = createWidgetDriver({
      click: async () => {},
      wait: async () => {},
      elementAtCenter: (el) => el,
      isVisible: () => true,
    });
    expect(await driver.probeOptions(container())).toEqual([]);
  });

  it('已经存在的同类元素不会被当成新选项', async () => {
    document.body.innerHTML =
      '<div class="x-combo-dropdown-item">早就在的东西</div>' + COMBO;
    const { driver } = driverFor();
    expect(await driver.probeOptions(container())).toEqual(['本科', '研究生']);
  });
});

describe('selectOption', () => {
  it('选中匹配的选项并回读确认', async () => {
    document.body.innerHTML = COMBO;
    const { driver } = driverFor();
    const result = await driver.selectOption(container(), '研究生');

    expect(result).toMatchObject({ ok: true, value: '研究生' });
    expect(document.querySelector('.value-wrapper').textContent).toBe('研究生');
  });

  it('选项里没有这个值时不乱点，报明确原因', async () => {
    document.body.innerHTML = COMBO;
    const { driver } = driverFor();
    const result = await driver.selectOption(container(), '博士');

    expect(result).toMatchObject({ ok: false, reason: 'option_not_found' });
    expect(result.options).toEqual(['本科', '研究生']);
  });

  it('点了但值没落下去要如实报告，不谎报成功', async () => {
    document.body.innerHTML = COMBO;
    const { driver } = driverFor({ onOptionClick: () => { /* 页面把这次点击吃掉了 */ } });
    const result = await driver.selectOption(container(), '本科');

    expect(result).toMatchObject({ ok: false, reason: 'value_not_applied' });
  });

  it('选项文字前后有空白也能匹配上', async () => {
    document.body.innerHTML = COMBO;
    const { driver } = driverFor({ options: ['  本科  ', '研究生'] });
    const result = await driver.selectOption(container(), '本科');
    expect(result.ok).toBe(true);
  });
});

describe('第一次点击被别的面板吃掉时要重试', () => {
  it('页面上已经开着别的面板时，第一次点击只是关掉它——要再点一次才展开自己的', async () => {
    document.body.innerHTML = COMBO;
    let otherPanelOpen = true;
    const clicks = [];
    const driver = createWidgetDriver({
      click: async (el) => {
        clicks.push(el.className);
        if (otherPanelOpen) { otherPanelOpen = false; return; } // 这一下只关掉了别人的面板
        document.body.insertAdjacentHTML('beforeend',
          '<div class="x-popup"><div class="x-combo-dropdown-item">本科</div></div>');
      },
      wait: async () => {},
      elementAtCenter: (el) => el.querySelector('.x-combo-dropdown-label') || el,
      isVisible: (el) => document.body.contains(el),
    });

    expect(await driver.probeOptions(container())).toEqual(['本科']);
    expect(clicks).toHaveLength(2);
  });

  it('重试之后仍然没有面板就放弃，不无限点下去', async () => {
    document.body.innerHTML = COMBO;
    const clicks = [];
    const driver = createWidgetDriver({
      click: async (el) => { clicks.push(el.className); },
      wait: async () => {},
      elementAtCenter: (el) => el,
      isVisible: () => true,
    });
    expect(await driver.probeOptions(container())).toEqual([]);
    expect(clicks.length).toBeLessThanOrEqual(2);
  });
});

