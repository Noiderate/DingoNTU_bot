const { createCronHandler, runRefreshTodaySheet } = require('../../src/services/cronJobs');

module.exports = createCronHandler('refresh-today-sheet', () => runRefreshTodaySheet());
