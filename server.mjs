import http from 'node:http';
import fs from 'node:fs';
import {systemMetrics} from './metrics.mjs';
import path from 'node:path';
import os from 'node:os';
import {execFile,execFileSync} from 'node:child_process';
import {randomUUID} from 'node:crypto';
import {Readable,Transform} from 'node:stream';
import {pipeline} from 'node:stream/promises';
import {configs,localModels,saveConfig,providerFor,modelDir,configDir,refreshModels} from './catalog.mjs';
import {ROOT,DATA,PROMPTS,RUNS,PI_MODELS,TMUX,PI,LLAMA_SERVER} from './settings.mjs';
import {modelMetadata,promptRegistry,suiteRegistry} from './registry.mjs';
import {publicInferenceServers,remoteModels,removeInferenceServer,saveInferenceServer} from './servers.mjs';
const PORT=Number(process.env.PORT||4318);
const AUTONOMOUS_PROMPT='Autonomous benchmark mode is enabled. Work continuously toward the requested outcome, make reasonable in-scope decisions without asking routine questions, use the available tools, and verify the result before stopping. Ask the user only when genuinely blocked, when required information is missing, or before an unsafe or materially out-of-scope action.';
fs.mkdirSync(DATA,{recursive:true});
const promptDefinitions=promptRegistry(),suiteDefinitions=suiteRegistry(),quickSuiteCases=suiteDefinitions.find(suite=>suite.id==='quick').cases;
const db=path.join(DATA,'runs.json'),suiteDb=path.join(DATA,'quick-suites.json'),downloadDb=path.join(DATA,'downloads.json'),contextDb=path.join(DATA,'context-checks.json'),serverModeDb=path.join(DATA,'server-mode.json'),origin=`http://127.0.0.1:${PORT}`;
const folderSelections=new Map();
function gpuLimit(){
 if(process.platform!=='darwin'||process.arch!=='arm64')return {supported:false,currentMb:null,totalMb:Math.floor(os.totalmem()/1048576),recommendedMaxMb:null};
 const totalMb=Math.floor(os.totalmem()/1048576),recommendedMaxMb=Math.max(0,totalMb-6144);let currentMb=null;
 try{currentMb=Number(execFileSync('/usr/sbin/sysctl',['-n','iogpu.wired_limit_mb'],{encoding:'utf8',timeout:1500}).trim())}catch{}
 return {supported:currentMb!==null,currentMb,totalMb,recommendedMaxMb,resetsOnRestart:true};
}
function setGpuLimit(value){
 const status=gpuLimit();if(!status.supported)throw Error('GPU wired-memory overrides require a supported Apple Silicon Mac.');
 const mb=Number(value);if(!Number.isInteger(mb)||(mb!==0&&(mb<1024||mb>status.totalMb-4096)))throw Error('Choose 0 for the system default, or leave at least 4 GB for macOS.');
 const command=`/usr/sbin/sysctl -w iogpu.wired_limit_mb=${mb}`;
 execFileSync('/usr/bin/osascript',['-e',`do shell script ${JSON.stringify(command)} with administrator privileges`],{encoding:'utf8',timeout:120000});
 return gpuLimit();
}
let runs=fs.existsSync(db)?JSON.parse(fs.readFileSync(db)):[];
let quickSuites=fs.existsSync(suiteDb)?JSON.parse(fs.readFileSync(suiteDb)):[];
let downloads=fs.existsSync(downloadDb)?JSON.parse(fs.readFileSync(downloadDb)):[];
let contextChecks=fs.existsSync(contextDb)?JSON.parse(fs.readFileSync(contextDb)):[];
let serverMode=fs.existsSync(serverModeDb)?JSON.parse(fs.readFileSync(serverModeDb)):{enabled:false};
runs=runs.map(r=>({...r,config:r.config||'balanced'}));
const save=()=>fs.writeFileSync(db,JSON.stringify(runs,null,2)); save();
const saveSuites=()=>fs.writeFileSync(suiteDb,JSON.stringify(quickSuites,null,2));
const stoppedSuiteCases=new Set();
const recoverableSuiteCases=[];
const startupTmuxAlive=name=>{if(!name)return false;try{execFileSync(TMUX,['has-session','-t',name],{stdio:'ignore'});return true}catch{return false}};
for(const suite of quickSuites){for(const test of suite.cases||[]){test.promptCount=test.promptCount||1;test.revisions=test.revisions||[]}if(['queued','starting','running','revising'].includes(suite.state)){const test=(suite.cases||[]).find(item=>['starting','running','revising'].includes(item.state)&&startupTmuxAlive(item.tmux));if(test){recoverableSuiteCases.push({suiteId:suite.id,testId:test.id});suite.currentCase=test.id;delete suite.error}else{suite.state='interrupted';suite.error='Dashboard restarted before the suite completed.';suite.completedAt=new Date().toISOString()}}}saveSuites();
const saveDownloads=()=>fs.writeFileSync(downloadDb,JSON.stringify(downloads.slice(0,30),null,2));
for(const download of downloads)if(['queued','downloading'].includes(download.state)){download.state='interrupted';download.error='Dashboard restarted before the download completed.';download.completedAt=new Date().toISOString()}saveDownloads();
const downloadControllers=new Map();
const saveContextChecks=()=>fs.writeFileSync(contextDb,JSON.stringify(contextChecks.slice(0,30),null,2));
const saveServerMode=()=>fs.writeFileSync(serverModeDb,JSON.stringify(serverMode,null,2));
for(const check of contextChecks)if(['queued','starting','running'].includes(check.state)){check.state='interrupted';check.error='Dashboard restarted before the context check completed.';check.completedAt=new Date().toISOString()}saveContextChecks();
const tm=(...args)=>execFileSync(TMUX,args,{encoding:'utf8',timeout:5000,maxBuffer:2e6});
const quote=s=>"'"+s.replaceAll("'","'\\''")+"'";
const syncPause=milliseconds=>Atomics.wait(new Int32Array(new SharedArrayBuffer(4)),0,0,milliseconds);
function localRequestText(url,{method='GET',headers={},body='',signal,timeoutMs=1800000}={}){
 return new Promise((resolve,reject)=>{
  const request=http.request(url,{method,headers:{...headers,...(body?{'Content-Length':Buffer.byteLength(body)}:{})},signal},response=>{
   response.setEncoding('utf8');let text='';
   response.on('data',chunk=>{text+=chunk;if(text.length>2e6)request.destroy(Error('The model server returned an unexpectedly large response.'))});
   response.on('end',()=>resolve({ok:response.statusCode>=200&&response.statusCode<300,status:response.statusCode||0,text}));
  });
  request.on('error',reject);
  request.setTimeout(timeoutMs,()=>{const error=Error(`The model server did not return this sample within ${Math.round(timeoutMs/60000)} minutes.`);error.code='STRESS_SAMPLE_TIMEOUT';request.destroy(error)});
  request.end(body);
 });
}
function contextStressFailure(check,error){
 const technical=String(error?.message||'Unknown context-test error.'),code=error?.cause?.code||error?.code||null,percent=check.currentStep?[25,50,75][check.currentStep-1]:null,tokens=Number(check.targetTokens||check.promptTokens||0),completed=check.speedSamples?.length||0;
 check.errorCode=code;check.technicalError=code?`${technical} (${code})`:technical;
 if(code==='STRESS_SAMPLE_TIMEOUT')return `The ${percent||'current'}% context sample exceeded its ${Math.round((check.sampleTimeoutMs||1800000)/60000)}-minute limit while processing ${tokens.toLocaleString()} prompt tokens. ${completed?`${completed} earlier sample${completed===1?' completed':'s completed'} successfully. `:''}Try a smaller context or run the test again after freeing memory.`;
 if(technical==='fetch failed'||code==='UND_ERR_HEADERS_TIMEOUT')return `The ${percent||'current'}% context sample reached ${tokens.toLocaleString()} prompt tokens, but the dashboard connection timed out before generation results returned. ${completed?`The ${completed===1?'25% sample':'earlier samples'} completed successfully. `:''}The model server may still be healthy; run the test again.`;
 if(['ECONNRESET','ECONNREFUSED','EPIPE'].includes(code))return `The connection to the model server was interrupted during the ${percent||'current'}% context sample at ${tokens.toLocaleString()} prompt tokens. ${completed?`${completed} earlier sample${completed===1?' completed':'s completed'} successfully. `:''}Check that the model server is still running, then retry.`;
 return technical;
}
function portBusy(port){try{execFileSync('/usr/sbin/lsof',['-nP','-iTCP:'+port,'-sTCP:LISTEN','-t'],{stdio:'ignore',timeout:500});return true}catch{return false}}
function waitForPortRelease(model,timeoutMs=5000){
 const port=Number(new URL(model.baseUrl).port||80),deadline=Date.now()+timeoutMs;
	 while(Date.now()<deadline){if(!portBusy(port))return;syncPause(100)}
 throw Error('Port '+port+' is still in use after stopping the previous model server. Wait a few seconds and try again.');
}
const activeIteration=r=>r.kind==='repeated-session'?(r.iterations||[]).find(item=>['starting','running','paused'].includes(item.state))||(r.iterations||[]).filter(item=>item.startedAt).at(-1):null;
const executionFor=r=>activeIteration(r)||r;
const alive=r=>{const target=executionFor(r);if(!target?.tmux)return false;try{tm('has-session','-t',target.tmux);return true}catch{return false}};
function configureTestTmux(name){try{tm('set-option','-t',name,'mouse','on')}catch{}try{tm('set-window-option','-t',name,'history-limit','100000')}catch{}try{tm('set-window-option','-t',name,'remain-on-exit','off')}catch{}}
const exitFile=r=>path.join(DATA,r.id,'exit-code');
const agentProgressFile=r=>path.join(DATA,r.id,'progress.json');
function exitCode(r){try{const value=Number(fs.readFileSync(exitFile(r),'utf8').trim());return Number.isInteger(value)?value:null}catch{return null}}
function agentProgress(r){try{const file=agentProgressFile(r);if(fs.statSync(file).size>16384)return null;const value=JSON.parse(fs.readFileSync(file,'utf8')),percent=Number(value.percent),phase=String(value.phase||'Working').slice(0,80),summary=String(value.summary||'').slice(0,240);if(value.source==='runner'||(['Starting','Resuming'].includes(phase)&&['Waiting for Pi to create its plan.','Restoring the saved Pi session.'].includes(summary)))return null;if(!Number.isFinite(percent)||percent<0||percent>100)return null;return {percent:Math.round(percent),phase,summary,updatedAt:value.updatedAt&&Number.isFinite(Date.parse(value.updatedAt))?value.updatedAt:null}}catch{return null}}
function hasSavedSession(r){try{return fs.readdirSync(path.join(DATA,r.id,'sessions')).some(name=>name.endsWith('.jsonl')&&fs.statSync(path.join(DATA,r.id,'sessions',name)).size>0)}catch{return false}}
function captureHardware(target,sample){const ram=sample.ram||{};target.peakMemoryBytes=Math.max(target.peakMemoryBytes||0,ram.used||0);target.peakGpuMemoryBytes=Math.max(target.peakGpuMemoryBytes||0,ram.gpuInUse||0);target.peakCpuPercent=Math.max(target.peakCpuPercent||0,sample.cpu?.percent||0);target.peakGpuPercent=Math.max(target.peakGpuPercent||0,sample.gpu?.percent||0);target.peakPowerWatts=Math.max(target.peakPowerWatts||0,sample.power?.total||0)}
function iterationTotals(iterations=[]){const complete=iterations.filter(item=>['complete','failed'].includes(item.state)),rates=complete.map(item=>item.stats?.averageTokensPerSecond).filter(Number.isFinite),times=complete.map(item=>item.elapsedMs).filter(Number.isFinite);return {completed:complete.length,generatedTokens:complete.reduce((sum,item)=>sum+(item.stats?.generatedTokens||0),0),averageTokensPerSecond:rates.length?rates.reduce((sum,value)=>sum+value,0)/rates.length:null,lowTokensPerSecond:rates.length?Math.min(...rates):null,highTokensPerSecond:rates.length?Math.max(...rates):null,averageElapsedMs:times.length?times.reduce((sum,value)=>sum+value,0)/times.length:null,peakMemoryBytes:Math.max(0,...complete.map(item=>item.peakMemoryBytes||0)),peakGpuMemoryBytes:Math.max(0,...complete.map(item=>item.peakGpuMemoryBytes||0))}}
function runSnapshots(){let changed=false;const sample=systemMetrics(),snapshots=runs.map(r=>{const target=executionFor(r),isAlive=alive(r);if(r.kind==='repeated-session'){if(isAlive&&target?.startedAt){captureHardware(target,sample);target.stats=sessionStats(target.id);target.elapsedMs=Date.now()-Date.parse(target.startedAt);r.elapsedMs=Date.now()-Date.parse(r.startedAt);r.stats=target.stats;r.peakMemoryBytes=target.peakMemoryBytes;r.peakGpuMemoryBytes=target.peakGpuMemoryBytes;changed=true}else if(r.state==='running'){r.state='interrupted';r.error='The dashboard stopped coordinating this series. Start it again to resume the current clean run.';changed=true}r.totals=iterationTotals(r.iterations);return {...r,alive:isAlive,agentProgress:target?agentProgress(target):null,currentIteration:target?.index||null}}if(isAlive&&r.startedAt){captureHardware(r,sample);r.stats=sessionStats(r.id);r.elapsedMs=Date.now()-Date.parse(r.startedAt);changed=true}if(!isAlive&&r.started&&r.state==='running'){const code=exitCode(r);captureHardware(r,sample);r.stats=sessionStats(r.id);r.state=code===null?'stopped':code===0?'complete':'failed';r.exitCode=code;r.completedAt=new Date().toISOString();r.elapsedMs=r.startedAt?Date.parse(r.completedAt)-Date.parse(r.startedAt):null;changed=true}return {...r,alive:isAlive,agentProgress:agentProgress(r)}});if(changed)save();return snapshots}
function suiteSnapshots(){return quickSuites.map(suite=>({...suite,cases:(suite.cases||[]).map(test=>({...test,alive:!!test.tmux&&tmuxAlive(test.tmux)}))}))}
function models(){
 try{
  const configured=JSON.parse(fs.readFileSync(PI_MODELS,'utf8')).providers?.ollama?.models||[];
  const available=configured.filter(m=>m.id).map(m=>({...m,name:m.name||m.id,reasoning:m.reasoning===true,runtime:'ollama',source:'ollama',sourceId:'ollama-local',sourceName:'Ollama · This Mac',baseUrl:'http://127.0.0.1:11434/v1'}));
  const managed=localModels().map(m=>({...m,source:'managed',sourceId:'managed-local',sourceName:'Managed GGUF · This Mac'}));
  return [...new Map([...available,...managed,...remoteModels()].map(m=>[m.id,m])).values()];
 }catch{}
 return [...localModels(),...remoteModels()];
}
function openTerminal(r){
 r=executionFor(r);
 if(!alive(r))throw Error('Start or resume this run before opening its tmux session.');
 configureTestTmux(r.tmux);
 let target=r.tmux;
 let startCommand='';try{startCommand=tm('display-message','-p','-t',`${r.tmux}:0`,'#{pane_start_command}')}catch{}
 if(!startCommand.includes('progress.mjs')){
  const activityTarget=`${r.tmux}:activity`,windows=tm('list-windows','-t',r.tmux,'-F','#{window_name}').trim().split('\n');
  if(!windows.includes('activity')){
   const progress=[process.execPath,path.join(ROOT,'progress.mjs'),path.join(DATA,r.id,'sessions'),exitFile(r)].map(quote).join(' ');
   tm('new-window','-d','-t',r.tmux,'-n','activity','-c',r.cwd,progress);
   try{tm('set-window-option','-t',activityTarget,'history-limit','100000')}catch{}
  }
  target=activityTarget;
 }
 const command=`${quote(TMUX)} attach-session -t ${quote(target)}`;
 const escaped=command.replaceAll('\\','\\\\').replaceAll('"','\\"');
 execFileSync('/usr/bin/osascript',['-e',`tell application "Terminal"\nactivate\ndo script "${escaped}"\nend tell`],{encoding:'utf8',timeout:5000});
}
function openModelTerminal(model){
 const session=modelSessionName(model);if(!tmuxAlive(session))throw Error('This model server is not running.');
 const command=`${quote(TMUX)} attach-session -t ${quote(session)}`,escaped=command.replaceAll('\\','\\\\').replaceAll('"','\\"');
 execFileSync('/usr/bin/osascript',['-e',`tell application "Terminal"\nactivate\ndo script "${escaped}"\nend tell`],{encoding:'utf8',timeout:5000});
}
const tmuxAlive=name=>{try{tm('has-session','-t',name);return true}catch{return false}};
const modelSessionName=model=>'llm-'+model.id.replace(/[^a-zA-Z0-9_-]/g,'-').slice(0,48);
function lanAddress(){
 const addresses=Object.values(os.networkInterfaces()).flat().filter(item=>item&&item.family==='IPv4'&&!item.internal);
 return addresses.find(item=>/^192\.168\.|^10\.|^172\.(1[6-9]|2\d|3[01])\./.test(item.address))?.address||addresses[0]?.address||null;
}
function serverModeFor(model){return serverMode.enabled&&serverMode.modelId===model.id?serverMode:null}
function runtimeAccess(model){const mode=serverModeFor(model);return {host:mode?'0.0.0.0':new URL(model.baseUrl).hostname,apiKey:mode?.apiKey||model.apiKey||'local',serverMode:!!mode}}
function serverModeSnapshot(){
 const model=models().find(item=>item.id===serverMode.modelId),config=configs().find(item=>item.id===serverMode.configId),session=model?modelSessionName(model):null,running=!!session&&tmuxAlive(session),address=lanAddress(),port=model?Number(new URL(model.baseUrl).port||80):null;let ready=false;
 if(running&&model)try{execFileSync('/usr/bin/curl',['-fsS','--max-time','1','-H','Authorization: Bearer '+serverMode.apiKey,new URL('/health',model.baseUrl).href],{stdio:'ignore',timeout:1500});ready=true}catch{}
 return {enabled:!!serverMode.enabled,running,ready,state:!serverMode.enabled?'off':ready?'online':running?'starting':'stopped',modelId:model?.id||serverMode.modelId||null,modelName:model?.name||null,configId:config?.id||serverMode.configId||null,configName:config?.name||null,contextWindow:config?.contextWindow||null,url:address&&port?`http://${address}:${port}/v1`:null,apiKey:serverMode.enabled?serverMode.apiKey:null,session,startedAt:serverMode.startedAt||null};
}
const effectiveContextWindow=value=>Math.ceil(Number(value)/32)*32;
const runtimeProfileDir=path.join(DATA,'model-runtimes');
const runtimeProfileFile=model=>path.join(runtimeProfileDir,model.id.replace(/[^a-zA-Z0-9_-]/g,'-').slice(0,80)+'.json');
function managedServerArgs(model,config){
 const overridden=new Set(['-c','--ctx-size']);
 if(config.parallel!==null)overridden.add('-np').add('--parallel');
 if(config.fit!=='inherit')overridden.add('-fit').add('--fit');
 if(config.fitTarget!==null)overridden.add('-fitt').add('--fit-target');
 if(config.specType!=='inherit')overridden.add('--spec-type');
 if(config.specDraftMax!==null)overridden.add('--spec-draft-n-max');
 const source=(model.serverArgs||[]).map(String),preserved=[];
 for(let index=0;index<source.length;index++){const argument=source[index],flag=argument.split('=',1)[0];if(overridden.has(flag)){if(!argument.includes('='))index++;continue}preserved.push(argument)}
 const runtime=[...preserved,'--ctx-size',String(config.contextWindow)];
 const hasParallel=runtime.some(argument=>['-np','--parallel'].includes(argument.split('=',1)[0]));
 if(config.parallel!==null)runtime.push('--parallel',String(config.parallel));
 else if(!hasParallel)runtime.push('--parallel','1');
 if(config.fit!=='inherit')runtime.push('--fit',config.fit);
 if(config.fitTarget!==null)runtime.push('--fit-target',String(config.fitTarget));
 if(config.specType!=='inherit')runtime.push('--spec-type',config.specType);
 if(config.specDraftMax!==null)runtime.push('--spec-draft-n-max',String(config.specDraftMax));
 return runtime;
}
function runtimeProfile(model,args,access=runtimeAccess(model)){return JSON.stringify({modelFile:model.modelFile,baseUrl:model.baseUrl,args,host:access.host,serverMode:access.serverMode})}
function savedRuntimeProfile(model){try{return fs.readFileSync(runtimeProfileFile(model),'utf8')}catch{return null}}
function runtimeContext(session){try{const command=tm('display-message','-p','-t',session,'#{pane_start_command}'),matches=[...command.matchAll(/["']?--ctx-size["']?\s+["']?(\d+)/g)];return matches.length?Number(matches.at(-1)[1]):null}catch{return null}}
function reportedRuntimeContext(model,session=modelSessionName(model),apiKey=runtimeAccess(model).apiKey){try{const props=new URL('/props',model.baseUrl).href,payload=execFileSync('/usr/bin/curl',['-fsS','--max-time','1','-H','Authorization: Bearer '+apiKey,props],{encoding:'utf8',timeout:1500,maxBuffer:1e6}),reported=Number(JSON.parse(payload)?.default_generation_settings?.n_ctx);return Number.isInteger(reported)?reported:runtimeContext(session)}catch{return runtimeContext(session)}}
function modelIsBusy(modelId){return runs.some(run=>run.model===modelId&&alive(run))||quickSuites.some(suite=>suite.model===modelId&&suite.cases?.some(test=>test.tmux&&tmuxAlive(test.tmux)))}
function releaseIdleManagedRuntimes(selectedModelId,{restartSelected=false}={}){
	 for(const candidate of models().filter(item=>item.runtime==='llama.cpp')){
	  if(candidate.id===selectedModelId&&!restartSelected)continue;
	  const session=modelSessionName(candidate);if(!tmuxAlive(session))continue;
	  if(serverModeFor(candidate))throw Error(`Stop Server mode for ${candidate.name} before loading another managed model.`);
  if(modelIsBusy(candidate.id))throw Error(`The managed model ${candidate.name} is still in use. Finish its active test before loading another large model.`);
	  tm('kill-session','-t',session);waitForPortRelease(candidate);
 }
}
function ensureModelRuntime(model,config){
 if(model.runtime!=='llama.cpp')return null;
 if(!model.modelFile)throw Error('The GGUF weight file is missing.');
 if(!fs.existsSync(LLAMA_SERVER))throw Error('llama-server is missing. Set LLAMA_SERVER_BIN or install the bundled runtime.');
 releaseIdleManagedRuntimes(model.id);
	 const mode=serverModeFor(model);if(mode&&mode.configId!==config.id)throw Error(`Server mode is using the ${configs().find(item=>item.id===mode.configId)?.name||mode.configId} preset. Stop it before changing runtime settings.`);
	 const url=new URL(model.baseUrl),port=Number(url.port||80),session=modelSessionName(model),serverArgs=managedServerArgs(model,config),access=runtimeAccess(model),profile=runtimeProfile(model,serverArgs,access),currentContext=tmuxAlive(session)?reportedRuntimeContext(model,session,access.apiKey):null,expectedContext=effectiveContextWindow(config.contextWindow),profileChanged=tmuxAlive(session)&&savedRuntimeProfile(model)!==profile;
	 if(tmuxAlive(session)&&(currentContext!==expectedContext||profileChanged)){if(modelIsBusy(model.id))throw Error(`This model server is currently in use with different runtime settings. Finish the active test before applying this preset.`);tm('kill-session','-t',session);waitForPortRelease(model)}
	 if(!tmuxAlive(session)){
	  if(portBusy(port))throw Error('Port '+port+' is already used by another process. Stop that process or change this model’s base URL before retrying.');
	  const args=[LLAMA_SERVER,'--model',model.modelFile,'--alias',model.id,...serverArgs,'--host',access.host,'--port',String(port),'--api-key',access.apiKey];
  tm('new-session','-d','-s',session,'-x','140','-y','35','-c',ROOT,args.map(quote).join(' '));
  fs.mkdirSync(runtimeProfileDir,{recursive:true});fs.writeFileSync(runtimeProfileFile(model),profile);
 }
	 return {session,health:new URL('/health',url).href,props:new URL('/props',url).href,apiKey:access.apiKey,contextWindow:expectedContext,requestedContext:config.contextWindow,serverArgs,serverMode:access.serverMode};
}
async function runContextCheck(check){
 try{
  const model=models().find(item=>item.id===check.model),config=configs().find(item=>item.id===check.config);if(!model||!config)throw Error('The selected model or configuration is no longer available.');if(model.runtime!=='llama.cpp')throw Error('Runtime context checks currently require a local GGUF model served by llama.cpp.');
  check.state='starting';check.startedAt=new Date().toISOString();const baseline=systemMetrics();check.baselineMemoryBytes=baseline.ram?.used||null;check.peakMemoryBytes=check.baselineMemoryBytes||0;check.peakGpuMemoryBytes=baseline.ram?.gpuInUse||0;check.peakGpuAllocatedBytes=baseline.ram?.gpuAllocated||0;saveContextChecks();const runtime=ensureModelRuntime(model,config),deadline=Date.now()+120000;
  check.state='running';saveContextChecks();let reported=null;while(Date.now()<deadline){const sample=systemMetrics();check.peakMemoryBytes=Math.max(check.peakMemoryBytes||0,sample.ram?.used||0);check.peakGpuMemoryBytes=Math.max(check.peakGpuMemoryBytes||0,sample.ram?.gpuInUse||0);check.peakGpuAllocatedBytes=Math.max(check.peakGpuAllocatedBytes||0,sample.ram?.gpuAllocated||0);if(!tmuxAlive(runtime.session))throw Error('The model server exited while loading this context. Reduce the context size or memory pressure.');try{const response=await fetch(runtime.health,{headers:{Authorization:'Bearer '+runtime.apiKey},signal:AbortSignal.timeout(1500)});if(response.ok){reported=reportedRuntimeContext(model,runtime.session);if(reported)break}}catch{}await delay(1000)}
  if(!reported)throw Error('The model server did not become ready within two minutes.');if(reported<config.contextWindow)throw Error(`llama-server loaded ${reported.toLocaleString()} tokens, below the requested ${config.contextWindow.toLocaleString()}.`);
  const completionUrl=new URL('/v1/chat/completions',model.baseUrl),probe=await fetch(completionUrl,{method:'POST',headers:{Authorization:'Bearer '+runtime.apiKey,'Content-Type':'application/json'},body:JSON.stringify({model:model.providerModelId||model.id,messages:[{role:'user',content:'context fit probe '.repeat(2048)}],max_tokens:1,temperature:0}),signal:AbortSignal.timeout(120000)}),probeText=await probe.text();
  if(!probe.ok){let detail=probeText;try{detail=JSON.parse(probeText)?.error?.message||detail}catch{}throw Error('The model loaded but failed its decode probe: '+String(detail||`HTTP ${probe.status}`).slice(0,500))}
  const finalSample=systemMetrics();check.peakMemoryBytes=Math.max(check.peakMemoryBytes||0,finalSample.ram?.used||0);check.peakGpuMemoryBytes=Math.max(check.peakGpuMemoryBytes||0,finalSample.ram?.gpuInUse||0);check.peakGpuAllocatedBytes=Math.max(check.peakGpuAllocatedBytes||0,finalSample.ram?.gpuAllocated||0);check.reportedContext=reported;check.state='complete';check.completedAt=new Date().toISOString();check.elapsedMs=Date.parse(check.completedAt)-Date.parse(check.startedAt);saveContextChecks();
 }catch(error){check.state='failed';check.error=error.message;check.completedAt=new Date().toISOString();check.elapsedMs=check.startedAt?Date.parse(check.completedAt)-Date.parse(check.startedAt):0;saveContextChecks()}
}
const contextCheckControllers=new Map();
function sampleUsefulContextCheck(check){
 const sample=systemMetrics(),ram=sample.ram||{};
 check.peakMemoryBytes=Math.max(check.peakMemoryBytes||0,ram.used||0);
 check.peakGpuMemoryBytes=Math.max(check.peakGpuMemoryBytes||0,ram.gpuInUse||0);
 check.peakGpuAllocatedBytes=Math.max(check.peakGpuAllocatedBytes||0,ram.gpuAllocated||0);
 if(Number.isFinite(ram.available))check.minimumAvailableBytes=Math.min(check.minimumAvailableBytes??ram.available,ram.available);
 if(Number.isFinite(ram.swapUsed))check.peakSwapBytes=Math.max(check.peakSwapBytes??ram.swapUsed,ram.swapUsed);
}
async function runUsefulContextCheck(check,testConfig){
 const controller=new AbortController();
 contextCheckControllers.set(check.id,controller);
 let monitor;
 try{
  const model=models().find(item=>item.id===check.model);
  if(!model||!testConfig)throw Error('The selected model or configuration is no longer available.');
  check.state='starting';check.phase='Cold-starting model';check.percent=5;check.startedAt=new Date().toISOString();
  const baseline=systemMetrics(),ram=baseline.ram||{};
  check.baselineMemoryBytes=ram.used||null;check.baselineSwapBytes=ram.swapUsed||0;check.peakMemoryBytes=ram.used||0;check.peakGpuMemoryBytes=ram.gpuInUse||0;check.peakGpuAllocatedBytes=ram.gpuAllocated||0;check.minimumAvailableBytes=ram.available??null;check.peakSwapBytes=ram.swapUsed??null;
  saveContextChecks();
  const runtime=ensureModelRuntime(model,testConfig),deadline=Date.now()+180000;
  check.runtimeSession=runtime.session;check.state='running';check.phase='Loading requested context';check.percent=15;saveContextChecks();
  monitor=setInterval(()=>{sampleUsefulContextCheck(check);saveContextChecks()},2000);
  let reported=null;
  while(Date.now()<deadline){
   if(controller.signal.aborted)throw controller.signal.reason||Error('Stopped by user.');
   if(!tmuxAlive(runtime.session))throw Error('The model server exited while loading this context.');
   try{const response=await fetch(runtime.health,{headers:{Authorization:'Bearer '+runtime.apiKey},signal:AbortSignal.timeout(1500)});if(response.ok){reported=reportedRuntimeContext(model,runtime.session);if(reported)break}}catch{}
   await delay(1000);
  }
  if(!reported)throw Error('The model server did not become ready within three minutes.');
  if(reported<testConfig.contextWindow)throw Error('llama-server reduced the context to '+reported.toLocaleString()+' tokens.');
	  check.reportedContext=reported;check.phase='Calibrating speed curve';check.percent=22;saveContextChecks();
	  const tokenizeUrl=new URL('/tokenize',model.baseUrl),completionUrl=new URL('/v1/chat/completions',model.baseUrl),headers={Authorization:'Bearer '+runtime.apiKey,'Content-Type':'application/json'},unit=' context-fit';
	  const tokenized=await fetch(tokenizeUrl,{method:'POST',headers,body:JSON.stringify({content:unit.repeat(256),add_special:false}),signal:AbortSignal.any([controller.signal,AbortSignal.timeout(30000)])});
	  if(!tokenized.ok)throw Error('The runtime could not tokenize the stress prompt.');
	  const unitCount=(await tokenized.json()).tokens?.length||256,fractions=[.25,.5,.75];check.speedSamples=[];check.decodeTokens=64;
	  for(let index=0;index<fractions.length;index++){
	   if(controller.signal.aborted)throw controller.signal.reason||Error('Stopped by user.');
	   const fraction=fractions[index],target=Math.max(1024,Math.min(Math.floor(testConfig.contextWindow*fraction),testConfig.contextWindow-1024)),repeats=Math.max(1,Math.floor(target*256/unitCount)),content=`speed-curve-${index+1} `+unit.repeat(repeats),started=Date.now(),measuredPrefill=check.speedSamples.at(-1)?.prefillTokensPerSecond,estimatedMs=Math.ceil(target/(measuredPrefill>0?measuredPrefill:60)*1000+60000),sampleTimeoutMs=Math.max(600000,Math.min(3600000,estimatedMs*3));
	   check.currentStep=index+1;check.promptTokens=target;check.targetTokens=target;check.sampleStartedAt=new Date(started).toISOString();check.estimatedSampleMs=estimatedMs;check.sampleTimeoutMs=sampleTimeoutMs;check.phase='Measuring '+Math.round(fraction*100)+'% context token speed';check.percent=28+index*20;saveContextChecks();
		   const requestBody=JSON.stringify({model:model.providerModelId||model.id,messages:[{role:'user',content:content+'\nReply with a concise confirmation that this context-speed sample completed.'}],max_tokens:64,temperature:0,stream:false,cache_prompt:false}),response=await localRequestText(completionUrl,{method:'POST',headers,body:requestBody,signal:controller.signal,timeoutMs:sampleTimeoutMs}),responseText=response.text;
	   if(!response.ok){let detail=responseText;try{detail=JSON.parse(responseText)?.error?.message||detail}catch{}throw Error('Context speed sample failed: '+String(detail||('HTTP '+response.status)).slice(0,500))}
	   let result={};try{result=JSON.parse(responseText)}catch{}
	   const promptTokens=Number(result.timings?.prompt_n)||Number(result.usage?.prompt_tokens)||target,prefillTokensPerSecond=Number(result.timings?.prompt_per_second)||null,decodeTokensPerSecond=Number(result.timings?.predicted_per_second)||null,decodeTokens=Number(result.timings?.predicted_n)||Number(result.usage?.completion_tokens)||null;
	   check.promptTokens=promptTokens;check.prefillTokensPerSecond=prefillTokensPerSecond;check.decodeTokensPerSecond=decodeTokensPerSecond;check.actualDecodeTokens=decodeTokens;check.speedSamples.push({contextPercent:Math.round(fraction*100),contextTokens:promptTokens,prefillTokensPerSecond,decodeTokensPerSecond,decodeTokens,elapsedMs:Date.now()-started});sampleUsefulContextCheck(check);saveContextChecks();
	  }
	  check.phase='Measuring memory headroom';check.percent=90;sampleUsefulContextCheck(check);await delay(2000);sampleUsefulContextCheck(check);
	  const headroom=check.minimumAvailableBytes??0,swapGrowth=Math.max(0,(check.peakSwapBytes||0)-(check.baselineSwapBytes||0)),warningHeadroom=2*1024**3,unsafeHeadroom=1024**3,firstSpeed=check.speedSamples[0]?.decodeTokensPerSecond,lastSpeed=check.speedSamples.at(-1)?.decodeTokensPerSecond,speedRatio=firstSpeed>0&&lastSpeed>0?lastSpeed/firstSpeed:1;
	  check.swapGrowthBytes=swapGrowth;
	  check.generationSlowdownPercent=Math.max(0,Math.round((1-speedRatio)*100));
	  check.verdict=headroom<unsafeHeadroom||swapGrowth>512*1024**2||speedRatio<.5?'unsafe':headroom<warningHeadroom||swapGrowth>128*1024**2||speedRatio<.75?'warning':'pass';
	  check.recommendedContext=check.verdict==='pass'?testConfig.contextWindow:Math.max(8192,Math.floor((testConfig.contextWindow*(check.verdict==='unsafe'?.5:.75))/1024)*1024);
	  const speedNote=check.generationSlowdownPercent?' Generation slowed '+check.generationSlowdownPercent+'% between the 25% and 75% samples.':'';
	  check.summary=(check.verdict==='pass'?'All context-speed samples completed with usable headroom.':check.verdict==='warning'?'The samples completed, but memory, swap, or generation-speed headroom is tight.':'The context technically ran, but memory pressure or severe generation slowdown makes it unsafe for long agent sessions.')+speedNote;
  check.phase='Complete';check.percent=100;check.state='complete';check.completedAt=new Date().toISOString();check.elapsedMs=Date.parse(check.completedAt)-Date.parse(check.startedAt);saveContextChecks();
 }catch(error){
	  check.state=controller.signal.aborted?'stopped':'failed';check.phase=check.state==='stopped'?'Stopped':'Failed';check.error=controller.signal.aborted?'Stopped by user.':contextStressFailure(check,error);check.summary=check.error;check.completedAt=new Date().toISOString();check.elapsedMs=check.startedAt?Date.parse(check.completedAt)-Date.parse(check.startedAt):0;saveContextChecks();
 }finally{clearInterval(monitor);contextCheckControllers.delete(check.id)}
}
const validRepo=repo=>typeof repo==='string'&&/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(repo);
const validHfFile=file=>typeof file==='string'&&file.toLowerCase().endsWith('.gguf')&&!file.startsWith('/')&&!file.split('/').includes('..');
const hfJson=async(url,signal)=>{const timeout=AbortSignal.timeout(30000),combined=signal?AbortSignal.any([signal,timeout]):timeout,response=await fetch(url,{headers:{'User-Agent':'LLMTestLab/1.0'},signal:combined});if(!response.ok)throw Error('Hugging Face returned HTTP '+response.status);return response.json()};
function ggufGroups(siblings=[]){const groups=new Map();for(const item of siblings){const file=item.rfilename;if(!validHfFile(file)||/(^|\/)(mmproj|imatrix|mtp-)/i.test(file))continue;const split=file.match(/^(.*)-(\d{5})-of-(\d{5})\.gguf$/i),key=split?split[1]+'.gguf':file;if(!groups.has(key))groups.set(key,{name:key.split('/').pop().replace(/\.gguf$/i,''),files:[],totalBytes:0});const size=item.size||item.lfs?.size||null,group=groups.get(key);group.files.push({path:file,size});if(size)group.totalBytes+=size}return [...groups.values()].map(group=>({...group,files:group.files.sort((a,b)=>a.path.localeCompare(b.path))})).sort((a,b)=>a.name.localeCompare(b.name))}
async function searchHuggingFace(query){const url=new URL('https://huggingface.co/api/models');url.searchParams.set('search',query);url.searchParams.set('filter','gguf');url.searchParams.set('sort','downloads');url.searchParams.set('direction','-1');url.searchParams.set('limit','8');const found=await hfJson(url);return Promise.all(found.map(async model=>{const detail=await hfJson(`https://huggingface.co/api/models/${model.id}?blobs=true`);return {id:model.id,downloads:model.downloads||0,likes:model.likes||0,lastModified:model.lastModified||null,url:`https://huggingface.co/${model.id}`,groups:ggufGroups(detail.siblings)}}))}
async function downloadHuggingFace(job){
 const controller=new AbortController();downloadControllers.set(job.id,controller);job.state='downloading';job.downloadedBytes=0;job.currentFile=null;delete job.error;delete job.completedAt;saveDownloads();
 try{const detail=await hfJson(`https://huggingface.co/api/models/${job.repo}?blobs=true`,controller.signal),available=new Map((detail.siblings||[]).map(file=>[file.rfilename,file]));for(const file of job.files)if(!available.has(file)||!validHfFile(file))throw Error('The selected GGUF file is no longer available.');job.totalBytes=job.files.reduce((sum,file)=>sum+(available.get(file).size||available.get(file).lfs?.size||0),0);const repoFolder=path.join(modelDir,'downloads',job.repo.replace('/','--'));for(const file of job.files){if(controller.signal.aborted)throw controller.signal.reason;job.currentFile=file;const expected=available.get(file).size||available.get(file).lfs?.size||0,destination=path.resolve(repoFolder,file),root=path.resolve(repoFolder)+path.sep;if(!destination.startsWith(root))throw Error('Invalid download path.');fs.mkdirSync(path.dirname(destination),{recursive:true});if(fs.existsSync(destination)){const size=fs.statSync(destination).size;if(!expected||size===expected){job.downloadedBytes+=size;saveDownloads();continue}throw Error('A different file already exists at '+destination)}const temporary=destination+'.download';if(fs.existsSync(temporary))fs.rmSync(temporary);const url='https://huggingface.co/'+job.repo+'/resolve/main/'+file.split('/').map(encodeURIComponent).join('/')+'?download=true',signal=AbortSignal.any([controller.signal,AbortSignal.timeout(3600000)]),response=await fetch(url,{redirect:'follow',headers:{'User-Agent':'LLMTestLab/1.0'},signal});if(!response.ok||!response.body)throw Error('Download failed with HTTP '+response.status);let lastSaved=0;const meter=new Transform({transform(chunk,encoding,callback){job.downloadedBytes+=chunk.length;if(Date.now()-lastSaved>1000){lastSaved=Date.now();saveDownloads()}callback(null,chunk)}});try{await pipeline(Readable.fromWeb(response.body),meter,fs.createWriteStream(temporary,{flags:'wx'}),{signal:controller.signal});if(expected&&fs.statSync(temporary).size!==expected)throw Error('Downloaded size does not match the Hugging Face file metadata.');fs.renameSync(temporary,destination);saveDownloads()}catch(error){if(fs.existsSync(temporary))fs.rmSync(temporary);throw error}}job.refresh=refreshModels();job.state='complete';job.currentFile=null;job.completedAt=new Date().toISOString();saveDownloads()}catch(error){job.state=controller.signal.aborted?'stopped':'failed';job.error=controller.signal.aborted?'Stopped by user.':error.message;job.currentFile=null;job.completedAt=new Date().toISOString();saveDownloads()}finally{downloadControllers.delete(job.id)}
}
const prompts=()=>promptDefinitions.map(prompt=>({...prompt,name:prompt.file,displayName:prompt.name}));
function launch(r){
 const model=models().find(m=>m.id===r.model),config=configs().find(c=>c.id===r.config);
 if(!model||!config)throw Error('Select an available model and configuration.');
 const runDir=path.join(DATA,r.id);fs.mkdirSync(runDir,{recursive:true});
 const extension=path.join(runDir,'model-config.mjs');
	 const runtime=ensureModelRuntime(model,config),provider=providerFor(model,config);if(runtime)provider.apiKey=runtime.apiKey;
 fs.writeFileSync(extension,'export default function(pi){pi.registerProvider("bench-local",'+JSON.stringify(provider)+')}\n');
 const resultFile=exitFile(r);fs.rmSync(resultFile,{force:true});
 const progressFile=agentProgressFile(r),previousProgress=agentProgress(r);fs.writeFileSync(progressFile,JSON.stringify({version:1,percent:previousProgress?.percent||0,phase:r.started?'Resuming':'Starting',summary:r.started?'Restoring the saved Pi session.':'Waiting for Pi to create its plan.',updatedAt:new Date().toISOString(),source:'runner'},null,2));
 r.launchConfig={model:r.model,configuration:config,baseUrl:provider.baseUrl,runtime:model.runtime||'external',modelServer:runtime?.session||null,mode:'autonomous'};
 const progressPrompt=`Report your own progress to ${progressFile} so the local benchmark dashboard can display it. Write valid JSON with exactly these fields: {"version":1,"percent":number,"phase":string,"summary":string,"updatedAt":ISO-8601 string}. Estimate percent from 0 to 100 based on completion of the requested deliverable, not token usage or elapsed time. Update it after planning, after each meaningful milestone, whenever the plan changes, and immediately before your final response. Keep phase under 80 characters and summary under 240 characters. The estimate may change when you discover new work, but do not report 100 until implementation and verification are complete. This progress file is dashboard metadata, not part of the requested project deliverables.`;
 const args=[PI,'--print','--extension',extension,'--provider','bench-local','--model',model.providerModelId||model.id,'--thinking',model.reasoning?config.thinking:'off','--approve','--offline','--append-system-prompt',AUTONOMOUS_PROMPT+' '+progressPrompt,'--session-dir',path.join(DATA,r.id,'sessions'),'--name',r.name];
 const progressFirst=`Before doing any other work, write your initial progress estimate to ${progressFile} using the required progress JSON schema. Continue updating it at every meaningful milestone.`;
 if(r.sessionFile)args.push('--session',r.sessionFile,progressFirst+' '+(r.continuePrompt||'Continue from saved progress. Verify current files and finish the benchmark.'));
 else if(r.started&&hasSavedSession(r))args.push('--continue',progressFirst+' '+(r.continuePrompt||'Continue from saved progress. Verify current files and finish the benchmark.'));
 else args.push('@'+path.join(PROMPTS,r.prompt),progressFirst+' Execute the benchmark in this project. Work in small steps, keep progress in TASKS.md, and verify the result.');
 const healthCheck=runtime?`/usr/bin/curl -fsS --connect-timeout 1 --max-time 1 -H ${quote('Authorization: Bearer '+runtime.apiKey)} ${quote(runtime.health)}`:null;
 const runtimeReady=runtime?`{ for attempt in $(/usr/bin/seq 1 60); do ${healthCheck} >/dev/null 2>&1 && break; sleep 1; done; ${healthCheck} >/dev/null 2>&1 || { /usr/bin/printf 'Model server did not become ready within two minutes. Reduce the context size or GPU memory pressure and try again.\\n' >&2; false; }; } && { context_payload=$(/usr/bin/curl -fsS --max-time 2 -H ${quote('Authorization: Bearer '+runtime.apiKey)} ${quote(runtime.props)}); /usr/bin/printf '%s' "$context_payload" | /usr/bin/grep -Eq ${quote('"n_ctx"[[:space:]]*:[[:space:]]*'+runtime.contextWindow)} || { /usr/bin/printf 'Model server did not apply the requested %s-token context. Adjust the preset or GPU memory limit.\\n' ${quote(String(runtime.contextWindow))} >&2; false; }; }`:'true';
 const sessionDir=path.join(DATA,r.id,'sessions'),progress=[process.execPath,path.join(ROOT,'progress.mjs'),sessionDir].map(quote).join(' '),piCommand=args.map(quote).join(' ');
 const header=`/usr/bin/printf '\\033[2J\\033[HLLM Test Lab\\n\\nSession: %s\\nModel: %s\\nContext: %s tokens\\n\\n[00:00] Checking the model server...\\n' ${quote(r.name)} ${quote(model.name)} ${quote(Number(config.contextWindow).toLocaleString('en-US'))}`;
 const command=`${header}; if ${runtimeReady}; then ${progress} & progress_pid=$!; ${piCommand}; result=$?; kill "$progress_pid" >/dev/null 2>&1 || true; wait "$progress_pid" >/dev/null 2>&1 || true; else result=$?; fi; if [ "$result" -eq 0 ]; then /usr/bin/printf '\\nCompleted successfully. This tmux session will now close.\\n'; else /usr/bin/printf '\\nStopped with exit code %s.\\n' "$result" >&2; fi; /usr/bin/printf '%s\\n' "$result" > ${quote(resultFile)}; exit "$result"`;
 tm('new-session','-d','-s',r.tmux,'-x','160','-y','45','-c',r.cwd,command);configureTestTmux(r.tmux);r.state='running';r.started=true;r.startedAt=new Date().toISOString();r.attempt=(r.attempt||0)+1;r.peakMemoryBytes=0;r.peakGpuMemoryBytes=0;r.peakCpuPercent=0;r.peakGpuPercent=0;r.peakPowerWatts=0;delete r.exitCode;delete r.completedAt;save();
}
const delay=ms=>new Promise(resolve=>setTimeout(resolve,ms));
function sessionStats(runId){
 const dir=path.join(DATA,runId,'sessions');if(!fs.existsSync(dir))return {generatedTokens:0,inputTokens:0,cacheReadTokens:0,responseCount:0,modelTimeMs:0,averageTokensPerSecond:null,lowTokensPerSecond:null,highTokensPerSecond:null};
 const rows=[];for(const name of fs.readdirSync(dir).filter(name=>name.endsWith('.jsonl'))){for(const line of fs.readFileSync(path.join(dir,name),'utf8').split('\n')){if(!line.trim())continue;try{rows.push(JSON.parse(line))}catch{}}}
 let generatedTokens=0,inputTokens=0,cacheReadTokens=0,modelTimeMs=0,timedGeneratedTokens=0;const rates=[];let lastAssistant=null;
 for(let i=0;i<rows.length;i++){const row=rows[i];if(row.type!=='message'||row.message?.role!=='assistant'||!row.message.usage)continue;lastAssistant=row;const output=Number(row.message.usage.output)||0;generatedTokens+=output;inputTokens+=Number(row.message.usage.input)||0;cacheReadTokens+=Number(row.message.usage.cacheRead)||0;const start=Date.parse(rows[i-1]?.timestamp),end=Date.parse(row.timestamp),elapsed=end-start;if(output>0&&elapsed>0){modelTimeMs+=elapsed;timedGeneratedTokens+=output;rates.push(output/(elapsed/1000))}}
 return {generatedTokens,timedGeneratedTokens,inputTokens,cacheReadTokens,responseCount:rates.length,modelTimeMs,latestTokensPerSecond:rates.length?rates.at(-1):null,averageTokensPerSecond:modelTimeMs?timedGeneratedTokens/(modelTimeMs/1000):null,lowTokensPerSecond:rates.length?Math.min(...rates):null,highTokensPerSecond:rates.length?Math.max(...rates):null,lastStopReason:lastAssistant?.message?.stopReason||null,lastError:lastAssistant?.message?.errorMessage||null};
}
function sampleSuiteCase(test){
 const sample=systemMetrics(),ram=sample.ram||{};captureHardware(test,sample);test.peakGpuAllocatedBytes=Math.max(test.peakGpuAllocatedBytes||0,ram.gpuAllocated||0);test.stats=sessionStats(test.runId);test.agentProgress=agentProgress({id:test.runId});test.elapsedMs=Date.now()-Date.parse(test.startedAt);
 if(test.revisionStartedAt)test.elapsedMs=(test.priorElapsedMs||0)+Date.now()-Date.parse(test.revisionStartedAt);
}
function suiteTotals(suite){
 const cases=suite.cases||[],stats=cases.map(test=>test.stats||{}),generatedTokens=stats.reduce((sum,item)=>sum+(item.generatedTokens||0),0),timedGeneratedTokens=stats.reduce((sum,item)=>sum+(item.timedGeneratedTokens||0),0),inputTokens=stats.reduce((sum,item)=>sum+(item.inputTokens||0),0),cacheReadTokens=stats.reduce((sum,item)=>sum+(item.cacheReadTokens||0),0),modelTimeMs=stats.reduce((sum,item)=>sum+(item.modelTimeMs||0),0),rates=stats.flatMap(item=>[item.lowTokensPerSecond,item.highTokensPerSecond]).filter(Number.isFinite);
 return {generatedTokens,inputTokens,cacheReadTokens,modelTimeMs,averageTokensPerSecond:modelTimeMs?timedGeneratedTokens/(modelTimeMs/1000):null,lowTokensPerSecond:rates.length?Math.min(...rates):null,highTokensPerSecond:rates.length?Math.max(...rates):null,peakMemoryBytes:Math.max(0,...cases.map(item=>item.peakMemoryBytes||0)),peakGpuMemoryBytes:Math.max(0,...cases.map(item=>item.peakGpuMemoryBytes||0)),peakGpuAllocatedBytes:Math.max(0,...cases.map(item=>item.peakGpuAllocatedBytes||0)),peakCpuPercent:Math.max(0,...cases.map(item=>item.peakCpuPercent||0)),peakGpuPercent:Math.max(0,...cases.map(item=>item.peakGpuPercent||0)),peakPowerWatts:Math.max(0,...cases.map(item=>item.peakPowerWatts||0))};
}
async function runRepeatedSession(parent){
 try{
  parent.started=true;parent.state='running';parent.startedAt=parent.startedAt||new Date().toISOString();parent.completedAt=null;parent.error=null;save();
  for(const iteration of parent.iterations){
   if(iteration.state==='complete')continue;
   if(parent.pauseRequested){parent.state='paused';save();return}
   if(!iteration.startedAt)fs.mkdirSync(iteration.cwd,{recursive:false});iteration.state='starting';iteration.startedAt=iteration.startedAt||new Date().toISOString();save();
   launch(iteration);iteration.state='running';save();
   while(alive(iteration)){const sample=systemMetrics();captureHardware(iteration,sample);iteration.stats=sessionStats(iteration.id);iteration.elapsedMs=Date.now()-Date.parse(iteration.startedAt);parent.stats=iteration.stats;parent.elapsedMs=Date.now()-Date.parse(parent.startedAt);parent.totals=iterationTotals(parent.iterations);save();await delay(2000)}
   const sample=systemMetrics();captureHardware(iteration,sample);iteration.stats=sessionStats(iteration.id);iteration.exitCode=exitCode(iteration);iteration.completedAt=new Date().toISOString();iteration.elapsedMs=Date.parse(iteration.completedAt)-Date.parse(iteration.startedAt);iteration.state=iteration.exitCode===0&&!iteration.stats?.lastError?'complete':'failed';if(iteration.state==='failed')iteration.error=iteration.stats?.lastError||`Pi exited with status ${iteration.exitCode??'unknown'}.`;parent.totals=iterationTotals(parent.iterations);save();
   if(iteration.state==='failed'){parent.state='partial';parent.error=`Run ${iteration.index} failed. Remaining repetitions were not started.`;break}
  }
  if(parent.state==='running')parent.state=parent.iterations.every(item=>item.state==='complete')?'complete':'partial';parent.completedAt=new Date().toISOString();parent.elapsedMs=Date.parse(parent.completedAt)-Date.parse(parent.startedAt);parent.stats=parent.iterations.at(-1)?.stats||parent.stats;parent.totals=iterationTotals(parent.iterations);save();
 }catch(error){parent.state='failed';parent.error=error.message;parent.completedAt=new Date().toISOString();parent.elapsedMs=parent.startedAt?Date.parse(parent.completedAt)-Date.parse(parent.startedAt):0;save()}
}
async function runProjectSuite(suite){
 suite.state='running';suite.startedAt=new Date().toISOString();saveSuites();
 for(const definition of suite.plan||quickSuiteCases){
  const runId=randomUUID(),test={id:definition.id,name:definition.name,prompt:definition.promptFile,runId,cwd:path.join(RUNS,'suite-'+suite.id.slice(0,8),definition.id),tmux:'pi-suite-'+runId.slice(0,8),state:'queued',grade:null,promptCount:1,revisions:[],startedAt:null,completedAt:null,elapsedMs:null,baselineMemoryBytes:null,peakMemoryBytes:0,peakGpuMemoryBytes:0,peakGpuAllocatedBytes:0,stats:sessionStats(runId)};suite.cases.push(test);suite.currentCase=definition.id;fs.mkdirSync(test.cwd,{recursive:true});saveSuites();
  const run={id:runId,name:'suite-'+definition.id,prompt:definition.promptFile,model:suite.model,config:suite.config,cwd:test.cwd,customFolder:false,tmux:test.tmux,created:new Date().toISOString(),state:'queued'};
  try{const baseline=systemMetrics();test.baselineMemoryBytes=baseline.ram?.used||null;test.state='starting';test.startedAt=new Date().toISOString();saveSuites();launch(run);test.state='running';saveSuites();while(alive(run)){sampleSuiteCase(test);suite.elapsedMs=Date.now()-Date.parse(suite.startedAt);suite.totals=suiteTotals(suite);saveSuites();await delay(2000)}sampleSuiteCase(test);test.exitCode=exitCode(run);test.completedAt=new Date().toISOString();test.elapsedMs=Date.parse(test.completedAt)-Date.parse(test.startedAt);const outputFiles=files(test.cwd);test.outputFiles=outputFiles.length;test.entryFile=outputFiles.find(file=>file.name==='index.html')?.name||outputFiles.find(file=>file.name.endsWith('.html'))?.name||null;test.state=stoppedSuiteCases.delete(test.runId)?'stopped':test.exitCode!==0||test.stats.lastStopReason==='error'||test.stats.lastError||!test.entryFile?'failed':'complete';if(test.state==='failed')test.error=test.stats.lastError||(test.exitCode===null?'The benchmark terminal ended without a completion status.':test.exitCode!==0?'Pi exited with status '+test.exitCode+'.':!test.entryFile?'Pi finished without creating a launchable HTML app.':'Pi stopped with an error.');if(test.state==='stopped')test.error='Stopped by user.'}catch(error){test.state='failed';test.error=error.message;test.completedAt=new Date().toISOString();test.elapsedMs=test.startedAt?Date.parse(test.completedAt)-Date.parse(test.startedAt):0}suite.elapsedMs=Date.now()-Date.parse(suite.startedAt);suite.totals=suiteTotals(suite);saveSuites();if(test.state==='stopped')break;
 }
 suite.currentCase=null;suite.completedAt=new Date().toISOString();suite.elapsedMs=Date.parse(suite.completedAt)-Date.parse(suite.startedAt);suite.state=suite.cases.some(test=>test.state==='stopped')?'stopped':suite.cases.every(test=>test.state==='complete')?'complete':'partial';suite.totals=suiteTotals(suite);saveSuites();
}
async function runSuiteRevision(suite,test,instructions,mode){
 const revision={number:(test.revisions?.length||0)+1,mode,instructions,startedAt:new Date().toISOString(),state:'running'};test.revisions=test.revisions||[];test.revisions.push(revision);test.promptCount=(test.promptCount||1)+1;test.grade=null;test.state='revising';test.priorElapsedMs=test.elapsedMs||0;test.revisionStartedAt=revision.startedAt;delete test.error;suite.state='revising';suite.currentCase=test.id;delete suite.error;saveSuites();
 const run={id:test.runId,name:'suite-'+test.id+'-revision-'+revision.number,prompt:test.prompt,model:suite.model,config:suite.config,cwd:test.cwd,customFolder:false,tmux:test.tmux,created:new Date().toISOString(),state:'queued',started:true,continuePrompt:instructions};
 try{launch(run);while(alive(run)){sampleSuiteCase(test);suite.totals=suiteTotals(suite);saveSuites();await delay(2000)}sampleSuiteCase(test);test.exitCode=exitCode(run);const outputFiles=files(test.cwd);test.outputFiles=outputFiles.length;test.entryFile=outputFiles.find(file=>file.name==='index.html')?.name||outputFiles.find(file=>file.name.endsWith('.html'))?.name||null;test.state=stoppedSuiteCases.delete(test.runId)?'stopped':test.exitCode===0&&!test.stats?.lastError&&!!test.entryFile?'complete':'failed';if(test.state==='failed')test.error=test.stats?.lastError||(!test.entryFile?'Pi finished the revision without a launchable HTML app.':`Pi revision exited with status ${test.exitCode??'unknown'}.`);if(test.state==='stopped')test.error='Stopped by user.';revision.state=test.state;revision.completedAt=new Date().toISOString()}catch(error){test.state='failed';test.error=error.message;revision.state='failed';revision.error=error.message;revision.completedAt=new Date().toISOString()}finally{test.completedAt=new Date().toISOString();suite.elapsedMs=(suite.elapsedMs||0)+Math.max(0,Date.parse(test.completedAt)-Date.parse(revision.startedAt));delete test.revisionStartedAt;delete test.priorElapsedMs;suite.currentCase=null;suite.completedAt=test.completedAt;suite.state=test.state==='stopped'?'stopped':suite.cases.every(item=>item.state==='complete')?'complete':'partial';suite.totals=suiteTotals(suite);saveSuites()}
}
async function monitorRecoveredSuiteCase(suite,test){
 const revision=(test.revisions||[]).at(-1),isRevision=revision&&['running','stopping'].includes(revision.state);
 while(tmuxAlive(test.tmux)){sampleSuiteCase(test);suite.totals=suiteTotals(suite);saveSuites();await delay(2000)}
 sampleSuiteCase(test);
 if(stoppedSuiteCases.delete(test.runId)||test.state==='stopped')test.state='stopped';
 else{
  test.exitCode=exitCode({id:test.runId});
  const outputFiles=files(test.cwd);
  test.outputFiles=outputFiles.length;
  test.entryFile=outputFiles.find(file=>file.name==='index.html')?.name||outputFiles.find(file=>file.name.endsWith('.html'))?.name||null;
  test.state=test.exitCode===0&&!test.stats?.lastError&&!!test.entryFile?'complete':'failed';
  if(test.state==='failed')test.error=test.stats?.lastError||(!test.entryFile?'Pi finished without a launchable HTML app.':'Pi exited with status '+(test.exitCode??'unknown')+'.');
 }
 const completedAt=new Date().toISOString();
 test.completedAt=completedAt;
 if(isRevision){revision.state=test.state;revision.completedAt=completedAt}
 delete test.revisionStartedAt;
 delete test.priorElapsedMs;
 suite.currentCase=null;
 suite.completedAt=completedAt;
 suite.state=test.state==='stopped'?'stopped':suite.cases.every(item=>item.state==='complete')?'complete':'partial';
 suite.totals=suiteTotals(suite);
 saveSuites();
}
function files(dir,base=dir,depth=0){if(depth>4)return [];return fs.readdirSync(dir,{withFileTypes:true}).filter(e=>!e.name.startsWith('.')&&!['addons','node_modules'].includes(e.name)).flatMap(e=>{let p=path.join(dir,e.name);return e.isSymbolicLink()?[]:e.isDirectory()?files(p,base,depth+1):[{name:path.relative(base,p),size:fs.statSync(p).size}] }).slice(0,300)}
async function body(req){let s='';for await(const c of req){s+=c;if(s.length>100000)throw Error('Request too large')}return JSON.parse(s||'{}')}
const json=(res,data,status=200)=>{res.writeHead(status,{'Content-Type':'application/json','Cache-Control':'no-store'});res.end(JSON.stringify(data))};
async function directChat(payload){
 const model=models().find(item=>item.id===payload.model),config=configs().find(item=>item.id===payload.config),messages=payload.messages;
 if(!model||!config)throw Error('Select an available model and configuration.');
 if(runs.some(alive)||quickSuites.some(suite=>suite.cases?.some(test=>test.tmux&&tmuxAlive(test.tmux))))throw Error('Wait for active benchmarks to finish before chatting so their measurements stay clean.');
 if(contextChecks.some(check=>['queued','starting','running'].includes(check.state)))throw Error('Wait for the active context check to finish before chatting.');
 if(!Array.isArray(messages)||!messages.length||messages.length>24)throw Error('Chat history must contain between 1 and 24 messages.');
 let total=0;for(const message of messages){if(!['user','assistant'].includes(message?.role)||typeof message.content!=='string'||!message.content.trim()||message.content.length>10000)throw Error('Chat messages must contain a valid role and 1 to 10,000 characters.');total+=message.content.length}if(total>60000)throw Error('Chat history is too large. Clear the chat and try again.');
 const runtime=ensureModelRuntime(model,config);if(runtime){const deadline=Date.now()+120000;let ready=false;while(Date.now()<deadline){if(!tmuxAlive(runtime.session))throw Error('The managed model exited while loading. Reduce the context or memory pressure.');try{const response=await fetch(runtime.health,{headers:{Authorization:'Bearer '+runtime.apiKey},signal:AbortSignal.timeout(1500)});if(response.ok){ready=true;break}}catch{}await delay(1000)}if(!ready||reportedRuntimeContext(model,runtime.session)<config.contextWindow)throw Error('The model server did not load the requested context within two minutes.')}
	 const endpoint=new URL(model.baseUrl);endpoint.pathname=endpoint.pathname.replace(/\/$/,'')+'/chat/completions';const response=await fetch(endpoint,{method:'POST',headers:{Authorization:'Bearer '+(runtime?.apiKey||model.apiKey||'local'),'Content-Type':'application/json'},body:JSON.stringify({model:model.providerModelId||model.id,messages:messages.map(({role,content})=>({role,content})),max_tokens:config.maxTokens,temperature:config.temperature,top_p:config.topP,top_k:config.topK,min_p:config.minP}),signal:AbortSignal.timeout(600000)}),text=await response.text();let result;try{result=JSON.parse(text)}catch{result=null}if(!response.ok)throw Error(String(result?.error?.message||text||`Inference server returned HTTP ${response.status}`).slice(0,800));const answer=result?.choices?.[0]?.message,content=answer?.content||answer?.reasoning_content;if(typeof content!=='string'||!content.trim())throw Error('The model returned an empty response.');return {message:content,model:model.name,usage:result.usage||null};
}
function chooseFolder(){return new Promise((resolve,reject)=>execFile('/usr/bin/osascript',['-e','POSIX path of (choose folder with prompt "Choose a project folder for this test session")'],{encoding:'utf8',timeout:60000},(error,stdout,stderr)=>{if(error){if(String(stderr).includes('User canceled'))return resolve(null);return reject(Error('The folder picker could not be opened.'))}resolve(path.resolve(stdout.trim()))}))}
for(const candidate of recoverableSuiteCases){const suite=quickSuites.find(item=>item.id===candidate.suiteId),test=suite?.cases?.find(item=>item.id===candidate.testId);if(suite&&test)void monitorRecoveredSuiteCase(suite,test)}
http.createServer(async(req,res)=>{try{
 if(![`127.0.0.1:${PORT}`,`localhost:${PORT}`].includes(req.headers.host))return json(res,{error:'Invalid host'},403);
 if(req.method!=='GET'&&(![origin,`http://localhost:${PORT}`].includes(req.headers.origin)||!req.headers['content-type']?.startsWith('application/json')))return json(res,{error:'Same-origin JSON required'},403);
 const u=new URL(req.url,origin);
	 if(req.method==='GET'&&u.pathname==='/api/state')return json(res,{prompts:prompts(),models:models().map(({modelFile,serverArgs,apiKey,...m})=>({...m,metadata:modelMetadata(m),activeContext:m.runtime==='llama.cpp'&&tmuxAlive(modelSessionName(m))?reportedRuntimeContext({...m,apiKey}):null})),servers:publicInferenceServers(),serverMode:serverModeSnapshot(),configs:configs(),runs:runSnapshots(),suiteDefinitions:suiteDefinitions.map(suite=>({...suite})),quickSuiteCases:quickSuiteCases.map(test=>({...test})),quickSuites:suiteSnapshots(),downloads:downloads.slice(0,10),contextChecks:contextChecks.slice(0,10),defaultRunFolder:RUNS,system:systemMetrics(),gpuLimit:gpuLimit()});
	 if(req.method==='POST'&&u.pathname==='/api/chat')return json(res,await directChat(await body(req)));
	 if(req.method==='POST'&&u.pathname==='/api/servers')return json(res,await saveInferenceServer(await body(req)));
	 const serverMatch=u.pathname.match(/^\/api\/servers\/([^/]+)\/remove$/);if(req.method==='POST'&&serverMatch){if(runs.some(run=>run.model?.startsWith('remote:'+serverMatch[1]+':')&&alive(run)))throw Error('Finish the active test using this server before removing it.');return json(res,removeInferenceServer(serverMatch[1]))}
	 if(req.method==='POST'&&u.pathname==='/api/server-mode/start'){
	  if(serverMode.enabled)throw Error('Server mode is already active. Stop it before starting another model.');
	  if(runs.some(alive)||quickSuites.some(suite=>suite.cases?.some(test=>test.tmux&&tmuxAlive(test.tmux)))||contextChecks.some(check=>['queued','starting','running','stopping'].includes(check.state)))throw Error('Finish the active workload before starting Server mode.');
	  const payload=await body(req),model=models().find(item=>item.id===payload.model),config=configs().find(item=>item.id===payload.config);if(!model||!config)throw Error('Select an available model and preset.');if(model.runtime!=='llama.cpp')throw Error('Server mode requires a managed local GGUF model.');if(model.contextWindow&&config.contextWindow>model.contextWindow)throw Error('The selected preset exceeds this model’s context limit.');
	  releaseIdleManagedRuntimes(model.id,{restartSelected:true});const previous=serverMode;serverMode={enabled:true,modelId:model.id,configId:config.id,apiKey:randomUUID().replaceAll('-',''),startedAt:new Date().toISOString()};saveServerMode();
	  try{ensureModelRuntime(model,config);return json(res,serverModeSnapshot(),202)}catch(error){serverMode=previous;saveServerMode();throw error}
	 }
	 if(req.method==='POST'&&u.pathname==='/api/server-mode/stop'){
	  if(!serverMode.enabled)throw Error('Server mode is not active.');const model=models().find(item=>item.id===serverMode.modelId);if(model&&modelIsBusy(model.id))throw Error('Finish the active workload using this server before stopping it.');if(model&&tmuxAlive(modelSessionName(model))){tm('kill-session','-t',modelSessionName(model));waitForPortRelease(model)}serverMode={enabled:false,stoppedAt:new Date().toISOString()};saveServerMode();return json(res,serverModeSnapshot());
	 }
	 if(req.method==='POST'&&u.pathname==='/api/server-mode/terminal'){const model=models().find(item=>item.id===serverMode.modelId);if(!serverMode.enabled||!model)throw Error('Server mode is not active.');openModelTerminal(model);return json(res,{ok:true})}
 if(req.method==='POST'&&u.pathname==='/api/system/gpu-limit')return json(res,setGpuLimit((await body(req)).mb));
 if(req.method==='POST'&&['/api/quick-suites','/api/models/context-check'].includes(u.pathname)&&quickSuites.some(suite=>suite.cases?.some(test=>test.tmux&&tmuxAlive(test.tmux))))throw Error('Finish the active benchmark process before starting another clean workload.');
 if(req.method==='POST'&&u.pathname==='/api/quick-suites'){const b=await body(req),model=models().find(m=>m.id===b.model),config=configs().find(c=>c.id===b.config),definition=suiteDefinitions.find(suite=>suite.id===(b.suite||'quick'));if(!model||!config)throw Error('Select an available model and configuration.');if(!definition)throw Error('Select a benchmark suite.');if(quickSuites.some(s=>['queued','starting','running'].includes(s.state)))throw Error('A benchmark suite is already running.');if(runs.some(alive))throw Error('Pause or finish active single sessions before starting a benchmark so its speed and memory results remain accurate.');if(model.runtime==='llama.cpp')releaseIdleManagedRuntimes(model.id,{restartSelected:true});const suite={id:randomUUID(),kind:'project-suite',suiteId:definition.id,suiteName:definition.name,suiteVersion:definition.version,repetitions:definition.repetitions,plan:definition.cases.map(test=>({...test})),model:model.id,modelName:model.name,modelSnapshot:modelMetadata(model,config),config:config.id,configName:config.name,configuration:{...config},state:'queued',createdAt:new Date().toISOString(),cases:[],totals:null};quickSuites.unshift(suite);saveSuites();void runProjectSuite(suite);return json(res,suite,202)}
 const stoppedRevisionMatch=u.pathname.match(/^\/api\/quick-suites\/([^/]+)\/cases\/([^/]+)\/revise$/);
 if(req.method==='POST'&&stoppedRevisionMatch){const suite=quickSuites.find(item=>item.id===stoppedRevisionMatch[1]),test=suite?.cases?.find(item=>item.id===stoppedRevisionMatch[2]);if(test?.state==='stopped'){if(runs.some(alive)||quickSuites.some(item=>item.cases?.some(entry=>entry.tmux&&tmuxAlive(entry.tmux))))throw Error('Finish the active benchmark before starting a revision.');if(!hasSavedSession({id:test.runId}))throw Error('The saved Pi conversation for this app is unavailable.');const payload=await body(req),mode=payload.mode==='custom'?'custom':'normal',custom=String(payload.instructions||'').trim();if(mode==='custom'&&(custom.length<2||custom.length>4000))throw Error('Describe the problem in 2 to 4,000 characters.');const instructions=mode==='custom'?'The user reviewed the generated app and found these problems:\n\n'+custom+'\n\nInspect the existing project, fix every reported issue, finish incomplete work, and verify the app before stopping.':'The user stopped the previous revision before it completed. Inspect the saved progress, continue repairing unfinished or broken behavior, and verify the app before stopping.';void runSuiteRevision(suite,test,instructions,mode);return json(res,{ok:true,promptCount:(test.promptCount||1)+1},202)}}
 const suiteStopMatch=u.pathname.match(/^\/api\/quick-suites\/([^/]+)\/cases\/([^/]+)\/stop$/);
 if(req.method==='POST'&&suiteStopMatch){const suite=quickSuites.find(item=>item.id===suiteStopMatch[1]),test=suite?.cases?.find(item=>item.id===suiteStopMatch[2]);if(!suite||!test)throw Error('Unknown benchmark result.');if(!test.tmux||!tmuxAlive(test.tmux))throw Error('This benchmark case is not running.');stoppedSuiteCases.add(test.runId);test.state='stopping';const revision=(test.revisions||[]).at(-1);if(revision?.state==='running')revision.state='stopping';saveSuites();tm('kill-session','-t',test.tmux);const stoppedAt=new Date().toISOString();test.state='stopped';test.error='Stopped by user.';test.completedAt=stoppedAt;if(revision?.state==='stopping'){revision.state='stopped';revision.completedAt=stoppedAt}suite.state='stopped';suite.currentCase=null;suite.completedAt=stoppedAt;saveSuites();return json(res,{ok:true},202)}
 const suiteMatch=u.pathname.match(/^\/api\/quick-suites\/([^/]+)\/cases\/([^/]+)\/(open|terminal|finder|grade|revise)$/);
 if(suiteMatch){const suite=quickSuites.find(item=>item.id===suiteMatch[1]),test=suite?.cases?.find(item=>item.id===suiteMatch[2]);if(!suite||!test)throw Error('Unknown benchmark result.');const action=suiteMatch[3];if(req.method==='POST'&&action==='grade'){if(test.state!=='complete')throw Error('Finish this app before grading it.');const grade=Number((await body(req)).grade);if(!Number.isInteger(grade)||grade<1||grade>5)throw Error('Grade must be between 1 and 5.');test.grade=grade;test.gradedAt=new Date().toISOString();saveSuites();return json(res,test)}if(req.method==='POST'&&action==='revise'){if(!['complete','failed'].includes(test.state))throw Error('This app must finish before it can be revised.');if(runs.some(alive)||quickSuites.some(item=>item.cases?.some(entry=>entry.tmux&&tmuxAlive(entry.tmux))))throw Error('Finish the active benchmark before starting a revision.');if(!hasSavedSession({id:test.runId}))throw Error('The saved Pi conversation for this app is unavailable.');const payload=await body(req),mode=payload.mode==='custom'?'custom':'normal',custom=String(payload.instructions||'').trim();if(mode==='custom'&&(custom.length<2||custom.length>4000))throw Error('Describe the problem in 2 to 4,000 characters.');const instructions=mode==='custom'?`The user reviewed the generated app and found these problems:\n\n${custom}\n\nInspect the existing project, fix every reported issue, finish incomplete work, and verify the app before stopping.`:'The user reviewed the generated app and says it does not work or is not finished. Inspect the current project critically, identify incomplete or broken behavior, repair it, and verify the app before stopping.';void runSuiteRevision(suite,test,instructions,mode);return json(res,{ok:true,promptCount:(test.promptCount||1)+1},202)}if(req.method==='POST'&&action==='terminal'){openTerminal({...test,id:test.runId});return json(res,{ok:true})}if(req.method==='POST'&&action==='finder'){execFileSync('/usr/bin/open',[test.cwd]);return json(res,{ok:true})}if(req.method==='POST'&&action==='open'){const entry=test.entryFile||files(test.cwd).map(file=>file.name).find(name=>name==='index.html')||files(test.cwd).map(file=>file.name).find(name=>name.endsWith('.html'));if(!entry)throw Error('No HTML app was found yet. Open the project folder to inspect its files.');execFileSync('/usr/bin/open',[path.join(test.cwd,entry)]);return json(res,{ok:true})}}
 if(req.method==='POST'&&u.pathname==='/api/models/refresh')return json(res,refreshModels());
 if(req.method==='POST'&&u.pathname==='/api/context-fit-checks'){
  if(runs.some(alive)||quickSuites.some(suite=>suite.cases?.some(test=>test.tmux&&tmuxAlive(test.tmux))))throw Error('Finish the active benchmark before running a context stress test.');
  if(contextChecks.some(check=>['queued','starting','running','stopping'].includes(check.state)))throw Error('A context test is already running.');
  const payload=await body(req),model=models().find(item=>item.id===payload.model),config=configs().find(item=>item.id===payload.config),contextWindow=Number(payload.contextWindow);
  if(!model||!config)throw Error('Select an available model and configuration.');
  if(model.runtime!=='llama.cpp')throw Error('Context stress tests require a managed local GGUF model.');
  if(!Number.isInteger(contextWindow)||contextWindow<4096||contextWindow>1048576)throw Error('Choose a context between 4,096 and 1,048,576 tokens.');
  if(model.contextWindow&&contextWindow>model.contextWindow)throw Error('The requested context exceeds the model limit of '+model.contextWindow.toLocaleString()+' tokens.');
  if(config.maxTokens>=contextWindow)throw Error('The context must be larger than the preset maximum response.');
  releaseIdleManagedRuntimes(model.id,{restartSelected:true});
  const check={id:randomUUID(),kind:'stress',model:model.id,modelName:model.name,config:config.id,configName:config.name,requestedContext:contextWindow,declaredContext:model.contextWindow||null,modelBytes:model.fileBytes||null,state:'queued',phase:'Queued',percent:0,createdAt:new Date().toISOString()};
  contextChecks.unshift(check);saveContextChecks();void runUsefulContextCheck(check,{...config,contextWindow});return json(res,check,202);
 }
 const contextStopMatch=u.pathname.match(/^\/api\/context-fit-checks\/([^/]+)\/stop$/);
 if(req.method==='POST'&&contextStopMatch){const check=contextChecks.find(item=>item.id===contextStopMatch[1]);if(!check||!['queued','starting','running'].includes(check.state))throw Error('This context test is not running.');check.state='stopping';check.phase='Stopping';saveContextChecks();contextCheckControllers.get(check.id)?.abort(Error('Stopped by user.'));if(check.runtimeSession&&tmuxAlive(check.runtimeSession))tm('kill-session','-t',check.runtimeSession);return json(res,{ok:true},202)}
 if(req.method==='POST'&&u.pathname==='/api/models/context-check'){const b=await body(req),model=models().find(item=>item.id===b.model),config=configs().find(item=>item.id===b.config);if(!model||!config)throw Error('Select an available model and configuration.');if(model.runtime!=='llama.cpp')throw Error('Context checks are available for local GGUF models.');if(runs.some(alive)||quickSuites.some(suite=>['queued','starting','running'].includes(suite.state)))throw Error('Finish or remove active tests before loading a model for a clean memory check.');if(contextChecks.some(check=>['queued','starting','running'].includes(check.state)))throw Error('A context check is already running.');if(model.contextWindow&&config.contextWindow>model.contextWindow)throw Error(`This preset exceeds the model metadata limit of ${model.contextWindow.toLocaleString()} tokens.`);releaseIdleManagedRuntimes(model.id,{restartSelected:true});const check={id:randomUUID(),model:model.id,modelName:model.name,config:config.id,configName:config.name,requestedContext:config.contextWindow,declaredContext:model.contextWindow||null,modelBytes:model.fileBytes||null,state:'queued',createdAt:new Date().toISOString(),reportedContext:null,baselineMemoryBytes:null,peakMemoryBytes:null,peakGpuMemoryBytes:null,peakGpuAllocatedBytes:null};contextChecks.unshift(check);saveContextChecks();void runContextCheck(check);return json(res,check,202)}
 if(req.method==='GET'&&u.pathname==='/api/huggingface/search'){const query=(u.searchParams.get('q')||'').trim();if(query.length<2||query.length>100)throw Error('Enter between 2 and 100 characters.');return json(res,{results:await searchHuggingFace(query)});}
 if(req.method==='POST'&&u.pathname==='/api/huggingface/download'){const b=await body(req);if(!validRepo(b.repo)||!Array.isArray(b.files)||!b.files.length||b.files.length>20||!b.files.every(validHfFile))throw Error('Invalid Hugging Face selection.');if(downloads.some(d=>['queued','downloading','stopping'].includes(d.state)))throw Error('A model download is already running.');const job={id:randomUUID(),repo:b.repo,name:String(b.name||b.files[0]).slice(0,160),files:b.files,state:'queued',createdAt:new Date().toISOString(),downloadedBytes:0,totalBytes:Number(b.totalBytes)||0};downloads.unshift(job);saveDownloads();void downloadHuggingFace(job);return json(res,job,202)}
 const downloadAction=u.pathname.match(/^\/api\/huggingface\/download\/([^/]+)\/(stop|retry)$/);if(req.method==='POST'&&downloadAction){const job=downloads.find(item=>item.id===downloadAction[1]);if(!job)throw Error('Unknown model download.');if(downloadAction[2]==='stop'){if(!['queued','downloading'].includes(job.state))throw Error('This download is not running.');job.state='stopping';job.error='Stopping download…';saveDownloads();downloadControllers.get(job.id)?.abort();return json(res,job,202)}if(!['interrupted','failed','stopped'].includes(job.state))throw Error('Only interrupted, failed, or stopped downloads can start again.');if(downloads.some(item=>item.id!==job.id&&['queued','downloading','stopping'].includes(item.state)))throw Error('Another model download is already running.');job.state='queued';job.restartedAt=new Date().toISOString();delete job.error;delete job.completedAt;saveDownloads();void downloadHuggingFace(job);return json(res,job,202)}
 if(req.method==='POST'&&u.pathname==='/api/configs')return json(res,saveConfig(await body(req)));
 if(req.method==='POST'&&u.pathname==='/api/folders/choose'){const folder=await chooseFolder();if(!folder)return json(res,{canceled:true});const token=randomUUID();folderSelections.set(token,{folder,expires:Date.now()+600000});return json(res,{token,path:folder});}
 if(req.method==='POST'&&u.pathname==='/api/folders'){const b=await body(req),folder={models:modelDir,configs:configDir}[b.folder];if(!folder)throw Error('Unknown folder');execFileSync('/usr/bin/open',[folder]);return json(res,{ok:true});}
 if(req.method==='POST'&&u.pathname==='/api/runs'){
 const b=await body(req),p=prompts().find(p=>p.name===b.prompt);if(!p)throw Error('Unknown prompt');
 if(!models().some(m=>m.id===b.model))throw Error('Unknown or unavailable Ollama model');
 if(!configs().some(c=>c.id===b.config))throw Error('Select a configuration');
 const repetitions=Number(b.repetitions||1);if(!Number.isInteger(repetitions)||repetitions<1||repetitions>10)throw Error('Choose between 1 and 10 repetitions.');
 const id=randomUUID(),picked=folderSelections.get(b.folderToken);if(b.folderToken&&(!picked||picked.expires<=Date.now()))throw Error('Folder selection expired. Choose the folder again.');const selection=b.folderToken?picked:null,base=selection?.folder||RUNS,cwd=repetitions>1?path.join(base,'llm-test-'+id.slice(0,8)):(selection?.folder||path.join(RUNS,id));folderSelections.delete(b.folderToken);fs.mkdirSync(cwd,{recursive:true});
 const model=models().find(model=>model.id===b.model),configuration=configs().find(config=>config.id===b.config),common={name:p.displayName,prompt:b.prompt,model:b.model,config:b.config},r={id,...common,promptSnapshot:{id:p.id,name:p.displayName,file:p.file,category:p.category,difficulty:p.difficulty,version:p.version,hash:p.hash,hashAlgorithm:p.hashAlgorithm},modelSnapshot:modelMetadata(model,configuration),configurationSnapshot:{...configuration},cwd,customFolder:!!selection,tmux:'pi-bench-'+id.slice(0,8),created:new Date().toISOString(),state:'queued',repetitions};if(repetitions>1){r.kind='repeated-session';r.iterations=Array.from({length:repetitions},(_,index)=>{const iterationId=randomUUID();return {id:iterationId,index:index+1,...common,name:`${p.displayName} · Run ${index+1}`,cwd:path.join(cwd,'run-'+String(index+1).padStart(2,'0')),customFolder:false,tmux:'pi-repeat-'+iterationId.slice(0,8),created:new Date().toISOString(),state:'queued'}})}runs.unshift(r);save();return json(res,r);
 }
 const m=u.pathname.match(/^\/api\/runs\/([^/]+)(?:\/(files|file|start|continue|pause|open|finder|remove|model|config))?$/);
 if(m){const r=runs.find(r=>r.id===m[1]);if(!r)throw Error('Unknown run');const action=m[2];
 const target=executionFor(r),outputRoot=r.kind==='repeated-session'?(target?.cwd||r.cwd):r.cwd;
 if(req.method==='GET'&&action==='files')return json(res,files(outputRoot));
 if(req.method==='GET'&&action==='file'){const p=path.resolve(outputRoot,u.searchParams.get('name')||'');if(!p.startsWith(outputRoot+path.sep)||!fs.realpathSync(p).startsWith(fs.realpathSync(outputRoot)+path.sep))throw Error('Invalid path');if(fs.statSync(p).size>500000)throw Error('File too large');return json(res,{text:fs.readFileSync(p,'utf8')});}
 if(req.method==='POST'&&action==='start'){if(alive(r))throw Error('Session already running');if(r.kind==='repeated-session'){if(r.started&&!['paused','interrupted'].includes(r.state))throw Error('This repeated benchmark has already run. Create a new session for another clean comparison.');r.pauseRequested=false;void runRepeatedSession(r);return json(res,r,202)}launch(r);return json(res,r);}
 if(req.method==='POST'&&action==='continue'){if(!alive(r))throw Error('Session is not running');tm('send-keys','-t',target.tmux,'-l','Continue the benchmark from current progress and verify the result.');tm('send-keys','-t',target.tmux,'Enter');r.state='running';r.pauseRequested=false;target.state='running';save();return json(res,r);}
 if(req.method==='POST'&&action==='pause'){if(alive(r))tm('send-keys','-t',target.tmux,'Escape');r.state='paused';r.pauseRequested=true;if(target&&target!==r)target.state='paused';save();return json(res,r);}
 if(req.method==='POST'&&action==='open'){openTerminal(r);return json(res,{ok:true});}
 if(req.method==='POST'&&action==='finder'){if(!fs.existsSync(r.cwd))throw Error('The project folder no longer exists.');execFileSync('/usr/bin/open',[r.cwd]);return json(res,{ok:true});}
 if(req.method==='POST'&&action==='remove'){if(alive(r))tm('kill-session','-t',target.tmux);runs=runs.filter(x=>x.id!==r.id);save();return json(res,{ok:true,cwd:r.cwd,filesPreserved:true});}
 if(req.method==='POST'&&action==='config'){if(alive(r))throw Error('Configuration changes apply to stopped or new runs.');const b=await body(req);if(!configs().some(c=>c.id===b.config))throw Error('Unknown configuration');r.config=b.config;save();return json(res,r);}
 if(req.method==='POST'&&action==='model'){if(alive(r))throw Error('Pause or stop the run before changing its model.');const b=await body(req);if(!models().some(m=>m.id===b.model))throw Error('Unknown or unavailable Ollama model');r.model=b.model;save();return json(res,r);}
 }
 const staticMap={'/':'index.html','/app.js':'app.js','/style.css':'style.css'};if(req.method==='GET'&&staticMap[u.pathname]){res.setHeader('Content-Type',u.pathname.endsWith('.js')?'text/javascript':u.pathname.endsWith('.css')?'text/css':'text/html');return res.end(fs.readFileSync(path.join(import.meta.dirname,'public',staticMap[u.pathname])))}json(res,{error:'Not found'},404);
 }catch(e){json(res,{error:e.message},400)}}).listen(PORT,'127.0.0.1',()=>console.log(`Pi Bench Console: ${origin}`));
