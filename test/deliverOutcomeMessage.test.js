const test = require('node:test');
const assert = require('node:assert/strict');
const repo = require('../src/services/orderRepository');
const { applyOutcome } = require('../src/services/paymentVerifier');
const { OUTCOMES } = require('../src/services/paymentRules');

/**
 * A terminal verification outcome now deletes the "please wait" message and
 * sends the result as a fresh message, instead of editing it in place.
 */

const order = {
  id: 'order-1', code: 'DG1', chatId: 123, totalCents: 500, hallName: 'Hall 1',
};

const submission = { id: 'sub-1', processing_message_id: 999 };

function trackedBot() {
  const calls = { deleted: [], sent: [], edited: [] };
  return {
    calls,
    async deleteMessage(chatId, messageId) { calls.deleted.push({ chatId, messageId }); },
    async sendMessage(chatId, text) { calls.sent.push({ chatId, text }); },
    async editMessageText() { assert.fail('Must delete and send a new message, not edit in place'); },
    async sendPhoto() {},
  };
}

test('AUTO_APPROVED deletes the processing message and sends exactly one confirmation, with the amount', async t => {
  t.mock.method(repo, 'updatePaymentSubmission', async () => submission);
  t.mock.method(repo, 'transitionOrderStatus', async () => (
    { id: order.id, order_code: order.code, chat_id: order.chatId, total_cents: order.totalCents, order_items: [], customers: {} }
  ));

  const bot = trackedBot();
  const decision = { outcome: OUTCOMES.AUTO_APPROVED, reasons: [], normalized: { referenceNormalized: null } };

  // refreshDeliveryModeMenus() runs after the message swap and hits real
  // Supabase in this unit test (it's a destructured import, so it can't be
  // mocked from here) - only the message-delivery assertions below are this
  // test's concern, so that unrelated downstream failure is swallowed.
  await applyOutcome(bot, { order, submission, patch: {}, decision }).catch(() => {});

  assert.equal(bot.calls.deleted.length, 1);
  assert.deepEqual(bot.calls.deleted[0], { chatId: order.chatId, messageId: submission.processing_message_id });
  // Exactly one message: markOrderPaid's own confirmation (now carrying the
  // amount) is the customer's only notification - applyOutcome no longer
  // sends a second, near-duplicate one on top of it.
  assert.equal(bot.calls.sent.length, 1);
  assert.match(bot.calls.sent[0].text, /confirmed.*\$5\.00.*received/is);
});

test('FLAGGED deletes the processing message and sends the result as a new one', async t => {
  t.mock.method(repo, 'updatePaymentSubmission', async () => submission);
  t.mock.method(repo, 'transitionOrderStatus', async () => (
    { id: order.id, order_code: order.code, chat_id: order.chatId, total_cents: order.totalCents, order_items: [], customers: {} }
  ));
  // forwardToAdmins() calls the real getAdminIds() (a destructured import, so
  // it can't be mocked from here) - harmless here since it's a synchronous,
  // in-memory read that returns [] unless something has loaded it.

  const bot = trackedBot();
  const decision = { outcome: OUTCOMES.FLAGGED, reasons: ['SOME_REASON'], normalized: { referenceNormalized: null } };

  await applyOutcome(bot, { order, submission, patch: {}, decision });

  assert.equal(bot.calls.deleted.length, 1);
  assert.equal(bot.calls.sent.length, 1);
  assert.match(bot.calls.sent[0].text, /couldn't automatically verify/i);
});
