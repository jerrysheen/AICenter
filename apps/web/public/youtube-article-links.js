export function youtubeVideoId(url) {
  const value = String(url || '').trim();
  if (!value) return '';
  let parsed;
  try {
    parsed = new URL(value);
  } catch {
    return '';
  }
  const host = parsed.hostname.toLowerCase().replace(/^www\./, '');
  let id = '';
  if (host === 'youtu.be') id = parsed.pathname.split('/').filter(Boolean)[0] || '';
  else if (host === 'youtube.com' || host === 'm.youtube.com' || host === 'music.youtube.com' || host === 'youtube-nocookie.com') {
    if (parsed.pathname === '/watch') id = parsed.searchParams.get('v') || '';
    else {
      const embed = parsed.pathname.match(/^\/(?:shorts|embed|live|v)\/([^/?#]+)/);
      if (embed) id = embed[1];
    }
  }
  try {
    id = decodeURIComponent(id);
  } catch {
    return '';
  }
  return /^[A-Za-z0-9_-]{6,}$/.test(id) ? id : '';
}

export function youtubeWatchUrl(videoId, seconds = null) {
  const id = String(videoId || '').trim();
  if (!/^[A-Za-z0-9_-]{6,}$/.test(id)) return '';
  const base = `https://www.youtube.com/watch?v=${encodeURIComponent(id)}`;
  if (seconds == null || seconds === '') return base;
  const t = Number(seconds);
  if (!Number.isFinite(t) || t < 0) return base;
  return `${base}&t=${Math.floor(t)}`;
}

export function clockToSeconds(clock) {
  const raw = String(clock || '').trim();
  if (!/^\d{1,2}:\d{2}(?::\d{2})?$/.test(raw)) return null;
  const parts = raw.split(':').map((item) => Number(item));
  const [hour, minute, second] = parts.length === 2 ? [0, parts[0], parts[1]] : parts;
  if (minute > 59 || second > 59 || hour > 99) return null;
  return hour * 3600 + minute * 60 + second;
}

const HEADING_CLOCK = /^(.*?)([（(])\s*(\d{1,2}:\d{2}(?::\d{2})?)\s*([)）])\s*$/;

export function parseHeadingTimestamp(text) {
  const value = String(text || '').replace(/\s+/g, ' ').trim();
  const match = value.match(HEADING_CLOCK);
  if (!match) return null;
  const seconds = clockToSeconds(match[3]);
  if (seconds == null) return null;
  return {
    topic: match[1].trim(),
    clock: match[3],
    seconds,
    before: `${match[1]}${match[2]}`,
    after: match[4],
  };
}

export function headingTimeHref(videoId, text) {
  const parsed = parseHeadingTimestamp(text);
  if (!parsed) return '';
  return youtubeWatchUrl(videoId, parsed.seconds);
}

export function attachYoutubeHeadingTimes(container, videoId, { onOpen } = {}) {
  if (!container || !videoId || typeof container.querySelectorAll !== 'function') return 0;
  let count = 0;
  for (const heading of container.querySelectorAll('h1, h2, h3, h4')) {
    if (typeof heading.querySelector === 'function' && heading.querySelector('a.youtube-time')) continue;
    const parsed = parseHeadingTimestamp(heading.textContent || '');
    if (!parsed) continue;
    const href = youtubeWatchUrl(videoId, parsed.seconds);
    if (!href) continue;
    const link = document.createElement('a');
    link.className = 'youtube-time';
    link.href = href;
    link.target = '_blank';
    link.rel = 'noopener noreferrer';
    link.textContent = parsed.clock;
    link.dataset.youtubeSeconds = String(parsed.seconds);
    link.setAttribute('aria-label', `原帖 ${parsed.clock}`);
    if (onOpen) {
      link.addEventListener('click', (event) => onOpen(href, event));
    }
    if (typeof heading.replaceChildren === 'function') heading.replaceChildren();
    if (parsed.before) heading.append(document.createTextNode(parsed.before));
    heading.append(link);
    if (parsed.after) heading.append(document.createTextNode(parsed.after));
    count += 1;
  }
  return count;
}
