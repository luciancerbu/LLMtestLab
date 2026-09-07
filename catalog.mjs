import fs from 'node:fs';
import path from 'node:path';
export const modelDir=path.join(import.meta.dirname,'models'),configDir=path.join(import.meta.dirname,'configs');
const ggufCache=new Map();
function ggufContextWindow(file){
 try{
  const stat=fs.statSync(file),cached=ggufCache.get(file);if(cached?.size===stat.size&&cached?.mtimeMs===stat.mtimeMs)return cached.contextWindow;
  const fd=fs.openSync(file,'r'),buffer=Buffer.alloc(Math.min(stat.size,1024*1024));try{fs.readSync(fd,buffer,0,buffer.length,0)}finally{fs.closeSync(fd)}
  if(buffer.toString('ascii',0,4)!=='GGUF')return null;let offset=8;const u32=()=>{const value=buffer.readUInt32LE(offset);offset+=4;return value},u64=()=>{const value=Number(buffer.readBigUInt64LE(offset));offset+=8;return value},text=()=>{const length=u64();const value=buffer.toString('utf8',offset,offset+length);offset+=length;return value};
  u64();const count=u64(),sizes=[1,1,2,2,4,4,4,1,null,null,8,8,8];const value=type=>{if(type===8)return text();if(type===9){const child=u32(),length=u64();for(let i=0;i<length;i++)value(child);return null}const size=sizes[type];if(!size||offset+size>buffer.length)throw Error('Unsupported GGUF metadata');let result=null;if(type===4)result=buffer.readUInt32LE(offset);else if(type===5)result=buffer.readInt32LE(offset);else if(type===10)result=Number(buffer.readBigUInt64LE(offset));else if(type===11)result=Number(buffer.readBigInt64LE(offset));offset+=size;return result};
  let contextWindow=null;for(let i=0;i<count&&offset<buffer.length;i++){const key=text(),entry=value(u32());if(key.endsWith('.context_length')&&Number.isInteger(entry)){contextWindow=entry;break}}
  ggufCache.set(file,{size:stat.size,mtimeMs:stat.mtimeMs,contextWindow});return contextWindow;
 }catch{return null}
}
const walk=(dir,base=dir)=>fs.readdirSync(dir,{withFileTypes:true}).flatMap(entry=>{const file=path.join(dir,entry.name);return entry.isDirectory()?walk(file,base):[path.relative(base,file)]});
const runnableGguf=file=>{if(!file.toLowerCase().endsWith('.gguf')||/(^|\/)(mmproj|imatrix|mtp-)/i.test(file))return false;const shard=file.match(/-(\d{5})-of-\d{5}\.gguf$/i);return !shard||shard[1]==='00001'};
export function refreshModels(){
 const definitions=fs.readdirSync(modelDir).filter(file=>file.endsWith('.json')).map(file=>({file,data:JSON.parse(fs.readFileSync(path.join(modelDir,file),'utf8'))}));
 const referenced=new Set(definitions.filter(({data})=>data.file).map(({data})=>path.resolve(modelDir,data.file)));
 const usedIds=new Set(definitions.map(({data})=>data.id)),usedPorts=new Set(definitions.map(({data})=>{try{return Number(new URL(data.baseUrl).port)}catch{return 0}}));
 let nextPort=8080;const created=[];
 for(const relative of walk(modelDir).filter(runnableGguf).sort()){
  const absolute=path.resolve(modelDir,relative);if(referenced.has(absolute))continue;
  let id=relative.replace(/\.gguf$/i,'').replace(/-00001-of-\d{5}$/i,'').toLowerCase().replace(/[^a-z0-9]+/g,'-').replace(/^-|-$/g,'').slice(0,80)||'local-model',candidate=id,n=2;while(usedIds.has(candidate))candidate=(id+'-'+n++).slice(0,90);id=candidate;while(usedPorts.has(nextPort))nextPort++;usedPorts.add(nextPort);usedIds.add(id);
  const definition={id,name:path.basename(relative).replace(/\.gguf$/i,'').replace(/-00001-of-\d{5}$/i,''),runtime:'llama.cpp',file:relative,baseUrl:`http://127.0.0.1:${nextPort}/v1`,reasoning:false,input:['text']};
  const definitionFile=id+'.json';fs.writeFileSync(path.join(modelDir,definitionFile),JSON.stringify(definition,null,2)+'\n');created.push({definition:definitionFile,file:relative,id});referenced.add(absolute);nextPort++;
 }
 return {scanned:walk(modelDir).filter(file=>file.toLowerCase().endsWith('.gguf')).length,created,available:definitions.length+created.length};
}
export function configs(){return fs.readdirSync(configDir).filter(f=>f.endsWith('.json')).map(f=>validateConfig(JSON.parse(fs.readFileSync(path.join(configDir,f),'utf8'))))}
export function validateConfig(c){
 c={topK:40,minP:0.05,...c};
 if(!/^[a-z0-9-]{1,60}$/.test(c.id)||typeof c.name!=='string'||!c.name.trim()||c.name.length>80)throw Error('Use a short name and an ID containing lowercase letters, numbers or hyphens.');
 if(!['off','minimal','low','medium','high'].includes(c.thinking))throw Error('Invalid thinking level');
 const optionalNumber=(key,min,max,integer=false)=>{if(c[key]===undefined||c[key]===null||c[key]==='')return null;const value=Number(c[key]);if(!Number.isFinite(value)||value<min||value>max||(integer&&!Number.isInteger(value)))throw Error('Invalid '+key);return value};
 for(const [key,min,max] of [['contextWindow',512,1048576],['maxTokens',1,131072],['temperature',0,2],['topP',0,1],['topK',0,1000],['minP',0,1]])if(typeof c[key]!=='number'||!Number.isFinite(c[key])||c[key]<min||c[key]>max)throw Error('Invalid '+key);
 if(!Number.isInteger(c.contextWindow)||!Number.isInteger(c.maxTokens)||c.maxTokens>=c.contextWindow)throw Error('Output tokens must be smaller than the context window.');
 const parallel=optionalNumber('parallel',1,128,true),fitTarget=optionalNumber('fitTarget',1,1048576,true),specDraftMax=optionalNumber('specDraftMax',0,64,true),fit=c.fit??'inherit',specType=c.specType??'inherit';
 if(!['inherit','on','off'].includes(fit))throw Error('Invalid fit mode');
 if(!['inherit','none','draft-simple','draft-eagle3','draft-mtp','draft-dflash','draft-dspark','ngram-simple','ngram-map-k','ngram-map-k4v','ngram-mod','ngram-cache'].includes(specType))throw Error('Invalid speculative decoding type');
 return {id:c.id,name:c.name.trim(),thinking:c.thinking,contextWindow:c.contextWindow,maxTokens:c.maxTokens,temperature:c.temperature,topP:c.topP,topK:c.topK,minP:c.minP,parallel,fit,fitTarget,specType,specDraftMax};
}
export function localModels(){return fs.readdirSync(modelDir).filter(f=>f.endsWith('.json')).map(f=>{
 const m=JSON.parse(fs.readFileSync(path.join(modelDir,f),'utf8'));
 if(typeof m.id!=='string'||!m.id)throw Error('Model ID missing in '+f);
 const url=new URL(m.baseUrl||'http://127.0.0.1:11434/v1');
 if(!['127.0.0.1','localhost','[::1]'].includes(url.hostname))throw Error('Model endpoint must be local');
 if(m.runtime&&!['llama.cpp'].includes(m.runtime))throw Error('Unsupported runtime in '+f);
 let modelFile=null;
 if(m.file){modelFile=path.resolve(modelDir,m.file);if(!modelFile.startsWith(modelDir+path.sep)||!fs.existsSync(modelFile))throw Error('Model weight not found for '+f)}
 if(m.serverArgs&&!Array.isArray(m.serverArgs))throw Error('serverArgs must be an array in '+f);
 const fileBytes=modelFile?fs.statSync(modelFile).size:null,contextWindow=m.contextWindow||(modelFile?ggufContextWindow(modelFile):null);
 return {...m,name:m.name||m.id,baseUrl:url.href,reasoning:m.reasoning===true,modelFile,fileBytes,contextWindow};
})}
export function saveConfig(c){c=validateConfig(c);fs.writeFileSync(path.join(configDir,c.id+'.json'),JSON.stringify(c,null,2)+'\n');return c}
export function providerFor(model,config){return {api:'openai-completions',baseUrl:model.baseUrl||'http://127.0.0.1:11434/v1',apiKey:model.apiKey||'local',models:[{id:model.providerModelId||model.id,name:model.name,reasoning:model.reasoning,input:model.input||['text'],contextWindow:config.contextWindow,maxTokens:config.maxTokens,cost:{input:0,output:0,cacheRead:0,cacheWrite:0},samplingParams:{temperature:config.temperature,top_p:config.topP,top_k:config.topK,min_p:config.minP}}]}}
