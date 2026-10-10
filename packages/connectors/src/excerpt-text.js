const NAMED_ENTITIES = Object.freeze({
  amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ',
  hellip: '…', mdash: '—', ndash: '–', rsquo: "'", lsquo: "'", rdquo: '"', ldquo: '"',
});

function safeChar(code) {
  if (!Number.isFinite(code) || code < 0 || code > 0x10ffff || (code >= 0xd800 && code <= 0xdfff)) return '';
  return String.fromCodePoint(code);
}

export function decodeHtmlEntities(value) {
  let text = String(value ?? '');
  for (let pass = 0; pass < 2; pass += 1) {
    const next = text
      .replace(/&#(\d+);/g, (_match, code) => safeChar(Number(code)))
      .replace(/&#x([0-9a-f]+);/gi, (_match, code) => safeChar(Number.parseInt(code, 16)))
      .replace(/&([a-z]+);/gi, (match, name) => {
        const key = name.toLowerCase();
        return Object.prototype.hasOwnProperty.call(NAMED_ENTITIES, key) ? NAMED_ENTITIES[key] : match;
      });
    if (next === text) break;
    text = next;
  }
  return text;
}

const VIDEO_PLAYER_RESIDUE = [
  /your browser (?:does not|doesn't|can't|cannot) support (?:the )?video(?: tag)?\.?/gi,
  /please (?:enable|update) (?:javascript|your browser)[^.]{0,80}video[^.]{0,40}\.?/gi,
  /(?:click|tap) to (?:play|unmute)(?: (?:the )?video)?\.?/gi,
  /\bplay video\b/gi,
  /watch (?:this )?video(?: on youtube)?\.?/gi,
  /video player (?:is )?loading\.?/gi,
  /this video is (?:unavailable|not available)\.?/gi,
  /\bjw ?player\b/gi,
  /enable javascript to (?:view|play)[^.]{0,40}\.?/gi,
  /\[video\]/gi,
  /视频播放器(?:加载中|无法播放|不受支持)?/g,
  /您的浏览器不支持[^。]{0,16}视频[^。]{0,12}。?/g,
  /点击(?:这里)?播放视频/g,
];

export function stripVideoPlayerResidue(value) {
  let text = String(value ?? '');
  for (const pattern of VIDEO_PLAYER_RESIDUE) text = text.replace(pattern, ' ');
  return text;
}

export function cleanIngestExcerpt(value) {
  const withoutTags = String(value ?? '')
    .replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, '$1')
    .replace(/<br\s*\/?>/gi, ' ')
    .replace(/<[^>]+>/g, ' ');
  return stripVideoPlayerResidue(decodeHtmlEntities(withoutTags)).replace(/\s+/g, ' ').trim();
}
