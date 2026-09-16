const { createCronHandler, runSweep } = require('../../src/services/cronJobs');

module.exports = createCronHandler('sweep', () => runSweep());
