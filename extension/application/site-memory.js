export function siteKey(url) {
  try { return new URL(url).hostname.toLowerCase().replace(/^www\./, ''); } catch { return ''; }
}

/** Keep reusable field mappings only; never store answers, credentials, or uploaded files. */
export function mergeSiteMemory(existing = {}, observation = {}) {
  const fields = Array.isArray(observation.fields) ? observation.fields : [];
  return {
    host: siteKey(observation.url || existing.host),
    provider: observation.provider || existing.provider || 'generic',
    updatedAt: observation.updatedAt || new Date().toISOString(),
    mappings: fields.filter((field) => field.kind && !['sensitive_demographic', 'verification'].includes(field.kind))
      .map((field) => ({ label: field.label, name: field.name, kind: field.kind, type: field.type })),
  };
}
