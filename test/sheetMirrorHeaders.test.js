const test = require('node:test');
const assert = require('node:assert/strict');

// sheetMirror destructures these helpers at load time, so they are replaced on
// the module before it is first required.
const googleSheets = require('../src/services/googleSheets');

const sheet = { header: [], reads: 0, writes: [], readFails: false, writeOk: true };

googleSheets.readFromSheetOrThrow = async () => {
  sheet.reads += 1;
  if (sheet.readFails) {
    throw new Error('429 quota');
  }
  return [sheet.header];
};
googleSheets.writeToSheet = async (range, values) => {
  sheet.writes.push({ range, values });
  return sheet.writeOk;
};

const { ensureHeaders, resetHeadersCheck, HEADERS } = require('../src/services/sheetMirror');

/**
 * ensureHeaders ran before every order write and cost a Sheets read each time.
 * It now checks once per TTL - without ever writing default headers over a real
 * header row just because a read failed.
 */

test.beforeEach(() => {
  resetHeadersCheck();
  Object.assign(sheet, { header: HEADERS.slice(), reads: 0, writes: [], readFails: false, writeOk: true });
});

test('a complete header row is read once, then not again within the TTL', async () => {
  await ensureHeaders();
  await ensureHeaders();
  await ensureHeaders();

  assert.equal(sheet.reads, 1);
  assert.deepEqual(sheet.writes, []);
});

test('an empty sheet gets the full header row written', async () => {
  sheet.header = [];

  await ensureHeaders();

  assert.equal(sheet.writes.length, 1);
  assert.equal(sheet.writes[0].range, 'Orders!A1:R1');
  assert.deepEqual(sheet.writes[0].values, [HEADERS]);
});

test('an older 11-column sheet only gets the new right-hand columns', async () => {
  sheet.header = HEADERS.slice(0, 11);

  await ensureHeaders();

  assert.equal(sheet.writes.length, 1);
  assert.equal(sheet.writes[0].range, 'Orders!L1:R1');
  assert.deepEqual(sheet.writes[0].values, [HEADERS.slice(11)]);
});

test('a failed read throws and writes nothing, so a real header row is never overwritten', async () => {
  sheet.readFails = true;

  await assert.rejects(ensureHeaders(), /429/);

  assert.deepEqual(sheet.writes, []);
});

test('a failed read is not cached: the next call tries again', async () => {
  sheet.readFails = true;
  await assert.rejects(ensureHeaders());

  sheet.readFails = false;
  await ensureHeaders();

  assert.equal(sheet.reads, 2);
});

test('a failed header write is not cached: the next call tries again', async () => {
  sheet.header = [];
  sheet.writeOk = false;
  await ensureHeaders();

  sheet.writeOk = true;
  await ensureHeaders();

  assert.equal(sheet.writes.length, 2);
});
