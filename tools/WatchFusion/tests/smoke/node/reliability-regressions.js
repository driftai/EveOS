import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..');
const files = ['source-continuity','event-retention','r3-reliability','acquisition','maintenance','maintenance-route','fs9-combined','fs9-native','fs10-loop'].map(n=>`tests/reliability/${n}.test.cjs`);
const keys=['tests','suites','pass','fail','cancelled','skipped','todo'];
export function runReliabilityRegressions() {
  const env={...process.env};delete env.NODE_TEST_CONTEXT;
  const r=spawnSync(process.execPath,['--test','--test-reporter=tap',...files],{cwd:root,env,encoding:'utf8',windowsHide:true,timeout:120000,maxBuffer:8*1024*1024});
  const lines=String(r.stdout||'').replace(/\r\n/g,'\n').trimEnd().split('\n'),tail=lines.slice(-8),counts={};
  const valid=lines[0]==='TAP version 13'&&tail.length===8&&keys.every((k,i)=>{
    const m=tail[i].match(new RegExp('^# '+k+' (0|[1-9][0-9]*)$'));if(!m)return false;counts[k]=Number(m[1]);return Number.isSafeInteger(counts[k]);
  })&&/^# duration_ms \d+(?:\.\d+)?$/.test(tail[7]);
  const ok=valid&&!r.error&&!r.signal&&r.status===0&&counts.tests===181&&counts.pass===181&&!counts.fail&&!counts.cancelled&&!counts.skipped&&!counts.todo;
  return [{id:'RELIABILITY:grand-regressions',status:ok?'PASS':'FAIL',...(ok?{tests:counts.tests}:{error:'Reliability TAP incomplete or failed: '+lines.filter(l=>/^not ok|^# (?:tests|pass|fail|cancelled|skipped|todo) /.test(l)).slice(-20).join(' | ')})}];
}
