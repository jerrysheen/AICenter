// Translation jobs retry with a capped exponential delay, then stay failed.
export const TRANSLATION_MAX_ATTEMPTS = 4;
export const TRANSLATION_CHUNK_FAIL_LIMIT = 3;
export const TRANSLATION_CHUNK_FAIL_TTL_MS = 24 * 60 * 60 * 1000;
export const TRANSLATION_RETRY_BASE_MS = 1_000;
export const TRANSLATION_RETRY_MAX_MS = 5 * 60_000;

export function translationRetryDelayMs(attemptCount) {
  const exp = Math.min(16, Math.max(0, Number(attemptCount) - 1));
  return Math.min(TRANSLATION_RETRY_MAX_MS, TRANSLATION_RETRY_BASE_MS * (2 ** exp));
}
