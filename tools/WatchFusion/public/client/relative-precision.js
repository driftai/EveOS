/* Host corroboration is never a replacement target. Common source phase cancels
 * only for a same-anchor comparison; the separate source bound remains in force. */
(function(root){
  'use strict';
  const finite=Number.isFinite;
  function create(){
    let key=null, samples=[];
    function clear(){key=null;samples=[];}
    function observe(c,now,hostId){
      const h=c?.hostWitness,allowance=h?.precisionAllowanceMs;
      const ready=c?.reference==='linked-tab'&&c.source==='live'&&!c.authorityBuffering&&!c.mirrorContradicted&&
        finite(c.sourceReferenceAt)&&now>=c.sourceReferenceAt&&now-c.sourceReferenceAt<=1500&&
        finite(c.uncertaintyMs)&&c.uncertaintyMs>=0&&c.uncertaintyMs<=35&&finite(c.anchorPositionMs)&&finite(c.anchorAt)&&finite(c.phaseMs)&&c.rate===1&&
        h?.member===hostId&&typeof h?.outputSession==='string'&&h.playoutSegment===c.segment&&h.ready===true&&h.playing===true&&h.audible===true&&h.buffering===false&&h.correcting===false&&h.rate===1&&h.adjustmentMs===0&&h.clockWitness===true&&
        ['decoder-confirmed','fine-locked'].includes(h.startupPhase)&&finite(h.rttMs)&&h.rttMs>=0&&h.rttMs<=45&&finite(allowance)&&allowance>=0&&allowance<=12&&finite(h.sampledAt)&&now>=h.sampledAt&&now-h.sampledAt<=1000&&finite(h.positionMs);
      if(!ready){clear();return null;}
      const error=h.positionMs-(c.anchorPositionMs+(h.sampledAt-c.anchorAt)*c.rate+c.phaseMs), next=[hostId,h.outputSession,c.segment].join(':');
      if(!finite(error)||Math.abs(error)+allowance+c.uncertaintyMs>25){clear();return null;}
      if(key!==next){key=next;samples=[];}
      const previous=samples.at(-1);
      if(previous&&(h.sampledAt<previous.at||(h.sampledAt===previous.at&&(Math.abs(error-previous.error)>.1||allowance!==previous.clock||h.positionMs!==previous.position)))){clear();return null;}
      // Require actual reported player advancement on distinct samples, not a diagnostic motion label.
      if(previous&&h.sampledAt>previous.at){
        const dt=h.sampledAt-previous.at,dp=h.positionMs-previous.position;
        if(dt>1500||!finite(dp)||dp<=0||Math.abs(dp-dt)>10){samples=[];}
        else if(dt<175)return null;
      }
      if(!samples.length||h.sampledAt>samples.at(-1).at)samples.push({at:h.sampledAt,error,clock:allowance,position:h.positionMs});
      samples=samples.filter(x=>now-x.at<=2400).slice(-4);
      if(samples.length<3||samples.at(-1).at-samples[0].at<500||Math.max(...samples.map(x=>x.error))-Math.min(...samples.map(x=>x.error))>4)return null;
      return {key,hostError:error,hostClock:Math.max(...samples.map(x=>x.clock)),sampledAt:h.sampledAt};
    }
    function evidence(c,now,hostId,e,sourceBound,clock){
      const h=observe(c,now,hostId);
      if(!h||![e,sourceBound,clock].every(finite)||sourceBound<0||clock<0||sourceBound<clock||Math.abs(e)+sourceBound>50)return null;
      return {...h,relative:e+h.hostError,relativeBound:Math.ceil(clock+h.hostClock+4),sourceBound};
    }
    function admit(c,now,hostId,e,sourceBound,clock,step){
      const h=evidence(c,now,hostId,e,sourceBound,clock),delta=step*50;
      if(!h||!((step>=.12&&step<=.15)||(step>=.24&&step<=.26))||Math.abs(e)<=10||Math.abs(e)>32||Math.sign(h.relative)!==Math.sign(e)||Math.abs(h.relative)<h.relativeBound+delta+2||Math.abs(e-Math.sign(e)*delta)+sourceBound>50)return null;
      return h;
    }
    function verified(c,now,hostId,e,sourceBound,clock,prior){
      const h=evidence(c,now,hostId,e,sourceBound,clock);
      return !!h&&h.key===prior.key&&h.sampledAt>prior.sampledAt&&h.relativeBound<=prior.relativeBound+2&&Math.abs(h.hostError-prior.hostError)<=4&&Math.abs(prior.relative)-Math.abs(h.relative)>=6;
    }
    return {clear,observe,evidence,admit,verified};
  }
  root.WatchFusionRelativePrecision={create};
})(globalThis);
