const test = require('node:test');
const assert = require('node:assert/strict');
const repo = require('../src/services/orderRepository');
const { applyOutcome, MESSAGES } = require('../src/services/paymentVerifier');
const { OUTCOMES } = require('../src/services/paymentRules');
const { config } = require('../src/config');

/**
 * Being told "that's an unfinished transfer, finish it and resend" restarts
 * the payment deadline by PAYMENT_WINDOW_MINUTES. Leaving the original
 * deadline alone meant finishing the transfer routinely landed after it and
 * expired an order that was actually being paid.
 */

const order = { id: 'order-1', code: 'DG1', chatId: 123, totalCents: 500, hallName: 'Hall 1' };
const submission = { id: 'sub-1', processing_message_id: 999 };
const decision = {
  outcome: OUTCOMES.INCOMPLETE_TRANSFER,
  reasons: ['INCOMPLETE_TRANSFER'],
  normalized: { referenceNormalized: null, bankApp: null },
};

function captureBot() {
  const messages = [];
  return {
    messages,
    async deleteMessage() {},
    async sendMessage(chatId, text) { messages.push(text); },
  };
}

test('an unfinished-transfer screenshot restarts the payment window from now', async t => {
  t.mock.method(repo, 'updatePaymentSubmission', async () => submission);

  let transition;
  t.mock.method(repo, 'transitionOrderStatus', async (id, from, to, actor, reason, options) => {
    transition = { from, to, options };
    return { id, status: to };
  });

  const before = Date.now();
  await applyOutcome(captureBot(), { order, submission, patch: {}, decision });
  const after = Date.now();

  const dueAt = Date.parse(transition.options.patch.payment_due_at);
  const windowMs = config.payment.windowMinutes * 60 * 1000;
  assert.equal(transition.to, repo.STATUS.AWAITING_PAYMENT);
  assert.ok(dueAt >= before + windowMs && dueAt <= after + windowMs, 'deadline should be one window from now');
});

test('the customer is told how long they now have', async t => {
  t.mock.method(repo, 'updatePaymentSubmission', async () => submission);
  t.mock.method(repo, 'transitionOrderStatus', async (id, from, to) => ({ id, status: to }));
  const original = config.payment.expiryEnabled;
  config.payment.expiryEnabled = true;
  t.after(() => { config.payment.expiryEnabled = original; });

  const bot = captureBot();
  await applyOutcome(bot, { order, submission, patch: {}, decision });

  assert.equal(bot.messages.length, 1);
  assert.ok(bot.messages[0].startsWith(MESSAGES.INCOMPLETE));
  assert.match(bot.messages[0], new RegExp(`${config.payment.windowMinutes} more minute`));
});
