const NAMED = [
  [/&nbsp;/gi, ' '],
  [/&hellip;/gi, '…'],
  [/&mdash;/gi, '—'],
  [/&ndash;/gi, '–'],
  [/&quot;/gi, '"'],
  [/&#0*39;|&apos;/gi, "'"],
  [/&lt;/gi, '<'],
  [/&gt;/gi, '>'],
];

export function decodeHtmlEntities(value) {
  let text = String(value ?? '');
  if (!text.includes('&')) return text;
  for (let pass = 0; pass < 2; pass += 1) {
    let next = text;
    for (const [pattern, replacement] of NAMED) next = next.replace(pattern, replacement);
    next = next.replace(/&#(\d+);/g, (match, digits) => {
      const code = Number(digits);
      try { return String.fromCodePoint(code); } catch { return match; }
    });
    next = next.replace(/&#x([0-9a-f]+);/gi, (match, digits) => {
      const code = Number.parseInt(digits, 16);
      try { return String.fromCodePoint(code); } catch { return match; }
    });
    next = next.replace(/&amp;/gi, '&');
    if (next === text) break;
    text = next;
  }
  return text;
}
