// Must be set before src/config is first required, since config reads the
// environment at load time. node --test gives each file its own process.
process.env.CRON_SECRET = 'cron-secret-value';
process.env.CRON_TIME_BUDGET_MS = '7000';
process.env.WORKER_TIME_BUDGET_MS = '240000';

const test = require('node:test');
const assert = require('node:assert/strict');

const { createCronHandler } = require('../src/services/cronJobs');

/**
 * cron-job.org abandons a request after 30 s and disables a job after 25
 * failures in a row, so a scheduled run must get a short budget of its own. The
 * long WORKER_TIME_BUDGET_MS stays for the webhook's receipt verification.
 */

function fakeResponse() {
  const res = { statusCode: null, body: null };
  res.status = code => { res.statusCode = code; return res; };
  res.json = body => { res.body = body; return res; };
  return res;
}

test('a scheduled run gets the cron budget, not the long worker budget', async () => {
  let deadline = null;
  const handler = createCronHandler('probe', async args => { deadline = args.deadline; return {}; });

  const startedAt = Date.now();
  const res = fakeResponse();
  await handler({ headers: { authorization: 'Bearer cron-secret-value' } }, res);

  assert.equal(res.statusCode, 200);
  const budget = deadline - startedAt;
  assert.ok(budget >= 7000 && budget < 8000, `expected about 7000 ms, got ${budget}`);
});

test('the cron budget is a separate setting from the worker budget', () => {
  const { config } = require('../src/config');

  assert.equal(config.worker.cronTimeBudgetMs, 7000);
  assert.equal(config.worker.timeBudgetMs, 240000);
});
