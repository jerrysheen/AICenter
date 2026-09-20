import { AgentResearchProfileSchema, parseContract } from '../../contracts/src/index.js';

function cleanList(value, max = 16) {
  const input = Array.isArray(value) ? value : [];
  const seen = new Set();
  const items = [];
  for (const item of input) {
    const text = String(item || '').trim();
    if (!text || text.length > 64) continue;
    const key = text.toLocaleLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    items.push(text);
    if (items.length >= max) break;
  }
  return items;
}

export function resolveResearchProfile(researchMode = 'standard', overrides = {}) {
  const mode = researchMode === 'research' ? 'research' : 'standard';
  return parseContract(AgentResearchProfileSchema, {
    mode,
    modelProfile: mode === 'research' ? 'research' : 'default',
    methodKeywords: cleanList(overrides.methodKeywords),
    extraToolIds: cleanList(overrides.extraToolIds),
    thinking: mode === 'research' ? 'deliberate' : 'standard',
  });
}
