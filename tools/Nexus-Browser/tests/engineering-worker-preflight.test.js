'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { parseArgs, preflight, parseCodexQuota, parseTloStatus } = require('../scripts/engineering-worker-preflight');
const SHA = 'f83cfbe1a40cb42f223300a774569db28ad7263b';
const tloStatus = `SEARCH_MONITOR_RUNTIME_STATUS\nHEAD ${SHA}\nNexus Browser RUNNING\nTLO ready · canChat=true · model=qwen36-nvfp4\nNEXUS extension=connected · onlineTargets=7 · localTargets=5 · rooms=23`;
const quota = JSON.stringify({ state: 'AVAILABLE', incomplete: false, reached: false,
  fiveHour: { remainingPercent: 70, resetAt: 'future' }, weekly: { remainingPercent: 50, resetAt: 'future' } });
function mock({tlo=tloStatus, codex=quota, quotaCode=0, clean=true}={}){
  const calls=[];
  const run=(cmd,args)=>{
    calls.push({cmd,args});
    if(cmd==='git') {
      const [operation] = args;
      const outputs={branch:'eve/nexus-machine-spaces', 'rev-parse':SHA,status:clean?'':' M docs/draft.md', 'ls-remote':`${SHA}\trefs/heads/eve/nexus-machine-spaces`};
      return { code:0,stdout:outputs[operation]||'',stderr:'' };
    }
    if (args[0] === 'tools/runtime/search-monitor-runtime.mjs') return {code:0,stdout:tlo,stderr:''};
    if (args[0] === 'tools/Nexus-Browser/scripts/codex-quota-cli.js')
      return {code:quotaCode,stdout:codex,stderr:'(node) [DEP0190] DeprecationWarning'};
    throw Error('Unexpected command');
  };
  return { run,calls };
}
function check(worker,workflow,spec={}) { const m=mock(spec);return {...m,result:preflight({worker,workflow,expectedHead:SHA,minRemaining:15},{run:m.run,repoRoot:'/repo',node:'node'})}; }
test('no implicit worker: refusing omitted, invalid or unsafe worker input',()=>{
  assert.throws(()=>parseArgs(['--workflow','governor-publication','--expected-head',SHA]),/No implicit Codex default/);
  assert.throws(()=>parseArgs(['--worker','tlo','--workflow','local-agent','--expected-head',SHA,'--min-remaining','5']),/min-remaining >=6/);
});
test('TLO check uses local model/transport only, never invokes Codex quota',()=>{
  const r=check('tlo','local-agent'); assert.equal(r.result.status,'READY_FOR_TLO_BOUND_WORK');
  assert.equal(r.result.codexQuotaApplicable,false); assert.equal(r.result.authorityGranted,false);
  assert.equal(r.calls.some(x=>x.args[0]?.includes('codex-quota')),false);
});
test('TLO offline and wrong runtime HEAD fail closed without trying Codex',()=>{
  for(const s of [tloStatus.replace('canChat=true','canChat=false'),tloStatus.replace(`HEAD ${SHA}`,'HEAD '+'1'.repeat(40)),tloStatus.replace('extension=connected','extension=missing')]){
    const r=check('tlo','recovery',{tlo:s}); assert.equal(r.result.status,'BLOCKED');
    assert.equal(r.calls.some(x=>x.args[0]?.includes('codex-quota')),false);
  }
});
test('TLO does not silently become Governor publication executor',()=>{
  const r=check('tlo','governor-publication'); assert.equal(r.result.status,'BLOCKED');
  assert.match(r.result.reason,/still launches Codex/);assert.equal(r.calls.length,0);
});
test('Codex publication uses fresh quota check, warning on stderr is not failure',()=>{
  const r=check('codex','governor-publication'); assert.equal(r.result.status,'READY_FOR_CODEX_GOVERNOR_PREFLIGHT');
  assert.equal(r.result.codexQuotaApplicable,true); assert.equal(r.calls.filter(x=>x.args[0]?.includes('codex-quota')).length,1);
});
test('Codex low weekly or five-hour quota blocks only Codex path',()=>{
  for(const window of ['weekly','fiveHour']){
    const input=JSON.parse(quota);input[window].remainingPercent=7;
    const r=check('codex','governor-publication',{codex:JSON.stringify(input),quotaCode:3});
    assert.equal(r.result.status,'BLOCKED');assert.equal(r.result.reason,'CODEX_QUOTA_BELOW_REQUIRED_HEADROOM');
  }
});
test('incomplete quota blocks Codex with no guesses',()=>{
  const r=check('codex','governor-publication',{codex:JSON.stringify({state:'UNAVAILABLE',fiveHour:null,weekly:null})});
  assert.equal(r.result.status,'BLOCKED');assert.equal(r.result.codexQuota,null);
});
test('remote review is quota independent and does not imply local execution',()=>{
  const r=check('remote','source-review'); assert.equal(r.result.status,'READY_FOR_REMOTE_SOURCE_REVIEW_ONLY');
  assert.equal(r.calls.filter(x=>x.cmd!=='git').length,0);assert.equal(r.result.publicationAuthorized,false);
});
test('dirty tree refuses further preflight',()=>{
  const r=check('tlo','local-agent',{clean:false}); assert.equal(r.result.status,'BLOCKED');assert.equal(r.calls.some(x=>x.cmd!=='git'),false);
});
test('quota and runtime parsers reject incomplete evidence',()=>{
  assert.equal(parseCodexQuota('warnings only'),null);
  assert.equal(parseTloStatus('unavailable').canChat,false);
});
