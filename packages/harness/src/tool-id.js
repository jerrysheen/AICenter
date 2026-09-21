export function toHarnessToolName(id) {
  return String(id || '').trim().replaceAll('.', '_');
}

export function fromHarnessToolName(name) {
  const value = String(name || '').trim();
  if (!value) return '';
  return value.includes('.') ? value : value.replaceAll('_', '.');
}
