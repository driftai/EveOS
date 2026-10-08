'use strict';

const base = require('./server-controller-base');
const { enhanceMachineSpacesController } = require('./server-controller-filesystem');
const { enhanceMachineSpacesQuorumController } = require('./server-controller-quorum');

function createMachineSpacesController(options = {}) {
  return enhanceMachineSpacesQuorumController(
    (innerOptions) => enhanceMachineSpacesController(base.createMachineSpacesController, innerOptions),
    options
  );
}

module.exports = {
  ...base,
  createMachineSpacesController
};
