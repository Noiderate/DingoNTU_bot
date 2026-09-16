const { createCronHandler, runProcessPayments } = require('../../src/services/cronJobs');

module.exports = createCronHandler('process-payments', ({ deadline }) => runProcessPayments(deadline));
