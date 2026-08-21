import { fingerprint, fingerprintMatches } from '../perceive/fingerprint.js';

export const ACTIONS = ['click', 'type', 'scroll', 'navigate'];

export function validateAction(action) {
  if (!action || typeof action !== 'object') return { ok: false, error: '动作必须是对象' };
  if (!ACTIONS.includes(action.action)) return { ok: false, error: `未知动作 "${action.action}"` };
  if (['click', 'type'].includes(action.action) && !Number.isInteger(action.index)) return { ok: false, error: `动作 ${action.action} 缺少整数 index` };
  if (action.action === 'type' && typeof action.text !== 'string') return { ok: false, error: '动作 type 缺少字符串 text' };
  if (action.action === 'scroll' && !Number.isFinite(action.dy)) return { ok: false, error: '动作 scroll 缺少数值 dy' };
  if (action.action === 'navigate' && typeof action.url !== 'string') return { ok: false, error: '动作 navigate 缺少字符串 url' };
  return { ok: true };
}

export function createExecutor(impl) {
  return {
    async execute(action, context = {}) {
      const valid = validateAction(action);
      if (!valid.ok) return valid;
      let target;
      if (action.action === 'click' || action.action === 'type') {
        const elements = context.elements || [];
        target = elements.find((item) => item.index === action.index);
        if (!target) return { ok: false, error: `元素编号 ${action.index} 不存在，当前共 ${elements.length} 个元素` };
        const current = target.currentFingerprint || (target.el?.getBoundingClientRect ? fingerprint(target.el) : null);
        if (current && !fingerprintMatches(target.fingerprint, current)) {
          return { ok: false, error: `元素 ${action.index} 指纹已变化，需要重新感知` };
        }
      }
      try {
        if (action.action === 'click') await impl.click(target.el, action);
        if (action.action === 'type') await impl.type(target.el, action.text, action);
        if (action.action === 'scroll') await impl.scroll(action.dy, action);
        if (action.action === 'navigate') await impl.navigate(action.url, action);
        return { ok: true };
      } catch (error) {
        return { ok: false, error: String(error?.message || error) };
      }
    },
  };
}
