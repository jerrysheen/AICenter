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
  return `${style.fontStyle} ${style.fontWeight} ${style.fontSize} "Microsoft YaHei","PingFang SC","Noto Sans SC",sans-serif`;
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

function paintBox(context, node, origin) {
  const style = getComputedStyle(node);
  if (style.display === 'none' || style.visibility === 'hidden' || Number(style.opacity) === 0) {
    return false;
  }
  const fill = visibleColor(style.backgroundColor);
  const border = parsePx(style.borderTopWidth);
  const borderColor = visibleColor(style.borderTopColor);
  const isList = node.tagName === 'LI' && style.listStyleType && style.listStyleType !== 'none';
  if (!fill && !(border && borderColor && style.borderTopStyle !== 'none') && !isList) {
    return true;
  }
  const rect = node.getBoundingClientRect();
  const x = rect.left - origin.left;
  const y = rect.top - origin.top;
  if (rect.width <= 0 || rect.height <= 0) return true;
  const radius = parsePx(style.borderTopLeftRadius);
  if (fill) {
    context.fillStyle = fill;
    pathRoundRect(context, x, y, rect.width, rect.height, radius);
    context.fill();
  }
  if (border && borderColor && style.borderTopStyle !== 'none') {
    context.lineWidth = border;
    context.strokeStyle = borderColor;
    pathRoundRect(
      context,
      x + border / 2,
      y + border / 2,
      Math.max(0, rect.width - border),
      Math.max(0, rect.height - border),
      Math.max(0, radius - border / 2),
    );
    context.stroke();
  }
  if (isList) {
    context.fillStyle = visibleColor(style.color) || '#1b2028';
    const bulletX = x - 12;
    const bulletY = y + parsePx(style.lineHeight || style.fontSize) * 0.55;
    context.beginPath();
    context.arc(bulletX, bulletY, 2.4, 0, Math.PI * 2);
    context.fill();
  }
  return true;
}

function paintText(context, node, origin) {
  const text = node.textContent;
  if (!text || !/\S/.test(text)) return;
  const parent = node.parentElement;
  if (!parent) return;
  const style = getComputedStyle(parent);
  context.fillStyle = visibleColor(style.color) || '#1b2028';
  context.font = canvasFont(style);
  context.textBaseline = 'top';
  const range = document.createRange();
  range.selectNodeContents(node);
  const rects = range.getClientRects();
  if (!rects.length) return;
  const x = rects[0].left - origin.left;
  const y = rects[0].top - origin.top;
  if (rects.length === 1) {
    context.fillText(text, x, y);
    return;
  }
  const lineHeight = rects[1].top - rects[0].top || parsePx(style.fontSize) * 1.55;
  const maxWidth = Math.max(...Array.from(rects, (box) => box.width));
  let line = 0;
  let current = '';
  for (const char of text) {
    if (char === '\n') {
      if (current) context.fillText(current, x, y + line * lineHeight);
      current = '';
      line += 1;
      continue;
    }
    const next = current + char;
    if (current && context.measureText(next).width > maxWidth + 1) {
      context.fillText(current, x, y + line * lineHeight);
      current = char;
      line += 1;
    } else {
      current = next;
    }
  }
  if (current) context.fillText(current, x, y + line * lineHeight);
}

function paintTree(context, node, origin) {
  if (node.nodeType === Node.TEXT_NODE) {
    paintText(context, node, origin);
    return;
  }
  if (node.nodeType !== Node.ELEMENT_NODE) return;
  if (!paintBox(context, node, origin)) return;
  for (const child of node.childNodes) paintTree(context, child, origin);
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
