const PROVIDERS = [
  // 海外
  'greenhouse', 'lever', 'workday', 'icims', 'smartrecruiters',
  // 国内
  'moka', 'beisen', 'dayee',
  'generic',
];

export function detectApplicationProvider(url = '') {
  const host = (() => { try { return new URL(url).hostname.toLowerCase(); } catch { return ''; } })();
  if (!host) return 'generic';

  if (/greenhouse\.io$/.test(host) || host.includes('boards.greenhouse')) return 'greenhouse';
  if (/lever\.co$/.test(host) || host.includes('jobs.lever')) return 'lever';
  if (/myworkdayjobs\.com$/.test(host) || host.includes('workday')) return 'workday';
  if (host.includes('icims.com')) return 'icims';
  if (host.includes('smartrecruiters.com')) return 'smartrecruiters';

  // 国内 ATS。域名来自公开的招聘页地址，未逐一在真实页面上核过，
  // 遇到识别不出的站点应补充而不是改成模糊匹配。
  if (/(^|\.)mokahr\.com$/.test(host)) return 'moka';
  if (/(^|\.)zhiye\.com$/.test(host) || /(^|\.)italent\.cn$/.test(host)) return 'beisen';
  if (/(^|\.)dayeejob\.com$/.test(host)) return 'dayee';

  return 'generic';
}

export function fieldKind(field) {
  const text = [field.label, field.name, field.id, field.placeholder, field.type].filter(Boolean).join(' ').toLowerCase();

  // 任何文件输入都按附件处理，不看标签。真机在帆软秋招页（简道云）上实测：
  // 简历附件那两个 file 输入的标签取不出来（上传组件把字段名挡在外层），靠标签
  // 判断会让 resume_requires_user_file_selection 整个不触发，「简历先传」这道闸
  // 形同虚设。宁可把成绩单、作品集也一并停下来问用户，也不能漏掉简历。
  if (String(field.type || '').toLowerCase() === 'file') return 'resume';
  if (/resume|cv|简历/.test(text)) return 'resume';
  if (/cover letter|求职信/.test(text)) return 'cover_letter';
  // 全名必须排在姓/名之前：「姓名」里含「名」，先判 first_name 会把中文表单
  // 里最常见的全名字段判成名，填进去只有名没有姓。
  if (/full.*name|your name|姓名|名字/.test(text)) return 'full_name';
  if (/first.*name|given.*name|名/.test(text)) return 'first_name';
  if (/last.*name|family.*name|姓/.test(text)) return 'last_name';
  if (/e-?mail|邮箱/.test(text)) return 'email';
  if (/phone|mobile|telephone|手机|电话|联系方式/.test(text)) return 'phone';
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
