const test = require('node:test');
const assert = require('node:assert/strict');
const stateStore = require('../src/services/stateStore');
const orderStore = require('../src/services/orderStore');
const repo = require('../src/services/orderRepository');
const { handleResetPrompt, handleResetConfirm } = require('../src/handlers/admin');

/**
 * "Reset Halls and Orders" closes every active order and rewrites stock, so a
 * leftover button from an earlier night must not be able to run it, and a
 * single stray tap must never be enough.
 */

const { STATUS } = repo;

function captureAnswer() {
  const answers = [];
  const answer = async (text, options) => { answers.push({ text, options }); };
  return { answers, answer };
}

function captureBot() {
  const deleted = [];
  const edits = [];
  return {
    deleted,
    edits,
    async deleteMessage(chatId, messageId) { deleted.push(messageId); },
    async editMessageText(text, opts) { edits.push({ text, opts }); },
  };
}

test('an outdated reset button is refused and removed', async t => {
  t.mock.method(stateStore, 'get', async () => 'current-token');
  t.mock.method(orderStore, 'getActiveOrders', async () => {
    throw new Error('must not start a reset from an outdated button');
  });

  const bot = captureBot();
  const { answers, answer } = captureAnswer();

  await handleResetPrompt(bot, 555, 99, 'old-token', answer);

  assert.match(answers[0].text, /outdated/);
  assert.deepEqual(bot.deleted, [99]);
});

test('a reset button with no token (sent before tokens existed) is refused', async t => {
  t.mock.method(stateStore, 'get', async () => 'current-token');

  const bot = captureBot();
  const { answers, answer } = captureAnswer();

  await handleResetPrompt(bot, 555, 99, '', answer);

  assert.match(answers[0].text, /outdated/);
});

test('the first tap only asks for confirmation, spelling out what will happen', async t => {
  t.mock.method(stateStore, 'get', async () => 'tok');
  t.mock.method(orderStore, 'getActiveOrders', async () => [
    { status: STATUS.AWAITING_PAYMENT },
    { status: STATUS.PAID },
    { status: STATUS.PAYMENT_FLAGGED },
  ]);

  const bot = captureBot();
  const { answer } = captureAnswer();

  await handleResetPrompt(bot, 555, 99, 'tok', answer);

  assert.equal(bot.deleted.length, 0);
  assert.equal(bot.edits.length, 1);
  assert.match(bot.edits[0].text, /close 1 unpaid/);
  assert.match(bot.edits[0].text, /1 paid but unserved/);
  assert.match(bot.edits[0].text, /1 order\(s\) with a payment awaiting review will be left open/);
  const buttons = bot.edits[0].opts.reply_markup.inline_keyboard[0].map(button => button.callback_data);
  assert.deepEqual(buttons, ['dm_reset_yes:tok', 'dm_reset_no:tok']);
});

test('confirming with a token that was already used is refused', async t => {
  t.mock.method(stateStore, 'acquireLock', async () => 'holder');
  t.mock.method(stateStore, 'releaseLock', async () => true);
  t.mock.method(stateStore, 'get', async () => null); // consumed by the first reset
  t.mock.method(orderStore, 'getActiveOrders', async () => {
    throw new Error('must not reset twice');
  });

  const bot = captureBot();
  const { answers, answer } = captureAnswer();

  await handleResetConfirm(bot, 555, 99, 'tok', answer);

  assert.match(answers[0].text, /outdated/);
});

test('a second confirm while a reset is running does nothing', async t => {
  t.mock.method(stateStore, 'acquireLock', async () => null);
  t.mock.method(stateStore, 'get', async () => {
    throw new Error('must not even check the token');
  });

  const bot = captureBot();
  const { answers, answer } = captureAnswer();

  await handleResetConfirm(bot, 555, 99, 'tok', answer);

  assert.match(answers[0].text, /already running/);
});
