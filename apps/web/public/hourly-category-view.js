const node = (tag, className = '', text = '') => {
  const element = globalThis.document.createElement(tag);
  if (className) element.className = className;
  if (text) element.textContent = text;
  return element;
};

const CHROME = new Set(['tree-hour-fallback', 'news-day-label']);

function hasClass(element, name) {
  return String(element?.className || '').split(/\s+/).includes(name);
}

function childList(element) {
  return [...(element?.children || [])];
}

export function layoutHourlyDual(page, { enabled = false } = {}) {
  if (!enabled || !page) return { page, categorySlot: null };
  const children = childList(page);
  const existing = children.find((child) => hasClass(child, 'hourly-dual'));
  if (existing) {
    const categoryPane = childList(existing).find((child) => hasClass(child, 'hourly-dual-category'));
    const categorySlot = childList(categoryPane).find((child) => hasClass(child, 'hourly-category')) || null;
    return { page, categorySlot };
  }
  const chrome = [];
  const body = [];
  for (const child of children) {
    if ([...CHROME].some((name) => hasClass(child, name))) chrome.push(child);
    else body.push(child);
  }
  const dual = node('div', 'hourly-dual');
  const tree = node('details', 'hourly-dual-pane hourly-dual-tree');
  tree.open = false;
  tree.append(node('summary', 'hourly-dual-label', '信息树小时'));
  const treeBody = node('div', 'hourly-dual-body');
  body.forEach((child) => treeBody.append(child));
  tree.append(treeBody);
  const categoryPane = node('section', 'hourly-dual-pane hourly-dual-category is-primary');
  categoryPane.append(node('h2', 'hourly-dual-label', '类目小时'));
  const categorySlot = node('div', 'hourly-category');
  categoryPane.append(categorySlot);
  dual.append(tree, categoryPane);
  page.replaceChildren(...chrome, dual);
  paintHourlyCategory(categorySlot, null);
  return { page, categorySlot };
}

export function paintHourlyCategory(slot, edition) {
  slot.replaceChildren();
  slot.className = 'hourly-category';
  slot.hidden = false;
  if (!edition) {
    slot.append(node('p', 'hourly-category-empty', '分类小时报尚未生成'));
    return slot;
  }
  const categories = (edition.categories || []).filter((category) => category && (category.inputCount || category.events?.length));
  if (!categories.length || edition.status === 'empty') {
    slot.append(node('p', 'hourly-category-empty', '本小时暂无入料'));
    return slot;
  }
  for (const category of categories) {
    const untagged = category.id === '__untagged__';
    const block = node(untagged ? 'details' : 'section', untagged ? 'hourly-category-block is-untagged' : 'hourly-category-block');
    if (untagged) block.open = false;
    const heading = node(untagged ? 'summary' : 'h2', 'hourly-category-heading', category.label || category.id || '');
    const count = Number(category.inputCount) || (category.events || []).length;
    if (count) heading.append(node('span', 'hourly-category-count', `${count} 条`));
    if (category.truncated) heading.append(node('span', 'hourly-category-note', '材料已截断'));
    block.append(heading);
    const events = category.events || [];
    if (!events.length) {
      block.append(node('p', 'hourly-category-empty', category.status === 'failed' ? '这一类这次没有写成' : '这一类没有事件'));
    } else {
      const list = node('ul', 'hourly-category-events');
      events.forEach((event) => {
        const item = node('li', 'hourly-category-event');
        item.append(node('p', 'hourly-category-bullet', event.bullet || ''));
        const links = event.links || [];
        if (links.length) {
          const row = node('p', 'hourly-category-links');
          links.forEach((link, index) => {
            if (!link?.href) return;
            const anchor = node('a', 'hourly-category-link', links.length > 1 ? `原文 ${index + 1}` : '原文');
            anchor.href = link.href;
            row.append(anchor);
          });
          item.append(row);
        }
        list.append(item);
      });
      block.append(list);
    }
    slot.append(block);
  }
  return slot;
}
