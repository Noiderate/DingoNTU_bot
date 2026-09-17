const test = require('node:test');
const assert = require('node:assert/strict');
const repo = require('../src/services/orderRepository');
const orderActions = require('../src/services/orderActions');
const { processSubmission, handleDuplicateImage, MESSAGES } = require('../src/services/paymentVerifier');
const { STATUS } = repo;

/**
 * Bug: resending the exact same receipt image (a genuine repeat screenshot,
 * or reusing an old receipt for a different order) threw an uncaught
 * Postgres unique-violation on image_sha256 the moment the evidence step
 * tried to record it - the partial unique index doing exactly its job of
 * refusing a second live claim on that hash. With no catch around that
 * specific write, the exception fell through to the generic
 * try/catch in processSubmission and was mislabeled as
 * outcome_reasons: ['GEMINI_VERIFICATION_FAILURE'] - a duplicate resend
 * reported to the customer (and in the review card / sheet) as if Gemini
 * itself had failed, instead of "this receipt was already used".
 *
 * Fix: that one write is now wrapped, detects the unique violation, and
 * resolves it as duplicate_rejected via handleDuplicateImage - the
 * evidence-stage counterpart to applyOutcome's DUPLICATE_REJECTED branch.
 */

function uniqueViolationError() {
  const error = new Error('duplicate key value violates unique constraint "payment_submissions_image_sha256_live_idx"');
  error.code = '23505';
  return error;
}

test('handleDuplicateImage marks the submission duplicate_rejected without touching image_sha256 (would re-trigger the same violation)', async t => {
  t.mock.method(repo, 'findConflictingSubmission', async args => {
    assert.equal(args.imageSha256, 'abc123');
    return { id: 'winning-submission' };
  });

  let updatePayload = null;
  t.mock.method(repo, 'updatePaymentSubmission', async (id, patch) => { updatePayload = patch; return { id }; });
  t.mock.method(repo, 'transitionOrderStatus', async () => ({ id: 'order-1', status: STATUS.AWAITING_PAYMENT }));
  t.mock.method(orderActions, 'notify', async () => true);

  const order = { id: 'order-1', code: 'DG1', chatId: 555 };
  const submission = { id: 'sub-1', processing_message_id: 42 };

  const result = await handleDuplicateImage({}, { order, submission, storagePath: 'path/to/file.jpg', sha256: 'abc123' });

  assert.equal(result.outcome, 'duplicate_rejected');
  assert.equal(updatePayload.outcome, 'duplicate_rejected');
  assert.deepEqual(updatePayload.outcome_reasons, ['DUPLICATE_IMAGE']);
  assert.equal(updatePayload.duplicate_of_submission_id, 'winning-submission');
  assert.equal(updatePayload.storage_path, 'path/to/file.jpg');
  assert.ok(!('image_sha256' in updatePayload), 'must not write image_sha256 - it would hit the same unique violation again');
});

test('handleDuplicateImage tells the customer the receipt was already used, not that verification failed', async t => {
  t.mock.method(repo, 'findConflictingSubmission', async () => null);
  t.mock.method(repo, 'updatePaymentSubmission', async id => ({ id }));
  t.mock.method(repo, 'transitionOrderStatus', async () => ({ id: 'order-1', status: STATUS.AWAITING_PAYMENT }));

  const notified = [];
  t.mock.method(orderActions, 'notify', async (bot, chatId, text) => { notified.push({ chatId, text }); return true; });

  const order = { id: 'order-1', code: 'DG1', chatId: 555 };
  const submission = { id: 'sub-1', processing_message_id: 42 };

  await handleDuplicateImage({}, { order, submission, storagePath: 'x', sha256: 'abc123' });

  assert.equal(notified.length, 1);
  assert.equal(notified[0].chatId, 555);
  assert.equal(notified[0].text, MESSAGES.DUPLICATE);
  assert.doesNotMatch(notified[0].text, /gemini|verification failure/i);
});

test('handleDuplicateImage says nothing if the order already moved on elsewhere (transition superseded)', async t => {
  t.mock.method(repo, 'findConflictingSubmission', async () => null);
  t.mock.method(repo, 'updatePaymentSubmission', async id => ({ id }));
  // Someone/something else already resolved this order - the conditional
  // transition matches zero rows and returns null.
  t.mock.method(repo, 'transitionOrderStatus', async () => null);
  t.mock.method(orderActions, 'notify', async () => { throw new Error('must not notify - nothing to tell them'); });

  const order = { id: 'order-1', code: 'DG1', chatId: 555 };
  const submission = { id: 'sub-1', processing_message_id: 42 };

  await assert.doesNotReject(handleDuplicateImage({}, { order, submission, storagePath: 'x', sha256: 'abc123' }));
});


// --- Full pipeline wiring: the actual trigger point in processSubmission -------

test('a repeat screenshot resolves as a duplicate, not a Gemini verification failure', async t => {
  const orderRow = {
    id: 'order-1',
    order_code: 'DG1',
    status: STATUS.VERIFYING_PAYMENT,
    telegram_chat_id: 555,
    total_cents: 500,
    order_items: [],
    customers: {},
  };
  const submission = {
    id: 'sub-2', order_id: 'order-1', storage_path: null, received_at: new Date().toISOString(),
    attempt_count: 0, processing_message_id: 42,
  };

  t.mock.method(repo, 'getPaymentSubmission', async () => submission);
  t.mock.method(repo, 'claimSubmissionById', async () => submission);
  t.mock.method(repo, 'getOrderById', async () => orderRow);
  t.mock.method(repo, 'buildReceiptPath', () => '2026/09/DG1/sub-2.jpg');
  t.mock.method(repo, 'uploadReceipt', async () => {});

  // First write (storage_path + image_sha256) collides with a live claim on
  // that hash - the exact failure mode this test guards against. The second
  // write (handleDuplicateImage recording the resolution) must go through.
  let updateCalls = 0;
  t.mock.method(repo, 'updatePaymentSubmission', async (id, patch) => {
    updateCalls += 1;
    if (updateCalls === 1) {
      throw uniqueViolationError();
    }
    return { id, ...patch };
  });
  t.mock.method(repo, 'findConflictingSubmission', async () => ({ id: 'winning-submission' }));
  t.mock.method(repo, 'transitionOrderStatus', async () => ({ id: 'order-1', status: STATUS.AWAITING_PAYMENT }));

  const notified = [];
  t.mock.method(orderActions, 'notify', async (bot, chatId, text) => { notified.push({ chatId, text }); return true; });

  const bot = { async getFileLink() { return 'https://example.com/file.jpg'; } };
  t.mock.method(globalThis, 'fetch', async () => ({ ok: true, arrayBuffer: async () => new ArrayBuffer(8) }));

  const result = await processSubmission(bot, 'sub-2', { alreadyClaimed: true });

  assert.equal(result.outcome, 'duplicate_rejected');
  assert.equal(notified.length, 1);
  assert.equal(notified[0].text, MESSAGES.DUPLICATE);
  assert.notEqual(notified[0].text, MESSAGES.FLAGGED); // the old, wrong outcome
});
