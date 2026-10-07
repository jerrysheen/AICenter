import {readFileSync} from 'node:fs';
import {createHash} from 'node:crypto';
import {treeResponseProtocol,TREE_VALIDATOR_VERSION} from '../../../contracts/src/information-tree.js';
import {buildHarnessPrompt} from '../../../harness/src/prompt.js';

export function loadArticleNormalizeSkills() {
  const skills=loadInformationTreeSkills();
  const instruction=readFileSync(new URL('./skills/information-editor.skill.md',import.meta.url),'utf8');
  const injected=instruction+'\n'+treeResponseProtocol('article');
  const version=createHash('sha256').update(buildHarnessPrompt({closedContext:true,taskInstruction:injected,message:'{INPUT}'})+'article-normalize-v1').digest('hex');
  return {...skills,information:{instruction,injected,requestPrefix:buildHarnessPrompt({closedContext:true,taskInstruction:injected,message:''}),version,validatorVersion:'article-normalize-v1'}};
}
export function loadInformationTreeSkills() {
  return Object.fromEntries(['information','hourly','daily'].map(stage=>{
    const instruction=readFileSync(new URL(`./skills/${stage}.md`,import.meta.url),'utf8');
    const injected=instruction+'\n'+treeResponseProtocol(stage);
    const effectivePromptHash=createHash('sha256').update(buildHarnessPrompt({closedContext:true,taskInstruction:injected,message:'{INPUT}'})+TREE_VALIDATOR_VERSION).digest('hex');
    return [stage,{instruction,injected,version:effectivePromptHash,effectivePromptHash,validatorVersion:TREE_VALIDATOR_VERSION,
      ...(stage==='information' ? {compatiblePromptHashes:['4935e6e8687998ff6e31481bf12aa56564e303ce286af730f827dc75a8361647']} : {})}];
  }));
}
