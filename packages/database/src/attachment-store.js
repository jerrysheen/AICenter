import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';

const MIME_EXTENSION = Object.freeze({
  'image/jpeg': 'jpg',
  'image/png': 'png',
  'image/webp': 'webp',
  'image/gif': 'gif',
});

export function createAttachmentStore({ dataDirectory } = {}) {
  const root = path.resolve(dataDirectory || process.cwd());

  function resolveRelative(relativePath) {
    const normalized = String(relativePath || '').replaceAll('\\', '/').replace(/^\/+/, '');
    if (!normalized.startsWith('blobs/attachments/')) {
      throw new Error('附件路径无效');
    }
    if (normalized.includes('..')) throw new Error('附件路径无效');
    const absolute = path.resolve(root, normalized);
    const prefix = `${root}${path.sep}`;
    if (absolute !== root && !absolute.startsWith(prefix)) {
      throw new Error('附件路径越界');
    }
    return absolute;
  }

  return Object.freeze({
    write({ id, mime, bytes }) {
      const ext = MIME_EXTENSION[mime];
      if (!ext) throw new Error('不支持的图片类型');
      const relativePath = `blobs/attachments/${id}.${ext}`;
      const absolute = resolveRelative(relativePath);
      mkdirSync(path.dirname(absolute), { recursive: true });
      writeFileSync(absolute, bytes);
      return relativePath;
    },
    read(relativePath) {
      return readFileSync(resolveRelative(relativePath));
    },
    resolveAbsolute(relativePath) {
      return resolveRelative(relativePath);
    },
  });
}
