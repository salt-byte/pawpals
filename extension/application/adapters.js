/**
 * 站点适配器：把「这家平台的下拉长什么样」写成数据。
 *
 * 通用解析（snapshot + 大模型）能啃陌生站点，但每次都要现场推理，而且在不做无
 * 障碍的表单上会成片失手——简道云那张表 39 个字段，16 个取不到 label、14 个
 * widget 探不到选项。那 14 个不是 14 个独立难题，是**一个** panel 选择器没配对。
 *
 * 而中国校招网申的表单高度集中在少数几个 ATS，同一平台的表单由同一套模板生成。
 * 所以踩通一家 = 这家以后全对。这是通用 agent 没有的便宜：它每次都得重新看，
 * 我们可以把答案存下来。
 *
 * 三层里这是第一层：
 *   1. 适配器命中 → 用确定的选择器          0 延迟、0 token、稳定
 *   2. 陌生站点   → 通用 snapshot + 模型     ~2 秒
 *   3. 都不行     → 视觉兜底（截图给坐标）    贵，但什么都能啃
 *
 * ── 为什么是数据而不是代码 ──
 * 适配器最终要能从服务端热下发：一个用户在某家平台踩通，所有用户当场受益，
 * 不用等发版。所以这里只接受**选择器**，不接受任何行为。
 *
 * ── 安全边界（重要） ──
 * 适配器绝不能声明 kind。resume / verification / sensitive_demographic 三类安全
 * 闸由确定性的 fieldKind 判定；若允许一份可下发的数据把「简历上传框」改写成
 * 「普通文本框」，安全闸就能被数据绕过。normalizeAdapter 只透传白名单里的键。
 */

/** 通用兜底：没有适配器命中时用的选择器，等同于原先硬编码在 widget.js 里的那套。 */
export const GENERIC_SELECTORS = {
  panel: '[class*="dropdown"],[class*="Dropdown"],[class*="popup"],[class*="Popup"],[class*="popper"],[class*="Popper"],[class*="menu"],[class*="Menu"],[class*="options"],[class*="select-panel"]',
  option: '',
  labelSelector: '',
};

/**
 * 内置适配器。只放**真机抓过 DOM** 的平台。
 *
 * 没验证过的平台宁可留空走通用路径：一个猜出来的选择器比没有更糟，它会顶掉
 * 通用兜底，而且失败得很安静。
 */
export const BUILTIN_ADAPTERS = [
  {
    id: 'jiandaoyun',
    name: '帆软 / 简道云',
    hosts: ['jiandaoyun.com'],
    // 真机验证：面板是 .x-popup / .x-combo-dropdown。选项是**完全没有 class 的
    // <span>**，所以 option 留空，仍走「面板内取带文字的叶子」这条通用逻辑。
    panel: '[class*="x-popup"],[class*="x-combo-dropdown"],[class*="x-dropdown"]',
    // 真机验证：label 在字段容器的标题层，不是 <label for>
    labelSelector: '[class*="field-name"],[class*="field-title"],[class*="form-item-label"]',
  },
  {
    id: 'moka',
    name: 'Moka',
    hosts: ['mokahr.com'],
    panel: '[class*="dropdown"],[class*="Select"],[class*="select__menu"]',
  },
];

const asSelector = (value) => (typeof value === 'string' ? value.trim() : '');

/**
 * 把一份来路不明的适配器（内置的，或将来服务端下发的）收拾成可用形状。
 * 拿不到 id 或 hosts 就当它不存在——宁可回退到通用路径。
 *
 * 只透传白名单字段。任何多余的键（kind、value、脚本…）在这里被丢掉。
 */
export function normalizeAdapter(raw) {
  if (!raw || typeof raw !== 'object') return null;
  const id = typeof raw.id === 'string' ? raw.id.trim() : '';
  const hosts = (Array.isArray(raw.hosts) ? raw.hosts : [])
    .map((host) => String(host || '').toLowerCase().trim().replace(/^www\./, ''))
    .filter(Boolean);
  if (!id || !hosts.length) return null;
  return {
    id,
    name: typeof raw.name === 'string' && raw.name ? raw.name : id,
    hosts,
    panel: asSelector(raw.panel),
    option: asSelector(raw.option),
    labelSelector: asSelector(raw.labelSelector),
  };
}

const hostOf = (url) => {
  try { return new URL(url).hostname.toLowerCase().replace(/^www\./, ''); } catch { return ''; }
};

/**
 * host 命中：完全相等，或是它的子域。
 * 必须比 includes 严——`evil-jiandaoyun.com` 和 `jiandaoyun.com.attacker.net`
 * 都不算命中，否则别人建个域名就能让我们用它指定的选择器。
 */
function hostMatches(host, pattern) {
  if (!host || !pattern) return false;
  return host === pattern || host.endsWith(`.${pattern}`);
}

export function createAdapterRegistry(list = BUILTIN_ADAPTERS) {
  const adapters = (Array.isArray(list) ? list : []).map(normalizeAdapter).filter(Boolean);

  const findFor = (url) => {
    const host = hostOf(url);
    if (!host) return null;
    return adapters.find((adapter) => adapter.hosts.some((pattern) => hostMatches(host, pattern))) || null;
  };

  return {
    all: () => adapters.slice(),
    /** 命中的适配器，没有就 null（调用方走通用路径）。 */
    for: findFor,
    /**
     * 实际要用的选择器。适配器可以**收窄**通用选择器——这正是它的价值：简道云
     * 的面板是 .x-popup，用通用那一长串会连带匹配到无关容器，反而更差。
     */
    selectorsFor(url) {
      const adapter = findFor(url);
      return {
        provider: adapter?.id || 'generic',
        panel: adapter?.panel || GENERIC_SELECTORS.panel,
        option: adapter?.option || GENERIC_SELECTORS.option,
        labelSelector: adapter?.labelSelector || GENERIC_SELECTORS.labelSelector,
      };
    },
  };
}
