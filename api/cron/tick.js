const { createCronHandler, runTick } = require('../../src/services/cronJobs');

/**
 * The single scheduled entry point.
 *
 * Point cron-job.org here every minute with an
 * `Authorization: Bearer ${CRON_SECRET}` header. It runs payment recovery,
 * the sheet outbox drain, the preorder refresh and the expiry sweep in
 * sequence, and its regular database traffic also keeps a free-tier Supabase
 * project from pausing.
 *
 * The individual endpoints beside this one remain callable for debugging.
 */
module.exports = createCronHandler('tick', ({ deadline }) => runTick({ deadline }));
