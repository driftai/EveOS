'use strict';
const {test}=require('node:test'),a=require('node:assert/strict');
async function fixture(fn){
  const {getRoom,deleteRoom}=await import('../../src/server/room-store.js');
  const {handleSystemRoute}=await import('../../src/server/system-routes.js');
  const occupied=getRoom('GRAND_TEST_OCCUPIED'),retained=getRoom('GRAND_TEST_RETAINED');
  occupied.members.set('fixture',{});occupied.playback.paused=false;retained.messages.push({text:'fixture history'});
  function health(headers={},remoteAddress='127.0.0.1'){
    let body;const req={method:'GET',headers:{host:'127.0.0.1:9087',...headers},socket:{remoteAddress}};
    const res={writeHead(code){a.equal(code,200);},end(text){body=JSON.parse(text);}};
    a.equal(handleSystemRoute(req,res,['api','health']),true);return body;
  }
  try{fn(health);}finally{deleteRoom(occupied.id,occupied);deleteRoom(retained.id,retained);}
}
test('actual host-local health route distinguishes occupied and retained rooms',()=>fixture(health=>{
  const h=health();a.equal(h.rooms,2);a.deepEqual(h.roomActivity,{rooms:2,occupied:1,retainedEmpty:1,members:1,streams:0,playing:1});a.equal(JSON.stringify(h).includes('fixture history'),false);
}));
test('actual health route withholds activity detail from remote or cross-site requests',()=>fixture(health=>{
  for(const h of [health({},'198.51.100.100'),health({'cf-ray':'fixture'}),health({'sec-fetch-site':'cross-site'}),health({origin:'null'})]){a.equal(h.rooms,2);a.equal(h.roomActivity,undefined);}
}));
