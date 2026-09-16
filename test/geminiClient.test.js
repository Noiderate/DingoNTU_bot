const test = require('node:test');
const assert = require('node:assert/strict');
const { classifyError, isQuotaError, GeminiError } = require('../src/services/geminiClient');

test('a 429 status is classified as retryable and a quota error', () => {
  const classified = classifyError({ status: 429, message: 'Too many requests' });
  assert.equal(classified.retryable, true);
  assert.equal(isQuotaError(classified), true);
});

test('a RESOURCE_EXHAUSTED message is a quota error even without a numeric status', () => {
  const classified = classifyError({ message: 'RESOURCE_EXHAUSTED: quota exceeded for requests per day' });
  assert.equal(isQuotaError(classified), true);
});

test('a timeout is retryable but not a quota error, so it stays on the same model', () => {
  const classified = classifyError({ name: 'AbortError', message: 'The operation was aborted' });
  assert.equal(classified.retryable, true);
  assert.equal(isQuotaError(classified), false);
});

test('server overload is retryable but not a quota error', () => {
  const classified = classifyError({ status: 503, message: 'UNAVAILABLE' });
  assert.equal(classified.retryable, true);
  assert.equal(isQuotaError(classified), false);
});

test('a malformed-request error is not retryable and not a quota error', () => {
  const classified = classifyError({ status: 400, message: 'Invalid argument' });
  assert.equal(classified.retryable, false);
  assert.equal(isQuotaError(classified), false);
});

test('isQuotaError only recognises GeminiError instances, never a raw error', () => {
  assert.equal(isQuotaError(new Error('RESOURCE_EXHAUSTED')), false);
  assert.equal(isQuotaError(new GeminiError('quota exceeded', { status: 429 })), true);
});
