#!/usr/bin/env node
'use strict';
// Disposable browser-click qualification. Replaces only the click's outbound WS
// with a capture stub so this test never launches a real PowerShell window.
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const net = require('node:net');
const { spawn } = require('node:child_process');
const { launchChromiumOrConnect } = require('../../../tools/smoke/playwright-browser');
const ROOT = path.resolve(__dirname, '..', '..', '..');
const TOOL = path.join(ROOT, 'tools', 'Nexus-Browser');
const reserve = () => new Promise((resolve, reject) => {
  const server=net.createServer(); server.once('error',reject);
  server.listen(0,'127.0.0.1',()=>{const port=server.address().port;server.close(()=>resolve(port));});
});
async function main() {
  const port=await reserve(),dir=fs.mkdtempSync(path.join(os.tmpdir(),'eveos-dex-tui-launch-'));
  const child=spawn(process.execPath,['server.js'],{cwd:TOOL,windowsHide:true,
    env:{...process.env,NEXUS_BROWSER_PORT:String(port),NEXUS_BROWSER_DATA_DIR:dir},stdio:['ignore','pipe','pipe']});
  let tail='',browser,page;const errors=[];
  child.stdout.on('data',b=>{tail=(tail+String(b)).slice(-6000);});
  child.stderr.on('data',b=>{tail=(tail+String(b)).slice(-6000);});
  try {
    const deadline=Date.now()+15000;
    for (;;) {
      if (Date.now()>deadline || child.exitCode!==null) throw Error('Disposable Nexus did not become healthy.');
      try { const r=await fetch(`http://127.0.0.1:${port}/health`);if(r.ok)break; } catch {}
      await new Promise(r=>setTimeout(r,120));
    }
    ({browser}=await launchChromiumOrConnect({headless:true}));
    page=await browser.newPage({viewport:{width:1350,height:900}});
    page.on('pageerror',e=>errors.push(e.message));
    await page.goto(`http://127.0.0.1:${port}/?mode=dex`,{waitUntil:'domcontentloaded',timeout:30000});
    await page.locator('#dexModeTab').click();
    await page.locator('#dexRoomList .dex-room-item.active').waitFor({timeout:12000});
    await page.locator('#dexOpenTui').waitFor({state:'visible',timeout:12000});
    const roomId=await page.locator('#dexRoomList .dex-room-item.active').getAttribute('data-room-id');
    await page.evaluate(() => {
      const active=window.WebSocket;
      window.__dexTuiCaptured=[];
      window.WebSocket=class MockTuiLaunchSocket {
        constructor(){this.handlers={};queueMicrotask(()=>this.handlers.open?.({}));}
        addEventListener(kind,fn){this.handlers[kind]=fn;}
        send(raw){const p=JSON.parse(raw);window.__dexTuiCaptured.push(p);
          if(p.type==='dex_launch_room_tui') queueMicrotask(()=>this.handlers.message?.({data:JSON.stringify({type:'dex_tui_launch_result',requestId:p.requestId,ok:true,roomId:p.roomId,launched:true})}));}
        close(){this.handlers.close?.({});}
      };
      window.__dexOriginalWebSocket=active;
    });
    await page.locator('#dexOpenTui').click();
    await page.waitForFunction(() => document.getElementById('dexOpenTuiStatus')?.textContent === 'Terminal opened for the selected room.', null, {timeout:8000});
    const captured=await page.evaluate(()=>window.__dexTuiCaptured);
    if(captured[0]?.role!=='ui'||captured[0]?.clientKind!=='tui-launch'||captured[1]?.type!=='dex_launch_room_tui'||captured[1]?.roomId!==roomId)
      throw Error('TUI launch click did not bind the exact selected room. '+JSON.stringify(captured));
    if(errors.length)throw Error('Page exceptions: '+errors.join(' | '));
    console.log('DEX_TUI_OPEN_BUTTON_PLAYWRIGHT_GREEN exactRoom='+roomId+' realPowerShellLaunches=0');
  } catch (error) { console.error('DEX_TUI_UI_PLAYWRIGHT_RED',error.stack||error.message,'\nNEXUS_TAIL',tail);throw error; }
  finally {await browser?.close().catch(()=>{});if(child.exitCode===null)child.kill();await new Promise(r=>child.exitCode!==null?r():child.once('exit',r));fs.rmSync(dir,{recursive:true,force:true});}
}
main().catch(e=>{console.error(e.stack||e.message);process.exitCode=1;});
