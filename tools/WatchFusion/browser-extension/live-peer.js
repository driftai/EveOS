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
      socket.onmessage = event => this.receive(JSON.parse(event.data)).catch(error => this.status(error.message));
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
      if (message.type === 'metadata') return this.options.onMetadata?.(message.metadata);
      if (message.type === 'control') return this.options.onControl?.(message.action, message.value);
      if (message.type === 'left') return this.drop(message.peer);
      if (message.type === 'viewer' && this.options.stream) {
        this.drop(message.peer);
        const peer = this.createPeer(message.peer);
        for (const track of this.options.stream.getTracks()) peer.addTrack(track, this.options.stream);
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
    createPeer(id) {
      const peer = new RTCPeerConnection({ iceServers: this.iceServers || [] });
      peer.pendingIce = []; this.peers.set(id, peer);
      peer.onicecandidate = event => { if (event.candidate) this.send({ type: 'signal', peer: id, signal: { candidate: event.candidate.toJSON() } }); };
      peer.ontrack = event => { const stream = event.streams[0]; if (stream) this.options.onStream?.(stream); };
      peer.onconnectionstatechange = () => {
        if (peer.connectionState === 'connected') { clearTimeout(peer.deadline); this.status('Live · connected'); }
        if (peer.connectionState === 'failed') this.status('Live media could not connect. Retry; remote networks may need a TURN relay.');
      };
      peer.deadline = setTimeout(() => { if (peer.connectionState !== 'connected') this.status('Live media is waiting for a network route. Retry on the same LAN or configure a TURN relay.'); }, 15000);
      return peer;
    }
    metadata(value) { this.send({ type: 'metadata', metadata: value }); }
    control(action, value) { this.send({ type: 'control', action, value }); }
    drop(id) { const peer = this.peers.get(id); if (peer) { clearTimeout(peer.deadline); peer.close(); this.peers.delete(id); } }
    clearPeers() { for (const id of this.peers.keys()) this.drop(id); }
    stop() { this.closed = true; clearTimeout(this.retryTimer); clearInterval(this.heartbeat); this.socket?.close(); this.clearPeers(); }
  }
  root.WatchFusionLivePeer = LivePeer;
})(globalThis);
