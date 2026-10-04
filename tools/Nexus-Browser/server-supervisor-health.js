'use strict';

function attachSupervisorHealth({ server, sessionId, processRef = process } = {}) {
  if (!processRef?.on || !server) return () => {};
  const onMessage = (message = {}) => {
    if (message.type !== 'supervisor_health_probe' || !message.nonce) return;
    if (typeof processRef.send !== 'function' || processRef.connected === false) return;
    let address = null;
    try { address = server.address?.() || null; } catch {}
    try {
      processRef.send({
        type: 'supervisor_health_ack',
        nonce: String(message.nonce),
        sessionId: String(sessionId || ''),
        listening: !!server.listening,
        address
      });
    } catch {}
  };
  processRef.on('message', onMessage);
  return () => {
    try { processRef.off?.('message', onMessage); } catch {}
  };
}

module.exports = { attachSupervisorHealth };
