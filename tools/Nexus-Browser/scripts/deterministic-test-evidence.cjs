'use strict';
// Stable producer/qualifier contract: never parse the runtime's default human reporter.
const {spawnSync}=require('node:child_process');
const keys=['tests','suites','pass','fail','cancelled','skipped','todo'];
function assess(result,minTests=1){
 const counts={};const stdout=String(result.stdout||'').replace(/\r\n/g,'\n');
 const lines=stdout.trimEnd().split('\n'),tail=lines.slice(-8);
 const valid=Number.isSafeInteger(minTests)&&minTests>0&&lines[0]==='TAP version 13'&&tail.length===8&&keys.every((key,i)=>{
   const m=tail[i].match(new RegExp('^# '+key+' (0|[1-9][0-9]*)$'));if(!m)return false;
   const v=Number(m[1]);if(!Number.isSafeInteger(v))return false;counts[key]=v;return true;
 })&&/^# duration_ms \d+(?:\.\d+)?$/.test(tail[7])&&counts.tests===counts.pass+counts.fail+counts.cancelled+counts.skipped+counts.todo;
 const processOk=result.status===0&&!result.error&&!result.signal;
 const code=!valid?'TEST_REPORT_UNVERIFIED':!processOk||counts.fail||counts.cancelled?'TEST_EXECUTION_FAILED':counts.skipped||counts.todo?'TEST_COVERAGE_INCOMPLETE':counts.pass<minTests?'TEST_COUNT_BELOW_MINIMUM':'PASS';
 return {status:code==='PASS'?'PASS':'FAIL',code,exitCode:result.status??null,reporter:'tap',counts:valid?counts:null};
}
function run(tests,{cwd,env=process.env,minTests=1,timeout=240000,maxBuffer=16*1024*1024}={}){
 if(!Array.isArray(tests)||!tests.length||new Set(tests).size!==tests.length||!tests.every(x=>/^tests\/[a-z0-9-]+\.test\.js$/.test(x)))throw Error('TEST_LIST_INVALID');
 // Node's own test subprocess marker must not leak into a nested runner.
 const childEnv={...env};delete childEnv.NODE_TEST_CONTEXT;
 const result=spawnSync(process.execPath,['--test','--test-reporter=tap',...tests],{cwd,env:childEnv,encoding:'utf8',windowsHide:true,timeout,maxBuffer});
 return {...assess(result,minTests),stdout:String(result.stdout||''),stderr:String(result.stderr||'')};
}
module.exports={assess,run};
