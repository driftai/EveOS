'use strict';

const base = require('./server-controller-base');
const { enhanceMachineSpacesController } = require('./server-controller-filesystem');

function createMachineSpacesController(options = {}) {
  return enhanceMachineSpacesController(base.createMachineSpacesController, options);
}

module.exports = {
  ...base,
  createMachineSpacesController
};
