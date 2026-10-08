'use strict';

const fs = require('fs');
const path = require('path');

// Bump when the parsers change what the cached HTML looks like.
const PARSER_VERSION = 2;

const DEFAULTS = {
  version: 1,
  books: [],
  notes: [],
  collections: [],
  catalogs: [],
  settings: {
    theme: 'night',
    accent: 'amber',
    fontFamily: 'Literata',
    fontSize: 20,
    lineHeight: 1.7,
    pageWidth: 760,
    paged: true,
    justify: true,
    hyphens: true,
    sidebar: true
  }
};

class Store {
  constructor(dir) {
    this.dir = dir;
    this.file = path.join(dir, 'library.json');
    this.booksDir = path.join(dir, 'books');
    this.coversDir = path.join(dir, 'covers');
    this.cacheDir = path.join(dir, 'cache');
    this.assetsDir = path.join(dir, 'assets');
    for (const d of [this.dir, this.booksDir, this.coversDir, this.cacheDir, this.assetsDir]) {
      fs.mkdirSync(d, { recursive: true });
    }
    this.data = this.load();
    this._timer = null;
  }

  load() {
    try {
      const raw = JSON.parse(fs.readFileSync(this.file, 'utf8'));
      const data = Object.assign({}, DEFAULTS, raw);
      data.settings = Object.assign({}, DEFAULTS.settings, raw.settings || {});
      for (const key of ['books', 'notes', 'collections', 'catalogs']) {
        if (!Array.isArray(data[key])) data[key] = [];
      }
      return data;
    } catch (e) {
      return JSON.parse(JSON.stringify(DEFAULTS));
    }
  }

  save() {
    const tmp = this.file + '.tmp';
    fs.writeFileSync(tmp, JSON.stringify(this.data, null, 1), 'utf8');
    fs.renameSync(tmp, this.file);
  }

  // Debounced write so highlight/progress churn does not hammer the disk.
  saveSoon() {
    if (this._timer) clearTimeout(this._timer);
    this._timer = setTimeout(() => { this._timer = null; try { this.save(); } catch (e) { /* ignore */ } }, 400);
  }

  writeCover(id, dataUrl) {
    if (!dataUrl || !/^data:/.test(dataUrl)) return null;
    const m = dataUrl.match(/^data:([^;]+);base64,(.*)$/);
    if (!m) return null;
    const ext = m[1].includes('png') ? '.png' : m[1].includes('gif') ? '.gif' : m[1].includes('svg') ? '.svg' : m[1].includes('webp') ? '.webp' : '.jpg';
    const file = path.join(this.coversDir, id + ext);
    fs.writeFileSync(file, Buffer.from(m[2], 'base64'));
    return file;
  }

  readCover(file) {
    try {
      if (!file || !fs.existsSync(file)) return null;
      const ext = path.extname(file).toLowerCase();
      const mime = ext === '.png' ? 'image/png' : ext === '.gif' ? 'image/gif' : ext === '.svg' ? 'image/svg+xml' : ext === '.webp' ? 'image/webp' : 'image/jpeg';
      return 'data:' + mime + ';base64,' + fs.readFileSync(file).toString('base64');
    } catch (e) {
      return null;
    }
  }

  cachePath(id) {
    return path.join(this.cacheDir, id + '.json');
  }

  readCache(id, mtimeMs) {
    try {
      const p = this.cachePath(id);
      const raw = JSON.parse(fs.readFileSync(p, 'utf8'));
      if (mtimeMs && raw.__mtime !== mtimeMs) return null;
      // A newer parser (stripped colours, better chapters) invalidates old HTML.
      if (raw.__parser !== PARSER_VERSION) return null;
      return raw;
    } catch (e) {
      return null;
    }
  }

  writeCache(id, payload, mtimeMs) {
    try {
      payload.__mtime = mtimeMs || 0;
      payload.__parser = PARSER_VERSION;
      fs.writeFileSync(this.cachePath(id), JSON.stringify(payload), 'utf8');
    } catch (e) { /* cache is best-effort */ }
  }

  dropCache(id) {
    try { fs.unlinkSync(this.cachePath(id)); } catch (e) { /* ignore */ }
  }

  book(id) {
    return this.data.books.find((b) => b.id === id) || null;
  }

  note(id) {
    return this.data.notes.find((n) => n.id === id) || null;
  }
}

module.exports = { Store, DEFAULTS };
