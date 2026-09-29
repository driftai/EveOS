(function (root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  root.EveOSExtensionProtocol = api;
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  'use strict';

  const CHANNEL = 'eveos.extension.v1';
  const UI_CHANNEL = 'eveos.extension-hub.ui.v1';
  const VERSION = 1;
  const REQUESTS = Object.freeze({
    DESCRIBE: 'describe',
    STATUS: 'status',
    OPEN: 'open',
    INVOKE: 'invoke'
  });

  function request(type, detail = {}) {
    return { channel: CHANNEL, version: VERSION, type, detail };
  }

  function response(type, detail = {}) {
    return { channel: CHANNEL, version: VERSION, type, ok: true, detail };
  }

  function isRequest(value, type = '') {
    return value?.channel === CHANNEL
      && Number(value.version) === VERSION
      && (!type || value.type === type);
  }

  function isResponse(value) {
    return value?.channel === CHANNEL && Number(value.version) === VERSION && value.ok === true;
  }

  return Object.freeze({ CHANNEL, UI_CHANNEL, VERSION, REQUESTS, request, response, isRequest, isResponse });
});
