import fs from 'node:fs';
import path from 'node:path';
import Database from 'better-sqlite3';
import {resolveInstanceConfig} from '../packages/instance/src/index.js';
import {createStore} from '../packages/database/src/index.js';
import {createAiCenterServer} from '../apps/web/src/server.js';

const args=process.argv.slice(2),arg=name=>args.includes(name) ? args[args.indexOf(name)+1] : undefined;
if(!args.includes('--serve')) {console.log('npm run tree:preview -- --serve --replay .ai-data/tree-replay/acceptance-2026-10-06 [--port 8791]');process.exit(0);}
const replay=path.resolve(arg('--replay') || '.ai-data/tree-replay/acceptance-2026-10-06');
const instance=resolveInstanceConfig({repositoryRoot:process.cwd()});
const directory=path.join(replay,'preview'),dbPath=path.join(directory,'ai-center.db');fs.mkdirSync(directory,{recursive:true});
if(path.resolve(dbPath)===path.resolve(instance.databasePath))throw new Error('预览不能指向生产数据库');
if(!fs.existsSync(dbPath)) {
  const source=new Database(instance.databasePath,{readonly:true,fileMustExist:true});
  try {await source.backup(dbPath);}finally{source.close();}
}
// Forward migrations run on the isolated online backup only; neither source DB is mutated.
const migrated=createStore(dbPath);migrated.close();
const target=new Database(dbPath),source=new Database(path.join(replay,'ai-center.db'),{readonly:true,fileMustExist:true});
try {
  target.transaction(()=>{
    for(const table of ['information_tree_nodes','information_tree_editions','information_tree_heads','information_tree_information_heads','information_tree_policies','model_usage_index']) {
      if(!source.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name=?").get(table))continue;
      const rows=source.prepare(`SELECT * FROM ${table}`).all();
      for(const row of rows) {
        const keys=Object.keys(row);target.prepare(`INSERT OR REPLACE INTO ${table} (${keys.join(',')}) VALUES (${keys.map(()=>'?').join(',')})`).run(...keys.map(k=>row[k]));
      }
    }
  })();
} finally {target.close();source.close();}
const app=createAiCenterServer({host:'127.0.0.1',port:Number(arg('--port') || 8791),dataDirectory:directory});
const address=await app.listen();console.log(`隔离真实数据预览：${address.localUrl}/#report → 三层浓缩树`);
for(const signal of ['SIGINT','SIGTERM'])process.on(signal,async()=>{await app.close();process.exit(0);});
