'use strict';

const { buildRequestView } = require('./request-view');
const { findSpace, ensureSpaceShape } = require('./server-controller-filesystem');

function machineError(code, message) { return Object.assign(new Error(message), { code }); }

function enhanceMachineSpacesRequestViewController(createBaseController, options = {}) {
  const uiSockets = options.uiSockets || new Set();
  const safeSend = options.safeSend || (() => false);
  const getState = options.getState || (() => null);
  const base = createBaseController(options);

  function requireLocal(ws) {
    if (!uiSockets.has(ws)) {
      throw machineError('MACHINE_LOCAL_OWNER_REQUIRED', 'Unified Machine Spaces request history is available only to the local Nexus UI.');
    }
  }

  function requestSource(roomId, spaceRef) {
    const snapshot = getState();
    const room = (snapshot?.rooms || []).find((entry) => entry.id === String(roomId || ''));
    if (!room) throw machineError('MACHINE_ROOM_NOT_FOUND', 'Dex room no longer exists.');
    const space = findSpace(room, spaceRef);
    if (!space) throw machineError('MACHINE_SPACE_REQUIRED', 'Choose one exact active Machine Space.');
    ensureSpaceShape(space);
    const supervisedJobs = base.supervisedJobs?.snapshot?.().jobs || [];
    return {
      room,
      space,
      terminalRequests: Array.isArray(space.requests) ? space.requests : [],
      fileRequests: Array.isArray(space.fileRequests) ? space.fileRequests : [],
      supervisedJobs: supervisedJobs.filter((job) => job.roomId === room.id && job.spaceId === space.id)
    };
  }

  function view(msg = {}) {
    const source = requestSource(msg.roomId, msg.spaceId);
    const page = buildRequestView({
      terminalRequests: source.terminalRequests,
      fileRequests: source.fileRequests,
      supervisedJobs: source.supervisedJobs
    }, {
      kind: msg.kind,
      state: msg.state,
      actor: msg.actor,
      query: msg.query,
      liveOnly: msg.liveOnly === true,
      limit: msg.limit,
      cursor: msg.cursor
    });
    return {
      type: 'machine_request_view',
      requestId: msg.requestId || null,
      roomId: source.room.id,
      spaceId: source.space.id,
      ...page
    };
  }

  async function handle(ws, msg = {}) {
    const type = String(msg.type || '');
    try {
      if (type === 'machine_request_view') {
        requireLocal(ws);
        safeSend(ws, view(msg));
        return true;
      }
      return base.handle(ws, msg);
    } catch (error) {
      safeSend(ws, {
        type: 'error', requestId: msg.requestId || null,
        code: error.code || 'MACHINE_REQUEST_VIEW_FAILED', message: error.message
      });
      return true;
    }
  }

  return { ...base, handle, requestView: view };
}

module.exports = { enhanceMachineSpacesRequestViewController };
