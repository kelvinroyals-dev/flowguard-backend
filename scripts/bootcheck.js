// Load every module the way node does at startup. A `node --check` only parses
// syntax — it does NOT resolve requires, construct middleware, or run the
// validation that express-rate-limit does at import time. Both crashes that
// took production down would have been caught here.
const fs = require('fs');
const path = require('path');
let failed = 0;

const dirs = ['routes', 'middleware', 'utils'];
for (const d of dirs) {
  if (!fs.existsSync(d)) continue;
  for (const f of fs.readdirSync(d).filter(x => x.endsWith('.js'))) {
    const p = path.resolve(__dirname, '..', d, f);
    try {
      require(p);
      console.log(`  ✓ ${d}/${f}`);
    } catch (e) {
      failed++;
      console.log(`  ✗ ${d}/${f}  -> ${e.constructor.name}: ${e.message.split('\n')[0].slice(0, 90)}`);
    }
  }
}
console.log(failed ? `\n${failed} MODULE(S) WOULD CRASH ON BOOT` : '\nEvery module loads and constructs ✓');
process.exit(failed ? 1 : 0);
