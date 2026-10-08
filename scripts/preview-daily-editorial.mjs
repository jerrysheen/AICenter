import {createServer} from 'node:http';
import {readFileSync} from 'node:fs';
import {join} from 'node:path';
import Database from 'better-sqlite3';

const port = Number(process.argv.find(item => item.startsWith('--port='))?.slice(7) || 8793);
const root = '.ai-data/daily-editorial-preview';
const editorial = JSON.parse(readFileSync(join(root, 'editorial.json'), 'utf8'));
const db = new Database('data/ai-center.db', {readonly: true, fileMustExist: true});
const nodeById = db.prepare('SELECT value_json FROM information_tree_nodes WHERE workspace_id=? AND id=?');
const files = {
  '/styles.css': ['apps/web/public/styles.css', 'text/css; charset=utf-8'],
  '/information-tree.js': ['apps/web/public/information-tree.js', 'text/javascript; charset=utf-8'],
};
const page = `<!doctype html><html lang="zh-CN"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>日报研究稿预览</title><link rel="stylesheet" href="/styles.css"></head><body><div id="app"></div><script type="module">
import {createInformationTreePage} from '/information-tree.js';
const editorial = await fetch('/editorial.json').then(response => response.json());
const edition = {id:'preview-edition', layer:'daily', window:editorial.window, status:editorial.status, roots:[], inputIds:[], pendingIds:[], missingHours:editorial.coverage.incompleteHours, generatedAt:editorial.generatedAt};
const page = createInformationTreePage({
  api: async (path) => {
    const url = new URL(path, location.origin);
    if (url.pathname.endsWith('/editorial')) return {ok:true, editorial};
    if (url.pathname.endsWith('/node')) return fetch('/node?id=' + encodeURIComponent(url.searchParams.get('id'))).then(response => response.json());
    if (url.pathname.endsWith('/children')) return {children:[]};
    return {};
  },
  loadTreeManifest: async () => ({timezone:'Asia/Shanghai', pipeline:'tree-v3', directions:{}, days:[{edition}], hours:[], information:[]}),
  active: () => true,
  session: () => true,
});
await page.mount(document.querySelector('#app'), {manifest:{timezone:'Asia/Shanghai', pipeline:'tree-v3', directions:{}, days:[{edition}], hours:[], information:[]}});
</script></body></html>`;

createServer((request, response) => {
  const url = new URL(request.url, 'http://127.0.0.1');
  if (url.pathname === '/editorial.json') {
    response.writeHead(200, {'Content-Type': 'application/json; charset=utf-8'});
    response.end(JSON.stringify(editorial));
    return;
  }
  if (url.pathname === '/node') {
    const row = nodeById.get('local', url.searchParams.get('id') || '');
    response.writeHead(row ? 200 : 404, {'Content-Type': 'application/json; charset=utf-8'});
    response.end(JSON.stringify(row ? {ok:true, node:JSON.parse(row.value_json)} : {ok:false}));
    return;
  }
  if (url.pathname === '/' || url.pathname === '/index.html') {
    response.writeHead(200, {'Content-Type': 'text/html; charset=utf-8'});
    response.end(page);
    return;
  }
  const file = files[url.pathname];
  if (!file) {
    response.writeHead(404);
    response.end('not found');
    return;
  }
  response.writeHead(200, {'Content-Type': file[1]});
  response.end(readFileSync(file[0]));
}).listen(port, '127.0.0.1', () => {
  console.log(`preview http://127.0.0.1:${port}/`);
});
