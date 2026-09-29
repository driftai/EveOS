let capture, broadcast, peer, output, timer, rect, lastMetadata = {};
const video = document.getElementById('source'), canvas = document.getElementById('crop');
const paint = canvas.getContext('2d', { alpha: false });
function stop() {
  clearInterval(timer); timer = null; peer?.stop(); peer = null;
  capture?.getTracks().forEach(track => track.stop()); capture = null;
  broadcast?.getVideoTracks().forEach(track => track.stop()); broadcast = null;
  video.srcObject = null; output?.close().catch(() => {}); output = null;
  rect = null; paint.fillStyle = '#080c12'; paint.fillRect(0, 0, canvas.width, canvas.height);
}
function fitCrop(sw, sh) {
  const scale = Math.min(1, 1920 / sw, 1080 / sh);
  const width = Math.max(2, Math.round(sw * scale / 2) * 2);
  const height = Math.max(2, Math.round(sh * scale / 2) * 2);
  if (canvas.width !== width || canvas.height !== height) { canvas.width = width; canvas.height = height; }
}
function draw() {
  if (!rect || !video.videoWidth) return;
  const sx = Math.max(0, rect.x * video.videoWidth), sy = Math.max(0, rect.y * video.videoHeight);
  const sw = Math.min(video.videoWidth - sx, rect.width * video.videoWidth);
  const sh = Math.min(video.videoHeight - sy, rect.height * video.videoHeight);
  if (sw <= 1 || sh <= 1) return;
  fitCrop(sw, sh);
  paint.fillStyle = '#080c12'; paint.fillRect(0, 0, canvas.width, canvas.height);
  paint.drawImage(video, sx, sy, sw, sh, 0, 0, canvas.width, canvas.height);
}
chrome.runtime.onMessage.addListener((message, sender, reply) => {
  if (message.to !== 'offscreen' || sender.id !== chrome.runtime.id) return;
  (async () => {
    if (message.type === 'stop') { stop(); return { ok: true }; }
    if (message.type === 'sample') {
      if (message.rect) rect = message.rect;
      lastMetadata = message.metadata || {}; peer?.metadata(lastMetadata); return { ok: true };
    }
    if (message.type !== 'start') return;
    stop();
    try {
      capture = await navigator.mediaDevices.getUserMedia({ audio: { mandatory: { chromeMediaSource: 'tab', chromeMediaSourceId: message.streamId } }, video: { mandatory: { chromeMediaSource: 'tab', chromeMediaSourceId: message.streamId, maxWidth: 2560, maxHeight: 1440, maxFrameRate: 30 } } });
      video.srcObject = capture; await video.play();
      output = new AudioContext(); output.createMediaStreamSource(capture).connect(output.destination); await output.resume();
      broadcast = new MediaStream([...canvas.captureStream(30).getVideoTracks(), ...capture.getAudioTracks()]);
      broadcast.getVideoTracks().forEach(track => { track.contentHint = 'detail'; });
      timer = setInterval(draw, 33);
      peer = new WatchFusionLivePeer({ base: message.base, id: message.id, token: message.token, stream: broadcast,
        onReady: () => peer.metadata(lastMetadata),
        onControl: (action, value) => chrome.runtime.sendMessage({ to: 'worker', type: 'control', action, value }).catch(() => {}),
        onStatus: status => { if (/stopped|expired|denied|replaced/i.test(status)) stop(); }
      });
      capture.getVideoTracks()[0].onended = stop;
      return { ok: true };
    } catch (error) { stop(); throw error; }
  })().then(reply, error => reply({ error: error.message }));
  return true;
});
