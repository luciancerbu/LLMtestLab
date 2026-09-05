#!/usr/bin/env node

import {refreshModels} from '../catalog.mjs';

const result=refreshModels();
console.log(`Scanned ${result.scanned} GGUF file${result.scanned===1?'':'s'}.`);
if(result.created.length){
 for(const model of result.created)console.log(`Added ${model.id} from ${model.file}`);
}else console.log('No new runnable models found.');
console.log(`${result.available} local model definition${result.available===1?'':'s'} available.`);
