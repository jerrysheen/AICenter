const VERDICTS = new Set(['direct', 'background', 'irrelevant', 'insufficient']);

function readObject(value) {
  if (value && typeof value === 'object') return value;
  if (typeof value !== 'string') return null;
  const start = value.indexOf('{');
  const end = value.lastIndexOf('}');
  if (start < 0 || end <= start) return null;
  try { return JSON.parse(value.slice(start, end + 1)); } catch { return null; }
}

export function createResearchTagJudge(client) {
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
