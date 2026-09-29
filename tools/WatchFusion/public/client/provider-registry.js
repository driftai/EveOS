const mediaProviders = new Map();

function registerMediaProvider(provider) {
  if (!provider?.id || typeof provider?.supports !== 'function' || typeof provider?.load !== 'function') throw new TypeError('Provider requires id, supports(), and load().');
  mediaProviders.set(String(provider.id), Object.freeze(provider));
  return provider;
}

function findMediaProvider(source) {
  for (const provider of mediaProviders.values()) if (provider.supports(source)) return provider;
  return null;
}

registerMediaProvider({
  id: 'external-media',
  supports: source => source?.kind === 'media' && !!source.url,
  load: source => window.mediaPlayback?.ensureSource?.(source),
  unload: () => window.mediaPlayback?.clear?.()
});

async function unloadMediaProvider(source) {
  const provider = findMediaProvider(source);
  if (typeof provider?.unload === 'function') await provider.unload(source);
}
window.watchPartyProviders = {
  register: registerMediaProvider,
  find: findMediaProvider,
  unload: unloadMediaProvider,
  list: () => [...mediaProviders.keys()]
};
