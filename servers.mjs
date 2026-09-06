import fs from 'node:fs';
import net from 'node:net';
import path from 'node:path';
import {randomUUID} from 'node:crypto';
import {DATA} from './settings.mjs';

const db=path.join(DATA,'servers.json');
fs.mkdirSync(DATA,{recursive:true});
const read=()=>{try{return JSON.parse(fs.readFileSync(db,'utf8'))}catch{return []}};
const write=servers=>fs.writeFileSync(db,JSON.stringify(servers,null,2));

function privateHost(hostname){
 const host=hostname.replace(/^\[|\]$/g,'').toLowerCase();
 if(['localhost','127.0.0.1','::1'].includes(host)||host.endsWith('.local'))return true;
 if(net.isIP(host)===4){const [a,b]=host.split('.').map(Number);return a===10||a===127||(a===172&&b>=16&&b<=31)||(a===192&&b===168)||(a===169&&b===254)}
 if(net.isIP(host)===6)return host==='::1'||host.startsWith('fc')||host.startsWith('fd')||host.startsWith('fe80:');
 return false;
}
function normalizedUrl(value){
 let url;try{url=new URL(String(value||'').trim())}catch{throw Error('Enter a valid server URL, for example http://192.168.1.50:8080/v1.')}
 if(!['http:','https:'].includes(url.protocol)||url.username||url.password||!privateHost(url.hostname))throw Error('Only localhost and private-LAN HTTP or HTTPS servers are allowed.');
 url.pathname=url.pathname.replace(/\/+$/,'');if(!url.pathname||url.pathname==='/')url.pathname='/v1';
 url.search='';url.hash='';return url.href.replace(/\/$/,'');
}
const publicServer=server=>({id:server.id,name:server.name,location:server.location,baseUrl:server.baseUrl,hasApiKey:!!server.apiKey,models:server.models||[],testedAt:server.testedAt});
export const inferenceServers=()=>read();
export const publicInferenceServers=()=>read().map(publicServer);
export function remoteModels(){return read().flatMap(server=>(server.models||[]).map(model=>({id:`remote:${server.id}:${model.id}`,providerModelId:model.id,name:model.name||model.id,runtime:'openai-compatible',source:'remote',sourceId:server.id,sourceName:server.name,location:server.location,baseUrl:server.baseUrl,apiKey:server.apiKey||'local',reasoning:model.reasoning===true,input:['text'],contextWindow:model.contextWindow||null})))}
export async function saveInferenceServer(input){
 const servers=read(),existing=input.id?servers.find(server=>server.id===input.id):null,id=existing?.id||randomUUID(),name=String(input.name||'').trim(),baseUrl=normalizedUrl(input.baseUrl),apiKey=String(input.apiKey||'').trim()||existing?.apiKey||'';
 if(!name||name.length>80)throw Error('Give the server a name of up to 80 characters.');
 const url=new URL(baseUrl),location=['localhost','127.0.0.1','[::1]'].includes(url.hostname)?'local':'lan',response=await fetch(baseUrl+'/models',{headers:apiKey?{Authorization:'Bearer '+apiKey}:{},signal:AbortSignal.timeout(8000)});
 if(!response.ok)throw Error(`The server returned HTTP ${response.status} from /models.`);
 const payload=await response.json(),rows=Array.isArray(payload.data)?payload.data:[];
 if(!rows.length)throw Error('The server did not return any models from its OpenAI-compatible /models endpoint.');
 const contextWindow=Number(input.contextWindow)||null,models=rows.filter(row=>typeof row?.id==='string'&&row.id).slice(0,200).map(row=>({id:row.id,name:row.name||row.id,contextWindow:Number(row.context_window)||contextWindow||null,reasoning:input.reasoning===true}));
 const saved={id,name,location,baseUrl,apiKey,models,testedAt:new Date().toISOString()};const index=servers.findIndex(server=>server.id===id);if(index>=0)servers[index]=saved;else servers.push(saved);write(servers);return publicServer(saved);
}
export function removeInferenceServer(id){const servers=read(),next=servers.filter(server=>server.id!==id);if(next.length===servers.length)throw Error('Unknown inference server.');write(next);return {ok:true}}
