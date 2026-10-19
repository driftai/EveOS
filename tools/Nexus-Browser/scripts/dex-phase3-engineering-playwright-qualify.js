#!/usr/bin/env node
'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { randomUUID } = require('node:crypto');
const { openNexusWorkspace, evidenceDir } = require('../playwright/eveos-nexus-workspace');
const { transact } = require('./dex-room-terminal');
const { validateEngineeringProposal } = require('../dex/engineering-proposal');

const ROOM = /^room-[A-Za-z0-9_-]{6,125}$/;
// Fixed failure label for a controlled Playwright proof; not an API token or credential.
const DEFAULT_PHASE3_FAILURE_MARKER = 'PHASE3_CONTROLLED_FAILURE';

function argumentsFor(argv = []) {
  const options = { roomId: '', token: DEFAULT_PHASE3_FAILURE_MARKER, timeoutMs: 240000, headless: true };
  for (let index = 0; index < argv.length; index += 1) {
    const key = argv[index];
    if (key === '--headed') options.headless = false;
    else if (key === '--headless') options.headless = true;
    else if (['--room', '--token', '--timeout'].includes(key)) {
      const value = argv[++index];
      if (value == null || String(value).startsWith('--')) throw new Error(`${key} requires a value.`);
      if (key === '--room') options.roomId = value;
      else if (key === '--token') options.token = value;
      else options.timeoutMs = Number(value) * 1000;
    } else throw new Error(`Unsupported Phase 3 Playwright option ${key}.`);
  }
  if (!ROOM.test(options.roomId)) throw new Error('--room must be one exact Dex room ID.');
  if (!options.token || options.token.length > 120 || /[\x00-\x1f\x7f]/.test(options.token)) throw new Error('--token must be bounded plain text.');
  if (!Number.isFinite(options.timeoutMs) || options.timeoutMs < 30000 || options.timeoutMs > 300000) {
    throw new Error('--timeout must be 30..300 seconds.');
  }
  return options;
}

async function inspect(roomId) {
  return transact({
    type: 'dex_terminal_inspect', requestId: `phase3-inspect-${randomUUID()}`,
    roomId, limit: 20
  });
}

async function waitForProposal(roomId, jobId, timeoutMs, inspectFn = inspect) {
  const deadline = Date.now() + timeoutMs;
  let latest = null;
  while (Date.now() < deadline) {
    latest = await inspectFn(roomId);
    const incident = (latest.engineeringIncidents || []).find((entry) => entry.jobId === jobId);
    if (incident?.dispatch === 'safe-stopped') {
      throw new Error(`Engineering incident safe-stopped: ${incident.classification || 'unknown'}.`);
    }
    if (incident?.dispatch === 'scheduled') {
      const marker = (latest.messages || []).findIndex((message) =>
        message.senderName === 'Machine Spaces' && message.text.includes(`job=${jobId}`)
      );
      const replies = marker >= 0 ? latest.messages.slice(marker + 1).filter((message) => message.senderKind === 'agent') : [];
      for (const reply of replies) {
        const proposal = validateEngineeringProposal(reply.text, incident);
        if (proposal.ok) return { incident, proposal, responseMessageId: reply.id };
      }
    }
    await new Promise((resolve) => setTimeout(resolve, 1000));
  }
  throw new Error(`No validated engineering proposal arrived for ${jobId}. Last incident count ${latest?.engineeringIncidentCount || 0}.`);
}

async function run(options) {
  let session = null;
  let frame = null;
  let humanEnabled = false;
  try {
    session = await openNexusWorkspace({ headless: options.headless, timeoutMs: Math.min(options.timeoutMs, 120000) });
    frame = session.page.frameLocator('[data-nexus-browser-frame]');
    await frame.locator('#dexModeTab').click({ timeout: 30000 });
    const room = frame.locator(`#dexRoomList .dex-room-item[data-room-id="${options.roomId}"]`);
    await room.waitFor({ state: 'visible', timeout: 30000 });
    await room.click();

    const toggle = frame.locator('#dexHumanToggle');
    await toggle.waitFor({ state: 'visible', timeout: 30000 });
    if (await toggle.getAttribute('aria-pressed') !== 'true') await toggle.click();
    await frame.locator('#dexModePanel[data-human-input="enabled"]').waitFor({ state: 'attached', timeout: 15000 });
    humanEnabled = true;

    const machineSpaces = frame.locator('#dexMachineSpaces');
    if (await machineSpaces.getAttribute('open') == null) {
      await machineSpaces.locator(':scope > summary').click();
    }

    const allCards = frame.locator('[data-supervised-jobs] .machine-request');
    await allCards.first().waitFor({ state: 'visible', timeout: 30000 });
    const roomState = await inspect(options.roomId);
    const matching = [];
    for (let index = 0; index < await allCards.count(); index += 1) {
      const candidate = allCards.nth(index);
      const candidateTitle = await candidate.locator('.machine-request-title').innerText();
      const candidateJobId = candidateTitle.split('·').map((part) => part.trim()).at(-1) || '';
      const cardText = await candidate.innerText();
      const receiptMatches = (roomState.messages || []).some((message) => message.senderName === 'Dex'
        && message.text.includes(candidateJobId) && message.text.includes(options.token));
      if (cardText.includes(options.token) || receiptMatches) matching.push(candidate);
    }
    if (matching.length !== 1) throw new Error(`Expected one exact queued job for token ${options.token}; found ${matching.length}.`);
    const card = matching[0];
    const title = await card.locator('.machine-request-title').innerText();
    const jobId = title.split('·').map((part) => part.trim()).at(-1) || '';
    if (!/^machine-job-[A-Za-z0-9_-]{6,125}$/.test(jobId)) throw new Error(`Could not prove the queued job identity from ${title}.`);
    if (!await card.locator('.machine-state-queued').isVisible()) throw new Error(`Prepared job ${jobId} is not queued.`);

    await card.getByRole('button', { name: 'Start supervised', exact: true }).click();
    const dialog = frame.locator('.machine-dialog');
    await dialog.waitFor({ state: 'visible', timeout: 10000 });
    await dialog.getByRole('button', { name: 'Start job', exact: true }).click();
    await card.locator('.machine-state-failed').waitFor({ state: 'visible', timeout: options.timeoutMs });

    const recovery = await waitForProposal(options.roomId, jobId, options.timeoutMs);
    return { jobId, workspace: session.workspace, browserMode: session.mode, ...recovery,
      browserErrors: session.diagnostics.records.length, optionalProbeNoise: session.diagnostics.ignored.length };
  } catch (error) {
    fs.mkdirSync(evidenceDir, { recursive: true });
    if (session?.page) {
      if (frame) {
        const state = await frame.locator('body').evaluate(() => ({
          activeRoomId: document.querySelector('#dexRoomList .dex-room-item.active')?.dataset.roomId || null,
          spaceId: document.querySelector('#machineSpaceSelect')?.value || null,
          spaces: Array.from(document.querySelectorAll('#machineSpaceSelect option')).map((option) => ({ value: option.value, text: option.textContent })),
          supervisedText: String(document.querySelector('[data-supervised-jobs]')?.textContent || '').trim().slice(0, 1200)
        })).catch(() => null);
        if (state) error.message += ` | ui=${JSON.stringify(state)}`;
      }
      const screenshot = path.join(evidenceDir, `phase3-failure-${Date.now()}.png`);
      await session.page.screenshot({ path: screenshot, fullPage: true }).catch(() => {});
      error.screenshot = screenshot;
    }
    throw error;
  } finally {
    if (humanEnabled && frame) {
      const toggle = frame.locator('#dexHumanToggle');
      if (await toggle.getAttribute('aria-pressed').catch(() => 'false') === 'true') await toggle.click().catch(() => {});
    }
    await session?.close?.();
  }
}

async function main(argv = process.argv.slice(2)) {
  const options = argumentsFor(argv);
  try {
    const result = await run(options);
    console.log(`DEX_PHASE3_PLAYWRIGHT_GREEN room=${options.roomId} job=${result.jobId}`
      + ` dispatch=${result.incident.dispatch} proposal=${result.proposal.schema}`
      + ` retry=${result.proposal.retryIntent} browserErrors=${result.browserErrors}`
      + ` optionalProbeNoise=${result.optionalProbeNoise}`);
  } catch (error) {
    console.error(`DEX_PHASE3_PLAYWRIGHT_RED ${error?.message || error}`);
    if (error?.screenshot) console.error(`screenshot=${error.screenshot}`);
    process.exitCode = 1;
  }
}

if (require.main === module) main();
module.exports = { DEFAULT_PHASE3_FAILURE_MARKER, argumentsFor, waitForProposal, run, main };
