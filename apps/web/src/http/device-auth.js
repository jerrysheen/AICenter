export function publicHttpsLocation(request, url, publicBaseUrl) {
  if (!publicBaseUrl || !String(publicBaseUrl).startsWith('https:')) return '';
  let publicHost = '';
  try {
    publicHost = new URL(publicBaseUrl).host.toLowerCase();
  } catch {
    return '';
  }
  const requestHost = String(request.headers['x-forwarded-host'] || url.host || '')
    .split(',')[0]
    .trim()
    .toLowerCase();
  if (!publicHost || requestHost !== publicHost) return '';
  const proto = String(request.headers['x-forwarded-proto'] || '')
    .split(',')[0]
    .trim()
    .toLowerCase();
  if (proto !== 'http') return '';
  const path = `${url.pathname || '/'}${url.search || ''}`;
  return `${String(publicBaseUrl).replace(/\/$/, '')}${path}`;
}
