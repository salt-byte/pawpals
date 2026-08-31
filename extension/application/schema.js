const PROVIDERS = ['greenhouse', 'lever', 'workday', 'icims', 'smartrecruiters', 'generic'];

export function detectApplicationProvider(url = '') {
  const host = (() => { try { return new URL(url).hostname.toLowerCase(); } catch { return ''; } })();
  if (/greenhouse\.io$/.test(host) || host.includes('boards.greenhouse')) return 'greenhouse';
  if (/lever\.co$/.test(host) || host.includes('jobs.lever')) return 'lever';
  if (/myworkdayjobs\.com$/.test(host) || host.includes('workday')) return 'workday';
  if (host.includes('icims.com')) return 'icims';
  if (host.includes('smartrecruiters.com')) return 'smartrecruiters';
  return 'generic';
}

export function fieldKind(field) {
  const text = [field.label, field.name, field.id, field.placeholder, field.type].filter(Boolean).join(' ').toLowerCase();
  if (/resume|cv|简历/.test(text)) return 'resume';
  if (/cover letter|求职信/.test(text)) return 'cover_letter';
  if (/first.*name|given.*name|名(?!字)/.test(text)) return 'first_name';
  if (/last.*name|family.*name|姓/.test(text)) return 'last_name';
  if (/full.*name|姓名|your name/.test(text)) return 'full_name';
  if (/e-?mail|邮箱/.test(text)) return 'email';
  if (/phone|mobile|telephone|手机号|电话/.test(text)) return 'phone';
  if (/linkedin/.test(text)) return 'linkedin';
  if (/portfolio|website|personal site|作品集|个人网站/.test(text)) return 'portfolio';
  if (/work authorization|authorized.*work|sponsor|visa|身份|签证/.test(text)) return 'work_authorization';
  if (/gender|race|ethnicity|disability|veteran|性别|种族|残疾/.test(text)) return 'sensitive_demographic';
  if (/captcha|recaptcha|verification|验证/.test(text)) return 'verification';
  return 'custom';
}

/**
 * 跨渲染稳定的字段标识。
 *
 * 不能用数组下标：inspect 与 fill 是两次独立的往返，中间用户可能新增一段
 * 经历、上传简历触发解析重渲染，索引一旦位移，值就会被静默填进别的框。
 * name / id / type / label 这四项在重渲染后不变。
 */
export function fieldSignature(raw) {
  const part = (v) => String(v ?? '').replace(/\s+/g, ' ').trim().toLowerCase();
  return [
    `name=${part(raw.name)}`,
    `id=${part(raw.id)}`,
    `type=${part(raw.type) || 'text'}`,
    `label=${part(raw.label)}`,
  ].join('|');
}

export function normaliseField(raw, index) {
  return {
    index,
    label: String(raw.label || '').trim(),
    name: String(raw.name || '').trim(),
    type: String(raw.type || 'text').toLowerCase(),
    required: raw.required === true,
    options: Array.isArray(raw.options) ? raw.options.map(String).slice(0, 80) : [],
    kind: fieldKind(raw),
    signature: fieldSignature(raw),
  };
}

export { PROVIDERS };
