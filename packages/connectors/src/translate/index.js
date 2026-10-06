import { createHash } from 'node:crypto';
import { createGeminiGrokTaskRouter, parseGeminiGenerateContent } from '../gemini-grok-task.js';
export { parseGeminiGenerateContent };

// Gemini first; quota exhaustion falls back to Elucid Grok.

const DEFAULT_TARGET = 'zh';
const TRANSLATE_SYSTEM = '你是翻译器。将用户提供的英语或韩语译成简体中文，并做轻度清洗：去掉界面残渣和重复空白，不要总结、不要扩写、不要加评论。保持数字、公司名和专业术语准确。保留原文段落和列表；原文已有的评论保留独立的「评论」标题，每条评论保留作者并以「· 」另起一行，不把评论并入正文。只输出译文。';
const TRANSLATE_BATCH_SYSTEM = `你是财经信息翻译器。将输入中的英文或韩文译成简体中文，并做轻度清洗。

要求：
1. 保持事实、数字、日期、金额、百分比、公司名、产品名和股票代码准确。
2. 允许去掉界面残渣、重复空白和无信息尾巴；不要总结，不要扩写，不要加评论。
3. 只返回 JSON 数组，不要解释。
4. id 必须保持不变。
5. 保留原文段落和列表；原文已有的评论保留独立的「评论」标题，每条评论保留作者并以「· 」另起一行。没有评论的原文不要添加评论。JSON 字符串内换行使用 \\n 转义。

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

export function createTranslateService(options = {}) {
  const ttlMs = options.ttlMs ?? 24 * 60 * 60_000;
  const now = options.now || Date.now;
  const cache = new Map();
  const router = createGeminiGrokTaskRouter(options);
  const systemFor = (target, batch = false) => (batch ? TRANSLATE_BATCH_SYSTEM : TRANSLATE_SYSTEM).replaceAll('简体中文', target === 'en' ? '英文' : '简体中文');

  function cachedOrPassthrough(source, target) {
    const key = cacheKey(source, target);
    const hit = cache.get(key);
    if (hit && now() - hit.at < ttlMs) return {...hit.payload, cached:true};
    if (!needsTranslation(source,target)) return save(source,target,source,'passthrough');
    return null;
  }
  function save(source, target, translatedText, engine) {
    const payload = {sourceText:source,translatedText,targetLang:target,engine,cached:false};
    cache.set(cacheKey(source,target),{at:now(),payload});
    return payload;
  }
  async function translate({text:sourceText,targetLang=DEFAULT_TARGET} = {}) {
    const source = text(sourceText);
    if (!source) throw new Error('没有可翻译的正文');
    const target = normalizeTranslateTarget(targetLang);
    const hit = cachedOrPassthrough(source,target);
    if (hit) return hit;
    const result = await router.generate({system:systemFor(target),prompt:source});
    return save(source,target,result.text,result.engine);
  }
  async function translateMany({items=[],targetLang=DEFAULT_TARGET} = {}) {
    const target = normalizeTranslateTarget(targetLang);
    const translations = [], pending = [];
    for (const item of items) {
      const id = text(item?.id), source = text(item?.text || item?.body);
      if (!id || !source) continue;
      const hit = cachedOrPassthrough(source,target);
      if (hit) translations.push({id,...hit}); else pending.push({id,text:source});
    }
    if (pending.length) {
      const result = await router.generate({system:systemFor(target,true),prompt:JSON.stringify(pending)});
      const batch = parseGeminiBatchTranslations(result.text);
      const byId = new Map(batch.map(row=>[row.id,row.translatedText]));
      if (!pending.some(item=>byId.has(item.id))) throw new Error('批量翻译没有返回有效项目');
      for (const item of pending) {
        const translatedText = byId.get(item.id);
        const payload = translatedText ? save(item.text,target,translatedText,result.engine) : await translate({text:item.text,targetLang:target});
        translations.push({id:item.id,...payload});
      }
    }
    return {translations,targetLang:target};
  }
  return {translate,translateMany};
}
