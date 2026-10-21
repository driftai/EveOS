'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { createGovernorJobPlan } = require('../machine-spaces/governor-job-plan');
const SHA = 'a'.repeat(40);

function fixture(t) {
  const repo = fs.mkdtempSync(path.join(os.tmpdir(), 'eve-governor-plan-'));
  t.after(() => fs.rmSync(repo, { recursive: true, force: true }));
  fs.mkdirSync(path.join(repo, 'data', 'runtime', 'smoke-results', 'agent-governor'), {recursive:true});
  fs.mkdirSync(path.join(repo, 'tools'), { recursive: true });
  fs.writeFileSync(path.join(repo, 'data', 'runtime', 'mission.txt'), 'bounded source-only repair');
  const target = { type:'powershell', cwd:repo, id:'terminal-one', processEpoch:'epoch-one' };
  const options = { repoRoot: repo };
  const input = { runId:'gov-001', expectedHead:SHA, tier:'medium', mission:'data/runtime/mission.txt',
    allowedFiles:['tools/example.js'], target };
  return { repo, options, input };
}

test('plan is deterministic, bound to a single ignored run and cannot self-publish', (t) => {
  const f = fixture(t);
  const first = createGovernorJobPlan(f.input, f.options);
  const repeat = createGovernorJobPlan(f.input, f.options);
  assert.deepEqual(first, repeat);
  assert.equal(first.runId,'gov-001');
  assert.equal(first.tier,'medium');
  assert.match(first.command, /agent_governor\.py' 'run'/);
  assert.match(first.command, /--expected-head/);
  assert.match(first.command, /--allow-file/);
  assert.doesNotMatch(first.command, /--authorize-publish|\bpublish\b|--permit-high/);
  assert.equal(first.commandDigest.length,64);
});

test('explicit publication is bound to exact files, protected edits and commit metadata', (t) => {
  const f = fixture(t);
  fs.mkdirSync(path.join(f.repo, 'docs'), { recursive: true });
  fs.writeFileSync(path.join(f.repo, 'docs', 'draft.md'), 'unfinished');
  const plan = createGovernorJobPlan({ ...f.input, publish: true,
    preserveFiles: ['docs/draft.md'], commitMessage: 'feat(nexus): prove fresh-room publication' }, f.options);
  assert.match(plan.command, /--authorize-publish/);
  assert.match(plan.command, /--preserve-file' 'docs\/draft\.md/);
  assert.match(plan.command, /--commit-message' 'feat\(nexus\): prove fresh-room publication/);
  assert.equal(plan.publication.branch, 'eve/nexus-machine-spaces');
  assert.deepEqual([...plan.preserveFiles], ['docs/draft.md']);
  assert.throws(() => createGovernorJobPlan({ ...f.input, publish: true,
    preserveFiles: ['tools/example.js'] }, f.options), /Preserved files/);
});

test('rejects path traversal, injection, duplicate files, high/ultra and unknown model tier', (t) => {
  const f = fixture(t);
  const bad = [
    { mission:'data/runtime/../outside.txt' },
    { mission:'data/runtime/something;exit.txt' },
    { mission:'../private.txt' },
    { allowedFiles:['tools/f.js','tools/f.js'] },
    { allowedFiles:['data/runtime/mission.txt'] },
    { allowedFiles:['../secret.txt'] },
    { allowedFiles:['tools/file.js;git reset --hard'] },
    { allowedFiles:[] },
    { tier:'ultra' }, { tier:'high' },
    { expectedHead:'broken' },
    { runId:'../../old' }, { runId:'gov;exit' },
  ];
  for (const change of bad) assert.throws(() => createGovernorJobPlan({ ...f.input, ...change }, f.options),
    undefined, 'unsafe plan must fail: ' + JSON.stringify(change));
});

test('requires trusted checkout-root PowerShell and refuses existing run identity', (t) => {
  const f = fixture(t);
  assert.throws(() => createGovernorJobPlan({...f.input,target:{...f.input.target,type:'wsl'}}, f.options), /PowerShell/);
  assert.throws(() => createGovernorJobPlan({...f.input,target:{...f.input.target,cwd:path.dirname(f.repo)}}, f.options), /EveOS checkout/);
  fs.mkdirSync(path.join(f.repo,'data','runtime','smoke-results','agent-governor','gov-001'));
  assert.throws(() => createGovernorJobPlan(f.input,f.options), /existing run/);
});

test('rejects symlinked or externally resolved mission files', (t) => {
  const f = fixture(t);
  const out = path.join(f.repo,'secret.txt');fs.writeFileSync(out,'secret');
  try {
    fs.symlinkSync(out,path.join(f.repo,'data','runtime','link.txt'));
  } catch(e){if(e.code==='EPERM')return; throw e;}
  assert.throws(() => createGovernorJobPlan({...f.input,mission:'data/runtime/link.txt'},f.options), /Mission/);
});
