'use strict';

// Writes the launcher PNGs the Android project needs, from the same renderer
// that draws the desktop icon. Keeps the CI build free of image libraries.

const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');

const DENSITIES = [
  ['mdpi', 48], ['hdpi', 72], ['xhdpi', 96], ['xxhdpi', 144], ['xxxhdpi', 192]
];

const iconJs = path.join(__dirname, 'make-icon.js');
const src = fs.readFileSync(iconJs, 'utf8');
// Reuse the renderer and PNG encoder by evaluating the drawing half of the file.
const cut = src.indexOf('const outDir =');
const mod = { exports: {} };
const fn = new Function('module', 'exports', 'require', 'Buffer', src.slice(0, cut)
  + '\nmodule.exports = { renderRGBA: renderRGBA, encodePng: encodePng };');
fn(mod, mod.exports, require, Buffer);
const { renderRGBA, encodePng } = mod.exports;

const out = path.join(__dirname, '..', 'mobile', 'android-res');
for (const [name, size] of DENSITIES) {
  const dir = path.join(out, 'mipmap-' + name);
  fs.mkdirSync(dir, { recursive: true });
  const png = encodePng(size, renderRGBA(size));
  fs.writeFileSync(path.join(dir, 'ic_launcher.png'), png);
  fs.writeFileSync(path.join(dir, 'ic_launcher_round.png'), png);
  fs.writeFileSync(path.join(dir, 'ic_launcher_foreground.png'), png);
  console.log('mipmap-' + name + '/ic_launcher.png', size + 'px');
}

// Notification icon: a flat white glyph on transparency reads best in the bar.
const statusDir = path.join(out, 'drawable');
fs.mkdirSync(statusDir, { recursive: true });
fs.writeFileSync(path.join(statusDir, 'ic_stat_icon.png'), encodePng(96, renderRGBA(96)));
console.log('drawable/ic_stat_icon.png');
