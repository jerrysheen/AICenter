// Official titles arrive after the list. A later empty snapshot must not
// wipe a translation that already came back, and the reader must use the
// same ready title as the list.

export const OFFICIAL_LOCALIZATION_REFRESH_DELAYS_MS = Object.freeze([2_000, 4_000, 8_000, 15_000, 30_000, 60_000]);

function rowText(row) {
  return String(row?.text || '').trim();
}

export function readyLocalizationTitle(text) {
  const value = String(text || '').trim();
  if (!value || value === '正在翻译…' || value === '无标题' || value === '暂未翻译') return '';
  if (!/\p{Script=Han}/u.test(value)) return '';
  return value;
}

export function localizationStillOpen(row) {
  if (!row || typeof row !== 'object') return false;
  if (rowText(row)) return false;
  return row.pending === true || row.status === 'pending';
}

export function localizationMissingTitle(row) {
  if (!row || typeof row !== 'object') return false;
  if (rowText(row)) return false;
  return row.pending === true || row.status === 'pending' || row.status === 'failed';
}

export function nextOfficialLocalizationRefresh(attempt, delays = OFFICIAL_LOCALIZATION_REFRESH_DELAYS_MS) {
  const index = Number(attempt) || 0;
  if (index < 0 || index >= delays.length) return 0;
  return delays[index];
}

function sameLocalization(left, right) {
  return rowText(left) === rowText(right)
    && left?.status === right?.status
    && Boolean(left?.pending) === Boolean(right?.pending)
    && String(left?.engine || '') === String(right?.engine || '');
}

function writeLocalization(next, key, row, mark) {
  if (!key || !row || typeof row !== 'object') return;
  const prev = next[key];
  const prevText = rowText(prev);
  const incomingText = rowText(row);
  if (prevText && !incomingText) return;
  const merged = {
    ...(prev || {}),
    ...row,
    text: incomingText || prevText,
  };
  if (prev && sameLocalization(prev, merged)) return;
  next[key] = merged;
  mark.changed = true;
}

// Ready text stays when a stale or in-flight snapshot still has an empty row.
// A newer non-empty translation still replaces the previous one.
export function mergeLocalizationMap(current, incoming) {
  const base = current && typeof current === 'object' && !Array.isArray(current) ? current : {};
  const rows = incoming && typeof incoming === 'object' && !Array.isArray(incoming) ? incoming : null;
  if (!rows) return base;
  const next = { ...base };
  const mark = { changed: false };
  for (const [key, row] of Object.entries(rows)) writeLocalization(next, key, row, mark);
  for (const row of Object.values(rows)) {
    if (row?.id && next[row.id] == null) writeLocalization(next, row.id, row, mark);
  }
  return mark.changed ? next : base;
}

export function articleTitle({ lang = 'translation', localized = '', displayed = '', original = '' } = {}) {
  if (lang === 'original') {
    const source = String(original || '').trim() || String(displayed || '').trim();
    return source || '无标题';
  }
  const live = String(localized || '').trim();
  if (live === '正在翻译…') return live;
  const ready = readyLocalizationTitle(live);
  if (ready) return ready;
  const shown = String(displayed || '').trim();
  return shown || '无标题';
}
