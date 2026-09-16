const test = require('node:test');
const assert = require('node:assert/strict');

const {
  formatSgt,
  formatSgtFriendly,
  sgtDateTimeToUtc,
  parseReceiptDateTime,
  truncateToMinute,
  sgtDateParts,
} = require('../src/utils/time');

// 14:05 Singapore time is 06:05 UTC.
const UTC_INSTANT = '2026-09-16T06:05:00.000Z';

test('structured date and time fields are read as Singapore local time', () => {
  assert.equal(sgtDateTimeToUtc('2026-09-16', '14:05').toISOString(), UTC_INSTANT);
  assert.equal(sgtDateTimeToUtc('2026-09-16', '14:05:00').toISOString(), UTC_INSTANT);
});

test('a date with no time cannot be placed on the clock', () => {
  // Assuming midnight would let a receipt from any time that day pass a
  // minutes-wide window, so this must stay null and flag for review.
  assert.equal(sgtDateTimeToUtc('2026-09-16', null), null);
  assert.equal(sgtDateTimeToUtc('2026-09-16', ''), null);
  assert.equal(sgtDateTimeToUtc(null, '14:05'), null);
});

test('receipt timestamp text parses in the formats banks print', () => {
  const cases = [
    '16 Sep 2026, 2:05 PM',
    '16 Sep 2026 2:05 PM',
    '16 Sep 2026, 14:05',
    '16/09/2026 14:05',
    '16/09/2026 2:05 PM',
    '2026-09-16 14:05',
    '16 September 2026, 2:05 PM',
  ];

  for (const text of cases) {
    const parsed = parseReceiptDateTime(text);
    assert.ok(parsed, `expected "${text}" to parse`);
    assert.equal(parsed.toISOString(), UTC_INSTANT, `wrong instant for "${text}"`);
  }
});

test('dates are read day-first, never month-first', () => {
  // 09/10/2026 is 9 October in Singapore, not 10 September. Getting this
  // backwards would shift a receipt by nearly a month and silently pass or
  // fail the freshness window.
  const parsed = parseReceiptDateTime('09/10/2026 14:05');
  assert.equal(parsed.toISOString(), '2026-10-09T06:05:00.000Z');
});

test('unparseable timestamps return null rather than a guess', () => {
  assert.equal(parseReceiptDateTime('not a date'), null);
  assert.equal(parseReceiptDateTime(''), null);
  assert.equal(parseReceiptDateTime(null), null);
});

test('comparisons happen at minute granularity', () => {
  // Receipts commonly show only minutes, so seconds must not decide a window.
  const truncated = truncateToMinute(new Date('2026-09-16T06:05:47.123Z'));
  assert.equal(truncated.toISOString(), '2026-09-16T06:05:00.000Z');
  assert.equal(truncateToMinute(null), null);
});

test('display formatting is Singapore time, day first', () => {
  assert.equal(formatSgt(new Date(UTC_INSTANT)), '16/09/2026 14:05');
  assert.equal(formatSgt(UTC_INSTANT), '16/09/2026 14:05');
  assert.equal(formatSgt(null), '');
  assert.equal(formatSgt('nonsense'), '');
  assert.match(formatSgtFriendly(new Date(UTC_INSTANT)), /16 Sep 2026, 2:05/);
});

test('storage path parts use the Singapore calendar day', () => {
  // 16:30 UTC on the 15th is already the 16th in Singapore. Using UTC here
  // would file a receipt under the wrong day.
  const parts = sgtDateParts(new Date('2026-09-15T16:30:00.000Z'));
  assert.equal(parts.year, '2026');
  assert.equal(parts.month, '09');
  assert.equal(parts.day, '16');
});
