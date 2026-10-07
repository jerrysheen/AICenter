import Database from 'better-sqlite3';
import {resolveInstanceConfig} from '../packages/instance/src/index.js';
import {createStore} from '../packages/database/src/index.js';
import {PrepareTreeInformationInputSchema} from '../packages/contracts/src/information-tree.js';
import {enqueueTreePreparation} from '../packages/runtime/src/information-tree-module.js';
const args=process.argv.slice(2);
if(!args.includes('--queue') || !args.includes('--ids')){console.log('node --env-file=.env scripts/queue-tree-information.mjs --queue --ids feed:ID,media:ID（最多100条；须先正常完成本轮升级）');process.exit(0);}
const input=PrepareTreeInformationInputSchema.parse({sourceIds:args[args.indexOf('--ids')+1].split(',')});
if(input.sourceIds.some(id=>!/^feed:|^media:/.test(id)))throw new Error('只接受现有feed/media材料身份');
if(process.env.AI_CENTER_INFORMATION_PIPELINE!=='tree-v3')throw new Error('需已启用tree-v3');
const instance=resolveInstanceConfig({repositoryRoot:process.cwd()}),db=new Database(instance.databasePath,{readonly:true,fileMustExist:true});
try{if(!db.prepare("SELECT name FROM sqlite_master WHERE name='information_tree_information_heads'").get())throw new Error('请先正常重载升级到迁移43；此命令不会替生产执行迁移');}finally{db.close();}
const store=createStore(instance.databasePath);
try{console.log(JSON.stringify({queued:enqueueTreePreparation(store,input.workspaceId,input.sourceIds).map(j=>j.id)}));}finally{store.close();}
