const fs = require('fs');
const vm = require('vm');
for (const f of ['server/app.js', 'server/sessionPool.js', 'server/devtoolsTargets.js', 'server/aiService.js']) {
  try {
    new vm.Script(fs.readFileSync(f, 'utf8'), { filename: f });
    console.log('OK  ' + f);
  } catch (e) {
    console.log('ERR ' + f + ': ' + e.message);
    process.exitCode = 1;
  }
}
