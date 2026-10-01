(function(root){
  const PLAYING=1,PAUSED=2,BUFFERING=3;
  const MAX_SAMPLE_AGE_MS=2000;

  function projectedPosition(metadata={},now=Date.now()){
    const position=Math.max(0,Number(metadata.currentTime)||0);
    if(metadata.paused)return position;
    const sampledAt=Number(metadata.sampledAt),age=now-sampledAt;
    if(!Number.isFinite(sampledAt)||age<0||age>MAX_SAMPLE_AGE_MS)return position;
    return position+(age/1000)*Math.min(2,Math.max(.25,Number(metadata.rate)||1));
  }

  function youtubePlan(metadata={},playerState,currentTime,options={}){
    const target=projectedPosition(metadata,Number(options.now)||Date.now());
    const current=Math.max(0,Number(currentTime)||0),drift=target-current,absolute=Math.abs(drift);
    const paused=metadata.paused===true;
    const threshold=options.force===true?0.05:(paused?0.4:1.25);
    return{
      target,drift,
      seek:absolute>threshold,
      pause:paused&&playerState!==PAUSED,
      play:!paused&&playerState!==PLAYING&&playerState!==BUFFERING
    };
  }

  function mediaPlan(metadata={},currentTime,options={}){
    const target=projectedPosition(metadata,Number(options.now)||Date.now());
    const current=Math.max(0,Number(currentTime)||0),drift=target-current,absolute=Math.abs(drift);
    const paused=metadata.paused===true;
    const threshold=options.force===true?0.05:(paused?0.35:1.25);
    return{
      target,drift,
      seek:absolute>threshold,
      rate:Math.min(2,Math.max(.25,Number(metadata.rate)||1)),
      paused
    };
  }

  function positionJumped(position,sample,now=performance.now()){
    if(!sample||!Number.isFinite(Number(sample.position))||!Number.isFinite(Number(sample.at)))return false;
    const elapsed=now-Number(sample.at);
    if(elapsed<0||elapsed>1200)return false;
    const expected=Number(sample.position)+(sample.playing?(elapsed/1000)*Math.min(2,Math.max(.25,Number(sample.rate)||1)):0);
    return Math.abs((Number(position)||0)-expected)>1.5;
  }

  root.WatchFusionLinkedPlaybackSync={projectedPosition,youtubePlan,mediaPlan,positionJumped};
})(globalThis);
