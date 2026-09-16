const { createCronHandler, runRefreshPreorder } = require('../../src/services/cronJobs');

module.exports = createCronHandler('refresh-preorder', () => runRefreshPreorder());
