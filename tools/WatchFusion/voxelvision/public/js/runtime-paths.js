const MOUNT_PREFIX = /^\/voxelvision(?:\/|$)/i.test(globalThis.location?.pathname || '') ? '/voxelvision' : '';

function withMountPrefix(pathname) {
  const normalized = `/${String(pathname || '').replace(/^\/+/, '')}`;
  return `${MOUNT_PREFIX}${normalized}`;
}

export function voxelVisionAssetUrl(pathname) {
  return withMountPrefix(pathname);
}

export function voxelVisionApiUrl(pathname) {
  return withMountPrefix(`/api/${String(pathname || '').replace(/^\/+/, '')}`);
}

export function isVoxelVisionMounted() {
  return Boolean(MOUNT_PREFIX);
}
