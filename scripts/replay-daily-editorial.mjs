import {mkdirSync, readFileSync, writeFileSync} from 'node:fs';
import {join} from 'node:path';
import Database from 'better-sqlite3';
import {buildDailyEditorial, clusterInformationNodes, collectDailyEditorialMaterials} from '../packages/domain/src/daily-editorial.js';

const window = {startAt: 1791331200000, endAt: 1791417600000};
const outputDir = join('.ai-data', 'daily-editorial-preview');
const stamp = ms => new Date(ms).toLocaleString('sv-SE', {timeZone: 'Asia/Shanghai'});

function repositoryFor(db) {
  return {
    list(workspace, startAt, endAt, layer) {
      return db.prepare('SELECT published_id FROM information_tree_heads WHERE workspace_id=? AND layer=? AND start_at>=? AND start_at<? ORDER BY start_at DESC')
        .all(workspace, layer, startAt, endAt)
        .map(row => ({edition: row.published_id ? JSON.parse(db.prepare('SELECT value_json FROM information_tree_editions WHERE workspace_id=? AND id=?').get(workspace, row.published_id).value_json) : null}));
    },
    getNode(workspace, id) {
      const row = db.prepare('SELECT value_json FROM information_tree_nodes WHERE workspace_id=? AND id=?').get(workspace, id);
      return row ? JSON.parse(row.value_json) : null;
    },
  };
}

const db = new Database('data/ai-center.db', {readonly: true, fileMustExist: true});
const materials = collectDailyEditorialMaterials(repositoryFor(db), 'local', window);
if (stamp(window.startAt) !== '2026-10-07 08:00:00' || stamp(window.endAt) !== '2026-10-08 08:00:00') {
  throw new Error(`窗口标签不符: ${stamp(window.startAt)} → ${stamp(window.endAt)}`);
}
const catalog = JSON.parse(readFileSync(new URL('../config/tags.json', import.meta.url), 'utf8'));
const directionByTag = catalog.reading.directionByTag;
mkdirSync(outputDir, {recursive: true});
const clusters = clusterInformationNodes(materials.nodes, directionByTag);
const keywords = ['原油', '油价', '美联储', '通胀', '收益率', '融资', '数据中心', '算力', '海缆', '海底', '讣告', '去世', '外包', '电缆', '审批', '电力', '天然气'];
const lines = [
  `窗口 ${stamp(window.startAt)} → ${stamp(window.endAt)}`,
  `小时刊期 ${materials.hours.length}，小时模块 ${materials.modules.length}，信息节点 ${materials.nodes.length}，事件 ${clusters.length}`,
  `未完成小时 ${materials.incompleteHours.length}，待补 ${materials.pendingIds.length}，未读取 ${materials.unprocessedIds.length}`,
  '',
];
const interesting = clusters.filter(cluster => cluster.sourceNodeIds.length > 1 || keywords.some(word => `${cluster.title}\n${cluster.facts.join('\n')}`.includes(word)));
for (const cluster of interesting) {
  lines.push(`## ${cluster.eventId} ${cluster.direction} ${cluster.status} x${cluster.sourceNodeIds.length}`);
  lines.push(cluster.title);
  for (const fact of cluster.facts) lines.push(`- ${fact}`);
  lines.push('');
}
lines.push('# 其余标题');
for (const cluster of clusters) {
  if (interesting.includes(cluster)) continue;
  lines.push(`${cluster.eventId}\t${cluster.direction}\t${cluster.title}`);
}
writeFileSync(join(outputDir, 'catalog.txt'), lines.join('\n'), 'utf8');
writeFileSync(join(outputDir, 'clusters.json'), JSON.stringify(clusters.map(({nodes, ...cluster}) => cluster), null, 2));
const overlayPath = join(outputDir, 'overlay.json');
let editorial = null;
try {
  const overlay = JSON.parse(readFileSync(overlayPath, 'utf8'));
  editorial = buildDailyEditorial({
    materials,
    directionByTag,
    overlay,
    meta: {reportDate: '2026-10-08', timezone: 'Asia/Shanghai', model: 'cursor-grok-4.7', calls: 1, inputTokens: null, outputTokens: null, cost: null, generatedAt: Date.now()},
  });
  writeFileSync(join(outputDir, 'editorial.json'), JSON.stringify(editorial, null, 2));
} catch (error) {
  if (error.code !== 'ENOENT') throw error;
}
const daily = db.prepare("SELECT published_id FROM information_tree_heads WHERE workspace_id='local' AND layer='daily' AND start_at=?").get(window.startAt);
let oldTitles = [];
if (daily?.published_id) {
  const edition = JSON.parse(db.prepare('SELECT value_json FROM information_tree_editions WHERE id=?').get(daily.published_id).value_json);
  oldTitles = edition.roots.map(id => JSON.parse(db.prepare('SELECT value_json FROM information_tree_nodes WHERE id=?').get(id).value_json)).map(node => node.title);
}
writeFileSync(join(outputDir, 'old-daily-titles.json'), JSON.stringify(oldTitles, null, 2));
console.log(lines.slice(0, 4).join('\n'));
console.log(editorial ? `EDITORIAL ${editorial.id} ${editorial.status} events=${editorial.coverage.eventCount} body=${editorial.coverage.inBodyEventCount} index=${editorial.coverage.indexOnlyEventCount}` : 'OVERLAY_MISSING');
console.log(join(outputDir, 'catalog.txt'));
