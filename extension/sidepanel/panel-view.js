export function formatElementRows(elements) {
  return (elements || []).map((item) => ({
    index: item.index,
    text: `[${item.index}] ${item.type} "${item.label || '（无文案）'}"`,
  }));
}

export function parseActionForm(form) {
  if (form.action === 'click') return { action: 'click', index: Number(form.index) };
  if (form.action === 'type') return { action: 'type', index: Number(form.index), text: String(form.text ?? '') };
  if (form.action === 'scroll') return { action: 'scroll', dy: Number(form.dy) };
  return { action: form.action, url: String(form.url ?? '') };
}
