const MAX_PENDING_MS = 15_000;

function setupPlaybackScrollRestore() {
  let pending = null;
  let timer = 0;

  const remember = event => {
    const top = Math.max(0, Number(event?.detail?.top) || 0);
    pending = { top, at: Date.now() };
    if (timer) clearTimeout(timer);
    timer = setTimeout(() => { pending = null; timer = 0; }, MAX_PENDING_MS);
  };

  function onStatus(status, previousStatus) {
    if (!pending) return;
    if (status === "error") { pending = null; return; }
    if (status !== "playing" || previousStatus === "playing") return;
    const restore = pending;
    pending = null;
    if (timer) clearTimeout(timer);
    timer = setTimeout(() => {
      timer = 0;
      window.scrollTo({ top: restore.top, behavior: "smooth" });
    }, 320);
  }

  window.addEventListener("piano:preserve-playback-scroll", remember);
  return Object.freeze({ onStatus });
}

export { setupPlaybackScrollRestore };
