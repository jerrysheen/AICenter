// 播客成稿的合并策略。段产出已经定成「通顺提炼正文」；怎么合成一篇还在离线试跑。
//
// A point-compile：段内多事点，再由 Flash 统编成文。段契约和本文件不同，试跑前不接。
// B chapter-concat：Flash 只切章（title / start / partIds / 可选一行导语），各段正文按 partIds 首尾相接。当前默认。
// C flash-polish：各段提炼正文交给 Flash 统编润色。会换成另一次整篇生成，试跑前不接。
//
// 未就绪的策略即使写进 AI_CENTER_PODCAST_MERGE，也仍用 B，避免误打第二轮模型。

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

// flash 是这一策略将来要的那一次模型角色。ready 为 false 时任务仍走 chapters，不发 polish / compile。
export const PODCAST_MERGE_PLANS = Object.freeze({
  [MERGE_CHAPTER_CONCAT]: plan(MERGE_CHAPTER_CONCAT, {
    ready: true,
    flash: 'chapters',
    merge: mergeChapterConcat,
  }),
  [MERGE_POINT_COMPILE]: plan(MERGE_POINT_COMPILE, {
    ready: false,
    flash: 'compile',
    merge: mergeChapterConcat,
  }),
  [MERGE_FLASH_POLISH]: plan(MERGE_FLASH_POLISH, {
    ready: false,
    flash: 'polish',
    merge: mergeChapterConcat,
  }),
});

export function podcastMergePlan(strategy) {
  return PODCAST_MERGE_PLANS[strategy] || PODCAST_MERGE_PLANS[MERGE_CHAPTER_CONCAT];
}

export function resolvePodcastMergeRequest(source) {
  const raw = typeof source === 'string'
    ? source.trim()
    : String(source?.AI_CENTER_PODCAST_MERGE ?? '').trim();
  const selected = PODCAST_MERGE_PLANS[raw];
  const pending = Boolean(selected && !selected.ready);
  const plan = selected?.ready ? selected : PODCAST_MERGE_PLANS[MERGE_CHAPTER_CONCAT];
  return {
    requested: pending ? selected.id : '',
    pending,
    plan,
  };
}

export function mergeParallelArticle(parts, chapters, strategy = MERGE_CHAPTER_CONCAT) {
  const selected = podcastMergePlan(strategy);
  const active = selected.ready ? selected : PODCAST_MERGE_PLANS[MERGE_CHAPTER_CONCAT];
  return active.merge(parts, chapters);
}
