import { unzip } from './zip-archive.js';

function decodeXmlText(value) {
  return String(value || '')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&amp;/g, '&');
}

function attribute(tag, name) {
  const match = tag.match(new RegExp(`(?:^|\\s)${name}="([^"]*)"`));
  return match ? decodeXmlText(match[1]) : '';
}

function columnIndex(cellRef) {
  const letters = String(cellRef).match(/^[A-Z]+/i)?.[0]?.toUpperCase() || 'A';
  let index = 0;
  for (const char of letters) index = index * 26 + (char.charCodeAt(0) - 64);
  return index - 1;
}

function rowIndex(cellRef) {
  return Number(String(cellRef).match(/\d+/)?.[0] || 0);
}

function parseSharedStrings(xml) {
  const strings = [];
  const blocks = xml.match(/<si\b[^>]*>[\s\S]*?<\/si>/g) || [];
  for (const block of blocks) {
    const parts = [...block.matchAll(/<t(?:\s[^>]*)?>([\s\S]*?)<\/t>/g)].map((match) => decodeXmlText(match[1]));
    strings.push(parts.join(''));
  }
  return strings;
}

function cellValue(inner, type, strings) {
  if (type === 's') {
    const index = Number((inner.match(/<v[^>]*>([\s\S]*?)<\/v>/) || [])[1]);
    return Number.isInteger(index) ? strings[index] ?? '' : '';
  }
  if (type === 'inlineStr' || type === 'str') {
    const text = (inner.match(/<t(?:\s[^>]*)?>([\s\S]*?)<\/t>/) || inner.match(/<v[^>]*>([\s\S]*?)<\/v>/) || [])[1];
    return decodeXmlText(text || '');
  }
  const numeric = (inner.match(/<v[^>]*>([\s\S]*?)<\/v>/) || [])[1];
  if (numeric === undefined) return '';
  const parsed = Number(numeric);
  return Number.isFinite(parsed) ? parsed : decodeXmlText(numeric);
}

function parseSheet(xml, strings) {
  const rows = new Map();
  const cells = xml.match(/<c\b[^>]*\/>|<c\b[^>]*>[\s\S]*?<\/c>/g) || [];
  for (const cell of cells) {
    const open = cell.match(/^<c\b[^>]*/)[0];
    const ref = attribute(open, 'r');
    if (!ref) continue;
    const type = attribute(open, 't');
    const inner = cell.endsWith('/>') ? '' : cell.replace(/^<c\b[^>]*>/, '').replace(/<\/c>$/, '');
    const row = rowIndex(ref);
    const column = columnIndex(ref);
    if (!rows.has(row)) rows.set(row, {});
    rows.get(row)[column] = cellValue(inner, type, strings);
  }
  const indexes = [...rows.keys()].sort((left, right) => left - right);
  const width = Math.max(0, ...[...rows.values()].flatMap((row) => Object.keys(row).map(Number))) + 1;
  return indexes.map((index) => {
    const row = rows.get(index);
    return Array.from({ length: width }, (_, column) => row[column] ?? '');
  });
}

function parseRelationships(xml) {
  const map = new Map();
  const tags = xml.match(/<Relationship\b[^>]*\/?>/g) || [];
  for (const tag of tags) map.set(attribute(tag, 'Id'), attribute(tag, 'Target'));
  return map;
}

function resolveSheetPath(target) {
  const normalized = String(target || '').replaceAll('\\', '/').replace(/^\//, '');
  if (normalized.startsWith('xl/')) return normalized;
  return `xl/${normalized.replace(/^\.\//, '')}`;
}

export function readWorkbookSheets(buffer) {
  const files = unzip(buffer);
  const text = (name) => (files.get(name) ? files.get(name).toString('utf8') : '');
  const strings = files.has('xl/sharedStrings.xml') ? parseSharedStrings(text('xl/sharedStrings.xml')) : [];
  const relationships = parseRelationships(text('xl/_rels/workbook.xml.rels'));
  const sheets = {};
  const sheetTags = text('xl/workbook.xml').match(/<sheet\b[^>]*\/?>/g) || [];
  for (const tag of sheetTags) {
    const name = attribute(tag, 'name');
    const relId = attribute(tag, 'r:id') || attribute(tag, 'id');
    const target = relationships.get(relId);
    if (!name || !target) continue;
    sheets[name] = parseSheet(text(resolveSheetPath(target)), strings);
  }
  return sheets;
}
