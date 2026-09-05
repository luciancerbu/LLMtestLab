import http from 'node:http';
import fs from 'node:fs';
import {systemMetrics} from './metrics.mjs';
import path from 'node:path';
import {execFile,execFileSync} from 'node:child_process';
import {randomUUID} from 'node:crypto';
import {Readable,Transform} from 'node:stream';
import {pipeline} from 'node:stream/promises';
import {configs,localModels,saveConfig,providerFor,modelDir,configDir,refreshModels} from './catalog.mjs';
import {ROOT,DATA,PROMPTS,RUNS,PI_MODELS,TMUX,PI,LLAMA_SERVER} from './settings.mjs';
const PORT=Number(process.env.PORT||4318);
const AUTONOMOUS_PROMPT='Autonomous benchmark mode is enabled. Work continuously toward the requested outcome, make reasonable in-scope decisions without asking routine questions, use the available tools, and verify the result before stopping. Ask the user only when genuinely blocked, when required information is missing, or before an unsafe or materially out-of-scope action.';
fs.mkdirSync(DATA,{recursive:true});
const db=path.join(DATA,'runs.json'),suiteDb=path.join(DATA,'quick-suites.json'),downloadDb=path.join(DATA,'downloads.json'),quickSuiteCases=JSON.parse(fs.readFileSync(path.join(PROMPTS,'quick-suite.json'),'utf8')),origin=`http://127.0.0.1:${PORT}`;
const folderSelections=new Map();
let runs=fs.existsSync(db)?JSON.parse(fs.readFileSync(db)):[];
let quickSuites=fs.existsSync(suiteDb)?JSON.parse(fs.readFileSync(suiteDb)):[];
let downloads=fs.existsSync(downloadDb)?JSON.parse(fs.readFileSync(downloadDb)):[];
runs=runs.map(r=>({...r,config:r.config||'balanced'}));
const save=()=>fs.writeFileSync(db,JSON.stringify(runs,null,2)); save();
const saveSuites=()=>fs.writeFileSync(suiteDb,JSON.stringify(quickSuites.slice(0,30),null,2));
for(const suite of quickSuites)if(['queued','starting','running'].includes(suite.state)){suite.state='interrupted';suite.error='Dashboard restarted before the suite completed.';suite.completedAt=new Date().toISOString()}saveSuites();
const saveDownloads=()=>fs.writeFileSync(downloadDb,JSON.stringify(downloads.slice(0,30),null,2));
for(const download of downloads)if(['queued','downloading'].includes(download.state)){download.state='interrupted';download.error='Dashboard restarted before the download completed.';download.completedAt=new Date().toISOString()}saveDownloads();
const tm=(...args)=>execFileSync(TMUX,args,{encoding:'utf8',timeout:5000,maxBuffer:2e6});
const quote=s=>"'"+s.replaceAll("'","'\\''")+"'";
const alive=r=>{try{tm('has-session','-t',r.tmux);return true}catch{return false}};
function models(){
 try{
  const configured=JSON.parse(fs.readFileSync(PI_MODELS,'utf8')).providers?.ollama?.models||[];
  const available=configured.filter(m=>m.id).map(m=>({...m,name:m.name||m.id,reasoning:m.reasoning===true,runtime:'ollama',baseUrl:'http://127.0.0.1:11434/v1'}));
  return [...new Map([...available,...localModels()].map(m=>[m.id,m])).values()];
 }catch{}
 return localModels();
}
function openTerminal(r){
 if(!alive(r))throw Error('Start or resume this run before opening its tmux session.');
 const command=`${quote(TMUX)} attach-session -t ${quote(r.tmux)}`;
 const escaped=command.replaceAll('\\','\\\\').replaceAll('"','\\"');
 execFileSync('/usr/bin/osascript',['-e',`tell application "Terminal"\nactivate\ndo script "${escaped}"\nend tell`],{encoding:'utf8',timeout:5000});
}
const tmuxAlive=name=>{try{tm('has-session','-t',name);return true}catch{return false}};
function ensureModelRuntime(model,config){
 if(model.runtime!=='llama.cpp')return null;
 if(!model.modelFile)throw Error('The GGUF weight file is missing.');
 if(!fs.existsSync(LLAMA_SERVER))throw Error('llama-server is missing. Set LLAMA_SERVER_BIN or install the bundled runtime.');
 const url=new URL(model.baseUrl),port=Number(url.port||80),session='llm-'+model.id.replace(/[^a-zA-Z0-9_-]/g,'-').slice(0,48);
 if(!tmuxAlive(session)){
  const args=[LLAMA_SERVER,'--model',model.modelFile,'--alias',model.id,'--ctx-size',String(config.contextWindow),...(model.serverArgs||[]),'--host',url.hostname,'--port',String(port),'--api-key',model.apiKey||'local'];
  tm('new-session','-d','-s',session,'-x','140','-y','35','-c',ROOT,args.map(quote).join(' '));
 }
 return {session,health:new URL('/health',url).href};
}
const waitForHealth=async url=>{const end=Date.now()+180000;while(Date.now()<end){try{if((await fetch(url,{signal:AbortSignal.timeout(2500)})).ok)return}catch{}await new Promise(resolve=>setTimeout(resolve,1000))}throw Error('The local model server did not become ready within 3 minutes.')};
const completionUrl=baseUrl=>{const url=new URL(baseUrl);url.pathname=url.pathname.replace(/\/$/,'')+'/chat/completions';return url.href};
async function runQuickSuite(suite,model,config){
 try{
  suite.state='starting';suite.startedAt=new Date().toISOString();saveSuites();
  const runtime=ensureModelRuntime(model,config);if(runtime)await waitForHealth(runtime.health);
  suite.state='running';suite.results=[];saveSuites();
  for(const test of quickSuiteCases){
   const started=Date.now(),response=await fetch(completionUrl(model.baseUrl),{method:'POST',headers:{'Content-Type':'application/json','Authorization':'Bearer '+(model.apiKey||'local')},body:JSON.stringify({model:model.id,messages:[{role:'user',content:test.prompt}],temperature:config.temperature,top_p:config.topP,max_tokens:Math.min(test.maxTokens,config.maxTokens),stream:false}),signal:AbortSignal.timeout(600000)});
   const raw=await response.text();let payload;try{payload=JSON.parse(raw)}catch{throw Error('Model server returned an invalid response.')}if(!response.ok)throw Error(payload.error?.message||payload.error||'Model request failed with HTTP '+response.status);
   const usage=payload.usage||{},elapsedMs=Date.now()-started;
   suite.results.push({id:test.id,name:test.name,elapsedMs,promptTokens:Number.isFinite(usage.prompt_tokens)?usage.prompt_tokens:null,completionTokens:Number.isFinite(usage.completion_tokens)?usage.completion_tokens:null,totalTokens:Number.isFinite(usage.total_tokens)?usage.total_tokens:null,output:payload.choices?.[0]?.message?.content||'',finishReason:payload.choices?.[0]?.finish_reason||null});saveSuites();
  }
  const sum=key=>suite.results.every(r=>Number.isFinite(r[key]))?suite.results.reduce((n,r)=>n+r[key],0):null;suite.state='complete';suite.completedAt=new Date().toISOString();suite.elapsedMs=new Date(suite.completedAt)-new Date(suite.startedAt);suite.totals={promptTokens:sum('promptTokens'),completionTokens:sum('completionTokens'),totalTokens:sum('totalTokens')};saveSuites();
 }catch(error){suite.state='failed';suite.error=error.message;suite.completedAt=new Date().toISOString();suite.elapsedMs=new Date(suite.completedAt)-new Date(suite.startedAt);saveSuites()}
}
const validRepo=repo=>typeof repo==='string'&&/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(repo);
const validHfFile=file=>typeof file==='string'&&file.toLowerCase().endsWith('.gguf')&&!file.startsWith('/')&&!file.split('/').includes('..');
const hfJson=async url=>{const response=await fetch(url,{headers:{'User-Agent':'LLMTestLab/1.0'},signal:AbortSignal.timeout(30000)});if(!response.ok)throw Error('Hugging Face returned HTTP '+response.status);return response.json()};
function ggufGroups(siblings=[]){const groups=new Map();for(const item of siblings){const file=item.rfilename;if(!validHfFile(file)||/(^|\/)(mmproj|imatrix|mtp-)/i.test(file))continue;const split=file.match(/^(.*)-(\d{5})-of-(\d{5})\.gguf$/i),key=split?split[1]+'.gguf':file;if(!groups.has(key))groups.set(key,{name:key.split('/').pop().replace(/\.gguf$/i,''),files:[],totalBytes:0});const size=item.size||item.lfs?.size||null,group=groups.get(key);group.files.push({path:file,size});if(size)group.totalBytes+=size}return [...groups.values()].map(group=>({...group,files:group.files.sort((a,b)=>a.path.localeCompare(b.path))})).sort((a,b)=>a.name.localeCompare(b.name))}
async function searchHuggingFace(query){const url=new URL('https://huggingface.co/api/models');url.searchParams.set('search',query);url.searchParams.set('filter','gguf');url.searchParams.set('sort','downloads');url.searchParams.set('direction','-1');url.searchParams.set('limit','8');const found=await hfJson(url);return Promise.all(found.map(async model=>{const detail=await hfJson(`https://huggingface.co/api/models/${model.id}?blobs=true`);return {id:model.id,downloads:model.downloads||0,likes:model.likes||0,lastModified:model.lastModified||null,url:`https://huggingface.co/${model.id}`,groups:ggufGroups(detail.siblings)}}))}
async function downloadHuggingFace(job){try{job.state='downloading';saveDownloads();const detail=await hfJson(`https://huggingface.co/api/models/${job.repo}?blobs=true`),available=new Map((detail.siblings||[]).map(file=>[file.rfilename,file]));for(const file of job.files)if(!available.has(file)||!validHfFile(file))throw Error('The selected GGUF file is no longer available.');job.totalBytes=job.files.reduce((sum,file)=>sum+(available.get(file).size||available.get(file).lfs?.size||0),0);const repoFolder=path.join(modelDir,'downloads',job.repo.replace('/','--'));for(const file of job.files){job.currentFile=file;const expected=available.get(file).size||available.get(file).lfs?.size||0,destination=path.resolve(repoFolder,file),root=path.resolve(repoFolder)+path.sep;if(!destination.startsWith(root))throw Error('Invalid download path.');fs.mkdirSync(path.dirname(destination),{recursive:true});if(fs.existsSync(destination)){const size=fs.statSync(destination).size;if(!expected||size===expected){job.downloadedBytes+=size;saveDownloads();continue}throw Error('A different file already exists at '+destination)}const temporary=destination+'.download';if(fs.existsSync(temporary))fs.rmSync(temporary);const url='https://huggingface.co/'+job.repo+'/resolve/main/'+file.split('/').map(encodeURIComponent).join('/')+'?download=true',response=await fetch(url,{redirect:'follow',headers:{'User-Agent':'LLMTestLab/1.0'},signal:AbortSignal.timeout(3600000)});if(!response.ok||!response.body)throw Error('Download failed with HTTP '+response.status);let lastSaved=0;const meter=new Transform({transform(chunk,encoding,callback){job.downloadedBytes+=chunk.length;if(Date.now()-lastSaved>1000){lastSaved=Date.now();saveDownloads()}callback(null,chunk)}});try{await pipeline(Readable.fromWeb(response.body),meter,fs.createWriteStream(temporary,{flags:'wx'}));if(expected&&fs.statSync(temporary).size!==expected)throw Error('Downloaded size does not match the Hugging Face file metadata.');fs.renameSync(temporary,destination);saveDownloads()}catch(error){if(fs.existsSync(temporary))fs.rmSync(temporary);throw error}}job.refresh=refreshModels();job.state='complete';job.currentFile=null;job.completedAt=new Date().toISOString();saveDownloads()}catch(error){job.state='failed';job.error=error.message;job.completedAt=new Date().toISOString();saveDownloads()}}
const prompts=()=>fs.readdirSync(PROMPTS).filter(n=>n.endsWith('.txt')).map(name=>({name,text:fs.readFileSync(path.join(PROMPTS,name),'utf8')}));
function launch(r){
 const model=models().find(m=>m.id===r.model),config=configs().find(c=>c.id===r.config);
 if(!model||!config)throw Error('Select an available model and configuration.');
 const runDir=path.join(DATA,r.id);fs.mkdirSync(runDir,{recursive:true});
 const extension=path.join(runDir,'model-config.mjs');
 const provider=providerFor(model,config);
 const runtime=ensureModelRuntime(model,config);
 fs.writeFileSync(extension,'export default function(pi){pi.registerProvider("bench-local",'+JSON.stringify(provider)+')}\n');
 r.launchConfig={model:r.model,configuration:config,baseUrl:provider.baseUrl,runtime:model.runtime||'external',modelServer:runtime?.session||null,mode:'autonomous'};
 const args=[PI,'--extension',extension,'--provider','bench-local','--model',r.model,'--thinking',model.reasoning?config.thinking:'off','--approve','--offline','--append-system-prompt',AUTONOMOUS_PROMPT,'--session-dir',path.join(DATA,r.id,'sessions'),'--name',r.name];
 if(r.sessionFile)args.push('--session',r.sessionFile,'Continue from saved progress. Verify current files and finish the benchmark.');
 else if(r.started)args.push('--continue','Continue from saved progress. Verify current files and finish the benchmark.');
 else args.push('@'+path.join(PROMPTS,r.prompt),'Execute the benchmark in this project. Work in small steps, keep progress in TASKS.md, and verify the result.');
 const command=(runtime?`until /usr/bin/curl -fsS --max-time 2 ${quote(runtime.health)} >/dev/null 2>&1; do sleep 1; done; `:'')+'exec '+args.map(quote).join(' ');
 tm('new-session','-d','-s',r.tmux,'-x','160','-y','45','-c',r.cwd,command);r.state='running';r.started=true;save();
}
function files(dir,base=dir,depth=0){if(depth>4)return [];return fs.readdirSync(dir,{withFileTypes:true}).filter(e=>!e.name.startsWith('.')&&!['addons','node_modules'].includes(e.name)).flatMap(e=>{let p=path.join(dir,e.name);return e.isSymbolicLink()?[]:e.isDirectory()?files(p,base,depth+1):[{name:path.relative(base,p),size:fs.statSync(p).size}] }).slice(0,300)}
async function body(req){let s='';for await(const c of req){s+=c;if(s.length>20000)throw Error('Request too large')}return JSON.parse(s||'{}')}
const json=(res,data,status=200)=>{res.writeHead(status,{'Content-Type':'application/json','Cache-Control':'no-store'});res.end(JSON.stringify(data))};
function chooseFolder(){return new Promise((resolve,reject)=>execFile('/usr/bin/osascript',['-e','POSIX path of (choose folder with prompt "Choose a project folder for this test session")'],{encoding:'utf8',timeout:60000},(error,stdout,stderr)=>{if(error){if(String(stderr).includes('User canceled'))return resolve(null);return reject(Error('The folder picker could not be opened.'))}resolve(path.resolve(stdout.trim()))}))}
http.createServer(async(req,res)=>{try{
 if(![`127.0.0.1:${PORT}`,`localhost:${PORT}`].includes(req.headers.host))return json(res,{error:'Invalid host'},403);
 if(req.method!=='GET'&&(![origin,`http://localhost:${PORT}`].includes(req.headers.origin)||!req.headers['content-type']?.startsWith('application/json')))return json(res,{error:'Same-origin JSON required'},403);
 const u=new URL(req.url,origin);
 if(req.method==='GET'&&u.pathname==='/api/state')return json(res,{prompts:prompts(),models:models().map(({modelFile,serverArgs,apiKey,...m})=>m),configs:configs(),runs:runs.map(r=>({...r,alive:alive(r)})),quickSuiteCases:quickSuiteCases.map(({prompt,...test})=>test),quickSuites:quickSuites.slice(0,12),downloads:downloads.slice(0,10),defaultRunFolder:RUNS,system:systemMetrics()});
 if(req.method==='POST'&&u.pathname==='/api/quick-suites'){const b=await body(req),model=models().find(m=>m.id===b.model),config=configs().find(c=>c.id===b.config);if(!model||!config)throw Error('Select an available model and configuration.');if(quickSuites.some(s=>['queued','starting','running'].includes(s.state)))throw Error('A quick suite is already running.');const suite={id:randomUUID(),model:model.id,modelName:model.name,config:config.id,configName:config.name,state:'queued',createdAt:new Date().toISOString(),results:[]};quickSuites.unshift(suite);saveSuites();void runQuickSuite(suite,model,config);return json(res,suite,202)}
 if(req.method==='POST'&&u.pathname==='/api/models/refresh')return json(res,refreshModels());
 if(req.method==='GET'&&u.pathname==='/api/huggingface/search'){const query=(u.searchParams.get('q')||'').trim();if(query.length<2||query.length>100)throw Error('Enter between 2 and 100 characters.');return json(res,{results:await searchHuggingFace(query)});}
 if(req.method==='POST'&&u.pathname==='/api/huggingface/download'){const b=await body(req);if(!validRepo(b.repo)||!Array.isArray(b.files)||!b.files.length||b.files.length>20||!b.files.every(validHfFile))throw Error('Invalid Hugging Face selection.');if(downloads.some(d=>['queued','downloading'].includes(d.state)))throw Error('A model download is already running.');const job={id:randomUUID(),repo:b.repo,name:String(b.name||b.files[0]).slice(0,160),files:b.files,state:'queued',createdAt:new Date().toISOString(),downloadedBytes:0,totalBytes:Number(b.totalBytes)||0};downloads.unshift(job);saveDownloads();void downloadHuggingFace(job);return json(res,job,202)}
 if(req.method==='POST'&&u.pathname==='/api/configs')return json(res,saveConfig(await body(req)));
 if(req.method==='POST'&&u.pathname==='/api/folders/choose'){const folder=await chooseFolder();if(!folder)return json(res,{canceled:true});const token=randomUUID();folderSelections.set(token,{folder,expires:Date.now()+600000});return json(res,{token,path:folder});}
 if(req.method==='POST'&&u.pathname==='/api/folders'){const b=await body(req),folder={models:modelDir,configs:configDir}[b.folder];if(!folder)throw Error('Unknown folder');execFileSync('/usr/bin/open',[folder]);return json(res,{ok:true});}
 if(req.method==='POST'&&u.pathname==='/api/runs'){
 const b=await body(req),p=prompts().find(p=>p.name===b.prompt);if(!p)throw Error('Unknown prompt');
 if(!models().some(m=>m.id===b.model))throw Error('Unknown or unavailable Ollama model');
 if(!configs().some(c=>c.id===b.config))throw Error('Select a configuration');
 const id=randomUUID(),picked=folderSelections.get(b.folderToken);if(b.folderToken&&(!picked||picked.expires<=Date.now()))throw Error('Folder selection expired. Choose the folder again.');const selection=b.folderToken?picked:null,cwd=selection?.folder||path.join(RUNS,id);folderSelections.delete(b.folderToken);fs.mkdirSync(cwd,{recursive:true});
 const r={id,name:b.prompt.replace('.txt',''),prompt:b.prompt,model:b.model,config:b.config,cwd,customFolder:!!selection,tmux:'pi-bench-'+id.slice(0,8),created:new Date().toISOString(),state:'queued'};runs.unshift(r);save();return json(res,r);
 }
 const m=u.pathname.match(/^\/api\/runs\/([^/]+)(?:\/(files|file|start|continue|pause|open|finder|remove|model|config))?$/);
 if(m){const r=runs.find(r=>r.id===m[1]);if(!r)throw Error('Unknown run');const action=m[2];
 if(req.method==='GET'&&action==='files')return json(res,files(r.cwd));
 if(req.method==='GET'&&action==='file'){const p=path.resolve(r.cwd,u.searchParams.get('name')||'');if(!p.startsWith(r.cwd+path.sep)||!fs.realpathSync(p).startsWith(fs.realpathSync(r.cwd)+path.sep))throw Error('Invalid path');if(fs.statSync(p).size>500000)throw Error('File too large');return json(res,{text:fs.readFileSync(p,'utf8')});}
 if(req.method==='POST'&&action==='start'){if(alive(r))throw Error('Session already running');launch(r);return json(res,r);}
 if(req.method==='POST'&&action==='continue'){if(!alive(r))throw Error('Session is not running');tm('send-keys','-t',r.tmux,'-l','Continue the benchmark from current progress and verify the result.');tm('send-keys','-t',r.tmux,'Enter');r.state='running';save();return json(res,r);}
 if(req.method==='POST'&&action==='pause'){if(alive(r))tm('send-keys','-t',r.tmux,'Escape');r.state='paused';save();return json(res,r);}
 if(req.method==='POST'&&action==='open'){openTerminal(r);return json(res,{ok:true});}
 if(req.method==='POST'&&action==='finder'){if(!fs.existsSync(r.cwd))throw Error('The project folder no longer exists.');execFileSync('/usr/bin/open',[r.cwd]);return json(res,{ok:true});}
 if(req.method==='POST'&&action==='remove'){if(alive(r))tm('kill-session','-t',r.tmux);runs=runs.filter(x=>x.id!==r.id);save();return json(res,{ok:true,cwd:r.cwd,filesPreserved:true});}
 if(req.method==='POST'&&action==='config'){if(alive(r))throw Error('Configuration changes apply to stopped or new runs.');const b=await body(req);if(!configs().some(c=>c.id===b.config))throw Error('Unknown configuration');r.config=b.config;save();return json(res,r);}
 if(req.method==='POST'&&action==='model'){if(alive(r))throw Error('Pause or stop the run before changing its model.');const b=await body(req);if(!models().some(m=>m.id===b.model))throw Error('Unknown or unavailable Ollama model');r.model=b.model;save();return json(res,r);}
 }
 const staticMap={'/':'index.html','/app.js':'app.js','/style.css':'style.css'};if(req.method==='GET'&&staticMap[u.pathname]){res.setHeader('Content-Type',u.pathname.endsWith('.js')?'text/javascript':u.pathname.endsWith('.css')?'text/css':'text/html');return res.end(fs.readFileSync(path.join(import.meta.dirname,'public',staticMap[u.pathname])))}json(res,{error:'Not found'},404);
 }catch(e){json(res,{error:e.message},400)}}).listen(PORT,'127.0.0.1',()=>console.log(`Pi Bench Console: ${origin}`));
