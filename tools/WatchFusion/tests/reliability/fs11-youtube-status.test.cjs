'use strict';
const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),os=require('node:os'),path=require('node:path'),{pathToFileURL}=require('node:url');
const original=process.env.WF_YOUTUBE_STATUS_WORKER || path.resolve(__dirname,'../../src/server/youtube-status-worker.js');
test('concurrent status discovery runs once off the main event loop',async()=>{
 const root=fs.mkdtempSync(path.join(os.tmpdir(),'wf-tool-status-'));try{
 const dir=path.join(root,'src','server');fs.mkdirSync(dir,{recursive:true});fs.mkdirSync(path.join(root,'voxelvision'));fs.writeFileSync(path.join(root,'package.json'),'{"type":"module"}');fs.copyFileSync(original,path.join(dir,'worker.js'));
 fs.writeFileSync(path.join(root,'voxelvision','youtube-import.js'),`import fs from 'node:fs';export function getYoutubeStatus(){fs.appendFileSync(new URL('./count',import.meta.url),'x');Atomics.wait(new Int32Array(new SharedArrayBuffer(4)),0,0,300);return {available:true,provider:'fixture'};}`);
 const {youtubeStatusOffThread}=await import(pathToFileURL(path.join(dir,'worker.js')).href);let ticks=0;const timer=setInterval(()=>ticks++,20);try{const a=youtubeStatusOffThread(),b=youtubeStatusOffThread();assert.equal(a,b);assert.deepEqual(await a,{available:true,provider:'fixture'});assert.ok(ticks>=5);assert.equal(fs.readFileSync(path.join(root,'voxelvision','count'),'utf8'),'x');}finally{clearInterval(timer);}
 }finally{fs.rmSync(root,{recursive:true,force:true});}
});
test('failed discovery settles without publishing a successful result',async()=>{
 const root=fs.mkdtempSync(path.join(os.tmpdir(),'wf-tool-status-'));try{const dir=path.join(root,'src','server');fs.mkdirSync(dir,{recursive:true});fs.mkdirSync(path.join(root,'voxelvision'));fs.writeFileSync(path.join(root,'package.json'),'{"type":"module"}');fs.copyFileSync(original,path.join(dir,'worker.js'));fs.writeFileSync(path.join(root,'voxelvision','youtube-import.js'),`export function getYoutubeStatus(){throw Error('fixture failure');}`);const {youtubeStatusOffThread}=await import(pathToFileURL(path.join(dir,'worker.js')).href);await assert.rejects(youtubeStatusOffThread(),/discovery failed/);await assert.rejects(youtubeStatusOffThread(),/discovery failed/);}finally{fs.rmSync(root,{recursive:true,force:true});}
});
