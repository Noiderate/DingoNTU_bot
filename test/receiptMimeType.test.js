const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const { detectImageMimeType } = require('../src/services/paymentVerifier');

/**
 * Receipts sent as files are often PNG screenshots; they used to be labelled
 * JPEG for the model and storage regardless.
 */

test('a PNG receipt is recognised as PNG', () => {
  const png = fs.readFileSync(path.join(__dirname, '..', 'src', 'payment_example.png'));
  assert.equal(detectImageMimeType(png), 'image/png');
});

test('a JPEG receipt is recognised as JPEG', () => {
  const jpeg = fs.readFileSync(path.join(__dirname, '..', 'src', 'Payment_Instruction.jpg'));
  assert.equal(detectImageMimeType(jpeg), 'image/jpeg');
});

test('a WebP receipt is recognised as WebP', () => {
  const webp = Buffer.concat([Buffer.from('RIFF'), Buffer.alloc(4), Buffer.from('WEBPVP8 ')]);
  assert.equal(detectImageMimeType(webp), 'image/webp');
});

test('anything unrecognised falls back to JPEG, what Telegram photos always are', () => {
  assert.equal(detectImageMimeType(Buffer.from('nonsense')), 'image/jpeg');
  assert.equal(detectImageMimeType(null), 'image/jpeg');
});
