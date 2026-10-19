// One transport budget across every caller in this process, including non-streaming learning.
const { createLimiter } = require('./router.cjs');
module.exports = createLimiter();
