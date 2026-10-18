'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
const { authorize, launchRoomTui } = require('../dex/room-tui-launch');
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

test('launch creates only one fixed-command window, never a shell-supplied command', async () => {
  const calls=[];
  const spawnImpl=(exe,args,opts)=>{
    calls.push({exe,args,opts});
    const child=new EventEmitter();child.unref=()=>{};
    queueMicrotask(()=>child.emit('spawn'));
    return child;
  };
  const result=await launchRoomTui({ws,msg,snapshot,port:8765,platform:'win32',spawnImpl,nodeExe:'C:\\Program Files\\nodejs\\node.exe',script:'C:\\Work\\dex-room-terminal.js'});
  assert.equal(result.ok,true);assert.equal(calls.length,1);assert.equal(calls[0].exe,'powershell.exe');
  assert.equal(calls[0].opts.shell,false);assert.equal(calls[0].opts.detached,true);
  assert.match(calls[0].args.at(-1),/dex-room-terminal\.js/);
  assert.match(calls[0].args.at(-1),/tui --room/);
  assert.ok(calls[0].args.at(-1).includes(roomId));
});
