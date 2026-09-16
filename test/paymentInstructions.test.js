const test = require('node:test');
const assert = require('node:assert/strict');
const { config } = require('../src/config');
const stateStore = require('../src/services/stateStore');
const { sendPaymentInstructions, buildPaymentCaption } = require('../src/handlers/admin');

const order = {
  code: 'DG20260916-1', chatId: 123, hallName: 'Hall 1', totalCents: 500,
  items: [{ name: 'Rice', quantity: 1, lineTotalCents: 500 }],
};

test('payment image includes the order summary and requested PayNow wording, followed by an example screenshot', async t => {
  t.mock.method(stateStore, 'get', async () => 'cached-image');
  const photos = [];
  const bot = {
    async sendPhoto(...args) { photos.push(args); return {}; },
    async sendMessage() { assert.fail('Must not send a separate text message'); },
  };
  await sendPaymentInstructions(bot, order);
  assert.equal(photos.length, 2);
  assert.match(photos[0][2].caption, /Rice x1/);
  assert.match(photos[0][2].caption, /Please use PayNow to pay using the QR above\./);
  assert.match(photos[0][2].caption, /DG20260916-1/);
  assert.match(photos[1][2].caption, /Example of a valid screenshot/);
});

test('stale cached image retries the configured QR and example; cache write failure does not duplicate delivery', async t => {
  const previous = config.telegram.paymentInstructionImage;
  config.telegram.paymentInstructionImage = 'src/dingo_qr_code.png';
  t.after(() => { config.telegram.paymentInstructionImage = previous; });
  t.mock.method(stateStore, 'get', async () => 'stale-image');
  t.mock.method(stateStore, 'set', async () => { throw new Error('Cache unavailable'); });
  const sources = [];
  const bot = {
    async sendPhoto(chatId, source) {
      sources.push(source);
      if (source === 'stale-image') throw new Error('Invalid file ID');
      assert(require('fs').existsSync(source));
      return { photo: [{ file_id: 'fresh-image' }] };
    },
    async sendMessage() { assert.fail('Photo already delivered'); },
  };
  await sendPaymentInstructions(bot, order);
  // One stale + one fresh attempt for the QR, then the same pair for the example.
  assert.equal(sources.length, 4);
});

test('large orders fit a photo caption while keeping payment instructions and total', () => {
  const caption = buildPaymentCaption({ ...order, items: Array.from({ length: 100 }, () => order.items[0]) });
  assert(caption.length <= 1024);
  assert.match(caption, /Full order: \/orders/);
  assert.match(caption, /Amount due:.*5\.00/);
  assert.match(caption, /MUST INCLUDE DATE, TIME AND PAYMENT AMOUNT AND TO WHO/);
});
