// LIKE 带 ESCAPE 时用不上 source_url 索引。前缀改成 NOCASE 范围，批量查询走索引。

const RANGE_TABLE = 'dedup_url_prefix_ranges';

export function prefixUpperBound(prefix) {
  const chars = Array.from(String(prefix || ''));
  if (!chars.length) return '';
  for (let index = chars.length - 1; index >= 0; index -= 1) {
    const code = chars[index].codePointAt(0);
    if (code < 0x10ffff) {
      chars[index] = String.fromCodePoint(code + 1);
      return chars.slice(0, index + 1).join('');
    }
  }
  return '';
}

function rangesFor(prefixes) {
  const ranges = [];
  const seen = new Set();
  for (const prefix of prefixes || []) {
    const lower = String(prefix || '');
    if (!lower || seen.has(lower)) continue;
    const upper = prefixUpperBound(lower);
    if (!upper) continue;
    seen.add(lower);
    ranges.push([lower, upper]);
  }
  return ranges;
}

function lookupSql({ indexName, tableSql, tailJoins, select, urlColumn, workspaceColumn, extraWhere }) {
  const joins = tailJoins ? `\n${tailJoins}` : '';
  const filter = extraWhere ? ` AND ${extraWhere}` : '';
  return `SELECT * FROM (
    SELECT r.lower AS match_prefix, ${select},
      ROW_NUMBER() OVER (PARTITION BY r.lower ORDER BY length(${urlColumn}) ASC) AS dedup_prefix_rank
    FROM ${RANGE_TABLE} r
    JOIN ${tableSql} INDEXED BY ${indexName}
      ON ${workspaceColumn} = ?
     AND ${urlColumn} >= r.lower COLLATE NOCASE
     AND ${urlColumn} < r.upper COLLATE NOCASE${filter}${joins}
  ) WHERE dedup_prefix_rank <= ?`;
}

export function rowsByUrlPrefixes(database, spec) {
  const ranges = rangesFor(spec.prefixes);
  if (!ranges.length) return [];
  const limit = Math.max(1, Math.min(Number(spec.perPrefixLimit) || 40, 40));
  database.exec(`CREATE TEMP TABLE IF NOT EXISTS ${RANGE_TABLE} (
    lower TEXT PRIMARY KEY,
    upper TEXT NOT NULL
  )`);
  const clear = database.prepare(`DELETE FROM ${RANGE_TABLE}`);
  const insert = database.prepare(`INSERT INTO ${RANGE_TABLE} (lower, upper) VALUES (?, ?)`);
  const query = database.prepare(lookupSql(spec));
  const rows = database.transaction(() => {
    clear.run();
    for (const range of ranges) insert.run(range[0], range[1]);
    return query.all(spec.workspaceId, limit);
  })();
  return rows.map(({ dedup_prefix_rank, ...row }) => row);
}

export function explainPrefixLookup(database, { indexName, tableSql, urlColumn, workspaceColumn }) {
  return database.prepare(`EXPLAIN QUERY PLAN
    SELECT ${urlColumn}
    FROM ${tableSql} INDEXED BY ${indexName}
    WHERE ${workspaceColumn} = ?
      AND ${urlColumn} >= ? COLLATE NOCASE
      AND ${urlColumn} < ? COLLATE NOCASE`)
    .all('local', 'https://example.com/a', 'https://example.com/b')
    .map((row) => String(row.detail || ''));
}
