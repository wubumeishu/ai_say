const { spawn } = require('node:child_process');
const srv = spawn('node', ['server/index.js'], { cwd: process.cwd(), stdio: ['ignore','ignore','ignore'], detached: true });
srv.unref();
console.log('daemon started pid=' + srv.pid);