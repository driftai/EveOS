#!/usr/bin/env node
'use strict';

const fs = require('node:fs');
const path = require('node:path');
const {
  parseArgs,
  openNexusWorkspace,
  evidenceDir
} = require('../playwright/eveos-nexus-workspace');

function writeFailure(error) {
  fs.mkdirSync(evidenceDir, { recursive: true });
  const file = path.join(evidenceDir, 'latest-failure.json');
  fs.writeFileSync(file, JSON.stringify({
    at: new Date().toISOString(),
    message: String(error?.message || error),
    diagnostics: Array.isArray(error?.diagnostics) ? error.diagnostics : []
  }, null, 2));
  return file;
}

function waitForStop(durationMs = 0) {
  return new Promise((resolve) => {
    let timer = null;
    const stop = (reason) => {
      if (timer) clearTimeout(timer);
      process.off('SIGINT', onInterrupt);
      process.off('SIGTERM', onTerminate);
      resolve(reason);
    };
    const onInterrupt = () => stop('signal');
    const onTerminate = () => stop('signal');
    process.once('SIGINT', onInterrupt);
    process.once('SIGTERM', onTerminate);
    if (durationMs > 0) timer = setTimeout(() => stop('duration'), durationMs);
  });
}

async function main(argv = process.argv.slice(2)) {
  const options = parseArgs(argv);
  let session = null;
  try {
    session = await openNexusWorkspace(options);
    const { workspace } = session;
    console.log(
      `NEXUS_PLAYWRIGHT_WORKSPACE_READY mode=${session.mode} workspace=${workspace.workspaceId}`
      + ` targets=${workspace.targets.length} frame=${workspace.frameUrl}`
    );
    const reason = await waitForStop(options.durationMs);
    console.log(`NEXUS_PLAYWRIGHT_WORKSPACE_STOPPED reason=${reason} browserErrors=${session.diagnostics.records.length}`
      + ` optionalProbeNoise=${session.diagnostics.ignored.length}`);
  } catch (error) {
    const file = writeFailure(error);
    console.error(`NEXUS_PLAYWRIGHT_WORKSPACE_RED ${error?.message || error}`);
    console.error(`diagnostics=${file}`);
    process.exitCode = 1;
  } finally {
    await session?.close?.();
  }
}

if (require.main === module) main();
module.exports = { main, waitForStop, writeFailure };
