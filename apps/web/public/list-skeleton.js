function classNames(node) {
  return String(node?.className || '').split(/\s+/).filter(Boolean);
}

function directChild(root, className) {
  const children = root?.children ? [...root.children] : [];
  return children.find((node) => classNames(node).includes(className)) || null;
}

export function createListSkeleton(doc, { rows = 6, label = '正在读取', variant = '' } = {}) {
  const box = doc.createElement('div');
  box.className = variant === 'feed' ? 'list-skeleton is-feed' : 'list-skeleton';
  box.setAttribute('role', 'status');
  box.setAttribute('aria-busy', 'true');
  box.setAttribute('aria-label', label);
  if (box.dataset) box.dataset.rows = String(rows);
  const list = doc.createElement('div');
  list.className = 'list-skeleton-rows';
  for (let index = 0; index < rows; index += 1) {
    const row = doc.createElement('div');
    row.className = variant === 'feed' ? 'list-skeleton-row is-feed' : 'list-skeleton-row';
    row.setAttribute('aria-hidden', 'true');
    const title = doc.createElement('span');
    title.className = 'list-skeleton-title';
    const meta = doc.createElement('span');
    meta.className = 'list-skeleton-meta';
    row.append(title, meta);
    list.append(row);
  }
  box.append(list);
  return box;
}

export function paintListSkeleton(root, { rows = 6, label = '正在读取', variant = '' } = {}) {
  if (!root?.replaceChildren) return null;
  const doc = root.ownerDocument || (typeof document !== 'undefined' ? document : null);
  if (!doc?.createElement) return null;
  const current = directChild(root, 'list-skeleton');
  const sameRows = String(current?.dataset?.rows || '') === String(rows);
  const sameVariant = (variant === 'feed') === classNames(current).includes('is-feed');
  if (current && sameRows && sameVariant && root.childElementCount === 1) {
    current.setAttribute?.('aria-label', label);
    root.setAttribute?.('aria-busy', 'true');
    return current;
  }
  const box = createListSkeleton(doc, { rows, label, variant });
  root.replaceChildren(box);
  root.setAttribute?.('aria-busy', 'true');
  return box;
}

export function paintHubTickSkeleton(root, count = 4) {
  if (!root?.replaceChildren) return null;
  const doc = root.ownerDocument || (typeof document !== 'undefined' ? document : null);
  if (!doc?.createElement) return null;
  const size = Math.max(1, count);
  const first = root.children?.[0];
  if (first && classNames(first).includes('is-skeleton') && root.childElementCount === size) {
    root.setAttribute?.('aria-busy', 'true');
    return root;
  }
  const cards = [];
  for (let index = 0; index < size; index += 1) {
    const card = doc.createElement('div');
    card.className = 'hub-tick is-skeleton';
    card.setAttribute('aria-hidden', 'true');
    card.append(doc.createElement('span'), doc.createElement('span'), doc.createElement('span'));
    cards.push(card);
  }
  root.replaceChildren(...cards);
  root.setAttribute?.('aria-busy', 'true');
  return root;
}
