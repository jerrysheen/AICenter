export const BODY_COMPLETION_MAX_ATTEMPTS = 3;
export const BODY_COMPLETION_MAX_AGE_MS = 24 * 60 * 60 * 1000;

function metadataOf(previous) {
  return previous && typeof previous === 'object' && !Array.isArray(previous) ? previous : {};
}

function priorAttempts(metadata, wasPending) {
  const stored = Number(metadata.bodyCompletionAttempts);
  if (Number.isInteger(stored) && stored > 0) return stored;
  return wasPending ? 1 : 0;
}

function priorSince(metadata, wasPending, now) {
  const stored = Number(metadata.bodyCompletionSince);
  if (Number.isFinite(stored) && stored > 0) return stored;
  const evaluated = Number(metadata.filterEvaluatedAt);
  if (wasPending && Number.isFinite(evaluated) && evaluated > 0) return evaluated;
  const captured = Number(metadata.capturedAt);
  if (wasPending && Number.isFinite(captured) && captured > 0) return captured;
  return now;
}

// A truncated KEEP stays pending so the next sync can fetch the rest of the body.
// The third observation, or 24 hours from the first, drops the marker and leaves the decision alone.
export function resolveBodyCompletion(previous, { truncated = false, now = Date.now() } = {}) {
  const metadata = metadataOf(previous);
  if (!truncated) {
    const idle = metadata.bodyCompletion !== 'pending'
      && !Number(metadata.bodyCompletionAttempts)
      && !Number(metadata.bodyCompletionSince);
    return {
      bodyCompletion: '',
      bodyCompletionAttempts: 0,
      bodyCompletionSince: 0,
      exhausted: false,
      unchanged: idle,
    };
  }
  const wasPending = metadata.bodyCompletion === 'pending';
  const attemptsSoFar = priorAttempts(metadata, wasPending);
  const since = priorSince(metadata, wasPending, now);
  const gaveUp = !wasPending && attemptsSoFar >= BODY_COMPLETION_MAX_ATTEMPTS;
  if (gaveUp) {
    return {
      bodyCompletion: '',
      bodyCompletionAttempts: attemptsSoFar,
      bodyCompletionSince: since,
      exhausted: true,
      unchanged: true,
    };
  }
  const attempts = attemptsSoFar + 1;
  const aged = since > 0 && now - since >= BODY_COMPLETION_MAX_AGE_MS;
  const exhausted = attempts >= BODY_COMPLETION_MAX_ATTEMPTS || aged;
  return {
    bodyCompletion: exhausted ? '' : 'pending',
    bodyCompletionAttempts: attempts,
    bodyCompletionSince: since,
    exhausted,
    unchanged: false,
  };
}

export function bodyCompletionFields(previous, options) {
  const next = resolveBodyCompletion(previous, options);
  return {
    bodyCompletion: next.bodyCompletion,
    bodyCompletionAttempts: next.bodyCompletionAttempts,
    bodyCompletionSince: next.bodyCompletionSince,
  };
}
