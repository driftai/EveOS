'use strict';

const { createAgentQuorumCoordinator } = require('./agent-quorum');
const { ACTIONS, createAgentQuorumProviderControl } = require('./agent-quorum-provider-control');
const dexProtocol = require('../public/dex-protocol');
for (const action of ACTIONS) dexProtocol.PROVIDER_CONTROL_ACTIONS.add(action);

function enhanceMachineSpacesQuorumController(createBaseController, options = {}) {
  const base = createBaseController(options);
  const quorum = options.agentQuorum || createAgentQuorumCoordinator({ now: options.now });
  const quorumControl = createAgentQuorumProviderControl({ quorum });
  const providerControl = {
    owns(action) {
      const value = String(action || '').toLowerCase();
      return quorumControl.owns(value) || base.providerControl.owns(value);
    },
    route(input, helpers) {
      const action = String(input?.command?.action || '').toLowerCase();
      return quorumControl.owns(action)
        ? quorumControl.route(input, helpers)
        : base.providerControl.route(input, helpers);
    }
  };
  return { ...base, providerControl, agentQuorum: quorum, quorumControl };
}

module.exports = { enhanceMachineSpacesQuorumController };
