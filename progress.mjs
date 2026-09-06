import fs from 'node:fs';
import path from 'node:path';

const sessionDir=process.argv[2];
const completionFile=process.argv[3]||null;
const startedAt=Date.now();
let lastSignature='';
let lastHeartbeat=0;
let stopping=false;
const processedLines=new Map();

function clipped(value,limit=12000){
 const text=String(value??'').trimEnd();
 return text.length<=limit?text:`${text.slice(0,limit)}\n… output clipped in this view (${(text.length-limit).toLocaleString()} more characters)`;
}

function contentText(content){
 if(typeof content==='string')return content;
 if(!Array.isArray(content))return '';
 return content.filter(item=>item?.type==='text'&&typeof item.text==='string').map(item=>item.text).join('\n');
}

function renderMessage(row){
 const message=row?.type==='message'?row.message:null;if(!message)return;
 if(message.role==='user'){
  const value=contentText(message.content);
  if(value.startsWith('<file name=')){console.log('\n━━ Benchmark prompt loaded ━━');return}
  if(value)console.log(`\n━━ User ━━\n${clipped(value)}`);
  return;
 }
 if(message.role==='assistant'){
  const usage=message.usage||{},details=[];
  if(Number.isFinite(Number(usage.output)))details.push(`${Number(usage.output).toLocaleString()} tokens`);
  if(message.stopReason)details.push(message.stopReason);
  console.log(`\n━━ Assistant${details.length?` · ${details.join(' · ')}`:''} ━━`);
  for(const item of Array.isArray(message.content)?message.content:[]){
   if(item?.type==='text'&&item.text)console.log(clipped(item.text));
   if(item?.type==='toolCall'){
    console.log(`\n→ ${item.name||'tool'}`);
    const command=item.arguments?.command;
    console.log(clipped(typeof command==='string'?`$ ${command}`:JSON.stringify(item.arguments||{},null,2),6000));
   }
  }
  return;
 }
 if(message.role==='toolResult'){
  console.log(`\n← ${message.toolName||'tool'}${message.isError?' · error':' · complete'}`);
  const value=contentText(message.content);if(value)console.log(clipped(value));
 }
}

function renderConversation(){
 if(!sessionDir||!fs.existsSync(sessionDir))return;
 for(const name of fs.readdirSync(sessionDir).filter(name=>name.endsWith('.jsonl')).sort()){
  const file=path.join(sessionDir,name);let lines=[];
  try{lines=fs.readFileSync(file,'utf8').split('\n')}catch{continue}
  let index=processedLines.get(file)||0;
  for(;index<lines.length;index++){
   if(!lines[index].trim())continue;
   try{renderMessage(JSON.parse(lines[index]))}catch{break}
  }
  processedLines.set(file,index);
 }
}

function duration(ms){
 const seconds=Math.max(0,Math.floor(ms/1000));
 const hours=Math.floor(seconds/3600),minutes=Math.floor((seconds%3600)/60),remainder=seconds%60;
 return hours?`${String(hours).padStart(2,'0')}:${String(minutes).padStart(2,'0')}:${String(remainder).padStart(2,'0')}`:`${String(minutes).padStart(2,'0')}:${String(remainder).padStart(2,'0')}`;
}

function stats(){
 let generatedTokens=0,inputTokens=0,responses=0,lastStopReason=null;
 if(!sessionDir||!fs.existsSync(sessionDir))return {generatedTokens,inputTokens,responses,lastStopReason};
 for(const name of fs.readdirSync(sessionDir).filter(name=>name.endsWith('.jsonl'))){
  const file=path.join(sessionDir,name);
  let content='';
  try{content=fs.readFileSync(file,'utf8')}catch{continue}
  for(const line of content.split('\n')){
   if(!line.trim())continue;
   try{
    const row=JSON.parse(line),message=row.type==='message'?row.message:null;
    if(message?.role!=='assistant'||!message.usage)continue;
    generatedTokens+=Number(message.usage.output)||0;
    inputTokens+=Number(message.usage.input)||0;
    responses+=1;
    lastStopReason=message.stopReason||lastStopReason;
   }catch{}
  }
 }
 return {generatedTokens,inputTokens,responses,lastStopReason};
}

function render(force=false){
 renderConversation();
 if(completionFile&&fs.existsSync(completionFile)){
  let exitCode='unknown';try{exitCode=fs.readFileSync(completionFile,'utf8').trim()||'unknown'}catch{}
  console.log(`\nBenchmark finished with exit code ${exitCode}. Closing the activity window.`);
  stop();return;
 }
 const current=stats(),now=Date.now(),signature=`${current.responses}:${current.generatedTokens}:${current.lastStopReason||''}`;
 if(!force&&signature===lastSignature&&now-lastHeartbeat<60000)return;
 lastSignature=signature;lastHeartbeat=now;
 const elapsed=duration(now-startedAt);
 if(current.responses===0)console.log(`[${elapsed}] Pi is working autonomously · waiting for the first model response`);
 else console.log(`[${elapsed}] Pi is working autonomously · ${current.responses.toLocaleString()} responses · ${current.generatedTokens.toLocaleString()} generated tokens${current.lastStopReason?` · last: ${current.lastStopReason}`:''}`);
}

console.log('LLM Test Lab · live benchmark activity');
console.log('Model server ready. Pi is now running in autonomous mode.');
console.log('Conversation and progress are recorded below; use the mouse wheel or tmux copy mode to review them.');
render(true);
const timer=setInterval(render,10000);
function stop(){if(stopping)return;stopping=true;clearInterval(timer);process.exit(0)}
process.on('SIGTERM',stop);
process.on('SIGINT',stop);
