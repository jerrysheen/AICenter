import path from 'node:path';
import {createHarnessAgentRuntime} from './harness-agent-runtime.js';

// Parallel closed article calls reuse the frozen adapter with isolated mutable
// execution state. Ask and reports retain their original serialized context.
export function createHarnessExecutionRuntime(options) {
  const count=options.articleAdmission?.policy?.concurrency || 1;
  const main=createHarnessAgentRuntime(options);
  if(count===1)return main;
  const lanes=Array.from({length:count},(_,index)=>({load:0,runtime:null,index}));
  let closed=false;
  return Object.freeze({
    kind:'harness',supportsExecutionAdmission:true,
    availableTools:input=>main.availableTools(input),
    async run(input={}) {
      if(closed)throw new Error('Harness 已关闭');
      if(input.closedContext!==true || input.closedTask!=='article-normalize')return main.run(input);
      const lane=lanes.reduce((a,b)=>a.load<=b.load ? a : b);
      lane.runtime ||= createHarnessAgentRuntime({...options,runtimeDirectory:path.join(options.runtimeDirectory,`article-lane-${lane.index+1}`)});
      lane.load++;
      try{return await lane.runtime.run(input);}finally{lane.load--;}
    },
    async close(){closed=true;await Promise.allSettled([main.close(),...lanes.filter(l=>l.runtime).map(l=>l.runtime.close())]);},
  });
}
