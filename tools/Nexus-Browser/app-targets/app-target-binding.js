'use strict';

const { bindingScope } = require('./passive-watcher');

function conversationProof(identity = {}) {
  const anchors = [
    ...(Array.isArray(identity.conversationAnchors) ? identity.conversationAnchors : []),
    identity.conversationAnchor
  ].filter(Boolean);
  return {
    title: String(identity.conversationTitle || '').trim(),
    anchors: [...new Set(anchors.map(String))]
  };
}

function strongTargetIdentity(target = {}) {
  const identity = target.concreteTargetIdentity || {};
  const pid = identity.processId || target.pid || null;
  const hwnd = identity.windowHandle || target.windowHandle || null;
  const proof = conversationProof(identity);
  return !!target.id && !!target.providerId && !!pid && !!hwnd
    && (!!proof.title || proof.anchors.length > 0);
}

function createBinding(target, { expectedIdentity = null, exactMatch = null } = {}) {
  if (!target?.id || !target?.providerId) {
    const error = new Error('App-Origin target identity is incomplete.');
    error.code = 'APP_TARGET_IDENTITY_INCOMPLETE';
    throw error;
  }

  if (expectedIdentity) {
    const expected = {
      ...target,
      concreteTargetIdentity: { ...expectedIdentity }
    };
    if (typeof exactMatch === 'function' && !exactMatch(expected, target)) {
      const error = new Error(
        'The native app conversation changed; explicit target selection is required.'
      );
      error.code = 'APP_TARGET_REBIND_REQUIRED';
      throw error;
    }
  }

  const bindingIdentity = {
    ...(expectedIdentity || target.concreteTargetIdentity || {})
  };
  if (!bindingIdentity.deliveryScope) {
    bindingIdentity.deliveryScope = bindingScope({
      ...target,
      concreteTargetIdentity: bindingIdentity
    });
  }
  return {
    ...target,
    concreteTargetIdentity: bindingIdentity
  };
}

function persistBinding(target, {
  expectedIdentity = null,
  exactMatch = null,
  storage
} = {}) {
  if (!storage?.writeTargetSelection) {
    const error = new Error('Terminal Relay target storage is unavailable.');
    error.code = 'APP_TARGET_STORAGE_UNAVAILABLE';
    throw error;
  }
  const binding = createBinding(target, { expectedIdentity, exactMatch });
  storage.writeTargetSelection(binding);
  return binding;
}

function providerCandidates(liveTargets = [], providerId = 'chatgpt-desktop') {
  return liveTargets.filter((target) =>
    String(target?.providerId || '') === String(providerId)
      && strongTargetIdentity(target));
}

function findPersistedTarget(selection, liveTargets = []) {
  const stored = selection?.target;
  if (!stored?.id || !stored?.providerId) return null;
  return liveTargets.find((target) =>
    String(target?.id || '') === String(stored.id)
      && String(target?.providerId || '') === String(stored.providerId)) || null;
}

function restorePersistedBinding({
  selection,
  liveTargets = [],
  appTargetsApi,
  storage,
  allowSingleTargetFallback = false,
  providerId = 'chatgpt-desktop'
} = {}) {
  const stored = selection?.target || null;
  const live = findPersistedTarget(selection, liveTargets);

  if (stored && live && strongTargetIdentity(stored) && strongTargetIdentity(live)
      && typeof appTargetsApi?.advanceAppTargetBinding === 'function') {
    const advanced = appTargetsApi.advanceAppTargetBinding(stored, live);
    if (advanced && strongTargetIdentity(advanced)) {
      const binding = createBinding(advanced);
      storage?.writeTargetSelection?.(binding);
      return { binding, mode: 'restored', priorSelection: true };
    }
  }

  if (!allowSingleTargetFallback) return null;

  const candidates = providerCandidates(liveTargets, providerId);
  if (candidates.length !== 1) {
    const error = new Error(candidates.length
      ? 'Multiple strong App-Origin targets are available; automatic binding is ambiguous.'
      : 'No single strong App-Origin target is available for automatic binding.');
    error.code = candidates.length ? 'AUTO_BIND_AMBIGUOUS' : 'AUTO_BIND_TARGET_UNAVAILABLE';
    error.detail = { providerId, candidates: candidates.length };
    throw error;
  }

  const binding = persistBinding(candidates[0], { storage });
  return {
    binding,
    mode: stored ? 'recovered-single-target' : 'single-live-target',
    priorSelection: !!stored
  };
}

module.exports = {
  conversationProof,
  strongTargetIdentity,
  createBinding,
  persistBinding,
  providerCandidates,
  findPersistedTarget,
  restorePersistedBinding
};
