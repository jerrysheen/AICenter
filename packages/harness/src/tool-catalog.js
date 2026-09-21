import { parseHarnessToolIds } from './runtime-mode.js';
import { toHarnessToolName } from './tool-id.js';

const VALUE_TYPES = new Set(['string', 'number', 'integer', 'boolean', 'null', 'array', 'object']);
const DOTTED_KEY_PATTERN = '^[a-z][a-z0-9-]*(?:\\.[a-z][a-z0-9-]*)+$';

function jsonSchemaProperties(parameters = {}) {
  if (!parameters || typeof parameters !== 'object') return {};
  if (parameters.properties && typeof parameters.properties === 'object') return parameters;
  return {
    type: 'object',
    properties: parameters,
    additionalProperties: false,
  };
}

export function projectToolCatalog(tools, allowedToolIds) {
  const list = typeof tools?.list === 'function' ? tools.list() : [];
  const allow = new Set(parseHarnessToolIds(allowedToolIds, []));
  const selected = allow.size ? list.filter((tool) => allow.has(tool.id)) : list;
  return selected.map((tool) => ({
    id: tool.id,
    name: toHarnessToolName(tool.id),
    description: String(tool.description || '').trim(),
    effect: tool.effect || 'read',
    parameters: jsonSchemaProperties(tool.parameters),
  }));
}

function constraintNotes(spec = {}) {
  const notes = [];
  if (spec.pattern === DOTTED_KEY_PATTERN) {
    notes.push('点分 taxonomy key，例如 domain.investment');
  } else if (spec.pattern) {
    notes.push(`必须匹配 ${spec.pattern}`);
  }
  if (Number.isFinite(spec.minLength)) notes.push(`最短 ${spec.minLength} 字`);
  if (Number.isFinite(spec.maxLength)) notes.push(`最长 ${spec.maxLength} 字`);
  if (Number.isFinite(spec.minimum)) notes.push(`最小 ${spec.minimum}`);
  if (Number.isFinite(spec.maximum)) notes.push(`最大 ${spec.maximum}`);
  if (Number.isFinite(spec.minItems)) notes.push(`至少 ${spec.minItems} 项`);
  if (Number.isFinite(spec.maxItems)) notes.push(`最多 ${spec.maxItems} 项`);
  return notes;
}

function withAnnotations(node, spec = {}) {
  if (spec.title) node.title = spec.title;
  if (spec.default !== undefined) node.default = spec.default;
  if (spec.examples !== undefined) node.examples = spec.examples;
  else if (spec.pattern === DOTTED_KEY_PATTERN) node.examples = ['domain.investment'];
  const description = [spec.description, ...constraintNotes(spec)]
    .map((part) => String(part || '').trim())
    .filter(Boolean)
    .join('。');
  if (description) node.description = description;
  return node;
}

function sanitizeValueSpec(spec) {
  if (!spec || typeof spec !== 'object') return { type: 'json' };
  const type = String(spec.type || 'json');
  if (type === 'json' || !VALUE_TYPES.has(type)) {
    return withAnnotations({ type: 'json' }, spec);
  }
  const node = { type };
  if (Array.isArray(spec.enum)) node.enum = spec.enum;
  if (spec.const !== undefined) node.const = spec.const;
  if (type === 'array' && spec.items) node.items = sanitizeValueSpec(spec.items);
  if (type === 'object') {
    node.additionalProperties = spec.additionalProperties === true;
    if (spec.properties && typeof spec.properties === 'object') {
      node.properties = toDefineToolParameters(spec);
    }
  }
  return withAnnotations(node, spec);
}

export function toDefineToolParameters(parameters = {}) {
  const schema = jsonSchemaProperties(parameters);
  const required = new Set(schema.required || []);
  return Object.fromEntries(Object.entries(schema.properties || {}).map(([key, spec]) => {
    const node = sanitizeValueSpec(spec);
    if (required.has(key) && spec?.default === undefined) node.required = true;
    return [key, node];
  }));
}
