const test = require('node:test');
const assert = require('node:assert/strict');
const repo = require('../src/services/orderRepository');
const { applyOutcome } = require('../src/services/paymentVerifier');
const { OUTCOMES } = require('../src/services/paymentRules');

/**
 * Regression coverage for a class of bug found alongside the claiming fix:
 * every non-auto-approved branch of applyOutcome edited the customer's
 * message and (for FLAGGED) forwarded a review card to admins UNCONDITIONALLY,
 * even when the transitionOrderStatus call right above it returned null -
 * meaning the order had already been resolved by something else (an admin,
 * or a concurrent run) between deciding the outcome and applying it. Only the
 * AUTO_APPROVED branch checked this. Telling a customer "we couldn't verify"
 * or "please finish the transfer" for an order that was already paid or
 * rejected is exactly the contradictory-message bug this fixes.
 */

const order = {
  id: 'order-1', code: 'DG1', chatId: 123, totalCents: 500, hallName: 'Hall 1',
};

const submission = { id: 'sub-1', processing_message_id: 999 };

function baseDecision(outcome, overrides = {}) {
  return {
    outcome,
    reasons: ['SOME_REASON'],
    normalized: { referenceNormalized: null, bankApp: null, ...overrides },
  };
}

function silentBot() {
  return {
    async editMessageText() { assert.fail('Must not edit the customer message once the transition was superseded'); },
    async sendMessage() { assert.fail('Must not message the customer once the transition was superseded'); },
    async sendPhoto() { assert.fail('Must not forward a review card once the transition was superseded'); },
  };
}

test('INCOMPLETE_TRANSFER does not notify the customer when the revert-to-awaiting transition is superseded', async t => {
  t.mock.method(repo, 'updatePaymentSubmission', async () => submission);
  t.mock.method(repo, 'transitionOrderStatus', async () => null);

  const result = await applyOutcome(silentBot(), {
    order, submission, patch: {}, decision: baseDecision(OUTCOMES.INCOMPLETE_TRANSFER),
  });

  assert.equal(result.outcome, OUTCOMES.INCOMPLETE_TRANSFER);
});

test('DUPLICATE_REJECTED does not notify the customer when the revert-to-awaiting transition is superseded', async t => {
  t.mock.method(repo, 'updatePaymentSubmission', async () => submission);
  t.mock.method(repo, 'transitionOrderStatus', async () => null);

  const result = await applyOutcome(silentBot(), {
    order, submission, patch: {}, decision: baseDecision(OUTCOMES.DUPLICATE_REJECTED),
  });

  assert.equal(result.outcome, OUTCOMES.DUPLICATE_REJECTED);
});

test('FLAGGED does not notify the customer or forward to admins when the flagging transition is superseded', async t => {
  t.mock.method(repo, 'updatePaymentSubmission', async () => submission);
  t.mock.method(repo, 'transitionOrderStatus', async () => null);

  const result = await applyOutcome(silentBot(), {
    order, submission, patch: {}, decision: baseDecision(OUTCOMES.FLAGGED),
  });

  assert.equal(result.outcome, OUTCOMES.FLAGGED);
});
