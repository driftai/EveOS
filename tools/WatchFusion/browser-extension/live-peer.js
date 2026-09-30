/* Shared by the companion, EveOS publisher, and WatchFusion receivers. */
(function (root) {
  'use strict';
  class LivePeer {
    constructor(options) {
      this.options = options; this.peers = new Map(); this.closed = false; this.retry = 0;
      this.connect();
      this.heartbeat = setInterval(() => this.send({ type: 'ping' }), 15000);
    }
    send(data) { if (this.socket?.readyState === 1) this.socket.send(JSON.stringify(data)); }
    connect() {
      if (this.closed) return;
      const url = new URL('/live-ws', this.options.base); url.protocol = url.protocol === 'https:' ? 'wss:' : 'ws:';
      const socket = new WebSocket(url); this.socket = socket;
      socket.onopen = () => { this.retry = 0; this.send({ type: 'join', id: this.options.id, token: this.options.token, role: this.options.stream ? 'publisher' : 'viewer', roomId: this.options.roomId, memberId: this.options.memberId }); };
      socket.onmessage = event => {
        try {
          this.receive(JSON.parse(event.data)).catch(error => this.status(error.message));
        } catch {
          this.status('The live connection sent an invalid response. Reconnecting…');
          socket.close(4002, 'invalid response');
        }
      };
      socket.onerror = () => this.status('Live connection unavailable');
      socket.onclose = event => {
        this.clearPeers();
        if (this.closed) return;
        this.status(event.reason || 'Reconnecting live media…');
        if (event.code === 1008 || event.code === 1000) return;
        this.retryTimer = setTimeout(() => this.connect(), Math.min(10000, 500 * 2 ** this.retry++));
      };
    }
    status(message) { this.options.onStatus?.(message); }
    async receive(message) {
      if (message.type === 'ready') { this.iceServers = message.iceServers; this.viewerId = message.peer; this.options.onReady?.(); return; }
      if (message.type === 'status') return this.status(message.status);
      if (message.type === 'audio-sync') return this.options.onAudioSync?.(message);
      if (message.type === 'metadata') return this.options.onMetadata?.(message.metadata);
      if (message.type === 'control') return this.options.onControl?.(message.action, message.value);
      if (message.type === 'left') return this.drop(message.peer);
      if (message.type === 'viewer' && this.options.stream) {
        this.drop(message.peer);
        const peer = this.createPeer(message.peer);
        const senders = this.options.stream.getTracks().map(track => peer.addTrack(track, this.options.stream));
        await Promise.all(senders.map(sender => this.tuneSender(sender)));
        const offer = await peer.createOffer(); await peer.setLocalDescription(offer);
        this.send({ type: 'signal', peer: message.peer, signal: { description: peer.localDescription } });
        return;
      }
      if (message.type !== 'signal') return;
      const peer = this.peers.get(message.peer) || this.createPeer(message.peer);
      const signal = message.signal;
      if (signal.description) {
        await peer.setRemoteDescription(signal.description);
        for (const candidate of peer.pendingIce.splice(0)) await peer.addIceCandidate(candidate);
        if (signal.description.type === 'offer') {
          await peer.setLocalDescription(await peer.createAnswer());
          this.send({ type: 'signal', peer: message.peer, signal: { description: peer.localDescription } });
        }
      } else if (signal.candidate) {
        if (peer.remoteDescription) await peer.addIceCandidate(signal.candidate);
        else peer.pendingIce.push(signal.candidate);
      }
    }
    async tuneSender(sender) {
      if (sender.track?.kind !== 'video') return;
      try {
        const params = sender.getParameters();
        if (!params.encodings?.length) return;
        params.encodings[0].maxBitrate = Math.max(500000, Number(this.options.maxVideoBitrate) || 6000000);
        params.encodings[0].maxFramerate = Math.max(15, Number(this.options.maxVideoFramerate) || 30);
        params.degradationPreference = 'maintain-framerate';
        await sender.setParameters(params);
      } catch {}
    }
    async replaceVideoTrack(track) {
      if (!track || track.kind !== 'video' || !this.options.stream) return;
      const audio = this.options.stream.getAudioTracks();
      this.options.stream = new MediaStream([track, ...audio]);
      await Promise.all([...this.peers.values()].map(async peer => {
        const sender = peer.getSenders().find(item => item.track?.kind === 'video');
        if (!sender || sender.track === track) return;
        try { await sender.replaceTrack(track); await this.tuneSender(sender); } catch {}
      }));
    }
    createPeer(id) {
      const peer = new RTCPeerConnection({ iceServers: this.iceServers || [] });
      peer.pendingIce = []; this.peers.set(id, peer);
      peer.onicecandidate = event => { if (event.candidate) this.send({ type: 'signal', peer: id, signal: { candidate: event.candidate.toJSON() } }); };
      peer.ontrack = event => {
        const target = Math.max(0, Math.min(4000, Number(this.options.jitterBufferTargetMs) || 60));
        try {
          if ('jitterBufferTarget' in event.receiver) event.receiver.jitterBufferTarget = target;
          else if ('playoutDelayHint' in event.receiver) event.receiver.playoutDelayHint = target / 1000;
        } catch {}
        const stream = event.streams[0]; if (stream) this.options.onStream?.(stream);
      };
      peer.onconnectionstatechange = () => {
        if (peer.connectionState === 'connected') { clearTimeout(peer.deadline); this.status('Live · connected'); }
        if (peer.connectionState === 'failed') {
          this.status('Live media lost its route. Reconnecting…');
          if (!this.options.stream && this.socket?.readyState === 1) this.socket.close(4001, 'peer retry');
        }
      };
      peer.deadline = setTimeout(() => { if (peer.connectionState !== 'connected') this.status('Live media is waiting for a network route. Retry on the same LAN or configure a TURN relay.'); }, 15000);
      return peer;
    }
    async diagnostics() {
      const result = [];
      for (const [id, peer] of this.peers) {
        const item = { peer:id, state:peer.connectionState };
        try {
          const stats = await peer.getStats();
          stats.forEach(report => {
            const kind = report.kind || report.mediaType;
            if (report.type === 'outbound-rtp' && kind === 'video') item.outboundVideo = {
              framesEncoded:report.framesEncoded, totalEncodeTime:report.totalEncodeTime,
              qualityLimitationReason:report.qualityLimitationReason, bytesSent:report.bytesSent,
              retransmittedPacketsSent:report.retransmittedPacketsSent
            };
            if (report.type === 'inbound-rtp' && (kind === 'video' || kind === 'audio')) item[`inbound${kind === 'audio' ? 'Audio' : 'Video'}`] = {
              framesDecoded:report.framesDecoded, framesDropped:report.framesDropped, jitter:report.jitter,
              jitterBufferDelay:report.jitterBufferDelay, jitterBufferTargetDelay:report.jitterBufferTargetDelay,
              jitterBufferMinimumDelay:report.jitterBufferMinimumDelay, jitterBufferEmittedCount:report.jitterBufferEmittedCount,
              framesPerSecond:report.framesPerSecond, packetsLost:report.packetsLost,
              concealedSamples:report.concealedSamples, insertedSamplesForDeceleration:report.insertedSamplesForDeceleration,
              estimatedPlayoutTimestamp:report.estimatedPlayoutTimestamp, totalProcessingDelay:report.totalProcessingDelay
            };
            if (report.type === 'candidate-pair' && report.state === 'succeeded' && (report.nominated || report.selected)) {
              item.route = { currentRoundTripTime:report.currentRoundTripTime, availableOutgoingBitrate:report.availableOutgoingBitrate };
            }
          });
        } catch {}
        result.push(item);
      }
      return result;
    }
    async audioSyncSample() {
      for (const peer of this.peers.values()) {
        try {
          const stats = await peer.getStats();
          for (const report of stats.values()) {
            if (report.type !== 'inbound-rtp' || (report.kind || report.mediaType) !== 'audio') continue;
            const estimatedPlayoutTimestamp = Number(report.estimatedPlayoutTimestamp);
            if (!Number.isFinite(estimatedPlayoutTimestamp) || estimatedPlayoutTimestamp <= 0) return null;
            const emitted = Number(report.jitterBufferEmittedCount) || 0;
            return {
              estimatedPlayoutTimestamp,
              jitterBufferDelayMs: emitted > 0 ? (Number(report.jitterBufferDelay) || 0) * 1000 / emitted : null,
              jitterBufferTargetMs: emitted > 0 ? (Number(report.jitterBufferTargetDelay) || 0) * 1000 / emitted : null
            };
          }
        } catch {}
      }
      return null;
    }
    syncAudio(sample) { this.send({ type: 'sync-sample', sample }); }
    metadata(value) { this.send({ type: 'metadata', metadata: value }); }
    control(action, value) { this.send({ type: 'control', action, value }); }
    drop(id) { const peer = this.peers.get(id); if (peer) { clearTimeout(peer.deadline); peer.close(); this.peers.delete(id); } }
    clearPeers() { for (const id of this.peers.keys()) this.drop(id); }
    stop() { this.closed = true; clearTimeout(this.retryTimer); clearInterval(this.heartbeat); this.socket?.close(); this.clearPeers(); }
  }
  root.WatchFusionLivePeer = LivePeer;
})(globalThis);
