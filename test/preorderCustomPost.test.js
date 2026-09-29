const test = require('node:test');
const assert = require('node:assert/strict');
const googleSheets = require('../src/services/googleSheets');
const menuStore = require('../src/services/menuStore');
const stateStore = require('../src/services/stateStore');
const orderStore = require('../src/services/orderStore');
const admin = require('../src/handlers/admin');

/**
 * Settings > Edit Dingo Post: an admin-set first line (replacing "Preorders
 * available for X onwards") and an optional photo, the post then being that
 * photo with the text as its caption. Nothing custom = the default post.
 */

const LIVE_TEXT_POST = { channelId: 'chan1', msgId: 111, photoFileId: null, contentHash: 'old' };

function mockPost(t, { custom = null, post = LIVE_TEXT_POST, foodItems = [{ id: 2, name: 'Chicken Rice', stock: 3 }] } = {}) {
  const stored = [];
  t.mock.method(stateStore, 'get', async (key, fallback = null) => {
    if (key === stateStore.KEYS.preorderPost()) return post;
    if (key === stateStore.KEYS.preorderCustom()) return custom;
    return fallback;
  });
  t.mock.method(stateStore, 'set', async (key, value) => { stored.push({ key, value }); });
  t.mock.method(googleSheets, 'getHallsOrThrow', async () => [{ id: 2, name: 'Hall Twelve', shortName: 'H12' }]);
  t.mock.method(menuStore, 'getFoodItemsOrThrow', async () => foodItems);
  t.mock.method(googleSheets, 'getPreorderAdminTag', async () => null);
  t.mock.method(orderStore, 'loadBlockedHalls', async () => ({ isBlocked: () => false }));
  return stored;
}

test('with nothing custom, the intro is the usual default line', () => {
  assert.equal(admin.buildPreorderIntro('H12', null), 'Preorders available for H12 onwards');
});

test('custom text replaces the intro, fills in {hall}, and is HTML-escaped', () => {
  assert.equal(
    admin.buildPreorderIntro('H12', 'Supper <open> for {hall} & {HALL}!'),
    'Supper &lt;open&gt; for H12 &amp; H12!'
  );
});

test('a photo caption drops food lines from the end to stay within 1024 characters', async t => {
  const foodItems = Array.from({ length: 80 }, (_, index) => ({ id: index + 2, name: `Menu item number ${index}`, stock: 1 }));
  t.mock.method(menuStore, 'getFoodItemsOrThrow', async () => foodItems);

  const text = await admin.buildPreorderMessageText('H12', null, { maxLength: 1024 });

  assert.ok(text.length <= 1024, `caption is ${text.length} characters`);
  assert.match(text, /…and \d+ more/);
  assert.match(text, /Click below to start ordering/);
});

test('custom text reaches the live post through the normal silent edit', async t => {
  mockPost(t, { custom: { text: 'Late night supper at {hall}!', photoFileId: null } });

  const edits = [];
  const bot = {
    async editMessageText(text, opts) { edits.push({ text, opts }); },
    async sendPhoto() { throw new Error('no photo set - must not repost'); },
  };

  const result = await admin.refreshPreorderPost(bot);

  assert.deepEqual(result, { refreshed: true });
  assert.match(edits[0].text, /^Late night supper at H12!/);
  assert.match(edits[0].text, /Chicken Rice/);
});

test('attaching a photo replaces the text post with a photo post, caption = the post text', async t => {
  const stored = mockPost(t, { custom: { text: null, photoFileId: 'photo-1' } });

  const photos = [];
  const deleted = [];
  const bot = {
    async editMessageText() { throw new Error('a text post cannot become a photo by editing'); },
    async sendPhoto(chatId, fileId, opts) { photos.push({ chatId, fileId, opts }); return { message_id: 222 }; },
    async deleteMessage(chatId, msgId) { deleted.push(msgId); },
  };

  const result = await admin.refreshPreorderPost(bot);

  assert.deepEqual(result, { reposted: true });
  assert.equal(photos[0].chatId, 'chan1');
  assert.equal(photos[0].fileId, 'photo-1');
  assert.match(photos[0].opts.caption, /^Preorders available for H12 onwards/);
  assert.deepEqual(deleted, [111]);

  const recorded = stored.find(entry => entry.key === stateStore.KEYS.preorderPost());
  assert.equal(recorded.value.msgId, 222);
  assert.equal(recorded.value.photoFileId, 'photo-1');
});

test('a live photo post with the same photo is updated by editing its caption', async t => {
  mockPost(t, {
    custom: { text: 'New line', photoFileId: 'photo-1' },
    post: { channelId: 'chan1', msgId: 111, photoFileId: 'photo-1', contentHash: 'old' },
  });

  const captions = [];
  const bot = {
    async editMessageCaption(caption, opts) { captions.push({ caption, opts }); },
    async editMessageText() { throw new Error('a photo post has a caption, not text'); },
  };

  await admin.refreshPreorderPost(bot);

  assert.match(captions[0].caption, /^New line/);
  assert.equal(captions[0].opts.message_id, 111);
});

test('removing the photo turns the live post back into a text post', async t => {
  mockPost(t, {
    custom: { text: null, photoFileId: null },
    post: { channelId: 'chan1', msgId: 111, photoFileId: 'photo-1', contentHash: 'old' },
  });

  const sent = [];
  const bot = {
    async sendMessage(chatId, text) { sent.push(text); return { message_id: 333 }; },
    async deleteMessage() {},
  };

  const result = await admin.refreshPreorderPost(bot);

  assert.deepEqual(result, { reposted: true });
  assert.match(sent[0], /^Preorders available for H12 onwards/);
});

test('a non-admin photo is never taken as the preorder photo', async t => {
  t.mock.method(stateStore, 'get', async () => {
    throw new Error('must not even look up admin state for a non-admin');
  });

  const handled = await admin.handleAdminPreorderPhoto({}, {
    from: { id: 123456789 }, chat: { id: 1 }, photo: [{ file_id: 'x' }],
  });

  assert.equal(handled, false);
});
