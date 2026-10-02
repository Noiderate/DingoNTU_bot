const test = require('node:test');
const assert = require('node:assert/strict');
const { config } = require('../src/config');
const stateStore = require('../src/services/stateStore');
const { sendPaymentInstructions, buildPaymentCaption } = require('../src/handlers/admin');

const order = {
  code: 'DG20260916-1', chatId: 123, hallName: 'Hall 1', totalCents: 500,
  items: [{ name: 'Rice', quantity: 1, lineTotalCents: 500 }],
};

test('the QR and the example screenshot ship together as one swipeable gallery', async t => {
  t.mock.method(stateStore, 'get', async () => 'cached-image');
  const groups = [];
  const bot = {
    async sendMediaGroup(chatId, media) { groups.push({ chatId, media }); return [{}, {}]; },
    async sendPhoto() { assert.fail('Must send one gallery, not separate photos'); },
    async sendMessage() { assert.fail('Must not send a separate text message'); },
  };
  await sendPaymentInstructions(bot, order);

  assert.equal(groups.length, 1);
  const { chatId, media } = groups[0];
  assert.equal(chatId, order.chatId);
  assert.equal(media.length, 2);
  assert.equal(media[0].media, 'cached-image');
  assert.match(media[0].caption, /Rice x1/);
  assert.match(media[0].caption, /Pay with the PayNow QR above/);
  assert.match(media[0].caption, /DG20260916-1/);
  assert.match(media[0].caption, /swipe for example/);
  // Telegram only renders an album's caption when exactly one item carries
  // one - a second caption here would silently blank out the whole thing.
  assert.equal(media[1].caption, undefined);
});

test('a stale cached QR retries the configured static image, still as one gallery', async t => {
  const previous = config.telegram.paymentInstructionImage;
  config.telegram.paymentInstructionImage = 'src/dingo_qr_code.png';
  t.after(() => { config.telegram.paymentInstructionImage = previous; });
  // Only the QR's own cache is stale - keep the example cache empty so this
  // test isn't also exercising the example's own retry-on-stale-cache path.
  t.mock.method(stateStore, 'get', async key => (key === stateStore.KEYS.paymentImageFileId() ? 'stale-image' : null));
  t.mock.method(stateStore, 'set', async () => { throw new Error('Cache unavailable'); });

  const attempts = [];
  const bot = {
    async sendMediaGroup(chatId, media) {
      attempts.push(media[0].media);
      if (media[0].media === 'stale-image') throw new Error('Invalid file ID');
      assert(require('fs').existsSync(media[0].media));
      return [{ photo: [{ file_id: 'fresh-qr' }] }, { photo: [{ file_id: 'fresh-example' }] }];
    },
    async sendPhoto() { assert.fail('Must send one gallery, not separate photos'); },
    async sendMessage() { assert.fail('Photo already delivered'); },
  };

  await sendPaymentInstructions(bot, order);
  // One failed attempt with the stale cached source, one successful attempt
  // with the configured static image.
  assert.equal(attempts.length, 2);
});

test('a stale cached example is retried with a fresh upload before giving up on the QR', async t => {
  const previousUen = config.payment.uen;
  config.payment.uen = 'T12LL1234K';
  t.after(() => { config.payment.uen = previousUen; });
  // Every stateStore.get call returns this - it stands in for a stale cached
  // example file_id (the QR itself is never cached, so this only affects the
  // example lookup in practice).
  t.mock.method(stateStore, 'get', async () => 'stale-example');
  const setCalls = [];
  t.mock.method(stateStore, 'set', async (key, value) => { setCalls.push({ key, value }); });

  const attempts = [];
  const bot = {
    async sendMediaGroup(chatId, media) {
      attempts.push(media[1].media);
      if (media[1].media === 'stale-example') throw new Error('Invalid file ID');
      assert(require('fs').existsSync(media[1].media));
      return [{}, { photo: [{ file_id: 'fresh-example' }] }];
    },
    async sendPhoto() { assert.fail('Must send one gallery, not separate photos'); },
    async sendMessage() { assert.fail('Must not send a separate text message'); },
  };

  await sendPaymentInstructions(bot, order);

  assert.equal(attempts.length, 2); // stale example, then a fresh upload of the same QR
  assert.ok(setCalls.some(({ value }) => value === 'fresh-example'));
});

test('when a PayNow UEN is configured, the QR and example ship together as one album', async t => {
  const previousUen = config.payment.uen;
  config.payment.uen = 'T12LL1234K';
  t.after(() => { config.payment.uen = previousUen; });
  t.mock.method(stateStore, 'get', async () => null);
  t.mock.method(stateStore, 'set', async () => {});

  const groups = [];
  const bot = {
    async sendMediaGroup(...args) {
      groups.push(args);
      return [{ photo: [{ file_id: 'qr' }] }, { photo: [{ file_id: 'example' }] }];
    },
    async sendPhoto() { assert.fail('Must not fall back to individual photos'); },
    async sendMessage() { assert.fail('Must not send a separate text message'); },
  };

  await sendPaymentInstructions(bot, order);

  assert.equal(groups.length, 1);
  const [chatId, media] = groups[0];
  assert.equal(chatId, order.chatId);
  assert.equal(media.length, 2);
  assert.ok(Buffer.isBuffer(media[0].media));
  assert.match(media[0].caption, /Pay with the PayNow QR above/);
  assert.equal(media[1].caption, undefined);
});

test('a broken example never costs the customer their QR: falls back to a lone photo plus a best-effort example', async t => {
  const previousUen = config.payment.uen;
  config.payment.uen = 'T12LL1234K';
  t.after(() => { config.payment.uen = previousUen; });
  t.mock.method(stateStore, 'get', async () => null);
  t.mock.method(stateStore, 'set', async () => {});

  const photos = [];
  const bot = {
    async sendMediaGroup() { throw new Error('Telegram rejected the album'); },
    async sendPhoto(...args) { photos.push(args); return {}; },
    async sendMessage() { assert.fail('Must not send a separate text message'); },
  };

  await sendPaymentInstructions(bot, order);

  // The QR goes out on its own first, then the example is attempted
  // separately and best-effort.
  assert.equal(photos.length, 2);
  assert.ok(Buffer.isBuffer(photos[0][1]));
  assert.match(photos[0][2].caption, /Pay with the PayNow QR above/);
  assert.match(photos[1][2].caption, /Example of a valid screenshot/);
});

test('large orders fit a photo caption while keeping payment instructions and total', () => {
  const caption = buildPaymentCaption({ ...order, items: Array.from({ length: 100 }, () => order.items[0]) });
  assert(caption.length <= 1024);
  assert.match(caption, /Full order: \/orders/);
  assert.match(caption, /Total: .*5.00/);
  assert.match(caption, /UNCROPPED screenshot showing date, time, amount and recipient/);
});
