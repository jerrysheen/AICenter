const SHARE_PLACEHOLDER = /\[未抓取\](?:\s*(?:图片(?:\s*[×xX]\s*\d+)?|视频|链接卡片(?:[：:][^\n]*)?|X\s*长文))?|\[图片\]|图片\s*[×xX]\s*\d+/g;

export function stripSharePlaceholders(value) {
  return String(value || '')
    .replace(SHARE_PLACEHOLDER, ' ')
    .replace(/[ \t]{2,}/g, ' ')
    .replace(/[ \t]*\n[ \t]*/g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

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

function isQuoteLine(line) {
  return /^>\s?/.test(String(line || ''));
}

function isBlockStart(lines, index) {
  const line = lines[index] || '';
  if (!line.trim()) return true;
  if (/^#{1,3}\s+\S/.test(line)) return true;
  if (isQuoteLine(line)) return true;
  if (isTableStart(lines, index)) return true;
  return Boolean(listMarker(line));
}

function takeQuote(lines, start) {
  const quoted = [];
  let index = start;
  while (index < lines.length && isQuoteLine(lines[index])) {
    quoted.push(lines[index].replace(/^>\s?/, ''));
    index += 1;
  }
  return { quoted, next: index };
}

function autolinkHtml(value) {
  return String(value || '').replace(/https?:\/\/[^\s<&]+/gi, (url) => {
    const cleaned = url.replace(/[),.;]+$/g, '');
    const trailing = url.slice(cleaned.length);
    return `<a href="${cleaned}" target="_blank" rel="noopener noreferrer">${cleaned}</a>${trailing}`;
  });
}

function takeMarkdownLinks(value) {
  const links = [];
  const marked = String(value || '').replace(/\[([^\]\n]+)\]\((https?:\/\/[^\s)]+)\)/g, (_match, label, href) => {
    const token = `\u0000L${links.length}\u0000`;
    links.push({ label, href });
    return token;
  });
  return { marked, links };
}

function restoreMarkdownLinks(value, links) {
  return String(value || '').replace(/\u0000L(\d+)\u0000/g, (_match, index) => {
    const link = links[Number(index)];
    if (!link) return '';
    return `<a href="${escapeHtml(link.href)}" target="_blank" rel="noopener noreferrer">${escapeHtml(link.label)}</a>`;
  });
}

function inlineHtml(value) {
  const { marked, links } = takeMarkdownLinks(value);
  let text = escapeHtml(marked);
  text = text.replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>');
  text = text.replace(/`([^`]+)`/g, '<code>$1</code>');
  text = text.replace(/(^|[^*`])\*([^*`\n]+)\*(?!\*)/g, '$1<em>$2</em>');
  return restoreMarkdownLinks(autolinkHtml(text), links);
}

function plainInline(value) {
  const { marked, links } = takeMarkdownLinks(value);
  const text = marked
    .replace(/\*\*([^*]+)\*\*/g, '$1')
    .replace(/`([^`]+)`/g, '$1')
    .replace(/(^|[^*`])\*([^*`\n]+)\*(?!\*)/g, '$1$2')
    .replace(/\u0000L(\d+)\u0000/g, (_match, index) => links[Number(index)]?.label || '')
    .replace(/\s+/g, ' ')
    .trim();
  return text;
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
    if (isQuoteLine(line)) {
      const taken = takeQuote(lines, index);
      const parts = taken.quoted.map((item) => item.trim()).filter(Boolean).map((item) => `<p>${inlineHtml(item)}</p>`);
      html.push(`<blockquote>${parts.join('')}</blockquote>`);
      index = taken.next;
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

function flattenShareList(node, blocks) {
  for (const item of node.items || []) {
    const extra = (item.extra || []).map(plainInline).filter(Boolean).join(' ');
    const text = [plainInline(item.text), extra].filter(Boolean).join(' ');
    if (text) blocks.push({ kind: 'text', text });
    for (const child of item.children || []) flattenShareList(child, blocks);
  }
}

export function markdownShareBlocks(value) {
  const lines = String(value || '').replace(/\r/g, '').split('\n');
  const blocks = [];
  for (let index = 0; index < lines.length;) {
    const line = lines[index];
    if (!line.trim()) {
      index += 1;
      continue;
    }
    const heading = line.match(/^(#{1,3})\s+(.+)$/);
    if (heading) {
      const text = plainInline(heading[2]);
      if (text) blocks.push({ kind: 'text', text });
      index += 1;
      continue;
    }
    if (isTableStart(lines, index)) {
      const headers = splitCells(line).map(plainInline);
      index += 2;
      const rows = [];
      while (index < lines.length && lines[index].includes('|') && !isDividerRow(lines[index])) {
        rows.push(splitCells(lines[index]).map(plainInline));
        index += 1;
      }
      blocks.push({ kind: 'table', headers, rows });
      continue;
    }
    if (isQuoteLine(line)) {
      const taken = takeQuote(lines, index);
      const text = plainInline(taken.quoted.join(' '));
      if (text) blocks.push({ kind: 'text', text });
      index = taken.next;
      continue;
    }
    if (listMarker(line)) {
      const parsed = parseList(lines, index);
      flattenShareList(parsed.list, blocks);
      index = parsed.next;
      continue;
    }
    const paragraph = [line];
    index += 1;
    while (index < lines.length && !isBlockStart(lines, index)) {
      paragraph.push(lines[index]);
      index += 1;
    }
    const text = plainInline(paragraph.join(' '));
    if (text) blocks.push({ kind: 'text', text });
  }
  return blocks;
}

// Read-only presentation of the existing connector comment marker. No stored
// content or translation cache is rewritten by these helpers.
export function splitFeedText(value) {
  const lines = String(value || '').replace(/\r\n?/g, '\n').trim().split('\n');
  const heading = /^\s*(?:#{1,6}\s*)?(?:\*\*)?(?:评论(?:区|预览)?|Comments?|Replies)(?:\*\*)?\s*[：:]?\s*$/iu;
  const marker = /^\s*(?:[·•*−-]|\d+[.)、])\s+/u;
  const index = lines.findIndex((line, i) => heading.test(line)
    && lines.slice(i + 1).find(next => next.trim())?.match(marker));
  if (index < 0) return { body: lines.join('\n'), comments: [], notes: '' };
  const comments = [];
  const tail = lines.slice(index + 1);
  const noteIndex = tail.findIndex(line => /^\s*\[未抓取\]/u.test(line));
  const commentLines = noteIndex < 0 ? tail : tail.slice(0, noteIndex);
  for (const line of commentLines) {
    if (marker.test(line)) comments.push(line.replace(marker, '').trim());
    else if (line.trim() && comments.length) comments[comments.length - 1] += `\n${line.trim()}`;
  }
  return {
    body: lines.slice(0, index).join('\n').trim(),
    comments,
    notes: noteIndex < 0 ? '' : tail.slice(noteIndex).join('\n').trim(),
  };
}

function readableParagraphs(value) {
  return String(value || '').split('\n').map(line => {
    line = line.replace(/^(\s*)[·•]\s+/u, '$1- ')
      .replace(/^(\s*)(\d+)[)、]\s+/u, '$1$2. ');
    // Lists, headings and table rows already carry meaningful structure.
    if (line.length <= 320 || /^\s*(?:#{1,6}\s|[-*·•]\s|\d+[.)、]\s|\|)/u.test(line)) return line;
    const sentences = line.match(/.*?(?:[。！？][”’」』]?|[.!?](?=\s|$)|$)/gu)?.filter(Boolean) || [line];
    const paragraphs = [];
    let paragraph = '';
    for (const sentence of sentences) {
      paragraph += sentence;
      if (paragraph.length >= 240) { paragraphs.push(paragraph.trim()); paragraph = ''; }
    }
    if (paragraph.trim()) paragraphs.push(paragraph.trim());
    return paragraphs.join('\n\n');
  }).join('\n');
}

export function feedTextToHtml(value) {
  const split = splitFeedText(value);
  const body = stripSharePlaceholders(split.body);
  const comments = split.comments.map((comment) => stripSharePlaceholders(comment)).filter(Boolean);
  const notes = stripSharePlaceholders(split.notes);
  const html = body ? markdownToHtml(readableParagraphs(body)) : '';
  const commentHtml = comments.length
    ? `<section class="feed-comments" aria-label="评论"><h4>评论 · ${comments.length}</h4><ul>${comments.map(comment => `<li>${inlineHtml(comment).replace(/\n/g, '<br>')}</li>`).join('')}</ul></section>`
    : '';
  const noteHtml = notes ? `<div class="feed-media-notes">${markdownToHtml(notes)}</div>` : '';
  return `<div class="feed-prose">${html}</div>${commentHtml}${noteHtml}`;
}

export function renderFeedTextInto(element, value) {
  element.innerHTML = feedTextToHtml(value);
}
