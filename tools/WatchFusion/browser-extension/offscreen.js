let capture, peer, output, timer, rect, sampledAt = 0, lastMetadata = {};
const video = document.getElementById('source'), canvas = document.getElementById('crop');
const paint = canvas.getContext('2d', { alpha: false });
function stop() {
  clearInterval(timer); timer = null; peer?.stop(); peer = null;
  capture?.getTracks().forEach(track => track.stop()); capture = null;
  video.srcObject = null; output?.close().catch(() => {}); output = null;
  rect = null; paint.fillStyle = '#080c12'; paint.fillRect(0, 0, canvas.width, canvas.height);
}
function draw() {
  paint.fillStyle = '#080c12'; paint.fillRect(0, 0, canvas.width, canvas.height);
  if (!rect || Date.now() - sampledAt > 1000 || !video.videoWidth) return;
  const sx = rect.x * video.videoWidth, sy = rect.y * video.videoHeight;
  const sw = rect.width * video.videoWidth, sh = rect.height * video.videoHeight;
  if (sw <= 0 || sh <= 0) return;
  const scale = Math.min(canvas.width / sw, canvas.height / sh), dw = sw * scale, dh = sh * scale;
  paint.drawImage(video, sx, sy, sw, sh, (canvas.width - dw) / 2, (canvas.height - dh) / 2, dw, dh);
}
chrome.runtime.onMessage.addListener((message, sender, reply) => {
  if (message.to !== 'offscreen' || sender.id !== chrome.runtime.id) return;
  (async () => {
    if (message.type === 'stop') { stop(); return { ok: true }; }
    if (message.type === 'sample') {
      rect = message.rect; sampledAt = Date.now(); lastMetadata = message.metadata || {};
      peer?.metadata(lastMetadata); return { ok: true };
    }
    if (message.type !== 'start') return;
    stop();
    try {
      capture = await navigator.mediaDevices.getUserMedia({ audio: { mandatory: { chromeMediaSource: 'tab', chromeMediaSourceId: message.streamId } }, video: { mandatory: { chromeMediaSource: 'tab', chromeMediaSourceId: message.streamId, maxWidth: 1920, maxHeight: 1080, maxFrameRate: 30 } } });
      video.srcObject = capture; await video.play();
      // tabCapture silences the source's local output. Restore it once, here.
      output = new AudioContext(); output.createMediaStreamSource(capture).connect(output.destination); await output.resume();
      const stream = new MediaStream([...canvas.captureStream(30).getVideoTracks(), ...capture.getAudioTracks()]);
      timer = setInterval(draw, 33);
      peer = new WatchFusionLivePeer({ base: message.base, id: message.id, token: message.token, stream,
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
