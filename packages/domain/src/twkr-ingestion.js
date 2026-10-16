export const TWKR_MAX_NEW = 40;

export function ingestTwkrNews(mediaService, workspaceId, source, items, at = Date.now()) {
  const lookbackMs = Math.max(1, Number(source.lookbackHours) || 48) * 60 * 60 * 1000;
  const cutoff = at - lookbackMs;
  const fresh = (items || [])
    .filter((item) => Number.isInteger(item?.publishedAt) && item.publishedAt >= cutoff)
    .sort((left, right) => right.publishedAt - left.publishedAt || String(left.externalId).localeCompare(String(right.externalId)));
  return mediaService.indexExternalItems(workspaceId, source, fresh, at, { maxNew: TWKR_MAX_NEW });
}

export function ingestTwkrRevenue(repository, workspaceId, rows, at = Date.now()) {
  if (!repository?.upsertMany) throw new Error('月营收仓储未就绪');
  return repository.upsertMany(workspaceId, rows || [], at);
}
