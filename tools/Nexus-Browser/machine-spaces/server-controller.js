'use strict';

const base = require('./server-controller-base');
const { enhanceMachineSpacesController } = require('./server-controller-filesystem');
const { enhanceMachineSpacesQuorumController } = require('./server-controller-quorum');
const { enhanceMachineSpacesSupervisedController } = require('./server-controller-supervised');
const { enhanceMachineSpacesTrustedAttachController } = require('./server-controller-trusted-attach');

function createMachineSpacesController(options = {}) {
  return enhanceMachineSpacesTrustedAttachController(
    (trustedAttachOptions) => enhanceMachineSpacesSupervisedController(
      (supervisedOptions) => enhanceMachineSpacesQuorumController(
        (quorumOptions) => enhanceMachineSpacesController(base.createMachineSpacesController, quorumOptions),
        supervisedOptions
      ),
      trustedAttachOptions
    ),
    options
  );
}

module.exports = {
  ...base,
  createMachineSpacesController
};
