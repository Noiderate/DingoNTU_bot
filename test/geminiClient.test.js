const test = require('node:test');
const assert = require('node:assert/strict');
const { classifyError, isQuotaError, isOverloadedError, GeminiError } = require('../src/services/geminiClient');

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

test('server overload is retryable, not a quota error, but is an overloaded error', () => {
  const classified = classifyError({ status: 503, message: 'UNAVAILABLE' });
  assert.equal(classified.retryable, true);
  assert.equal(isQuotaError(classified), false);
  assert.equal(isOverloadedError(classified), true);
});

test('isOverloadedError recognises 500/502/503/504 and overload-ish messages', () => {
  assert.equal(isOverloadedError(classifyError({ status: 500, message: 'internal error' })), true);
  assert.equal(isOverloadedError(classifyError({ status: 502, message: 'Bad gateway' })), true);
  assert.equal(isOverloadedError(classifyError({ status: 504, message: 'Gateway timeout' })), true);
  assert.equal(isOverloadedError(classifyError({ message: 'The model is overloaded' })), true);
});

test('a timeout is retryable but neither a quota nor an overloaded error, so it stays on the same model', () => {
  const classified = classifyError({ name: 'AbortError', message: 'The operation was aborted' });
  assert.equal(classified.retryable, true);
  assert.equal(isQuotaError(classified), false);
  assert.equal(isOverloadedError(classified), false);
});

test('isOverloadedError only recognises GeminiError instances, never a raw error', () => {
  assert.equal(isOverloadedError(new Error('UNAVAILABLE')), false);
  assert.equal(isOverloadedError(new GeminiError('UNAVAILABLE', { status: 503 })), true);
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
