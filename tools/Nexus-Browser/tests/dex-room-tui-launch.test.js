'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
const { authorize, encodePowerShell, visibleLaunchSpec, launchRoomTui } = require('../dex/room-tui-launch');
const roomId = 'room-aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee';
const ws = { role: 'ui', clientKind: 'tui-launch', remoteAddress: '127.0.0.1', terminalOperatorOrigin: 'http://127.0.0.1:8765' };
const msg = { type: 'dex_launch_room_tui', requestId: 'room-tui-request-001', roomId };
const snapshot = { rooms: [{ id: roomId, name: 'Proof' }] };

test('launch only from exact localhost Nexus browser origin and existing room', () => {
  assert.equal(authorize(ws,msg,snapshot,8765,'win32').ok,true);
  assert.equal(authorize({...ws,terminalOperatorOrigin:'http://evil.example'},msg,snapshot,8765,'win32').code,'DEX_TUI_ORIGIN_DENIED');
  assert.equal(authorize({...ws,terminalOperatorOrigin:null},msg,snapshot,8765,'win32').code,'DEX_TUI_ORIGIN_DENIED');
  assert.equal(authorize({...ws,clientKind:'terminal-operator'},msg,snapshot,8765,'win32').code,'DEX_TUI_LOCAL_UI_ONLY');
  assert.equal(authorize({...ws,remoteAddress:'10.0.0.7'},msg,snapshot,8765,'win32').code,'DEX_TUI_LOCAL_UI_ONLY');
  assert.equal(authorize(ws,{...msg,roomId:'room-absent123456'},snapshot,8765,'win32').code,'DEX_TUI_ROOM_NOT_FOUND');
  assert.equal(authorize(ws,msg,snapshot,8765,'linux').code,'DEX_TUI_WINDOWS_ONLY');
});

test('launch uses a verified visible Start-Process window and never shell-supplied input', async () => {
  const calls=[];
  const spawnImpl=(exe,args,opts)=>{
    calls.push({exe,args,opts});
    const child=new EventEmitter(); child.stdout=new EventEmitter(); child.stderr=new EventEmitter();
    queueMicrotask(()=>{ child.stdout.emit('data','43210'); child.emit('close',0); });
    return child;
  };
  const result=await launchRoomTui({ws,msg,snapshot,port:8765,platform:'win32',spawnImpl,nodeExe:'C:\\Program Files\\nodejs\\node.exe',script:'C:\\Work\\dex-room-terminal.js'});
  assert.equal(result.ok,true); assert.equal(result.terminalPid,43210); assert.equal(calls.length,1); assert.equal(calls[0].exe,'powershell.exe');
  assert.equal(calls[0].opts.shell,false); assert.equal(calls[0].opts.windowsHide,true);
  const helper=Buffer.from(calls[0].args.at(-1),'base64').toString('utf16le');
  assert.match(helper,/Start-Process/); assert.match(helper,/-WindowStyle Normal/);
  const spec=visibleLaunchSpec({nodeExe:'C:\\Program Files\\nodejs\\node.exe',script:'C:\\Work\\dex-room-terminal.js',roomId});
  assert.match(spec.targetCommand,/dex-room-terminal\.js/); assert.match(spec.targetCommand,/tui --room/); assert.ok(spec.targetCommand.includes(roomId));
  assert.equal(Buffer.from(encodePowerShell(spec.targetCommand),'base64').length > 0,true);
});

test('launcher failure is reported instead of treating process creation as terminal success', async () => {
  const spawnImpl=()=>{ const child=new EventEmitter(); child.stdout=new EventEmitter(); child.stderr=new EventEmitter();
    queueMicrotask(()=>{ child.stderr.emit('data','Start-Process failed'); child.emit('close',1); }); return child; };
  const result=await launchRoomTui({ws,msg,snapshot,port:8765,platform:'win32',spawnImpl});
  assert.equal(result.ok,false); assert.equal(result.code,'DEX_TUI_LAUNCH_FAILED'); assert.match(result.message,/Start-Process failed/);
});
