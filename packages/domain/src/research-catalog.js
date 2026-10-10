import { createHash } from 'node:crypto';
import {
  ResearchAdditionSchema,
  ResearchCatalogSchema,
  parseContract,
  ValidationError,
} from '../../contracts/src/index.js';

export const RESEARCH_TAG_PROMPT_VERSION = 'research-tag-v1';
export const RESEARCH_RELEVANCE_PROMPT_VERSION = 'research-relevance-v1';
const BANNED_TAG_NAME = /利空|利好|逻辑破坏|看涨|看跌|必涨|必跌/;

export function canonicalHash(value) {
  return createHash('sha256').update(JSON.stringify(canonicalize(value))).digest('hex');
}

function canonicalize(value) {
  if (Array.isArray(value)) return value.map(canonicalize);
  if (value && typeof value === 'object') {
    return Object.fromEntries(Object.keys(value).sort().map((key) => [key, canonicalize(value[key])]));
  }
  return value;
}

function assertNeutral(tags) {
  for (const tag of tags) {
    if (BANNED_TAG_NAME.test(tag.name) || BANNED_TAG_NAME.test(tag.id)) {
      throw new ValidationError(`研究Tag不能使用预设结论：${tag.name}`, ['tags']);
    }
  }
}

function definitionFields(tag) {
  return {
    id: tag.id,
    name: tag.name,
    definition: tag.definition,
    include: tag.include,
    exclude: tag.exclude,
    keywords: tag.keywords || [],
    aliases: tag.aliases || [],
    enabled: tag.enabled !== false,
  };
}

function questionFields(question) {
  return {
    id: question.id,
    version: question.version,
    objective: question.objective,
    subquestions: question.subquestions,
    queries: question.queries || [],
    historyLookbackMs: question.historyLookbackMs,
    evidence: question.evidence,
  };
}

function stripTag(tag) {
  const { definitionHash, questionHash, ...rest } = tag;
  return rest;
}

function stripQuestion(question) {
  const { definitionHash, questionHash, ...rest } = question;
  return rest;
}

export function loadResearchCatalog(source) {
  const raw = typeof source === 'string' ? JSON.parse(source) : source;
  if (raw?.kind === 'research-addition') {
    throw new ValidationError('研究增补必须合并到已加载目录后才能生效', ['kind']);
  }
  const rawTags = Array.isArray(raw?.tags) ? raw.tags : [];
  const rawQuestions = Array.isArray(raw?.questions) ? raw.questions : [];
  const rest = { ...(raw || {}) };
  delete rest.contentHash;
  delete rest.tags;
  delete rest.questions;
  const parsed = parseContract(ResearchCatalogSchema, {
    ...rest,
    tags: rawTags.map(stripTag),
    questions: rawQuestions.map(stripQuestion),
  });
  assertNeutral(parsed.tags);
  const seenTags = new Set();
  const tags = parsed.tags.map((tag) => {
    if (seenTags.has(tag.id)) throw new ValidationError(`研究Tag重复：${tag.id}`, ['tags']);
    seenTags.add(tag.id);
    return { ...tag, definitionHash: canonicalHash(definitionFields(tag)) };
  });
  const seenQuestions = new Set();
  const questions = parsed.questions.map((question) => {
    if (seenQuestions.has(question.id)) throw new ValidationError(`研究问题重复：${question.id}`, ['questions']);
    seenQuestions.add(question.id);
    const tagIds = question.subquestions.flatMap((item) => item.tagIds);
    for (const tagId of tagIds) {
      const tag = tags.find((item) => item.id === tagId);
      if (!tag) throw new ValidationError(`研究问题引用了不存在的Tag：${tagId}`, ['tagIds']);
      if (!tag.enabled) throw new ValidationError(`研究问题引用了未启用的Tag：${tagId}`, ['tagIds']);
    }
    return { ...question, questionHash: canonicalHash(questionFields(question)) };
  });
  const contentHash = canonicalHash({
    id: parsed.id,
    tags: tags.map((tag) => tag.definitionHash).sort(),
    questions: questions.map((question) => question.questionHash).sort(),
  });
  return { id: parsed.id, version: parsed.version, tags, questions, contentHash };
}

export function applyResearchAddition(catalog, addition) {
  if (!catalog?.tags || !catalog?.questions) throw new ValidationError('没有已加载的研究配置', ['catalog']);
  const parsed = parseContract(ResearchAdditionSchema, {
    ...addition,
    tags: (addition?.tags || []).map(stripTag),
    questions: (addition?.questions || []).map(stripQuestion),
  });
  const tags = new Map(catalog.tags.map((tag) => [tag.id, stripTag(tag)]));
  for (const tag of parsed.tags) tags.set(tag.id, tag);
  const questions = new Map(catalog.questions.map((question) => [question.id, stripQuestion(question)]));
  for (const question of parsed.questions) questions.set(question.id, question);
  return loadResearchCatalog({
    id: catalog.id,
    version: parsed.version,
    tags: [...tags.values()],
    questions: [...questions.values()],
  });
}

export function projectResearchTags(tags) {
  return (tags || []).map((tag) => ({
    id: tag.id,
    name: tag.name,
    definition: tag.definition,
    include: tag.include,
    exclude: tag.exclude,
    keywords: tag.keywords || [],
    aliases: tag.aliases || [],
  }));
}

export function tagsForQuestion(catalog, question) {
  const ids = [...new Set(question.subquestions.flatMap((item) => item.tagIds))];
  const tags = ids.map((id) => catalog.tags.find((tag) => tag.id === id));
  if (tags.some((tag) => !tag || !tag.enabled)) {
    throw new ValidationError('研究问题引用了未启用或不存在的研究Tag', ['tagIds']);
  }
  return tags;
}
