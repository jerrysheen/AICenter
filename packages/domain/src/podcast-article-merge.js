// 播客成稿的合并策略。默认是 A。
//
// A point-compile：每段 2～5 个带细节的事点。Flash 按事点块分批写成若干章，再拼成一篇。
//   短集一批就写完，仍是一次调用。不设成稿字数门槛。
// B chapter-concat：只切章，再把事点按 partIds 接上。Flash 统编失败时用它降级，不再润色一轮。
// C flash-polish：不接。写成环境变量也仍走 A。
// E oneshot：不进这条路径。整集字幕一次灌给模型的做法不在这里。

export const MERGE_CHAPTER_CONCAT = 'chapter-concat';
export const MERGE_POINT_COMPILE = 'point-compile';
export const MERGE_FLASH_POLISH = 'flash-polish';

const CLOCK = /^\d{1,2}:\d{2}(?::\d{2})?$/;

function cleanLine(value, limit) {
  const text = String(value || '').replace(/\s+/g, ' ').trim();
  return limit ? text.slice(0, limit) : text;
}

function chapterHeading(title, start, index) {
  const name = cleanLine(String(title || '').replace(/^#{1,6}\s+/, ''), 80) || `第 ${index + 1} 章`;
  const clock = CLOCK.test(cleanLine(start)) ? cleanLine(start) : '';
  const labeled = clock && !name.includes(clock) ? `${name}（${clock}）` : name;
  return `## ${labeled}`;
}

// 段正文里若自行带了标题，拿掉开头的标题行，章名只留合并时的那一个。
export function segmentProseBody(text) {
  const lines = String(text || '').replace(/\r\n/g, '\n').trim().split('\n');
  while (lines.length && /^#{1,6}\s+\S/.test(lines[0].trim())) {
    lines.shift();
    while (lines.length && !lines[0].trim()) lines.shift();
  }
  return lines.join('\n').replace(/\n{3,}/g, '\n\n').trim();
}

// B：一章一个 ##，可选一行导语，然后是这些段的提炼正文。不另起「章节总结」或译文层。
export function mergeChapterConcat(parts, chapters) {
  const list = Array.isArray(parts) ? parts : [];
  const blocks = [];
  (Array.isArray(chapters) ? chapters : []).forEach((chapter, index) => {
    const heading = chapterHeading(chapter?.title, chapter?.start, index);
    const lines = [heading];
    const lead = cleanLine(chapter?.oneLiner, 80);
    const titleText = heading.replace(/^##\s+/, '');
    if (lead && lead !== titleText) lines.push('', lead);
    let wrote = false;
    for (const id of chapter?.partIds || []) {
      const text = segmentProseBody(list[id]?.translation);
      if (!text) continue;
      lines.push('', text);
      wrote = true;
    }
    if (!wrote && lines.length === 1) lines.push('');
    const block = lines.join('\n').trim();
    if (block) blocks.push(block);
  });
  return blocks.join('\n\n').trim();
}

function plan(id, { ready, flash, merge }) {
  return Object.freeze({ id, ready, flash, merge });
}

// flash 是成功时模型在做什么。A 的成稿由分批统编在本地拼成，不经过 merge。
// merge 只负责 B 的本地拼接。
export const PODCAST_MERGE_DEFAULT = MERGE_POINT_COMPILE;

export const PODCAST_MERGE_PLANS = Object.freeze({
  [MERGE_POINT_COMPILE]: plan(MERGE_POINT_COMPILE, {
    ready: true,
    flash: 'compile',
    merge: mergeChapterConcat,
  }),
  [MERGE_CHAPTER_CONCAT]: plan(MERGE_CHAPTER_CONCAT, {
    ready: true,
    flash: 'chapters',
    merge: mergeChapterConcat,
  }),
  [MERGE_FLASH_POLISH]: plan(MERGE_FLASH_POLISH, {
    ready: false,
    flash: 'polish',
    merge: mergeChapterConcat,
  }),
});

export function podcastMergePlan(strategy) {
  return PODCAST_MERGE_PLANS[strategy] || PODCAST_MERGE_PLANS[PODCAST_MERGE_DEFAULT];
}

export function resolvePodcastMergeRequest(source) {
  const raw = typeof source === 'string'
    ? source.trim()
    : String(source?.AI_CENTER_PODCAST_MERGE ?? '').trim();
  const selected = PODCAST_MERGE_PLANS[raw];
  const pending = Boolean(selected && !selected.ready);
  const plan = selected?.ready ? selected : PODCAST_MERGE_PLANS[PODCAST_MERGE_DEFAULT];
  return {
    requested: pending ? selected.id : '',
    pending,
    plan,
  };
}

export function segmentCompileMaterial(parts) {
  return (Array.isArray(parts) ? parts : []).map((part, index) => {
    const points = (Array.isArray(part?.points) ? part.points : [])
      .map((item) => String(item || '').replace(/\s+/g, ' ').trim())
      .filter(Boolean)
      .slice(0, 5);
    const fallback = String(part?.translation || '').split('\n').map((item) => item.trim()).filter(Boolean).slice(0, 5);
    return {
      i: index,
      start: String(part?.start || ''),
      topic: String(part?.topic || '').trim(),
      points: points.length ? points : fallback,
    };
  });
}

// 一批事点的篇幅。超过就另起一次 Flash，避免一次吞下整集后半被压没。
// 这是输入切分，不是成稿字数门槛。
export const COMPILE_BATCH_MAX_CHARS = 1600;
export const COMPILE_BATCH_MAX_PARTS = 4;

function pointTextChars(item) {
  return (Array.isArray(item?.points) ? item.points : []).join('\n').length;
}

export function compileMaterialBatches(parts, { maxChars = COMPILE_BATCH_MAX_CHARS, maxParts = COMPILE_BATCH_MAX_PARTS } = {}) {
  const items = segmentCompileMaterial(parts);
  if (!items.length) return [];
  const charLimit = Math.max(200, Number(maxChars) || COMPILE_BATCH_MAX_CHARS);
  const partLimit = Math.max(1, Number(maxParts) || COMPILE_BATCH_MAX_PARTS);
  const batches = [];
  let current = [];
  let chars = 0;
  for (const item of items) {
    const size = pointTextChars(item);
    if (current.length && (current.length >= partLimit || chars + size > charLimit)) {
      batches.push(current);
      current = [];
      chars = 0;
    }
    current.push(item);
    chars += size;
  }
  if (current.length) batches.push(current);
  return batches;
}

export function compileBatchKey(batches) {
  return (Array.isArray(batches) ? batches : []).map((batch) => (
    (Array.isArray(batch) ? batch : []).map((item) => Number(item?.i)).join('.')
  )).join(',');
}

export function compilePrompt(parts, title = '', options = {}) {
  const material = Array.isArray(options.material) ? options.material : segmentCompileMaterial(parts);
  const total = Math.max(1, Math.floor(Number(options.total) || 0) || 1);
  const index = Math.min(total, Math.max(1, Math.floor(Number(options.index) || 1)));
  const scope = total > 1
    ? `本批是第 ${index} 批，共 ${total} 批。只写下面这些事点，不要补写没给出的议题。\n\n`
    : '';
  return `选集：${String(title || '').trim()}\n\n${scope}各段事点：\n${JSON.stringify(material)}`;
}

const COMPILE_ANCHOR = /\d+(?:\.\d+)?%|\d+(?:\.\d+)?\s*亿美元|\d+(?:\.\d+)?\s*亿|\b[A-Z]{2,5}\b/g;

// 对照事点里的数字和代码有没有写进正文。只给单集验收看，不作为成稿门槛。
export function compileAnchorCoverage(parts, article) {
  const seen = new Set();
  const anchors = [];
  for (const item of segmentCompileMaterial(parts)) {
    for (const point of item.points) {
      const found = String(point).match(COMPILE_ANCHOR) || [];
      for (const token of found) {
        const key = token.replace(/\s+/g, '');
        if (!key || seen.has(key)) continue;
        seen.add(key);
        anchors.push(key);
      }
    }
  }
  const body = String(article || '').replace(/\s+/g, '');
  const missing = anchors.filter((token) => !body.includes(token));
  return {
    anchors: anchors.length,
    present: anchors.length - missing.length,
    missing: missing.slice(0, 40),
  };
}

// Flash 统编必须是一篇带章的正文。JSON、过短，或又拆出「章节总结 / 对话」，都当失败，交给 B。
export function acceptCompiledArticle(raw) {
  const text = String(raw || '')
    .replace(/^```(?:markdown|md)?\s*/i, '')
    .replace(/\s*```$/i, '')
    .replace(/\r\n/g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
  if (!text || text.startsWith('{') || text.startsWith('[')) return '';
  if (text.includes('### 章节总结') || text.includes('### 对话')) return '';
  const han = (text.match(/\p{Script=Han}/gu) || []).length;
  if (han < 8 || !/^##\s+\S/m.test(text)) return '';
  return text;
}

export function joinCompiledBlocks(blocks) {
  const pieces = [];
  for (const block of Array.isArray(blocks) ? blocks : []) {
    const text = acceptCompiledArticle(block);
    if (!text) return '';
    pieces.push(text);
  }
  if (!pieces.length) return '';
  return acceptCompiledArticle(pieces.join('\n\n'));
}

export function mergeParallelArticle(parts, chapters) {
  return mergeChapterConcat(parts, chapters);
}
