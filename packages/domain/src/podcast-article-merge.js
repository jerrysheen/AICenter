// 播客成稿的合并策略。默认是 A。
//
// A point-compile：每段 2～5 个带细节的事点，Flash 一次按主题统编成一篇长文。
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

// flash 是成功时那一次模型在做什么。merge 只负责 B 的本地拼接。
// point-compile 的成稿是 Flash 返回的长文，不经过 merge。
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

export function compilePrompt(parts, title = '') {
  return `选集：${String(title || '').trim()}\n\n各段事点：\n${JSON.stringify(segmentCompileMaterial(parts))}`;
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

export function mergeParallelArticle(parts, chapters) {
  return mergeChapterConcat(parts, chapters);
}
