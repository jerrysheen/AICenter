import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { ValidationError } from '../../contracts/src/index.js';

const ID_PATTERN = /^[a-z][a-z0-9-]{0,63}$/;
const VERSION_PATTERN = /^\d+\.\d+\.\d+$/;

function asObject(value) {
  return value && typeof value === 'object' && !Array.isArray(value) ? value : null;
}

function insideRoot(root, relativeFile) {
  const relative = String(relativeFile || '').trim().replaceAll('\\', '/');
  if (!relative || path.isAbsolute(relative) || relative.split('/').includes('..')) return '';
  const resolved = path.resolve(root, relative);
  const fromRoot = path.relative(root, resolved);
  if (!fromRoot || fromRoot.startsWith('..') || path.isAbsolute(fromRoot)) return '';
  return resolved;
}

function loadEntries(root) {
  let parsed;
  try {
    parsed = JSON.parse(readFileSync(path.join(root, 'registry.json'), 'utf8'));
  } catch {
    throw new ValidationError('分析方法目录不可用', ['selectedSkills']);
  }
  if (!Array.isArray(parsed?.skills)) throw new ValidationError('分析方法目录不可用', ['selectedSkills']);
  const seen = new Set();
  return parsed.skills.map((item) => {
    const source = asObject(item) || {};
    const id = String(source.id || '').trim();
    const version = String(source.version || '').trim();
    const key = `${id}@${version}`;
    if (seen.has(key)) throw new ValidationError(`分析方法版本重复：${key}`, ['selectedSkills']);
    seen.add(key);
    const file = insideRoot(root, source.contentFile);
    const expected = String(source.contentHash || '').trim().toLowerCase();
    let actual = '';
    let guidance = '';
    if (file) {
      try {
        const bytes = readFileSync(file);
        actual = createHash('sha256').update(bytes).digest('hex');
        guidance = bytes.toString('utf8').replace(/^\uFEFF/, '').trim();
      } catch {
        actual = '';
        guidance = '';
      }
    }
    const hashOk = Boolean(file && expected && actual === expected && guidance);
    return {
      id,
      version,
      name: String(source.name || '').trim(),
      description: String(source.description || '').trim(),
      selectable: source.selectable === true,
      hashOk,
      contentHash: hashOk ? actual : '',
      guidance: hashOk ? guidance : '',
    };
  });
}

function findEntry(entries, id, version) {
  return entries.find((item) => item.id === id && item.version === version) || null;
}

export function createAnalysisSkillCatalog({ rootDirectory } = {}) {
  if (!rootDirectory) throw new Error('analysis skill catalog directory is required');
  const root = path.resolve(rootDirectory);
  return Object.freeze({
    listSelectable() {
      return loadEntries(root)
        .filter((item) => item.selectable && item.hashOk && item.name && ID_PATTERN.test(item.id) && VERSION_PATTERN.test(item.version))
        .map((item) => ({
          id: item.id,
          version: item.version,
          name: item.name,
          description: item.description,
        }));
    },
    describe(selection) {
      const source = asObject(selection);
      if (!source) return null;
      const entry = findEntry(loadEntries(root), String(source.id || '').trim(), String(source.version || '').trim());
      if (!entry?.hashOk || !entry.name) return null;
      return { id: entry.id, version: entry.version, name: entry.name, description: entry.description };
    },
    activate(selected) {
      if (!Array.isArray(selected)) throw new ValidationError('分析方法选择无效', ['selectedSkills']);
      if (selected.length > 1) throw new ValidationError('本轮最多选择一个分析方法', ['selectedSkills']);
      if (!selected.length) return [];
      const source = asObject(selected[0]);
      if (!source) throw new ValidationError('分析方法选择无效', ['selectedSkills']);
      const extra = Object.keys(source).filter((key) => key !== 'id' && key !== 'version');
      if (extra.length) throw new ValidationError('分析方法只能提交编号和版本', ['selectedSkills']);
      const id = String(source.id || '').trim();
      const version = String(source.version || '').trim();
      if (!ID_PATTERN.test(id) || !VERSION_PATTERN.test(version)) {
        throw new ValidationError('分析方法编号或版本无效', ['selectedSkills']);
      }
      const entry = findEntry(loadEntries(root), id, version);
      if (!entry) throw new ValidationError('未知的分析方法版本，不会改用其他版本', ['selectedSkills']);
      if (!entry.hashOk) throw new ValidationError('已发布分析方法内容与登记不一致', ['selectedSkills']);
      if (!entry.selectable) throw new ValidationError('该分析方法版本不允许选择', ['selectedSkills']);
      return [{
        id: entry.id,
        version: entry.version,
        name: entry.name,
        description: entry.description,
        contentHash: entry.contentHash,
        guidance: entry.guidance,
      }];
    },
  });
}
