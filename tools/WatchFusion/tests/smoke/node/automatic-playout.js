import assert from 'node:assert/strict';
import { createPlayoutCoordinator } from '../../../src/server/playout-coordinator.js';

export async function runAutomaticPlayoutChecks(check) {
  const start = 22000;
  const play = {position:12, updatedAt:start, rate:1, paused:false};
  const viewers = new Set(['tv','phone']);
  const room = coordinator => (now, extra = {}) => coordinator.coordinate({now, authority:'linked', viewers, allowHoldback:false, ...extra});
  function sample(coordinator, member, time, phase, extra = {}) {
    coordinator.observe(member, {positionMs:12000 + time - start + phase, sampledAt:time, outputSession:member,
      uncertaintyMs:12, ready:true, playing:true, ...extra}, time + 20);
  }
  function feed(coordinator, member, first, phases, extra = {}) {
    phases.forEach((phase, i) => sample(coordinator, member, first + 350 * i, phase, extra));
  }

  await check('AUTO-01:linked source phase wins, and receiver reports cannot move it', () => {
    const sync = createPlayoutCoordinator(), get = room(sync);
    sync.transport(play);
    feed(sync,'linked',start,[-160,-170,-166,-164,-390,-166]);
    feed(sync,'tv',start,[-850,-850,-850,-850,-850,-850]);
    feed(sync,'phone',start,[15,15,15,15,15,15]);
    const result = get(start + 1800);
    assert.equal(result.reference, 'linked-tab');
    assert.equal(result.phaseMs, -166);
    assert.equal(result.outputTiming,'speaker-unmeasured');
    assert.equal(result.holdbackMs,0,'an audible or unknown linked source is not delayed');
    // The legacy linked-tab mirror can subsequently correct the same phase at its own cadence.
    sync.transport({...play,position:13.634,updatedAt:start+1800});
    assert.equal(get(start+1810).phaseMs,0,'rebasing the room clock cannot count the same phase twice');
  });

  await check('AUTO-02:uncertain clocks and advancing drift cannot claim a stable reference', () => {
    const sync = createPlayoutCoordinator(), get = room(sync);
    sync.transport(play);
    feed(sync,'linked',start,[100,100,100,100,100],{uncertaintyMs:151});
    assert.equal(get(start+1450).reference,'room-clock');
    feed(sync,'linked',start+1900,[0,55,110,165,220,275]);
    assert.equal(get(start+3690).reference,'room-clock');
    feed(sync,'linked',start+4200,[22,23,22,23,22,23]);
    assert.equal(get(start+6000).reference,'linked-tab');
    sample(sync,'linked',start+6500,23,{buffering:true});
    assert.equal(get(start+6600).authorityBuffering,true);
    sample(sync,'linked',start+6490,23);
    assert.equal(get(start+6680).authorityBuffering,true,'late samples cannot clear a fresh stall');
    assert.equal(get(start+9000).authorityBuffering,false);
    assert.equal(get(start+11000).reference,'room-clock');
  });

  await check('AUTO-03:owned outputs get bounded common allowance from a stable slow buffer', () => {
    const sync = createPlayoutCoordinator(), get = room(sync);
    sync.transport(play);
    for (let i = 0; i < 6; i++) {
      const time = start + i * 350, position = 12000 + i * 350;
      sample(sync,'linked',time,0);
      sample(sync,'tv',time,-180,{bufferedUntilMs:position-125});
      sample(sync,'phone',time,0,{bufferedUntilMs:position+2500});
    }
    assert.equal(get(start+1770,{allowHoldback:true}).holdbackMs,350);
    assert.equal(get(start+1800,{allowHoldback:true,viewers:new Set(['phone'])}).holdbackMs,350,'leaving cannot cause a catch-up jump');
    assert.equal(get(start+1800,{allowHoldback:false}).holdbackMs,0,'losing output ownership revokes the allowance');
    const segment = sync.segment();
    sync.transport({...play,position:13.81,updatedAt:start+1800},true);
    assert.equal(sync.segment(),segment+1,'a real seek invalidates prior timing even for a 10 ms hop');
    assert.equal(get(start+1810,{allowHoldback:true}).holdbackMs,0);
  });

  await check('AUTO-04:device route changes, transport changes and stale samples invalidate evidence', () => {
    const sync = createPlayoutCoordinator(), get = room(sync);
    sync.transport(play);
    feed(sync,'linked',start,[80,80,80,80,80]);
    assert.equal(get(start+1450).phaseMs,80);
    sample(sync,'linked',start+1550,80,{outputSession:'changed-route'});
    assert.equal(get(start+1600).reference,'room-clock');
    feed(sync,'linked',start+1900,[30,30,30,30,30],{outputSession:'changed-route'});
    assert.equal(get(start+3370).phaseMs,30);
    sync.transport({...play,updatedAt:start+3500,rate:1.25});
    assert.equal(get(start+3540).phaseMs,0);
    const segment = sync.segment();
    sync.transport({...play,updatedAt:start+3600,paused:true});
    assert.equal(sync.segment(),segment+1);
    assert.equal(get(start+3650).reference,'room-clock');
  });
}
