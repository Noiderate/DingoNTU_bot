const test = require('node:test');
const assert = require('node:assert/strict');

const {
  OUTCOMES,
  REASONS,
  evaluatePayment,
  normalizeReference,
  normalizeRecipientName,
  normalizeUen,
  proxyMatches,
} = require('../src/services/paymentRules');

// --- Fixtures ----------------------------------------------------------------
// Baseline is a clean, valid DBS receipt that should auto-approve. Each test
// overrides only the field under examination, so a failure points straight at
// the rule that broke.

const ORDER_CREATED_AT = '2026-09-16T06:00:00.000Z'; // 14:00 SGT
const RECEIVED_AT = new Date('2026-09-16T06:10:00.000Z'); // 14:10 SGT

const ORDER = { total_cents: 1250, created_at: ORDER_CREATED_AT };

const RULES = {
  recipientNames: ['Dingo Cafe'],
  recipientAliases: ['DINGO CAFE PTE LTD'],
  uen: '',
  proxyNumber: '',
  maxAgeMinutes: 30,
  clockSkewMinutes: 5,
  maxIncompleteAttempts: 3,
};

function makeExtraction(overrides = {}) {
  return {
    is_bank_transfer_receipt: true,
    readability: 'clear',
    transfer_status: 'successful',
    status_text_seen: 'Transfer Successful',
    bank_app: 'DBS PayLah',
    amount_text: 'S$12.50',
    amount_value: 12.5,
    currency: 'SGD',
    recipient_name: 'Dingo Cafe',
    recipient_uen: null,
    recipient_proxy: null,
    transaction_datetime_text: '16 Sep 2026, 2:05 PM',
    transaction_date: '2026-09-16',
    transaction_time: '14:05',
    reference_label: 'Transaction Ref',
    reference_id: 'DBS-1234-5678',
    appears_cropped: false,
    appears_edited_or_composited: false,
    missing_required_fields: [],
    notes: null,
    ...overrides,
  };
}

function evaluate(overrides = {}, extra = {}) {
  return evaluatePayment({
    extraction: makeExtraction(overrides),
    order: ORDER,
    rules: RULES,
    now: RECEIVED_AT,
    receivedAt: RECEIVED_AT,
    ...extra,
  });
}


// --- Amount ------------------------------------------------------------------

test('exact amount auto-approves', () => {
  const result = evaluate();
  assert.equal(result.outcome, OUTCOMES.AUTO_APPROVED);
  assert.deepEqual(result.reasons, []);
  assert.equal(result.normalized.amountCents, 1250);
});

test('overpaying still approves but is recorded', () => {
  const result = evaluate({ amount_value: 20, amount_text: 'S$20.00' });
  assert.equal(result.outcome, OUTCOMES.AUTO_APPROVED);
  assert.deepEqual(result.reasons, [REASONS.OVERPAID]);
});

test('underpaying flags for review', () => {
  const result = evaluate({ amount_value: 10, amount_text: 'S$10.00' });
  assert.equal(result.outcome, OUTCOMES.FLAGGED);
  assert.ok(result.reasons.includes(REASONS.AMOUNT_MISMATCH));
});

test('a one-cent shortfall is still a shortfall', () => {
  const result = evaluate({ amount_value: 12.49, amount_text: 'S$12.49' });
  assert.equal(result.outcome, OUTCOMES.FLAGGED);
  assert.ok(result.reasons.includes(REASONS.AMOUNT_MISMATCH));
});

test('unreadable amount flags rather than assuming zero', () => {
  const result = evaluate({ amount_value: null, amount_text: null });
  assert.equal(result.outcome, OUTCOMES.FLAGGED);
  assert.ok(result.reasons.includes(REASONS.AMOUNT_UNREADABLE));
  assert.equal(result.normalized.amountCents, null);
});

test('thousands separators parse correctly (S$1,234.50)', () => {
  const bigOrder = { total_cents: 123450, created_at: ORDER_CREATED_AT };
  const result = evaluatePayment({
    extraction: makeExtraction({ amount_value: null, amount_text: 'S$1,234.50' }),
    order: bigOrder,
    rules: RULES,
    now: RECEIVED_AT,
    receivedAt: RECEIVED_AT,
  });

  assert.equal(result.normalized.amountCents, 123450);
  assert.equal(result.outcome, OUTCOMES.AUTO_APPROVED);
});

test('a foreign currency does not satisfy an SGD total', () => {
  const result = evaluate({ amount_value: null, amount_text: 'RM 12.50', currency: 'MYR' });
  assert.equal(result.outcome, OUTCOMES.FLAGGED);
  assert.ok(result.reasons.includes(REASONS.AMOUNT_MISMATCH));
});


// --- Recipient ---------------------------------------------------------------

test('recipient matches by exact name', () => {
  assert.equal(evaluate({ recipient_name: 'Dingo Cafe' }).outcome, OUTCOMES.AUTO_APPROVED);
});

test('recipient matches despite case, punctuation and legal suffix', () => {
  const result = evaluate({ recipient_name: 'DINGO CAFE PTE. LTD.' });
  assert.equal(result.outcome, OUTCOMES.AUTO_APPROVED);
});

test('recipient matches by configured alias', () => {
  const result = evaluate({ recipient_name: 'DINGO CAFE PTE LTD' });
  assert.equal(result.outcome, OUTCOMES.AUTO_APPROVED);
});

test('recipient matches by UEN, which wins over the display name', () => {
  const rules = { ...RULES, uen: '202012345X' };
  const result = evaluatePayment({
    // Name is wrong, but the UEN is definitive.
    extraction: makeExtraction({ recipient_name: 'Some Other Shop', recipient_uen: '202012345x' }),
    order: ORDER,
    rules,
    now: RECEIVED_AT,
    receivedAt: RECEIVED_AT,
  });

  assert.equal(result.outcome, OUTCOMES.AUTO_APPROVED);
});

test('a wrong UEN is a mismatch even when the name looks right', () => {
  const rules = { ...RULES, uen: '202012345X' };
  const result = evaluatePayment({
    extraction: makeExtraction({ recipient_uen: '999999999Z' }),
    order: ORDER,
    rules,
    now: RECEIVED_AT,
    receivedAt: RECEIVED_AT,
  });

  assert.equal(result.outcome, OUTCOMES.FLAGGED);
  assert.ok(result.reasons.includes(REASONS.RECIPIENT_MISMATCH));
});

test('recipient matches by masked proxy tail', () => {
  const rules = { ...RULES, recipientNames: [], recipientAliases: [], proxyNumber: '91234567' };
  const result = evaluatePayment({
    extraction: makeExtraction({ recipient_name: null, recipient_proxy: '****4567' }),
    order: ORDER,
    rules,
    now: RECEIVED_AT,
    receivedAt: RECEIVED_AT,
  });

  assert.equal(result.outcome, OUTCOMES.AUTO_APPROVED);
});

test('paying an entirely different person is a mismatch', () => {
  const result = evaluate({ recipient_name: 'Bob Tan' });
  assert.equal(result.outcome, OUTCOMES.FLAGGED);
  assert.ok(result.reasons.includes(REASONS.RECIPIENT_MISMATCH));
});

test('no visible recipient at all is unverifiable, not a match', () => {
  const result = evaluate({ recipient_name: null, recipient_uen: null, recipient_proxy: null });
  assert.equal(result.outcome, OUTCOMES.FLAGGED);
  assert.ok(result.reasons.includes(REASONS.RECIPIENT_UNVERIFIABLE));
});


// --- Transfer completion -----------------------------------------------------

for (const status of ['review_or_confirm', 'scheduled', 'pending_or_processing', 'failed', 'unknown']) {
  test(`a "${status}" screen is not a completed payment`, () => {
    const result = evaluate({ transfer_status: status });
    assert.equal(result.outcome, OUTCOMES.INCOMPLETE_TRANSFER);
    assert.ok(result.reasons.includes(REASONS.INCOMPLETE_TRANSFER));
  });
}

test('repeated incomplete transfers escalate to a human', () => {
  const result = evaluate({ transfer_status: 'scheduled' }, { incompleteAttempts: 2 });
  assert.equal(result.outcome, OUTCOMES.FLAGGED);
});


// --- Timestamps --------------------------------------------------------------

test('a transfer made before the order existed is rejected', () => {
  const result = evaluate({ transaction_time: '13:00', transaction_datetime_text: '16 Sep 2026, 1:00 PM' });
  assert.equal(result.outcome, OUTCOMES.FLAGGED);
  assert.ok(result.reasons.includes(REASONS.TIMESTAMP_BEFORE_ORDER));
});

test('a stale receipt beyond the max age is rejected', () => {
  const lateReceived = new Date('2026-09-16T07:00:00.000Z'); // 15:00 SGT, 55 min after txn
  const result = evaluatePayment({
    extraction: makeExtraction(),
    order: { total_cents: 1250, created_at: '2026-09-16T05:00:00.000Z' },
    rules: RULES,
    now: lateReceived,
    receivedAt: lateReceived,
  });

  assert.equal(result.outcome, OUTCOMES.FLAGGED);
  assert.ok(result.reasons.includes(REASONS.TIMESTAMP_TOO_OLD));
});

test('a timestamp in the future is rejected', () => {
  const result = evaluate({ transaction_time: '15:30', transaction_datetime_text: '16 Sep 2026, 3:30 PM' });
  assert.equal(result.outcome, OUTCOMES.FLAGGED);
  assert.ok(result.reasons.includes(REASONS.TIMESTAMP_IN_FUTURE));
});

test('small clock skew is tolerated', () => {
  // 14:13 SGT, three minutes "after" it was received, inside the 5 min skew.
  const result = evaluate({ transaction_time: '14:13', transaction_datetime_text: '16 Sep 2026, 2:13 PM' });
  assert.equal(result.outcome, OUTCOMES.AUTO_APPROVED);
});

test('a date with no time cannot be verified', () => {
  const result = evaluate({
    transaction_time: null,
    transaction_datetime_text: '16 Sep 2026',
  });
  assert.equal(result.outcome, OUTCOMES.FLAGGED);
  assert.ok(result.reasons.includes(REASONS.TIMESTAMP_UNREADABLE));
});

test('24-hour DD/MM text parses when structured fields are absent', () => {
  const result = evaluate({
    transaction_date: null,
    transaction_time: null,
    transaction_datetime_text: '16/09/2026 14:05',
  });
  assert.equal(result.outcome, OUTCOMES.AUTO_APPROVED);
});

test('12-hour text parses when structured fields are absent', () => {
  const result = evaluate({
    transaction_date: null,
    transaction_time: null,
    transaction_datetime_text: '16 Sep 2026, 2:05 PM',
  });
  assert.equal(result.outcome, OUTCOMES.AUTO_APPROVED);
});

test('DD/MM is not misread as MM/DD', () => {
  // 09/10/2026 must be 9 October, not 10 September. 9 Oct is far in the future
  // relative to the order, so it must be rejected rather than silently accepted.
  const result = evaluate({
    transaction_date: null,
    transaction_time: null,
    transaction_datetime_text: '09/10/2026 14:05',
  });
  assert.equal(result.outcome, OUTCOMES.FLAGGED);
  assert.ok(result.reasons.includes(REASONS.TIMESTAMP_IN_FUTURE));
});


// --- Reference and duplicates ------------------------------------------------

test('a missing reference always reaches a human', () => {
  const result = evaluate({ reference_id: null });
  assert.equal(result.outcome, OUTCOMES.FLAGGED);
  assert.ok(result.reasons.includes(REASONS.MISSING_REFERENCE));
});

test('a duplicate reference is rejected, not flagged', () => {
  const result = evaluate({}, { duplicate: { reference: true, image: false } });
  assert.equal(result.outcome, OUTCOMES.DUPLICATE_REJECTED);
  assert.ok(result.reasons.includes(REASONS.DUPLICATE_REFERENCE));
});

test('a duplicate image is rejected', () => {
  const result = evaluate({}, { duplicate: { reference: false, image: true } });
  assert.equal(result.outcome, OUTCOMES.DUPLICATE_REJECTED);
  assert.ok(result.reasons.includes(REASONS.DUPLICATE_IMAGE));
});

test('an incomplete transfer takes precedence over a duplicate', () => {
  const result = evaluate(
    { transfer_status: 'scheduled' },
    { duplicate: { reference: true, image: false } }
  );
  assert.equal(result.outcome, OUTCOMES.INCOMPLETE_TRANSFER);
});


// --- Tampering and cropping --------------------------------------------------

test('a suspected edit flags', () => {
  const result = evaluate({ appears_edited_or_composited: true });
  assert.equal(result.outcome, OUTCOMES.FLAGGED);
  assert.ok(result.reasons.includes(REASONS.SUSPECTED_EDIT));
});

test('cropping is harmless when nothing required was lost', () => {
  const result = evaluate({ appears_cropped: true });
  assert.equal(result.outcome, OUTCOMES.AUTO_APPROVED);
  assert.ok(!result.reasons.includes(REASONS.CROPPED));
});

test('cropping is fatal when it cost us a required field', () => {
  const result = evaluate({ appears_cropped: true, reference_id: null });
  assert.equal(result.outcome, OUTCOMES.FLAGGED);
  assert.ok(result.reasons.includes(REASONS.CROPPED));
});

test('a non-receipt image flags', () => {
  const result = evaluate({ is_bank_transfer_receipt: false });
  assert.equal(result.outcome, OUTCOMES.FLAGGED);
  assert.ok(result.reasons.includes(REASONS.NOT_A_RECEIPT));
});

test('an unreadable image flags', () => {
  const result = evaluate({ readability: 'unreadable' });
  assert.equal(result.outcome, OUTCOMES.FLAGGED);
  assert.ok(result.reasons.includes(REASONS.UNREADABLE));
});


// --- Completeness of the audit record ----------------------------------------

test('every failing check is reported, not just the first', () => {
  const result = evaluate({
    amount_value: 5,
    amount_text: 'S$5.00',
    recipient_name: 'Someone Else',
    reference_id: null,
    transaction_time: '13:00',
    transaction_datetime_text: '16 Sep 2026, 1:00 PM',
    appears_edited_or_composited: true,
  });

  assert.equal(result.outcome, OUTCOMES.FLAGGED);

  for (const expected of [
    REASONS.AMOUNT_MISMATCH,
    REASONS.RECIPIENT_MISMATCH,
    REASONS.MISSING_REFERENCE,
    REASONS.TIMESTAMP_BEFORE_ORDER,
    REASONS.SUSPECTED_EDIT,
  ]) {
    assert.ok(result.reasons.includes(expected), `expected reason ${expected}`);
  }
});


// --- Normalisation -----------------------------------------------------------

test('reference normalisation strips separators and case', () => {
  assert.equal(normalizeReference('dbs-1234 5678'), 'DBS12345678');
  assert.equal(normalizeReference('DBS/1234/5678'), 'DBS12345678');
  assert.equal(normalizeReference('  '), null);
  assert.equal(normalizeReference(null), null);
});

test('the same reference in different bank formats collapses to one key', () => {
  assert.equal(normalizeReference('OCBC_9988-7766'), normalizeReference('ocbc 9988 7766'));
});

test('recipient normalisation strips punctuation and legal suffixes', () => {
  assert.equal(normalizeRecipientName('DINGO CAFE PTE. LTD.'), 'dingo cafe');
  assert.equal(normalizeRecipientName('Dingo  Cafe'), 'dingo cafe');
  assert.equal(normalizeRecipientName(null), null);
});

test('UEN normalisation uppercases and strips separators', () => {
  assert.equal(normalizeUen('2020-12345 x'), '202012345X');
});

test('masked proxies need enough visible characters to be meaningful', () => {
  assert.equal(proxyMatches('****4567', ['91234567']), true);
  assert.equal(proxyMatches('****9999', ['91234567']), false);
  // Two visible digits would match far too many numbers to be evidence.
  assert.equal(proxyMatches('******67', ['91234567']), null);
  assert.equal(proxyMatches(null, ['91234567']), null);
});
