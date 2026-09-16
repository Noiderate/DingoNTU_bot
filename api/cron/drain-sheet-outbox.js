const { createCronHandler, runDrainSheetOutbox } = require('../../src/services/cronJobs');

module.exports = createCronHandler('drain-sheet-outbox', ({ deadline }) => runDrainSheetOutbox(deadline));
