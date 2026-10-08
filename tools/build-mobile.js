'use strict';

// Copies the shared parsing/markdown/sync code into the phone app's www folder
// and makes sure JSZip is there. Runs on this machine and on the CI runner.

const fs = require('fs');
const path = require('path');
const https = require('https');

const root = path.join(__dirname, '..');
const www = path.join(root, 'mobile', 'www');
const libOut = path.join(www, 'lib');
const vendorOut = path.join(www, 'vendor');

const SHARED = ['util.js', 'markdown.js', 'fb2.js', 'epub.js', 'parse.js', 'sync.js'];

function download(url, target) {
  return new Promise((resolve, reject) => {
    https.get(url, (res) => {
      if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
        res.resume();
        return download(res.headers.location, target).then(resolve, reject);
      }
      if (res.statusCode !== 200) {
        res.resume();
        return reject(new Error('HTTP ' + res.statusCode + ' для ' + url));
      }
      const chunks = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => {
        fs.writeFileSync(target, Buffer.concat(chunks));
        resolve(target);
      });
    }).on('error', reject);
  });
}

(async function main() {
  fs.mkdirSync(libOut, { recursive: true });
  fs.mkdirSync(vendorOut, { recursive: true });

  for (const name of SHARED) {
    const from = path.join(root, 'src', 'lib', name);
    fs.copyFileSync(from, path.join(libOut, name));
    console.log('copied lib/' + name);
  }

  const zipTarget = path.join(vendorOut, 'jszip.min.js');
  const local = path.join(root, 'node_modules', 'jszip', 'dist', 'jszip.min.js');
  if (fs.existsSync(local)) {
    fs.copyFileSync(local, zipTarget);
    console.log('copied vendor/jszip.min.js');
  } else if (!fs.existsSync(zipTarget)) {
    await download('https://cdn.jsdelivr.net/npm/jszip@3.10.1/dist/jszip.min.js', zipTarget);
    console.log('downloaded vendor/jszip.min.js');
  }

  // App icon source for @capacitor/assets.
  const assets = path.join(root, 'mobile', 'assets');
  fs.mkdirSync(assets, { recursive: true });
  const icon = path.join(root, 'build', 'icon-1024.png');
  if (fs.existsSync(icon)) {
    fs.copyFileSync(icon, path.join(assets, 'icon.png'));
    fs.copyFileSync(icon, path.join(assets, 'splash.png'));
    console.log('copied assets/icon.png');
  }
  console.log('mobile www is ready');
})().catch((e) => {
  console.error(e.message);
  process.exit(1);
});
