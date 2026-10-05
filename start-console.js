const { spawn } = require('node:child_process');
const { appendFileSync } = require('node:fs');
const root = process.cwd();
const srv = spawn('node', ['server/index.js'], { cwd: root, stdio: ['ignore','ignore','ignore'], detached: true });
srv.unref();
appendFileSync(root + '/console.log', '[started] pid=' + srv.pid + ' at ' + new Date().toISOString() + '\n');
console.log('launcher started server pid=' + srv.pid);
