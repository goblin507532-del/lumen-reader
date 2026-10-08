'use strict';

const { app, BrowserWindow, ipcMain, dialog, shell, protocol, net, nativeImage, Menu } = require('electron');
const fs = require('fs');
const fsp = require('fs/promises');
const path = require('path');
const { pathToFileURL } = require('url');

const { Store } = require('./lib/store');
const { parseBook, BOOK_EXT, extOf } = require('./lib/parse');
const opds = require('./lib/opds');
const translate = require('./lib/translate');
const recipe = require('./lib/recipe');
const { uid, stripTags } = require('./lib/util');

let store = null;
let win = null;

// Filled in by ipc-extra so the quit handler can flush a sync.
const extras = { handle: null, store: null, getWin: () => win };

// Big books, big caches: a thousand-page FB2 with images needs room, and the
// renderer must keep working while the window sits in the background.
app.commandLine.appendSwitch('js-flags', '--max-old-space-size=8192');
app.commandLine.appendSwitch('disable-renderer-backgrounding');
app.commandLine.appendSwitch('disable-background-timer-throttling');
app.commandLine.appendSwitch('disable-backgrounding-occluded-windows');
app.commandLine.appendSwitch('disk-cache-size', String(512 * 1024 * 1024));

protocol.registerSchemesAsPrivileged([
  { scheme: 'lumen', privileges: { standard: true, secure: true, supportFetchAPI: true, stream: true, bypassCSP: false } }
]);

function dataDir() {
  return path.join(app.getPath('userData'), 'data');
}

function safeName(s) {
  return String(s || 'book').replace(/[\\/:*?"<>|]+/g, '_').replace(/\s+/g, ' ').trim().slice(0, 80);
}

// --- window ---------------------------------------------------------------

function createWindow() {
  const iconPath = path.join(__dirname, '..', 'build', 'icon.ico');
  win = new BrowserWindow({
    width: 1340,
    height: 880,
    minWidth: 900,
    minHeight: 600,
    show: false,
    frame: false,
    backgroundColor: '#14110f',
    icon: fs.existsSync(iconPath) ? iconPath : undefined,
    title: 'Lumen Reader',
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false,
      spellcheck: true,
      backgroundThrottling: false
    }
  });
  win.loadFile(path.join(__dirname, 'renderer', 'index.html'));
  win.once('ready-to-show', () => win.show());
  win.on('maximize', () => win.webContents.send('window:state', { maximized: true }));
  win.on('unmaximize', () => win.webContents.send('window:state', { maximized: false }));
  win.webContents.setWindowOpenHandler(({ url }) => {
    if (/^https?:/.test(url)) shell.openExternal(url);
    return { action: 'deny' };
  });
}

app.whenReady().then(() => {
  Menu.setApplicationMenu(null);
  store = new Store(dataDir());
  extras.handle = handle;
  extras.store = store;

  protocol.handle('lumen', async (req) => {
    try {
      const u = new URL(req.url);
      const kind = u.hostname;
      const rel = decodeURIComponent(u.pathname).replace(/^\/+/, '');
      const roots = { cover: store.coversDir, asset: store.assetsDir, book: store.booksDir };
      const root = roots[kind];
      if (!root) return new Response('not found', { status: 404 });
      const full = path.join(root, rel);
      if (!full.startsWith(root)) return new Response('denied', { status: 403 });
      return net.fetch(pathToFileURL(full).toString());
    } catch (e) {
      return new Response('error', { status: 500 });
    }
  });

  createWindow();
  require('./ipc-extra').register(extras);
  app.on('activate', () => { if (!BrowserWindow.getAllWindows().length) createWindow(); });
  if (process.env.LUMEN_SELFTEST) selfTest();
});

// Development smoke run: imports fixtures, drives the UI, saves screenshots.
function selfTest() {
  const dir = process.env.LUMEN_SELFTEST;
  const shots = process.env.LUMEN_SHOTS || app.getPath('temp');
  win.webContents.on('console-message', (_e, level, message, line, source) => {
    console.log('[renderer]', message, '(' + path.basename(source || '') + ':' + line + ')');
  });
  win.webContents.on('render-process-gone', (_e, d) => console.log('[renderer gone]', JSON.stringify(d)));
  const shot = async (name) => {
    const img = await win.webContents.capturePage();
    await fsp.writeFile(path.join(shots, name + '.png'), img.toPNG());
    console.log('[shot]', name);
  };
  const run = (js) => win.webContents.executeJavaScript(js, true);
  win.webContents.once('did-finish-load', async () => {
    try {
      await new Promise((r) => setTimeout(r, 1200));
      for (const f of fs.readdirSync(dir)) {
        if (BOOK_EXT.includes(extOf(f))) {
          try { await importFile(path.join(dir, f)); console.log('[import ok]', f); } catch (e) { console.log('[import FAIL]', f, e.message); }
        }
      }
      await run('refreshState().then(()=>Library.render())');
      await new Promise((r) => setTimeout(r, 900));
      await shot('01-library');
      const id = await run('(State.books.find(function(b){return b.format==="fb2";})||State.books[0]).id');
      await run('Reader.open(' + JSON.stringify(id) + ')');
      await new Promise((r) => setTimeout(r, 1400));
      await shot('02-reader');
      const selInfo = await run('(function(){var c=Reader.content();var n=c.querySelectorAll("p")[1]||c.querySelector("p,h1,h2,div");if(!n)return{err:"no p"};var r=document.createRange();r.selectNodeContents(n);var s=window.getSelection();s.removeAllRanges();s.addRange(r);var cap=Reader.captureSelection();return {text:String(s), collapsed:s.isCollapsed, count:s.rangeCount, cap:!!cap};})()');
      console.log('[selection]', JSON.stringify(selInfo));
      await run('Reader.pendingSel = (function(){var c=Reader.content();var n=c.querySelectorAll("p")[1]||c.querySelector("p,h1,h2,div");var r=document.createRange();r.selectNodeContents(n);var s=window.getSelection();s.removeAllRanges();s.addRange(r);return Reader.captureSelection();})(); if(Reader.pendingSel){Reader.showSelPop(Reader.pendingSel.rect,null); Reader.addHighlight("amber");}');
      await new Promise((r) => setTimeout(r, 700));
      await shot('03-highlight');
      await run('Reader.togglePanel("#rd-panel-toc", document.querySelector("#rd-toc"))');
      await new Promise((r) => setTimeout(r, 500));
      await shot('04-toc');
      const big = await run('(State.books.find(function(b){return (b.stats||{}).words>50000;})||{}).id');
      if (big) {
        await run('Reader.closePanels(); Reader.open(' + JSON.stringify(big) + ')');
        await new Promise((r) => setTimeout(r, 2500));
        await run('Reader.next(); Reader.next(); Reader.next()');
        await new Promise((r) => setTimeout(r, 800));
        await shot('04b-paged');
        console.log('[paged]', await run('JSON.stringify({pages:Reader.pageCount(), chapter:Reader.chapter, pct:document.querySelector("#progress-label").textContent})'));

        // Page turning: a nudge must not flip, a notch must flip exactly one,
        // two quick turns must advance two, and the slide must animate.
        await run('Reader.showChapter(1,0)');
        await new Promise((r) => setTimeout(r, 900));
        const fire = (dy) => 'document.querySelector("#reader-stage").dispatchEvent(new WheelEvent("wheel",{deltaY:' + dy + ',bubbles:true,cancelable:true}))';
        await run(fire(12));
        await new Promise((r) => setTimeout(r, 350));
        const nudge = await run('Reader.page');
        await run(fire(120));
        await new Promise((r) => setTimeout(r, 110));
        const mid = await run('Math.round(document.querySelector("#reader-scroll").scrollLeft)');
        await new Promise((r) => setTimeout(r, 600));
        const after = await run('JSON.stringify({page:Reader.page, left:Math.round(document.querySelector("#reader-scroll").scrollLeft), width:document.querySelector("#reader-scroll").clientWidth})');
        await run('Reader.next(); Reader.next();');
        await new Promise((r) => setTimeout(r, 800));
        const twice = await run('Reader.page');
        await run('Reader.prev();');
        await new Promise((r) => setTimeout(r, 600));
        const backOne = await run('Reader.page');
        console.log('[paging]', JSON.stringify({ afterNudge: nudge, midAnimation: mid, afterNotch: JSON.parse(after), afterTwo: twice, afterPrev: backOne }));
        console.log('[fonts]', await run('(function(){var c=document.querySelector("#reader-content");var p=c.querySelector("p")||c.querySelector("div");var cs=getComputedStyle(p);return JSON.stringify({force:c.classList.contains("force-font"),family:cs.fontFamily.split(",")[0],weight:cs.fontWeight});})()'));
      }
      if (big) {
        await run('Reader.togglePanel("#rd-panel-tr", document.querySelector("#rd-translate")); document.querySelector("#tr-mode").value="parallel";');
        await new Promise((r) => setTimeout(r, 400));
        await run('Translator.run(true)');
        await new Promise((r) => setTimeout(r, 12000));
        console.log('[translate]', await run('JSON.stringify({status:document.querySelector("#tr-status").textContent, lines:document.querySelectorAll(".tr-line").length, sample:(document.querySelector(".tr-line")||{}).textContent})'));
        await shot('09-translate');
        // Does the translation survive a scroll and a page turn?
        await run('document.querySelector("#reader-scroll").dispatchEvent(new WheelEvent("wheel",{deltaY:12,bubbles:true}))');
        await new Promise((r) => setTimeout(r, 600));
        console.log('[tr after wheel]', await run('JSON.stringify({lines:document.querySelectorAll(".tr-line").length, chapter:Reader.chapter})'));
        await run('Reader.next()');
        await new Promise((r) => setTimeout(r, 900));
        console.log('[tr after next]', await run('JSON.stringify({lines:document.querySelectorAll(".tr-line").length, chapter:Reader.chapter})'));
        await run('var s=document.querySelector("#reader-scroll"); s.scrollLeft = s.scrollLeft + 3; s.dispatchEvent(new Event("scroll"));');
        await new Promise((r) => setTimeout(r, 700));
        console.log('[tr after nudge]', await run('JSON.stringify({lines:document.querySelectorAll(".tr-line").length, chapter:Reader.chapter})'));
      }
      // Whole-book translation on the small FB2, then check that the blocks
      // the renderer sees line up with the ones the main process extracted.
      await run('Reader.open(' + JSON.stringify(id) + ')');
      await new Promise((r) => setTimeout(r, 1200));
      console.log('[book-translate]', await run('L.translateBook(' + JSON.stringify(id) + ', {to:"ru"}).then(function(r){return JSON.stringify(r);})'));
      console.log('[parity]', await run('(async function(){var out=[];for(var i=0;i<Reader.chapters.length;i++){Reader.showChapter(i,0);await new Promise(function(r){setTimeout(r,150);});var n=Translator.blocks().length;var peek=await L.translatePeek(Reader.book.id,i,"ru",n);out.push(i+":"+n+(peek?"=ok":"=MISMATCH"));}return out.join(" ");})()'));
      await run('Reader.showChapter(1,0)');
      await new Promise((r) => setTimeout(r, 900));
      await shot('11-book-translated');

      console.log('[meta-search]', await run('(async function(){Catalog.searchEverywhere("stalker");await new Promise(function(r){setTimeout(r,9000);});var m=State.cat.meta;return JSON.stringify({groups:Array.from(m.groups.values()).map(function(g){return g.sourceId+":"+g.items.length;}),pending:m.pending});})()'));
      await run('go("catalog")');
      await new Promise((r) => setTimeout(r, 600));
      await shot('12-search');

      try {
        const note = await run('L.recipeImport({url:"https://eda.ru/recepty/vypechka-deserty/francuzskij-baget-33742", downloadImages:true}).then(function(n){return JSON.stringify({id:n.id,title:n.title,len:n.body.length,cover:!!n.cover});})');
        console.log('[recipe]', note);
        await run('refreshState().then(function(){ go("brain"); Brain.select(JSON.parse(' + JSON.stringify(note) + ').id); })');
        await new Promise((r) => setTimeout(r, 1500));
        await shot('10-recipe');
      } catch (e) {
        console.log('[recipe FAILED]', e.message);
      }
      await run('Reader.closePanels(); go("brain"); Brain.create("recipe").then(function(n){document.querySelector("#be-title").value="Паста карбонара";Brain.renderPreview();Brain.queueSave();})');
      await new Promise((r) => setTimeout(r, 1200));
      await shot('05-brain');
      await run('go("highlights"); Highlights.render()');
      await new Promise((r) => setTimeout(r, 500));
      await shot('06-highlights');
      await run('go("catalog"); Catalog.pick(State.sources[0])');
      await new Promise((r) => setTimeout(r, 6000));
      await shot('07-catalog');
      await run('go("settings"); Settings.render()');
      await new Promise((r) => setTimeout(r, 600));
      await shot('08-settings');
      console.log('[selftest done]');
    } catch (e) {
      console.log('[selftest FAILED]', e && e.message);
    }
    app.quit();
  });
}

// Leaving the app flushes the library to the sync repo, so the phone opens on
// the page this device stopped at.
let flushing = false;
app.on('before-quit', (event) => {
  if (flushing || !extras.syncReady || !extras.syncReady()) return;
  event.preventDefault();
  flushing = true;
  extras.runSync('lumen desktop: выход')
    .catch(() => {})
    .then(() => app.quit());
});

app.on('window-all-closed', () => {
  try { if (store) store.save(); } catch (e) { /* ignore */ }
  if (process.platform !== 'darwin') app.quit();
});

// --- helpers --------------------------------------------------------------

function publicBook(b) {
  return {
    id: b.id, title: b.title, authors: b.authors, series: b.series, seriesNum: b.seriesNum,
    format: b.format, lang: b.lang, year: b.year, genres: b.genres, annotation: b.annotation,
    tags: b.tags || [], collection: b.collection || '', favorite: !!b.favorite,
    added: b.added, lastOpened: b.lastOpened || 0, progress: b.progress || { chapter: 0, offset: 0, percent: 0 },
    stats: b.stats || null, file: b.file, missing: !fs.existsSync(b.file),
    remoteOnly: !!b.remoteOnly || (!!b.syncFile && !b.file),
    syncFile: b.syncFile || '',
    sourceUrl: b.sourceUrl || '',
    coverUrl: b.cover ? 'lumen://cover/' + path.basename(b.cover) + '?v=' + (b.coverV || 0) : null,
    highlights: b.highlights || [], bookmarks: b.bookmarks || [], notes: b.notes || '',
    rating: b.rating || 0
  };
}

function snapshot() {
  return {
    books: store.data.books.map(publicBook),
    notes: store.data.notes,
    collections: store.data.collections,
    catalogs: store.data.catalogs,
    settings: store.data.settings,
    sources: opds.SOURCES
  };
}

async function importFile(srcPath, opt) {
  const options = opt || {};
  const ext = extOf(srcPath);
  if (!BOOK_EXT.includes(ext)) throw new Error('Неподдерживаемый формат: ' + ext);
  const buf = await fsp.readFile(srcPath);
  const parsed = await parseBook(srcPath, buf);

  const id = uid('bk');
  const stored = path.join(store.booksDir, id + ext);
  await fsp.writeFile(stored, buf);

  let coverFile = null;
  if (parsed.cover) coverFile = store.writeCover(id, parsed.cover);

  const dup = store.data.books.find((b) => b.title === parsed.meta.title
    && (b.authors || []).join() === (parsed.meta.authors || []).join());

  const book = {
    id,
    title: parsed.meta.title,
    authors: parsed.meta.authors || [],
    series: parsed.meta.series || '',
    seriesNum: parsed.meta.seriesNum || '',
    genres: parsed.meta.genres || [],
    annotation: parsed.meta.annotation || '',
    lang: parsed.meta.lang || '',
    year: parsed.meta.year || '',
    format: parsed.format || ext.replace('.', ''),
    file: stored,
    cover: coverFile,
    coverV: Date.now(),
    tags: options.tags || [],
    collection: options.collection || '',
    favorite: false,
    added: Date.now(),
    lastOpened: 0,
    progress: { chapter: 0, offset: 0, percent: 0 },
    highlights: [],
    bookmarks: [],
    notes: '',
    rating: 0,
    stats: parsed.stats || null,
    external: parsed.external || null,
    source: options.source || 'Локальный файл'
  };
  store.data.books.unshift(book);
  if (parsed.chapters && parsed.chapters.length) {
    store.writeCache(id, { chapters: parsed.chapters, notes: parsed.notes || {} }, (await fsp.stat(stored)).mtimeMs);
  }
  store.save();
  return { book: publicBook(book), duplicate: dup ? dup.title : null };
}

// --- IPC ------------------------------------------------------------------

function handle(channel, fn) {
  ipcMain.handle(channel, async (ev, ...args) => {
    try {
      return { ok: true, data: await fn(...args) };
    } catch (e) {
      return { ok: false, error: String((e && e.message) || e) };
    }
  });
}

handle('state:get', async () => snapshot());

handle('settings:set', async (patch) => {
  Object.assign(store.data.settings, patch || {});
  store.saveSoon();
  return store.data.settings;
});

handle('window:action', async (action) => {
  if (!win) return false;
  if (action === 'min') win.minimize();
  else if (action === 'max') win.isMaximized() ? win.unmaximize() : win.maximize();
  else if (action === 'close') win.close();
  return win.isMaximized();
});

handle('books:pick', async () => {
  const res = await dialog.showOpenDialog(win, {
    title: 'Добавить книги',
    properties: ['openFile', 'multiSelections'],
    filters: [
      { name: 'Книги', extensions: ['fb2', 'zip', 'fbz', 'epub', 'txt', 'md', 'html', 'htm', 'rtf', 'docx', 'pdf'] },
      { name: 'Все файлы', extensions: ['*'] }
    ]
  });
  if (res.canceled) return { imported: [], errors: [] };
  const imported = [];
  const errors = [];
  for (const p of res.filePaths) {
    try { imported.push((await importFile(p)).book); } catch (e) { errors.push(path.basename(p) + ': ' + e.message); }
  }
  return { imported, errors };
});

handle('books:importPaths', async (paths) => {
  const imported = [];
  const errors = [];
  for (const p of paths || []) {
    try {
      const st = await fsp.stat(p);
      if (st.isDirectory()) {
        const entries = await fsp.readdir(p);
        for (const e of entries) {
          const full = path.join(p, e);
          if (BOOK_EXT.includes(extOf(full))) {
            try { imported.push((await importFile(full)).book); } catch (err) { errors.push(e + ': ' + err.message); }
          }
        }
      } else {
        imported.push((await importFile(p)).book);
      }
    } catch (e) {
      errors.push(path.basename(p) + ': ' + e.message);
    }
  }
  return { imported, errors };
});

handle('book:open', async (id) => {
  const b = store.book(id);
  if (!b) throw new Error('Книга не найдена');
  if (!fs.existsSync(b.file)) throw new Error('Файл книги пропал: ' + b.file);
  if (b.external === 'pdf' || extOf(b.file) === '.pdf') {
    const pdfWin = new BrowserWindow({
      width: 1100, height: 900, title: b.title, backgroundColor: '#1a1714',
      webPreferences: { plugins: true }
    });
    pdfWin.loadURL(pathToFileURL(b.file).toString());
    b.lastOpened = Date.now();
    store.saveSoon();
    return { external: 'pdf' };
  }
  const mtime = (await fsp.stat(b.file)).mtimeMs;
  let cached = store.readCache(id, mtime);
  if (!cached) {
    const parsed = await parseBook(b.file, await fsp.readFile(b.file));
    cached = { chapters: parsed.chapters, notes: parsed.notes || {} };
    if (!b.stats) b.stats = parsed.stats;
    if (!b.cover && parsed.cover) { b.cover = store.writeCover(id, parsed.cover); b.coverV = Date.now(); }
    store.writeCache(id, cached, mtime);
  }
  b.lastOpened = Date.now();
  store.saveSoon();
  return { book: publicBook(b), chapters: cached.chapters, notes: cached.notes };
});

handle('book:update', async (id, patch) => {
  const b = store.book(id);
  if (!b) throw new Error('Книга не найдена');
  const allowed = ['title', 'authors', 'series', 'seriesNum', 'tags', 'collection', 'favorite', 'annotation', 'notes', 'rating', 'progress', 'bookmarks', 'genres', 'year'];
  for (const k of Object.keys(patch || {})) if (allowed.includes(k)) b[k] = patch[k];
  store.saveSoon();
  return publicBook(b);
});

handle('book:setCover', async (id) => {
  const b = store.book(id);
  if (!b) throw new Error('Книга не найдена');
  const res = await dialog.showOpenDialog(win, {
    title: 'Выбрать обложку',
    properties: ['openFile'],
    filters: [{ name: 'Изображения', extensions: ['jpg', 'jpeg', 'png', 'webp', 'gif'] }]
  });
  if (res.canceled) return null;
  const src = res.filePaths[0];
  const img = nativeImage.createFromPath(src);
  const resized = img.isEmpty() ? null : img.resize({ width: 600, quality: 'best' });
  const target = path.join(store.coversDir, id + '.jpg');
  await fsp.writeFile(target, resized ? resized.toJPEG(90) : await fsp.readFile(src));
  b.cover = target;
  b.coverV = Date.now();
  store.save();
  return publicBook(b);
});

handle('book:delete', async (id, withFile) => {
  const i = store.data.books.findIndex((b) => b.id === id);
  if (i < 0) throw new Error('Книга не найдена');
  const b = store.data.books[i];
  store.data.books.splice(i, 1);
  store.dropCache(id);
  if (withFile) {
    try { await fsp.unlink(b.file); } catch (e) { /* ignore */ }
    try { if (b.cover) await fsp.unlink(b.cover); } catch (e) { /* ignore */ }
  }
  store.save();
  return true;
});

handle('book:progress', async (id, progress) => {
  const b = store.book(id);
  if (!b) return false;
  b.progress = progress;
  b.lastOpened = Date.now();
  store.saveSoon();
  return true;
});

handle('highlight:save', async (id, hl) => {
  const b = store.book(id);
  if (!b) throw new Error('Книга не найдена');
  b.highlights = b.highlights || [];
  const existing = hl.id ? b.highlights.find((h) => h.id === hl.id) : null;
  if (existing) Object.assign(existing, hl, { updated: Date.now() });
  else b.highlights.push(Object.assign({ id: uid('hl'), created: Date.now() }, hl));
  store.saveSoon();
  return b.highlights;
});

handle('highlight:delete', async (id, hlId) => {
  const b = store.book(id);
  if (!b) throw new Error('Книга не найдена');
  b.highlights = (b.highlights || []).filter((h) => h.id !== hlId);
  store.saveSoon();
  return b.highlights;
});

handle('note:save', async (note) => {
  const now = Date.now();
  if (note.id) {
    const n = store.note(note.id);
    if (!n) throw new Error('Запись не найдена');
    Object.assign(n, note, { updated: now });
    store.saveSoon();
    return n;
  }
  const n = Object.assign({
    id: uid('nt'), kind: 'note', title: 'Без названия', body: '', tags: [],
    cover: null, pinned: false, created: now, updated: now, meta: {}, links: []
  }, note);
  store.data.notes.unshift(n);
  store.save();
  return n;
});

handle('note:delete', async (id) => {
  store.data.notes = store.data.notes.filter((n) => n.id !== id);
  store.save();
  return true;
});

handle('note:pickImage', async () => {
  const res = await dialog.showOpenDialog(win, {
    title: 'Картинка для записи',
    properties: ['openFile'],
    filters: [{ name: 'Изображения', extensions: ['jpg', 'jpeg', 'png', 'webp', 'gif'] }]
  });
  if (res.canceled) return null;
  const src = res.filePaths[0];
  const name = uid('img') + path.extname(src).toLowerCase();
  await fsp.copyFile(src, path.join(store.assetsDir, name));
  return 'lumen://asset/' + name;
});

handle('note:saveImageData', async (dataUrl) => {
  const m = String(dataUrl || '').match(/^data:(image\/[\w+]+);base64,(.*)$/);
  if (!m) throw new Error('Не изображение');
  const ext = m[1].includes('png') ? '.png' : m[1].includes('gif') ? '.gif' : m[1].includes('webp') ? '.webp' : '.jpg';
  const name = uid('img') + ext;
  await fsp.writeFile(path.join(store.assetsDir, name), Buffer.from(m[2], 'base64'));
  return 'lumen://asset/' + name;
});

handle('collections:set', async (list) => {
  store.data.collections = list || [];
  store.save();
  return store.data.collections;
});

handle('catalog:list', async () => ({ builtin: opds.SOURCES, custom: store.data.catalogs }));

handle('catalog:add', async (entry) => {
  if (!entry || !/^https?:\/\//.test(entry.url || '')) throw new Error('Нужен URL каталога (http/https)');
  store.data.catalogs.push({
    id: uid('cat'), kind: 'opds', name: entry.name || entry.url,
    url: entry.url, search: entry.search || '', note: 'Свой каталог', custom: true
  });
  store.save();
  return store.data.catalogs;
});

handle('catalog:remove', async (id) => {
  store.data.catalogs = store.data.catalogs.filter((c) => c.id !== id);
  store.save();
  return store.data.catalogs;
});

function findSource(sourceId) {
  return opds.SOURCES.find((s) => s.id === sourceId) || store.data.catalogs.find((c) => c.id === sourceId);
}

handle('catalog:browse', async (sourceId, url) => {
  const src = findSource(sourceId);
  if (!src) throw new Error('Каталог не найден');
  return opds.browse(src, url);
});

handle('catalog:search', async (sourceId, query, url) => {
  const src = findSource(sourceId);
  if (!src) throw new Error('Каталог не найден');
  return opds.search(src, query, url);
});

handle('catalog:searchEverywhere', async (query) => {
  const sources = opds.SOURCES.concat(store.data.catalogs);
  const groups = await opds.searchAll(sources, query, 12, (group) => {
    if (win && !win.isDestroyed()) win.webContents.send('catalog:searchHit', { query, group });
  });
  return groups;
});

handle('catalog:download', async (item, sourceName) => {
  // Internet Archive and Open Library name an item, not a file.
  if (item.archiveId) {
    const file = await opds.resolveArchiveFile(item.archiveId);
    item = Object.assign({}, item, { download: file.url, ext: file.ext });
  }
  const dl = await opds.download(item.download);
  let ext = item.ext || extOf(dl.name) || '';
  if (!ext || !BOOK_EXT.includes(ext)) {
    ext = opds.FORMAT_BY_TYPE[dl.type] || '.epub';
  }
  const tmp = path.join(app.getPath('temp'), safeName(item.title) + ext);
  await fsp.writeFile(tmp, dl.buf);
  const result = await importFile(tmp, { source: sourceName || 'Онлайн-каталог' });
  try { await fsp.unlink(tmp); } catch (e) { /* ignore */ }
  // Keep the catalog cover when the file itself has none.
  if (!result.book.coverUrl && item.cover && /^https?:/.test(item.cover)) {
    try {
      const img = await opds.download(item.cover);
      const b = store.book(result.book.id);
      const target = path.join(store.coversDir, b.id + '.jpg');
      await fsp.writeFile(target, img.buf);
      b.cover = target;
      b.coverV = Date.now();
      store.save();
      result.book = publicBook(b);
    } catch (e) { /* cover is optional */ }
  }
  return result;
});

handle('shell:open', async (url) => {
  if (/^https?:/.test(url)) await shell.openExternal(url);
  return true;
});

handle('shell:reveal', async (file) => {
  shell.showItemInFolder(file);
  return true;
});

handle('export:text', async (suggested, text, filters) => {
  const res = await dialog.showSaveDialog(win, {
    title: 'Сохранить',
    defaultPath: safeName(suggested),
    filters: filters || [{ name: 'Markdown', extensions: ['md'] }, { name: 'Текст', extensions: ['txt'] }]
  });
  if (res.canceled) return null;
  await fsp.writeFile(res.filePath, text, 'utf8');
  return res.filePath;
});

handle('import:text', async () => {
  const res = await dialog.showOpenDialog(win, {
    title: 'Импорт заметок',
    properties: ['openFile', 'multiSelections'],
    filters: [{ name: 'Markdown / текст', extensions: ['md', 'markdown', 'txt'] }]
  });
  if (res.canceled) return [];
  const out = [];
  for (const p of res.filePaths) {
    const body = await fsp.readFile(p, 'utf8');
    out.push({ title: path.basename(p).replace(/\.[^.]+$/, ''), body });
  }
  return out;
});

handle('data:stats', async () => {
  const sum = (dir) => {
    let total = 0;
    try {
      for (const f of fs.readdirSync(dir)) {
        try { total += fs.statSync(path.join(dir, f)).size; } catch (e) { /* ignore */ }
      }
    } catch (e) { /* ignore */ }
    return total;
  };
  return {
    dir: store.dir,
    books: store.data.books.length,
    notes: store.data.notes.length,
    highlights: store.data.books.reduce((n, b) => n + (b.highlights || []).length, 0),
    bytes: sum(store.booksDir) + sum(store.coversDir) + sum(store.cacheDir) + sum(store.assetsDir)
  };
});

handle('data:backup', async () => {
  const res = await dialog.showSaveDialog(win, {
    title: 'Резервная копия библиотеки',
    defaultPath: 'lumen-backup-' + new Date().toISOString().slice(0, 10) + '.json',
    filters: [{ name: 'JSON', extensions: ['json'] }]
  });
  if (res.canceled) return null;
  await fsp.writeFile(res.filePath, JSON.stringify(store.data, null, 1), 'utf8');
  return res.filePath;
});

handle('search:global', async (query) => {
  const q = String(query || '').toLowerCase().trim();
  if (q.length < 2) return { books: [], notes: [], highlights: [] };
  const hitBooks = store.data.books.filter((b) =>
    (b.title || '').toLowerCase().includes(q)
    || (b.authors || []).join(' ').toLowerCase().includes(q)
    || (b.tags || []).join(' ').toLowerCase().includes(q)).map(publicBook);
  const hitNotes = store.data.notes.filter((n) =>
    (n.title || '').toLowerCase().includes(q)
    || (n.body || '').toLowerCase().includes(q)
    || (n.tags || []).join(' ').toLowerCase().includes(q));
  const hitHl = [];
  for (const b of store.data.books) {
    for (const h of b.highlights || []) {
      if ((h.text || '').toLowerCase().includes(q) || (h.note || '').toLowerCase().includes(q)) {
        hitHl.push({ bookId: b.id, bookTitle: b.title, highlight: h });
      }
    }
  }
  return { books: hitBooks, notes: hitNotes, highlights: hitHl.slice(0, 200) };
});

handle('book:searchInside', async (id, query) => {
  const b = store.book(id);
  if (!b) throw new Error('Книга не найдена');
  const cached = store.readCache(id, (await fsp.stat(b.file)).mtimeMs);
  if (!cached) return [];
  const q = String(query || '').toLowerCase();
  if (q.length < 2) return [];
  const out = [];
  cached.chapters.forEach((c, ci) => {
    const text = stripTags(c.html);
    let from = 0;
    const low = text.toLowerCase();
    let idx;
    while ((idx = low.indexOf(q, from)) >= 0 && out.length < 300) {
      out.push({
        chapter: ci,
        chapterTitle: c.title,
        offset: idx,
        snippet: text.slice(Math.max(0, idx - 60), idx + q.length + 80)
      });
      from = idx + q.length;
    }
  });
  return out;
});
