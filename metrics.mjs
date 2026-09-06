import {execFileSync,spawn} from 'node:child_process';
import os from 'node:os';

let sample=null,received=0,child,retry,closing=false;
let previous=os.cpus().map(c=>c.times);
function collect(){
 let buffer='';
 child=spawn(process.env.MACMON_BIN||'macmon',['pipe','--interval','2000'],{stdio:['ignore','pipe','ignore']});
 child.stdout.setEncoding('utf8');
 child.stdout.on('data',chunk=>{
  buffer+=chunk;
  let end;
  while((end=buffer.indexOf('\n'))>=0){
   const line=buffer.slice(0,end);buffer=buffer.slice(end+1);
   try{sample=JSON.parse(line);received=Date.now()}catch{}
  }
 });
 child.on('error',()=>{});
 child.on('close',()=>{if(!closing)retry=setTimeout(collect,10000)});
}
collect();
function stop(){closing=true;clearTimeout(retry);child?.kill()}
process.on('exit',stop);
for(const signal of ['SIGTERM','SIGINT'])process.on(signal,()=>{stop();process.exit(0)});
const number=value=>typeof value==='number'&&Number.isFinite(value)?value:null;
const percent=value=>number(value)==null?null:Math.max(0,Math.min(100,value*100));
const sysctl=name=>{try{return execFileSync('/usr/sbin/sysctl',['-n',name],{encoding:'utf8',timeout:1200}).trim()}catch{return null}};
function hardwareInformation(){
 const cpuModel=sysctl('machdep.cpu.brand_string')||os.cpus()[0]?.model||null,physicalCores=Number(sysctl('hw.physicalcpu'))||os.cpus().length,logicalCores=Number(sysctl('hw.logicalcpu'))||os.cpus().length,performanceCores=Number(sysctl('hw.perflevel0.physicalcpu'))||null,efficiencyCores=Number(sysctl('hw.perflevel1.physicalcpu'))||null;
 let gpuModel=null,gpuCores=null;
 if(process.platform==='darwin')try{const displays=JSON.parse(execFileSync('/usr/sbin/system_profiler',['SPDisplaysDataType','-json'],{encoding:'utf8',timeout:5000,maxBuffer:2e6})).SPDisplaysDataType||[],gpu=displays.find(item=>item.sppci_device_type==='spdisplays_gpu')||displays[0];gpuModel=gpu?.sppci_model||gpu?._name||null;gpuCores=Number(gpu?.sppci_cores)||null}catch{}
 return {cpu:{model:cpuModel,physicalCores,logicalCores,performanceCores,efficiencyCores},gpu:{model:gpuModel,cores:gpuCores}};
}
const hardware=hardwareInformation();
let gpuMemorySample={allocated:null,inUse:null},gpuMemoryAt=0;
function gpuMemory(){
 if(Date.now()-gpuMemoryAt<2000)return gpuMemorySample;
 gpuMemoryAt=Date.now();
 try{const output=execFileSync('/usr/sbin/ioreg',['-r','-c','AGXAccelerator','-d','1'],{encoding:'utf8',timeout:1200,maxBuffer:2e6});gpuMemorySample={allocated:Number(output.match(/"Alloc system memory"=(\d+)/)?.[1])||null,inUse:Number(output.match(/"In use system memory"=(\d+)/)?.[1])||null}}catch{gpuMemorySample={allocated:null,inUse:null}}
 return gpuMemorySample;
}
export function systemMetrics(){
 const current=os.cpus().map(c=>c.times);
 let totalTicks=0,idle=0;
 current.forEach((t,i)=>{if(previous[i]){for(const key of Object.keys(t))totalTicks+=t[key]-previous[i][key];idle+=t.idle-previous[i].idle}});
 previous=current;
 const fresh=sample&&Date.now()-received<10000,s=fresh?sample:{};
 const total=number(s.memory?.ram_total)??os.totalmem(),used=number(s.memory?.ram_usage)??total-os.freemem(),gpuRam=gpuMemory();
 return {
  sampledAt:fresh?new Date(received).toISOString():null,
  hardware,
  cpu:{percent:percent(s.cpu_usage_pct)??(totalTicks?100*(1-idle/totalTicks):null),temperature:number(s.temp?.cpu_temp_avg)},
  gpu:{percent:percent(s.gpu_usage?.[1]),frequency:number(s.gpu_usage?.[0]),temperature:number(s.temp?.gpu_temp_avg)},
  ram:{total,used,available:total-used,percent:used/total*100,swapUsed:number(s.memory?.swap_usage),swapTotal:number(s.memory?.swap_total),gpuAllocated:gpuRam.allocated,gpuInUse:gpuRam.inUse},
  power:{cpu:number(s.cpu_power),gpu:number(s.gpu_power),ane:number(s.ane_power),total:number(s.sys_power),chip:number(s.all_power)}
 };
}
