// Bamboo Relay in front of StartLux Decision. Same state + questions shape as
// TypeSafe System One. The key is read only from BAMBOO_API_KEY.

import { randomUUID } from 'node:crypto';

export const BAMBOO_DEFAULT_ENDPOINT = 'https://api.bamboonode.dev/v1/decisions';
export const BAMBOO_DEFAULT_MODEL = 'startlux-decision-27b-autothink';
const DEFAULT_TIMEOUT_MS = 30_000;
const DEFAULT_MAX_BYTES = 1_000_000;

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

function thinkModeOf(value) {
  const raw = text(value).toLowerCase();
  return raw === 'never' || raw === 'always' || raw === 'auto' ? raw : 'auto';
}

export function resolveBambooApiKey(env = process.env) {
  return text(env?.BAMBOO_API_KEY);
}

export function resolveBambooEndpoint(env = process.env) {
  const explicit = text(env?.AI_CENTER_BAMBOO_ENDPOINT);
  if (explicit) return explicit;
  const root = text(env?.AI_CENTER_BAMBOO_API_ROOT);
  if (!root) return BAMBOO_DEFAULT_ENDPOINT;
  return `${root.replace(/\/$/, '')}/decisions`;
}

export function resolveBambooModel(env = process.env) {
  return text(env?.AI_CENTER_BAMBOO_MODEL) || BAMBOO_DEFAULT_MODEL;
}

function redact(value, secrets) {
  let output = String(value ?? '');
  for (const secret of secrets) {
    if (secret && secret.length >= 4) output = output.split(secret).join('[redacted]');
  }
  return output.replace(/Bearer\s+\S+/gi, 'Bearer [redacted]').replace(/[\r\n]+/g, ' ').trim();
}

function clip(value, max = 180) {
  const message = String(value || '').replace(/[\r\n]+/g, ' ').trim();
  return message.length > max ? `${message.slice(0, max)}…` : message;
}

function fail(code, message, { status = null, secrets = [] } = {}) {
  const error = new Error(redact(clip(message), secrets) || 'Bamboo 请求失败');
  error.code = code;
  if (Number.isInteger(status)) error.status = status;
  return error;
}

function endpointAllowed(endpoint, apiKey) {
  let url;
  try { url = new URL(endpoint); } catch { return false; }
  if (apiKey && endpoint.includes(apiKey)) return false;
  const local = url.hostname === 'localhost' || url.hostname === '127.0.0.1';
  if (url.protocol === 'https:') return true;
  return url.protocol === 'http:' && local;
}

// StartLux documents optional noul criteria as {true, false} descriptions, the
// same shape TypeSafe already sends. Pass them through. Do not fold them into
// instructions: that would change the question text. Live agreement with JEV
// was not measured; see noulWireVariants.
export function projectDecisionQuestions(questions, { includeCriteria = true } = {}) {
  if (!isRecord(questions) || !Object.keys(questions).length) {
    throw fail('BAMBOO_CONTRACT', 'Bamboo questions 不能为空');
  }
  const projected = {};
  for (const [id, question] of Object.entries(questions)) {
    if (!isRecord(question)) throw fail('BAMBOO_CONTRACT', `问题 ${id} 必须是对象`);
    const type = question.type === 'bool' ? 'noul' : text(question.type);
    if (type !== 'noul' && type !== 'choice' && type !== 'score') {
      throw fail('BAMBOO_CONTRACT', `问题 ${id} 的类型无法送到 Bamboo`);
    }
    const next = { type };
    if (typeof question.instructions === 'string') next.instructions = question.instructions;
    if (includeCriteria && isRecord(question.criteria)) {
      if (type === 'noul') {
        const criteria = {};
        if (typeof question.criteria.true === 'string') criteria.true = question.criteria.true;
        if (typeof question.criteria.false === 'string') criteria.false = question.criteria.false;
        if (Object.keys(criteria).length) next.criteria = criteria;
      } else {
        next.criteria = question.criteria;
      }
    }
    projected[id] = next;
  }
  return projected;
}

export function noulWireVariants(question) {
  const wrapped = { sample: question };
  return {
    withCriteria: projectDecisionQuestions(wrapped).sample,
    instructionsOnly: projectDecisionQuestions(wrapped, { includeCriteria: false }).sample,
  };
}

function assertUnit(value, label) {
  if (typeof value !== 'number' || !Number.isFinite(value) || value < 0 || value > 1) {
    throw fail('BAMBOO_CONTRACT', `${label} 不是 0 到 1 的数字`);
  }
}

export function assertDecisionAnswers(questions, answers) {
  if (!isRecord(answers)) throw fail('BAMBOO_BAD_RESPONSE', 'Bamboo 没有返回 answers');
  for (const [id, question] of Object.entries(questions)) {
    const answer = answers[id];
    if (!isRecord(answer)) throw fail('BAMBOO_CONTRACT', `Bamboo 缺少答案 ${id}`);
    if (question.type === 'noul') {
      if (answer.type !== 'noul') throw fail('BAMBOO_CONTRACT', `Bamboo 答案 ${id} 类型不是 noul`);
      assertUnit(answer.noul, `Bamboo 答案 ${id} 的 noul`);
    } else if (question.type === 'choice') {
      readChoiceAnswer(answer);
    } else if (question.type === 'score') {
      const levels = scoreLevelCount(question.criteria);
      readScoreAnswer(answer, levels);
    }
  }
  return answers;
}

export function readChoiceAnswer(answer) {
  if (!isRecord(answer) || answer.type !== 'choice') throw fail('BAMBOO_CONTRACT', 'choice 答案缺失');
  if (answer.choice !== null && typeof answer.choice !== 'string') {
    throw fail('BAMBOO_CONTRACT', 'choice 只能是字符串或 null');
  }
  if (answer.none_probability !== undefined) assertUnit(answer.none_probability, 'none_probability');
  const probabilities = isRecord(answer.probabilities) ? answer.probabilities : {};
  return {
    choice: answer.choice,
    noneProbability: answer.none_probability ?? null,
    probabilities,
  };
}

function scoreLevelCount(criteria) {
  if (Array.isArray(criteria)) return criteria.length;
  if (isRecord(criteria)) return Object.keys(criteria).length;
  return 0;
}

export function readScoreAnswer(answer, levels) {
  const count = Number(levels);
  if (!Number.isInteger(count) || count < 2 || count > 10) {
    throw fail('BAMBOO_CONTRACT', 'score 需要 2 到 10 档');
  }
  if (!isRecord(answer) || answer.type !== 'score' || typeof answer.score !== 'number' || !Number.isFinite(answer.score)) {
    throw fail('BAMBOO_CONTRACT', 'score 答案缺失');
  }
  if (answer.score < 0 || answer.score > count - 1) {
    throw fail('BAMBOO_CONTRACT', `score 必须落在 0 到 ${count - 1}`);
  }
  return { score: answer.score, probabilities: isRecord(answer.probabilities) ? answer.probabilities : {} };
}

export function matchedNoulLabels(answers, threshold) {
  const limit = Number(threshold);
  if (!Number.isFinite(limit) || limit < 0 || limit > 1) {
    throw fail('BAMBOO_CONTRACT', 'noul 阈值必须是 0 到 1 的数字');
  }
  const hits = [];
  for (const [id, answer] of Object.entries(isRecord(answers) ? answers : {})) {
    if (!isRecord(answer) || answer.type !== 'noul') continue;
    assertUnit(answer.noul, `标签 ${id} 的 noul`);
    if (answer.noul >= limit) hits.push({ id, noul: answer.noul });
  }
  return hits;
}

function combineSignals(parentSignal, timeoutMs) {
  const controller = new AbortController();
  const timer = setTimeout(() => {
    controller.abort(fail('BAMBOO_TIMEOUT', `Bamboo 请求超时（${timeoutMs}ms）`));
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

function httpCode(status) {
  if (status === 401) return 'BAMBOO_UNAUTHORIZED';
  if (status === 403) return 'BAMBOO_FORBIDDEN';
  if (status === 422) return 'BAMBOO_UNPROCESSABLE';
  if (status === 429) return 'BAMBOO_RATE_LIMIT';
  if (status >= 500) return 'BAMBOO_UPSTREAM';
  if (status >= 300 && status < 400) return 'BAMBOO_REDIRECT';
  return 'BAMBOO_HTTP_ERROR';
}

function categoryFor(code) {
  switch (code) {
    case 'BAMBOO_UNAUTHORIZED': return 'unauthorized';
    case 'BAMBOO_FORBIDDEN': return 'forbidden';
    case 'BAMBOO_UNPROCESSABLE': return 'unprocessable';
    case 'BAMBOO_RATE_LIMIT': return 'rate-limit';
    case 'BAMBOO_UPSTREAM': return 'upstream';
    case 'BAMBOO_TIMEOUT': return 'timeout';
    case 'BAMBOO_NETWORK_ERROR': return 'network';
    case 'BAMBOO_UNAVAILABLE': return 'unavailable';
    case 'BAMBOO_BAD_RESPONSE': return 'bad-response';
    case 'BAMBOO_CONTRACT': return 'contract';
    case 'BAMBOO_REDIRECT': return 'redirect';
    default: return 'http';
  }
}

function readErrorDetail(payload, secrets) {
  if (typeof payload === 'string') return redact(clip(payload), secrets);
  if (!isRecord(payload)) return '';
  const error = isRecord(payload.error) ? payload.error : null;
  const detail = error?.message ?? payload.error ?? payload.message ?? payload.detail ?? '';
  const rendered = typeof detail === 'string' ? detail : (() => { try { return JSON.stringify(detail); } catch { return ''; } })();
  return redact(clip(rendered), secrets);
}

async function readLimitedText(response, maxBytes) {
  const declared = Number(response.headers?.get?.('content-length'));
  if (Number.isFinite(declared) && declared > maxBytes) {
    throw fail('BAMBOO_BAD_RESPONSE', 'Bamboo 响应超过大小限制', { status: response.status });
  }
  if (!response.body || typeof response.body.getReader !== 'function') {
    const raw = await response.text();
    if (Buffer.byteLength(raw) > maxBytes) {
      throw fail('BAMBOO_BAD_RESPONSE', 'Bamboo 响应超过大小限制', { status: response.status });
    }
    return raw;
  }
  const reader = response.body.getReader();
  const chunks = [];
  let total = 0;
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > maxBytes) {
      try { await reader.cancel(); } catch { /* already over the cap */ }
      throw fail('BAMBOO_BAD_RESPONSE', 'Bamboo 响应超过大小限制', { status: response.status });
    }
    chunks.push(Buffer.from(value));
  }
  return Buffer.concat(chunks).toString('utf8');
}

function usageOf(payload) {
  return isRecord(payload?.usage) ? payload.usage : {};
}

function report(log, fields, secrets) {
  if (typeof log !== 'function') return;
  const line = `[bamboo] id=${fields.requestId} provider=bamboo model=${fields.model} http=${fields.http} ms=${fields.ms} in=${fields.inputTokens ?? '-'} out=${fields.outputTokens ?? '-'} category=${fields.category}`;
  try { log(redact(line, secrets)); } catch { /* logging must not change the call */ }
}

export function createBambooStartLuxClient(options = {}) {
  const env = options.env || process.env;
  const fetchImpl = options.fetch || fetch;
  const apiKey = resolveBambooApiKey(env);
  const endpoint = text(options.endpoint) || resolveBambooEndpoint(env);
  const model = text(options.model) || resolveBambooModel(env);
  const timeoutMs = positiveInteger(options.timeoutMs ?? env.AI_CENTER_BAMBOO_TIMEOUT_MS, DEFAULT_TIMEOUT_MS);
  const maxBytes = positiveInteger(options.maxBytes ?? env.AI_CENTER_BAMBOO_MAX_RESPONSE_BYTES, DEFAULT_MAX_BYTES);
  const thinkMode = thinkModeOf(options.thinkMode ?? env.AI_CENTER_BAMBOO_THINK_MODE);
  const log = options.log;
  const secrets = [apiKey].filter(Boolean);

  return Object.freeze({
    providerId: 'bamboo',
    modelId: model,
    available() {
      return Boolean(apiKey);
    },
    async evaluate({ state, questions, signal, model: requestModel } = {}) {
      const requestId = randomUUID();
      const started = Date.now();
      const usedModel = text(requestModel) || model;
      let http = '-';
      let category = 'ok';
      let inputTokens = null;
      let outputTokens = null;
      const finish = () => report(log, {
        requestId, model: usedModel, http, ms: Date.now() - started, inputTokens, outputTokens, category,
      }, secrets);
      if (!apiKey) {
        category = 'unavailable';
        finish();
        throw fail('BAMBOO_UNAVAILABLE', '未配置 BAMBOO_API_KEY');
      }
      if (!endpointAllowed(endpoint, apiKey)) {
        category = 'unavailable';
        finish();
        throw fail('BAMBOO_UNAVAILABLE', 'Bamboo endpoint 必须是 https，且不能把密钥写进 URL', { secrets });
      }
      let projected;
      try {
        projected = projectDecisionQuestions(questions);
      } catch (error) {
        category = categoryFor(error?.code);
        finish();
        throw error;
      }
      const timeout = combineSignals(signal, timeoutMs);
      try {
        const response = await fetchImpl(endpoint, {
          method: 'POST',
          redirect: 'manual',
          headers: {
            Authorization: `Bearer ${apiKey}`,
            'Content-Type': 'application/json',
            'x-request-id': requestId,
          },
          body: JSON.stringify({
            model: usedModel,
            state,
            questions: projected,
            think_mode: thinkMode,
          }),
          signal: timeout.signal,
        });
        http = Number.isInteger(response.status) && response.status > 0 ? response.status : '-';
        if (response.status === 0 || response.type === 'opaqueredirect' || (response.status >= 300 && response.status < 400)) {
          category = 'redirect';
          throw fail('BAMBOO_REDIRECT', `Bamboo 返回重定向（${response.status || 0}），已停止且未转发凭据`, { status: response.status || null, secrets });
        }
        const raw = await readLimitedText(response, maxBytes);
        const contentType = String(response.headers?.get?.('content-type') || '');
        const trimmed = raw.trimStart();
        const html = contentType.includes('text/html') || trimmed.startsWith('<');
        let payload = null;
        if (!html && raw) {
          try { payload = JSON.parse(raw); } catch { payload = null; }
        }
        if (!response.ok) {
          const code = httpCode(response.status);
          category = categoryFor(code);
          const detail = payload ? readErrorDetail(payload, secrets) : (html ? '' : readErrorDetail(raw, secrets));
          throw fail(code, `Bamboo 调用失败（${response.status}${detail ? `: ${detail}` : ''}）`, { status: response.status, secrets });
        }
        if (html || !payload) {
          category = 'bad-response';
          throw fail('BAMBOO_BAD_RESPONSE', 'Bamboo 返回了无法解析的正文', { status: response.status, secrets });
        }
        try {
          assertDecisionAnswers(projected, payload.answers);
        } catch (error) {
          category = categoryFor(error?.code);
          throw error;
        }
        const usage = usageOf(payload);
        inputTokens = Number.isFinite(Number(usage.input_tokens)) ? Number(usage.input_tokens) : null;
        outputTokens = Number.isFinite(Number(usage.output_tokens)) ? Number(usage.output_tokens) : null;
        return {
          model: text(payload.model, usedModel),
          answers: payload.answers,
          usage,
          requestId: text(response.headers?.get?.('x-request-id')) || requestId,
        };
      } catch (error) {
        if (signal?.aborted && !error?.code) throw error;
        if (error?.code) {
          if (category === 'ok') category = categoryFor(error.code);
          throw error;
        }
        if (error?.name === 'AbortError' || error?.name === 'TimeoutError') {
          if (signal?.aborted) throw error;
          category = 'timeout';
          throw fail('BAMBOO_TIMEOUT', `Bamboo 请求超时（${timeoutMs}ms）`, { secrets });
        }
        category = 'network';
        throw fail('BAMBOO_NETWORK_ERROR', redact(error?.message, secrets) || 'Bamboo 网络失败', { secrets });
      } finally {
        timeout.clear();
        finish();
      }
    },
  });
}
