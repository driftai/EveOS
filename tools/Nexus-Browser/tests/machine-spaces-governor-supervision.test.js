'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { createSupervisedJobCoordinator } = require('../machine-spaces/supervised-job');
const { enhanceMachineSpacesSupervisedController } = require('../machine-spaces/server-controller-supervised');
const { enhanceMachineSpacesHumanGateController, MUTATING_TYPES } = require('../machine-spaces/server-controller-human-gate');

function fixture(t) {
  const repo = fs.mkdtempSync(path.join(os.tmpdir(), 'eve-governor-supervised-'));
  t.after(() => fs.rmSync(repo, {recursive:true,force:true}));
  fs.mkdirSync(path.join(repo,'data','runtime','smoke-results','agent-governor'), {recursive:true});
  fs.writeFileSync(path.join(repo,'data','runtime','mission.txt'), 'read-only dry-run');
  const target = { id:'terminal-one', type:'powershell', cwd:repo, processEpoch:'epoch-one' };
  const room = {id:'room-one', machineSpaces:{spaces:[{id:'space-one',name:'Engineering',resourceIds:['terminal-one']}]}};
  const ui = {}, outsider = {}, uiSockets = new Set([ui]), sent=[];
  const jobs=createSupervisedJobCoordinator({idFactory:(()=>{let n=0;return()=>String(++n)})()});
  let runs=0;
  const broker = {
    target(id){return id === target.id?target:null;},
    activeInfo(){return null;},
    runSupervised(){runs++;return new Promise(()=>{});}
  };
  const base = { broker, spool:{store:()=>({outputId:'out'})}, providerControl:{owns:()=>false,route:()=>null},
    async handle(){return false;},stop(){} };
  const shared={ uiSockets, safeSend(_ws,payload){sent.push(payload);return true;},
    getState:()=>({rooms:[room]}), supervisedJobs:jobs, governorRoot:repo };
  const controller=enhanceMachineSpacesHumanGateController(
    opts => enhanceMachineSpacesSupervisedController(()=>base, opts), shared);
  const input={type:'machine_prepare_governor_job',roomId:'room-one',spaceId:'space-one',targetId:'terminal-one',
    runId:'run-001',requestId:'request-one',expectedHead:'a'.repeat(40),tier:'medium',
    mission:'data/runtime/mission.txt',allowedFiles:['tools/safe.js']};
  return {repo,ui,outsider,sent,jobs,controller,input,runs:()=>runs};
}

test('Governor prepare is a Human-Input-gated local-only queued operation, never immediate execution',async t=>{
  const f=fixture(t);
  assert.ok(MUTATING_TYPES.has('machine_prepare_governor_job'));
  await f.controller.handle(f.outsider,f.input);
  assert.equal(f.jobs.snapshot().jobs.length,0);
  await f.controller.handle(f.ui,f.input);
  assert.equal(f.jobs.snapshot().jobs.length,0);
  assert.equal(f.sent.at(-1).code,'MACHINE_HUMAN_INPUT_LOCKED');
  await f.controller.handle(f.ui,{type:'machine_set_human_input',enabled:true});
  await f.controller.handle(f.ui,f.input);
  const job=f.jobs.snapshot().jobs[0];
  assert.equal(job.kind,'governor');
  assert.equal(job.state,'queued');
  assert.equal(f.runs(),0,'preparation does not run Codex or qualify anything');
  const prepared=f.sent.find(x=>x.type==='machine_governor_job_prepared');
  assert.ok(prepared);
  assert.equal(prepared.job.governor.runId,'run-001');
  assert.doesNotMatch(JSON.stringify(prepared),/mission\.txt|tools\/safe\.js/);
});

test('repeated request ID is idempotent; altered intent is rejected before launch',async t=>{
  const f=fixture(t);
  await f.controller.handle(f.ui,{type:'machine_set_human_input',enabled:true});
  await f.controller.handle(f.ui,f.input);
  await f.controller.handle(f.ui,f.input);
  assert.equal(f.jobs.snapshot().jobs.length,1);
  await f.controller.handle(f.ui,{...f.input,allowedFiles:['tools/other.js']});
  assert.equal(f.sent.at(-1).code,'MACHINE_JOB_REQUEST_CONFLICT');
  assert.equal(f.runs(),0);
});

test('mission drift after preparation blocks local start without dispatch or replay',async t=>{
  const f=fixture(t);
  await f.controller.handle(f.ui,{type:'machine_set_human_input',enabled:true});
  await f.controller.handle(f.ui,f.input);
  fs.writeFileSync(path.join(f.repo,'data','runtime','mission.txt'),'CHANGED MISSION');
  const job=f.jobs.snapshot().jobs[0];
  await f.controller.handle(f.ui,{type:'machine_start_supervised_job',jobId:job.jobId});
  assert.equal(f.runs(),0);
  assert.equal(f.jobs.status(job.jobId).state,'queued');
  assert.equal(f.sent.at(-1).code,'MACHINE_GOVERNOR_PLAN_CHANGED');
});

test('successful local-owner start delegates to the existing supervised broker exactly once',async t=>{
  const f=fixture(t);
  await f.controller.handle(f.ui,{type:'machine_set_human_input',enabled:true});
  await f.controller.handle(f.ui,f.input);
  const job=f.jobs.snapshot().jobs[0];
  await f.controller.handle(f.ui,{type:'machine_start_supervised_job',jobId:job.jobId});
  assert.equal(f.runs(),1);
  assert.equal(f.jobs.status(job.jobId).state,'running');
  await f.controller.handle(f.ui,{type:'machine_start_supervised_job',jobId:job.jobId});
  assert.equal(f.runs(),1);
});
