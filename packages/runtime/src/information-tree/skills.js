import {readFileSync} from 'node:fs';
import {createHash} from 'node:crypto';
import {treeResponseProtocol,TREE_VALIDATOR_VERSION} from '../../../contracts/src/information-tree.js';
import {buildHarnessPrompt} from '../../../harness/src/prompt.js';

export function loadArticleNormalizeSkills() {
  const skills=loadInformationTreeSkills();
  const instruction=readFileSync(new URL('./skills/information-editor.skill.md',import.meta.url),'utf8');
  const injected=instruction+'\n'+treeResponseProtocol('article');
  const version=createHash('sha256').update(buildHarnessPrompt({closedContext:true,taskInstruction:injected,message:'{INPUT}'})+'article-normalize-v1').digest('hex');
  // Title guidance changed. Completed article-normalize-v1 nodes stay reusable and are not rewritten.
  const compatiblePromptHashes=['3829fba8ad65961b3f30050ea24a3c27f4db2bfd81fb70894e0840ffadd740c2','6cb033d1f6bc956f98c8146812b9f1d25a281943eded9c6e6c7494bcf7d866d6'];
  return {...skills,information:{instruction,injected,requestPrefix:buildHarnessPrompt({closedContext:true,taskInstruction:injected,message:''}),version,validatorVersion:'article-normalize-v1',compatiblePromptHashes}};
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
