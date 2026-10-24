'use strict';
const test=require('node:test'),assert=require('node:assert/strict');
const {routeTerminalOperator}=require('../dex/server-terminal-operator-route');
const operator={handle:msg=>({ok:true,type:msg.type})};
const ws={remoteAddress:'127.0.0.1',terminalOperatorOrigin:null};
test('only direct local operator read/send/check/rooms may reach the existing Dex owner',()=>{
  for(const type of ['dex_terminal_rooms','dex_terminal_inspect','dex_terminal_send','dex_terminal_check','dex_terminal_viewer_standby'])
    assert.equal(routeTerminalOperator(ws,{type,requestId:'test-operator-001'},operator).type,'dex_terminal_result');
  for(const type of ['machine_start_supervised_job','provider_control_request','dex_state_put','dex_relay_start','hello','send_prompt'])
    assert.equal(routeTerminalOperator(ws,{type,requestId:'test-operator-001'},operator).code,'DEX_TERMINAL_ACTION_DENIED');
});
test('browser Origin and nonlocal transport cannot become terminal operator',()=>{
  assert.equal(routeTerminalOperator({...ws,terminalOperatorOrigin:'http://127.0.0.1:1234'},{type:'dex_terminal_send'},operator).code,'DEX_TERMINAL_LOCAL_ONLY');
  assert.equal(routeTerminalOperator({...ws,remoteAddress:'10.0.0.2'},{type:'dex_terminal_send'},operator).code,'DEX_TERMINAL_LOCAL_ONLY');
});
