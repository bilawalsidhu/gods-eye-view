// Point the DroidEye app at a God's Eye View server.
//   npm run droideye:server -- http://192.168.1.10:4173     (your Mac on Wi-Fi, for testing)
//   npm run droideye:server -- https://droideye.onrender.com (hosted)
// Then run: npx cap sync android
import fs from 'node:fs';

const url = process.argv[2];
if (!url || !/^https?:\/\/[^/]+/.test(url)) {
  console.error('Usage: npm run droideye:server -- <http(s)://host[:port]>');
  process.exit(1);
}
const file = new URL('../capacitor.config.json', import.meta.url);
const config = JSON.parse(fs.readFileSync(file, 'utf8'));
config.server = { url: url.replace(/\/+$/, ''), cleartext: url.startsWith('http://') };
fs.writeFileSync(file, JSON.stringify(config, null, 2) + '\n');
console.log(`DroidEye now loads ${config.server.url}`);
if (config.server.cleartext) {
  console.log('Note: over plain http the microphone (voice) is blocked by Android WebView. Use the https server for voice.');
}
