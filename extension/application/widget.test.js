import { beforeEach, describe, expect, it, vi } from 'vitest';
import { createWidgetDriver, applyWidgetValues, probeWidgets } from './widget.js';
import { widgetContainerFor } from './form.js';

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

describe('widgetContainerFor', () => {
  it('按签名找回 widget 的容器元素', async () => {
    document.body.innerHTML = COMBO;
    const { collectApplicationFields } = await import('./form.js');
    const [field] = collectApplicationFields(document);
    const container = widgetContainerFor(document, field.signature);
    expect(container).toBe(document.querySelector('.fx-field'));
  });

  it('签名对不上时返回 null', () => {
    document.body.innerHTML = COMBO;
    expect(widgetContainerFor(document, 'name=|id=|type=widget|label=不存在')).toBe(null);
  });
});

describe('applyWidgetValues', () => {
  const twoCombos = COMBO + COMBO.replace('学历', '学位');

  it('把值交给驱动器，成功的记进 filled', async () => {
    document.body.innerHTML = COMBO;
    const { collectApplicationFields } = await import('./form.js');
    const [field] = collectApplicationFields(document);
    const driver = { selectOption: vi.fn(async () => ({ ok: true, value: '本科' })) };

    const result = await applyWidgetValues(document, [{ signature: field.signature, value: '本科' }], { driver });
    expect(result.filled).toEqual([field.signature]);
    expect(result.skipped).toEqual([]);
    expect(driver.selectOption).toHaveBeenCalledWith(document.querySelector('.fx-field'), '本科');
  });

  it('驱动器失败时带上原因和可选项，不算填上', async () => {
    document.body.innerHTML = COMBO;
    const { collectApplicationFields } = await import('./form.js');
    const [field] = collectApplicationFields(document);
    const driver = { selectOption: vi.fn(async () => ({ ok: false, reason: 'option_not_found', options: ['本科'] })) };

    const result = await applyWidgetValues(document, [{ signature: field.signature, value: '博士' }], { driver });
    expect(result.filled).toEqual([]);
    expect(result.skipped[0]).toMatchObject({ reason: 'option_not_found', options: ['本科'] });
  });

  it('容器找不到时跳过，不去猜别的控件', async () => {
    document.body.innerHTML = COMBO;
    const driver = { selectOption: vi.fn() };
    const result = await applyWidgetValues(document, [{ signature: 'name=|id=|type=widget|label=没有这个', value: 'x' }], { driver });
    expect(driver.selectOption).not.toHaveBeenCalled();
    expect(result.skipped[0]).toMatchObject({ reason: 'not_found' });
  });

  it('驱动器抛错时算失败而不是整批崩掉', async () => {
    document.body.innerHTML = twoCombos;
    const { collectApplicationFields } = await import('./form.js');
    const fields = collectApplicationFields(document);
    const driver = {
      selectOption: vi.fn()
        .mockRejectedValueOnce(new Error('页面炸了'))
        .mockResolvedValueOnce({ ok: true, value: '哲学' }),
    };
    const result = await applyWidgetValues(document, [
      { signature: fields[0].signature, value: 'A' },
      { signature: fields[1].signature, value: '哲学' },
    ], { driver });

    expect(result.skipped[0]).toMatchObject({ reason: 'driver_error' });
    expect(result.filled).toEqual([fields[1].signature]);
  });

  it('没有 widget 值要填时不启动驱动器', async () => {
    document.body.innerHTML = COMBO;
    const driver = { selectOption: vi.fn() };
    expect(await applyWidgetValues(document, [], { driver })).toEqual({ filled: [], skipped: [] });
    expect(driver.selectOption).not.toHaveBeenCalled();
  });
});

/**
 * 真机实测：单个 widget 探测约 2.8 秒（级联控件点开时要向服务器拉选项）。
 * 帆软那页 15 个 widget 全探一遍要 42 秒，任务直接超时。所以探测必须有边界。
 */
describe('probeWidgets', () => {
  const target = (label) => ({ field: { signature: `sig-${label}`, label }, container: {} });

  it('逐个探测并带上标签和选项', async () => {
    const driver = { probeOptions: vi.fn(async () => ['甲', '乙']) };
    const result = await probeWidgets([target('学历'), target('学位')], { driver });

    expect(result.probed).toMatchObject([
      { signature: 'sig-学历', label: '学历', options: ['甲', '乙'] },
      { signature: 'sig-学位', label: '学位', options: ['甲', '乙'] },
    ]);
    expect(result.partial).toBe(false);
  });

  it('每个控件完成后上报可恢复进度', async () => {
    const onProgress = vi.fn();
    const driver = { probeOptions: vi.fn(async () => ['甲']) };
    await probeWidgets([target('学历'), target('学位')], { driver, onProgress });

    expect(onProgress).toHaveBeenCalledWith(expect.objectContaining({ stage: 'probing', completed: 1, total: 2, label: '学历' }));
    expect(onProgress).toHaveBeenCalledWith(expect.objectContaining({ stage: 'probing', completed: 2, total: 2, label: '学位' }));
  });

  it('只探测指定的签名——服务端通常只需要几个字段的选项', async () => {
    const driver = { probeOptions: vi.fn(async () => ['甲']) };
    const result = await probeWidgets([target('学历'), target('学位')], { driver, signatures: ['sig-学位'] });

    expect(driver.probeOptions).toHaveBeenCalledTimes(1);
    expect(result.probed.map((p) => p.label)).toEqual(['学位']);
  });

  it('超出时间预算就停下并标记 partial，不把整个任务拖到超时', async () => {
    let clock = 0;
    const driver = { probeOptions: vi.fn(async () => { clock += 3000; return ['甲']; }) };
    const result = await probeWidgets([target('a'), target('b'), target('c')], {
      driver, budgetMs: 5000, now: () => clock,
    });

    expect(result.probed).toHaveLength(2); // 第三个开始前预算已用尽
    expect(result.partial).toBe(true);
  });

  it('某个控件探测抛错时记下来继续，不中断整批', async () => {
    const driver = {
      probeOptions: vi.fn()
        .mockRejectedValueOnce(new Error('面板炸了'))
        .mockResolvedValueOnce(['甲']),
    };
    const result = await probeWidgets([target('a'), target('b')], { driver });

    expect(result.probed[0]).toMatchObject({ label: 'a', options: [], error: expect.any(String) });
    expect(result.probed[1]).toMatchObject({ label: 'b', options: ['甲'] });
    expect(result.partial).toBe(false);
  });

  it('没有目标时返回空结果，不启动驱动器', async () => {
    const driver = { probeOptions: vi.fn() };
    expect(await probeWidgets([], { driver })).toEqual({ probed: [], partial: false });
    expect(driver.probeOptions).not.toHaveBeenCalled();
  });
});

/**
 * 真机踩到：帆软的「本科学校」下拉是全国高校列表，探回来 2604 个选项，两个学校
 * 字段合起来 5208 个——塞进 LLM prompt 直接把请求撑爆（fetch failed）。
 *
 * 这类字段本质是「可搜索」而不是「可枚举」，选项列表对模型没有意义。
 */
describe('probeWidgets：超长选项要截断并标记', () => {
  const target = (label) => ({ field: { signature: `sig-${label}`, label }, container: {} });

  it('选项超过上限时截断，并标记 truncated', async () => {
    const many = Array.from({ length: 500 }, (_, i) => `选项${i}`);
    const driver = { probeOptions: vi.fn(async () => many) };
    const { probed } = await probeWidgets([target('本科学校')], { driver, maxOptions: 60 });

    expect(probed[0].options).toHaveLength(60);
    expect(probed[0].truncated).toBe(true);
    expect(probed[0].optionCount).toBe(500);
  });

  it('选项不超上限时不标记', async () => {
    const driver = { probeOptions: vi.fn(async () => ['本科', '研究生']) };
    const { probed } = await probeWidgets([target('学历')], { driver, maxOptions: 60 });

    expect(probed[0].options).toEqual(['本科', '研究生']);
    expect(probed[0].truncated).toBe(false);
  });
});

/**
 * 真机根因：简道云级联控件的选项是**完全没有 class 的 <span>**——
 *   SPAN. → "产品类" / "研发类" / "职能类" ...
 * 而原先靠 class 含 option|item|cell 来认选项，一个都匹配不上，求差永远是空。
 * 于是「意向岗位大类」这类必填字段一直填不上。
 *
 * 面板容器倒是有类名（x-popup / x-combo-dropdown，两种控件都一样），所以改成
 * 先找新出现的面板，再取面板里有文字的叶子节点。
 */
describe('选项识别不依赖选项自身的 class', () => {
  const bare = (opts) =>
    `<div class="x-popup x-combo-dropdown">` + opts.map((o) => `<span>${o}</span>`).join('') + `</div>`;

  function driverWithPanel(panelHtml, { onOptionClick } = {}) {
    const click = vi.fn(async (el) => {
      if (el.closest('.x-combo')) { document.body.insertAdjacentHTML('beforeend', panelHtml); return; }
      if (onOptionClick) return onOptionClick(el);
      document.querySelector('.value-wrapper').textContent = el.textContent;
      document.querySelector('.x-popup')?.remove();
    });
    return createWidgetDriver({
      click, wait: async () => {},
      elementAtCenter: (el) => el.querySelector('.x-combo-dropdown-label') || el,
      isVisible: (el) => document.body.contains(el),
    });
  }

  it('无 class 的 span 选项也能读出来', async () => {
    document.body.innerHTML = COMBO;
    const driver = driverWithPanel(bare(['产品类', '研发类', '职能类']));
    expect(await driver.probeOptions(container())).toEqual(['产品类', '研发类', '职能类']);
  });

  it('面板里的搜索框不算选项', async () => {
    document.body.innerHTML = COMBO;
    const panel = '<div class="x-popup x-combo-dropdown">' +
      '<div class="x-search-input"><input type="text" placeholder="搜索"></div>' +
      '<span>产品类</span><span>研发类</span></div>';
    const driver = driverWithPanel(panel);
    expect(await driver.probeOptions(container())).toEqual(['产品类', '研发类']);
  });

  it('能选中无 class 的选项并回读确认', async () => {
    document.body.innerHTML = COMBO;
    const driver = driverWithPanel(bare(['产品类', '研发类']));
    const result = await driver.selectOption(container(), '研发类');
    expect(result).toMatchObject({ ok: true, value: '研发类' });
    expect(document.querySelector('.value-wrapper').textContent).toBe('研发类');
  });

  it('页面上本来就有的面板不算新面板', async () => {
    document.body.innerHTML = '<div class="x-popup"><span>早就在的</span></div>' + COMBO;
    const driver = driverWithPanel(bare(['产品类']));
    expect(await driver.probeOptions(container())).toEqual(['产品类']);
  });
});

/**
 * 真机踩到：面板里逐个节点调 isVisible（读 getBoundingClientRect）等于强制布局。
 * 帆软的学校下拉有 2604 个选项，两个这样的字段就让 probe 任务 180 秒回不来。
 *
 * 而这个检查本来就是冗余的——面板自身已经确认可见，里面的选项不必逐个再验。
 */
describe('面板内不逐个做可见性检查，并且有扫描上限', () => {
  it('选项很多时截断到上限，不把整棵子树走完', async () => {
    document.body.innerHTML = COMBO;
    const many = Array.from({ length: 3000 }, (_, i) => `<span>选项${i}</span>`).join('');
    let visibleCalls = 0;
    const driver = createWidgetDriver({
      click: async (el) => {
        if (el.closest('.x-combo')) document.body.insertAdjacentHTML('beforeend', `<div class="x-popup">${many}</div>`);
      },
      wait: async () => {},
      elementAtCenter: (el) => el.querySelector('.x-combo-dropdown-label') || el,
      isVisible: (el) => { visibleCalls += 1; return document.body.contains(el); },
    });

    const options = await driver.probeOptions(container());
    expect(options.length).toBeLessThanOrEqual(300);
    expect(options[0]).toBe('选项0');
    // 只对面板容器做可见性检查，不对 3000 个选项逐个做
    expect(visibleCalls).toBeLessThan(100);
  });
});

/**
 * 真机：帆软那页 15 个控件探测超过 220 秒。瓶颈是两个学校下拉——2604 个选项光
 * 渲染就要几秒。现在只有总预算、没有单字段上限，一个慢控件就能吃掉全部时间，
 * 后面十几个字段一个都探不到。
 */
describe('单字段探测超时', () => {
  const target = (label) => ({ field: { signature: `sig-${label}`, label }, container: {} });

  it('单个控件超时后跳过它，继续探后面的', async () => {
    const driver = {
      probeOptions: vi.fn()
        .mockImplementationOnce(() => new Promise((r) => setTimeout(() => r(['慢']), 10000)))
        .mockResolvedValueOnce(['甲', '乙']),
    };
    const result = await probeWidgets([target('慢控件'), target('学历')], { driver, perFieldMs: 50 });

    expect(result.probed[0]).toMatchObject({ label: '慢控件', options: [], timedOut: true });
    expect(result.probed[1]).toMatchObject({ label: '学历', options: ['甲', '乙'] });
  });

  it('没超时的不打 timedOut 标记', async () => {
    const driver = { probeOptions: vi.fn(async () => ['甲']) };
    const { probed } = await probeWidgets([target('学历')], { driver, perFieldMs: 5000 });
    expect(probed[0].timedOut).toBe(false);
  });
});

/**
 * 面板里带搜索框时，直接搜比枚举好得多。
 *
 * 帆软的「本科学校」是全国高校下拉，2604 个选项——枚举既慢（光渲染就几秒）、
 * 又塞不进 prompt。而面板的 class 里明明写着 has-search：打字过滤再点，一步到位。
 */
describe('带搜索框的面板：搜而不是枚举', () => {
  const panelWithSearch = (opts) =>
    '<div class="x-popup x-combo-dropdown has-search">' +
    '<div class="x-search-input"><input type="text" class="search"></div>' +
    opts.map((o) => `<span>${o}</span>`).join('') + '</div>';

  function driverWith({ all, onType }) {
    const typed = [];
    const click = vi.fn(async (el) => {
      if (el.closest('.x-combo')) { document.body.insertAdjacentHTML('beforeend', panelWithSearch(all.slice(0, 3))); return; }
      if (el.tagName === 'SPAN') {
        document.querySelector('.value-wrapper').textContent = el.textContent;
        document.querySelector('.x-popup')?.remove();
      }
    });
    const type = vi.fn(async (el, text) => {
      typed.push(text);
      const hits = onType ? onType(text) : all.filter((o) => o.includes(text));
      document.querySelector('.x-popup').innerHTML =
        '<div class="x-search-input"><input type="text" class="search"></div>' +
        hits.map((o) => `<span>${o}</span>`).join('');
    });
    const driver = createWidgetDriver({
      click, type, wait: async () => {},
      elementAtCenter: (el) => el.querySelector('.x-combo-dropdown-label') || el,
      isVisible: (el) => document.body.contains(el),
    });
    return { driver, typed, type };
  }

  it('面板有搜索框时先打字过滤，再点命中的那个', async () => {
    document.body.innerHTML = COMBO;
    const { driver, typed } = driverWith({ all: ['北京大学', '清华大学', '复旦大学', '浙江大学'] });
    const result = await driver.selectOption(container(), '浙江大学');

    expect(typed).toContain('浙江大学');
    expect(result).toMatchObject({ ok: true, value: '浙江大学' });
    expect(document.querySelector('.value-wrapper').textContent).toBe('浙江大学');
  });

  it('搜不到时如实报告，并带上搜索后的候选', async () => {
    document.body.innerHTML = COMBO;
    const { driver } = driverWith({ all: ['北京大学', '清华大学', '复旦大学'], onType: () => [] });
    const result = await driver.selectOption(container(), '不存在大学');
    expect(result).toMatchObject({ ok: false, reason: 'option_not_found' });
  });

  it('没有搜索框的面板走原来的枚举路径', async () => {
    document.body.innerHTML = COMBO;
    const { driver } = driverFor();
    const result = await driver.selectOption(container(), '研究生');
    expect(result).toMatchObject({ ok: true, value: '研究生' });
  });
});

/**
 * 合成事件优先、CDP 兜底。
 *
 * Claude in Chrome 全程走 chrome.debugger + Input.dispatchMouseEvent，事件
 * isTrusted、任何页面拦不住，代价是 Chrome 强制显示「已开始调试此浏览器」的
 * 横幅。我们的合成事件在简道云上验证过可用，所以只把 CDP 当兜底——面板没被
 * 合成点击打开时才用，横幅只在那几秒出现。
 */
describe('CDP 兜底', () => {
  it('合成点击没打开面板时，调用兜底再点一次', async () => {
    document.body.innerHTML = COMBO;
    let syntheticTried = false;
    const cdpFallback = vi.fn(async () => {
      document.body.insertAdjacentHTML('beforeend', '<div class="x-popup"><span>本科</span></div>');
    });
    const driver = createWidgetDriver({
      click: async () => { syntheticTried = true; return { cdpFallback }; },
      wait: async () => {},
      elementAtCenter: (el) => el.querySelector('.x-combo-dropdown-label') || el,
      isVisible: (el) => document.body.contains(el),
    });

    expect(await driver.probeOptions(container())).toEqual(['本科']);
    expect(syntheticTried).toBe(true);
    expect(cdpFallback).toHaveBeenCalled();
  });

  it('合成点击成功时不碰兜底——不该无谓地挂调试横幅', async () => {
    document.body.innerHTML = COMBO;
    const cdpFallback = vi.fn();
    const driver = createWidgetDriver({
      click: async (el) => {
        if (el.closest('.x-combo')) document.body.insertAdjacentHTML('beforeend', '<div class="x-popup"><span>本科</span></div>');
        return { cdpFallback };
      },
      wait: async () => {},
      elementAtCenter: (el) => el.querySelector('.x-combo-dropdown-label') || el,
      isVisible: (el) => document.body.contains(el),
    });

    await driver.probeOptions(container());
    expect(cdpFallback).not.toHaveBeenCalled();
  });

  it('没有提供兜底时行为不变', async () => {
    document.body.innerHTML = COMBO;
    const driver = createWidgetDriver({
      click: async () => {},
      wait: async () => {},
      elementAtCenter: (el) => el,
      isVisible: () => true,
    });
    expect(await driver.probeOptions(container())).toEqual([]);
  });
});


/**
 * 空状态重读。
 *
 * 真机：填完「意向岗位大类 = 产品类」后再探「意向岗位」，拿回来的是 1 个选项
 * 「没有可选择的数据」。两种可能分不清——选项是异步拉的、我们只等 350ms 读太早，
 * 还是父级的值只是显示上去了、页面内部没更新。
 *
 * 与其继续推理，不如让探测自己分辨：看起来像空状态就多等一会儿重读，并把面板
 * 原文带回来。重读之后有了 → 是异步；还是空 → 是父级没生效。
 */
describe('疑似空状态时重读一次', () => {
  const emptyThenLoaded = () => {
    let calls = 0;
    return {
      probeOptions: async () => {
        calls += 1;
        return calls === 1 ? ['没有可选择的数据'] : ['产品经理', '数据产品经理'];
      },
      selectOption: async () => ({ ok: true }),
      probeCalls: () => calls,
    };
  };

  it('空状态会重读，拿到真正的选项', async () => {
    const driver = emptyThenLoaded();
    const { probed } = await probeWidgets(
      [{ field: { signature: 's1', label: '意向岗位' }, container: {} }],
      { driver, emptyRetryMs: 1 }
    );
    expect(probed[0].options).toEqual(['产品经理', '数据产品经理']);
    expect(driver.probeCalls()).toBe(2);
  });

  it('重读之后还是空，如实报空并标记出来——那说明不是异步的问题', async () => {
    const driver = {
      probeOptions: async () => ['没有可选择的数据'],
      selectOption: async () => ({ ok: true }),
    };
    const { probed } = await probeWidgets(
      [{ field: { signature: 's1', label: '意向岗位' }, container: {} }],
      { driver, emptyRetryMs: 1 }
    );
    expect(probed[0].options).toEqual([]);
    expect(probed[0].emptyState).toBe('没有可选择的数据');
  });

  it('正常选项不触发重读，不白等', async () => {
    let calls = 0;
    const driver = { probeOptions: async () => { calls += 1; return ['是', '否']; }, selectOption: async () => ({ ok: true }) };
    const { probed } = await probeWidgets(
      [{ field: { signature: 's1', label: '性别' }, container: {} }],
      { driver, emptyRetryMs: 1 }
    );
    expect(probed[0].options).toEqual(['是', '否']);
    expect(calls).toBe(1);
  });
});
