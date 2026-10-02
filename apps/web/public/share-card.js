export const SHARE_CARD_WIDTH = 720;
export const SHARE_CARD_MAX_HEIGHT = 4000;
export const SHARE_CARD_BODY_MAX_HEIGHT = 3680;

export function sharePngFilename(title, now = new Date()) {
  const stamp = now.toISOString().slice(0, 10);
  const slug = String(title || '问答')
    .replace(/[\\/:*?"<>|\n\r]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 36) || '问答';
  return `aicenter-${slug}-${stamp}.png`;
}

export function stripAskShareClone(root) {
  root.querySelectorAll('.ask-exchange-actions, .ask-run-trace').forEach((node) => node.remove());
  return root;
}

export function buildAskShareSheet(card) {
  const sheet = document.createElement('article');
  sheet.className = 'share-sheet';
  const clone = card.cloneNode(true);
  clone.classList.add('share-sheet-card');
  stripAskShareClone(clone);
  const heading = clone.querySelector('.ask-question');
  const title = heading?.textContent?.trim() || '问答';
  if (heading) {
    const question = document.createElement('p');
    question.className = 'share-sheet-question';
    question.textContent = title;
    heading.replaceWith(question);
  }
  const foot = document.createElement('footer');
  foot.className = 'share-sheet-foot';
  foot.append(
    Object.assign(document.createElement('span'), { className: 'share-sheet-brand', textContent: 'AI Center' }),
    Object.assign(document.createElement('span'), {
      className: 'share-sheet-meta',
      textContent: `${title} · ${new Date().toLocaleDateString('zh-CN')}`,
    }),
  );
  sheet.append(clone, foot);
  return { sheet, title };
}

function nextFrame() {
  return new Promise((resolve) => {
    requestAnimationFrame(() => requestAnimationFrame(resolve));
  });
}

function canvasFont(style) {
  const family = style.fontFamily || '"Microsoft YaHei", "PingFang SC", "Noto Sans SC", sans-serif';
  return `${style.fontStyle || 'normal'} ${style.fontWeight || '400'} ${style.fontSize || '16px'} ${family}`;
}

function parsePx(value) {
  const number = Number.parseFloat(value);
  return Number.isFinite(number) ? number : 0;
}

function visibleColor(value) {
  const text = String(value || '');
  if (!text || text === 'transparent' || text === 'rgba(0, 0, 0, 0)') return '';
  return text;
}

function pathRoundRect(context, x, y, width, height, radius) {
  const size = Math.max(0, Math.min(radius, width / 2, height / 2));
  context.beginPath();
  if (!size) {
    context.rect(x, y, width, height);
    return;
  }
  context.moveTo(x + size, y);
  context.arcTo(x + width, y, x + width, y + height, size);
  context.arcTo(x + width, y + height, x, y + height, size);
  context.arcTo(x, y + height, x, y, size);
  context.arcTo(x, y, x + width, y, size);
  context.closePath();
}

function borderSide(style, side) {
  const width = parsePx(style[`border${side}Width`]);
  const color = visibleColor(style[`border${side}Color`]);
  const line = style[`border${side}Style`];
  if (!width || !color || line === 'none' || line === 'hidden') return null;
  return { width, color };
}

function uniformBorder(style) {
  const sides = ['Top', 'Right', 'Bottom', 'Left'].map((side) => borderSide(style, side));
  if (sides.some((side) => !side)) return null;
  const [first] = sides;
  if (!sides.every((side) => side.width === first.width && side.color === first.color)) return null;
  return first;
}

function strokeBorderSides(context, x, y, width, height, style) {
  const sides = {
    Top: borderSide(style, 'Top'),
    Right: borderSide(style, 'Right'),
    Bottom: borderSide(style, 'Bottom'),
    Left: borderSide(style, 'Left'),
  };
  context.beginPath();
  if (sides.Top) {
    context.strokeStyle = sides.Top.color;
    context.lineWidth = sides.Top.width;
    context.moveTo(x, y + sides.Top.width / 2);
    context.lineTo(x + width, y + sides.Top.width / 2);
    context.stroke();
  }
  if (sides.Right) {
    context.strokeStyle = sides.Right.color;
    context.lineWidth = sides.Right.width;
    context.beginPath();
    context.moveTo(x + width - sides.Right.width / 2, y);
    context.lineTo(x + width - sides.Right.width / 2, y + height);
    context.stroke();
  }
  if (sides.Bottom) {
    context.strokeStyle = sides.Bottom.color;
    context.lineWidth = sides.Bottom.width;
    context.beginPath();
    context.moveTo(x, y + height - sides.Bottom.width / 2);
    context.lineTo(x + width, y + height - sides.Bottom.width / 2);
    context.stroke();
  }
  if (sides.Left) {
    context.strokeStyle = sides.Left.color;
    context.lineWidth = sides.Left.width;
    context.beginPath();
    context.moveTo(x + sides.Left.width / 2, y);
    context.lineTo(x + sides.Left.width / 2, y + height);
    context.stroke();
  }
}

function paintBox(context, node, origin) {
  const style = getComputedStyle(node);
  if (style.display === 'none' || style.visibility === 'hidden' || Number(style.opacity) === 0) {
    return false;
  }
  const fill = visibleColor(style.backgroundColor);
  const uniform = uniformBorder(style);
  const hasSide = ['Top', 'Right', 'Bottom', 'Left'].some((side) => borderSide(style, side));
  if (!fill && !hasSide) return true;
  const radius = parsePx(style.borderTopLeftRadius);
  const rects = [...node.getClientRects()].filter((rect) => rect.width > 0 && rect.height > 0);
  for (const rect of rects) {
    const x = rect.left - origin.left;
    const y = rect.top - origin.top;
    if (fill) {
      context.fillStyle = fill;
      pathRoundRect(context, x, y, rect.width, rect.height, radius);
      context.fill();
    }
    if (uniform) {
      context.lineWidth = uniform.width;
      context.strokeStyle = uniform.color;
      pathRoundRect(
        context,
        x + uniform.width / 2,
        y + uniform.width / 2,
        Math.max(0, rect.width - uniform.width),
        Math.max(0, rect.height - uniform.width),
        Math.max(0, radius - uniform.width / 2),
      );
      context.stroke();
    } else if (hasSide) {
      strokeBorderSides(context, x, y, rect.width, rect.height, style);
    }
  }
  return true;
}

function letterSpacingPx(style) {
  if (!style.letterSpacing || style.letterSpacing === 'normal') return 0;
  return parsePx(style.letterSpacing);
}

function measureTracked(context, text, spacing) {
  if (!spacing) return context.measureText(text).width;
  let width = 0;
  for (const char of text) width += context.measureText(char).width + spacing;
  return Math.max(0, width - (text ? spacing : 0));
}

function fillTracked(context, text, x, y, spacing) {
  if (!spacing) {
    context.fillText(text, x, y);
    return context.measureText(text).width;
  }
  let cursor = x;
  for (const char of text) {
    context.fillText(char, cursor, y);
    cursor += context.measureText(char).width + spacing;
  }
  return Math.max(0, cursor - x - (text ? spacing : 0));
}

function ellipsize(context, text, maxWidth, spacing) {
  if (measureTracked(context, text, spacing) <= maxWidth + 0.5) return text;
  const dots = '…';
  if (measureTracked(context, dots, spacing) > maxWidth) return '';
  let low = 0;
  let high = text.length;
  while (low < high) {
    const mid = Math.ceil((low + high) / 2);
    const width = measureTracked(context, text.slice(0, mid) + dots, spacing);
    if (width <= maxWidth) low = mid;
    else high = mid - 1;
  }
  return `${text.slice(0, low)}${dots}`;
}

function lineTextTop(rect, fontSize) {
  const extra = rect.height - fontSize;
  return rect.top + (extra > 0 ? extra / 2 : 0);
}

// Keep the browser's line breaks. Measuring the whole string again drifts
// once a line starts after <strong> or <a>, or a URL breaks mid-word.
function textLineBoxes(node) {
  const text = node.textContent ?? '';
  if (!text) return [];
  const range = document.createRange();
  range.setStart(node, 0);
  range.setEnd(node, text.length);
  const all = range.getClientRects();
  if (!all.length) return [];
  if (all.length === 1) {
    return [{ text, left: all[0].left, top: all[0].top, width: all[0].width, height: all[0].height }];
  }
  const lines = [];
  let offset = 0;
  while (offset < text.length && lines.length <= text.length) {
    range.setStart(node, offset);
    range.setEnd(node, text.length);
    const rest = range.getClientRects();
    if (!rest.length) break;
    const top = rest[0].top;
    let low = offset + 1;
    let high = text.length;
    let end = offset;
    while (low <= high) {
      const mid = (low + high) >> 1;
      range.setStart(node, offset);
      range.setEnd(node, mid);
      const boxes = range.getClientRects();
      const onLine = boxes.length > 0 && boxes[boxes.length - 1].top < top + 1;
      if (onLine) {
        end = mid;
        low = mid + 1;
      } else {
        high = mid - 1;
      }
    }
    if (end > 0 && end < text.length) {
      const prev = text.charCodeAt(end - 1);
      const next = text.charCodeAt(end);
      if (prev >= 0xD800 && prev <= 0xDBFF && next >= 0xDC00 && next <= 0xDFFF) end += 1;
    }
    if (end <= offset) {
      offset += 1;
      continue;
    }
    range.setStart(node, offset);
    range.setEnd(node, end);
    const rect = range.getClientRects()[0];
    if (rect && rect.width > 0) {
      lines.push({
        text: text.slice(offset, end),
        left: rect.left,
        top: rect.top,
        width: rect.width,
        height: rect.height,
      });
    }
    offset = end;
  }
  return lines;
}

function paintUnderline(context, x, y, width, fontSize) {
  const lineY = Math.round(y + fontSize * 0.92) + 0.5;
  context.beginPath();
  context.lineWidth = 1;
  context.moveTo(x, lineY);
  context.lineTo(x + width, lineY);
  context.stroke();
}

function paintText(context, node, origin) {
  const raw = node.textContent;
  if (!raw || !/\S/.test(raw)) return;
  const parent = node.parentElement;
  if (!parent) return;
  const style = getComputedStyle(parent);
  const lines = textLineBoxes(node);
  if (!lines.length) return;
  const spacing = letterSpacingPx(style);
  const fontSize = parsePx(style.fontSize) || 16;
  const ellipsis = style.textOverflow === 'ellipsis' && (style.whiteSpace === 'nowrap' || style.whiteSpace === 'pre');
  const decoration = `${style.textDecorationLine || ''} ${style.webkitTextDecorationsInEffect || ''}`;
  const underline = decoration.includes('underline');
  const parentRect = ellipsis ? parent.getBoundingClientRect() : null;
  const padRight = ellipsis ? parsePx(style.paddingRight) + parsePx(style.borderRightWidth) : 0;
  context.save();
  context.font = canvasFont(style);
  context.fillStyle = visibleColor(style.color) || '#1b2028';
  context.strokeStyle = context.fillStyle;
  context.textBaseline = 'top';
  context.textAlign = 'left';
  for (const line of lines) {
    let text = line.text.replace(/[\r\n]/g, '');
    if (!text.trim()) continue;
    const x = line.left - origin.left;
    const y = lineTextTop(line, fontSize) - origin.top;
    if (ellipsis && parentRect) {
      const maxWidth = parentRect.left + parentRect.width - padRight - line.left;
      text = ellipsize(context, text, Math.max(0, maxWidth), spacing);
    }
    if (!text) continue;
    const width = fillTracked(context, text, x, y, spacing);
    if (underline && width > 0) paintUnderline(context, x, y, width, fontSize);
  }
  context.restore();
}

function markerLabel(node, type) {
  const parent = node.parentElement;
  const siblings = parent ? [...parent.children].filter((child) => child.tagName === 'LI') : [node];
  const index = Math.max(0, siblings.indexOf(node));
  const start = Number.parseInt(parent?.getAttribute('start') || '', 10);
  const value = (Number.isFinite(start) ? start : 1) + index;
  if (type === 'decimal-leading-zero') return `${String(value).padStart(2, '0')}.`;
  return `${value}.`;
}

function firstTextLineBox(node) {
  const walker = document.createTreeWalker(node, NodeFilter.SHOW_TEXT);
  const range = document.createRange();
  let current = walker.nextNode();
  while (current) {
    if (current.textContent && /\S/.test(current.textContent)) {
      range.selectNodeContents(current);
      const rect = range.getClientRects()[0];
      if (rect && rect.height > 0) return rect;
    }
    current = walker.nextNode();
  }
  const rect = node.getBoundingClientRect();
  return rect.height > 0 ? rect : null;
}

function paintListMarker(context, node, origin) {
  const style = getComputedStyle(node);
  const type = style.listStyleType;
  if (!type || type === 'none') return;
  const line = firstTextLineBox(node);
  if (!line) return;
  const fontSize = parsePx(style.fontSize) || 16;
  const textLeft = line.left - origin.left;
  const y = lineTextTop(line, fontSize) - origin.top;
  const gap = Math.max(6, fontSize * 0.4);
  const markerStyle = getComputedStyle(node, '::marker');
  context.save();
  context.font = canvasFont(style);
  context.fillStyle = visibleColor(markerStyle.color) || visibleColor(style.color) || '#1b2028';
  context.textBaseline = 'top';
  if (type === 'disc' || type === 'circle' || type === 'square') {
    const cx = textLeft - gap - fontSize * 0.18;
    const cy = y + fontSize * 0.48;
    context.beginPath();
    if (type === 'square') context.rect(cx - 2.2, cy - 2.2, 4.4, 4.4);
    else context.arc(cx, cy, type === 'circle' ? 2.6 : 2.5, 0, Math.PI * 2);
    if (type === 'circle') {
      context.lineWidth = 1;
      context.strokeStyle = context.fillStyle;
      context.stroke();
    } else context.fill();
    context.restore();
    return;
  }
  if (type !== 'decimal' && type !== 'decimal-leading-zero') {
    context.restore();
    return;
  }
  context.textAlign = 'right';
  context.fillText(markerLabel(node, type), textLeft - gap, y);
  context.restore();
}

function clipsOverflow(style) {
  return [style.overflowX, style.overflowY].some((value) => value && value !== 'visible');
}

function paintTree(context, node, origin) {
  if (node.nodeType === Node.TEXT_NODE) {
    paintText(context, node, origin);
    return;
  }
  if (node.nodeType !== Node.ELEMENT_NODE) return;
  if (!paintBox(context, node, origin)) return;
  if (node.tagName === 'LI') paintListMarker(context, node, origin);
  const style = getComputedStyle(node);
  const clip = clipsOverflow(style);
  if (clip) {
    const rect = node.getBoundingClientRect();
    const top = parsePx(style.borderTopWidth);
    const right = parsePx(style.borderRightWidth);
    const bottom = parsePx(style.borderBottomWidth);
    const left = parsePx(style.borderLeftWidth);
    context.save();
    context.beginPath();
    context.rect(
      rect.left - origin.left + left,
      rect.top - origin.top + top,
      Math.max(0, rect.width - left - right),
      Math.max(0, rect.height - top - bottom),
    );
    context.clip();
  }
  for (const child of node.childNodes) paintTree(context, child, origin);
  if (clip) context.restore();
}

export async function rasterizeElement(element, {
  pixelRatio = 2,
  backgroundColor = '#ffffff',
  maxHeight = SHARE_CARD_MAX_HEIGHT,
} = {}) {
  const width = Math.max(1, Math.ceil(element.offsetWidth || SHARE_CARD_WIDTH));
  const height = Math.max(1, Math.min(Math.ceil(element.offsetHeight || element.scrollHeight), maxHeight));
  const origin = element.getBoundingClientRect();
  const canvas = document.createElement('canvas');
  canvas.width = Math.round(width * pixelRatio);
  canvas.height = Math.round(height * pixelRatio);
  const context = canvas.getContext('2d', { alpha: false });
  if (!context) throw new Error('无法生成 PNG');
  context.fillStyle = backgroundColor;
  context.fillRect(0, 0, canvas.width, canvas.height);
  context.scale(pixelRatio, pixelRatio);
  paintTree(context, element, origin);
  const blob = await new Promise((resolve) => canvas.toBlob(resolve, 'image/png'));
  if (!blob) throw new Error('无法生成 PNG');
  return { blob, previewUrl: makePreviewDataUrl(canvas) };
}

function makePreviewDataUrl(source) {
  const maxWidth = 540;
  const scale = Math.min(1, maxWidth / source.width);
  const preview = document.createElement('canvas');
  preview.width = Math.max(1, Math.round(source.width * scale));
  preview.height = Math.max(1, Math.round(source.height * scale));
  const context = preview.getContext('2d', { alpha: false });
  if (!context) return '';
  context.drawImage(source, 0, 0, preview.width, preview.height);
  return preview.toDataURL('image/jpeg', 0.8);
}

export function downloadBlob(filename, blob) {
  const url = URL.createObjectURL(blob);
  const link = document.createElement('a');
  link.href = url;
  link.download = filename;
  document.body.append(link);
  link.click();
  link.remove();
  window.setTimeout(() => URL.revokeObjectURL(url), 1000);
}

export async function deliverPng(blob, filename, { title } = {}) {
  const file = new File([blob], filename, { type: 'image/png' });
  if (typeof navigator.canShare === 'function' && navigator.canShare({ files: [file] })) {
    try {
      await navigator.share({ files: [file], title: title || 'AI Center' });
      return 'shared';
    } catch (error) {
      if (error?.name === 'AbortError') return 'aborted';
    }
  }
  let copied = false;
  if (navigator.clipboard?.write && globalThis.ClipboardItem) {
    try {
      await navigator.clipboard.write([new ClipboardItem({ 'image/png': blob })]);
      copied = true;
    } catch {
      copied = false;
    }
  }
  downloadBlob(filename, blob);
  return copied ? 'copied' : 'downloaded';
}

export async function exportAskSharePng(card, options = {}) {
  if (!card) throw new Error('没有可分享的问答');
  const { sheet, title } = buildAskShareSheet(card);
  const host = document.createElement('div');
  host.className = 'share-sheet-host';
  host.setAttribute('aria-hidden', 'true');
  host.append(sheet);
  document.body.append(host);
  try {
    if (document.fonts?.ready) {
      await Promise.race([document.fonts.ready, new Promise((resolve) => setTimeout(resolve, 80))]);
    }
    await nextFrame();
    const body = sheet.querySelector('.share-sheet-card');
    if (body && body.scrollHeight > SHARE_CARD_BODY_MAX_HEIGHT) {
      sheet.classList.add('is-truncated');
      sheet.append(Object.assign(document.createElement('p'), {
        className: 'share-sheet-note',
        textContent: '回答较长，图中只截取前半部分',
      }));
      await nextFrame();
    }
    const { blob, previewUrl } = await rasterizeElement(sheet, {
      pixelRatio: Math.min(Number(options.pixelRatio) || window.devicePixelRatio || 2, 2),
      backgroundColor: '#ffffff',
      maxHeight: SHARE_CARD_MAX_HEIGHT,
    });
    const filename = sharePngFilename(title, options.now);
    const delivery = options.deliver === false
      ? 'preview'
      : await deliverPng(blob, filename, { title });
    return { blob, previewUrl, filename, title, delivery };
  } finally {
    host.remove();
  }
}
