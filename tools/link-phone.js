'use strict';

// One-shot setup for phone↔computer sync: makes the private repo and writes
// the connection into the desktop app's settings. Run it once, then open the
// app and press "Синхронизировать сейчас".

const fs = require('fs');
const path = require('path');
const gh = require('./gh');
const sync = require('../src/lib/sync');

const DATA = path.join(process.env.APPDATA || '', 'Lumen Reader', 'data');
const FILE = path.join(DATA, 'library.json');

(async function main() {
  const user = await gh.me();
  const repo = process.argv[2] || 'lumen-sync';
  const cfg = { token: gh.token(), owner: user.login, repo, branch: 'main' };

  await sync.ensureRepo(cfg);
  console.log('репозиторий синхронизации: https://github.com/' + user.login + '/' + repo + ' (приватный)');

  fs.mkdirSync(DATA, { recursive: true });
  let data = { version: 1, books: [], notes: [], collections: [], catalogs: [], settings: {} };
  if (fs.existsSync(FILE)) {
    try { data = JSON.parse(fs.readFileSync(FILE, 'utf8')); } catch (e) { /* start fresh */ }
  }
  data.settings = data.settings || {};
  data.settings.sync = Object.assign({ repo, auto: true, maxUploadMb: 40, lastSync: 0 }, data.settings.sync, {
    enabled: true, token: cfg.token, owner: user.login, repo, auto: true
  });
  fs.writeFileSync(FILE, JSON.stringify(data, null, 1), 'utf8');
  console.log('настройки компьютера записаны:', FILE);

  // First push, so the phone has something to pull.
  const state = {
    version: 1, updatedAt: Date.now(),
    books: (data.books || []).map((b) => ({
      id: b.id, title: b.title, authors: b.authors || [], format: b.format,
      tags: b.tags || [], collection: b.collection || '', favorite: !!b.favorite,
      added: b.added, updated: b.updated || b.added, lastOpened: b.lastOpened || 0,
      progress: b.progress || { chapter: 0, offset: 0, percent: 0 },
      highlights: b.highlights || [], bookmarks: b.bookmarks || [], stats: b.stats || null
    })),
    notes: data.notes || [],
    collections: data.collections || [],
    removed: { books: [], notes: [], highlights: [] }
  };
  const res = await sync.syncState(cfg, state, 'lumen: первая связка');
  console.log('состояние отправлено: книг ' + res.state.books.length + ', записей ' + res.state.notes.length);
  console.log('');
  console.log('на телефоне: Ещё → Синхронизация');
  console.log('  владелец: ' + user.login);
  console.log('  репозиторий: ' + repo);
  console.log('  токен: тот же, что в ' + path.join(process.env.APPDATA || '', 'WarfareLauncher', 'token.txt'));
})().catch((e) => {
  console.error('ошибка:', e.message);
  process.exit(1);
});
