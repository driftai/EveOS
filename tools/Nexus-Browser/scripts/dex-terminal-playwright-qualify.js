#!/usr/bin/env node
'use strict';
// Disposable Nexus UI + terminal-operator readback. Does not perform TLO inference.
const fs=require('node:fs');const os=require('node:os');const net=require('node:net');
const path=require('node:path');const http=require('node:http');const {spawn}=require('node:child_process');
const {launchChromiumOrConnect}=require('../../../tools/smoke/playwright-browser');
const {transact}=require('./dex-room-terminal');
const ROOT=path.resolve(__dirname,'..','..','..');
function port(){return new Promise((resolve,reject)=>{const s=net.createServer();s.once('error',reject);s.listen(0,'127.0.0.1',()=>{const n=s.address().port;s.close(()=>resolve(n));});});}
async function health(n,child){const end=Date.now()+15000;while(Date.now()<end){if(child.exitCode!==null)throw Error('Isolated Nexus exited.');try{const ok=await new Promise(r=>{const req=http.get(`http://127.0.0.1:${n}/health`,res=>{res.resume();r(res.statusCode===200)});req.once('error',()=>r(false));});if(ok)return;}catch{}await new Promise(r=>setTimeout(r,100));}throw Error('Nexus health timeout');}
async function main(){
  const n=await port(),dir=fs.mkdtempSync(path.join(os.tmpdir(),'eveos-dex-operator-ui-'));
  const child=spawn(process.execPath,['server.js'],{cwd:path.join(ROOT,'tools','Nexus-Browser'),windowsHide:true,env:{...process.env,NEXUS_BROWSER_PORT:String(n),NEXUS_BROWSER_DATA_DIR:dir},stdio:['ignore','pipe','pipe']});
  let logs='',browser=null,page=null;const errs=[];child.stdout.on('data',x=>{logs=(logs+String(x)).slice(-12000)});child.stderr.on('data',x=>{logs=(logs+String(x)).slice(-12000)});
  try{
    await health(n,child);
    ({browser}=await launchChromiumOrConnect({headless:true}));
    page=await browser.newPage({viewport:{width:1420,height:950}});
    page.on('pageerror',e=>errs.push(e.message));
    await page.goto(`http://127.0.0.1:${n}/?mode=dex`,{waitUntil:'domcontentloaded',timeout:30000});
    await page.locator('#dexModeTab').click();
    await page.locator('#dexRoomList .dex-room-item').first().waitFor({timeout:10000});
    await page.locator('#dexHumanToggle').click();
    await page.locator('#dexNewRoom').click();
    const id=await page.locator('#dexRoomList .dex-room-item.active').getAttribute('data-room-id');
    if(!/^room-[A-Za-z0-9_-]{6,125}$/.test(id||''))throw Error('Dex UI did not produce an exact room ID.');
    await page.locator('#machineCreateSpace').click();
    await page.locator('.machine-dialog-input').fill('Terminal UI Acceptance');
    await page.locator('.machine-dialog-actions button:last-child').click();
    await page.locator('#machineSpaceSelect option').filter({hasText:'Terminal UI Acceptance'}).waitFor({state:'attached',timeout:10000});
    await page.locator('#dexMemberClass').selectOption('local-origin');
    await page.locator('#dexMemberType').selectOption('provider-workspace');
    await page.locator('#dexMemberTarget option[value="local:tlo-chat:default"]').waitFor({state:'attached',timeout:15000});
    await page.locator('#dexMemberTarget').selectOption('local:tlo-chat:default');
    await page.locator('#dexAddMember').click();
    await page.locator('#dexMemberList').getByText('TLO',{exact:false}).first().waitFor({timeout:10000});
    // The browser updates instantly, but Dex persists participant edits on a short debounce.
    // Require the authoritative server's exact-room TLO binding, not a local DOM label.
    const req='terminal-browser-proof-0001';
    const wsUrl=`ws://127.0.0.1:${n}/ws`;
    let result=null;
    const syncDeadline=Date.now()+15000;
    do {
      result=await transact({type:'dex_terminal_inspect',requestId:req,roomId:id},{url:wsUrl});
      if(result?.ok && result.roomId===id && result.tloMemberId)break;
      await new Promise(resolve=>setTimeout(resolve,250));
    } while(Date.now()<syncDeadline);
    if(!result?.ok || result.roomId!==id || !result.tloMemberId){
      const rooms=await transact({type:'dex_terminal_rooms',requestId:'terminal-browser-rooms-0001'},{url:wsUrl});
      throw Error('Dex TLO binding did not persist in the exact room: '+JSON.stringify({expectedRoomId:id,result,rooms}));
    }
    // A configured-but-unattached Machine Space is intentionally not an executable
    // space: terminal-operator.spaceFor() returns null until it owns a live resource.
    if(result.machineSpaceId!==null)throw Error('Unattached room unexpectedly has an executable Machine Space: '+JSON.stringify(result));
    if(await page.locator('#dexRoomList .dex-room-item.active').getAttribute('data-room-id')!==id)
      throw Error('Browser selected room changed before terminal readback.');
    if(!(await page.locator('#machineSpaceStatus').innerText()).includes('Terminal UI Acceptance'))
      throw Error('The selected Dex room did not retain its configured Machine Space.');
    const refusal=await transact({type:'dex_terminal_send',requestId:'terminal-browser-refusal-0001',roomId:id,text:'Do not execute synthetic UI test'},{url:`ws://127.0.0.1:${n}/ws`});
    if(refusal?.code!=='DEX_TERMINAL_MACHINE_SPACE_REQUIRED')throw Error('Unattached Machine Space must fail before model inference; got '+JSON.stringify(refusal));
    if(errs.length)throw Error('Browser page errors: '+errs.join(' | '));
    console.log('DEX_TERMINAL_PLAYWRIGHT_UI_GREEN room='+id+' nativeModelCalls=0 attachedTerminal=false');
  }catch(e){
    if(page){const evidence=path.join(ROOT,'data','runtime','smoke-results','v071b-dex-terminal');fs.mkdirSync(evidence,{recursive:true});const screenshot=path.join(evidence,'dex-terminal-ui-failure-'+Date.now()+'.png');await page.screenshot({path:screenshot,fullPage:true}).catch(()=>{});console.error('Disposable screenshot:',screenshot);}
    console.error('NEXUS_TAIL',logs.split(/\r?\n/).slice(-14).join('\n'));throw e;
  }finally{
    await browser?.close().catch(()=>{});
    if(child.exitCode===null)child.kill();
    await new Promise(resolve=>child.exitCode!==null?resolve():child.once('exit',resolve));
    fs.rmSync(dir,{recursive:true,force:true});
  }
}
main().catch(e=>{console.error('DEX_TERMINAL_PLAYWRIGHT_UI_RED',e.stack||e.message);process.exitCode=1});
