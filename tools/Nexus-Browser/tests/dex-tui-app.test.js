'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { PassThrough } = require('node:stream');
const { runApp, formatRooms, chooseRoom } = require('../scripts/dex-tui');
const A = 'room-first000001', B = 'room-second00002';
const room = (roomId, roomName) => ({ roomId, roomName, userName: 'Drift', busy: false, tloMemberId: 'tlo', machineSpaceId: 'space' });
async function until(fn) {
  const deadline = Date.now() + 1400;
  while (!fn() && Date.now() < deadline) await new Promise(resolve => setTimeout(resolve, 5));
  assert.ok(fn(), 'TUI state did not appear');
}
function launch({ rooms = [room(A, 'Alpha'), room(B, 'Beta')], runRoom, runBase, runSpaces } = {}) {
  const input = new PassThrough(), output = new PassThrough(), calls = [];
  let text = '';
  output.on('data', chunk => { text += String(chunk); });
  let seq = 0;
  const task = runApp({ input, output,
    tx: async request => { calls.push(request.type); return { ok: true, rooms }; },
    makePayload: p => ({ type: p.command }), id: () => `tui-id-${++seq}`,
    runRoom: runRoom || (async () => ({ navigation: 'rooms' })),
    runBase: runBase || (async () => ({ navigation: 'home' })),
    runSpaces: runSpaces || (async () => ({ navigation: 'home' }))
  });
  return { input, task, calls, text: () => text };
}
test('room selection and formatting reject control injection or unlisted IDs', () => {
  const rendered = formatRooms([room(A, 'Safe\x1b[31m\nInjected')]);
  assert.match(rendered, /Safe \[31m Injected/);
  assert.doesNotMatch(rendered, /\x1b|\nInjected/);
  assert.equal(chooseRoom('1', [room(A,'Alpha')]).roomId, A);
  assert.equal(chooseRoom(A, [room(A,'Alpha')]).roomId, A);
  assert.equal(chooseRoom('0', [room(A,'Alpha')]), null);
});
test('room back, second room, home then Base and Spaces all share one TUI lifetime', async () => {
  const seen = [];
  const s = launch({ runRoom: async p => (seen.push(p.room), { navigation: 'rooms' }),
    runBase: async () => (seen.push('base'), { navigation: 'home' }),
    runSpaces: async () => (seen.push('spaces'), { navigation: 'home' }) });
  await until(() => s.text().includes('nexus> '));
  s.input.write('1\n'); await until(() => s.text().includes('rooms> '));
  s.input.write('1\n'); await until(() => seen.includes(A) && (s.text().match(/rooms> /g) || []).length >= 2);
  s.input.write('2\n'); await until(() => seen.includes(B) && (s.text().match(/rooms> /g) || []).length >= 3);
  s.input.write('/home\n'); await until(() => (s.text().match(/nexus> /g) || []).length >= 2);
  s.input.write('2\n'); await until(() => seen.includes('base') && (s.text().match(/nexus> /g) || []).length >= 3);
  s.input.write('3\n'); await until(() => seen.includes('spaces') && (s.text().match(/nexus> /g) || []).length >= 4);
  s.input.write('/quit\n');
  assert.equal((await s.task).quit, true);
  assert.deepEqual(seen, [A, B, 'base', 'spaces']);
  assert.deepEqual(s.calls, ['rooms', 'rooms', 'rooms']);
});
test('no browsing action sends a Dex room turn', async () => {
  const s = launch();
  await until(() => s.text().includes('nexus> '));
  s.input.write('/home\n'); await until(() => s.text().includes('Commands: 1 Dex'));
  s.input.write('1\n'); await until(() => s.text().includes('rooms> '));
  s.input.write('unlisted\n'); await until(() => s.text().includes('Not a listed room'));
  s.input.write('/home\n'); await until(() => (s.text().match(/nexus> /g) || []).length >= 3);
  s.input.write('/quit\n'); await s.task;
  assert.deepEqual(s.calls, ['rooms']);
});
test('explicit room /quit still exits entire application', async () => {
  const s = launch({runRoom: async () => ({navigation:'quit'})});
  await until(() => s.text().includes('nexus> '));
  s.input.write('1\n'); await until(() => s.text().includes('rooms> '));
  s.input.write('1\n');
  assert.equal((await s.task).quit, true);
});
test('failed refresh revokes old room choices and refuses dispatch from stale list', async () => {
  const input = new PassThrough(), output = new PassThrough(); let log='', calls=0, opened=false;
  output.on('data', c=>log+=String(c));
  const task=runApp({input, output,
    id:()=> 'request-id',makePayload:p=>({type:p.command}),
    tx:async()=>++calls===1 ? {ok:true,rooms:[room(A,'Alpha')]} : {ok:false,code:'OFFLINE',message:'offline'},
    runRoom:async()=>{opened=true;return {navigation:'rooms'};},
    runBase:async()=>({navigation:'home'}),runSpaces:async()=>({navigation:'home'})
  });
  await until(()=>log.includes('nexus> '));
  input.write('1\n');await until(()=>log.includes('rooms> '));
  input.write('/refresh\n');await until(()=>log.includes('OFFLINE'));
  input.write('1\n');await until(()=>log.includes('Not a listed room'));
  input.write('/home\n');await until(()=>(log.match(/nexus> /g)||[]).length===2);
  input.write('/quit\n');await task;
  assert.equal(opened,false);
  assert.equal(calls,2);
});
test('room user identity follows selected room and carries to Base without mutation', async () => {
  let roomIdentity, baseIdentity;
  const s=launch({rooms:[room(A,'Alpha')],
    runRoom:async (_p,options)=>(roomIdentity=options.displayName,{navigation:'home'}),
    runBase:async options=>(baseIdentity=options.displayName,{navigation:'home'})});
  await until(()=>s.text().includes('nexus> '));
  s.input.write('1\n');await until(()=>s.text().includes('rooms> '));
  s.input.write('1\n');await until(()=>roomIdentity==='Drift');
  await until(()=>(s.text().match(/nexus> /g)||[]).length>=2);
  s.input.write('2\n');await until(()=>baseIdentity==='Drift');
  await until(()=>(s.text().match(/nexus> /g)||[]).length>=3);
  s.input.write('/quit\n');await s.task;
  assert.equal(roomIdentity,'Drift'); assert.equal(baseIdentity,'Drift');
  assert.deepEqual(s.calls,['rooms']);
});
test('home /name sets session-only fallback identity without a provider command',async()=>{
  let identity;
  const s=launch({runBase:async opts=>(identity=opts.displayName,{navigation:'home'})});
  await until(()=>s.text().includes('nexus> '));
  s.input.write('/name Drift\n');await until(()=>s.text().includes('Input identity set to Drift'));
  s.input.write('2\n');await until(()=>identity==='Drift');
  await until(()=>(s.text().match(/nexus> /g)||[]).length>=3);
  s.input.write('/quit\n');await s.task;
  assert.deepEqual(s.calls,[]);
});
