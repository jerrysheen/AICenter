const DEFAULT_HEADERS = {
  'User-Agent':
    'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/123.0.0.0 Safari/537.36',
  Referer: 'https://www.bilibili.com',
};

export async function getJson(url, timeoutMs = 15_000) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetch(url, { headers: DEFAULT_HEADERS, signal: controller.signal, redirect: 'follow' });
    const payload = await response.text();
    if (!response.ok) throw new Error(`HTTP ${response.status} for ${url}: ${payload.slice(0, 500)}`);
    try {
      return JSON.parse(payload);
    } catch {
      throw new Error(`Invalid JSON from ${url}: ${payload.slice(0, 500)}`);
    }
  } catch (error) {
    if (error.name === 'AbortError') throw new Error(`Request timed out for ${url}`);
    throw error;
  } finally {
    clearTimeout(timer);
  }
}

export async function resolveRedirectUrl(url, timeoutMs = 12_000) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetch(url, {
      headers: DEFAULT_HEADERS,
      signal: controller.signal,
      redirect: 'follow',
    });
    return response.url || url;
  } finally {
    clearTimeout(timer);
  }
}
