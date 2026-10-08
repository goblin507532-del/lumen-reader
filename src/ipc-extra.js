'use strict';

// Translation and recipe-capture IPC, kept apart from the core library wiring.

const fsp = require('fs/promises');
const path = require('path');
const fs = require('fs');
const translate = require('./lib/translate');
const recipeLib = require('./lib/recipe');
const opds = require('./lib/opds');
const sync = require('./lib/sync');
const { uid, decodeBuffer } = require('./lib/util');

const IMAGE_EXT = { 'image/jpeg': '.jpg', 'image/png': '.png', 'image/webp': '.webp', 'image/gif': '.gif', 'image/avif': '.avif' };

function register(deps) {
  const { handle, store, getWin } = deps;

  const trSettings = () => Object.assign({
    engine: 'gtx', to: 'ru', from: 'auto', style: 'literary', mode: 'parallel',
    apiKey: '', model: '', baseUrl: '', libreUrl: '', glossary: ''
  }, store.data.settings.translate || {});

  const cacheFile = (bookId, lang) => path.join(store.cacheDir, bookId + '.tr-' + lang + '.json');

  async function readTrCache(bookId, lang) {
    try {
      return JSON.parse(await fsp.readFile(cacheFile(bookId, lang), 'utf8'));
    } catch (e) {
      return {};
    }
  }

  async function writeTrCache(bookId, lang, data) {
    try {
      await fsp.writeFile(cacheFile(bookId, lang), JSON.stringify(data), 'utf8');
    } catch (e) { /* cache is best-effort */ }
  }

  handle('translate:info', async () => ({
    engines: translate.ENGINES,
    langs: translate.LANGS,
    settings: trSettings()
  }));

  handle('translate:setSettings', async (patch) => {
    store.data.settings.translate = Object.assign(trSettings(), patch || {});
    store.saveSoon();
    return store.data.settings.translate;
  });

  // Fragments come from the rendered chapter, so the mapping back to blocks is
  // the renderer's own index. Results are cached per book+chapter+language.
  handle('translate:chapter', async (bookId, chapter, fragments, override) => {
    const settings = Object.assign(trSettings(), override || {});
    const lang = settings.to || 'ru';
    const cache = await readTrCache(bookId, lang);
    const key = 'ch' + chapter;
    const hit = cache[key];
    if (hit && hit.engine === settings.engine && hit.items.length === fragments.length && !settings.force) {
      return { items: hit.items, cached: true };
    }
    const win = getWin();
    const items = await translate.translateBatch(fragments, { to: lang, from: settings.from, settings }, (done, total) => {
      if (win && !win.isDestroyed()) win.webContents.send('translate:progress', { bookId, chapter, done, total });
    });
    cache[key] = { engine: settings.engine, at: Date.now(), items };
    await writeTrCache(bookId, lang, cache);
    return { items, cached: false };
  });

  // Same block set the renderer collects (p, li, h1-h4, verse, author line),
  // in document order, so cached items line up by index on either side.
  const VOID_TAGS = /^(area|base|br|col|embed|hr|img|input|link|meta|param|source|track|wbr)$/i;

  function isInteresting(tag, attrs) {
    if (/^(p|li|h1|h2|h3|h4)$/.test(tag)) return true;
    return tag === 'div' && /class\s*=\s*["'][^"']*(fb-verse|fb-author-line)/i.test(attrs || '');
  }

  function extractBlocks(html) {
    const out = [];
    const stack = [];
    const re = /<\/?([\w-]+)([^>]*)>/g;
    let m;
    while ((m = re.exec(html))) {
      const tag = m[1].toLowerCase();
      const attrs = m[2] || '';
      const closing = m[0].charAt(1) === '/';
      if (!closing) {
        if (VOID_TAGS.test(tag) || /\/\s*>$/.test(m[0])) continue;
        stack.push({ tag, interest: isInteresting(tag, attrs), start: re.lastIndex, inner: false });
        continue;
      }
      // Unwind to the matching open tag; stray closers are ignored.
      let depth = -1;
      for (let i = stack.length - 1; i >= 0; i--) {
        if (stack[i].tag === tag) { depth = i; break; }
      }
      if (depth < 0) continue;
      const frame = stack[depth];
      stack.length = depth;
      if (frame.interest) {
        if (stack.length) stack[stack.length - 1].inner = true;
        if (!frame.inner) {
          const text = html.slice(frame.start, m.index)
            .replace(/<[^>]*>/g, '').replace(/&nbsp;/g, ' ').replace(/\s+/g, ' ')
            .trim();
          if (text.length > 1) out.push(text);
        }
      } else if (frame.inner && stack.length) {
        stack[stack.length - 1].inner = true;
      }
    }
    return out;
  }

  let bookJob = null;

  handle('translate:book', async (bookId, override) => {
    const book = store.book(bookId);
    if (!book) throw new Error('Книга не найдена');
    const settings = Object.assign(trSettings(), override || {});
    const lang = settings.to || 'ru';
    const cached = store.readCache(bookId, null);
    if (!cached || !cached.chapters) throw new Error('Сначала открой книгу — она ещё не разобрана');

    const cache = await readTrCache(bookId, lang);
    const win = getWin();
    const say = (payload) => {
      if (win && !win.isDestroyed()) win.webContents.send('translate:book', Object.assign({ bookId }, payload));
    };

    bookJob = { cancelled: false };
    const job = bookJob;
    const chapters = cached.chapters;
    const totalChapters = chapters.length;
    let translatedChapters = 0;
    let fragmentsDone = 0;

    const plan = chapters.map((c, i) => ({ index: i, title: c.title, blocks: extractBlocks(c.html) }));
    const totalFragments = plan.reduce((n, p) => n + p.blocks.length, 0);
    say({ stage: 'start', totalChapters, totalFragments });

    for (const part of plan) {
      if (job.cancelled) {
        say({ stage: 'cancelled', chapter: part.index, translatedChapters });
        return { cancelled: true, chapters: translatedChapters };
      }
      const key = 'ch' + part.index;
      const hit = cache[key];
      if (!part.blocks.length) { translatedChapters++; continue; }
      if (hit && hit.engine === settings.engine && hit.items.length === part.blocks.length && !settings.force) {
        translatedChapters++;
        fragmentsDone += part.blocks.length;
        say({ stage: 'chapter', chapter: part.index, title: part.title, translatedChapters, totalChapters, fragmentsDone, totalFragments, cached: true });
        continue;
      }
      const items = await translate.translateBatch(part.blocks, { to: lang, from: settings.from, settings }, (done) => {
        say({
          stage: 'progress', chapter: part.index, title: part.title,
          translatedChapters, totalChapters,
          fragmentsDone: fragmentsDone + done, totalFragments
        });
      });
      cache[key] = { engine: settings.engine, at: Date.now(), items };
      await writeTrCache(bookId, lang, cache);
      translatedChapters++;
      fragmentsDone += part.blocks.length;
      say({ stage: 'chapter', chapter: part.index, title: part.title, translatedChapters, totalChapters, fragmentsDone, totalFragments });
    }
    say({ stage: 'done', translatedChapters, totalChapters, fragmentsDone, totalFragments });
    bookJob = null;
    return { cancelled: false, chapters: translatedChapters, fragments: fragmentsDone };
  });

  handle('translate:cancel', async () => {
    if (bookJob) bookJob.cancelled = true;
    return true;
  });

  handle('translate:status', async (bookId, lang) => {
    const book = store.book(bookId);
    if (!book) return null;
    const cached = store.readCache(bookId, null);
    if (!cached || !cached.chapters) return null;
    const cache = await readTrCache(bookId, lang || trSettings().to);
    const ready = cached.chapters.filter((c, i) => cache['ch' + i]).length;
    return { ready, total: cached.chapters.length };
  });

  handle('translate:peek', async (bookId, chapter, lang, count) => {
    const cache = await readTrCache(bookId, lang || trSettings().to);
    const hit = cache['ch' + chapter];
    if (!hit || (count && hit.items.length !== count)) return null;
    return hit.items;
  });

  handle('translate:clear', async (bookId, lang) => {
    try { await fsp.unlink(cacheFile(bookId, lang || trSettings().to)); } catch (e) { /* nothing cached */ }
    return true;
  });

  handle('translate:text', async (text, override) => {
    const settings = Object.assign(trSettings(), override || {});
    return translate.translateText(text, { to: settings.to, from: settings.from, settings });
  });

  // --- sync ----------------------------------------------------------------

  const LAUNCHER_TOKEN = path.join(process.env.APPDATA || '', 'WarfareLauncher', 'token.txt');

  const syncSettings = () => Object.assign({
    enabled: false, token: '', owner: '', repo: 'lumen-sync',
    auto: true, lastSync: 0, maxUploadMb: 40
  }, store.data.settings.sync || {});

  const syncCfg = () => {
    const s = syncSettings();
    if (!s.token) throw new Error('Нужен GitHub-токен с правом repo — вставь его в настройках синхронизации');
    if (!s.owner) throw new Error('Не указан владелец репозитория');
    return { token: s.token, owner: s.owner, repo: s.repo || 'lumen-sync', branch: 'main' };
  };

  // What travels between devices: everything except the book files themselves.
  function localState() {
    return {
      version: 1,
      updatedAt: Date.now(),
      books: store.data.books.map((b) => ({
        id: b.id,
        title: b.title,
        authors: b.authors || [],
        series: b.series || '',
        format: b.format,
        lang: b.lang || '',
        year: b.year || '',
        annotation: b.annotation || '',
        tags: b.tags || [],
        collection: b.collection || '',
        favorite: !!b.favorite,
        rating: b.rating || 0,
        notes: b.notes || '',
        added: b.added,
        updated: b.updated || b.lastOpened || b.added,
        lastOpened: b.lastOpened || 0,
        progress: b.progress || { chapter: 0, offset: 0, percent: 0 },
        highlights: b.highlights || [],
        bookmarks: b.bookmarks || [],
        stats: b.stats || null,
        sourceUrl: b.sourceUrl || '',
        source: b.source || '',
        file: b.syncFile || ''
      })),
      notes: store.data.notes,
      collections: store.data.collections,
      removed: store.data.removed || { books: [], notes: [], highlights: [] }
    };
  }

  function applyState(state) {
    const incoming = new Map((state.books || []).map((b) => [b.id, b]));
    for (const book of store.data.books) {
      const remote = incoming.get(book.id);
      if (!remote) continue;
      incoming.delete(book.id);
      const remoteNewer = Number(remote.lastOpened || 0) > Number(book.lastOpened || 0);
      if (remoteNewer) {
        book.progress = remote.progress || book.progress;
        book.lastOpened = remote.lastOpened;
      }
      book.highlights = remote.highlights || book.highlights;
      book.bookmarks = remote.bookmarks || book.bookmarks;
      book.tags = remote.tags || book.tags;
      book.collection = remote.collection || book.collection;
      book.favorite = !!remote.favorite;
      book.rating = remote.rating || book.rating;
      book.notes = remote.notes || book.notes;
      if (remote.file) book.syncFile = remote.file;
    }
    // Books that exist only on the other device: keep them as shelf entries.
    for (const remote of incoming.values()) {
      store.data.books.push(Object.assign({}, remote, {
        file: '',
        remoteOnly: true,
        syncFile: remote.file || '',
        cover: null,
        external: null
      }));
    }
    const notesById = new Map(store.data.notes.map((n) => [n.id, n]));
    store.data.notes = (state.notes || []).map((n) => {
      const have = notesById.get(n.id);
      return have && Number(have.updated || 0) > Number(n.updated || 0) ? have : n;
    });
    store.data.collections = state.collections || store.data.collections;
    store.data.removed = state.removed || { books: [], notes: [], highlights: [] };
    store.save();
  }

  handle('sync:info', async () => {
    const s = syncSettings();
    const hinted = !s.token && fs.existsSync(LAUNCHER_TOKEN);
    return Object.assign({}, s, {
      token: s.token ? '••••' + s.token.slice(-4) : '',
      hasToken: !!s.token,
      tokenHint: hinted ? LAUNCHER_TOKEN : '',
      books: store.data.books.length,
      notes: store.data.notes.length
    });
  });

  handle('sync:setSettings', async (patch) => {
    const next = Object.assign(syncSettings(), patch || {});
    if (patch && patch.useLauncherToken && fs.existsSync(LAUNCHER_TOKEN)) {
      next.token = fs.readFileSync(LAUNCHER_TOKEN, 'utf8').trim();
    }
    delete next.useLauncherToken;
    store.data.settings.sync = next;
    store.save();
    return { ok: true, hasToken: !!next.token };
  });

  handle('sync:check', async () => {
    const cfg = syncCfg();
    const user = await sync.call(cfg, 'GET', '/user');
    if (!syncSettings().owner) {
      store.data.settings.sync = Object.assign(syncSettings(), { owner: user.login });
      store.save();
    }
    await sync.ensureRepo(Object.assign({}, cfg, { owner: user.login }));
    return { login: user.login, repo: (syncSettings().repo || 'lumen-sync') };
  });

  deps.runSync = async function runSync(note) {
    const cfg = syncCfg();
    const res = await sync.syncState(cfg, localState(), note || 'lumen desktop');
    applyState(res.state);
    const settings = syncSettings();
    settings.lastSync = Date.now();
    store.data.settings.sync = settings;
    store.save();
    return res;
  };

  deps.syncReady = function syncReady() {
    const s = syncSettings();
    return !!(s.auto && s.token && s.owner);
  };

  handle('sync:run', async (opts) => {
    const cfg = syncCfg();
    const win = getWin();
    const tell = (text) => { if (win && !win.isDestroyed()) win.webContents.send('sync:progress', { text }); };
    tell('Читаю состояние…');
    const res = await sync.syncState(cfg, localState(), (opts && opts.note) || 'lumen desktop');
    tell('Свожу изменения…');
    applyState(res.state);
    const settings = syncSettings();
    settings.lastSync = Date.now();
    store.data.settings.sync = settings;
    store.save();
    return {
      pushed: res.pushed,
      books: res.state.books.length,
      notes: res.state.notes.length,
      changes: res.changes
    };
  });

  // Send the actual file so the phone can read the book offline.
  handle('sync:uploadBook', async (bookId) => {
    const cfg = syncCfg();
    const book = store.book(bookId);
    if (!book || !book.file || !fs.existsSync(book.file)) throw new Error('Файл книги не найден');
    const limit = (syncSettings().maxUploadMb || 40) * 1024 * 1024;
    const stat = await fsp.stat(book.file);
    if (stat.size > limit) throw new Error('Книга больше ' + Math.round(limit / 1048576) + ' МБ — подними лимит в настройках');
    const ext = path.extname(book.file) || '.epub';
    const target = 'books/' + book.id + ext;
    const win = getWin();
    if (win && !win.isDestroyed()) win.webContents.send('sync:progress', { text: 'Отправляю «' + book.title + '»…' });
    const buf = await fsp.readFile(book.file);
    let sha = null;
    try {
      const existing = await sync.call(cfg, 'GET', '/repos/' + cfg.owner + '/' + cfg.repo + '/contents/' + encodeURI(target));
      sha = existing.sha;
    } catch (e) { /* not there yet */ }
    await sync.putFile(cfg, target, buf.toString('base64'), 'lumen: ' + book.title, sha);
    if (book.cover && fs.existsSync(book.cover)) {
      const coverTarget = 'covers/' + book.id + path.extname(book.cover);
      let csha = null;
      try {
        const existing = await sync.call(cfg, 'GET', '/repos/' + cfg.owner + '/' + cfg.repo + '/contents/' + encodeURI(coverTarget));
        csha = existing.sha;
      } catch (e) { /* new cover */ }
      await sync.putFile(cfg, coverTarget, (await fsp.readFile(book.cover)).toString('base64'), 'lumen cover', csha);
    }
    book.syncFile = target;
    book.updated = Date.now();
    store.save();
    await sync.syncState(cfg, localState(), 'lumen: book uploaded');
    return { file: target, size: stat.size };
  });

  handle('sync:downloadBook', async (bookId) => {
    const cfg = syncCfg();
    const book = store.book(bookId);
    if (!book || !book.syncFile) throw new Error('Для этой книги нет файла в синхронизации');
    const bin = await sync.getBinary(cfg, book.syncFile);
    const ext = path.extname(book.syncFile) || '.epub';
    const target = path.join(store.booksDir, book.id + ext);
    await fsp.writeFile(target, Buffer.from(bin.base64, 'base64'));
    book.file = target;
    book.remoteOnly = false;
    store.save();
    return { file: target };
  });

  // --- recipes -------------------------------------------------------------

  async function saveRemoteImage(url) {
    if (/^lumen:/.test(url)) return url;
    if (/^data:image\//i.test(url)) {
      const m = url.match(/^data:(image\/[\w+]+);base64,(.*)$/);
      if (!m) return null;
      const name = uid('img') + (IMAGE_EXT[m[1]] || '.jpg');
      await fsp.writeFile(path.join(store.assetsDir, name), Buffer.from(m[2], 'base64'));
      return 'lumen://asset/' + name;
    }
    if (!/^https?:/i.test(url)) return null;
    const dl = await opds.download(url);
    if (dl.buf.length < 3000) return null;
    const ext = IMAGE_EXT[(dl.type || '').split(';')[0]] || path.extname(new URL(url).pathname).toLowerCase() || '.jpg';
    const name = uid('img') + (ext.length <= 5 ? ext : '.jpg');
    await fsp.writeFile(path.join(store.assetsDir, name), dl.buf);
    return 'lumen://asset/' + name;
  }

  handle('recipe:fetch', async (url) => {
    const res = await opds.request(url);
    return { html: decodeBuffer(res.buf), url: res.url };
  });

  handle('recipe:preview', async (input) => {
    let html = input.html || '';
    let url = input.url || '';
    if (!html && url) {
      const res = await opds.request(url);
      html = decodeBuffer(res.buf);
      url = res.url;
    }
    const parsed = recipeLib.parse({ html, text: input.text || '', url });
    return {
      title: parsed.title,
      meta: parsed.meta,
      ingredients: parsed.ingredients,
      steps: parsed.steps.map((s) => ({ text: s.text, images: (s.images || []).length, heading: !!s.heading })),
      images: parsed.images.length,
      notes: parsed.notes || '',
      source: parsed.source,
      markdown: recipeLib.toMarkdown(parsed, null)
    };
  });

  handle('recipe:import', async (input) => {
    const win = getWin();
    const tell = (text) => { if (win && !win.isDestroyed()) win.webContents.send('recipe:progress', { text }); };

    let html = input.html || '';
    let url = input.url || '';
    if (!html && url) {
      tell('Качаю страницу…');
      const res = await opds.request(url);
      html = decodeBuffer(res.buf);
      url = res.url;
    }
    const parsed = recipeLib.parse({ html, text: input.text || '', url });

    // Translate before images: a failed download should not lose the text.
    if (input.translate) {
      const settings = Object.assign(trSettings(), input.translate);
      const fragments = [parsed.title, parsed.description || '']
        .concat(parsed.ingredients)
        .concat(parsed.steps.map((s) => s.text || ''))
        .concat([parsed.notes || '']);
      tell('Перевожу (' + fragments.filter(Boolean).length + ' фрагментов)…');
      const done = await translate.translateBatch(fragments.map((f) => f || '—'), {
        to: settings.to, from: settings.from, settings
      }, (d, t) => tell('Перевожу ' + d + '/' + t + '…'));
      let i = 0;
      parsed.title = done[i++] || parsed.title;
      parsed.description = (done[i++] || '').replace(/^—$/, '');
      parsed.ingredients = parsed.ingredients.map(() => done[i++]);
      parsed.steps = parsed.steps.map((s) => Object.assign({}, s, { text: done[i++] }));
      parsed.notes = (done[i++] || '').replace(/^—$/, '');
    }

    const imageMap = {};
    if (input.downloadImages !== false) {
      const all = [];
      for (const s of parsed.steps) for (const src of (s.images || []).slice(0, 4)) all.push(src);
      for (const src of parsed.images.slice(0, 8)) all.push(src);
      const unique = all.filter((v, i, a) => a.indexOf(v) === i).slice(0, Number(input.maxImages) || 30);
      let n = 0;
      for (const src of unique) {
        n++;
        tell('Сохраняю картинку ' + n + '/' + unique.length + '…');
        try {
          const local = await saveRemoteImage(src);
          if (local) imageMap[src] = local;
        } catch (e) { /* a missing photo is not fatal */ }
      }
    }

    const body = recipeLib.toMarkdown(parsed, imageMap);
    const cover = parsed.images.map((s) => imageMap[s]).find(Boolean)
      || Object.values(imageMap)[0] || null;

    const note = Object.assign({
      id: uid('nt'),
      kind: input.kind || 'recipe',
      title: parsed.title || 'Рецепт',
      body,
      tags: (input.tags || []).concat(input.translate ? ['перевод'] : []),
      cover,
      pinned: false,
      created: Date.now(),
      updated: Date.now(),
      meta: Object.assign({ source: url || '' }, parsed.meta || {}),
      links: []
    });
    store.data.notes.unshift(note);
    store.save();
    return note;
  });
}

module.exports = { register };
