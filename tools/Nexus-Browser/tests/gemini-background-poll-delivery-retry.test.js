const test = require('node:test');
const assert = require('node:assert/strict');
const poll = require('../extension/gemini-background-poll.js');

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function waitFor(predicate, { attempts = 120, delayMs = 10 } = {}) {
  for (let index = 0; index < attempts; index += 1) {
    if (predicate()) return;
    await sleep(delayMs);
  }
  assert.fail('Timed out waiting for Gemini final-delivery retry');
}

test('AI Studio rejected final delivery stays retryable without concurrent poll fan-out', async (t) => {
  const requestId = `delivery-retry-${Date.now()}`;
  const finalEvents = [];
  const completionSeenBySend = [];
  let finalAttempts = 0;
  let sampleCalls = 0;
  let samplesInFlight = 0;
  let maxSamplesInFlight = 0;

  t.after(() => poll.stopResponsePoll(requestId));

  const tabsApi = {
    async get() {
      return {
        id: 42,
        active: true,
        discarded: false,
        url: 'https://aistudio.google.com/prompts/delivery-retry'
      };
    }
  };

  const scriptingApi = {
    async executeScript() {
      samplesInFlight += 1;
      maxSamplesInFlight = Math.max(maxSamplesInFlight, samplesInFlight);
      await sleep(25);
      sampleCalls += 1;
      samplesInFlight -= 1;
      return [{ result: {
        count: 2,
        userCount: 2,
        text: 'DELIVERY_RETRY_OK',
        generating: sampleCalls === 1,
        ready: true,
        promptMatched: true,
        lastUserText: 'retry prompt',
        modelAfterUserCount: 1
      } }];
    }
  };

  poll.startAiStudioResponsePoll({
    tabId: 42,
    requestId,
    baseline: { count: 1, userCount: 1, text: 'OLD' },
    expectedPrompt: 'retry prompt',
    send(event) {
      if (event.type !== 'response_final') return true;
      finalAttempts += 1;
      completionSeenBySend.push(poll.hasCompletedRequest(requestId));
      if (finalAttempts === 1) return false;
      finalEvents.push(event);
      return true;
    },
    tabsApi,
    scriptingApi,
    intervalMs: 5,
    timeoutMs: 3000
  });

  await waitFor(() => finalEvents.length === 1);

  assert.equal(finalAttempts, 2, 'the rejected final should be retried exactly once before acceptance');
  assert.deepEqual(completionSeenBySend, [false, false], 'completion dedupe must not be set before transport acceptance');
  assert.equal(maxSamplesInFlight, 1, 'retry ticks must stay bounded to one in-flight sample');
  assert.equal(finalEvents[0].type, 'response_final');
  assert.equal(finalEvents[0].text, 'DELIVERY_RETRY_OK');
  assert.equal(poll.hasCompletedRequest(requestId), true, 'accepted final should retire the request into completion dedupe');
});
