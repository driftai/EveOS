import { Worker, isMainThread, parentPort } from 'node:worker_threads';

// Discovery starts external commands. Keep their synchronous waits off the relay
// thread, and coalesce concurrent host-local requests into a single operation.
let pending = null;
export function youtubeStatusOffThread() {
  if (!isMainThread) throw new Error('Status discovery requires the main thread.');
  if (pending) return pending;
  const job = new Promise((resolve, reject) => {
    let worker, timer, settled = false;
    function finish(error, value) {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (error) reject(error); else resolve(value);
    }
    try {
      worker = new Worker(new URL(import.meta.url), { execArgv: [] });
      worker.once('message', message => {
        if (message?.ok === true && message.value && typeof message.value.available === 'boolean') finish(null, message.value);
        else finish(new Error('YouTube tool discovery failed.'));
      });
      worker.once('error', () => finish(new Error('YouTube tool discovery failed.')));
      worker.once('exit', () => finish(new Error('YouTube tool discovery exited without a result.')));
      timer = setTimeout(() => {
        // Do not replace this worker or start another job until it has exited.
        void worker.terminate().then(() => finish(new Error('YouTube tool discovery timed out.')), () => finish(new Error('YouTube tool discovery timed out.')));
      }, 105000);
      timer.unref?.();
    } catch (error) { finish(error); }
  });
  pending = job.finally(() => { pending = null; });
  return pending;
}

if (!isMainThread) {
  try {
    const { getYoutubeStatus } = await import('../../voxelvision/youtube-import.js');
    parentPort.postMessage({ ok: true, value: getYoutubeStatus() });
  } catch { parentPort.postMessage({ ok: false }); }
  finally { parentPort.close(); }
}
