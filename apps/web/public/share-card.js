import { paintQr, qrMatrix } from './qr-code.js';

export const SHARE_CARD_MIN_WIDTH = 375;
export const SHARE_CARD_MAX_WIDTH = 540;
export const SHARE_CARD_WIDTH = 540;
export const SHARE_SITE_URL = 'https://tradingplus.cn';
export const SHARE_SITE_LABEL = 'tradingplus.cn';
export const SHARE_SCALE_FLOOR = 1.5;
// One long PNG. Total pixels stay under iOS ~16.7M. Each side stays under 16384,
// or a smaller edge when the device rejects that size.
export const SHARE_CANVAS_LIMITS = {
  maxEdge: 16384,
  maxArea: 16_777_216,
  deviceMaxEdge: 16384,
};

function positive(value, fallback) {
  const number = Number(value);
  return Number.isFinite(number) && number > 0 ? number : fallback;
}

export function canvasLimitBox(limits = SHARE_CANVAS_LIMITS) {
  const cap = positive(limits.maxEdge, 16384);
  const device = positive(limits.deviceMaxEdge, cap);
  return { maxEdge: Math.min(cap, device), maxArea: positive(limits.maxArea, 16_777_216) };
}

export function clampShareScale(devicePixelRatio) {
  const value = Number(devicePixelRatio);
  const ratio = Number.isFinite(value) && value > 0 ? value : 2;
  return Math.min(3, Math.max(2, ratio));
}

function floorScale(value) {
  return Math.floor((value + 1e-9) * 100) / 100;
}

function scaleFits(scale, cssWidth, cssHeight, maxEdge, maxArea) {
  if (!(scale > 0)) return false;
  const pixelWidth = Math.round(cssWidth * scale);
  const pixelHeight = Math.round(cssHeight * scale);
  return pixelWidth <= maxEdge && pixelHeight <= maxEdge && pixelWidth * pixelHeight <= maxArea;
}

export function resolveShareScale(devicePixelRatio, cssWidth, cssHeight, limits = SHARE_CANVAS_LIMITS) {
  const width = Math.max(1, Number(cssWidth) || 1);
  const height = Math.max(1, Number(cssHeight) || 1);
  const { maxEdge, maxArea } = canvasLimitBox(limits);
  const limit = Math.min(
    3,
    maxEdge / width,
    maxEdge / height,
    Math.sqrt(maxArea / (width * height)),
  );
  const preferred = Math.min(clampShareScale(devicePixelRatio), limit);
  const target = preferred >= 2 || limit < SHARE_SCALE_FLOOR
    ? preferred
    : Math.min(limit, Math.max(SHARE_SCALE_FLOOR, preferred));
  let scale = floorScale(target);
  while (scale > 0 && !scaleFits(scale, width, height, maxEdge, maxArea)) {
    scale = floorScale(scale - 0.01);
  }
  return scale > 0 ? scale : target;
}

export function detectMaxCanvasEdge() {
  const cap = SHARE_CANVAS_LIMITS.maxEdge;
  if (typeof document === 'undefined') return cap;
  try {
    const canvas = document.createElement('canvas');
    canvas.width = cap;
    canvas.height = 1;
    const accepted = canvas.width > 0 ? canvas.width : cap;
    return Math.min(cap, accepted);
  } catch {
    return cap;
  }
}

export function sharePngFilename(title, now = new Date()) {
  const stamp = now.toISOString().slice(0, 10);
  const slug = String(title || '问答')
    .replace(/[\\/:*?"<>|\n\r]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 36) || '问答';
  return `aicenter-${slug}-${stamp}.png`;
}

export function formatShareTime(now = new Date()) {
  const date = now instanceof Date ? now : new Date(now);
  if (Number.isNaN(date.getTime())) return '';
  const pad = (value) => String(value).padStart(2, '0');
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())} ${pad(date.getHours())}:${pad(date.getMinutes())}`;
}

export function shareTextBlocks(value) {
  return String(value || '').split(/\n+/).map((line) => line.replace(/[ \t]+/g, ' ').trim()).filter(Boolean);
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

function paintEmbeddedImage(context, node, origin) {
  const rect = node.getBoundingClientRect();
  if (rect.width <= 0 || rect.height <= 0) return;
  if (node.tagName === 'IMG' && !node.complete) return;
  try {
    context.drawImage(node, rect.left - origin.left, rect.top - origin.top, rect.width, rect.height);
  } catch {
    // A broken bitmap should not abort the rest of the card.
  }
}

function paintTree(context, node, origin) {
  if (node.nodeType === Node.TEXT_NODE) {
    paintText(context, node, origin);
    return;
  }
  if (node.nodeType !== Node.ELEMENT_NODE) return;
  if (!paintBox(context, node, origin)) return;
  if (node.tagName === 'CANVAS' || node.tagName === 'IMG') {
    paintEmbeddedImage(context, node, origin);
    return;
  }
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
  limits = SHARE_CANVAS_LIMITS,
} = {}) {
  const width = Math.max(1, Math.ceil(element.offsetWidth || SHARE_CARD_WIDTH));
  const height = Math.max(1, Math.ceil(element.offsetHeight || element.scrollHeight));
  const scale = resolveShareScale(pixelRatio, width, height, limits);
  const origin = element.getBoundingClientRect();
  const canvas = document.createElement('canvas');
  canvas.width = Math.max(1, Math.round(width * scale));
  canvas.height = Math.max(1, Math.round(height * scale));
  const context = canvas.getContext('2d', { alpha: false });
  if (!context) throw new Error('无法生成 PNG');
  context.fillStyle = backgroundColor;
  context.fillRect(0, 0, canvas.width, canvas.height);
  context.scale(scale, scale);
  paintTree(context, element, origin);
  const blob = await new Promise((resolve) => canvas.toBlob(resolve, 'image/png'));
  if (!blob) throw new Error('无法生成 PNG');
  return { blob, previewUrl: makePreviewDataUrl(canvas), scale, width, height };
}

function makePreviewDataUrl(source) {
  try {
    return source.toDataURL('image/png');
  } catch {
    return '';
  }
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

export async function deliverShareFiles(pages, { title } = {}) {
  const files = (pages || []).map((page) => new File([page.blob], page.filename, { type: 'image/png' }));
  const nav = globalThis.navigator;
  try {
    if (files.length && typeof File !== 'undefined' && nav && typeof nav.canShare === 'function' && nav.canShare({ files })) {
      await nav.share({ files, title: title || 'TradingPlus' });
      return 'shared';
    }
  } catch (error) {
    if (error?.name === 'AbortError') return 'aborted';
  }
  return 'preview';
}

export async function deliverPng(blob, filename, { title } = {}) {
  return deliverShareFiles([{ blob, filename }], { title });
}

function shareBlocks(input) {
  const blocks = [];
  for (const paragraph of input.paragraphs || []) {
    const text = String(paragraph || '').trim();
    if (!text) continue;
    const node = document.createElement('p');
    node.className = 'share-sheet-paragraph';
    node.textContent = text;
    blocks.push(node);
  }
  const points = (input.points || []).map((point) => String(point || '').trim()).filter(Boolean);
  if (points.length) {
    const list = document.createElement('ul');
    list.className = 'share-sheet-points';
    for (const point of points) {
      list.append(Object.assign(document.createElement('li'), { textContent: point }));
    }
    blocks.push(list);
  }
  return blocks;
}

function mountQr(canvas, url) {
  const css = 88;
  const ratio = 4;
  canvas.width = css * ratio;
  canvas.height = css * ratio;
  canvas.className = 'share-card-qr';
  const context = canvas.getContext('2d', { alpha: false });
  if (!context) return;
  paintQr(context, qrMatrix(url || SHARE_SITE_URL), 0, 0, canvas.width, 4);
}

function buildShareSheet(input, blockNodes) {
  const sheet = document.createElement('article');
  sheet.className = 'share-sheet';
  const head = document.createElement('header');
  head.className = 'share-sheet-head';
  const title = document.createElement('h1');
  title.className = 'share-sheet-question';
  title.textContent = String(input.title || '分享').trim() || '分享';
  const metaText = [input.source, input.time].map((part) => String(part || '').trim()).filter(Boolean).join(' · ');
  head.append(title);
  if (metaText) {
    const meta = document.createElement('p');
    meta.className = 'share-sheet-meta';
    meta.textContent = metaText;
    head.append(meta);
  }
  const body = document.createElement('div');
  body.className = 'share-sheet-body';
  for (const node of blockNodes) body.append(node);
  const foot = document.createElement('footer');
  foot.className = 'share-sheet-foot';
  const brand = document.createElement('div');
  brand.className = 'share-sheet-brandbox';
  brand.append(
    Object.assign(document.createElement('strong'), { className: 'share-sheet-brand', textContent: 'TradingPlus' }),
    Object.assign(document.createElement('span'), { className: 'share-sheet-url', textContent: SHARE_SITE_LABEL }),
  );
  const qr = document.createElement('canvas');
  mountQr(qr, input.url || SHARE_SITE_URL);
  foot.append(brand, qr);
  sheet.append(head, body, foot);
  return sheet;
}

function mountHost(node) {
  const host = document.createElement('div');
  host.className = 'share-sheet-host';
  host.setAttribute('aria-hidden', 'true');
  host.append(node);
  document.body.append(host);
  return host;
}

async function settleLayout() {
  if (document.fonts?.ready) {
    await Promise.race([document.fonts.ready, new Promise((resolve) => setTimeout(resolve, 80))]);
  }
  await nextFrame();
}

export function askExchangeShareInput(card, now = new Date()) {
  let title = card?.querySelector?.('.ask-question')?.textContent?.replace(/\s+/g, ' ').trim() || '问答';
  const answer = card?.querySelector?.('.ask-answer');
  const paragraphs = [];
  if (answer) {
    const blocks = [...answer.querySelectorAll('p, li, h1, h2, h3, h4, pre, blockquote')];
    for (const block of blocks) {
      if (blocks.some((other) => other !== block && other.contains(block))) continue;
      const text = block.textContent.replace(/\s+/g, ' ').trim();
      if (text) paragraphs.push(text);
    }
    if (!paragraphs.length) paragraphs.push(...shareTextBlocks(answer.textContent));
  }
  if (title.length > 120) {
    paragraphs.unshift(title);
    title = `${title.slice(0, 80)}…`;
  }
  const source = card?.querySelector?.('.ask-source-footer')?.textContent?.replace(/\s+/g, ' ').trim();
  return {
    title,
    source: source || 'AI 问答',
    time: formatShareTime(now),
    paragraphs,
    url: SHARE_SITE_URL,
  };
}

export async function exportShareCard(input, options = {}) {
  const card = {
    title: String(input?.title || '分享').trim() || '分享',
    source: String(input?.source || '').trim(),
    time: String(input?.time || '').trim(),
    paragraphs: input?.paragraphs || [],
    points: input?.points || [],
    url: input?.url || SHARE_SITE_URL,
  };
  if (!card.title && !card.paragraphs.length && !card.points.length) throw new Error('没有可分享的内容');
  const sheet = buildShareSheet(card, shareBlocks(card));
  const host = mountHost(sheet);
  try {
    await settleLayout();
    const limits = { ...SHARE_CANVAS_LIMITS, ...(options.limits || {}) };
    if (!options.limits || options.limits.deviceMaxEdge == null) {
      limits.deviceMaxEdge = options.maxEdge || detectMaxCanvasEdge();
    }
    const ratio = Number(options.pixelRatio) || globalThis.devicePixelRatio || 2;
    const rendered = await rasterizeElement(sheet, {
      pixelRatio: ratio,
      backgroundColor: '#ffffff',
      limits,
    });
    const file = {
      ...rendered,
      filename: sharePngFilename(card.title, options.now),
    };
    const delivery = options.deliver === false
      ? 'preview'
      : await deliverShareFiles([file], { title: card.title });
    return {
      title: card.title,
      blob: file.blob,
      previewUrl: file.previewUrl,
      filename: file.filename,
      pages: [file],
      scale: file.scale,
      delivery,
    };
  } finally {
    host.remove();
  }
}

export async function exportAskSharePng(card, options = {}) {
  if (!card) throw new Error('没有可分享的问答');
  return exportShareCard(askExchangeShareInput(card, options.now), options);
}
