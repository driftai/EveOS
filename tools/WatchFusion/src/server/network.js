import os from 'node:os';
import { Worker } from 'node:worker_threads';
import { AsyncLocalStorage } from 'node:async_hooks';

const interfaceScope = new AsyncLocalStorage();
let interfaceWorker = null, pendingProbe = null, retiringWorker = null;
let probeSequence = 0, lastProbeMs = 0, lastProbeAt = 0;
// The native interface enumeration can block on Windows adapter discovery. The
// worker never receives user input or grants authority; the request uses its own fresh snapshot.
const interfaceWorkerCode = `const {parentPort}=require('node:worker_threads');
const os=require('node:os');parentPort.on('message',()=>{try{parentPort.postMessage({interfaces:os.networkInterfaces()||{}});}catch{parentPort.postMessage({error:true});}});`;
function retireInterfaceWorker(worker) {
  if (interfaceWorker !== worker) return;
  interfaceWorker = null;
  retiringWorker = worker.terminate().catch(() => {}).finally(() => { retiringWorker = null; });
}
function freshInterfaceSnapshot() {
  if (pendingProbe) return pendingProbe;
  if (retiringWorker) return Promise.reject(new Error('Network interface probe recovering'));
  const started = Date.now();
  pendingProbe = new Promise((resolve, reject) => {
    let worker = interfaceWorker, timer, settled = false;
    const finish = (err, value) => {
      if (settled) return; settled = true; clearTimeout(timer);
      if (worker) { worker.removeListener('message', onMessage); worker.removeListener('error', onError); worker.removeListener('exit', onExit); }
      lastProbeMs = Math.min(60000, Math.max(0, Date.now() - started)); lastProbeAt = Date.now(); probeSequence++;
      if (err) { if (worker) retireInterfaceWorker(worker); reject(err); }
      else { worker.unref(); resolve(value); }
    };
    const onMessage = result => result?.interfaces && typeof result.interfaces === 'object'
      ? finish(null, result.interfaces) : finish(new Error('Network interface probe failed'));
    const onError = () => finish(new Error('Network interface worker failed'));
    const onExit = () => finish(new Error('Network interface worker exited'));
    try {
      if (!worker) {
        worker = new Worker(interfaceWorkerCode, { eval:true, execArgv:[] }); interfaceWorker = worker;
        // Errors between requests are observed as well; no orphaned worker can crash the server.
        worker.on('error', () => retireInterfaceWorker(worker));
        worker.on('exit', () => { if (interfaceWorker === worker) interfaceWorker = null; });
      }
      worker.ref(); worker.once('message', onMessage); worker.once('error', onError); worker.once('exit', onExit);
      timer = setTimeout(() => finish(new Error('Network interface probe timed out')), 4000);
      worker.postMessage(null);
    } catch (error) { finish(error); }
  }).finally(() => { pendingProbe = null; });
  return pendingProbe;
}
export async function withNetworkSnapshot(task) {
  const interfaces = await freshInterfaceSnapshot();
  return interfaceScope.run(interfaces, task);
}
export function networkInterfacesSnapshot() { return interfaceScope.getStore() ?? os.networkInterfaces(); }
export function networkSnapshotActive() { return interfaceScope.getStore() !== undefined; }
export function networkProbeStats() { return { sequence:probeSequence, ms:lastProbeMs, ageMs:lastProbeAt ? Math.min(60000, Math.max(0, Date.now()-lastProbeAt)) : 60000 }; }


const VIRTUAL_NAME = /(virtual|vEthernet|hyper-v|wsl|docker|vmware|virtualbox|loopback|tunnel|zerotier|tailscale|wireguard|hamachi|host-only|nat)/i;
const PRIVATE_LAN = /^(10\.|192\.168\.|172\.(1[6-9]|2[0-9]|3[0-1])\.)/;

export function networkAddresses() {
  const seen = new Set();
  const candidates = [];
  let interfaces = {};
  try { interfaces = networkInterfacesSnapshot() || {}; }
  catch { interfaces = {}; }
  for (const [name, entries] of Object.entries(interfaces)) {
    for (const entry of entries || []) {
      if (entry.family !== 'IPv4' || entry.internal || !entry.address || seen.has(entry.address)) continue;
      if (/^(127\.|169\.254\.)/.test(entry.address)) continue;
      seen.add(entry.address);
      const privateLan = PRIVATE_LAN.test(entry.address);
      const virtual = VIRTUAL_NAME.test(name);
      candidates.push({
        address: entry.address,
        name,
        virtual,
        shareable: privateLan && !virtual,
        score: (privateLan ? 100 : 10) + (virtual ? -80 : 0)
      });
    }
  }
  return candidates.sort((a, b) => b.score - a.score || a.address.localeCompare(b.address));
}

export const shareableNetworkAddresses = () => networkAddresses().filter(x => x.shareable).map(x => x.address);
export const preferredLanAddress = () => shareableNetworkAddresses()[0] || null;
export const isVirtualAddress = address => networkAddresses().some(x => x.address === address && x.virtual);

export function lanUrls(address, port) {
  if (!address) return { ip: null, host: null };
  return {
    ip: `http://${address}:${port}`,
    host: `http://${address.replaceAll('.', '-')}.sslip.io:${port}`
  };
}

export const localCanonicalHostUrl = port => `http://127.0.0.1:${port}`;
export const localEmbedHostUrl = port => `http://127-0-0-1.sslip.io:${port}`;
export const preferredLanHostUrl = port => lanUrls(preferredLanAddress(), port).host;

export function originForRequest(req) {
  return String(req.headers.host || '').split(':')[0] || '127.0.0.1';
}

export function isHtmlNavigation(req) {
  const method = String(req.method || 'GET').toUpperCase();
  if (method !== 'GET' && method !== 'HEAD') return false;
  return String(req.headers.accept || '').includes('text/html')
    || String(req.url || '').startsWith('/watch/')
    || req.url === '/';
}

export function logNetworkStartup({ port, host, lanMode }) {
  console.log(`WatchFusion listening on port ${port}`);
  console.log(`Local: http://127.0.0.1:${port}`);
  if (!lanMode) console.log(`Local mode: loopback only (http://127.0.0.1:${port})`);

  const addresses = networkAddresses();
  const shareable = addresses.filter(x => x.shareable);
  const localOnly = addresses.filter(x => !x.shareable);

  if (shareable.length) {
    console.log(`LAN (preferred): http://${shareable[0].address}:${port}`);
    for (const item of shareable.slice(1)) console.log(`LAN (other):     http://${item.address}:${port}`);
    console.log('LAN addresses:');
    for (const item of shareable) {
      console.log(`LAN IP:   http://${item.address}:${port}/`);
      console.log(`LAN HOST: http://${item.address.replaceAll('.', '-')}.sslip.io:${port}/`);
    }
    if (localOnly.length) {
      console.log('LAN (local/virtual only):');
      for (const item of localOnly) console.log(`  http://${item.address}:${port}  [${item.name}]`);
    }
    console.log(`LAN SHARE IP:   http://${shareable[0].address}:${port}/`);
    console.log(`LAN SHARE HOST (optional): http://${shareable[0].address.replaceAll('.', '-')}.sslip.io:${port}/`);
  } else if (localOnly.length) {
    console.log('LAN: only local/virtual IPv4 addresses detected; no physical LAN address is safe to advertise');
    for (const item of localOnly) console.log(`  local-only: http://${item.address}:${port}  [${item.name}]`);
  } else {
    console.log('LAN: no usable IPv4 address detected');
  }

  console.log(`Binding: ${host}`);
  console.log(lanMode
    ? 'LAN binding: 0.0.0.0 (all network interfaces)'
    : `Local-only binding: 127.0.0.1 (canonical loopback URL: http://127.0.0.1:${port}/)`);
}
