const ORIGINAL = /^(?:原文|打开原文|打开原站|前往原站(?:\s*↗)?)(?:\s|$)/;
const SAVED_ORIGINAL = /^阅读站内原文/;
const EXPAND = /^展开/;

export function behaviorClickName(label, { detailsOpen = false } = {}) {
  const text = String(label || '').replace(/\s+/g, ' ').trim();
  if (!text) return '';
  if (ORIGINAL.test(text) || SAVED_ORIGINAL.test(text)) return 'source.original';
  if (EXPAND.test(text)) return detailsOpen ? '' : 'item.expand';
  return '';
}

export function behaviorControlLabel(node) {
  if (!node) return '';
  const aria = typeof node.getAttribute === 'function' ? node.getAttribute('aria-label') : '';
  if (aria) return String(aria).replace(/\s+/g, ' ').trim();
  const span = typeof node.querySelector === 'function' ? node.querySelector('span') : null;
  const spanText = String(span?.textContent || '').replace(/\s+/g, ' ').trim();
  if (spanText && spanText.length <= 40) return spanText;
  return String(node.textContent || '').replace(/\s+/g, ' ').trim();
}

export function behaviorDetailsExpand(details) {
  if (!details || details.open !== true) return false;
  const marked = details.dataset?.behavior || details.getAttribute?.('data-behavior') || '';
  if (marked === 'item.expand') return true;
  const className = String(details.className || '');
  if (/(?:^|\s)(?:reading-fold|tree-body)(?:\s|$)/.test(className)) return true;
  const summary = typeof details.querySelector === 'function' ? details.querySelector('summary') : null;
  return behaviorClickName(behaviorControlLabel(summary)) === 'item.expand';
}
