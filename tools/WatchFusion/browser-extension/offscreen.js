let capture, broadcast, peer, output, timer, frameCallback, rect, canvasTrack, lastMetadata = {};
const video = document.getElementById('source'), canvas = document.getElementById('crop');
const paint = canvas.getContext('2d', { alpha: false });
const sharing = () => Boolean(peer && capture?.getVideoTracks().some(track => track.readyState === 'live'));
const notifySharing = () => chrome.runtime.sendMessage({ to:'popup', type:'capture-state', linked:sharing() }).catch(() => {});

function blank() {
  paint.fillStyle = '#080c12';
  paint.fillRect(0, 0, canvas.width, canvas.height);
}

function stopDrawLoop() {
  clearInterval(timer); timer = null;
  if (frameCallback && video.cancelVideoFrameCallback) video.cancelVideoFrameCallback(frameCallback);
  frameCallback = 0;
}

function startDrawLoop() {
  stopDrawLoop();
  if (typeof video.requestVideoFrameCallback === 'function') {
    const tick = () => {
      if (!capture) return;
      draw();
      frameCallback = video.requestVideoFrameCallback(tick);
    };
    frameCallback = video.requestVideoFrameCallback(tick);
  } else timer = setInterval(draw, 33);
}

function relayBitrate(base) {
  try {
    const host = new URL(base).hostname;
    const near = host === '127.0.0.1' || host === 'localhost' || host.endsWith('.sslip.io')
      || /^(?:10\.|192\.168\.|172\.(?:1[6-9]|2\d|3[01])\.)/.test(host);
    return near ? 8000000 : 4500000;
  } catch { return 6000000; }
}

function stop() {
  stopDrawLoop(); peer?.stop(); peer = null;
  capture?.getTracks().forEach(track => track.stop()); capture = null;
  broadcast?.getTracks().forEach(track => track.stop()); broadcast = null;
  canvasTrack = null; video.srcObject = null;
  output?.close().catch(() => {}); output = null;
  rect = null; lastMetadata = {}; blank();
  void notifySharing();
}

function fitCrop(sw, sh) {
  const scale = Math.min(1, 1920 / sw, 1080 / sh);
  const width = Math.max(2, Math.round(sw * scale / 2) * 2);
  const height = Math.max(2, Math.round(sh * scale / 2) * 2);
  if (canvas.width === width && canvas.height === height) return;
  canvas.width = width; canvas.height = height;
  blank(); canvasTrack?.requestFrame?.();
}

function draw() {
  if (!rect || !video.videoWidth || !video.videoHeight) { blank(); return; }
  const sx = Math.max(0, Math.min(video.videoWidth, rect.x * video.videoWidth));
  const sy = Math.max(0, Math.min(video.videoHeight, rect.y * video.videoHeight));
  const sw = Math.min(video.videoWidth - sx, rect.width * video.videoWidth);
  const sh = Math.min(video.videoHeight - sy, rect.height * video.videoHeight);
  if (sw <= 1 || sh <= 1) { blank(); return; }
  fitCrop(sw, sh);
  paint.drawImage(video, sx, sy, sw, sh, 0, 0, canvas.width, canvas.height);
  canvasTrack?.requestFrame?.();
}

chrome.runtime.onMessage.addListener((message, sender, reply) => {
  if (message.to !== 'offscreen' || sender.id !== chrome.runtime.id) return;
  (async () => {
    if (message.type === 'stop') { stop(); return { ok: true }; }
    if (message.type === 'status') return { linked:sharing() };
    if (message.type === 'sample') {
      rect = message.rect || null;
      lastMetadata = message.metadata || {};
      peer?.metadata(lastMetadata);
      return { ok: true };
    }
    if (message.type !== 'start') return;
    stop();
    try {
      capture = await navigator.mediaDevices.getUserMedia({
        audio: { mandatory: { chromeMediaSource: 'tab', chromeMediaSourceId: message.streamId } },
        video: { mandatory: {
          chromeMediaSource: 'tab', chromeMediaSourceId: message.streamId,
          minWidth: 640, minHeight: 360, maxWidth: 2560, maxHeight: 1440, maxFrameRate: 30
        } }
      });
      video.srcObject = capture;
      await video.play();

      // tabCapture suppresses local tab audio. Restore it independently of the relayed stream.
      output = new AudioContext();
      output.createMediaStreamSource(capture).connect(output.destination);
      await output.resume();

      const canvasStream = canvas.captureStream(0);
      canvasTrack = canvasStream.getVideoTracks()[0];
      canvasTrack.contentHint = 'motion';
      broadcast = new MediaStream([canvasTrack, ...capture.getAudioTracks()]);
      startDrawLoop();
      draw();

      peer = new WatchFusionLivePeer({
        base: message.base, id: message.id, token: message.token, stream: broadcast,
        maxVideoBitrate: relayBitrate(message.base), maxVideoFramerate: 30,
        onReady: () => peer.metadata(lastMetadata),
        onControl: (action, value) => chrome.runtime.sendMessage({ to: 'worker', type: 'control', action, value }).catch(() => {}),
        onStatus: status => { if (/stopped|expired|denied|replaced/i.test(status)) stop(); }
      });
      capture.getVideoTracks()[0].onended = stop;
      void notifySharing();
      return { ok: true };
    } catch (error) { stop(); throw error; }
  })().then(reply, error => reply({ error: error.message }));
  return true;
});
