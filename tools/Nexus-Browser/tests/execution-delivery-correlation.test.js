'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const ledger = require('../machine-spaces/operation-ledger');
const {
  createTaskCompletionJournal,
  credentialPath,
  resultPath
} = require('../dex/task-completion-journal');
const {
  writeJournal
} = require('../dex/post-idle-maintenance');
const {
  correlateExecutionDelivery
} = require('../dex/execution-delivery-correlation');

const ROOM = 'room-correlation-one';
const SPACE = 'machine-space-one';
const SOURCE = 'message-correlation-one';
const SHA = 'a'.repeat(40);
const BRANCH = 'eve/nexus-machine-spaces';
const BASE = Date.parse('2026-10-17T19:00:00.000Z');

const iso = (offset) => new Date(BASE + offset).toISOString();

function fixture(t) {
  const root = fs.mkdtempSync(
    path.join(os.tmpdir(), 'eveos-cross-owner-')
  );

  t.after(() => fs.rmSync(root, {
    recursive: true,
    force: true
  }));

  let now = BASE + 5000;

  const local = {
    targetClassId: 'local-origin',
    targetId: 'local:test:correlation',
    providerId: 'local-test'
  };

  const state = {
    rooms: [{
      id: ROOM,
      name: 'Correlation Room',
      members: [
        { id: 'worker', binding: { ...local } },
        {
          id: 'requester',
          binding: {
            targetClassId: 'online-origin',
            targetId: 99,
            providerId: 'chatgpt',
            url: 'https://chatgpt.com/c/correlation'
          }
        }
      ]
    }]
  };

  const journal = createTaskCompletionJournal({
    root,
    getState: () => state,
    validateLocal: async () => true,
    readGit: async () => ({
      head: SHA,
      branch: BRANCH,
      dirty: false
    }),
    now: () => now
  });

  return {
    root,
    local,
    journal,
    clock: (offset) => {
      now = BASE + offset;
    }
  };
}

function command(sourceMessageId = SOURCE) {
  return {
    roomId: ROOM,
    requesterMemberId: 'requester',
    taskId: 'correlation-task-one',
    sourceMessageId,
    branch: BRANCH,
    expectedHead: SHA
  };
}

function machineExecution() {
  const value = ledger.createLedger({
    roomId: ROOM,
    spaceId: SPACE
  });

  const requestId = 'machine-request-correlation-one';

  ledger.recordRequest(value, {
    roomId: ROOM,
    spaceId: SPACE,
    requestId,
    actorMemberId: 'worker',
    sourceMessageId: SOURCE,
    terminalId: 'terminal-correlation-one',
    grantId: 'grant-correlation-one',
    capability: 'terminal.exec',
    operationDigest: 'b'.repeat(64),
    commandSummary: 'node correlation-test.js',
    createdAt: iso(0)
  }, () => true);

  ledger.markDispatched(
    value,
    requestId,
    iso(1000)
  );

  ledger.markExecutionStarted(
    value,
    requestId,
    iso(2000)
  );

  ledger.markExecutionCompleted(
    value,
    requestId,
    iso(3000)
  );

  ledger.settle(value, {
    requestId,
    state: 'completed',
    outputId: 'output-correlation-one',
    preview: 'green',
    bytes: 5,
    exitCode: 0,
    finishedAt: iso(4000)
  });

  return value;
}

test(
  'one exact source message correlates execution and delivery without merging ownership',
  async (t) => {
    const f = fixture(t);

    const registered = await f.journal.register({
      source: f.local,
      command: command()
    });

    assert.equal(registered.ok, true);
    assert.equal(
      registered.job.sourceMessageId,
      SOURCE
    );

    const credential = JSON.parse(
      fs.readFileSync(
        credentialPath(
          f.root,
          registered.job.id
        ),
        'utf8'
      )
    );

    assert.equal(
      credential.sourceMessageId,
      SOURCE
    );

    const duplicate = await f.journal.register({
      source: f.local,
      command: command()
    });

    assert.equal(
      duplicate.deduplicated,
      true
    );

    const conflict = await f.journal.register({
      source: f.local,
      command: command('different-message')
    });

    assert.equal(
      conflict.code,
      'TASK_COMPLETION_ID_CONFLICT'
    );

    f.clock(6000);

    writeJournal(
      resultPath(
        f.root,
        registered.job.id
      ),
      {
        version: 1,
        id: registered.job.id,
        token: credential.token,
        expectedHead: SHA,
        taskId: 'correlation-task-one',
        result: 'success',
        summary: 'Correlation qualification passed.',
        stageResults: []
      }
    );

    assert.equal(
      f.journal.scan(),
      1
    );

    f.clock(7000);

    assert.ok(
      f.journal.claim(
        registered.job.id
      )
    );

    f.clock(8000);

    assert.ok(
      f.journal.ack(
        registered.job.id,
        true
      )
    );

    const trace = correlateExecutionDelivery({
      roomId: ROOM,
      sourceMessageId: SOURCE,
      machineEntries: machineExecution().events,
      completionJobs: f.journal.all(),
      now: BASE + 9000
    });

    assert.equal(
      trace.ownership.execution,
      'machine-spaces'
    );

    assert.equal(
      trace.ownership.delivery,
      'task-completion'
    );

    assert.equal(
      trace.machineSpaces.length,
      1
    );

    assert.equal(
      trace.taskCompletion.length,
      1
    );

    assert.equal(
      trace.machineSpaces[0]
        .lifecycle.currentStage,
      'result-persisted'
    );

    assert.equal(
      trace.taskCompletion[0]
        .lifecycle.deliveryOutcome,
      'delivered'
    );

    assert.deepEqual(
      trace.timeline.map(
        (entry) =>
          `${entry.owner}:${entry.stage}`
      ),
      [
        'machine-spaces:accepted',
        'machine-spaces:dispatched',
        'machine-spaces:execution-started',
        'machine-spaces:execution-completed',
        'machine-spaces:result-persisted',
        'task-completion:accepted',
        'task-completion:result-persisted',
        'task-completion:notification-attempted',
        'task-completion:delivered'
      ]
    );
  }
);

test(
  'room membership alone can never create cross-owner correlation',
  () => {
    const trace = correlateExecutionDelivery({
      roomId: ROOM,
      sourceMessageId: 'another-message',
      machineEntries: machineExecution().events,
      completionJobs: [],
      now: BASE + 9000
    });

    assert.equal(
      trace.machineSpaces.length,
      0
    );

    assert.equal(
      trace.taskCompletion.length,
      0
    );

    assert.deepEqual(
      trace.timeline,
      []
    );
  }
);

test(
  'correlation identity is bounded opaque metadata, never inferred',
  () => {
    assert.throws(
      () => correlateExecutionDelivery({
        roomId: ROOM,
        sourceMessageId: 'not valid because spaces',
        machineEntries: [],
        completionJobs: []
      }),
      (error) =>
        error?.code === 'CORRELATION_BAD_ID'
    );
  }
);
