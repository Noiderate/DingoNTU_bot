const test = require('node:test');
const assert = require('node:assert/strict');
const sharp = require('sharp');
const { shrinkForStorage, MAX_SIDE_PX } = require('../src/utils/receiptImage');

// A noisy phone-sized screenshot: big enough that shrinking must help.
async function bigPng() {
  const width = 1290;
  const height = 2796;
  const raw = Buffer.alloc(width * height * 3);
  require('node:crypto').randomFillSync(raw);
  return sharp(raw, { raw: { width, height, channels: 3 } }).png().toBuffer();
}

test('shrinkForStorage makes a large PNG smaller, capped on the longest side', async () => {
  const original = await bigPng();
  const result = await shrinkForStorage(original);

  assert.ok(result, 'expected a shrunk copy');
  assert.equal(result.mimeType, 'image/jpeg');
  assert.equal(result.extension, 'jpg');
  assert.ok(result.buffer.length < original.length);

  const meta = await sharp(result.buffer).metadata();
  assert.equal(meta.format, 'jpeg');
  assert.equal(Math.max(meta.width, meta.height), MAX_SIDE_PX);
});

test('shrinkForStorage returns null (keep the original) for data it cannot decode', async () => {
  assert.equal(await shrinkForStorage(Buffer.from('not an image')), null);
});

test('shrinkForStorage returns null when shrinking would not save space', async () => {
  const tiny = await sharp({ create: { width: 10, height: 10, channels: 3, background: '#fff' } })
    .jpeg({ quality: 40 }).toBuffer();
  assert.equal(await shrinkForStorage(tiny), null);
});

