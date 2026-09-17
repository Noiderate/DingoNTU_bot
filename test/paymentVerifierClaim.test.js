const test = require('node:test');
const assert = require('node:assert/strict');
const repo = require('../src/services/orderRepository');
const { processSubmission } = require('../src/services/paymentVerifier');

/**
 * Regression coverage for the concurrency bug where the synchronous
 * in-request verification path never claimed a lease on the submission it
 * was processing. A freshly-submitted receipt is immediately claimable
 * (queued, unlocked, due now by default - see 0002_payment_submissions.sql),
 * so a scheduled cron tick landing in that window could run a second,
 * fully independent verification pass on the same submission concurrently:
 * each hitting Gemini separately and potentially disagreeing on the outcome
 * (one flagging it to admins, the other auto-approving it).
 */

const fakeBot = {};

test('the synchronous path claims the submission before doing any work, and backs off if someone else already holds it', async t => {
  t.mock.method(repo, 'getPaymentSubmission', async () => ({ id: 'sub-1', order_id: 'order-1' }));
  const claimCalls = [];
  t.mock.method(repo, 'claimSubmissionById', async (submissionId, workerId) => {
    claimCalls.push({ submissionId, workerId });
    return null; // Someone else already holds the lease.
  });
  t.mock.method(repo, 'getOrderById', async () => {
    assert.fail('Must not fetch the order, let alone process it, once the claim fails');
  });

  const result = await processSubmission(fakeBot, 'sub-1', {});

  assert.deepEqual(result, { skipped: 'already_claimed' });
  assert.equal(claimCalls.length, 1);
  assert.equal(claimCalls[0].submissionId, 'sub-1');
});

test('the claimed lease covers the full processing deadline, not a shorter fixed default', async t => {
  t.mock.method(repo, 'getPaymentSubmission', async () => ({ id: 'sub-3', order_id: 'order-3' }));
  const claimCalls = [];
  t.mock.method(repo, 'claimSubmissionById', async (submissionId, workerId, options) => {
    claimCalls.push(options);
    return null;
  });
  t.mock.method(repo, 'getOrderById', async () => { assert.fail('unreachable'); });

  // A long-running invocation: 4 minutes left on its deadline. A fixed 120s
  // lease would expire while this is still legitimately working, letting a
  // scheduled tick reclaim and reprocess the same submission concurrently -
  // the exact bug the claim step exists to prevent, reintroduced via lease
  // expiry instead of a missing claim.
  const deadline = Date.now() + 240000;
  await processSubmission(fakeBot, 'sub-3', { deadline });

  assert.equal(claimCalls.length, 1);
  // Leases with headroom over the ~240s deadline, not clamped to a shorter
  // fixed value.
  assert.ok(claimCalls[0].leaseMs > 200000, `expected a lease covering the deadline, got ${claimCalls[0].leaseMs}ms`);
});

test('the scheduled worker path (alreadyClaimed) skips claiming - it already holds the lease from claimNextSubmission', async t => {
  t.mock.method(repo, 'getPaymentSubmission', async () => ({ id: 'sub-2', order_id: 'order-2' }));
  t.mock.method(repo, 'claimSubmissionById', async () => {
    assert.fail('Must not claim again - claimNextSubmission already did');
  });
  t.mock.method(repo, 'getOrderById', async () => null); // Short-circuits on "order_missing" for a minimal test.

  const result = await processSubmission(fakeBot, 'sub-2', { alreadyClaimed: true });

  assert.deepEqual(result, { skipped: 'order_missing' });
});
