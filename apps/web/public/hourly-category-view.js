const node = (tag, className = '', text = '') => {
  const element = globalThis.document.createElement(tag);
  if (className) element.className = className;
  if (text) element.textContent = text;
  return element;
};

export function paintHourlyCategory(slot, edition) {
  slot.replaceChildren();
  slot.className = 'hourly-category';
  if (!edition) {
    slot.append(node('p', 'tree-hour-empty', '分类小时报尚未生成'));
    return slot;
  }
  const categories = (edition.categories || []).filter((category) => category && (category.inputCount || category.events?.length));
  if (!categories.length) {
    slot.hidden = true;
    return slot;
  }
  slot.hidden = false;
  for (const category of categories) {
    const block = node('section', 'reading-block hourly-category-block');
    const heading = node('h2', 'reading-direction news-section-title', category.label || category.id || '');
    if (category.truncated) heading.append(node('span', 'news-section-count', '材料已截断'));
    block.append(heading);
    const events = category.events || [];
    if (!events.length) {
      block.append(node('p', 'tree-hour-empty', category.status === 'failed' ? '这一类这次没有写成' : '这一类没有事件'));
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
