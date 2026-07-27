# PawPals 浏览器插件基础层 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 建成 PawPals 浏览器插件的骨架、感知层与执行层，做到能在真实网页上「抽取可交互元素 → 手动指定编号 → 执行动作」的可演示闭环。

**Architecture:** 插件代码位于现有仓库的新目录 `extension/`，Manifest V3。感知层把 DOM 抽成带编号的可交互元素列表；执行层定义为适配器接口，提供合成事件与 `chrome.debugger` 两套实现；拟人化操作节奏抽成纯函数以便确定性测试。本计划**不含** LLM 决策循环与护栏 policy，因此执行动作只能由人在调试面板手动触发，不存在自主操作账号的风险。

**Tech Stack:** Manifest V3、原生 ES 模块（插件侧不引入构建步骤）、Vitest + jsdom（单元测试）

## Global Constraints

- 插件代码全部位于现有仓库的 `extension/` 目录，不另建仓库
- **不修改 `server.ts`（5458 行）与 `src/App.tsx`（5010 行）**，这两个文件已过大
- 插件所有服务端请求指向 `http://localhost:3010`
- Manifest V3
- 感知采用 DOM 索引方案，不使用截图定位
- 执行层必须是可替换适配器，`synthetic` 与 `debugger` 两套实现共用同一接口
- 所有含随机性的函数必须接受可注入的 `rng` 参数（默认 `Math.random`），以便测试确定性
- 插件侧代码使用原生 ES 模块语法，不引入打包器
- Node 版本：本机为 v25.7.0，npm 11.10.1

---

### Task 1: 测试基建

项目当前没有任何单元测试框架（`package.json` 里只有 `lint`、`eval` 等脚本）。后续每个任务都依赖它，所以先建。

**Files:**
- Create: `vitest.config.ts`
- Modify: `package.json`（新增 devDependencies 与 `test` 脚本）
- Test: `extension/smoke.test.js`

**Interfaces:**
- Consumes: 无
- Produces: `npm test` 可运行；测试环境为 jsdom；测试文件匹配 `extension/**/*.test.js` 与 `server/**/*.test.ts`

- [ ] **Step 1: 安装依赖**

```bash
cd "/Users/dengyudie/Downloads/萌爪伴学-(pawpals)"
npm install -D vitest@^3 jsdom@^26
```

- [ ] **Step 2: 写 vitest 配置**

新建 `vitest.config.ts`。注意**不要**改动现有的 `vite.config.ts`——它带着前端专用的 `define` 与 proxy 配置，Vitest 用独立配置文件避免互相干扰。

```typescript
import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    environment: 'jsdom',
    include: ['extension/**/*.test.js', 'server/**/*.test.ts'],
    globals: false,
  },
});
```

- [ ] **Step 3: 加 test 脚本**

在 `package.json` 的 `scripts` 中加入（放在 `"lint"` 之后）：

```json
"test": "vitest run",
"test:watch": "vitest",
```

- [ ] **Step 4: 写冒烟测试**

新建 `extension/smoke.test.js`：

```javascript
import { describe, it, expect } from 'vitest';

describe('测试基建', () => {
  it('jsdom 环境可用', () => {
    document.body.innerHTML = '<button id="b">点我</button>';
    expect(document.getElementById('b').textContent).toBe('点我');
  });
});
```

- [ ] **Step 5: 运行测试**

Run: `npm test`
Expected: PASS，1 passed

- [ ] **Step 6: 提交**

```bash
git add vitest.config.ts package.json package-lock.json extension/smoke.test.js
git commit -m "test: 引入 vitest + jsdom 测试基建"
```

---

### Task 2: 拟人化节奏纯函数

`electron/platforms/human-behavior.mjs` 里的逻辑分两部分：贝塞尔曲线与打字节奏的**计算**（可移植），以及 `page.mouse` / `page.keyboard` 的**调用**（Playwright 专用，不可移植）。这个任务只移植计算部分，且做成纯函数——输入参数出计划，不碰 DOM，因此可以完全确定性地测试。

**Files:**
- Create: `extension/act/human.js`
- Test: `extension/act/human.test.js`

**Interfaces:**
- Consumes: 无
- Produces:
  - `bezierPath(fromX, fromY, toX, toY, opts) -> Array<{x: number, y: number}>`
  - `movePlan(fromX, fromY, toX, toY, opts) -> Array<{x: number, y: number, delayMs: number}>`
  - `clickPoint(box, opts) -> {x: number, y: number}`，`box` 形如 `{x, y, width, height}`
  - `typingPlan(text, opts) -> Array<{char: string, delayMs: number}>`
  - 所有 `opts` 均接受 `{rng?: () => number, steps?: number}`

- [ ] **Step 1: 写失败的测试**

新建 `extension/act/human.test.js`：

```javascript
import { describe, it, expect } from 'vitest';
import { bezierPath, movePlan, clickPoint, typingPlan } from './human.js';

// 固定 rng：始终返回 0.5，让所有随机量落在区间中点，结果完全可预测
const half = () => 0.5;

describe('bezierPath', () => {
  it('按给定步数生成路径点', () => {
    const path = bezierPath(0, 0, 100, 0, { rng: half, steps: 10 });
    expect(path).toHaveLength(10);
  });

  it('终点精确落在目标坐标上', () => {
    const path = bezierPath(0, 0, 100, 50, { rng: half, steps: 10 });
    const last = path[path.length - 1];
    expect(last.x).toBeCloseTo(100);
    expect(last.y).toBeCloseTo(50);
  });

  it('路径不是直线（中间点偏离首尾连线）', () => {
    // rng 恒为 0.5 时垂直偏移为 0，所以用一个偏移量非零的 rng
    const path = bezierPath(0, 0, 100, 0, { rng: () => 0.9, steps: 11 });
    const mid = path[4];
    expect(Math.abs(mid.y)).toBeGreaterThan(0);
  });
});

describe('movePlan', () => {
  it('每个点都带 delayMs，且落在 10-30ms 区间内', () => {
    const plan = movePlan(0, 0, 100, 100, { rng: half, steps: 5 });
    expect(plan).toHaveLength(5);
    for (const step of plan) {
      expect(step.delayMs).toBeGreaterThanOrEqual(10);
      expect(step.delayMs).toBeLessThanOrEqual(30);
    }
  });
});

describe('clickPoint', () => {
  it('落点在元素内部，但不在正中心', () => {
    const box = { x: 0, y: 0, width: 100, height: 40 };
    const point = clickPoint(box, { rng: () => 0.9 });
    expect(point.x).toBeGreaterThan(0);
    expect(point.x).toBeLessThan(100);
    expect(point.x).not.toBe(50);
  });

  it('rng 恒为 0.5 时落在元素中心', () => {
    const box = { x: 0, y: 0, width: 100, height: 40 };
    const point = clickPoint(box, { rng: half });
    expect(point.x).toBeCloseTo(50);
    expect(point.y).toBeCloseTo(20);
  });
});

describe('typingPlan', () => {
  it('每个字符一个条目，顺序与原文一致', () => {
    const plan = typingPlan('你好ab', { rng: half });
    expect(plan.map((s) => s.char).join('')).toBe('你好ab');
  });

  it('每个字符的停顿落在 60-180ms 区间内（无思考停顿时）', () => {
    const plan = typingPlan('abc', { rng: half });
    for (const step of plan) {
      expect(step.delayMs).toBeGreaterThanOrEqual(60);
      expect(step.delayMs).toBeLessThanOrEqual(180);
    }
  });

  it('rng 极小时插入思考停顿，总时长明显变长', () => {
    const normal = typingPlan('abcdefghij', { rng: half });
    const thinking = typingPlan('abcdefghij', { rng: () => 0.01 });
    const sum = (p) => p.reduce((acc, s) => acc + s.delayMs, 0);
    expect(sum(thinking)).toBeGreaterThan(sum(normal));
  });
});
```

- [ ] **Step 2: 运行测试确认失败**

Run: `npx vitest run extension/act/human.test.js`
Expected: FAIL，报错 `Failed to resolve import "./human.js"`

- [ ] **Step 3: 实现**

新建 `extension/act/human.js`：

```javascript
/**
 * 拟人化操作节奏 —— 纯计算，不碰 DOM
 *
 * 自 electron/platforms/human-behavior.mjs 移植。原实现把「算轨迹」和
 * 「调 page.mouse」混在一起，只能在 Playwright 里跑。这里只保留计算部分，
 * 输出一份「计划」交给执行层去落地，因此两套执行实现可以共用同一份节奏逻辑，
 * 也可以确定性地单测。
 */

const DEFAULT_RNG = Math.random;

/** 在 [min, max) 区间内取一个随机数 */
function between(rng, min, max) {
  return min + rng() * (max - min);
}

/**
 * 贝塞尔曲线路径：from → to 之间用一个随机控制点画弧。
 * 真人移动鼠标不走直线，总有轻微弯曲。
 */
export function bezierPath(fromX, fromY, toX, toY, opts = {}) {
  const rng = opts.rng ?? DEFAULT_RNG;
  const steps = opts.steps ?? Math.floor(between(rng, 25, 45));

  const dx = toX - fromX;
  const dy = toY - fromY;
  const dist = Math.hypot(dx, dy);
  const len = dist || 1;

  // 控制点取在首尾中点附近，沿垂直方向偏移
  const perpScale = (rng() - 0.5) * dist * 0.6;
  const cpX = (fromX + toX) / 2 + (-dy / len) * perpScale;
  const cpY = (fromY + toY) / 2 + (dx / len) * perpScale;

  const path = [];
  for (let i = 1; i <= steps; i += 1) {
    const t = i / steps;
    path.push({
      x: (1 - t) ** 2 * fromX + 2 * (1 - t) * t * cpX + t ** 2 * toX,
      y: (1 - t) ** 2 * fromY + 2 * (1 - t) * t * cpY + t ** 2 * toY,
    });
  }
  return path;
}

/** 在贝塞尔路径基础上给每一步配一个 10-30ms 的停顿 */
export function movePlan(fromX, fromY, toX, toY, opts = {}) {
  const rng = opts.rng ?? DEFAULT_RNG;
  return bezierPath(fromX, fromY, toX, toY, opts).map((point) => ({
    ...point,
    delayMs: Math.round(between(rng, 10, 30)),
  }));
}

/**
 * 点击落点：偏离正中心 30%-70%。
 * 真人不会精确点在像素正中，恒定居中反而是机器特征。
 */
export function clickPoint(box, opts = {}) {
  const rng = opts.rng ?? DEFAULT_RNG;
  return {
    x: box.x + box.width * between(rng, 0.3, 0.7),
    y: box.y + box.height * between(rng, 0.3, 0.7),
  };
}

/**
 * 打字节奏：每字符 60-180ms；约 8% 概率插入 200-500ms 的「思考停顿」。
 */
export function typingPlan(text, opts = {}) {
  const rng = opts.rng ?? DEFAULT_RNG;
  return Array.from(text).map((char) => {
    let delayMs = between(rng, 60, 180);
    if (rng() < 0.08) delayMs += between(rng, 200, 500);
    return { char, delayMs: Math.round(delayMs) };
  });
}
```

- [ ] **Step 4: 运行测试确认通过**

Run: `npx vitest run extension/act/human.test.js`
Expected: PASS，9 passed

- [ ] **Step 5: 提交**

```bash
git add extension/act/human.js extension/act/human.test.js
git commit -m "feat(extension): 拟人化操作节奏纯函数"
```

---

### Task 3: 感知层 —— 可见性判定

判断一个元素是否真的能被用户看到并点到。这是元素抽取的前置条件：页面上有大量隐藏的、尺寸为零的、被遮挡的可交互元素，全喂给 LLM 会让列表噪声极大。

**Files:**
- Create: `extension/perceive/visibility.js`
- Test: `extension/perceive/visibility.test.js`

**Interfaces:**
- Consumes: 无
- Produces:
  - `isVisible(el, win = window) -> boolean`
  - `isInViewport(el, win = window) -> boolean`

- [ ] **Step 1: 写失败的测试**

新建 `extension/perceive/visibility.test.js`。

注意：jsdom 的 `getBoundingClientRect()` 恒返回全 0，所以测试里必须显式打桩，否则任何元素都会被判为不可见。

```javascript
import { describe, it, expect, beforeEach } from 'vitest';
import { isVisible, isInViewport } from './visibility.js';

/** jsdom 不做布局，手动给元素打上尺寸 */
function stubRect(el, rect) {
  el.getBoundingClientRect = () => ({
    x: rect.x ?? 0,
    y: rect.y ?? 0,
    width: rect.width ?? 0,
    height: rect.height ?? 0,
    top: rect.y ?? 0,
    left: rect.x ?? 0,
    right: (rect.x ?? 0) + (rect.width ?? 0),
    bottom: (rect.y ?? 0) + (rect.height ?? 0),
  });
  return el;
}

beforeEach(() => {
  document.body.innerHTML = '';
});

describe('isVisible', () => {
  it('有尺寸的普通元素判为可见', () => {
    const el = document.createElement('button');
    document.body.appendChild(el);
    stubRect(el, { width: 100, height: 30 });
    expect(isVisible(el)).toBe(true);
  });

  it('尺寸为零判为不可见', () => {
    const el = document.createElement('button');
    document.body.appendChild(el);
    stubRect(el, { width: 0, height: 0 });
    expect(isVisible(el)).toBe(false);
  });

  it('display:none 判为不可见', () => {
    const el = document.createElement('button');
    el.style.display = 'none';
    document.body.appendChild(el);
    stubRect(el, { width: 100, height: 30 });
    expect(isVisible(el)).toBe(false);
  });

  it('visibility:hidden 判为不可见', () => {
    const el = document.createElement('button');
    el.style.visibility = 'hidden';
    document.body.appendChild(el);
    stubRect(el, { width: 100, height: 30 });
    expect(isVisible(el)).toBe(false);
  });

  it('opacity:0 判为不可见', () => {
    const el = document.createElement('button');
    el.style.opacity = '0';
    document.body.appendChild(el);
    stubRect(el, { width: 100, height: 30 });
    expect(isVisible(el)).toBe(false);
  });

  it('null 或非元素节点判为不可见', () => {
    expect(isVisible(null)).toBe(false);
    expect(isVisible(document.createTextNode('x'))).toBe(false);
  });
});

describe('isInViewport', () => {
  it('位于视口内判为 true', () => {
    const el = document.createElement('button');
    document.body.appendChild(el);
    stubRect(el, { x: 10, y: 10, width: 100, height: 30 });
    expect(isInViewport(el)).toBe(true);
  });

  it('完全滚出视口上方判为 false', () => {
    const el = document.createElement('button');
    document.body.appendChild(el);
    stubRect(el, { x: 10, y: -200, width: 100, height: 30 });
    expect(isInViewport(el)).toBe(false);
  });
});
```

- [ ] **Step 2: 运行测试确认失败**

Run: `npx vitest run extension/perceive/visibility.test.js`
Expected: FAIL，报错 `Failed to resolve import "./visibility.js"`

- [ ] **Step 3: 实现**

新建 `extension/perceive/visibility.js`：

```javascript
/**
 * 可见性判定 —— 决定一个元素要不要进入喂给 LLM 的元素列表
 *
 * 页面上隐藏的、零尺寸的可交互元素非常多（折叠菜单、预渲染弹窗、
 * 埋点用的空 a 标签）。全部收进来会让列表噪声大到 LLM 选不准。
 */

/** 元素是否真的显示出来了 */
export function isVisible(el, win = globalThis.window) {
  if (!el || el.nodeType !== 1) return false;

  const rect = el.getBoundingClientRect();
  if (rect.width <= 0 || rect.height <= 0) return false;

  const style = win.getComputedStyle(el);
  if (style.display === 'none') return false;
  if (style.visibility === 'hidden' || style.visibility === 'collapse') return false;
  if (Number(style.opacity) === 0) return false;

  return true;
}

/** 元素是否落在当前视口内（哪怕只有一部分） */
export function isInViewport(el, win = globalThis.window) {
  if (!el || el.nodeType !== 1) return false;

  const rect = el.getBoundingClientRect();
  const viewportHeight = win.innerHeight || 0;
  const viewportWidth = win.innerWidth || 0;

  return (
    rect.bottom > 0 &&
    rect.right > 0 &&
    rect.top < viewportHeight &&
    rect.left < viewportWidth
  );
}
```

- [ ] **Step 4: 运行测试确认通过**

Run: `npx vitest run extension/perceive/visibility.test.js`
Expected: PASS，8 passed

- [ ] **Step 5: 提交**

```bash
git add extension/perceive/visibility.js extension/perceive/visibility.test.js
git commit -m "feat(extension): 感知层可见性判定"
```

---

### Task 4: 感知层 —— 元素抽取与指纹

把页面抽成带编号的可交互元素列表，并给每个元素记一个指纹。指纹用于在「感知」与「执行」之间校验元素没有变化——设计文档里明确指出，缺少这一步会导致点击错误的元素，是最危险的失败模式。

**Files:**
- Create: `extension/perceive/fingerprint.js`
- Create: `extension/perceive/collect.js`
- Test: `extension/perceive/fingerprint.test.js`
- Test: `extension/perceive/collect.test.js`

**Interfaces:**
- Consumes: `isVisible`、`isInViewport`（Task 3）
- Produces:
  - `fingerprint(el) -> {tag: string, text: string, x: number, y: number}`
  - `fingerprintMatches(a, b, tolerancePx = 8) -> boolean`
  - `elementLabel(el) -> string`
  - `collectInteractive(root = document, opts) -> Array<{index: number, tag: string, label: string, type: string, fingerprint: object, el: Element}>`
  - `renderForPrompt(elements) -> string`

- [ ] **Step 1: 写指纹的失败测试**

新建 `extension/perceive/fingerprint.test.js`：

```javascript
import { describe, it, expect, beforeEach } from 'vitest';
import { fingerprint, fingerprintMatches, elementLabel } from './fingerprint.js';

function stubRect(el, rect) {
  el.getBoundingClientRect = () => ({
    x: rect.x ?? 0, y: rect.y ?? 0,
    width: rect.width ?? 0, height: rect.height ?? 0,
    top: rect.y ?? 0, left: rect.x ?? 0,
    right: (rect.x ?? 0) + (rect.width ?? 0),
    bottom: (rect.y ?? 0) + (rect.height ?? 0),
  });
  return el;
}

beforeEach(() => { document.body.innerHTML = ''; });

describe('elementLabel', () => {
  it('优先取可见文案', () => {
    document.body.innerHTML = '<button>立即沟通</button>';
    expect(elementLabel(document.querySelector('button'))).toBe('立即沟通');
  });

  it('无文案时退回 aria-label', () => {
    document.body.innerHTML = '<button aria-label="关闭"></button>';
    expect(elementLabel(document.querySelector('button'))).toBe('关闭');
  });

  it('输入框退回 placeholder', () => {
    document.body.innerHTML = '<input placeholder="搜索职位" />';
    expect(elementLabel(document.querySelector('input'))).toBe('搜索职位');
  });

  it('压缩空白', () => {
    document.body.innerHTML = '<button>  立即   沟通\n </button>';
    expect(elementLabel(document.querySelector('button'))).toBe('立即 沟通');
  });
});

describe('fingerprint', () => {
  it('记录标签、文案与位置', () => {
    document.body.innerHTML = '<button>立即沟通</button>';
    const el = stubRect(document.querySelector('button'), { x: 12.4, y: 30.6, width: 80, height: 32 });
    expect(fingerprint(el)).toEqual({ tag: 'button', text: '立即沟通', x: 12, y: 31 });
  });
});

describe('fingerprintMatches', () => {
  const base = { tag: 'button', text: '立即沟通', x: 100, y: 200 };

  it('完全一致时匹配', () => {
    expect(fingerprintMatches(base, { ...base })).toBe(true);
  });

  it('位置微移在容差内仍匹配', () => {
    expect(fingerprintMatches(base, { ...base, x: 105, y: 203 })).toBe(true);
  });

  it('位置移动超出容差不匹配', () => {
    expect(fingerprintMatches(base, { ...base, x: 140 })).toBe(false);
  });

  it('文案变化不匹配', () => {
    expect(fingerprintMatches(base, { ...base, text: '继续沟通' })).toBe(false);
  });

  it('标签变化不匹配', () => {
    expect(fingerprintMatches(base, { ...base, tag: 'a' })).toBe(false);
  });
});
```

- [ ] **Step 2: 运行测试确认失败**

Run: `npx vitest run extension/perceive/fingerprint.test.js`
Expected: FAIL，报错 `Failed to resolve import "./fingerprint.js"`

- [ ] **Step 3: 实现指纹**

新建 `extension/perceive/fingerprint.js`：

```javascript
/**
 * 元素指纹 —— 用于校验「感知」到「执行」之间元素没有被换掉
 *
 * 页面随时可能在两次操作之间重排（异步加载、弹窗、列表刷新）。
 * 只凭编号去点，编号对应的元素可能已经变成了别的东西。
 * 执行前比对指纹，不一致就重新感知，而不是硬点下去。
 */

/** 压缩连续空白，去掉首尾空格 */
function normalizeText(value) {
  return String(value || '').replace(/\s+/g, ' ').trim();
}

/** 取一个元素对人类而言的「名字」 */
export function elementLabel(el) {
  if (!el) return '';
  const candidates = [
    el.textContent,
    el.getAttribute?.('aria-label'),
    el.getAttribute?.('placeholder'),
    el.getAttribute?.('title'),
    el.getAttribute?.('value'),
    el.getAttribute?.('alt'),
  ];
  for (const candidate of candidates) {
    const text = normalizeText(candidate);
    if (text) return text;
  }
  return '';
}

/** 生成指纹：标签 + 文案 + 取整后的位置 */
export function fingerprint(el) {
  const rect = el.getBoundingClientRect();
  return {
    tag: el.tagName.toLowerCase(),
    text: elementLabel(el),
    x: Math.round(rect.x),
    y: Math.round(rect.y),
  };
}

/** 两个指纹是否指向同一个元素。位置允许小幅漂移（滚动、微动画） */
export function fingerprintMatches(a, b, tolerancePx = 8) {
  if (!a || !b) return false;
  if (a.tag !== b.tag) return false;
  if (a.text !== b.text) return false;
  if (Math.abs(a.x - b.x) > tolerancePx) return false;
  if (Math.abs(a.y - b.y) > tolerancePx) return false;
  return true;
}
```

- [ ] **Step 4: 运行测试确认通过**

Run: `npx vitest run extension/perceive/fingerprint.test.js`
Expected: PASS，10 passed

- [ ] **Step 5: 写元素抽取的失败测试**

新建 `extension/perceive/collect.test.js`：

```javascript
import { describe, it, expect, beforeEach } from 'vitest';
import { collectInteractive, renderForPrompt } from './collect.js';

/** 给页面上所有元素统一打上非零尺寸，除非 data-zero 标记 */
function layoutAll(y = 10) {
  let offset = y;
  for (const el of document.querySelectorAll('*')) {
    const zero = el.hasAttribute('data-zero');
    const rect = {
      x: 10, y: offset,
      width: zero ? 0 : 120,
      height: zero ? 0 : 32,
    };
    el.getBoundingClientRect = () => ({
      ...rect,
      top: rect.y, left: rect.x,
      right: rect.x + rect.width, bottom: rect.y + rect.height,
    });
    offset += 40;
  }
}

beforeEach(() => { document.body.innerHTML = ''; });

describe('collectInteractive', () => {
  it('收集按钮、链接、输入框', () => {
    document.body.innerHTML = `
      <button>立即沟通</button>
      <a href="/job/1">岗位详情</a>
      <input placeholder="搜索职位" />
    `;
    layoutAll();
    const items = collectInteractive(document);
    expect(items).toHaveLength(3);
    expect(items.map((i) => i.label)).toEqual(['立即沟通', '岗位详情', '搜索职位']);
  });

  it('编号从 0 开始且连续', () => {
    document.body.innerHTML = '<button>A</button><button>B</button>';
    layoutAll();
    const items = collectInteractive(document);
    expect(items.map((i) => i.index)).toEqual([0, 1]);
  });

  it('跳过不可见元素', () => {
    document.body.innerHTML = `
      <button>可见</button>
      <button data-zero>零尺寸</button>
      <button style="display:none">隐藏</button>
    `;
    layoutAll();
    const items = collectInteractive(document);
    expect(items.map((i) => i.label)).toEqual(['可见']);
  });

  it('收集 role=button 的非语义元素', () => {
    document.body.innerHTML = '<div role="button">自定义按钮</div>';
    layoutAll();
    const items = collectInteractive(document);
    expect(items).toHaveLength(1);
    expect(items[0].tag).toBe('div');
  });

  it('跳过 tabindex=-1 的元素', () => {
    document.body.innerHTML = '<div tabindex="-1">不可聚焦</div>';
    layoutAll();
    expect(collectInteractive(document)).toHaveLength(0);
  });

  it('每个条目带指纹与元素引用', () => {
    document.body.innerHTML = '<button>立即沟通</button>';
    layoutAll();
    const [item] = collectInteractive(document);
    expect(item.fingerprint.text).toBe('立即沟通');
    expect(item.el).toBe(document.querySelector('button'));
  });

  it('区分输入类型，输入框的 type 为 input', () => {
    document.body.innerHTML = '<input placeholder="搜索" /><button>提交</button>';
    layoutAll();
    const items = collectInteractive(document);
    expect(items[0].type).toBe('input');
    expect(items[1].type).toBe('button');
  });

  it('超出 maxElements 时截断', () => {
    document.body.innerHTML = Array.from({ length: 10 })
      .map((_, i) => `<button>按钮${i}</button>`).join('');
    layoutAll();
    expect(collectInteractive(document, { maxElements: 4 })).toHaveLength(4);
  });
});

describe('renderForPrompt', () => {
  it('渲染成带编号的行，供 LLM 阅读', () => {
    document.body.innerHTML = '<button>立即沟通</button><input placeholder="搜索职位" />';
    layoutAll();
    const text = renderForPrompt(collectInteractive(document));
    expect(text).toContain('[0] button "立即沟通"');
    expect(text).toContain('[1] input "搜索职位"');
  });

  it('空列表返回明确提示而不是空字符串', () => {
    expect(renderForPrompt([])).toBe('（页面上没有可交互元素）');
  });
});
```

- [ ] **Step 6: 运行测试确认失败**

Run: `npx vitest run extension/perceive/collect.test.js`
Expected: FAIL，报错 `Failed to resolve import "./collect.js"`

- [ ] **Step 7: 实现元素抽取**

新建 `extension/perceive/collect.js`：

```javascript
/**
 * 元素抽取 —— 把页面抽成带编号的可交互元素列表
 *
 * 采用 DOM 索引方案而非截图：LLM 读列表选编号，不读像素猜坐标。
 * 便宜一个数量级，且不会点偏。
 */

import { isVisible } from './visibility.js';
import { fingerprint, elementLabel } from './fingerprint.js';

const INTERACTIVE_SELECTOR = [
  'a[href]',
  'button',
  'input',
  'select',
  'textarea',
  '[role="button"]',
  '[role="link"]',
  '[role="tab"]',
  '[role="checkbox"]',
  '[onclick]',
  '[tabindex]',
].join(',');

const DEFAULT_MAX_ELEMENTS = 120;

/** 归类，让 LLM 知道这个元素能怎么操作 */
function elementType(el) {
  const tag = el.tagName.toLowerCase();
  if (tag === 'input') {
    const inputType = (el.getAttribute('type') || 'text').toLowerCase();
    return inputType === 'submit' || inputType === 'button' ? 'button' : 'input';
  }
  if (tag === 'textarea') return 'input';
  if (tag === 'select') return 'select';
  if (tag === 'a') return 'link';
  if (tag === 'button') return 'button';
  const role = el.getAttribute('role');
  if (role === 'link') return 'link';
  return 'button';
}

/**
 * 抽取当前页面的可交互元素。
 * 返回条目里的 el 是真实 DOM 引用，只在页面内使用，不跨进程传递。
 */
export function collectInteractive(root = document, opts = {}) {
  const maxElements = opts.maxElements ?? DEFAULT_MAX_ELEMENTS;
  const win = opts.win ?? globalThis.window;

  const items = [];
  for (const el of root.querySelectorAll(INTERACTIVE_SELECTOR)) {
    if (items.length >= maxElements) break;

    // tabindex="-1" 表示不参与键盘导航，通常不是给用户点的
    if (el.getAttribute('tabindex') === '-1') continue;
    if (el.hasAttribute('disabled')) continue;
    if (!isVisible(el, win)) continue;

    items.push({
      index: items.length,
      tag: el.tagName.toLowerCase(),
      type: elementType(el),
      label: elementLabel(el),
      fingerprint: fingerprint(el),
      el,
    });
  }
  return items;
}

/** 渲染成 LLM 可读的行文本 */
export function renderForPrompt(elements) {
  if (!elements || elements.length === 0) return '（页面上没有可交互元素）';
  return elements
    .map((item) => `[${item.index}] ${item.type} "${item.label}"`)
    .join('\n');
}
```

- [ ] **Step 8: 运行全部感知层测试确认通过**

Run: `npx vitest run extension/perceive`
Expected: PASS，28 passed（visibility 8 + fingerprint 10 + collect 10）

- [ ] **Step 9: 提交**

```bash
git add extension/perceive/
git commit -m "feat(extension): 感知层元素抽取与指纹校验"
```

---

### Task 5: 执行层接口与合成事件实现

定义执行层适配器接口，并写出第一套实现。合成事件实现的关键难点是 React 受控组件——直接赋 `el.value` 会被框架的 value tracker 覆盖回去，必须走原生 setter 绕过。

**Files:**
- Create: `extension/act/adapter.js`
- Create: `extension/act/synthetic.js`
- Test: `extension/act/adapter.test.js`
- Test: `extension/act/synthetic.test.js`

**Interfaces:**
- Consumes: `movePlan`、`clickPoint`、`typingPlan`（Task 2）；`fingerprint`、`fingerprintMatches`（Task 4）
- Produces:
  - `ACTIONS`：常量数组 `['click', 'type', 'scroll', 'navigate']`
  - `validateAction(action) -> {ok: true} | {ok: false, error: string}`
  - `createExecutor(impl) -> {execute(action, context) -> Promise<{ok: boolean, error?: string}>}`
  - `syntheticImpl` —— 实现 `{click(el, opts), type(el, text, opts), scroll(dy), navigate(url)}`
  - `nativeSetValue(el, value) -> void`

- [ ] **Step 1: 写接口层的失败测试**

新建 `extension/act/adapter.test.js`：

```javascript
import { describe, it, expect, vi } from 'vitest';
import { ACTIONS, validateAction, createExecutor } from './adapter.js';

describe('validateAction', () => {
  it('接受合法的 click 动作', () => {
    expect(validateAction({ action: 'click', index: 3 })).toEqual({ ok: true });
  });

  it('拒绝未知动作名', () => {
    const result = validateAction({ action: 'explode', index: 3 });
    expect(result.ok).toBe(false);
    expect(result.error).toContain('explode');
  });

  it('click 缺少 index 时拒绝', () => {
    const result = validateAction({ action: 'click' });
    expect(result.ok).toBe(false);
    expect(result.error).toContain('index');
  });

  it('type 缺少 text 时拒绝', () => {
    const result = validateAction({ action: 'type', index: 1 });
    expect(result.ok).toBe(false);
    expect(result.error).toContain('text');
  });

  it('navigate 缺少 url 时拒绝', () => {
    expect(validateAction({ action: 'navigate' }).ok).toBe(false);
  });

  it('null 输入拒绝而不是抛异常', () => {
    expect(validateAction(null).ok).toBe(false);
  });

  it('ACTIONS 导出四个动作', () => {
    expect(ACTIONS).toEqual(['click', 'type', 'scroll', 'navigate']);
  });
});

describe('createExecutor', () => {
  const elements = [
    { index: 0, el: {}, fingerprint: { tag: 'button', text: '确定', x: 10, y: 10 } },
  ];

  it('合法动作转发给实现', async () => {
    const impl = { click: vi.fn().mockResolvedValue(undefined) };
    const executor = createExecutor(impl);
    const result = await executor.execute({ action: 'click', index: 0 }, { elements });
    expect(result.ok).toBe(true);
    expect(impl.click).toHaveBeenCalledOnce();
  });

  it('非法动作不转发给实现', async () => {
    const impl = { click: vi.fn() };
    const executor = createExecutor(impl);
    const result = await executor.execute({ action: 'nope' }, { elements });
    expect(result.ok).toBe(false);
    expect(impl.click).not.toHaveBeenCalled();
  });

  it('编号越界时报错且不转发', async () => {
    const impl = { click: vi.fn() };
    const executor = createExecutor(impl);
    const result = await executor.execute({ action: 'click', index: 99 }, { elements });
    expect(result.ok).toBe(false);
    expect(result.error).toContain('99');
    expect(impl.click).not.toHaveBeenCalled();
  });

  it('指纹不一致时拒绝执行', async () => {
    const impl = { click: vi.fn() };
    const executor = createExecutor(impl);
    const stale = [{
      index: 0,
      el: {},
      fingerprint: { tag: 'button', text: '确定', x: 10, y: 10 },
      currentFingerprint: { tag: 'button', text: '取消', x: 10, y: 10 },
    }];
    const result = await executor.execute({ action: 'click', index: 0 }, { elements: stale });
    expect(result.ok).toBe(false);
    expect(result.error).toContain('指纹');
    expect(impl.click).not.toHaveBeenCalled();
  });

  it('实现抛异常时转成失败结果而不是往上抛', async () => {
    const impl = { click: vi.fn().mockRejectedValue(new Error('boom')) };
    const executor = createExecutor(impl);
    const result = await executor.execute({ action: 'click', index: 0 }, { elements });
    expect(result.ok).toBe(false);
    expect(result.error).toContain('boom');
  });
});
```

- [ ] **Step 2: 运行测试确认失败**

Run: `npx vitest run extension/act/adapter.test.js`
Expected: FAIL，报错 `Failed to resolve import "./adapter.js"`

- [ ] **Step 3: 实现接口层**

新建 `extension/act/adapter.js`：

```javascript
/**
 * 执行层适配器接口
 *
 * 两套实现共用这一层：synthetic（合成事件）与 debugger（chrome.debugger 经 CDP
 * 发真事件）。选哪套取决于目标站点是否拒绝 isTrusted=false 的事件，
 * 但接口一致，上层不感知差别。
 *
 * 这一层只做三件事：校验动作合法、校验元素没变、把异常转成结果。
 */

import { fingerprintMatches } from '../perceive/fingerprint.js';

export const ACTIONS = ['click', 'type', 'scroll', 'navigate'];

/** 校验一个动作对象结构是否合法 */
export function validateAction(action) {
  if (!action || typeof action !== 'object') {
    return { ok: false, error: '动作必须是对象' };
  }
  if (!ACTIONS.includes(action.action)) {
    return { ok: false, error: `未知动作 "${action.action}"，可用动作：${ACTIONS.join(' / ')}` };
  }
  if ((action.action === 'click' || action.action === 'type') && !Number.isInteger(action.index)) {
    return { ok: false, error: `动作 ${action.action} 缺少整数 index` };
  }
  if (action.action === 'type' && typeof action.text !== 'string') {
    return { ok: false, error: '动作 type 缺少字符串 text' };
  }
  if (action.action === 'navigate' && typeof action.url !== 'string') {
    return { ok: false, error: '动作 navigate 缺少字符串 url' };
  }
  if (action.action === 'scroll' && !Number.isFinite(action.dy)) {
    return { ok: false, error: '动作 scroll 缺少数值 dy' };
  }
  return { ok: true };
}

/**
 * 包一个具体实现，得到一个带校验的执行器。
 * context.elements 是 collectInteractive 的输出；若条目上带 currentFingerprint，
 * 说明调用方重新感知过，此处会比对，不一致即拒绝执行。
 */
export function createExecutor(impl) {
  async function execute(action, context = {}) {
    const valid = validateAction(action);
    if (!valid.ok) return { ok: false, error: valid.error };

    const elements = context.elements || [];

    let target = null;
    if (action.action === 'click' || action.action === 'type') {
      target = elements.find((item) => item.index === action.index);
      if (!target) {
        return { ok: false, error: `元素编号 ${action.index} 不存在，当前共 ${elements.length} 个元素` };
      }
      if (target.currentFingerprint &&
          !fingerprintMatches(target.fingerprint, target.currentFingerprint)) {
        return { ok: false, error: `元素 ${action.index} 指纹已变化，需要重新感知` };
      }
    }

    try {
      switch (action.action) {
        case 'click':
          await impl.click(target.el, action);
          break;
        case 'type':
          await impl.type(target.el, action.text, action);
          break;
        case 'scroll':
          await impl.scroll(action.dy);
          break;
        case 'navigate':
          await impl.navigate(action.url);
          break;
        default:
          return { ok: false, error: `未处理的动作 ${action.action}` };
      }
      return { ok: true };
    } catch (error) {
      return { ok: false, error: String(error?.message || error) };
    }
  }

  return { execute };
}
```

- [ ] **Step 4: 运行测试确认通过**

Run: `npx vitest run extension/act/adapter.test.js`
Expected: PASS，12 passed

- [ ] **Step 5: 写合成事件实现的失败测试**

新建 `extension/act/synthetic.test.js`。第三个用例模拟 React 受控组件：给 input 装一个 value tracker，朴素赋值会被它改写，只有走原生 setter 才能留住。

```javascript
import { describe, it, expect, beforeEach, vi } from 'vitest';
import { syntheticImpl, nativeSetValue } from './synthetic.js';

beforeEach(() => { document.body.innerHTML = ''; });

// 说明：jsdom 里没有真实的 React value tracker，所以「受控组件会不会吃掉输入」
// 这件事无法在此层面测出来，只能靠 Task 9 的手动验收在真实页面上验证。
// 这里能测的是 nativeSetValue 本身走的是原生 setter 而非属性赋值。

describe('nativeSetValue', () => {
  it('给普通 input 赋值', () => {
    document.body.innerHTML = '<input />';
    const input = document.querySelector('input');
    nativeSetValue(input, 'AI产品经理');
    expect(input.value).toBe('AI产品经理');
  });

  it('给 textarea 赋值', () => {
    document.body.innerHTML = '<textarea></textarea>';
    const el = document.querySelector('textarea');
    nativeSetValue(el, '你好');
    expect(el.value).toBe('你好');
  });
});

describe('syntheticImpl.click', () => {
  it('触发目标元素的 click 监听', async () => {
    document.body.innerHTML = '<button>立即沟通</button>';
    const button = document.querySelector('button');
    button.getBoundingClientRect = () => ({ x: 0, y: 0, width: 100, height: 30, top: 0, left: 0, right: 100, bottom: 30 });
    const handler = vi.fn();
    button.addEventListener('click', handler);

    await syntheticImpl.click(button, { rng: () => 0.5, fast: true });
    expect(handler).toHaveBeenCalledOnce();
  });

  it('发出的事件 isTrusted 为 false（这正是本方案的已知限制）', async () => {
    document.body.innerHTML = '<button>点我</button>';
    const button = document.querySelector('button');
    button.getBoundingClientRect = () => ({ x: 0, y: 0, width: 100, height: 30, top: 0, left: 0, right: 100, bottom: 30 });
    let trusted = null;
    button.addEventListener('click', (e) => { trusted = e.isTrusted; });

    await syntheticImpl.click(button, { rng: () => 0.5, fast: true });
    expect(trusted).toBe(false);
  });

  it('点击前发出 mousedown 与 mouseup', async () => {
    document.body.innerHTML = '<button>点我</button>';
    const button = document.querySelector('button');
    button.getBoundingClientRect = () => ({ x: 0, y: 0, width: 100, height: 30, top: 0, left: 0, right: 100, bottom: 30 });
    const seen = [];
    for (const type of ['mousedown', 'mouseup', 'click']) {
      button.addEventListener(type, () => seen.push(type));
    }

    await syntheticImpl.click(button, { rng: () => 0.5, fast: true });
    expect(seen).toEqual(['mousedown', 'mouseup', 'click']);
  });
});

describe('syntheticImpl.type', () => {
  it('把文本写进普通输入框', async () => {
    document.body.innerHTML = '<input />';
    const input = document.querySelector('input');
    await syntheticImpl.type(input, '产品经理', { rng: () => 0.5, fast: true });
    expect(input.value).toBe('产品经理');
  });

  it('每个字符都发出 input 事件', async () => {
    document.body.innerHTML = '<input />';
    const input = document.querySelector('input');
    const handler = vi.fn();
    input.addEventListener('input', handler);
    await syntheticImpl.type(input, 'abc', { rng: () => 0.5, fast: true });
    expect(handler).toHaveBeenCalledTimes(3);
  });

  it('输入前清空原有内容', async () => {
    document.body.innerHTML = '<input value="旧内容" />';
    const input = document.querySelector('input');
    input.value = '旧内容';
    await syntheticImpl.type(input, '新', { rng: () => 0.5, fast: true });
    expect(input.value).toBe('新');
  });
});

describe('syntheticImpl.scroll', () => {
  it('调用 window.scrollBy', async () => {
    const spy = vi.fn();
    const fakeWin = { scrollBy: spy };
    await syntheticImpl.scroll(300, { win: fakeWin, fast: true });
    expect(spy).toHaveBeenCalled();
  });
});
```

- [ ] **Step 6: 运行测试确认失败**

Run: `npx vitest run extension/act/synthetic.test.js`
Expected: FAIL，报错 `Failed to resolve import "./synthetic.js"`

- [ ] **Step 7: 实现合成事件版**

新建 `extension/act/synthetic.js`：

```javascript
/**
 * 执行层实现之一：合成事件
 *
 * 用 content script 能力直接 dispatchEvent。优点是零额外权限、可上应用商店；
 * 已知限制是所有事件 isTrusted 均为 false，若目标站点据此拦截则需换用
 * debugger 实现。
 *
 * 输入部分必须走原生 value setter：React 会给 input 挂一个 value tracker，
 * 直接赋 el.value 时 tracker 察觉不到变化，框架会在收到 input 事件后
 * 把值还原成自己的 state。绕过 tracker 是社区通行做法。
 */

import { clickPoint, movePlan, typingPlan } from './human.js';

/** 按计划停顿；fast 模式下跳过等待，供测试使用 */
async function pace(delayMs, fast) {
  if (fast) return;
  await new Promise((resolve) => setTimeout(resolve, delayMs));
}

/** 走原生 setter 赋值，绕过框架的 value tracker */
export function nativeSetValue(el, value) {
  const proto = el instanceof globalThis.HTMLTextAreaElement
    ? globalThis.HTMLTextAreaElement.prototype
    : globalThis.HTMLInputElement.prototype;
  const desc = Object.getOwnPropertyDescriptor(proto, 'value');
  if (desc && desc.set) {
    desc.set.call(el, value);
  } else {
    el.value = value;
  }
}

function fireMouse(el, type, point) {
  el.dispatchEvent(new MouseEvent(type, {
    bubbles: true,
    cancelable: true,
    clientX: point.x,
    clientY: point.y,
  }));
}

export const syntheticImpl = {
  async click(el, opts = {}) {
    const rng = opts.rng;
    const fast = opts.fast === true;

    el.scrollIntoView?.({ block: 'center' });
    await pace(400, fast);

    const box = el.getBoundingClientRect();
    const point = clickPoint(box, { rng });

    // 走一遍鼠标轨迹：即便 isTrusted=false，轨迹本身也构成行为特征
    const path = movePlan(box.x, box.y, point.x, point.y, { rng, steps: fast ? 2 : undefined });
    for (const step of path) {
      el.dispatchEvent(new MouseEvent('mousemove', {
        bubbles: true, clientX: step.x, clientY: step.y,
      }));
      await pace(step.delayMs, fast);
    }

    await pace(120, fast);
    fireMouse(el, 'mousedown', point);
    await pace(80, fast);
    fireMouse(el, 'mouseup', point);
    fireMouse(el, 'click', point);
  },

  async type(el, text, opts = {}) {
    const rng = opts.rng;
    const fast = opts.fast === true;

    el.focus?.();
    el.dispatchEvent(new FocusEvent('focusin', { bubbles: true }));

    // 清空原有内容
    nativeSetValue(el, '');
    el.dispatchEvent(new Event('input', { bubbles: true }));

    for (const step of typingPlan(text, { rng })) {
      el.dispatchEvent(new KeyboardEvent('keydown', { key: step.char, bubbles: true }));
      nativeSetValue(el, el.value + step.char);
      el.dispatchEvent(new Event('input', { bubbles: true }));
      el.dispatchEvent(new KeyboardEvent('keyup', { key: step.char, bubbles: true }));
      await pace(step.delayMs, fast);
    }

    el.dispatchEvent(new Event('change', { bubbles: true }));
  },

  async scroll(dy, opts = {}) {
    const win = opts.win ?? globalThis.window;
    const fast = opts.fast === true;
    const segments = 4;
    for (let i = 0; i < segments; i += 1) {
      win.scrollBy(0, dy / segments);
      await pace(250, fast);
    }
  },

  async navigate(url, opts = {}) {
    const win = opts.win ?? globalThis.window;
    win.location.href = url;
  },
};
```

- [ ] **Step 8: 运行全部执行层测试确认通过**

Run: `npx vitest run extension/act`
Expected: PASS，30 passed（human 9 + adapter 12 + synthetic 9）

- [ ] **Step 9: 提交**

```bash
git add extension/act/adapter.js extension/act/adapter.test.js extension/act/synthetic.js extension/act/synthetic.test.js
git commit -m "feat(extension): 执行层适配器接口与合成事件实现"
```

---

### Task 6: chrome.debugger 执行实现

第二套实现，经 CDP 发出 `isTrusted: true` 的真事件。代价是浏览器顶部常驻调试提示条，且该权限基本无法通过应用商店审核，因此只在合成事件被目标站点拒绝时启用。

CDP 调用无法在 jsdom 里真实执行，所以这一任务的测试针对「构造出的 CDP 命令是否正确」，而非「浏览器是否真的动了」。

**Files:**
- Create: `extension/act/debugger.js`
- Test: `extension/act/debugger.test.js`

**Interfaces:**
- Consumes: `clickPoint`、`movePlan`、`typingPlan`（Task 2）
- Produces: `createDebuggerImpl(sendCommand, opts) -> {click, type, scroll, navigate}`，其中 `sendCommand(method, params) -> Promise<any>`

- [ ] **Step 1: 写失败的测试**

新建 `extension/act/debugger.test.js`：

```javascript
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { createDebuggerImpl } from './debugger.js';

function makeEl(box) {
  const el = document.createElement('button');
  el.getBoundingClientRect = () => ({
    x: box.x, y: box.y, width: box.width, height: box.height,
    top: box.y, left: box.x, right: box.x + box.width, bottom: box.y + box.height,
  });
  el.scrollIntoView = () => {};
  document.body.appendChild(el);
  return el;
}

beforeEach(() => { document.body.innerHTML = ''; });

describe('createDebuggerImpl.click', () => {
  it('通过 Input.dispatchMouseEvent 发出按下与抬起', async () => {
    const send = vi.fn().mockResolvedValue({});
    const impl = createDebuggerImpl(send, { fast: true, rng: () => 0.5 });
    await impl.click(makeEl({ x: 0, y: 0, width: 100, height: 40 }));

    const types = send.mock.calls
      .filter((c) => c[0] === 'Input.dispatchMouseEvent')
      .map((c) => c[1].type);
    expect(types).toContain('mousePressed');
    expect(types).toContain('mouseReleased');
  });

  it('按下与抬起的坐标落在元素范围内', async () => {
    const send = vi.fn().mockResolvedValue({});
    const impl = createDebuggerImpl(send, { fast: true, rng: () => 0.5 });
    await impl.click(makeEl({ x: 10, y: 20, width: 100, height: 40 }));

    const pressed = send.mock.calls.find((c) => c[1]?.type === 'mousePressed')[1];
    expect(pressed.x).toBeGreaterThanOrEqual(10);
    expect(pressed.x).toBeLessThanOrEqual(110);
    expect(pressed.y).toBeGreaterThanOrEqual(20);
    expect(pressed.y).toBeLessThanOrEqual(60);
  });

  it('按下事件带 button:left 与 clickCount:1', async () => {
    const send = vi.fn().mockResolvedValue({});
    const impl = createDebuggerImpl(send, { fast: true, rng: () => 0.5 });
    await impl.click(makeEl({ x: 0, y: 0, width: 50, height: 20 }));

    const pressed = send.mock.calls.find((c) => c[1]?.type === 'mousePressed')[1];
    expect(pressed.button).toBe('left');
    expect(pressed.clickCount).toBe(1);
  });
});

describe('createDebuggerImpl.type', () => {
  it('每个字符发出一次 Input.insertText', async () => {
    const send = vi.fn().mockResolvedValue({});
    const impl = createDebuggerImpl(send, { fast: true, rng: () => 0.5 });
    await impl.type(makeEl({ x: 0, y: 0, width: 100, height: 30 }), 'abc');

    const inserts = send.mock.calls.filter((c) => c[0] === 'Input.insertText');
    expect(inserts).toHaveLength(3);
    expect(inserts.map((c) => c[1].text).join('')).toBe('abc');
  });
});

describe('createDebuggerImpl.scroll', () => {
  it('通过 Input.dispatchMouseEvent 的 mouseWheel 滚动', async () => {
    const send = vi.fn().mockResolvedValue({});
    const impl = createDebuggerImpl(send, { fast: true, rng: () => 0.5 });
    await impl.scroll(400);

    const wheels = send.mock.calls.filter((c) => c[1]?.type === 'mouseWheel');
    expect(wheels.length).toBeGreaterThan(0);
    const total = wheels.reduce((sum, c) => sum + c[1].deltaY, 0);
    expect(total).toBeCloseTo(400);
  });
});

describe('createDebuggerImpl.navigate', () => {
  it('调用 Page.navigate 并带上 url', async () => {
    const send = vi.fn().mockResolvedValue({});
    const impl = createDebuggerImpl(send, { fast: true });
    await impl.navigate('https://www.zhipin.com/job_detail/x.html');

    expect(send).toHaveBeenCalledWith('Page.navigate', {
      url: 'https://www.zhipin.com/job_detail/x.html',
    });
  });
});
```

- [ ] **Step 2: 运行测试确认失败**

Run: `npx vitest run extension/act/debugger.test.js`
Expected: FAIL，报错 `Failed to resolve import "./debugger.js"`

- [ ] **Step 3: 实现**

新建 `extension/act/debugger.js`：

```javascript
/**
 * 执行层实现之二：chrome.debugger 经 CDP 发真事件
 *
 * Input.dispatchMouseEvent / Input.insertText 产生的事件 isTrusted 为 true，
 * 与 Playwright 的行为一致。代价是浏览器顶部会常驻调试提示条，
 * 且 debugger 权限基本无法通过应用商店审核。
 *
 * 这里接受一个 sendCommand 函数而不是直接调 chrome.debugger，
 * 目的是让 CDP 命令的构造逻辑可以脱离浏览器测试。
 * 实际接线时传入：
 *   (method, params) => new Promise((resolve) =>
 *     chrome.debugger.sendCommand({ tabId }, method, params, resolve))
 */

import { clickPoint, movePlan, typingPlan } from './human.js';

async function pace(delayMs, fast) {
  if (fast) return;
  await new Promise((resolve) => setTimeout(resolve, delayMs));
}

export function createDebuggerImpl(sendCommand, implOpts = {}) {
  const fast = implOpts.fast === true;
  const rng = implOpts.rng;

  async function mouse(type, x, y, extra = {}) {
    await sendCommand('Input.dispatchMouseEvent', { type, x, y, ...extra });
  }

  return {
    async click(el) {
      el.scrollIntoView?.({ block: 'center' });
      await pace(400, fast);

      const box = el.getBoundingClientRect();
      const point = clickPoint(box, { rng });

      const path = movePlan(box.x, box.y, point.x, point.y, { rng, steps: fast ? 2 : undefined });
      for (const step of path) {
        await mouse('mouseMoved', step.x, step.y);
        await pace(step.delayMs, fast);
      }

      await pace(120, fast);
      await mouse('mousePressed', point.x, point.y, { button: 'left', clickCount: 1 });
      await pace(80, fast);
      await mouse('mouseReleased', point.x, point.y, { button: 'left', clickCount: 1 });
    },

    async type(el, text) {
      const box = el.getBoundingClientRect();
      const point = clickPoint(box, { rng });
      await mouse('mousePressed', point.x, point.y, { button: 'left', clickCount: 1 });
      await mouse('mouseReleased', point.x, point.y, { button: 'left', clickCount: 1 });
      await pace(200, fast);

      for (const step of typingPlan(text, { rng })) {
        await sendCommand('Input.insertText', { text: step.char });
        await pace(step.delayMs, fast);
      }
    },

    async scroll(dy) {
      const segments = 4;
      for (let i = 0; i < segments; i += 1) {
        await mouse('mouseWheel', 400, 400, { deltaX: 0, deltaY: dy / segments });
        await pace(250, fast);
      }
    },

    async navigate(url) {
      await sendCommand('Page.navigate', { url });
    },
  };
}
```

- [ ] **Step 4: 运行测试确认通过**

Run: `npx vitest run extension/act/debugger.test.js`
Expected: PASS，6 passed

- [ ] **Step 5: 提交**

```bash
git add extension/act/debugger.js extension/act/debugger.test.js
git commit -m "feat(extension): chrome.debugger 执行实现"
```

---

### Task 7: 插件骨架 —— manifest 与会话客户端

把前面的纯模块装进一个能真正加载的 MV3 插件。会话客户端负责与本机服务通信，逻辑抽成纯模块以便测试；service worker 只做薄壳。

**Files:**
- Create: `extension/manifest.json`
- Create: `extension/background/session-client.js`
- Create: `extension/background/service-worker.js`
- Test: `extension/background/session-client.test.js`

**Interfaces:**
- Consumes: 无
- Produces:
  - `SERVER_BASE`：常量 `'http://localhost:3010'`
  - `createSessionClient({fetchImpl, base}) -> {ping() -> Promise<boolean>, report(sessionId, payload) -> Promise<object>}`

- [ ] **Step 1: 写失败的测试**

新建 `extension/background/session-client.test.js`：

```javascript
import { describe, it, expect, vi } from 'vitest';
import { createSessionClient, SERVER_BASE } from './session-client.js';

describe('SERVER_BASE', () => {
  it('指向本机服务端口 3010', () => {
    expect(SERVER_BASE).toBe('http://localhost:3010');
  });
});

describe('createSessionClient.ping', () => {
  it('健康检查返回 200 时为 true', async () => {
    const fetchImpl = vi.fn().mockResolvedValue({ ok: true });
    const client = createSessionClient({ fetchImpl });
    expect(await client.ping()).toBe(true);
    expect(fetchImpl).toHaveBeenCalledWith('http://localhost:3010/api/health', expect.any(Object));
  });

  it('健康检查非 200 时为 false', async () => {
    const fetchImpl = vi.fn().mockResolvedValue({ ok: false });
    const client = createSessionClient({ fetchImpl });
    expect(await client.ping()).toBe(false);
  });

  it('网络异常时返回 false 而不是抛出', async () => {
    const fetchImpl = vi.fn().mockRejectedValue(new Error('ECONNREFUSED'));
    const client = createSessionClient({ fetchImpl });
    expect(await client.ping()).toBe(false);
  });
});

describe('createSessionClient.report', () => {
  it('以 POST + JSON 回报结果', async () => {
    const fetchImpl = vi.fn().mockResolvedValue({ ok: true, json: async () => ({ ok: true }) });
    const client = createSessionClient({ fetchImpl });
    await client.report('sess-1', { ok: true, step: 3 });

    const [url, init] = fetchImpl.mock.calls[0];
    expect(url).toBe('http://localhost:3010/api/internal/browser-task-done');
    expect(init.method).toBe('POST');
    expect(JSON.parse(init.body)).toEqual({ id: 'sess-1', result: { ok: true, step: 3 } });
  });

  it('服务端报错时返回带 error 的结果而不是抛出', async () => {
    const fetchImpl = vi.fn().mockRejectedValue(new Error('boom'));
    const client = createSessionClient({ fetchImpl });
    const result = await client.report('sess-1', {});
    expect(result.ok).toBe(false);
    expect(result.error).toContain('boom');
  });

  it('可用 base 覆盖默认地址', async () => {
    const fetchImpl = vi.fn().mockResolvedValue({ ok: true, json: async () => ({}) });
    const client = createSessionClient({ fetchImpl, base: 'http://127.0.0.1:9999' });
    await client.ping();
    expect(fetchImpl.mock.calls[0][0]).toBe('http://127.0.0.1:9999/api/health');
  });
});
```

- [ ] **Step 2: 运行测试确认失败**

Run: `npx vitest run extension/background/session-client.test.js`
Expected: FAIL，报错 `Failed to resolve import "./session-client.js"`

- [ ] **Step 3: 实现会话客户端**

新建 `extension/background/session-client.js`：

```javascript
/**
 * 与本机 PawPals 服务的通信
 *
 * 逻辑独立于 service worker，以便在 jsdom 里注入 fetch 打桩测试。
 * service worker 只负责把它接起来。
 *
 * 复用服务端已有的任务队列接缝（server.ts 的 /api/internal/browser-task*），
 * 该协议是纯 HTTP，不含任何 Electron 专属内容。
 */

export const SERVER_BASE = 'http://localhost:3010';

export function createSessionClient({ fetchImpl, base = SERVER_BASE } = {}) {
  const doFetch = fetchImpl ?? globalThis.fetch;

  async function ping() {
    try {
      const res = await doFetch(`${base}/api/health`, { method: 'GET' });
      return res.ok === true;
    } catch {
      return false;
    }
  }

  async function report(sessionId, payload) {
    try {
      const res = await doFetch(`${base}/api/internal/browser-task-done`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ id: sessionId, result: payload }),
      });
      if (!res.ok) return { ok: false, error: `服务端返回 ${res.status}` };
      return await res.json();
    } catch (error) {
      return { ok: false, error: String(error?.message || error) };
    }
  }

  return { ping, report };
}
```

- [ ] **Step 4: 运行测试确认通过**

Run: `npx vitest run extension/background/session-client.test.js`
Expected: PASS，7 passed

- [ ] **Step 5: 写 manifest**

新建 `extension/manifest.json`。`debugger` 权限先不声明——Task 6 的实现要用到它时再加，避免安装时就吓到用户。

```json
{
  "manifest_version": 3,
  "name": "PawPals 萌爪伴学",
  "version": "0.1.0",
  "description": "陪你求职的 AI 伴学团队。悬浮宠物 + 岗位页助手。",
  "permissions": ["storage", "sidePanel", "scripting", "tabs"],
  "host_permissions": [
    "http://localhost:3010/*",
    "https://www.zhipin.com/*"
  ],
  "background": {
    "service_worker": "background/service-worker.js",
    "type": "module"
  },
  "action": {
    "default_title": "PawPals"
  },
  "side_panel": {
    "default_path": "sidepanel/panel.html"
  },
  "content_scripts": [
    {
      "matches": ["https://www.zhipin.com/*"],
      "js": ["content/loader.js"],
      "css": ["content/pet.css"],
      "run_at": "document_idle"
    }
  ],
  "web_accessible_resources": [
    {
      "resources": ["content/*.js", "perceive/*.js", "act/*.js"],
      "matches": ["https://www.zhipin.com/*"]
    }
  ]
}
```

关于 `loader.js`：MV3 的 `content_scripts` 条目**不支持 ES module 语法**，写了 `import` 会直接加载失败。但条目里可以用**动态** `import()` 去拉起真正的模块，被拉起的模块内部就能正常使用 `import`。所以 content script 入口固定是一个不含静态 import 的 loader，实际逻辑都在它动态载入的模块里。`web_accessible_resources` 是动态 import 能取到这些文件的前提。

`loader.js` 由 Task 8 创建。

- [ ] **Step 6: 写 service worker 薄壳**

新建 `extension/background/service-worker.js`：

```javascript
/**
 * Service worker 薄壳
 *
 * MV3 的 service worker 空闲约 30 秒即休眠，所以这里不持有任何会话状态，
 * 只做三件事：点击图标开侧边栏、握手确认本机服务在、转发消息。
 * 状态一律存服务端。
 */

import { createSessionClient } from './session-client.js';

const client = createSessionClient();

chrome.action.onClicked.addListener(async (tab) => {
  if (tab?.id) await chrome.sidePanel.open({ tabId: tab.id });
});

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (msg?.type === 'PING_SERVER') {
    client.ping().then((alive) => sendResponse({ alive }));
    return true;
  }
  if (msg?.type === 'OPEN_PANEL') {
    const tabId = sender?.tab?.id;
    if (tabId) chrome.sidePanel.open({ tabId });
    sendResponse({ ok: true });
    return false;
  }
  return false;
});
```

- [ ] **Step 7: 提交**

```bash
git add extension/manifest.json extension/background/
git commit -m "feat(extension): MV3 骨架与会话客户端"
```

---

### Task 8: 悬浮宠物

注入到页面上的宠物。宠物的状态机抽成纯模块单测；DOM 注入部分薄到不需要测试。

**Files:**
- Create: `extension/content/pet-state.js`
- Create: `extension/content/pet.js`
- Create: `extension/content/pet.css`
- Test: `extension/content/pet-state.test.js`

**Interfaces:**
- Consumes: 无
- Produces:
  - `PET_STATES`：常量数组 `['idle', 'thinking', 'acting', 'alert', 'offline']`
  - `createPetState(initial = 'idle') -> {get(), set(next), onChange(fn)}`
  - `stateEmoji(state) -> string`

- [ ] **Step 1: 写失败的测试**

新建 `extension/content/pet-state.test.js`：

```javascript
import { describe, it, expect, vi } from 'vitest';
import { PET_STATES, createPetState, stateEmoji } from './pet-state.js';

describe('PET_STATES', () => {
  it('包含五种状态', () => {
    expect(PET_STATES).toEqual(['idle', 'thinking', 'acting', 'alert', 'offline']);
  });
});

describe('createPetState', () => {
  it('默认状态为 idle', () => {
    expect(createPetState().get()).toBe('idle');
  });

  it('可以设置为合法状态', () => {
    const state = createPetState();
    state.set('thinking');
    expect(state.get()).toBe('thinking');
  });

  it('设置非法状态时保持原状态', () => {
    const state = createPetState();
    state.set('exploding');
    expect(state.get()).toBe('idle');
  });

  it('状态变化时通知订阅者', () => {
    const state = createPetState();
    const listener = vi.fn();
    state.onChange(listener);
    state.set('acting');
    expect(listener).toHaveBeenCalledWith('acting', 'idle');
  });

  it('设置为相同状态时不通知', () => {
    const state = createPetState();
    const listener = vi.fn();
    state.onChange(listener);
    state.set('idle');
    expect(listener).not.toHaveBeenCalled();
  });
});

describe('stateEmoji', () => {
  it('每种状态都有对应表情', () => {
    for (const state of PET_STATES) {
      expect(stateEmoji(state)).toBeTruthy();
    }
  });

  it('未知状态退回默认表情', () => {
    expect(stateEmoji('nonsense')).toBe(stateEmoji('idle'));
  });
});
```

- [ ] **Step 2: 运行测试确认失败**

Run: `npx vitest run extension/content/pet-state.test.js`
Expected: FAIL，报错 `Failed to resolve import "./pet-state.js"`

- [ ] **Step 3: 实现状态机**

新建 `extension/content/pet-state.js`：

```javascript
/**
 * 宠物状态机
 *
 * idle     待命
 * thinking 正在等 LLM 返回
 * acting   正在页面上执行动作
 * alert    需要用户介入（验证码、需确认动作）
 * offline  连不上本机服务
 */

export const PET_STATES = ['idle', 'thinking', 'acting', 'alert', 'offline'];

const EMOJI = {
  idle: '🐾',
  thinking: '💭',
  acting: '✨',
  alert: '❗',
  offline: '💤',
};

export function stateEmoji(state) {
  return EMOJI[state] || EMOJI.idle;
}

export function createPetState(initial = 'idle') {
  let current = PET_STATES.includes(initial) ? initial : 'idle';
  const listeners = new Set();

  return {
    get() {
      return current;
    },
    set(next) {
      if (!PET_STATES.includes(next)) return;
      if (next === current) return;
      const previous = current;
      current = next;
      for (const listener of listeners) listener(current, previous);
    },
    onChange(fn) {
      listeners.add(fn);
      return () => listeners.delete(fn);
    },
  };
}
```

- [ ] **Step 4: 运行测试确认通过**

Run: `npx vitest run extension/content/pet-state.test.js`
Expected: PASS，8 passed

- [ ] **Step 5: 写宠物样式**

新建 `extension/content/pet.css`。用高 z-index 与 `all: initial` 隔离，避免被宿主页面样式影响。配色沿用项目现有的橙 `#FF8C42` 与棕 `#5C3D2E`。

```css
#pawpals-pet {
  all: initial;
  position: fixed;
  right: 24px;
  bottom: 24px;
  z-index: 2147483647;
  width: 56px;
  height: 56px;
  border-radius: 50%;
  background: #FF8C42;
  color: #fff;
  font-family: -apple-system, "PingFang SC", sans-serif;
  font-size: 26px;
  line-height: 56px;
  text-align: center;
  cursor: pointer;
  box-shadow: 0 4px 16px rgba(92, 61, 46, 0.3);
  transition: transform 0.2s ease;
  user-select: none;
}

#pawpals-pet:hover {
  transform: scale(1.08);
}

#pawpals-pet[data-state="offline"] {
  background: #B8A99C;
}

#pawpals-pet[data-state="alert"] {
  background: #E05A47;
}
```

- [ ] **Step 6: 写宠物注入脚本**

新建 `extension/content/pet.js`：

```javascript
/**
 * 悬浮宠物注入
 *
 * 薄壳：状态逻辑在 pet-state.js 里，这里只负责建 DOM、绑事件、同步 data-state。
 */

import { createPetState, stateEmoji } from './pet-state.js';

const state = createPetState('idle');

function mount() {
  if (document.getElementById('pawpals-pet')) return;

  const pet = document.createElement('div');
  pet.id = 'pawpals-pet';
  pet.textContent = stateEmoji(state.get());
  pet.dataset.state = state.get();
  pet.title = 'PawPals — 点击打开群聊';

  pet.addEventListener('click', () => {
    chrome.runtime.sendMessage({ type: 'OPEN_PANEL' });
  });

  state.onChange((next) => {
    pet.textContent = stateEmoji(next);
    pet.dataset.state = next;
  });

  document.body.appendChild(pet);

  // 服务端不在就置为 offline，让用户立刻知道要先起服务
  chrome.runtime.sendMessage({ type: 'PING_SERVER' }, (res) => {
    state.set(res?.alive ? 'idle' : 'offline');
  });
}

if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', mount);
} else {
  mount();
}
```

- [ ] **Step 7: 写 content script 入口加载器**

新建 `extension/content/loader.js`。它是 manifest 里唯一的 content script 入口，**不能含静态 import**。

```javascript
/**
 * content script 入口加载器
 *
 * MV3 的 content_scripts 条目不支持 ES module 语法，所以入口必须是
 * 一个不含静态 import 的普通脚本，再用动态 import() 拉起真正的模块。
 * 被拉起的模块内部可以正常使用 import。
 */
(async () => {
  const base = chrome.runtime.getURL('');
  await import(`${base}content/pet.js`);
})();
```

- [ ] **Step 8: 提交**

```bash
git add extension/content/
git commit -m "feat(extension): 悬浮宠物与状态机"
```

---

### Task 9: 侧边栏与手动调试面板

把感知层与执行层串起来，做成一个可演示的闭环：点「感知当前页面」列出带编号的元素，选一个编号和动作，点执行，页面真的动。这是本计划的交付物。

本任务**不接 LLM**，动作只能由人手动触发，因此不存在自主操作账号的风险。护栏 policy 与决策循环留给下一个计划。

**Files:**
- Create: `extension/sidepanel/panel.html`
- Create: `extension/sidepanel/panel.js`
- Create: `extension/content/bridge.js`
- Modify: `extension/manifest.json`（把 bridge.js 加入 content_scripts）
- Test: `extension/sidepanel/panel-view.test.js`
- Create: `extension/sidepanel/panel-view.js`

**Interfaces:**
- Consumes: `collectInteractive`、`renderForPrompt`（Task 4）；`createExecutor`、`syntheticImpl`（Task 5）
- Produces: `formatElementRows(elements) -> Array<{index, text}>`；`parseActionForm({action, index, text, dy, url}) -> object`

- [ ] **Step 1: 写视图层的失败测试**

新建 `extension/sidepanel/panel-view.test.js`：

```javascript
import { describe, it, expect } from 'vitest';
import { formatElementRows, parseActionForm } from './panel-view.js';

describe('formatElementRows', () => {
  it('把元素列表转成可显示的行', () => {
    const rows = formatElementRows([
      { index: 0, type: 'button', label: '立即沟通' },
      { index: 1, type: 'input', label: '搜索职位' },
    ]);
    expect(rows).toEqual([
      { index: 0, text: '[0] button "立即沟通"' },
      { index: 1, text: '[1] input "搜索职位"' },
    ]);
  });

  it('空列表返回空数组', () => {
    expect(formatElementRows([])).toEqual([]);
  });

  it('无文案的元素显示为「（无文案）」', () => {
    const rows = formatElementRows([{ index: 0, type: 'button', label: '' }]);
    expect(rows[0].text).toBe('[0] button "（无文案）"');
  });
});

describe('parseActionForm', () => {
  it('click 只保留 action 与 index', () => {
    expect(parseActionForm({ action: 'click', index: '3', text: '忽略' }))
      .toEqual({ action: 'click', index: 3 });
  });

  it('type 保留 index 与 text', () => {
    expect(parseActionForm({ action: 'type', index: '1', text: 'AI产品经理' }))
      .toEqual({ action: 'type', index: 1, text: 'AI产品经理' });
  });

  it('scroll 保留数值 dy', () => {
    expect(parseActionForm({ action: 'scroll', dy: '400' }))
      .toEqual({ action: 'scroll', dy: 400 });
  });

  it('navigate 保留 url', () => {
    expect(parseActionForm({ action: 'navigate', url: 'https://www.zhipin.com/' }))
      .toEqual({ action: 'navigate', url: 'https://www.zhipin.com/' });
  });

  it('index 非数字时置为 NaN 以便下游校验拒绝', () => {
    expect(Number.isNaN(parseActionForm({ action: 'click', index: 'abc' }).index)).toBe(true);
  });
});
```

- [ ] **Step 2: 运行测试确认失败**

Run: `npx vitest run extension/sidepanel/panel-view.test.js`
Expected: FAIL，报错 `Failed to resolve import "./panel-view.js"`

- [ ] **Step 3: 实现视图层纯函数**

新建 `extension/sidepanel/panel-view.js`：

```javascript
/** 侧边栏的纯展示逻辑，与 DOM 无关，便于单测 */

export function formatElementRows(elements) {
  return (elements || []).map((item) => ({
    index: item.index,
    text: `[${item.index}] ${item.type} "${item.label || '（无文案）'}"`,
  }));
}

/** 把表单里的字符串字段整理成执行层要的动作对象 */
export function parseActionForm(form) {
  const action = form.action;
  if (action === 'click') {
    return { action, index: Number(form.index) };
  }
  if (action === 'type') {
    return { action, index: Number(form.index), text: String(form.text ?? '') };
  }
  if (action === 'scroll') {
    return { action, dy: Number(form.dy) };
  }
  return { action, url: String(form.url ?? '') };
}
```

- [ ] **Step 4: 运行测试确认通过**

Run: `npx vitest run extension/sidepanel/panel-view.test.js`
Expected: PASS，8 passed

- [ ] **Step 5: 写页面内桥接脚本**

新建 `extension/content/bridge.js`。侧边栏拿不到页面 DOM，所有感知与执行都得在 content script 里做，通过消息往返。

```javascript
/**
 * 页面内桥接 —— 侧边栏与页面 DOM 之间的通道
 *
 * 侧边栏运行在独立文档里，拿不到宿主页面的 DOM，
 * 所以感知和执行都在这里做，只把可序列化的结果传回去（不传 DOM 引用）。
 */

import { collectInteractive } from '../perceive/collect.js';
import { fingerprint } from '../perceive/fingerprint.js';
import { createExecutor } from '../act/adapter.js';
import { syntheticImpl } from '../act/synthetic.js';

let lastElements = [];
const executor = createExecutor(syntheticImpl);

chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
  if (msg?.type === 'PERCEIVE') {
    lastElements = collectInteractive(document);
    sendResponse({
      ok: true,
      url: location.href,
      title: document.title,
      // 只回传可序列化字段，el 留在页面里
      elements: lastElements.map(({ index, tag, type, label }) => ({ index, tag, type, label })),
    });
    return false;
  }

  if (msg?.type === 'EXECUTE') {
    // 执行前重新算一次指纹，交给 adapter 比对
    const withCurrent = lastElements.map((item) => ({
      ...item,
      currentFingerprint: item.el.isConnected ? fingerprint(item.el) : null,
    }));
    executor.execute(msg.action, { elements: withCurrent })
      .then((result) => sendResponse(result));
    return true;
  }

  return false;
});
```

- [ ] **Step 6: 让加载器同时拉起 bridge.js**

修改 `extension/content/loader.js`（Task 8 创建），在 `pet.js` 之后加载 `bridge.js`：

```javascript
/**
 * content script 入口加载器
 *
 * MV3 的 content_scripts 条目不支持 ES module 语法，所以入口必须是
 * 一个不含静态 import 的普通脚本，再用动态 import() 拉起真正的模块。
 * 被拉起的模块内部可以正常使用 import。
 */
(async () => {
  const base = chrome.runtime.getURL('');
  await import(`${base}content/pet.js`);
  await import(`${base}content/bridge.js`);
})();
```

`manifest.json` 无需改动——Task 7 已把入口设为 `content/loader.js`，并已在 `web_accessible_resources` 中放行 `content/*.js`、`perceive/*.js`、`act/*.js`。

- [ ] **Step 7: 写侧边栏页面**

新建 `extension/sidepanel/panel.html`：

```html
<!DOCTYPE html>
<html lang="zh-CN">
<head>
  <meta charset="UTF-8" />
  <title>PawPals</title>
  <style>
    body { margin: 0; padding: 12px; font: 13px/1.6 -apple-system, "PingFang SC", sans-serif; color: #5C3D2E; background: #FFF8F0; }
    h1 { font-size: 14px; margin: 0 0 10px; }
    button { padding: 8px 12px; border: none; border-radius: 6px; background: #FF8C42; color: #fff; font-size: 13px; cursor: pointer; }
    button.ghost { background: transparent; color: #5C3D2E; border: 1px solid #EADDD0; }
    select, input { width: 100%; padding: 6px; margin: 4px 0 8px; border: 1px solid #EADDD0; border-radius: 6px; font-size: 13px; }
    #elements { max-height: 260px; overflow-y: auto; border: 1px solid #EADDD0; border-radius: 6px; padding: 6px; background: #fff; font-family: ui-monospace, Menlo, monospace; font-size: 11px; white-space: pre-wrap; }
    #result { margin-top: 10px; padding: 8px; border-radius: 6px; font-size: 12px; }
    .ok { background: #E8F6E8; }
    .bad { background: #FBEAEA; }
    label { font-size: 12px; opacity: .75; }
  </style>
</head>
<body>
  <h1>PawPals — 手动调试面板</h1>

  <button id="perceive">感知当前页面</button>
  <div id="elements" style="margin-top:10px">（尚未感知）</div>

  <hr style="margin:14px 0; border:none; border-top:1px solid #EADDD0" />

  <label>动作</label>
  <select id="action">
    <option value="click">click</option>
    <option value="type">type</option>
    <option value="scroll">scroll</option>
    <option value="navigate">navigate</option>
  </select>

  <label>元素编号（click / type）</label>
  <input id="index" type="number" placeholder="0" />

  <label>文本（type）</label>
  <input id="text" type="text" placeholder="AI产品经理" />

  <label>滚动距离（scroll）</label>
  <input id="dy" type="number" placeholder="400" />

  <label>网址（navigate）</label>
  <input id="url" type="text" placeholder="https://www.zhipin.com/" />

  <button id="execute" class="ghost">执行</button>
  <div id="result"></div>

  <script type="module" src="panel.js"></script>
</body>
</html>
```

- [ ] **Step 8: 写侧边栏脚本**

新建 `extension/sidepanel/panel.js`：

```javascript
import { formatElementRows, parseActionForm } from './panel-view.js';

const $ = (id) => document.getElementById(id);

async function activeTabId() {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  return tab?.id;
}

function show(ok, message) {
  const box = $('result');
  box.className = ok ? 'ok' : 'bad';
  box.textContent = message;
}

$('perceive').addEventListener('click', async () => {
  try {
    const tabId = await activeTabId();
    const res = await chrome.tabs.sendMessage(tabId, { type: 'PERCEIVE' });
    const rows = formatElementRows(res.elements);
    $('elements').textContent = rows.length
      ? rows.map((r) => r.text).join('\n')
      : '（页面上没有可交互元素）';
    show(true, `感知到 ${rows.length} 个元素 · ${res.title}`);
  } catch (error) {
    show(false, `感知失败：${error.message}。请确认当前标签页是 zhipin.com 且已刷新。`);
  }
});

$('execute').addEventListener('click', async () => {
  try {
    const action = parseActionForm({
      action: $('action').value,
      index: $('index').value,
      text: $('text').value,
      dy: $('dy').value,
      url: $('url').value,
    });
    const tabId = await activeTabId();
    const result = await chrome.tabs.sendMessage(tabId, { type: 'EXECUTE', action });
    show(result.ok, result.ok ? '执行成功' : `执行失败：${result.error}`);
  } catch (error) {
    show(false, `执行失败：${error.message}`);
  }
});
```

- [ ] **Step 9: 运行全部测试**

Run: `npm test`
Expected: PASS，88 passed（smoke 1 + human 9 + visibility 8 + fingerprint 10 + collect 10 + adapter 12 + synthetic 9 + debugger 6 + session-client 7 + pet-state 8 + panel-view 8）

- [ ] **Step 10: 手动验收**

1. `chrome://extensions/` → 开发者模式 → 加载已解压的扩展程序 → 选 `extension/` 目录
2. 另开终端跑 `npm run dev`（服务端 :3010）
3. 打开 `https://www.zhipin.com/` 并刷新
4. 右下角应出现橙色宠物；服务端没起时它是灰色的
5. 点宠物 → 侧边栏打开
6. 点「感知当前页面」→ 元素列表出现，带编号
7. 选一个安全的元素编号（例如搜索框），动作选 `type`，文本填「产品经理」，点执行
8. 页面上的搜索框应真的出现这段文字

**这一步的结果即为事件真实性的实测结论**：输入进得去说明合成事件可用，进不去说明需要切到 `debugger` 实现。把结论记录到 spec 的「未决事项」一节。

- [ ] **Step 11: 提交**

```bash
git add extension/
git commit -m "feat(extension): 侧边栏手动调试面板，感知与执行闭环"
```

---

## 自查记录

**Spec 覆盖情况：**

| Spec 要求 | 对应任务 |
|---|---|
| 插件位于 `extension/`、MV3 | Task 7 |
| 不改 `server.ts` / `src/App.tsx` | 全部任务均未列入这两个文件 |
| 感知层 DOM 索引 | Task 3、Task 4 |
| 元素指纹校验 | Task 4、Task 5（adapter 比对） |
| 执行层可替换适配器 | Task 5（接口 + synthetic）、Task 6（debugger） |
| 拟人化节奏移植 | Task 2 |
| 悬浮宠物 | Task 8 |
| `chrome.sidePanel` 侧边栏 | Task 7（manifest）、Task 9（页面） |
| 指向 `localhost:3010` | Task 7（`SERVER_BASE`） |
| 单元测试用 fixture 离线跑 | Task 1 建基建，Task 2-9 均含测试 |
| 事件真实性结论固化为回归测试 | Task 5 的 `isTrusted` 用例 + Task 9 手动验收 |

**本计划有意不覆盖的 spec 内容**（留给下一个计划）：护栏 `policy.ts`、`prompt.ts`、决策循环 `loop.ts`、Boss 登录/搜岗/投递的迁移、验证码检测、JSONL 留痕。因此本计划交付物无法自主操作账号，所有动作均需人工触发。
