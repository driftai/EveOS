'use strict';
// Relay SEND is admitted by localhost before an originating model turn finalizes.
// It has its own durable request-ID receipt. Recording a second pending control
// receipt after response_final would deadlock the room's FIFO until manual cleanup.
function directRoomSend(command = {}) {
  return String(command?.action || '').trim().toLowerCase() === 'send'
    && command.relay !== false;
}
module.exports = { directRoomSend };
