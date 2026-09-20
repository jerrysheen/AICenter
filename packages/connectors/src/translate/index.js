import { createHash } from 'node:crypto';

// 翻译只走 Gemini / DeepL / Google Translate。禁止读取 Elucid（ELUCID_GROK_API_KEY）。

const DEFAULT_TARGET = 'zh';
const GEMINI_DEFAULT_ROOT = 'https://generativelanguage.googleapis.com/v1beta';
const GEMINI_DEFAULT_MODEL = 'gemini-3.1-flash-lite';
const TRANSLATE_SYSTEM = '你是翻译器。将用户提供的英语或韩语译成简体中文，并做轻度清洗：去掉界面残渣和重复空白，不要总结、不要扩写、不要加评论。保持数字、公司名和专业术语准确。只输出译文。';
const TRANSLATE_BATCH_SYSTEM = `你是财经信息翻译器。将输入中的英文或韩文译成简体中文，并做轻度清洗。

要求：
1. 保持事实、数字、日期、金额、百分比、公司名、产品名和股票代码准确。
2. 允许去掉界面残渣、重复空白和无信息尾巴；不要总结，不要扩写，不要加评论。
3. 只返回 JSON 数组，不要解释。
4. id 必须保持不变。

输出格式：
[{"id":"原始id","translated":"中文翻译"}]`;

function text(value) {
  return typeof value === 'string' ? value.trim() : '';
}

function countMatches(source, pattern) {
  return (source.match(pattern) || []).length;
}

export function normalizeTranslateTarget(value) {
  const key = String(value || DEFAULT_TARGET).trim().toLowerCase();
  if (['zh', 'zh-cn', 'zh_cn', 'chinese', 'cn'].includes(key)) return 'zh';
  if (['en', 'en-us', 'english'].includes(key)) return 'en';
  return 'zh';
}

export function parseGoogleTranslatePayload(payload) {
  if (!Array.isArray(payload) || !Array.isArray(payload[0])) return '';
  return payload[0].map((row) => (Array.isArray(row) ? String(row[0] || '') : '')).join('').trim();
}

export function parseGeminiGenerateContent(payload) {
  const parts = payload?.candidates?.[0]?.content?.parts;
  if (!Array.isArray(parts)) return '';
  return parts.map((part) => text(part?.text)).join('').trim();
}

export function parseGeminiBatchTranslations(raw) {
  const source = text(raw).replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/, '');
  if (!source) return [];
  let parsed;
  try {
    parsed = JSON.parse(source);
  } catch {
    return [];
  }
  const rows = Array.isArray(parsed) ? parsed : Array.isArray(parsed?.translations) ? parsed.translations : [];
  const translations = [];
  const seen = new Set();
  for (const row of rows) {
    const id = text(row?.id);
    const translatedText = text(row?.translated || row?.translatedText);
    if (!id || !translatedText || seen.has(id)) continue;
    seen.add(id);
    translations.push({ id, translatedText });
  }
  return translations;
}

export function needsTranslation(sourceText, targetLang = DEFAULT_TARGET) {
  const source = text(sourceText);
  if (!source) return false;
  const target = normalizeTranslateTarget(targetLang);
  if (target !== 'zh') return true;
  const hangul = countMatches(source, /\p{Script=Hangul}/gu);
  const latin = countMatches(source, /[A-Za-z]/g);
  const han = countMatches(source, /\p{Script=Han}/gu);
  if (hangul === 0 && latin === 0) return false;
  const foreign = hangul + latin;
  if (hangul >= 2 && hangul >= han && hangul >= latin) return true;
  if (han >= 12) return false;
  if (han >= 8 && foreign < Math.max(8, Math.ceil(han * 0.25))) return false;
  return latin >= 8 || hangul >= 2;
}

function cacheKey(sourceText, targetLang) {
  return createHash('sha256').update(`${targetLang}\n${sourceText}`).digest('hex');
}

function envText(...keys) {
  for (const key of keys) {
    const value = text(process.env[key]);
    if (value) return value;
  }
  return '';
}

async function translateWithDeepl(fetchImpl, options, sourceText, targetLang) {
  const authKey = text(options.authKey);
  if (!authKey) return null;
  const endpoint = text(options.apiUrl) || 'https://api-free.deepl.com/v2/translate';
  const body = new URLSearchParams({
    text: sourceText,
    target_lang: targetLang === 'en' ? 'EN' : 'ZH',
  });
  const response = await fetchImpl(endpoint, {
    method: 'POST',
    headers: {
      Authorization: `DeepL-Auth-Key ${authKey}`,
      'Content-Type': 'application/x-www-form-urlencoded',
    },
    body,
  });
  if (!response.ok) {
    throw new Error(`DeepL 翻译失败（${response.status}）`);
  }
  const payload = await response.json();
  const translated = text(payload?.translations?.[0]?.text);
  if (!translated) throw new Error('DeepL 没有返回译文');
  return { translatedText: translated, engine: 'deepl' };
}

async function translateWithGoogle(fetchImpl, sourceText, targetLang) {
  const params = new URLSearchParams({
    client: 'gtx',
    sl: 'auto',
    tl: targetLang === 'en' ? 'en' : 'zh-CN',
    dt: 't',
    q: sourceText,
  });
  const response = await fetchImpl(`https://translate.googleapis.com/translate_a/single?${params}`);
  if (!response.ok) {
    throw new Error(`Google 翻译失败（${response.status}）`);
  }
  const translated = parseGoogleTranslatePayload(await response.json());
  if (!translated) throw new Error('Google 没有返回译文');
  return { translatedText: translated, engine: 'google' };
}

async function translateWithGemini(fetchImpl, options, sourceText) {
  const apiKey = text(options.apiKey);
  if (!apiKey) return null;
  const root = (text(options.apiRoot) || GEMINI_DEFAULT_ROOT).replace(/\/$/, '');
  const model = text(options.model) || GEMINI_DEFAULT_MODEL;
  const response = await fetchImpl(`${root}/models/${encodeURIComponent(model)}:generateContent`, {
    method: 'POST',
    headers: {
      'x-goog-api-key': apiKey,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      systemInstruction: { parts: [{ text: TRANSLATE_SYSTEM }] },
      contents: [{ role: 'user', parts: [{ text: sourceText }] }],
    }),
  });
  if (!response.ok) {
    let detail = '';
    try {
      const errorPayload = await response.json();
      detail = text(errorPayload?.error?.message || errorPayload?.message);
    } catch {
      detail = '';
    }
    throw new Error(`Gemini 翻译失败（${response.status}${detail ? `: ${detail}` : ''}）`);
  }
  const translated = parseGeminiGenerateContent(await response.json());
  if (!translated) throw new Error('Gemini 没有返回译文');
  return { translatedText: translated, engine: 'gemini' };
}

async function translateWithGeminiBatch(fetchImpl, options, items) {
  const apiKey = text(options.apiKey);
  if (!apiKey || !items.length) return [];
  const root = (text(options.apiRoot) || GEMINI_DEFAULT_ROOT).replace(/\/$/, '');
  const model = text(options.model) || GEMINI_DEFAULT_MODEL;
  const response = await fetchImpl(`${root}/models/${encodeURIComponent(model)}:generateContent`, {
    method: 'POST',
    headers: {
      'x-goog-api-key': apiKey,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      systemInstruction: { parts: [{ text: TRANSLATE_BATCH_SYSTEM }] },
      contents: [{
        role: 'user',
        parts: [{ text: JSON.stringify(items.map((item) => ({ id: item.id, text: item.text }))) }],
      }],
    }),
  });
  if (!response.ok) {
    let detail = '';
    try {
      const errorPayload = await response.json();
      detail = text(errorPayload?.error?.message || errorPayload?.message);
    } catch {
      detail = '';
    }
    throw new Error(`Gemini 翻译失败（${response.status}${detail ? `: ${detail}` : ''}）`);
  }
  return parseGeminiBatchTranslations(parseGeminiGenerateContent(await response.json()));
}

export function createTranslateService(options = {}) {
  const fetchImpl = options.fetch || fetch;
  const ttlMs = options.ttlMs ?? 24 * 60 * 60_000;
  const now = options.now || (() => Date.now());
  const cache = new Map();
  const authKey = options.authKey !== undefined
    ? text(options.authKey)
    : envText('AI_CENTER_DEEPL_API_KEY', 'DEEPL_AUTH_KEY', 'DEEPL_API_KEY');
  const apiUrl = options.apiUrl !== undefined
    ? text(options.apiUrl)
    : envText('AI_CENTER_DEEPL_API_URL');
  const geminiApiKey = options.geminiApiKey !== undefined
    ? text(options.geminiApiKey)
    : envText('GEMINI_API_KEY', 'GOOGLE_API_KEY', 'AI_CENTER_GEMINI_API_KEY');
  const geminiApiRoot = options.geminiApiRoot !== undefined
    ? text(options.geminiApiRoot)
    : envText('AI_CENTER_GEMINI_API_ROOT') || GEMINI_DEFAULT_ROOT;
  const geminiModel = options.geminiModel !== undefined
    ? text(options.geminiModel)
    : envText('AI_CENTER_GEMINI_MODEL') || GEMINI_DEFAULT_MODEL;

  async function runEngine(name, source, target) {
    if (name === 'gemini') {
      return translateWithGemini(fetchImpl, {
        apiKey: geminiApiKey,
        apiRoot: geminiApiRoot,
        model: geminiModel,
      }, source);
    }
    if (name === 'deepl') {
      return translateWithDeepl(fetchImpl, { authKey, apiUrl }, source, target);
    }
    return translateWithGoogle(fetchImpl, source, target);
  }

  async function translate({ text: sourceText, targetLang = DEFAULT_TARGET } = {}) {
    const source = text(sourceText);
    if (!source) throw new Error('没有可翻译的正文');
    const target = normalizeTranslateTarget(targetLang);
    const key = cacheKey(source, target);
    const hit = cache.get(key);
    if (hit && now() - hit.at < ttlMs) {
      return { ...hit.payload, cached: true };
    }

    if (!needsTranslation(source, target)) {
      const payload = {
        sourceText: source,
        translatedText: source,
        targetLang: target,
        engine: 'passthrough',
        cached: false,
      };
      cache.set(key, { at: now(), payload });
      return payload;
    }

    const engines = [];
    if (geminiApiKey) engines.push('gemini');
    if (authKey) engines.push('deepl');
    engines.push('google');

    let result;
    let lastError;
    for (const name of engines) {
      try {
        result = await runEngine(name, source, target);
        if (result) break;
      } catch (error) {
        lastError = error;
      }
    }
    if (!result) {
      throw lastError || new Error('翻译失败');
    }

    const payload = {
      sourceText: source,
      translatedText: result.translatedText,
      targetLang: target,
      engine: result.engine,
      cached: false,
    };
    cache.set(key, { at: now(), payload });
    return payload;
  }

  async function translateMany({ items = [], targetLang = DEFAULT_TARGET } = {}) {
    const target = normalizeTranslateTarget(targetLang);
    const translations = [];
    const pending = [];
    for (const item of items) {
      const id = text(item?.id);
      const source = text(item?.text || item?.body);
      if (!id || !source) continue;
      const key = cacheKey(source, target);
      const hit = cache.get(key);
      if (hit && now() - hit.at < ttlMs) {
        translations.push({ id, ...hit.payload, cached: true });
        continue;
      }
      if (!needsTranslation(source, target)) {
        const payload = {
          sourceText: source,
          translatedText: source,
          targetLang: target,
          engine: 'passthrough',
          cached: false,
        };
        cache.set(key, { at: now(), payload });
        translations.push({ id, ...payload });
        continue;
      }
      pending.push({ id, text: source, key });
    }

    if (pending.length && geminiApiKey) {
      try {
        const batch = await translateWithGeminiBatch(fetchImpl, {
          apiKey: geminiApiKey,
          apiRoot: geminiApiRoot,
          model: geminiModel,
        }, pending);
        const byId = new Map(batch.map((row) => [row.id, row.translatedText]));
        const leftover = [];
        for (const item of pending) {
          const translatedText = byId.get(item.id);
          if (!translatedText) {
            leftover.push(item);
            continue;
          }
          const payload = {
            sourceText: item.text,
            translatedText,
            targetLang: target,
            engine: 'gemini',
            cached: false,
          };
          cache.set(item.key, { at: now(), payload });
          translations.push({ id: item.id, ...payload });
        }
        pending.length = 0;
        pending.push(...leftover);
      } catch {
        // Fall through to one-by-one Gemini / DeepL / Google.
      }
    }

    for (const item of pending) {
      const payload = await translate({ text: item.text, targetLang: target });
      translations.push({ id: item.id, ...payload });
    }

    return { translations, targetLang: target };
  }

  return { translate, translateMany };
}
