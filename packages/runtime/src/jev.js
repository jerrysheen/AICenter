function text(value, fallback = '') {
  return typeof value === 'string' && value.trim() ? value.trim() : fallback;
}

function clip(value, max = 280) {
  const normalized = String(value || '').replace(/\s+/g, ' ').trim();
  if (!normalized) return '';
  return normalized.length > max ? `${normalized.slice(0, max)}…` : normalized;
}

function envFlag(value) {
  return text(value).toLowerCase();
}

function clampScore(value) {
  const number = Number(value);
  if (!Number.isFinite(number)) return null;
  return Math.min(1, Math.max(0, number));
}

export function resolveJevConfig(env = process.env) {
  const disabled = envFlag(env.AI_CENTER_JEV_DISABLED) === '1';
  return Object.freeze({
    disabled,
    available: !disabled,
  });
}

export function parseJevScores(answers = {}) {
  const scores = {};
  for (const [key, answer] of Object.entries(answers || {})) {
    const score = clampScore(answer?.noul ?? answer?.confidence ?? answer);
    if (score != null) scores[key] = score;
  }
  return scores;
}

export function averageConfidence(scores = {}) {
  const values = Object.values(scores).filter((value) => Number.isFinite(value));
  if (!values.length) return null;
  return Math.round((values.reduce((sum, value) => sum + value, 0) / values.length) * 100) / 100;
}

export function createJevPlugin({ client, now = () => Date.now() } = {}) {
  return Object.freeze({
    async evaluate({ state, questions, signal, kind = 'evaluate' } = {}) {
      if (!client || typeof client.evaluate !== 'function') {
        return { status: 'skipped', kind, reason: 'unavailable', scores: {}, confidence: null };
      }
      const startedAt = now();
      try {
        const response = await client.evaluate({ state, questions, signal });
        const scores = parseJevScores(response?.answers);
        return {
          status: 'ok',
          kind,
          scores,
          confidence: averageConfidence(scores),
          model: response?.model || '',
          usage: response?.usage || {},
          durationMs: now() - startedAt,
        };
      } catch (error) {
        if (error?.name === 'AbortError') throw error;
        return {
          status: 'failed',
          kind,
          error: clip(error?.message || error, 240),
          code: error?.code || '',
          scores: {},
          confidence: null,
          durationMs: now() - startedAt,
        };
      }
    },
  });
}

export function createJevPluginFromEnv({ client, env = process.env, now } = {}) {
  const config = resolveJevConfig(env);
  if (config.disabled) return null;
  if (!client || typeof client.evaluate !== 'function') return null;
  if (typeof client.available === 'function' && !client.available()) return null;
  return createJevPlugin({ client, now });
}
