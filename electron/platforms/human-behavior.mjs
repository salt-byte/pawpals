/**
 * Human-like behavior helpers — 反爬第 2 层
 *
 * Boss 风控看的不是浏览器指纹，是行为：
 *   - 点击瞬移（没有鼠标 move 轨迹）→ bot 标记
 *   - 点击在元素正中心、像素级精准 → bot 标记
 *   - 表单 value 瞬间设置（没有 input 事件流）→ bot 标记
 *   - 页面加载完立即点击（没有阅读时间）→ bot 标记
 *
 * 这个模块提供：
 *   humanDelay(min, max)        随机停顿
 *   humanScroll(page, distance) 分段滚动 + 段间停顿
 *   humanMouseMove(p, fx,fy, tx,ty)  贝塞尔曲线鼠标轨迹
 *   humanClick(page, locator)   move → 微停 → off-center 点击（真 CDP 事件）
 *   humanType(page, text)       字符级输入，60-180ms 抖动 + 偶发"思考停顿"
 *
 * 所有操作都通过 Playwright 的 page.mouse / page.keyboard，底层是
 * CDP Input.dispatchMouseEvent / dispatchKeyEvent → 真 OS 事件，
 * 不是 JS dispatchEvent，所以 trusted=true，所有 framework 都识别为真人操作。
 */

export async function humanDelay(minMs, maxMs) {
  const ms = minMs + Math.random() * (maxMs - minMs);
  await new Promise((r) => setTimeout(r, ms));
}

/**
 * 分段滚动：把总距离切成 3-6 段，每段 1/N ± 20%，段间 200-600ms 停顿
 * 模拟"读一段 → 滚一点 → 读一段"的真人浏览节奏
 */
export async function humanScroll(page, totalDistance) {
  const chunks = 3 + Math.floor(Math.random() * 4);
  const baseChunk = totalDistance / chunks;
  for (let i = 0; i < chunks; i++) {
    const dy = baseChunk * (0.8 + Math.random() * 0.4);
    try {
      await page.mouse.wheel(0, dy);
    } catch {}
    await humanDelay(200, 600);
  }
}

/**
 * 贝塞尔曲线鼠标移动：from → to 之间用一个随机控制点画弧，
 * 分 25-45 步 dispatch mouse move 事件，每步 10-30ms
 * 这是人类移动鼠标的真实形态（不是直线，有微小弯曲）
 */
export async function humanMouseMove(page, fromX, fromY, toX, toY, options = {}) {
  const steps = options.steps ?? 25 + Math.floor(Math.random() * 20);
  const dist = Math.hypot(toX - fromX, toY - fromY);
  // 控制点：在 from-to 中点附近，垂直偏移 dist * 0-30%
  const midX = (fromX + toX) / 2;
  const midY = (fromY + toY) / 2;
  const perpScale = (Math.random() - 0.5) * dist * 0.6;
  const dx = toX - fromX;
  const dy = toY - fromY;
  const len = Math.hypot(dx, dy) || 1;
  const cpX = midX + (-dy / len) * perpScale;
  const cpY = midY + (dx / len) * perpScale;

  for (let i = 1; i <= steps; i++) {
    const t = i / steps;
    const x = (1 - t) ** 2 * fromX + 2 * (1 - t) * t * cpX + t ** 2 * toX;
    const y = (1 - t) ** 2 * fromY + 2 * (1 - t) * t * cpY + t ** 2 * toY;
    try {
      await page.mouse.move(x, y);
    } catch {}
    await new Promise((r) => setTimeout(r, 10 + Math.random() * 20));
  }
}

// 维护一个"上一次鼠标位置"——下次 move 从这里出发，连续性更真
let _lastMouse = { x: 200, y: 200 };

/**
 * 把元素滚到可视区 → 微停 → 鼠标从上次位置贝塞尔曲线移到目标偏中心位置 → 微停 → 点击
 * 整个 sequence ~ 1-2 秒，跟真人点击节奏一致
 */
export async function humanClick(page, locator) {
  try {
    await locator.scrollIntoViewIfNeeded({ timeout: 5000 });
  } catch {}
  await humanDelay(300, 700);

  const box = await locator.boundingBox().catch(() => null);
  if (!box) {
    // 拿不到 bbox 就退回普通 click（Playwright locator.click 本身也走 CDP）
    await locator.click().catch(() => {});
    return;
  }

  // 点击位置偏离正中心 25-75%（人类不会精确点击像素正中）
  const targetX = box.x + box.width * (0.3 + Math.random() * 0.4);
  const targetY = box.y + box.height * (0.3 + Math.random() * 0.4);

  await humanMouseMove(page, _lastMouse.x, _lastMouse.y, targetX, targetY);
  _lastMouse = { x: targetX, y: targetY };

  // 落点后微停（人按下鼠标前的瞄准抖动）
  await humanDelay(60, 180);
  try {
    await page.mouse.down();
    await humanDelay(40, 120); // press duration
    await page.mouse.up();
  } catch {
    await locator.click().catch(() => {});
  }
}

/**
 * 字符级输入：每个字符 60-180ms 抖动；8% 概率穿插 200-500ms "思考停顿"；
 * 5% 概率打错一个邻近字符再立即退格（人类打字真实特征）
 *
 * 用 page.keyboard.type/press，底层是 CDP Input.dispatchKeyEvent → 真键盘事件，
 * 触发 keydown/keypress/input/keyup 全流程，比 input.value=xxx 真实得多
 */
export async function humanType(page, text) {
  for (const char of text) {
    // 5% 打错 + 退格
    if (Math.random() < 0.05) {
      const typoChar = randomNeighborChar(char);
      try { await page.keyboard.type(typoChar); } catch {}
      await new Promise((r) => setTimeout(r, 80 + Math.random() * 120));
      try { await page.keyboard.press("Backspace"); } catch {}
      await new Promise((r) => setTimeout(r, 80 + Math.random() * 100));
    }
    try {
      await page.keyboard.type(char);
    } catch {}
    let delay = 60 + Math.random() * 120;
    if (Math.random() < 0.08) delay += 200 + Math.random() * 300; // 8% 思考停顿
    await new Promise((r) => setTimeout(r, delay));
  }
}

// 简单 typo 模拟：从一个小字符集随便挑一个（中文/英文都可用）
function randomNeighborChar(char) {
  if (/[a-zA-Z]/.test(char)) {
    const neighbors = "asdfghjklqwertyuiopzxcvbnm";
    return neighbors[Math.floor(Math.random() * neighbors.length)];
  }
  // 中文/其他：返回一个最近输入过的字符的占位（直接退格替换）
  return char;
}

/**
 * 鼠标位置随机游走 N 步——在等待页面加载时用，看起来"我在看页面"而不是冻结
 */
export async function humanIdleMove(page, durationMs) {
  const start = Date.now();
  const viewport = page.viewportSize() || { width: 1280, height: 800 };
  while (Date.now() - start < durationMs) {
    const tx = 100 + Math.random() * (viewport.width - 200);
    const ty = 100 + Math.random() * (viewport.height - 200);
    await humanMouseMove(page, _lastMouse.x, _lastMouse.y, tx, ty, {
      steps: 10 + Math.floor(Math.random() * 10),
    });
    _lastMouse = { x: tx, y: ty };
    await humanDelay(400, 1200);
  }
}
