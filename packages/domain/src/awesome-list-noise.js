const AWESOME_REPO = /^awesome[-_][\w.-]+$/i;
const AWESOME_TITLE = /(?:^|[\s「【（(])awesome[-_][\w.-]+\s*项目更新/iu;

function githubAwesomeRepo(raw) {
  const text = String(raw || '').trim();
  if (!text) return false;
  let url;
  try { url = new URL(text); } catch { return false; }
  const host = url.hostname.replace(/^www\./i, '').toLowerCase();
  if (host !== 'github.com') return false;
  const parts = url.pathname.split('/').filter(Boolean).map((part) => {
    try { return decodeURIComponent(part); } catch { return part; }
  });
  return parts.length >= 2 && AWESOME_REPO.test(parts[1]);
}

export function isAwesomeListUpdateNoise({ title = '', titles = [], sourceUrl = '', urls = [] } = {}) {
  const names = [title, ...(Array.isArray(titles) ? titles : [])];
  for (const value of names) {
    if (AWESOME_TITLE.test(String(value || ''))) return true;
  }
  const links = [sourceUrl, ...(Array.isArray(urls) ? urls : [])];
  for (const value of links) {
    if (githubAwesomeRepo(value)) return true;
  }
  return false;
}
