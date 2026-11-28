// Source-tab mute and silence regression checks extracted from v13107-falsifiers.js.
import assert from 'node:assert/strict';
import vm from 'node:vm';
import { webcrypto } from 'node:crypto';

export async function runSourceWorkerChecks(check, read) {
  await check('V13107-08:source-tab-mute-is-verified-and-reasserted', () => {
    const src = read('browser-extension/worker.js');
    assert.ok(!/chrome\.tabs\.update\(tabId,\{muted:true\}\)\.catch\(\(\)=>\{\}\)/.test(src), 'mute failures are no longer swallowed');
    assert.match(src, /muteVerified=after\?\.mutedInfo\?\.muted===true/, 'mute is read back after the update');
    assert.match(src, /latestMuteEvidence=\{tabId,at:receivedAt,muted:sender\.tab\?\.mutedInfo\?\.muted\}/, 'capture actual sender mute evidence');
    assert.match(src, /const fresh=evidence\?\.tabId===tabId&&age>=0&&age<=900/);
    assert.match(src, /const muted=await ensureSourceTabMuted\(tabId,fresh&&evidence\.muted===false\)/, 'a fresh audible source sample awaits a verified mute recheck');
    assert.match(src, /sendSourceSample\(sample\.metadata,muted\)/, 'source telemetry carries verified mute, not a stale sender flag');
    assert.match(src, /chrome\.tabs\.update\(tabId,\{muted:previousMuted\}\)/, 'unlink restores the original mute state');
  });
  await check('V13107-08A:cold-worker-remutes-before-sampling-and-restores-the-original-tab-mute', async () => {
    for (const previousMuted of [false, true]) {
      const lab = sourceWorkerLab(read, previousMuted);
      const event = previousMuted ? { status: 'complete' } : { mutedInfo: { muted: false } };
      await Promise.all([lab.update(event), lab.link.status()]);
      assert.equal(lab.muted(), true);
      assert.equal(lab.peers.length, 1);
      const firstPeer = lab.peers[0];
      firstPeer.options.onReady();
      assert.equal(firstPeer.samples.at(-1)?.tabMuted, true);
      await Promise.all([lab.update({ status: 'complete' }), lab.link.status()]);
      assert.equal(lab.peers.length, 1);
      assert.equal(lab.muted(), true);
      await lab.link.stop();
      assert.equal(lab.muted(), previousMuted);
      assert.equal(lab.saved.sourceTab, undefined);
    }
  });
  await check('V13107-08B:unlink-restores-mute-after-an-in-flight-reassertion', async () => {
    const lab = sourceWorkerLab(read, false);
    assert.equal((await lab.link.status()).linked, true);
    lab.unmute();
    const pending = lab.deferTabRead();
    const update = lab.update({ mutedInfo: { muted: false } });
    await pending.started;
    const unlink = lab.link.stop();
    pending.release();
    await Promise.all([update, unlink]);
    assert.equal(lab.muted(), false);
    assert.equal(lab.saved.sourceTab, undefined);
  });
  await check('V13107-08C:pairing-mutes-the-tab-before-starting-the-probe', async () => {
    for (const previousMuted of [false, true]) {
      const lab = sourceWorkerLab(read, previousMuted, { linked: false });
      const pairing = 'http://localhost:9087/#live=' + 'a'.repeat(36) + '.' + 'b'.repeat(48);
      assert.equal((await lab.link.startCurrentTab(pairing, { tabId: 5, windowId: 2 })).ok, true);
      assert.equal(lab.queriedWindow(), 2);
      assert.equal(lab.muted(), true);
      await lab.link.stop();
      assert.equal(lab.muted(), previousMuted);
    }
  });
  await check('V13107-08D:popup-status-verifies-native-mute-and-identifies-the-owned-tab', async () => {
    const lab = sourceWorkerLab(read, false);
    await lab.link.status();
    lab.unmute();
    const status = await lab.link.status({ verifyMute: true });
    assert.equal(status.sourceTabId, 5);
    assert.equal(status.tabMuted, true);
    assert.equal(lab.muted(), true);
  });
  await check('V13107-08E:source-starting-to-play-rechecks-the-native-mute', async () => {
    const lab = sourceWorkerLab(read, false);
    await lab.link.status();
    lab.unmute();
    await lab.update({ audible: true });
    assert.equal(lab.muted(), true);
  });
  await check('V13107-08F:source-player-silence-belongs-to-the-selected-link', async () => {
    const lab = sourceWorkerLab(read, false);
    await lab.link.status();
    assert.equal((await lab.link.setSourcePlayerSilence(6, true)).ok, undefined);
    assert.equal(lab.saved.sourcePlayerSilenced, undefined);
    const enabled = await lab.link.setSourcePlayerSilence(5, true);
    assert.equal(enabled.silencedMedia, 1);
    assert.equal((await lab.link.status()).sourcePlayerSilenced, true);
    assert.equal(lab.saved.sourcePlayerSilenced, true);
    await lab.update({ status:'complete' });
    assert.equal(lab.probeStartModes.at(-1), true);
    await lab.link.stop();
    assert.equal(lab.saved.sourcePlayerSilenced, undefined);
  });
}

function sourceWorkerLab(read, previousMuted, { linked = true } = {}) {
  const tabId = 5;
  let muted = linked ? false : previousMuted;
  let update;
  let onMessage;
  let deferRead;
  let queriedWindow;
  const probeStartModes = [];
  const peers = [];
  const saved = linked ? {
    sourceTab: tabId, sourceTabWasMuted: previousMuted,
    sourceLinkConfig: { base: 'http://localhost:9087', id: 'publisher', token: 'test' }
  } : {};
  const session = {
    get: async () => ({ ...saved }),
    set: async (values) => { Object.assign(saved, values); },
    remove: async (keys) => keys.forEach((key) => { delete saved[key]; })
  };
  class LivePeer {
    constructor(options) { this.options = options; this.samples = []; peers.push(this); }
    metadata(sample) { this.samples.push(sample); }
    send(message) { if(this.closed)return false; if(message.type==='metadata')this.metadata(message.metadata); return true; }
    stop() { this.closed = true; }
  }
  const timers=new Map();let timerId=0;
  const ctx = vm.createContext({
    URL, crypto:webcrypto, setTimeout, clearTimeout,
    setInterval:fn=>{const id=++timerId;timers.set(id,fn);return id;},clearInterval:id=>timers.delete(id),
    importScripts() {},
    WatchFusionLivePeer: LivePeer,
    chrome: {
      runtime: { id:'fixture', onMessage: { addListener: (listener) => { onMessage = listener; } } },
      storage: { session },
      scripting: { executeScript: async () => [{ frameId: 0 }] },
      tabs: {
        query: async ({ windowId }) => { queriedWindow = windowId; return [{ id: tabId }]; },
        get: async () => {
          if (deferRead) await deferRead();
          return { id: tabId, url: 'https://example.test/media', mutedInfo: { muted } };
        },
        update: async (id, changes) => { assert.equal(id, tabId); muted = changes.muted; },
        sendMessage: async (id, message) => {
          if (message.type === 'source-player-silence') return { silencedMedia: message.enabled ? 1 : 0 };
          if (message.type !== 'probe-start') return;
          probeStartModes.push(message.sourcePlayerSilenced);
          assert.equal(muted, true, 'Browser tab must be muted before collecting source samples');
          onMessage({ to: 'worker', type: 'sample', hasMedia: true, generation:message.generation, token:'fixture-probe', topFrame:true, score:3, metadata:{pageUrl:'https://example.test/media',sampledAt:Date.now(),currentTime:12,paused:false} }, {
            id:'fixture', frameId:0, tab: { id, url: 'https://example.test/media', mutedInfo: { muted } }
          }, () => {});
        },
        onRemoved: { addListener() {} },
        onUpdated: { addListener: (listener) => { update = listener; } }
      }
    }
  });
  vm.runInContext(read('browser-extension/worker.js'), ctx);
  return {
    peers, saved, probeStartModes, link: ctx.WatchFusionMediaLink,
    update: (info) => update(tabId, info),
    muted: () => muted,
    queriedWindow: () => queriedWindow,
    unmute: () => { muted = false; },
    deferTabRead: () => {
      let release;
      let notify;
      const gate = new Promise((resolve) => { release = resolve; });
      const started = new Promise((resolve) => { notify = resolve; });
      deferRead = () => { deferRead = null; notify(); return gate; };
      return { started, release };
    }
  };
}
