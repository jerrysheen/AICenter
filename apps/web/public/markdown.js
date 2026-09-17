function escapeHtml(value) {
  return String(value || '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

function indentWidth(value) {
  const match = String(value || '').match(/^[ \t]*/);
  return (match?.[0] || '').replace(/\t/g, '    ').length;
}

function splitCells(line) {
  return String(line || '').trim().replace(/^\||\|$/g, '').split('|').map((cell) => cell.trim());
}

function isDividerRow(line) {
  const cells = splitCells(line);
  return cells.length > 0 && cells.every((cell) => /^:?-{3,}:?$/.test(cell));
}

function isTableStart(lines, index) {
  const line = lines[index] || '';
  if (!line.includes('|')) return false;
  return index + 1 < lines.length && isDividerRow(lines[index + 1]);
}

function listMarker(line) {
  const match = String(line || '').match(/^(\s*)([-*]|\d+\.)\s+(.*)$/);
  if (!match) return null;
  return {
    indent: match[1].replace(/\t/g, '    ').length,
    ordered: /^\d+\.$/.test(match[2]),
    text: match[3],
  };
}

function isBlockStart(lines, index) {
  const line = lines[index] || '';
  if (!line.trim()) return true;
  if (/^#{1,3}\s+\S/.test(line)) return true;
  if (isTableStart(lines, index)) return true;
  return Boolean(listMarker(line));
}

function autolinkHtml(value) {
  return String(value || '').replace(/https?:\/\/[^\s<&]+/gi, (url) => {
    const cleaned = url.replace(/[),.;]+$/g, '');
    const trailing = url.slice(cleaned.length);
    return `<a href="${cleaned}" target="_blank" rel="noopener noreferrer">${cleaned}</a>${trailing}`;
  });
}

function inlineHtml(value) {
  let text = escapeHtml(value);
  text = text.replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>');
  text = text.replace(/`([^`]+)`/g, '<code>$1</code>');
  text = text.replace(/(^|[^*`])\*([^*`\n]+)\*(?!\*)/g, '$1<em>$2</em>');
  return autolinkHtml(text);
}

function renderListHtml(node) {
  const tag = node.ordered ? 'ol' : 'ul';
  const items = node.items.map((item) => {
    const extra = item.extra.length
      ? item.extra.map((line) => `<div>${inlineHtml(line)}</div>`).join('')
      : '';
    const children = item.children.map(renderListHtml).join('');
    return `<li>${inlineHtml(item.text)}${extra}${children}</li>`;
  });
  return `<${tag}>${items.join('')}</${tag}>`;
}

function parseList(lines, start) {
  const first = listMarker(lines[start]);
  const items = [];
  let index = start;
  const base = first.indent;
  while (index < lines.length) {
    const line = lines[index];
    if (!line.trim()) {
      const next = lines[index + 1];
      if (next && (listMarker(next)?.indent >= base || indentWidth(next) > base)) {
        index += 1;
        continue;
      }
      break;
    }
    const marker = listMarker(line);
    if (marker && marker.indent === base && marker.ordered === first.ordered) {
      items.push({ text: marker.text, extra: [], children: [] });
      index += 1;
      continue;
    }
    if (marker && marker.indent > base) {
      const nested = parseList(lines, index);
      if (items.length) items[items.length - 1].children.push(nested.list);
      index = nested.next;
      continue;
    }
    if (!marker && items.length && indentWidth(line) > base) {
      items[items.length - 1].extra.push(line.trim());
      index += 1;
      continue;
    }
    break;
  }
  return { list: { ordered: first.ordered, items }, next: index };
}

export function markdownToHtml(value) {
  const lines = String(value || '').replace(/\r/g, '').split('\n');
  const html = [];
  for (let index = 0; index < lines.length;) {
    const line = lines[index];
    if (!line.trim()) {
      index += 1;
      continue;
    }
    const heading = line.match(/^(#{1,3})\s+(.+)$/);
    if (heading) {
      const level = Math.min(heading[1].length + 1, 4);
      html.push(`<h${level}>${inlineHtml(heading[2])}</h${level}>`);
      index += 1;
      continue;
    }
    if (isTableStart(lines, index)) {
      const headers = splitCells(line);
      index += 2;
      const rows = [];
      while (index < lines.length && lines[index].includes('|') && !isDividerRow(lines[index])) {
        rows.push(splitCells(lines[index]));
        index += 1;
      }
      const head = `<thead><tr>${headers.map((cell) => `<th>${inlineHtml(cell)}</th>`).join('')}</tr></thead>`;
      const body = `<tbody>${rows.map((row) => `<tr>${row.map((cell) => `<td>${inlineHtml(cell)}</td>`).join('')}</tr>`).join('')}</tbody>`;
      html.push(`<div class="ask-markdown-table-wrap"><table>${head}${body}</table></div>`);
      continue;
    }
    if (listMarker(line)) {
      const parsed = parseList(lines, index);
      html.push(renderListHtml(parsed.list));
      index = parsed.next;
      continue;
    }
    const paragraph = [line];
    index += 1;
    while (index < lines.length && !isBlockStart(lines, index)) {
      paragraph.push(lines[index]);
      index += 1;
    }
    html.push(`<p>${paragraph.map(inlineHtml).join('<br>')}</p>`);
  }
  return html.join('') || `<p>${inlineHtml(value)}</p>`;
}

export function renderMarkdownInto(element, value) {
  element.innerHTML = markdownToHtml(value);
}
