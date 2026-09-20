import { createHash } from 'node:crypto';

export const ATTACHMENT_MAX_BYTES = 8 * 1024 * 1024;
export const ATTACHMENT_MAX_COUNT = 4;

export function sniffImageMime(bytes) {
  if (!Buffer.isBuffer(bytes) || bytes.length < 12) return '';
  if (bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) return 'image/jpeg';
  if (bytes[0] === 0x89 && bytes[1] === 0x50 && bytes[2] === 0x4e && bytes[3] === 0x47) return 'image/png';
  if (bytes[0] === 0x47 && bytes[1] === 0x49 && bytes[2] === 0x46 && bytes[3] === 0x38) return 'image/gif';
  if (
    bytes[0] === 0x52 && bytes[1] === 0x49 && bytes[2] === 0x46 && bytes[3] === 0x46
    && bytes[8] === 0x57 && bytes[9] === 0x45 && bytes[10] === 0x42 && bytes[11] === 0x50
  ) return 'image/webp';
  return '';
}

export function decodeAttachmentData(value) {
  const raw = String(value || '').trim();
  if (!raw) return Buffer.alloc(0);
  const comma = raw.indexOf(',');
  const payload = raw.startsWith('data:') && comma > 0 ? raw.slice(comma + 1) : raw;
  return Buffer.from(payload, 'base64');
}

export function attachmentSha256(bytes) {
  return createHash('sha256').update(bytes).digest('hex');
}

export function projectAttachment(record) {
  if (!record) return null;
  return {
    id: record.id,
    mime: record.mime,
    originalName: record.originalName || '',
    byteSize: record.byteSize,
    createdAt: record.createdAt,
    url: `/api/v1/attachments/${record.id}/content`,
  };
}

export function normalizeAttachmentIds(value) {
  const seen = new Set();
  const ids = [];
  for (const item of Array.isArray(value) ? value : []) {
    const id = String(item || '').trim();
    if (!id || seen.has(id)) continue;
    seen.add(id);
    ids.push(id);
    if (ids.length >= ATTACHMENT_MAX_COUNT) break;
  }
  return ids;
}
