const DEFAULT_API_ROOT = 'https://api.typesafe.ai/v1';
const DEFAULT_MODEL = 'jev-latest';
const DEFAULT_TIMEOUT_MS = 10_000;

function text(value, fallback = '') {
  return typeof value === 'string' && value.trim() ? value.trim() : fallback;
}

function positiveInteger(value, fallback) {
  const parsed = Number(value);
  return Number.isInteger(parsed) && parsed > 0 ? parsed : fallback;
}

function isRecord(value) {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function clipError(value, max = 240) {
  const message = String(value || '').replace(/[\r\n]+/g, ' ').trim();
  return message.slice(0, max) || 'TypeSafe request failed';
}

function readErrorDetail(payload) {
  if (typeof payload === 'string') return clipError(payload);
  if (!isRecord(payload)) return '';
  return clipError(payload.error?.message || payload.message || payload.detail || '');
}

async function readJson(response) {
  const raw = await response.text();
  if (!raw) return {};
  try {
    return JSON.parse(raw);
  } catch {
    return { message: raw.slice(0, 240) };
  }
}

function combineSignals(parentSignal, timeoutMs) {
  const controller = new AbortController();
  const timer = setTimeout(() => {
    const error = new Error(`TypeSafe 请求超时（${timeoutMs}ms）`);
    error.name = 'TimeoutError';
    error.code = 'TYPESAFE_TIMEOUT';
    controller.abort(error);
  }, timeoutMs);
  const onAbort = () => {
    const error = parentSignal?.reason instanceof Error
      ? parentSignal.reason
      : new DOMException('The operation was aborted', 'AbortError');
    controller.abort(error);
  };
  if (parentSignal?.aborted) onAbort();
  else parentSignal?.addEventListener('abort', onAbort, { once: true });
  return {
    signal: controller.signal,
    clear() {
      clearTimeout(timer);
      parentSignal?.removeEventListener('abort', onAbort);
    },
  };
}

export function resolveTypeSafeApiKey(options = {}, env = process.env) {
  if (options.apiKey !== undefined) return text(options.apiKey);
  return text(env.AI_CENTER_TYPESAFE_API_KEY) || text(env.TYPESAFE_API_KEY);
}

export function createTypeSafeSystemOneClient(options = {}) {
  const env = options.env || process.env;
  const fetchImpl = options.fetch || fetch;
  const apiKey = resolveTypeSafeApiKey(options, env);
  const apiRoot = (text(options.apiRoot) || text(env.AI_CENTER_TYPESAFE_API_ROOT) || DEFAULT_API_ROOT).replace(/\/$/, '');
  const model = text(options.model) || text(env.AI_CENTER_JEV_MODEL) || DEFAULT_MODEL;
  const timeoutMs = positiveInteger(options.timeoutMs ?? env.AI_CENTER_JEV_TIMEOUT_MS, DEFAULT_TIMEOUT_MS);

  return Object.freeze({
    providerId: 'typesafe',
    modelId: model,
    available() {
      return Boolean(apiKey);
    },
    async evaluate({ state, questions, signal, model: requestModel } = {}) {
      if (!apiKey) {
        const error = new Error('未配置 AI_CENTER_TYPESAFE_API_KEY 或 TYPESAFE_API_KEY');
        error.code = 'TYPESAFE_UNAVAILABLE';
        throw error;
      }
      if (!isRecord(questions) || !Object.keys(questions).length) {
        throw new Error('TypeSafe questions 不能为空');
      }
      const timeout = combineSignals(signal, timeoutMs);
      try {
        const response = await fetchImpl(`${apiRoot}/systemone`, {
          method: 'POST',
          headers: {
            Authorization: `Bearer ${apiKey}`,
            'Content-Type': 'application/json',
          },
          body: JSON.stringify({
            state,
            model: text(requestModel) || model,
            questions,
          }),
          signal: timeout.signal,
        });
        const payload = await readJson(response);
        if (!response.ok) {
          const error = new Error(`TypeSafe 调用失败（${response.status}${readErrorDetail(payload) ? `: ${readErrorDetail(payload)}` : ''}）`);
          error.code = response.status === 401 || response.status === 403
            ? 'TYPESAFE_UNAUTHORIZED'
            : 'TYPESAFE_HTTP_ERROR';
          error.status = response.status;
          throw error;
        }
        if (!isRecord(payload?.answers)) {
          throw new Error('TypeSafe 没有返回 answers');
        }
        return {
          model: text(payload.model, model),
          answers: payload.answers,
          usage: isRecord(payload.usage) ? payload.usage : {},
        };
      } catch (error) {
        if (error?.name === 'AbortError' || error?.name === 'TimeoutError' || error?.code === 'TYPESAFE_TIMEOUT') {
          if (signal?.aborted) throw error;
          const timeoutError = new Error(`TypeSafe 请求超时（${timeoutMs}ms）`);
          timeoutError.code = 'TYPESAFE_TIMEOUT';
          throw timeoutError;
        }
        if (error?.code) throw error;
        const wrapped = new Error(clipError(error?.message));
        wrapped.code = 'TYPESAFE_NETWORK_ERROR';
        throw wrapped;
      } finally {
        timeout.clear();
      }
    },
  });
}
