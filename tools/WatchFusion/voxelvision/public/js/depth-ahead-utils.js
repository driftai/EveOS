/** Small browser helpers shared by the analyze-ahead controller. */

export function delay(ms = 0) {
  return new Promise(resolve => window.setTimeout(resolve, ms));
}

export function waitForVideoEvent(target, event, timeoutMs, errorEvent = 'error') {
  return new Promise((resolve, reject) => {
    const timer = window.setTimeout(() => finish(new Error(`Timed out waiting for video ${event}.`)), timeoutMs);
    const onSuccess = () => finish();
    const onError = () => finish(new Error('The analysis decoder could not read this video.'));
    const finish = error => {
      window.clearTimeout(timer);
      target.removeEventListener(event, onSuccess);
      target.removeEventListener(errorEvent, onError);
      if (error) reject(error);
      else resolve();
    };
    target.addEventListener(event, onSuccess, { once: true });
    target.addEventListener(errorEvent, onError, { once: true });
  });
}

export function formatMegabytes(bytes) {
  const mib = Math.max(0, bytes) / (1024 * 1024);
  return `${mib < 10 ? mib.toFixed(1) : Math.round(mib)} MB`;
}
