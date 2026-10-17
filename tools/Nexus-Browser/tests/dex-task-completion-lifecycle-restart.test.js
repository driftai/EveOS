'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const {
  lifecycleProjection,
  createTaskCompletionJournal
} = require('../dex/task-completion-journal');

const ID = 'task-completion-00000000-0000-4000-8000-000000000001';

function baseJob(state, extra = {}) {
  return {
    id: ID,
    taskId: 'task-restart-proof',
    jobType: 'qualification',
    roomId: 'room-one',
    roomName: 'Room One',
    workerMemberId: 'worker-one',
    workerTargetId: 'local:worker:1',
    workerProviderId: 'local-test',
    requesterMemberId: 'requester-one',
    requesterTarget: {
      targetClassId: 'online-origin',
      providerId: 'chatgpt',
      targetId: '101',
      url: 'https://chatgpt.com/c/test'
    },
    expectedHead: 'a'.repeat(40),
    branch: 'eve/nexus-machine-spaces',
    registeredAt: '2026-10-17T18:00:00.000Z',
    expiresAt: '2026-10-18T06:00:00.000Z',
    state,
    ...extra
  };
}

function seed(root, job) {
  const file = path.join(root, 'task-completion-journal.json');
  fs.writeFileSync(
    file,
    JSON.stringify({
      version: 1,
      jobs: [job]
    }),
    'utf8'
  );
  return file;
}

test('notification lifecycle exposes deterministic current-stage age', () => {
  const view = lifecycleProjection(
    baseJob('sent-unconfirmed', {
      readyAt: '2026-10-17T18:01:00.000Z',
      claimedAt: '2026-10-17T18:02:00.000Z'
    }),
    '2026-10-17T18:02:05.000Z'
  );

  assert.equal(view.currentStage, 'notification-attempted');
  assert.equal(view.stageSince, '2026-10-17T18:02:00.000Z');
  assert.equal(view.stageAgeMs, 5000);
  assert.equal(
    view.notificationAttemptedAt,
    '2026-10-17T18:02:00.000Z'
  );
});

test('restart converts an in-flight notification to durable uncertainty at the restart boundary', (t) => {
  const root = fs.mkdtempSync(
    path.join(os.tmpdir(), 'eveos-task-completion-restart-')
  );

  t.after(() => {
    fs.rmSync(root, {
      recursive: true,
      force: true
    });
  });

  const file = seed(
    root,
    baseJob('sent-unconfirmed', {
      readyAt: '2026-10-17T18:01:00.000Z',
      claimedAt: '2026-10-17T18:02:00.000Z'
    })
  );

  let clock = Date.parse('2026-10-17T18:04:00.000Z');

  const recovered = createTaskCompletionJournal({
    root,
    filePath: file,
    now: () => clock
  });

  const first = recovered.all()[0];

  assert.equal(first.state, 'outcome-unknown');
  assert.equal(first.deliveredAt, '2026-10-17T18:04:00.000Z');
  assert.equal(first.lifecycle.currentStage, 'uncertain');
  assert.equal(
    first.lifecycle.stageSince,
    '2026-10-17T18:04:00.000Z'
  );
  assert.equal(first.lifecycle.stageAgeMs, 0);

  // Uncertainty is terminal for automatic delivery replay.
  assert.equal(recovered.ready().length, 0);
  assert.equal(recovered.claim(ID), null);

  // A later process recreation must preserve the ORIGINAL
  // uncertainty boundary rather than resetting its age.
  clock = Date.parse('2026-10-17T18:04:05.000Z');

  const secondProcess = createTaskCompletionJournal({
    root,
    filePath: file,
    now: () => clock
  });

  const later = secondProcess.all()[0];

  assert.equal(later.state, 'outcome-unknown');
  assert.equal(later.deliveredAt, '2026-10-17T18:04:00.000Z');
  assert.equal(later.lifecycle.stageAgeMs, 5000);
  assert.equal(secondProcess.ready().length, 0);
  assert.equal(secondProcess.claim(ID), null);
});

test('explicit uncertain delivery records its own terminal transition time', (t) => {
  const root = fs.mkdtempSync(
    path.join(os.tmpdir(), 'eveos-task-completion-uncertain-')
  );

  t.after(() => {
    fs.rmSync(root, {
      recursive: true,
      force: true
    });
  });

  const file = seed(
    root,
    baseJob('ready', {
      readyAt: '2026-10-17T18:10:00.000Z'
    })
  );

  let clock = Date.parse('2026-10-17T18:10:02.000Z');

  const journal = createTaskCompletionJournal({
    root,
    filePath: file,
    now: () => clock
  });

  const claimed = journal.claim(ID);

  assert.equal(claimed.state, 'sent-unconfirmed');
  assert.equal(
    claimed.lifecycle.currentStage,
    'notification-attempted'
  );

  clock = Date.parse('2026-10-17T18:10:05.000Z');

  const uncertain = journal.uncertain(
    ID,
    'Provider submission result could not be proven.'
  );

  assert.equal(uncertain.state, 'outcome-unknown');
  assert.equal(
    uncertain.deliveredAt,
    '2026-10-17T18:10:05.000Z'
  );
  assert.equal(uncertain.lifecycle.currentStage, 'uncertain');
  assert.equal(uncertain.lifecycle.stageAgeMs, 0);

  clock = Date.parse('2026-10-17T18:10:07.500Z');

  assert.equal(
    journal.all()[0].lifecycle.stageAgeMs,
    2500
  );

  assert.equal(journal.claim(ID), null);
});
