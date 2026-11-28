'use strict';
// Read-only readiness observation. This never authorizes a restart on its own.
const fs = require('node:fs'), path = require('node:path');
const nonnegative = n => Number.isSafeInteger(n) && n >= 0;
function activity(h) {
  const a = h?.roomActivity;
  const keys = ['rooms', 'occupied', 'retainedEmpty', 'members', 'streams', 'playing'];
  if (!a || !keys.every(k => nonnegative(a[k])) || a.rooms !== h.rooms ||
      a.occupied + a.retainedEmpty !== a.rooms || a.playing > a.occupied ||
      a.occupied > a.members + a.streams || (a.occupied === 0 && a.members + a.streams !== 0)) return null;
  return Object.fromEntries(keys.map(k => [k, a[k]]));
}
function assess({health, controller, witness, confirmedIdle = false, port}) {
  const blockers = [];
  const healthy = health?.ok === true && health.app === 'WatchFusion' && health.port === port &&
    health.iframeClientRevision === 'solo12' && nonnegative(health.rooms);
  const rooms = healthy ? health.rooms : null, details = healthy ? activity(health) : null;
  if (!healthy) blockers.push('WATCHFUSION_HEALTH_UNVERIFIED');
  if (rooms > 0) {
    if (!details) blockers.push('ROOMS_PRESENT_ACTIVITY_UNKNOWN');
    else {
      if (details.occupied) blockers.push('OCCUPIED_ROOMS_PRESENT');
      if (details.retainedEmpty) blockers.push('RETAINED_ROOM_STATE_PRESENT');
    }
  }
  if (healthy && health.roomActivity !== undefined && !details) blockers.push('ROOM_ACTIVITY_INCONSISTENT');
  const running = controller?.ok === true && controller.controllerAvailable === true &&
    controller.service === 'watchfusion-control' && controller.port === port && controller.state === 'running' &&
    controller.running === true && ['local','lan'].includes(controller.exposureMode) &&
    Array.isArray(controller.pids) && controller.pids.length > 0 && controller.pids.every(p => Number.isSafeInteger(p) && p > 0);
  if (!running) blockers.push('CONTROLLER_RUNNING_STATE_UNVERIFIED');
  const bridge = witness?.schema === 1 && typeof witness.linked === 'boolean';
  if (!bridge) blockers.push('OFFICIAL_BRIDGE_WITNESS_UNVERIFIED');
  else if (witness.linked) blockers.push('SOURCE_STILL_LINKED');
  if (confirmedIdle !== true) blockers.push('STANDALONE_PLAYBACK_IDLE_NOT_CONFIRMED');
  return { ready: blockers.length === 0, blockers, rooms, roomActivity: details,
    controller: running ? { mode:controller.exposureMode, pids:controller.pids } : null,
    sourceLinked: bridge ? witness.linked : null, standaloneIdleConfirmed:confirmedIdle===true,
    observationOnly:true, restartPreservesRetainedRooms:false };
}
async function collect({getHealth,getController,getWitness,port,confirmedIdle=false}) {
  const outcomes = await Promise.allSettled([getHealth,getController,getWitness].map(fn => Promise.resolve().then(fn)));
  const value = i => outcomes[i].status === 'fulfilled' ? outcomes[i].value : null;
  return assess({health:value(0),controller:value(1),witness:value(2),port,confirmedIdle});
}
async function observe(repo, confirmedIdle) {
  const ports = JSON.parse(fs.readFileSync(path.join(repo,'config/eveos-ports.json'),'utf8')).ports;
  const port = ports.WATCHFUSION_PORT?.port, ctl = ports.GEMINI_CONTROL_PORT?.port;
  if (![port,ctl].every(n=>Number.isInteger(n)&&n>0&&n<=65535) || port===ctl) throw Error('PORT_REGISTRY_UNVERIFIED');
  const get = async url => { const r = await fetch(url,{redirect:'error',signal:AbortSignal.timeout(10000),headers:{Connection:'close'}}); if (!r.ok) throw Error('READINESS_HTTP_FAILED'); return r.json(); };
  return collect({port,confirmedIdle,getHealth:()=>get(`http://127.0.0.1:${port}/api/health`),
    getController:()=>get(`http://127.0.0.1:${ctl}/api/watchfusion/status`),
    getWitness:()=>require(path.join(repo,'tools/extensions/bridge-activation.cjs')).verifyInstalled(repo)});
}
module.exports = { activity, assess, collect, observe };
if (require.main===module) {
  const repo=path.resolve(__dirname,'../../..');
  observe(repo,process.argv.includes('--confirmed-idle')).then(r=>{console.log(JSON.stringify(r,null,2));process.exitCode=r.ready?0:3;},()=>{console.error('READINESS_OBSERVATION_FAILED');process.exitCode=2;});
}
