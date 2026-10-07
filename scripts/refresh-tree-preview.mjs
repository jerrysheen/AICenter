import path from 'node:path';
import Database from 'better-sqlite3';
const args=process.argv.slice(2),index=args.indexOf('--replay');
if(index<0)throw new Error('必须明确指定隔离回放目录 --replay');
const replay=path.resolve(args[index+1]),root=path.resolve('.ai-data');
if(!replay.startsWith(root+path.sep))throw new Error('仅支持仓库.ai-data中的隔离回放');
const targetPath=path.join(replay,'preview','ai-center.db'),sourcePath=path.join(replay,'ai-center.db');
if(targetPath===sourcePath)throw new Error('预览和回放库必须不同');
const target=new Database(targetPath,{fileMustExist:true}),source=new Database(sourcePath,{readonly:true,fileMustExist:true});
try{target.transaction(()=>{
  // Remove only the isolated backup's publication pointers, keeping saved originals and immutable history.
  for(const table of ['information_tree_heads','information_tree_information_heads','information_tree_policies'])target.prepare(`DELETE FROM ${table}`).run();
  for(const table of ['information_tree_nodes','information_tree_editions','information_tree_heads','information_tree_information_heads','information_tree_policies','model_usage_index'])for(const row of source.prepare(`SELECT * FROM ${table}`).all()){
    const keys=Object.keys(row);target.prepare(`INSERT OR REPLACE INTO ${table} (${keys.join(',')}) VALUES (${keys.map(()=>'?').join(',')})`).run(...keys.map(k=>row[k]));
  }
})();console.log('仅更新隔离预览的树和用量索引');}finally{target.close();source.close();}
