#!/usr/bin/env node
'use strict';
// Exact-once detached qualification runner. Only this allowlisted pipeline runs.
// Registration happens BEFORE process detachment. No retry after uncertain start.
const fs = require('node:fs');
const path = require('node:path');
const { spawn } = require('node:child_process');
const { randomUUID } = require('node:crypto');
const { WebSocket } = require('ws');
const { urls, dataDir, EVEOS_ROOT } = require('../runtime-config');
const { gitState, readJournal, writeJournal } = require('../dex/post-idle-maintenance');
const { JOB_ID, credentialPath, resultPath, tokenMatches } = require('../dex/task-completion-journal');

const NEXUS = path.resolve(__dirname, '..');
const STAGES = Object.freeze([
  { name: 'test:nexus-browser', args: ['test'], cwd: NEXUS, file: '01-nexus-browser-test.log' },
  { name: 'smoke:nexus-browser', args: ['run', 'smoke:nexus-browser'], cwd: EVEOS_ROOT, file: '02-smoke-nexus-browser.log' },
  { name: 'test:guardrails', args: ['run', 'test:guardrails'], cwd: EVEOS_ROOT, file: '03-test-guardrails.log' },
  { name: 'test:ai-control', args: ['run', 'test:ai-control'], cwd: EVEOS_ROOT, file: '04-test-ai-control.log' }
]);
function options(argv) {
  const args = [...argv], mode = args.shift(), out = {};
  while (args.length) {
    const key = String(args.shift());
    if (!/^--[a-z-]+$/.test(key) || !args.length) throw Error('Expected --name value; found ' + key);
    out[key.slice(2)] = String(args.shift());
  }
  return { mode, opts: out };
}
function request(type, payload = {}) {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(process.env.NEXUS_BROWSER_WS || urls().websocket);
    const id = 'task-completion-cli-' + randomUUID();
    const timer = setTimeout(() => {
      ws.close(); reject(new Error('Task registration outcome uncertain; inspect status before retrying.'));
    }, 20000);
    function finish(error, result) {
      clearTimeout(timer); try { ws.close(); } catch {}
      if (error) reject(error); else resolve(result);
    }
    ws.once('open', () => {
      ws.send(JSON.stringify({ type: 'hello', role: 'ui', clientKind: 'maintenance' }));
      ws.send(JSON.stringify({ type, requestId: id, ...payload }));
    });
    ws.on('message', (raw) => {
      let msg; try { msg = JSON.parse(String(raw)); } catch { return; }
      if (msg.type === 'task_completion_result' && msg.requestId === id) finish(null, msg.result);
    });
    ws.once('error', (e) => finish(e));
  });
}
function source(opts) {
  const pid = Number(opts['agy-pid']);
  if (!Number.isSafeInteger(pid) || pid < 1) throw Error('Require --agy-pid of the EXISTING Antigravity process.');
  return { targetClassId: 'local-origin', targetId: 'local:antigravity-existing:' + pid,
    providerId: 'local-antigravity-existing', providerName: 'Antigravity CLI' };
}
function exactSource(opts) {
  if (!opts.room || !opts.requester) throw Error('Require exact --room and --requester member ID.');
  const sha = String(opts.sha || '').toLowerCase(), branch = String(opts.branch || '');
  if (!/^[0-9a-f]{40}$/.test(sha) || !/^[A-Za-z0-9_./-]{1,128}$/.test(branch)) {
    throw Error('Require --sha <exact40> --branch <exact>.');
  }
  const git = gitState();
  if (git.head.toLowerCase() !== sha || git.branch !== branch || git.dirty) {
    throw Error('Actual local HEAD/branch/clean worktree failed BEFORE task registration.');
  }
  return { sha, branch };
}
function claimFile(id) { return path.join(dataDir(), 'task-completions', 'runs', id + '.claim'); }
function claimRun(id) {
  const dest = claimFile(id);
  fs.mkdirSync(path.dirname(dest), { recursive: true });
  const fd = fs.openSync(dest, 'wx', 0o600);
  try { fs.writeFileSync(fd, JSON.stringify({ pid: process.pid, at: new Date().toISOString() })); fs.fsyncSync(fd); }
  finally { fs.closeSync(fd); }
  return dest;
}
function stageCommand(stage) {
  // Arguments are static; user-provided input never becomes a shell command.
  return process.platform === 'win32'
    ? { cmd: process.env.ComSpec || 'cmd.exe',
        args: ['/d', '/s', '/c', 'npm ' + stage.args.join(' ')] }
    : { cmd: 'npm', args: stage.args };
}
function runStage(stage, directory) {
  return new Promise((resolve) => {
    const out = path.join(directory, stage.file);
    const log = fs.openSync(out, 'w');
    fs.writeSync(log, '[' + new Date().toISOString() + '] ' + stage.name + '\n');
    const { cmd, args } = stageCommand(stage);
    let child;
    try {
      child = spawn(cmd, args, { cwd: stage.cwd, env: process.env,
        stdio: ['ignore', log, log], windowsHide: true });
    } catch (error) {
      fs.writeSync(log, String(error) + '\n');
      fs.closeSync(log);
      resolve({ name: stage.name, exitCode: null, error: String(error.message).slice(0, 160) }); return;
    }
    child.once('error', (error) => {
      fs.writeSync(log, String(error) + '\n');
      try { fs.closeSync(log); } catch {}
      resolve({ name: stage.name, exitCode: null, error: String(error.message).slice(0, 160) });
    });
    child.once('close', (code, signal) => {
      try { fs.closeSync(log); } catch {}
      resolve({ name: stage.name, exitCode: Number.isInteger(code) ? code : null,
        ...(signal ? { signal } : {}) });
    });
  });
}
function signedResult(credentials, result, stages, summary) {
  return { version: 1, id: credentials.id, taskId: credentials.taskId,
    expectedHead: credentials.expectedHead, token: credentials.token, result,
    summary: String(summary).slice(0, 1000), stageResults: stages,
    logs: STAGES.map((s) => 'task-completions/logs/' + credentials.id + '/' + s.file),
    completedAt: new Date().toISOString() };
}
async function execute(id) {
  if (!JOB_ID.test(id)) throw Error('Invalid job ID.');
  const root = dataDir(), credentialFile = credentialPath(root, id);
  const credential = JSON.parse(fs.readFileSync(credentialFile, 'utf8'));
  const record = readJournal(path.join(root, 'task-completion-journal.json')).jobs
    .find((entry) => entry.id === id);
  if (!record || record.state !== 'armed' || record.taskId !== credential.taskId
    || record.branch !== credential.branch || record.expectedHead !== credential.expectedHead
    || !tokenMatches(credential.token, record.tokenDigest)) {
    throw Error('Immutable registered task credentials/state do not match.');
  }
  const directory = path.join(root, 'task-completions', 'logs', id);
  fs.mkdirSync(directory, { recursive: true });
  const output = resultPath(root, id);
  let stages = [], result = 'failed', summary = 'Execution could not start.';
  try {
    const git = gitState();
    if (git.head.toLowerCase() !== record.expectedHead || git.branch !== record.branch || git.dirty) {
      summary = 'Git SHA, branch or clean-tree gate failed at detached worker start.';
    } else {
      for (const stage of STAGES) stages.push(await runStage(stage, directory));
      result = stages.length === STAGES.length && stages.every((x) => x.exitCode === 0)
        ? 'success' : 'failed';
      summary = stages.map((s) => s.name + '=' + (s.exitCode ?? 'unknown')).join('; ');
    }
  } catch (error) { summary = 'Detached worker failed: ' + String(error.message).slice(0, 180); }
  writeJournal(output, signedResult(credential, result, stages, summary));
  return { jobId: id, result, stages, summary };
}
async function start(opts) {
  const agent = source(opts), git = exactSource(opts);
  const taskId = opts['task-id'] || 'qualification-' + randomUUID();
  const registered = await request('task_completion_register', {
    source: agent, roomId: opts.room, requesterMemberId: opts.requester,
    expectedHead: git.sha, branch: git.branch, taskId
  });
  if (!registered?.ok) throw Error(JSON.stringify(registered));
  const job = registered.job;
  if (registered.deduplicated) return { ok: true, deduplicated: true, job };
  // Claim before spawn. A crash between claim and spawn leaves an explicit
  // uncertain start, NEVER a reason to spawn duplicate npm tests.
  claimRun(job.id);
  const child = spawn(process.execPath, [__filename, 'execute', '--job', job.id], {
    cwd: NEXUS, detached: true, stdio: 'ignore', windowsHide: true
  });
  await new Promise((resolve, reject) => {
    child.once('spawn', resolve); child.once('error', reject);
  });
  child.unref();
  return { ok: true, launched: true, job, detachedPid: child.pid,
    resultFile: resultPath(dataDir(), job.id) };
}
async function main(argv = process.argv.slice(2)) {
  const { mode, opts } = options(argv);
  if (mode === 'start') return start(opts);
  if (mode === 'execute') return execute(opts.job);
  if (mode === 'status') return request('task_completion_status', {
    source: source(opts), ...(opts.room ? { roomId: opts.room } : {})
  });
  throw Error('Usage: start --agy-pid <pid> --room <room-id> --requester <member-id> '
    + '--branch <branch> --sha <exact40> [--task-id <unique>] | status --agy-pid <pid>');
}
if (require.main === module) main().then((r) => console.log(JSON.stringify(r, null, 2)))
  .catch((e) => { console.error(e.message); process.exitCode = 2; });
module.exports = { STAGES, options, source, exactSource, claimRun, stageCommand, runStage,
  signedResult, execute, start, request, main };
