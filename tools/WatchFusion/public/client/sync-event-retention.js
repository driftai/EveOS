/* Redacted repeated observation retention. Never coalesce controls or outcomes. */
(() => {
  'use strict';
  const MAX_GAP_MS=20000, MAX_SPAN_MS=60000, MAX_KEYS=16;
  function create() {
    const recent=new Map(); let hostKey=null;
    function reset(){recent.clear();hostKey=null;}
    function append(events,row,fields){
      const repeatable=row.kind==='host-rejoin-gated'||(row.kind==='linked-acquisition'&&/^source-(?:relay-lag|send-skipped|server-loop-delay|relay-rejected)$/.test(fields.reason||''));
      if(!repeatable){reset();events.push(row);return false;}
      const key=JSON.stringify([row.kind,row.segmentSequence,row.song?.observedSong,fields.peerCount,fields.observedPeerCount,fields.attempts,
        Object.entries(fields).map(([k,v])=>[k,typeof v==='number'?'number':v])]);
      if(row.kind==='host-rejoin-gated'&&hostKey!==key){
        if(hostKey!==null)recent.delete(hostKey);hostKey=key;
      }
      const prior=recent.get(key), at=Date.parse(row.at), idx=prior?events.indexOf(prior):-1;
      let merged=false;
      if(idx>=0 && at>=Date.parse(prior.at) && at-Date.parse(prior.at)<=MAX_GAP_MS && at-Date.parse(prior.firstAt||prior.at)<=MAX_SPAN_MS){
        const ranges={};
        for(const [k,v] of Object.entries(fields)){
          if(typeof v!=='number'||typeof prior[k]!=='number')continue;
          const previous=prior.repeatRanges?.[k]||[prior[k],prior[k]];
          ranges[k]=[Math.min(previous[0],v),Math.max(previous[1],v)];
        }
        // Replace rather than mutate: an in-flight cooperative export may hold the old row.
        row={...row,firstAt:prior.firstAt||prior.at,repeatCount:(prior.repeatCount||1)+1,repeatRanges:ranges};
        if(Number.isFinite(fields.sequence))row.sequenceTotal=(prior.sequenceTotal??prior.sequence)+fields.sequence;
        events.splice(idx,1);merged=true;
      }
      recent.set(key,row);
      if(recent.size>MAX_KEYS)recent.delete(recent.keys().next().value);
      events.push(row);return merged;
    }
    return {append,reset};
  }
  globalThis.WatchFusionSyncEventRetention={create};
})();
