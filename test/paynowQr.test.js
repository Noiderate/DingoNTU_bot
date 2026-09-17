const test = require('node:test');
const assert = require('node:assert/strict');
const { buildPayNowPayload, generatePayNowQrPng, crc16 } = require('../src/services/paynowQr');

/** Decode a flat EMV QR TLV string into { id: value }, for asserting on fields
 * without hand-computing byte offsets in the test itself. */
function parseTlv(payload) {
  const fields = {};
  let i = 0;
  while (i < payload.length) {
    const id = payload.slice(i, i + 2);
    const len = Number(payload.slice(i + 2, i + 4));
    const value = payload.slice(i + 4, i + 4 + len);
    fields[id] = value;
    i += 4 + len;
  }
  return fields;
}

test('crc16 matches the standard CRC-16/CCITT-FALSE check value', () => {
  // The published check value for this exact variant (poly 0x1021, init
  // 0xFFFF, no reflection, xorout 0) over ASCII "123456789" is 0x29B1 - the
  // same variant the EMV QR spec requires for its trailing checksum field.
  assert.equal(crc16('123456789'), '29B1');
});

test('no payload is built without a UEN or mobile proxy', () => {
  assert.equal(buildPayNowPayload({ amountCents: 500 }), null);
});

test('payload encodes a locked, dynamic PayNow QR for a UEN, with a valid CRC', () => {
  const payload = buildPayNowPayload({
    uen: '201912345A',
    amountCents: 1250,
    merchantName: 'Dingo Cafe',
    reference: 'DG20260916-1',
  });

  const root = parseTlv(payload);
  assert.equal(root['00'], '01'); // payload format indicator
  assert.equal(root['01'], '12'); // dynamic point of initiation
  assert.equal(root['52'], '0000'); // merchant category code
  assert.equal(root['53'], '702'); // SGD
  assert.equal(root['54'], '12.50'); // amount
  assert.equal(root['58'], 'SG');
  assert.equal(root['59'], 'Dingo Cafe');
  assert.equal(root['60'], 'Singapore');

  const merchantInfo = parseTlv(root['26']);
  assert.equal(merchantInfo['00'], 'SG.PAYNOW');
  assert.equal(merchantInfo['01'], '2'); // proxy type: UEN
  assert.equal(merchantInfo['02'], '201912345A');
  assert.equal(merchantInfo['03'], '0'); // amount locked, not editable

  const additionalData = parseTlv(root['62']);
  assert.equal(additionalData['01'], 'DG20260916-1');

  // CRC is the last 4 characters, computed over everything up to and
  // including the "6304" tag/length that precedes it.
  const withoutCrc = payload.slice(0, -4);
  assert.match(withoutCrc, /6304$/);
  assert.equal(payload.slice(-4), crc16(withoutCrc));
});

test('a mobile proxy is used when no UEN is configured', () => {
  const payload = buildPayNowPayload({ mobile: '+6591234567', amountCents: 500 });
  const merchantInfo = parseTlv(parseTlv(payload)['26']);
  assert.equal(merchantInfo['01'], '0'); // proxy type: mobile
  assert.equal(merchantInfo['02'], '+6591234567');
});

test('a UEN is preferred over a mobile proxy when both are configured', () => {
  const payload = buildPayNowPayload({ uen: '201912345A', mobile: '+6591234567', amountCents: 500 });
  const merchantInfo = parseTlv(parseTlv(payload)['26']);
  assert.equal(merchantInfo['01'], '2');
  assert.equal(merchantInfo['02'], '201912345A');
});

test('the CRC changes when any preceding field changes', () => {
  const a = buildPayNowPayload({ uen: '201912345A', amountCents: 500 });
  const b = buildPayNowPayload({ uen: '201912345A', amountCents: 501 });
  assert.notEqual(a.slice(-4), b.slice(-4));
});

test('generatePayNowQrPng renders a PNG buffer when an identity is configured, null otherwise', async () => {
  const buffer = await generatePayNowQrPng({ uen: '201912345A', amountCents: 500, reference: 'DG1' });
  assert.ok(Buffer.isBuffer(buffer));
  assert.equal(buffer.slice(0, 8).toString('hex'), '89504e470d0a1a0a'); // PNG signature

  assert.equal(await generatePayNowQrPng({ amountCents: 500 }), null);
});
