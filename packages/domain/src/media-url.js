// URL identity only. Publisher/channel keys and headlines are not identity evidence.
export function normalizeMediaUrl(value, trackingParams = []) {
  try {
    const url = new URL(value);
    url.hash = '';
    for (const key of [...url.searchParams.keys()]) if (key.startsWith('utm_') || trackingParams.includes(key)) url.searchParams.delete(key);
    return url.toString();
  } catch { return String(value || ''); }
}
