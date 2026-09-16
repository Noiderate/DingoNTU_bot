// Must be set before src/config is first required, since config reads the
// environment at load time. node --test gives each file its own process.
process.env.TELEGRAM_WEBHOOK_SECRET = 'correct-horse-battery-staple';
process.env.CRON_SECRET = 'cron-secret-value';

const test = require('node:test');
const assert = require('node:assert/strict');

const { secretMatches } = require('../api/telegram-webhook');
const { isAuthorized } = require('../src/services/cronJobs');
const { ALLOWED_UPDATES } = require('../src/app');

/**
 * Authentication on the two publicly reachable surfaces.
 *
 * Both endpoints are on the open internet. The webhook can create orders and
 * move money-related state; the cron endpoints can expire orders and restock
 * inventory. Neither may act on an unauthenticated request.
 */

test('the webhook accepts only the exact secret', () => {
  assert.equal(secretMatches('correct-horse-battery-staple'), true);
});

test('the webhook rejects a wrong, absent or malformed secret', () => {
  assert.equal(secretMatches('wrong-secret'), false);
  assert.equal(secretMatches(''), false);
  assert.equal(secretMatches(undefined), false);
  assert.equal(secretMatches(null), false);
});

test('the webhook rejects a secret that is merely a prefix or extension', () => {
  // Length is compared before content, so neither truncation nor padding can
  // sneak past.
  assert.equal(secretMatches('correct-horse-battery-stapl'), false);
  assert.equal(secretMatches('correct-horse-battery-staple '), false);
  assert.equal(secretMatches('correct-horse-battery-staplex'), false);
});

test('the webhook is case sensitive', () => {
  assert.equal(secretMatches('CORRECT-HORSE-BATTERY-STAPLE'), false);
});

test('cron endpoints require a bearer token', () => {
  assert.equal(isAuthorized({ headers: { authorization: 'Bearer cron-secret-value' } }), true);
});

test('cron endpoints reject a missing, wrong or malformed authorization header', () => {
  assert.equal(isAuthorized({ headers: {} }), false);
  assert.equal(isAuthorized({ headers: { authorization: '' } }), false);
  assert.equal(isAuthorized({ headers: { authorization: 'Bearer wrong' } }), false);
  // The scheme is required: a bare token must not be accepted.
  assert.equal(isAuthorized({ headers: { authorization: 'cron-secret-value' } }), false);
  assert.equal(isAuthorized({ headers: { authorization: 'Basic cron-secret-value' } }), false);
});

test('the bot subscribes only to the update kinds it handles', () => {
  // Anything else is traffic Telegram would send for us to discard, and each
  // one still costs a function invocation.
  assert.deepEqual(ALLOWED_UPDATES, ['message', 'callback_query']);
});
