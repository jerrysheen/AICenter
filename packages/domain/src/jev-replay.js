import { decideFeedAdmissionFallback } from './feed-filter.js';
import { createFeedValueEvaluator, normalizeFeedValueText, FEED_VALUE_RULE } from './feed-value.js';

export function heldCaptureInput(capture = {}) {
  const metadata = capture.metadata && typeof capture.metadata === 'object' ? capture.metadata : {};
  return {
    provider: capture.provider,
    sourceExternalId: capture.sourceExternalId || '',
    originalText: metadata.originalText || '',
    item: {
      provider: capture.provider,
      title: capture.title || '',
      body: metadata.originalText || capture.title || '',
      xFocus: metadata.xFocus,
      sourceExternalId: capture.sourceExternalId || '',
    },
  };
}

export async function admitHeldCapture({ feedRepository, capture, reason, enqueueTranslation } = {}) {
  const metadata = {
    ...(capture.metadata || {}),
    filterDecision: 'KEEP',
    filterReason: reason,
    filterApplied: false,
    filterMode: capture.metadata?.filterMode || 'enforce',
    filterRule: capture.metadata?.filterRule || 'all-three-0.60',
    filterReviewKind: 'none',
    fallbackAt: new Date().toISOString(),
    filterErrorCode: capture.metadata?.filterErrorCode || '',
    filterErrorStatus: capture.metadata?.filterErrorStatus ?? null,
  };
  const saved = feedRepository.saveCapture({
    id: capture.id,
    workspaceId: capture.workspaceId,
    provider: capture.provider,
    externalId: capture.externalId,
    sourceAccountId: capture.sourceAccountId || null,
    sourceUrl: capture.sourceUrl || '',
    title: capture.title || '',
    contentHash: capture.contentHash,
    rawArtifactPath: capture.rawArtifactPath || null,
    status: 'ready',
    publishedAt: capture.publishedAt || null,
    capturedAt: capture.capturedAt,
    authorNativeId: capture.authorNativeId || null,
    metadata,
  });
  const item = feedRepository.saveContentItem({
    workspaceId: capture.workspaceId,
    captureId: saved.id,
    originType: 'subscription',
    contentType: 'post',
    title: capture.title || '',
    body: capture.metadata?.originalText || capture.title || '',
    summary: '',
    sourceUrl: capture.sourceUrl || '',
    authorName: capture.metadata?.authorProfile?.name || '',
    publishedAt: capture.publishedAt || null,
  });
  if (enqueueTranslation) await enqueueTranslation(saved, item);
  return { capture: saved, item };
}

export async function reevaluateHeldCaptures({
  captures = [],
  mode = 'fallback',
  jevEnabled = true,
  xFocusConfig = null,
  xFocusMin = 0.7,
  evaluator = null,
  dryRun = false,
  onKeep,
  prefix = '',
} = {}) {
  const useJev = mode === 'jev' && jevEnabled === true && evaluator;
  const reasonPrefix = prefix || (jevEnabled === false ? 'jev-disabled' : 'fallback');
  const results = [];
  for (const capture of captures) {
    if (useJev) {
      const input = normalizeFeedValueText(capture.metadata?.originalText || capture.title || '', {
        title: capture.title || '',
        authorName: capture.metadata?.authorProfile?.name || '',
        capture: capture.metadata?.captureContext || {},
      });
      const result = await evaluator.evaluate(input);
      if (result.decision?.decision === 'KEEP' && !result.errorReason) {
        if (!dryRun && onKeep) await onKeep(capture, result.decision.reason || 'qualified', result);
        results.push({ externalId: capture.externalId, action: 'keep', reason: result.decision.reason || 'qualified' });
      } else {
        results.push({
          externalId: capture.externalId,
          action: 'hold',
          reason: result.errorReason || result.decision?.reason || 'jev-failed',
        });
      }
      continue;
    }
    const admission = decideFeedAdmissionFallback(heldCaptureInput(capture), {
      xFocusConfig,
      xFocusMin,
      prefix: reasonPrefix,
    });
    if (!admission.admit) {
      results.push({
        externalId: capture.externalId,
        action: 'hold',
        reason: jevEnabled === false ? 'jev-disabled' : (capture.metadata?.filterReason || 'jev-failed'),
      });
      continue;
    }
    if (!dryRun && onKeep) await onKeep(capture, admission.reason);
    results.push({ externalId: capture.externalId, action: 'keep', reason: admission.reason });
  }
  return results;
}

export function createReplayEvaluator(client, model = '') {
  if (!client) return null;
  return createFeedValueEvaluator({ client, model: model || client.modelId || '', rule: FEED_VALUE_RULE });
}
