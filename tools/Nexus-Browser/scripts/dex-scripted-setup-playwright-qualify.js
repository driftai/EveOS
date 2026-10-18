#!/usr/bin/env node
'use strict';
// Disposable real-browser check of the scripted TLO bootstrap. No agent calls.
const fs=require('node:fs'), os=require('node:os'), net=require('node:net'), http=require('node:http'), path=require('node:path');
const {spawn}=require('node:child_process');
const {launchChromiumOrConnect}=require('../../../tools/smoke/playwright-browser');
const {transact}=require('./dex-room-terminal');
const ROOT=path.resolve(__dirname,'..','..','..');
function freePort(){return new Promise((ok,bad)=>{const s=net.createServer();s.once('error',bad);s.listen(0,'127.0.0.1',()=>{const n=s.address().port;s.close(()=>ok(n));});});}
async function healthy(port,child){const deadline=Date.now()+15000;while(Date.now()<deadline){if(child.exitCode!==null)throw Error('Nexus exited before health');const status=await new Promise(ok=>{const req=http.get(`http://127.0.0.1:${port}/health`,r=>{r.resume();ok(r.statusCode)});req.on('error',()=>ok(0));});if(status===200)return;await new Promise(r=>setTimeout(r,125));}throw Error('Disposable Nexus did not start');}
async function main(){
  if(process.platform!=='win32')throw Error('Windows PowerShell acceptance requires Windows; do not claim real machine proof on Linux.');
  const port=await freePort(), dataDir=fs.mkdtempSync(path.join(os.tmpdir(),'eve-dex-setup-'));
  const child=spawn(process.execPath,['server.js'],{cwd:path.join(ROOT,'tools','Nexus-Browser'),windowsHide:true,
    env:{...process.env,NEXUS_BROWSER_PORT:String(port),NEXUS_BROWSER_DATA_DIR:dataDir},stdio:['ignore','pipe','pipe']});
  let logs='', browser=null,page=null;const errors=[];
  child.stdout.on('data',x=>logs=(logs+String(x)).slice(-14000));child.stderr.on('data',x=>logs=(logs+String(x)).slice(-14000));
  try {
    await healthy(port,child);
    ({browser}=await launchChromiumOrConnect({headless:true}));
    page=await browser.newPage({viewport:{width:1400,height:1050}});
    page.on('pageerror',e=>errors.push(e.message));
    await page.goto(`http://127.0.0.1:${port}/?mode=dex`,{waitUntil:'domcontentloaded'});
    await page.locator('#dexModeTab').click();
    await page.locator('#dexRoomList .dex-room-item').first().waitFor({state:'visible'});
    const url=`ws://127.0.0.1:${port}/ws`;
    const req={type:'dex_terminal_bootstrap',requestId:'dex-bootstrap-browser-0001',roomName:'Scripted Proof Room'};
    const first=await transact(req,{url}), repeat=await transact(req,{url});
    if(!first.ok||!first.ready||first.grantsEnabled||first.modelInvocations!==0||repeat.idempotent!==true||first.roomId!==repeat.roomId)
      throw Error('Bootstrap failed exact once, grants, or readiness invariants: '+JSON.stringify({first,repeat}));
    const selector=`#dexRoomList .dex-room-item[data-room-id="${first.roomId}"]`;
    await page.locator(selector).waitFor({state:'visible',timeout:12000});
    await page.locator(selector).click();
    await page.locator('#dexMemberList').getByText('TLO',{exact:false}).first().waitFor({state:'visible',timeout:12000});
    await page.locator('#machineSpaceSelect option').filter({hasText:'TLO Proof Machine Space'}).waitFor({state:'attached',timeout:12000});
    const read=await transact({type:'dex_terminal_inspect',requestId:'dex-bootstrap-browser-inspect-0001',roomId:first.roomId},{url});
    if(!read.ok||read.tloMemberId!==first.tloMemberId||read.machineSpaceId!==first.machineSpaceId)
      throw Error('Exact room/TLO/Machine Space readback failed: '+JSON.stringify(read));
    if(errors.length)throw Error('Real browser script errors: '+errors.join(' | '));
    console.log('DEX_SCRIPTED_SETUP_PLAYWRIGHT_GREEN room='+first.roomId+' agentCalls=0 grant=false');
  } catch(e) {
    const folder=path.join(ROOT,'data','runtime','smoke-results','dex-scripted-setup');fs.mkdirSync(folder,{recursive:true});
    if(page)await page.screenshot({path:path.join(folder,'ui-failure-'+Date.now()+'.png'),fullPage:true}).catch(()=>{});
    console.error('NEXUS_TAIL',logs.split(/\r?\n/).slice(-18).join('\n'));throw e;
  } finally {
    await browser?.close().catch(()=>{});
    if(child.exitCode===null)child.kill();
    await new Promise(resolve=>child.exitCode!==null?resolve():child.once('exit',resolve));
    fs.rmSync(dataDir,{recursive:true,force:true});
  }
}
main().catch(e=>{console.error('DEX_SCRIPTED_SETUP_PLAYWRIGHT_RED',e.stack||e.message);process.exitCode=1;});
