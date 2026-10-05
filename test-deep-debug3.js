
const { createLiveScanner } = require('./server/adapter/liveScanner');
const fs = require('fs');
const settings = JSON.parse(fs.readFileSync('settings.json', 'utf8'));
const windowId = settings.windowId || '2315e879dd6642559bdc11a07bb1fc43';
const liveScanner = createLiveScanner({
  settings: { apiBase: 'http://127.0.0.1:54346', windowId },
  adapterPlatform: 'ichigo194964',
});
liveScanner.openCdpSession().then(function(sess) {
  var inbox = sess.targets.find(function(t) { return t.type === 'page' && String(t.url||'').indexOf('sp.194964.com') !== -1; });
  if (!inbox) { console.log('no inbox'); sess.close(); return; }
  sess.client.attachTarget(inbox.id, true).then(function() {
    // Try Runtime.enable first
    return sess.client.send('Runtime.enable', { sessionId: sess.client.sessionIdForTarget(inbox.id) }).then(function() {
      console.log('Runtime.enable OK');
      return sess.client.evaluate('document.title', inbox.id);
    }).then(function(res) {
      console.log('evaluate result:', res);
      sess.close();
    }).catch(function(e) {
      console.log('error after enable:', e.message);
      sess.close();
    });
  }).catch(function(e) {
    console.log('attach error:', e.message);
    sess.close();
  });
}).catch(function(e) {
  console.log('open error:', e.message);
});
