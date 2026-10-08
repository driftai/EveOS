'use strict';

const base = require('./server-controller-base');
const { enhanceMachineSpacesController } = require('./server-controller-filesystem');
const { enhanceMachineSpacesQuorumController } = require('./server-controller-quorum');
const { enhanceMachineSpacesSupervisedController } = require('./server-controller-supervised');
const { enhanceMachineSpacesRequestViewController } = require('./server-controller-request-view');
const { enhanceMachineSpacesTrustedAttachController } = require('./server-controller-trusted-attach');
const { enhanceMachineSpacesHumanGateController } = require('./server-controller-human-gate');

function createMachineSpacesController(options = {}) {
  return enhanceMachineSpacesHumanGateController(
    (humanGateOptions) => enhanceMachineSpacesTrustedAttachController(
      (trustedAttachOptions) => enhanceMachineSpacesRequestViewController(
        (requestViewOptions) => enhanceMachineSpacesSupervisedController(
          (supervisedOptions) => enhanceMachineSpacesQuorumController(
            (quorumOptions) => enhanceMachineSpacesController(base.createMachineSpacesController, quorumOptions),
            supervisedOptions
          ),
          requestViewOptions
        ),
        trustedAttachOptions
      ),
      humanGateOptions
    ),
    options
  );
}

module.exports = {
  ...base,
  createMachineSpacesController
};
