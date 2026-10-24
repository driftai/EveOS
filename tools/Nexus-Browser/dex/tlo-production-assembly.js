'use strict';

const { randomBytes } = require('node:crypto');
const runtimeConfig = require('../runtime-config');
const serviceWorkspaceBridge = require('../service-workspace-bridge');
const serviceChats = require('../local-targets/eveos-service-chats');
const { createTloBackendTransport } = require('../local-targets/tlo-backend-transport');
const { BACKEND_TRANSPORT } = require('./tlo-backend-ownership-seam');
const { createTloBackendRuntime } = require('./tlo-backend-runtime');
const { createTloConversationStore, historyDigest } = require('./tlo-conversation-store');
const { createDurableTloOwnershipStore } = require('./tlo-ownership-durable-store');
const { createTloOwnershipFence } = require('./tlo-ownership-fence');
const { createTloProductionActivation, sourceIdentity } = require('./tlo-production-activation');

const TLO_TARGET = 'local:tlo-chat:default';
const TLO_PROVIDER = 'tlo-chat';
function failure(code, message) { return Object.assign(new Error(message), { code }); }
function token() { return randomBytes(32).toString('base64url'); }
function browserTarget() {
  return { id: TLO_TARGET, targetClassId: 'local-origin', targetTypeId: 'provider-workspace',
    targetTypeName: 'Eve-OS Bound Chats', providerId: TLO_PROVIDER, providerName: 'TLO',
    title: 'TLO Chat', detail: 'The exact TLO conversation owned by Search Monitor.',
    transport: 'search-monitor-workspace', sessionOrigin: 'shared-search-monitor-workspace',
    capabilities: { chat: true, captureLatest: false, activity: false, searchResults: false } };
}

function createTloProductionAssembly({ serverSessionId, getDurability, getStateStore,
  eveosBaseUrl = `http://127.0.0.1:${runtimeConfig.portFor('EVEOS_WEB_PORT')}`,
  ownershipStore = createDurableTloOwnershipStore(),
  conversationStore = createTloConversationStore(),
  activation = createTloProductionActivation({ serverSessionId, source: sourceIdentity() }),
  historyBridge = serviceWorkspaceBridge } = {}) {
  if (typeof getDurability !== 'function' || typeof getStateStore !== 'function')
    throw new TypeError('TLO production assembly requires existing Dex durability and state owners.');
  const ownerFence = createTloOwnershipFence(ownershipStore);
  const durability = { query: (...args) => getDurability().query(...args) };
  const stateStore = { load: (...args) => getStateStore().load(...args) };
  let runtime = null, startupError = null, leaseTimer = null;

  function ownerState() { return ownerFence.snapshot('default').state; }
  function deployment() { return activation.status(); }
  function assertDeploymentUsable() {
    const state = deployment();
    if (state.state === 'invalid') throw failure(state.code, state.message);
    return state;
  }
  function activeFor(owner) {
    const state = deployment();
    return state.active === true && state.owner?.id === owner.id
      && state.owner?.generation === owner.generation;
  }
  function refreshRuntime() {
    if (leaseTimer) clearInterval(leaseTimer);
    leaseTimer = null;
    runtime = null;
    const state = ownerState(), configured = assertDeploymentUsable();
    if (state.owner?.kind !== 'backend' || !configured.configured) return null;
    if (configured.owner?.id !== state.owner.id || configured.owner?.generation !== state.generation)
      throw failure('TLO_DEPLOYMENT_OWNER_MISMATCH', 'Activation and durable TLO ownership disagree.');
    const credentials = activation.credentials();
    const owner = { kind: 'backend', id: state.owner.id, generation: state.generation };
    const transport = createTloBackendTransport({ baseUrl: eveosBaseUrl,
      secret: credentials.secret, serverSessionId, owner });
    runtime = createTloBackendRuntime({ active: () => activeFor(owner), owner,
      ownershipStore, conversationStore, durability, stateStore, streamChat: transport.streamChat });
    if (configured.active) {
      leaseTimer = setInterval(() => {
        try { activation.renew(); }
        catch (error) { startupError = error; runtime = null; clearInterval(leaseTimer); leaseTimer = null; }
      }, 20_000);
      leaseTimer.unref?.();
    }
    return runtime;
  }
  try {
    ownerFence.fenceRestart({ scopeId: 'default' });
    conversationStore.fenceRestart('default');
    refreshRuntime();
  } catch (error) { startupError = error; runtime = null; }

  function browserAuthority(state = ownerState()) {
    const snapshot = historyBridge.snapshot(TLO_TARGET);
    if (state.handoff || state.owner?.kind === 'backend') return { allowed: false, snapshot };
    if (state.owner?.kind === 'browser' && state.owner.id !== snapshot.workspaceId)
      return { allowed: false, snapshot };
    return { allowed: true, snapshot };
  }
  const route = Object.freeze({
    async listTargets() {
      if (startupError || deployment().state === 'invalid') return [];
      const state = ownerState();
      if (state.handoff) return [];
      if (state.owner?.kind === 'backend') return runtime ? runtime.targetAdapter.listTargets() : [];
      return browserAuthority(state).allowed ? [browserTarget()] : [];
    },
    status() {
      if (startupError) return { bound: false, running: false, busy: false, state: 'backend_invalid',
        message: startupError.message };
      const state = ownerState();
      if (state.handoff) return { bound: false, running: false, busy: false, state: 'transferring',
        ownerGeneration: state.generation, message: 'TLO ownership transfer is awaiting an exact acknowledgement.' };
      if (state.turn?.phase === 'unknown') return { bound: false, running: false, busy: true, state: 'uncertain',
        ownerGeneration: state.generation, message: 'TLO has an uncertain request; no replay or rollback is allowed.' };
      if (state.owner?.kind === 'backend') return runtime?.targetAdapter.status() || {
        bound: false, running: false, busy: !!state.turn, state: 'backend_disabled',
        ownerGeneration: state.generation, message: 'Durable backend ownership exists, but activation is disabled.' };
      const snapshot = historyBridge.snapshot(TLO_TARGET);
      return { ...snapshot, state: state.owner ? 'browser_owned' : snapshot.state,
        ownerGeneration: state.generation, ownerKind: state.owner?.kind || null };
    },
    async sendPrompt(input) {
      if (startupError) throw startupError;
      const state = ownerState();
      if (state.handoff) throw failure('TLO_HANDOFF_ACTIVE', 'TLO ownership is transferring.');
      if (state.owner?.kind === 'backend') {
        if (!runtime) throw failure('TLO_BACKEND_DISABLED', 'Browser-independent TLO is disabled.');
        return runtime.targetAdapter.sendPrompt(input);
      }
      if (!browserAuthority(state).allowed)
        throw failure('TLO_BROWSER_OWNER_STALE', 'This Search Monitor page is not the durable browser owner.');
      return historyBridge.sendPrompt(input);
    }
  });

  const seam = Object.freeze({
    async beforeSend(input) {
      if (input?.target?.id !== TLO_TARGET) return null;
      const state = ownerState();
      if (state.handoff) throw failure('TLO_HANDOFF_ACTIVE', 'TLO ownership is transferring.');
      if (state.owner?.kind !== 'backend') {
        if (input.target.transport === BACKEND_TRANSPORT)
          throw failure('TLO_BACKEND_OWNER_STALE', 'Backend target is not the durable owner.');
        return null;
      }
      if (!runtime) throw failure('TLO_BACKEND_DISABLED', 'Browser-independent TLO is disabled.');
      const context = await runtime.ownershipSeam.beforeSend(input);
      if (context) Object.defineProperty(context, '__productionSeam', { value: runtime.ownershipSeam });
      return context;
    },
    afterEvent: (context, payload) => context?.__productionSeam?.afterEvent(context, payload),
    afterReturn: (context) => context?.__productionSeam?.afterReturn(context),
    afterFailure: (context, error) => context?.__productionSeam?.afterFailure(context, error)
  });

  async function ensureBrowserJournal() {
    let state = ownerState();
    const host = historyBridge.snapshot(TLO_TARGET);
    if (!host.bound || !host.workspaceId) throw failure('TLO_BROWSER_UNAVAILABLE', 'Exact Search Monitor TLO workspace is unavailable.');
    const generation = state.generation || 1, challenge = token();
    const exported = await historyBridge.exportTloHistory({ scopeId: 'default', generation }, { challenge });
    const digest = historyDigest({ scopeId: 'default', generation, history: exported.history });
    if (digest !== exported.digest) throw failure('TLO_HISTORY_DIGEST_MISMATCH', 'Browser history integrity failed.');
    if (!state.owner) {
      ownerFence.claimInitialBrowser({ workspaceId: host.workspaceId });
      conversationStore.initialize({ generation: 1, history: exported.history, expectedDigest: digest });
      state = ownerState();
    } else {
      if (state.owner.kind !== 'browser' || state.owner.id !== host.workspaceId)
        throw failure('TLO_BROWSER_OWNER_STALE', 'Connected browser does not match durable ownership.');
      const proof = conversationStore.proof('default', state.generation);
      if (!proof || proof.digest !== digest)
        throw failure('TLO_HISTORY_DIVERGED', 'Browser and durable TLO histories diverged.');
    }
    return { state, host, digest };
  }
  const control = Object.freeze({
    async preflight() {
      if (startupError) throw startupError;
      assertDeploymentUsable();
      const { state, host, digest } = await ensureBrowserJournal();
      const ownerId = `nexus-tlo-backend-${serverSessionId}`;
      return activation.prepare({ ownerId, ownerGeneration: state.generation + 1,
        browserWorkspaceId: host.workspaceId, browserGeneration: state.generation, browserDigest: digest });
    },
    handoff() {
      const configured = activation.credentials();
      if (!configured || configured.mode !== 'prepared')
        throw failure('TLO_DEPLOYMENT_STATE_INVALID', 'A current preflight is required.');
      const state = ownerState(), from = { ...state.owner, generation: state.generation };
      if (from.kind !== 'browser' || from.id !== configured.browserWorkspaceId)
        throw failure('TLO_BROWSER_OWNER_STALE', 'Preflight browser owner is stale.');
      const to = { kind: 'backend', id: configured.ownerId }, acknowledgementSecret = token();
      const prepared = ownerFence.prepareHandoff({ from, to,
        conversationDigest: configured.browserDigest, sourceWorkspaceId: from.id, acknowledgementSecret });
      const acknowledged = ownerFence.acknowledgeHandoff({ handoffId: prepared.handoff.id,
        to, acknowledgementSecret });
      ownerFence.completeHandoff({ handoffId: prepared.handoff.id, from });
      conversationStore.advanceGeneration({ handoffProof: acknowledged.handoff });
      const result = activation.markHandedOff(); refreshRuntime(); return result;
    },
    activate() {
      const configured = activation.credentials(), state = ownerState();
      if (!configured || configured.mode !== 'handed_off' || state.owner?.kind !== 'backend'
          || state.owner.id !== configured.ownerId || state.generation !== configured.ownerGeneration
          || state.handoff || state.turn || !conversationStore.proof('default', state.generation))
        throw failure('TLO_ACTIVATION_PREFLIGHT_FAILED', 'Backend owner is not durably idle and ready.');
      const result = activation.activate(); refreshRuntime(); return result;
    },
    async rollback() {
      const configured = activation.credentials(), state = ownerState();
      if (!configured || !['handed_off', 'active'].includes(configured.mode)
          || state.owner?.kind !== 'backend' || state.handoff || state.turn
          || conversationStore.snapshot('default')?.pending)
        throw failure('TLO_ROLLBACK_BLOCKED', 'Rollback requires a resolved, idle backend owner.');
      const host = historyBridge.snapshot(TLO_TARGET);
      if (!host.bound || !host.workspaceId) throw failure('TLO_BROWSER_UNAVAILABLE', 'Browser owner is unavailable for rollback.');
      const current = await historyBridge.exportTloHistory({ scopeId: 'default',
        generation: configured.browserGeneration }, { challenge: token() });
      if (current.history.length && current.digest !== configured.browserDigest)
        throw failure('TLO_HISTORY_DIVERGED', 'Browser history changed while backend owned TLO.');
      const history = conversationStore.snapshot('default').history;
      const targetGeneration = state.generation + 1;
      const digest = historyDigest({ scopeId: 'default', generation: targetGeneration, history });
      const from = { ...state.owner, generation: state.generation }, to = { kind: 'browser', id: host.workspaceId };
      const acknowledgementSecret = token();
      const prepared = ownerFence.prepareHandoff({ from, to,
        conversationDigest: conversationStore.proof('default', state.generation).digest,
        sourceWorkspaceId: from.id, acknowledgementSecret });
      await historyBridge.hydrateTloHistory({ scopeId: 'default', generation: targetGeneration,
        history, digest, expectedCurrentDigest: current.digest,
        expectedCurrentGeneration: configured.browserGeneration }, { challenge: acknowledgementSecret });
      const acknowledged = ownerFence.acknowledgeHandoff({ handoffId: prepared.handoff.id,
        to, acknowledgementSecret });
      ownerFence.completeHandoff({ handoffId: prepared.handoff.id, from });
      conversationStore.advanceGeneration({ handoffProof: acknowledged.handoff });
      activation.disable(); refreshRuntime(); return route.status();
    },
    status() {
      let owner; try { owner = ownerState(); } catch (error) { return { state: 'invalid', code: error.code, message: error.message }; }
      return { deployment: deployment(), owner: { kind: owner.owner?.kind || null,
        id: owner.owner?.id || null, generation: owner.generation }, uncertain: owner.turn?.phase === 'unknown',
        handoff: owner.handoff ? { id: owner.handoff.id, status: owner.handoff.status,
          to: owner.handoff.to, toGeneration: owner.handoff.toGeneration } : null,
        readiness: route.status() };
    }
  });
  serviceChats.configureExclusiveTloRoute(route);
  return Object.freeze({ route, ownershipSeam: seam, control, status: control.status,
    source: activation.source, activation, ownerFence, conversationStore,
    close() { if (leaseTimer) clearInterval(leaseTimer); leaseTimer = null; } });
}

module.exports = { createTloProductionAssembly };
