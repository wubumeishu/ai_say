
const { createLiveScanner } = require('./server/adapter/liveScanner');
const { createIchigoDeepScrape } = require('./server/adapter/ichigoDeepScrape');
const fs = require('fs');
const settings = JSON.parse(fs.readFileSync('settings.json', 'utf8'));
const windowId = settings.windowId || '2315e879dd6642559bdc11a07bb1fc43';
const liveScanner = createLiveScanner({
  settings: { apiBase: 'http://127.0.0.1:54346', windowId },
  adapterPlatform: 'ichigo194964',
});
// Test openCdpSession manually
liveScanner.openCdpSession().then(function(sess) {
  console.log('session targets:', sess.targets.length);
  sess.targets.forEach(function(t, i) { console.log('  ' + i + ': ' + t.url.slice(0,60)); });
  var inbox = sess.targets.find(function(t) { return t.type === 'page' && t.url && t.url.indexOf('sp.194964.com') !== -1; });
  console.log('inbox:', inbox ? inbox.id : 'NOT FOUND');
  if (!inbox) { sess.close(); return; }
  // Test attachTarget + evaluate
  sess.client.attachTarget(inbox.id, true).then(function(attachRes) {
    console.log('attach result:', JSON.stringify(attachRes));
    // Now try a simple evaluate
    return sess.client.evaluate('document.title', inbox.id).then(function(title) {
      console.log('title:', title);
      sess.close();
    });
  }).catch(function(e) {
    console.log('attach/evaluate error:', e.message);
    sess.close();
  });
}).catch(function(e) {
  console.log('openCdpSession error:', e.message, e.reason);
});
