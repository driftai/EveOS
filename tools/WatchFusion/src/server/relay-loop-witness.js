import { createHook } from 'node:async_hooks';
import { performance } from 'node:perf_hooks';

// Diagnostic only: never authorize media control, expose resource IDs, or retain payloads.
const classes = new Map([['Timeout','timer'],['Immediate','immediate'],['PROMISE','promise'],['TickObject','next-tick'],['HTTPINCOMINGMESSAGE','http'],['TCPWRAP','socket'],['TCPCONNECTWRAP','socket'],['WRITEWRAP','socket-write'],['FSREQCALLBACK','filesystem'],['FSREQPROMISE','filesystem'],['MESSAGEPORT','worker-message'],['GETADDRINFOREQWRAP','dns'],['GETNAMEINFOREQWRAP','dns']]);
const ms = v => Math.max(0,Math.min(60000,Math.round(v)));
export function createRelayLoopWitness({ now=()=>performance.now(), cpu=()=>process.cpuUsage(), hookFactory=createHook }={}) {
  const types=new Map(), active=new Map(); let enabled=false, last=null, lastCpu=null, slow=null, sequence=0, latest=null;
  const hook=hookFactory({
    init(id,type){if(types.size>=4096)types.delete(types.keys().next().value);types.set(id,classes.get(type)||'other');},
    destroy(id){types.delete(id);active.delete(id);},
    before(id){if(active.size<64)active.set(id,{at:now(),kind:types.get(id)||'other'});},
    after(id){const item=active.get(id);active.delete(id);if(!item)return;const end=now(),duration=end-item.at;if(duration>=100&&(!slow||end-slow.end>1500||duration>slow.duration))slow={kind:item.kind,end,duration};}
  });
  function setActive(value){if(value===enabled)return;enabled=value;types.clear();active.clear();slow=null;latest=null;last=null;lastCpu=null;if(value){hook.enable();last=now();lastCpu=cpu();}else hook.disable();}
  function sample(){if(!enabled)return null;const at=now(),usage=cpu(),span=at-last,delay=span-250,prior=last;const cpuMs=(usage.user+usage.system-lastCpu.user-lastCpu.system)/1000;last=at;lastCpu=usage;
    if(delay>=100){const hit=slow&&slow.end>=prior&&slow.end<=at;latest={sequence:++sequence,at,delayMs:ms(delay),kind:hit?slow.kind:'unattributed',callbackMs:hit?ms(slow.duration):0,processCpuMs:ms(cpuMs)};}
    if(slow&&slow.end<=at)slow=null;
    return current();
  }
  function current(){if(!latest||now()-latest.at>1500)return null;const {at,...result}=latest;return result;}
  return {setActive,sample,current,close:()=>setActive(false)};
}
