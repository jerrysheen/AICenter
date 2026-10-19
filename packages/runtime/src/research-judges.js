import {
  RESEARCH_RELEVANCE_NOUL_VERSION,
  RESEARCH_TAG_NOUL_VERSION,
  researchItemState,
  researchRelevanceQuestions,
  researchRelevanceState,
  researchTagHits,
  researchTagQuestion,
  researchVerdictFromScores,
  selectResearchTags,
} from '../../domain/src/research-noul.js';

const VERDICTS = new Set(['direct', 'background', 'irrelevant', 'insufficient']);

function readObject(value) {
  if (value && typeof value === 'object') return value;
  if (typeof value !== 'string') return null;
  const start = value.indexOf('{');
  const end = value.lastIndexOf('}');
  if (start < 0 || end <= start) return null;
  try { return JSON.parse(value.slice(start, end + 1)); } catch { return null; }
}

function addUsage(total, response) {
  const usage = tokenUsage(response?.usage || {});
  if (usage.inputTokens != null) total.inputTokens = (total.inputTokens ?? 0) + usage.inputTokens;
  if (usage.outputTokens != null) total.outputTokens = (total.outputTokens ?? 0) + usage.outputTokens;
  return response?.model || '';
}

function createBambooResearchTagJudge(client) {
  return {
    promptVersion: RESEARCH_TAG_NOUL_VERSION,
    batchCharge: 'item',
    async judge({ tags, items }) {
      const assignments = [];
      const usage = { requests: 0, inputTokens: null, outputTokens: null };
      let model = client.modelId || '';
      for (const item of items || []) {
        const { asked } = selectResearchTags(tags, item);
        if (!asked.length) {
          assignments.push({ resourceId: item.resourceId, tagIds: [] });
          continue;
        }
        try {
          const response = await client.evaluate({
            state: researchItemState(item),
            questions: Object.fromEntries(asked.map((tag) => [tag.id, researchTagQuestion(tag)])),
          });
          usage.requests += 1;
          const reported = addUsage(usage, response);
          if (reported) model = reported;
          const allowed = new Set(asked.map((tag) => tag.id));
          assignments.push({
            resourceId: item.resourceId,
            tagIds: researchTagHits(response.answers).filter((id) => allowed.has(id)),
          });
        } catch (error) {
          if (error?.code === 'rate-limit' || error?.status === 429) throw error;
        }
      }
      return { assignments, usage, model };
    },
  };
}

function createBambooResearchRelevanceJudge(client) {
  return {
    promptVersion: RESEARCH_RELEVANCE_NOUL_VERSION,
    batchCharge: 'item',
    async judge({ question, items }) {
      const results = [];
      const usage = { requests: 0, inputTokens: null, outputTokens: null };
      let model = client.modelId || '';
      const questions = researchRelevanceQuestions();
      for (const item of items || []) {
        try {
          const response = await client.evaluate({
            state: researchRelevanceState(question, item),
            questions,
          });
          usage.requests += 1;
          const reported = addUsage(usage, response);
          if (reported) model = reported;
          const answers = response.answers || {};
          results.push({
            resourceId: item.resourceId,
            verdict: researchVerdictFromScores({
              direct_answer: answers.direct_answer?.noul,
              related_context: answers.related_context?.noul,
              verifiable_fact: answers.verifiable_fact?.noul,
            }, item),
          });
        } catch (error) {
          if (error?.code === 'rate-limit' || error?.status === 429) throw error;
        }
      }
      return { results, usage, model };
    },
  };
}

export function createResearchTagJudge(client) {
  if (client?.providerId === 'bamboo') return createBambooResearchTagJudge(client);
  return {
    batchCharge: 'once',
    async judge({ tags, items }) {
      const response = await client.evaluate({
        state: { tag_catalog: tags, items },
        questions: {
          research_tags: '只做研究标签匹配。必须使用 tag_catalog 里的 definition、include 和 exclude。exclude 命中就不要返回该 id。没有命中返回空 tagIds。不要写报告，不要判断真伪。只返回 JSON {"assignments":[{"resourceId":"...","tagIds":[]}]}。',
        },
      });
      const parsed = readObject(response.answers?.research_tags);
      if (!Array.isArray(parsed?.assignments)) {
        const error = new Error('研究Tag结果无法解析');
        error.code = 'invalid-output';
        throw error;
      }
      return {
        assignments: parsed.assignments.map((item) => ({
          resourceId: item.resourceId || item.id,
          tagIds: Array.isArray(item.tagIds) ? item.tagIds.filter((id) => typeof id === 'string') : [],
        })),
        usage: tokenUsage(response.usage),
        model: response.model,
      };
    },
  };
}

export function createResearchRelevanceJudge(client) {
  if (client?.providerId === 'bamboo') return createBambooResearchRelevanceJudge(client);
  return {
    batchCharge: 'once',
    async judge({ question, items }) {
      const response = await client.evaluate({
        state: { question, items },
        questions: {
          research_relevance: '只判断每条材料与研究问题的相关性，返回 direct、background、irrelevant 或 insufficient。不要写报告，不要判断真伪，不要把概率当成结论。只返回 JSON {"results":[{"resourceId":"...","verdict":"insufficient"}]}。',
        },
      });
      const parsed = readObject(response.answers?.research_relevance);
      if (!Array.isArray(parsed?.results)) {
        const error = new Error('研究相关性结果无法解析');
        error.code = 'invalid-verdict';
        throw error;
      }
      return {
        results: parsed.results.map((item) => ({
          resourceId: item.resourceId || item.id,
          verdict: VERDICTS.has(item.verdict) ? item.verdict : '',
        })),
        usage: tokenUsage(response.usage),
        model: response.model,
      };
    },
  };
}

function tokenUsage(usage = {}) {
  const input = usage.input_tokens ?? usage.inputTokens;
  const output = usage.output_tokens ?? usage.outputTokens;
  return {
    requests: 1,
    inputTokens: Number.isFinite(Number(input)) ? Number(input) : null,
    outputTokens: Number.isFinite(Number(output)) ? Number(output) : null,
  };
}
