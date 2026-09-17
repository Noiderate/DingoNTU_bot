const test = require('node:test');
const assert = require('node:assert/strict');
const repo = require('../src/services/orderRepository');
const orderStore = require('../src/services/orderStore');
const orderActions = require('../src/services/orderActions');

/**
 * Coverage for letting staff serve an order before payment clears (see the
 * comment in orderStore.markOrderServed), and for reconciling its payment
 * afterwards - both of which required ALLOWED_TRANSITIONS entries that were
 * missing, which is why markOrderServed used to throw for any non-paid order
 * despite its own comment saying otherwise.
 */

const { STATUS } = repo;

test('an unpaid order can transition straight to served, in every unpaid active status', () => {
  for (const from of [STATUS.AWAITING_PAYMENT, STATUS.VERIFYING_PAYMENT, STATUS.PAYMENT_FLAGGED]) {
    assert.ok(
      repo.ALLOWED_TRANSITIONS[from].includes(STATUS.SERVED),
      `expected ${from} -> served to be allowed`
    );
  }
});

test('a served order can still be reconciled as paid, but never restocked via reject', () => {
  assert.deepEqual(repo.ALLOWED_TRANSITIONS[STATUS.SERVED], [STATUS.PAID]);
});

test('markOrderServed reports whether the order was still unpaid at serve time', async t => {
  t.mock.method(repo, 'getOrderById', async () => ({ id: 'o1', status: STATUS.AWAITING_PAYMENT }));
  t.mock.method(repo, 'transitionOrderStatus', async (id, from, to) => {
    assert.equal(from, STATUS.AWAITING_PAYMENT);
    assert.equal(to, STATUS.SERVED);
    return { id: 'o1', status: STATUS.SERVED, order_items: [], customers: {} };
  });

  const served = await orderStore.markOrderServed('o1', 999);

  assert.equal(served.wasUnpaid, true);
});

test('markOrderServed reports paid orders as not unpaid', async t => {
  t.mock.method(repo, 'getOrderById', async () => ({ id: 'o2', status: STATUS.PAID }));
  t.mock.method(repo, 'transitionOrderStatus', async () => (
    { id: 'o2', status: STATUS.SERVED, order_items: [], customers: {} }
  ));

  const served = await orderStore.markOrderServed('o2', 999);

  assert.equal(served.wasUnpaid, false);
});

test('markOrderServed returns null, not a partial result, when the transition is superseded', async t => {
  t.mock.method(repo, 'getOrderById', async () => ({ id: 'o3', status: STATUS.AWAITING_PAYMENT }));
  t.mock.method(repo, 'transitionOrderStatus', async () => null);

  assert.equal(await orderStore.markOrderServed('o3', 999), null);
});

test('reconciling a served order tells the customer payment is confirmed, not "being prepared"', async t => {
  t.mock.method(repo, 'transitionOrderStatus', async () => (
    { id: 'o4', order_code: 'DG1', chat_id: 555, total_cents: 500, order_items: [], customers: {} }
  ));

  const messages = [];
  const bot = { async sendMessage(chatId, text) { messages.push({ chatId, text }); } };

  await orderActions.markOrderPaid(bot, { id: 'o4' }, {
    fromStatus: STATUS.SERVED, actor: 'admin', actorTelegramId: 1, reason: 'test',
  });

  assert.equal(messages.length, 1);
  assert.match(messages[0].text, /confirmed/i);
  assert.doesNotMatch(messages[0].text, /being prepared/i);
});

test('accepting payment for a still-in-flight order keeps the normal "being prepared" message', async t => {
  t.mock.method(repo, 'transitionOrderStatus', async () => (
    { id: 'o5', order_code: 'DG2', chat_id: 555, total_cents: 500, order_items: [], customers: {} }
  ));

  const messages = [];
  const bot = { async sendMessage(chatId, text) { messages.push({ chatId, text }); } };

  await orderActions.markOrderPaid(bot, { id: 'o5' }, {
    fromStatus: STATUS.VERIFYING_PAYMENT, actor: 'ai_verifier', actorTelegramId: null, reason: 'test',
  });

  assert.match(messages[0].text, /being prepared/i);
});
