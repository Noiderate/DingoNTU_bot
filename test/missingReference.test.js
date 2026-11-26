const test = require('node:test');
const assert = require('node:assert/strict');
const repo = require('../src/services/orderRepository');
const googleSheets = require('../src/services/googleSheets');
const { applyOutcome, MESSAGES } = require('../src/services/paymentVerifier');
const { OUTCOMES, REASONS } = require('../src/services/paymentRules');
const { config } = require('../src/config');

/**
 * A receipt where the only problem is that no reference number is visible is
 * handed back to the customer to resend - like a repeat screenshot - instead
 * of being forwarded to the admins. The order goes back to awaiting payment
 * with its deadline restarted, since they have usually already paid.
 */

const order = { id: 'order-1', code: 'DG1', chatId: 123, totalCents: 500, hallName: 'Hall 1' };
const submission = { id: 'sub-1', processing_message_id: 999 };
const decision = {
  outcome: OUTCOMES.MISSING_REFERENCE,
  reasons: [REASONS.MISSING_REFERENCE],
  normalized: { referenceNormalized: null, bankApp: null },
};

function captureBot() {
  const messages = [];
  const photos = [];
  return {
    messages,
    photos,
    async deleteMessage() {},
    async sendMessage(chatId, text) { messages.push({ chatId, text }); return { message_id: 1 }; },
    async sendPhoto(chatId) { photos.push(chatId); return { message_id: 2 }; },
  };
}

test('the customer is asked to resend with the reference, and no admin is bothered', async t => {
  t.mock.method(repo, 'updatePaymentSubmission', async () => submission);
  t.mock.method(googleSheets, 'getAdminIds', () => [900]);

  let transition;
  t.mock.method(repo, 'transitionOrderStatus', async (id, from, to, actor, reason, options) => {
    transition = { from, to, options };
    return { id, status: to };
  });

  const bot = captureBot();
  const before = Date.now();
  const result = await applyOutcome(bot, { order, submission, patch: {}, decision });

  assert.equal(result.outcome, OUTCOMES.MISSING_REFERENCE);
  assert.equal(transition.from, repo.STATUS.VERIFYING_PAYMENT);
  assert.equal(transition.to, repo.STATUS.AWAITING_PAYMENT);
  assert.ok(Date.parse(transition.options.patch.payment_due_at) >= before + config.payment.windowMinutes * 60 * 1000);

  assert.equal(bot.messages.length, 1);
  assert.equal(bot.messages[0].chatId, 123);
  assert.ok(bot.messages[0].text.startsWith(MESSAGES.MISSING_REFERENCE));
  assert.ok(!bot.messages.some(m => m.chatId === 900));
  assert.equal(bot.photos.length, 0);
});

test('on the last hand-back, the customer is told a resend without one goes to an admin', async t => {
  t.mock.method(repo, 'updatePaymentSubmission', async () => submission);
  t.mock.method(repo, 'transitionOrderStatus', async (id, from, to) => ({ id, status: to }));
  const original = config.payment.maxMissingReferenceAttempts;
  t.after(() => { config.payment.maxMissingReferenceAttempts = original; });

  // Default (2): the first hand-back is already the last one.
  config.payment.maxMissingReferenceAttempts = 2;
  let bot = captureBot();
  await applyOutcome(bot, { order, submission, patch: {}, decision, missingReferenceAttempts: 0 });
  assert.ok(bot.messages[0].text.includes(MESSAGES.MISSING_REFERENCE_LAST_TRY));

  // With 3 allowed, the first hand-back still expects a proper resend.
  config.payment.maxMissingReferenceAttempts = 3;
  bot = captureBot();
  await applyOutcome(bot, { order, submission, patch: {}, decision, missingReferenceAttempts: 0 });
  assert.ok(!bot.messages[0].text.includes(MESSAGES.MISSING_REFERENCE_LAST_TRY));
});

test('nothing is sent if the order was already resolved elsewhere', async t => {
  t.mock.method(repo, 'updatePaymentSubmission', async () => submission);
  t.mock.method(repo, 'transitionOrderStatus', async () => null);

  const bot = captureBot();
  await applyOutcome(bot, { order, submission, patch: {}, decision });
  assert.equal(bot.messages.length, 0);
});
