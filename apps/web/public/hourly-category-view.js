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
  tree.append(node('summary', 'hourly-dual-label', '展开看信息树这一小时'));
  const treeBody = node('div', 'hourly-dual-body');
  body.forEach((child) => treeBody.append(child));
  tree.append(treeBody);
  const categoryPane = node('section', 'hourly-dual-pane hourly-dual-category is-primary');
  const lead = node('p', 'hourly-category-lead', '按方向整理好了，先看要点');
  lead.hidden = true;
  categoryPane.append(lead);
  categoryPane.append(node('h2', 'hourly-dual-label', '类目小时'));
  const categorySlot = node('div', 'hourly-category');
  categoryPane.append(categorySlot);
  dual.append(tree, categoryPane);
  page.replaceChildren(...chrome, dual);
  paintHourlyCategory(categorySlot, null);
  return { page, categorySlot };
}

function categoryCount(category) {
  return Number(category.inputCount) || (category.events || []).length;
}

function orderedCategories(categories) {
  const tagged = [];
  const untagged = [];
  for (const category of categories) {
    if (category.id === '__untagged__') untagged.push(category);
    else tagged.push(category);
  }
  return [...tagged, ...untagged];
}

function syncCategoryLead(slot, visible) {
  const lead = childList(slot?.parentElement).find((child) => hasClass(child, 'hourly-category-lead'));
  if (lead) lead.hidden = !visible;
}

function shownMaterialCount(category) {
  let count = 0;
  for (const event of category.events || []) {
    const links = (event.links || []).filter((link) => link && (link.href || link.sourceId));
    if (links.length) {
      count += links.length;
      continue;
    }
    const sourceIds = Array.isArray(event.sourceIds) ? event.sourceIds.filter(Boolean) : [];
    count += sourceIds.length || 1;
  }
  return count;
}

function displayGapNote(category, total) {
  const shown = shownMaterialCount(category);
  if (!total || shown >= total) return '';
  return `已显示 ${shown}/${total}`;
}

function appendCategoryEvents(block, category) {
  const events = category.events || [];
  if (!events.length) {
    block.append(node('p', 'hourly-category-empty', category.status === 'failed' ? '这一类这次没有写成' : '这一类没有事件'));
    return;
  }
  const list = node('ul', 'hourly-category-events');
  events.forEach((event) => {
    const item = node('li', 'hourly-category-event');
    const paragraph = node('p', 'hourly-category-bullet', event.bullet || '');
    const links = (event.links || []).filter((link) => link?.href);
    links.forEach((link, index) => {
      const anchor = node('a', 'hourly-category-link', links.length > 1 ? `原文 ${index + 1}` : '原文');
      anchor.href = link.href;
      paragraph.append(anchor);
    });
    item.append(paragraph);
    list.append(item);
  });
  block.append(list);
}

export function paintHourlyCategory(slot, edition) {
  slot.replaceChildren();
  slot.className = 'hourly-category';
  slot.hidden = false;
  if (!edition) {
    syncCategoryLead(slot, false);
    slot.append(node('p', 'hourly-category-empty', '分类小时报尚未生成'));
    return slot;
  }
  const categories = orderedCategories((edition.categories || []).filter((category) => category && (category.inputCount || category.events?.length)));
  if (!categories.length || edition.status === 'empty') {
    syncCategoryLead(slot, false);
    slot.append(node('p', 'hourly-category-empty', '本小时暂无入料'));
    return slot;
  }
  const tagged = categories.filter((category) => category.id !== '__untagged__');
  syncCategoryLead(slot, tagged.length > 0);
  for (const category of categories) {
    const untagged = category.id === '__untagged__';
    const count = categoryCount(category);
    const block = node('section', untagged ? 'hourly-category-block is-untagged' : 'hourly-category-block');
    const heading = node('h2', 'hourly-category-heading', untagged ? `还没归类 · ${count}` : (category.label || category.id || ''));
    if (!untagged && count) heading.append(node('span', 'hourly-category-count', String(count)));
    const gap = displayGapNote(category, count);
    if (gap) heading.append(node('span', 'hourly-category-note', gap));
    block.append(heading);
    appendCategoryEvents(block, category);
    slot.append(block);
  }
  return slot;
}
