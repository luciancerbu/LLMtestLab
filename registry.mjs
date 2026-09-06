import fs from 'node:fs';
import path from 'node:path';
import {createHash} from 'node:crypto';
import {PROMPTS,ROOT} from './settings.mjs';

const readJson=file=>JSON.parse(fs.readFileSync(file,'utf8'));
const promptFile=path.join(PROMPTS,'registry.json');
const suiteFile=path.join(ROOT,'suites','registry.json');

export function promptRegistry(){
 return readJson(promptFile).map(entry=>{
  if(!/^[a-z0-9-]+$/.test(entry.id)||!['easy','medium','hard','stress'].includes(entry.difficulty))throw Error('Invalid prompt registry entry: '+entry.id);
  const absolute=path.resolve(PROMPTS,entry.file);if(!absolute.startsWith(PROMPTS+path.sep)||!fs.existsSync(absolute))throw Error('Prompt file missing: '+entry.file);
  const text=fs.readFileSync(absolute,'utf8'),hash=createHash('sha256').update(text).digest('hex');
  return {...entry,hash,hashAlgorithm:'sha256',text};
 });
}

export function suiteRegistry(){
 const prompts=new Map(promptRegistry().map(prompt=>[prompt.id,prompt]));
 return readJson(suiteFile).map(suite=>{
  if(!/^[a-z0-9-]+$/.test(suite.id)||!Number.isInteger(suite.repetitions)||suite.repetitions<1||suite.repetitions>10)throw Error('Invalid suite registry entry: '+suite.id);
  const cases=[];for(let repetition=1;repetition<=suite.repetitions;repetition++)for(const id of suite.prompts){const prompt=prompts.get(id);if(!prompt)throw Error('Unknown prompt in suite '+suite.id+': '+id);cases.push({id:suite.repetitions===1?id:`${id}-r${repetition}`,promptId:id,name:prompt.name+(suite.repetitions===1?'':` · Run ${repetition}`),promptFile:prompt.file,promptVersion:prompt.version,promptHash:prompt.hash,repetition})}
  return {...suite,cases};
 });
}

export function modelMetadata(model,configuration=null){
 const source=model.file||model.modelFile||model.id,match=String(source).match(/(?:^|[-_.])(IQ\d(?:_[A-Z0-9]+)*|Q\d(?:_[A-Z0-9]+)*|F16|BF16|NVFP4)(?:[-_.]|$)/i);
 const provider=model.runtime==='llama.cpp'?'llama.cpp':model.runtime||'ollama';
 return {id:model.id,name:model.name,provider,quantization:model.quantization||match?.[1]?.toUpperCase()||'unknown',declaredContextWindow:model.contextWindow||null,runContextWindow:configuration?.contextWindow||null,hardware:model.hardware||{platform:process.platform,architecture:process.arch,accelerator:provider==='llama.cpp'?'Apple Silicon GPU':'provider-managed'}};
}
