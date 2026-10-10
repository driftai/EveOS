'use strict';

const fs = require('node:fs');
const path = require('node:path');

function findNpmCli() {
    const candidates = [
        process.env.npm_execpath,
        path.join(path.dirname(process.execPath), 'node_modules', 'npm', 'bin', 'npm-cli.js'),
        path.resolve(path.dirname(process.execPath), '..', 'lib', 'node_modules', 'npm', 'bin', 'npm-cli.js')
    ].filter(Boolean);
    return candidates.find((candidate) => fs.existsSync(candidate)) || null;
}

function npmInvocation(args = []) {
    const cli = findNpmCli();
    if (cli) return { command: process.execPath, args: [cli, ...args], cli };
    if (process.platform === 'win32') {
        throw new Error('npm CLI could not be resolved beside Node. Reinstall Node.js with npm included.');
    }
    return { command: 'npm', args, cli: null };
}

module.exports = { findNpmCli, npmInvocation };
