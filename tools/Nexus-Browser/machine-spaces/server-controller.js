'use strict';

const base = require('./server-controller-base');
const { enhanceMachineSpacesController } = require('./server-controller-filesystem');
const { enhanceMachineSpacesQuorumController } = require('./server-controller-quorum');
const { enhanceMachineSpacesSupervisedController } = require('./server-controller-supervised');

function createMachineSpacesController(options = {}) {
  return enhanceMachineSpacesSupervisedController(
    (supervisedOptions) => enhanceMachineSpacesQuorumController(
      (quorumOptions) => enhanceMachineSpacesController(base.createMachineSpacesController, quorumOptions),
      supervisedOptions
    ),
    options
  );
}

module.exports = {
  ...base,
  createMachineSpacesController
};
