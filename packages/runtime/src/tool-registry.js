import { z } from 'zod';
import { AgentToolResultSchema, ValidationError, parseContract } from '../../contracts/src/index.js';

const TOOL_ID = /^[a-z][a-z0-9-]*(?:\.[a-z][a-z0-9-]*)+$/;
const EFFECTS = new Set(['read', 'write', 'destructive']);
const DEFAULT_MAX_RESULT_BYTES = 64 * 1024;

function providerName(id) {
  return id.replaceAll('.', '_').replaceAll('-', '_');
}

function withoutDialect(schema) {
  const { $schema: _dialect, ...parameters } = schema;
  return parameters;
}

function legacySchema(definition = {}) {
  if (Array.isArray(definition.enum)) return z.enum(definition.enum);
  if (definition.type === 'string') {
    let schema = z.string();
    if (Number.isFinite(definition.minLength)) schema = schema.min(definition.minLength);
    if (Number.isFinite(definition.maxLength)) schema = schema.max(definition.maxLength);
    return schema;
  }
  if (definition.type === 'integer') {
    let schema = z.number().int();
    if (Number.isFinite(definition.minimum)) schema = schema.min(definition.minimum);
    if (Number.isFinite(definition.maximum)) schema = schema.max(definition.maximum);
    return schema;
  }
  if (definition.type === 'number') {
    let schema = z.number();
    if (Number.isFinite(definition.minimum)) schema = schema.min(definition.minimum);
    if (Number.isFinite(definition.maximum)) schema = schema.max(definition.maximum);
    return schema;
  }
  if (definition.type === 'boolean') return z.boolean();
  if (definition.type === 'array') {
    let schema = z.array(legacySchema(definition.items || {}));
    if (Number.isFinite(definition.minItems)) schema = schema.min(definition.minItems);
    if (Number.isFinite(definition.maxItems)) schema = schema.max(definition.maxItems);
    return schema;
  }
  if (definition.type === 'object' || definition.properties) {
    const required = new Set(definition.required || []);
    const shape = Object.fromEntries(Object.entries(definition.properties || {}).map(([key, value]) => {
      const schema = legacySchema(value);
      return [key, required.has(key) ? schema : schema.optional()];
    }));
    return z.object(shape).strict();
  }
  return z.unknown();
}

function parseForTool(schema, value, id, kind) {
  try {
    return parseContract(schema, value, `工具 ${id} ${kind}无效`);
  } catch (error) {
    if (error instanceof ValidationError) {
      throw new ValidationError(`工具 ${id} ${kind}无效：${error.message}`, error.issues);
    }
    throw error;
  }
}

function serializedBytes(value, id) {
  try {
    return Buffer.byteLength(JSON.stringify(value), 'utf8');
  } catch {
    throw new ValidationError(`工具 ${id} 返回值无法序列化`);
  }
}

/**
 * Provider-neutral tool boundary for the single Agent Runtime. Zod is the
 * executable source of truth; JSON Schema is derived for model providers.
 */
export function createToolRegistry() {
  const tools = new Map();
  const providerNames = new Map();

  return Object.freeze({
    register(definition) {
      const id = String(definition?.id || '').trim();
      if (!TOOL_ID.test(id)) throw new Error('工具 id 必须是点分语义名称');
      if (tools.has(id)) throw new Error(`工具 ${id} 已注册`);
      if (typeof definition.execute !== 'function') throw new Error(`工具 ${id} 缺少 execute`);
      const effect = definition.effect || 'read';
      if (!EFFECTS.has(effect)) throw new Error(`工具 ${id} 的 effect 无效`);
      const name = providerName(id);
      if (providerNames.has(name)) throw new Error(`工具 providerName ${name} 与 ${providerNames.get(name)} 冲突`);

      const hasInputSchema = definition.inputSchema && typeof definition.inputSchema.parse === 'function';
      const inputSchema = hasInputSchema
        ? definition.inputSchema
        : legacySchema(definition.parameters || { type: 'object', properties: {} });
      const parameters = hasInputSchema
        ? withoutDialect(z.toJSONSchema(inputSchema))
        : (definition.parameters || withoutDialect(z.toJSONSchema(inputSchema)));
      const resultSchema = definition.resultSchema && typeof definition.resultSchema.parse === 'function'
        ? definition.resultSchema
        : AgentToolResultSchema;
      const maxResultBytes = Math.max(1_024, Math.min(
        Number(definition.maxResultBytes) || DEFAULT_MAX_RESULT_BYTES,
        1024 * 1024,
      ));
      const record = Object.freeze({
        id,
        providerName: name,
        description: String(definition.description || '').trim(),
        effect,
        researchOnly: Boolean(definition.researchOnly),
        parameters,
        inputSchema,
        resultSchema,
        maxResultBytes,
        execute: definition.execute,
      });
      tools.set(id, record);
      providerNames.set(name, id);
      return { id: record.id, description: record.description, effect: record.effect, parameters: record.parameters };
    },
    list() {
      return [...tools.values()].map(({ id, providerName: name, description, effect, parameters, researchOnly }) => ({
        id, name, description, effect, parameters, researchOnly,
      }));
    },
    async execute(id, input, context) {
      const tool = tools.get(id);
      if (!tool) throw new Error(`未注册的工具 ${id}`);
      const parsedInput = parseForTool(tool.inputSchema, input ?? {}, id, '参数');
      const rawResult = await tool.execute(parsedInput, context);
      const result = parseForTool(tool.resultSchema, rawResult, id, '结果');
      const bytes = serializedBytes(result, id);
      if (bytes > tool.maxResultBytes) {
        throw new ValidationError(`工具 ${id} 结果超过 ${tool.maxResultBytes} 字节预算`);
      }
      return result;
    },
  });
}
