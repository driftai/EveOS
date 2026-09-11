import assert from 'node:assert/strict';
import { ForegroundMaskAssist } from '../public/js/foreground-mask-assist.js';
const originalWorker = globalThis.Worker;
const workers = [];
globalThis.Worker = class {
  constructor() { workers.push(this); }
  postMessage(message) {
    if (message.type === 'load') queueMicrotask(() => this.onmessage({ data: { type: 'ready' } }));
    else this.job = message;
  }
  finish() { this.onmessage({ data: { type: 'mask', id: this.job.id, mask: new Uint8Array(64).fill(255), ms: 200 } }); }
  terminate() { this.terminated = true; }
};
const interrupted = new ForegroundMaskAssist();
const interruptedLoad = interrupted.setEnabled(true);
const interruptedWorker = workers.at(-1);
interrupted.setEnabled(true, { defer: true });
assert.equal(await interruptedLoad, false, 'cache-only restore must settle an obsolete auxiliary load');
assert.equal(interrupted.worker, null);
assert.ok(interruptedWorker.terminated, 'cache-only restore must release an in-progress auxiliary worker');
const assist = new ForegroundMaskAssist();
try {
  const workerCount = workers.length;
  assist.setEnabled(true, { defer: true });
  assert.equal(workers.length, workerCount, 'deferred assistance must not compile a model during cache-only replay');
  const loading = assist.ensureReady();
  assert.equal(workers.length, workerCount + 1, 'the worker must start when uncached assisted analysis actually needs it');
  await loading;
  const activeWorker = workers.at(-1);
  const rgba = new Uint8ClampedArray(256).fill(90);
  const first = assist.forFrame(rgba, 8, 8, 0);
  activeWorker.finish();
  assert.ok(await first);
  assert.deepEqual(await assist.forFrame(rgba, 8, 8, 0.1), new Uint8Array(64).fill(255), 'unchanged borders and interior can reuse matching evidence');
  const moving = new Uint8ClampedArray(256).fill(180);
  const next = assist.forFrame(moving, 8, 8, 0.2);
  assert.ok(assist.pending, 'meaningful image change must request fresh evidence within the sparse interval');
  assist.reset(); activeWorker.finish();
  assert.equal(await next, null, 'results from before a seek/source reset must be discarded');
  const outstanding = assist.forFrame(rgba, 8, 8, 2);
  assist.setEnabled(false);
  assert.equal(await outstanding, null, 'disabling must settle pending work');
  assert.ok(activeWorker.terminated);
  activeWorker.onmessage({ data: { type: 'ready' } });
  assert.equal(assist.ready, false, 'an obsolete worker must not revive itself');
  console.log('Foreground mask scheduling passed: matching reuse, motion refresh, reset and disable cancellation.');
} finally { assist.setEnabled(false); globalThis.Worker = originalWorker; }
