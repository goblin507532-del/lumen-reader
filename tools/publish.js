'use strict';

// Publishes the project to GitHub and (optionally) kicks off the Android build.
// Usage: node tools/publish.js [--repo lumen-reader] [--build]

const path = require('path');
const gh = require('./gh');

const IGNORE = [
  /^node_modules\//,
  /^dist\//,
  /^build\/icon\.ico$/,
  /^mobile\/node_modules\//,
  /^mobile\/android\//,
  /^mobile\/ios\//,
  /^mobile\/www\/lib\//,
  /^mobile\/www\/vendor\//,
  /^mobile\/assets\//,
  /^out\//,
  /\.log$/,
  /^\.git\//
];

function arg(name, fallback) {
  const i = process.argv.indexOf('--' + name);
  return i > 0 && process.argv[i + 1] && !process.argv[i + 1].startsWith('--') ? process.argv[i + 1] : fallback;
}

(async function main() {
  const repo = arg('repo', 'lumen-reader');
  const user = await gh.me();
  console.log('аккаунт:', user.login);

  const info = await gh.ensureRepo(user.login, repo, {
    description: 'Lumen Reader — читалка и «второй мозг»: Windows + Android, синхронизация через GitHub',
    private: false
  });
  console.log('репозиторий:', info.html_url);

  const root = path.join(__dirname, '..');
  const res = await gh.pushDir(user.login, repo, root, 'Lumen Reader: desktop, phone app, sync', {
    ignore: IGNORE,
    branch: 'main',
    onProgress: (n, total, file) => {
      if (n % 10 === 0 || n === total) console.log('  ' + n + '/' + total + '  ' + file);
    }
  });
  console.log('отправлено файлов:', res.files, '| коммит', res.commit.slice(0, 7));

  if (process.argv.includes('--build')) {
    await new Promise((r) => setTimeout(r, 3000));
    try {
      await gh.dispatchWorkflow(user.login, repo, 'android.yml', 'main', { release: 'true' });
      console.log('сборка APK запущена: ' + info.html_url + '/actions');
    } catch (e) {
      console.log('не вышло запустить сборку:', e.message);
    }
  }
  console.log('готово: ' + info.html_url);
})().catch((e) => {
  console.error('ошибка:', e.message);
  process.exit(1);
});
