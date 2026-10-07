import { createHash } from 'node:crypto';
import { needsZhLocalization, localizationItemId } from './localize-texts.js';
import { MediaArticleTranslationSchema } from '../../contracts/src/media.js';

const hash = value => createHash('sha256').update(value).digest('hex');

export function mediaTranslationUnits({ externalId, bodyHash, title, paragraphs = [] }) {
  const units = [];
  const all=[{ id: 'title', text: title, kind: 'heading' }, ...paragraphs];
  for (const [index,paragraph] of all.entries()) {
    const text = String(paragraph.text || '').trim();
    for (let start = 0, part = 0; start < text.length; part++) {
      let end = Math.min(start + 2400, text.length);
      if (end < text.length) {
        const boundary=text.lastIndexOf(' ',end);
        if (boundary>start+1200) end=boundary+1;
      }
      if (end < text.length && /[\uD800-\uDBFF]/.test(text[end - 1])) end--;
      const source = text.slice(start, end).trim();
      // Body edits invalidate only the changed block and its adjacent context, not the whole article.
      const context=JSON.stringify([title,all[index-1]?.text?.slice(-240) || '',all[index+1]?.text?.slice(0,240) || '']);
      const id = localizationItemId(`media-block-v2:${externalId}:${hash(source)}:${hash(context)}`);
      const legacyId=localizationItemId(`media-full:${externalId}:${bodyHash}:${hash(title || '')}:${paragraph.id}:${part}`);
      if (source) units.push({ id, legacyId, localizationId: id, paragraphId: paragraph.id, part, kind: paragraph.kind, text: source });
      start = end;
    }
  }
  return units;
}

export function mediaTranslationBatches(units) {
  const batches = [];
  let batch = [], chars = 0;
  for (const unit of units) {
    if (batch.length && (batch.length >= 16 || chars + unit.text.length > 12000)) {
      batches.push(batch); batch = []; chars = 0;
    }
    batch.push(unit); chars += unit.text.length;
  }
  if (batch.length) batches.push(batch);
  return batches;
}

export function projectMediaTranslation(article, saved = []) {
  const units = mediaTranslationUnits(article);
  const byId = new Map(saved.map(row => [row.itemId, row]));
  const groups = new Map();
  let completedChunks = 0, updatedAt = null;
  for (const unit of units) {
    const row = byId.get(unit.id) || byId.get(unit.legacyId);
    const ready = row?.sourceHash === hash(unit.text) && Boolean(row.translatedText);
    const passthrough = !needsZhLocalization(unit.text);
    const text = ready ? row.translatedText : passthrough ? unit.text : '';
    if (text) completedChunks++;
    if (ready) updatedAt = Math.max(updatedAt || 0, row.updatedAt);
    const group = groups.get(unit.paragraphId) || { id: unit.paragraphId, kind: unit.kind, texts: [], complete: true };
    group.texts.push(text); group.complete &&= Boolean(text); groups.set(unit.paragraphId, group);
  }
  const title = groups.get('title');
  return MediaArticleTranslationSchema.parse({
    status: completedChunks === units.length && units.length > 0 ? 'ready' : completedChunks ? 'partial' : 'pending',
    bodyHash: article.bodyHash, snapshotRevision: article.snapshotRevision,
    title: title?.complete ? title.texts.join('') : '',
    paragraphs: [...groups.values()].filter(g => g.id !== 'title' && g.complete).map(g => ({ id: g.id, kind: g.kind, text: g.texts.join('') })),
    completedChunks, totalChunks: units.length, updatedAt,
  });
}
