'use strict';

// Sync over a private GitHub repository: no server to run, no account to pay
// for, and the same code works from Electron and from the phone app.
//
// Layout in the sync repo:
//   state.json          merged library: books meta, notes, highlights, progress
//   books/<id>.<ext>    optional book files pushed to the phone
//   assets/<name>       images used by notes

const API = 'https://api.github.com';

function headers(cfg, extra) {
  return Object.assign({
    Authorization: 'Bearer ' + cfg.token,
    Accept: 'application/vnd.github+json',
    'X-GitHub-Api-Version': '2022-11-28',
    'User-Agent': 'lumen-sync'
  }, extra || {});
}

async function call(cfg, method, path, body) {
  const res = await fetch(API + path, {
    method,
    headers: headers(cfg, body ? { 'Content-Type': 'application/json' } : null),
    body: body ? JSON.stringify(body) : undefined
  });
  const text = await res.text();
  if (!res.ok) {
    const err = new Error('GitHub ' + res.status + ': ' + text.slice(0, 200));
    err.status = res.status;
    throw err;
  }
  return text ? JSON.parse(text) : {};
}

function b64encode(str) {
  if (typeof Buffer !== 'undefined') return Buffer.from(str, 'utf8').toString('base64');
  return btoa(unescape(encodeURIComponent(str)));
}

function b64decode(str) {
  const clean = String(str || '').replace(/\s+/g, '');
  if (typeof Buffer !== 'undefined') return Buffer.from(clean, 'base64').toString('utf8');
  return decodeURIComponent(escape(atob(clean)));
}

async function ensureRepo(cfg) {
  try {
    return await call(cfg, 'GET', '/repos/' + cfg.owner + '/' + cfg.repo);
  } catch (e) {
    if (e.status !== 404) throw e;
  }
  return call(cfg, 'POST', '/user/repos', {
    name: cfg.repo,
    description: 'Lumen Reader — личная синхронизация (книги, заметки, прогресс)',
    private: true,
    auto_init: true
  });
}

async function getFile(cfg, path) {
  let meta;
  try {
    meta = await call(cfg, 'GET', '/repos/' + cfg.owner + '/' + cfg.repo + '/contents/' + encodeURI(path));
  } catch (e) {
    if (e.status === 404) return null;
    throw e;
  }
  if (meta.content) return { sha: meta.sha, text: b64decode(meta.content), size: meta.size };
  // Files over 1 MB come back without content; fetch the blob itself.
  const blob = await call(cfg, 'GET', '/repos/' + cfg.owner + '/' + cfg.repo + '/git/blobs/' + meta.sha);
  return { sha: meta.sha, text: b64decode(blob.content), size: meta.size, base64: blob.content.replace(/\s+/g, '') };
}

async function getBinary(cfg, path) {
  const meta = await call(cfg, 'GET', '/repos/' + cfg.owner + '/' + cfg.repo + '/contents/' + encodeURI(path));
  const blob = await call(cfg, 'GET', '/repos/' + cfg.owner + '/' + cfg.repo + '/git/blobs/' + meta.sha);
  return { sha: meta.sha, base64: String(blob.content || '').replace(/\s+/g, ''), size: meta.size };
}

async function putFile(cfg, path, contentBase64, message, sha) {
  const body = { message: message || 'lumen sync', content: contentBase64, branch: cfg.branch || 'main' };
  if (sha) body.sha = sha;
  return call(cfg, 'PUT', '/repos/' + cfg.owner + '/' + cfg.repo + '/contents/' + encodeURI(path), body);
}

async function listDir(cfg, path) {
  try {
    const res = await call(cfg, 'GET', '/repos/' + cfg.owner + '/' + cfg.repo + '/contents/' + encodeURI(path));
    return Array.isArray(res) ? res : [];
  } catch (e) {
    if (e.status === 404) return [];
    throw e;
  }
}

// --- merge -----------------------------------------------------------------

const EMPTY = { version: 1, updatedAt: 0, books: [], notes: [], collections: [], removed: { books: [], notes: [], highlights: [] } };

function stamp(record) {
  return Number(record.updated || record.lastOpened || record.created || record.added || 0);
}

function mergeLists(mine, theirs, removedIds) {
  const gone = new Set(removedIds || []);
  const byId = new Map();
  for (const item of mine || []) byId.set(item.id, item);
  for (const item of theirs || []) {
    const have = byId.get(item.id);
    if (!have) { byId.set(item.id, item); continue; }
    byId.set(item.id, stamp(item) > stamp(have) ? item : have);
  }
  return Array.from(byId.values()).filter((i) => !gone.has(i.id));
}

function mergeHighlights(mine, theirs, removedIds) {
  const gone = new Set(removedIds || []);
  const byId = new Map();
  for (const h of mine || []) byId.set(h.id, h);
  for (const h of theirs || []) {
    const have = byId.get(h.id);
    if (!have || Number(h.updated || h.created || 0) > Number(have.updated || have.created || 0)) byId.set(h.id, h);
  }
  return Array.from(byId.values()).filter((h) => !gone.has(h.id));
}

function mergeBooks(mine, theirs, removed) {
  const gone = new Set(removed.books || []);
  const byId = new Map();
  for (const b of mine || []) byId.set(b.id, Object.assign({}, b));
  for (const b of theirs || []) {
    const have = byId.get(b.id);
    if (!have) { byId.set(b.id, Object.assign({}, b)); continue; }
    // Fields follow the newer record, but reading position follows whichever
    // device read last, and marks are the union of both.
    const newer = stamp(b) > stamp(have) ? b : have;
    const merged = Object.assign({}, have, newer);
    const mineOpened = Number(have.lastOpened || 0);
    const theirsOpened = Number(b.lastOpened || 0);
    merged.lastOpened = Math.max(mineOpened, theirsOpened);
    merged.progress = theirsOpened > mineOpened ? (b.progress || have.progress) : (have.progress || b.progress);
    merged.highlights = mergeHighlights(have.highlights, b.highlights, removed.highlights);
    merged.bookmarks = mergeHighlights(have.bookmarks, b.bookmarks, []);
    merged.tags = Array.from(new Set([].concat(have.tags || [], b.tags || [])));
    byId.set(b.id, merged);
  }
  return Array.from(byId.values()).filter((b) => !gone.has(b.id));
}

function merge(local, remote) {
  const mine = Object.assign({}, EMPTY, local || {});
  const theirs = Object.assign({}, EMPTY, remote || {});
  const removed = {
    books: Array.from(new Set([].concat(mine.removed.books || [], theirs.removed.books || []))),
    notes: Array.from(new Set([].concat(mine.removed.notes || [], theirs.removed.notes || []))),
    highlights: Array.from(new Set([].concat(mine.removed.highlights || [], theirs.removed.highlights || [])))
  };
  const books = mergeBooks(mine.books, theirs.books, removed);
  const notes = mergeLists(mine.notes, theirs.notes, removed.notes);
  const collections = Array.from(new Set([].concat(mine.collections || [], theirs.collections || [])));
  const changes = {
    booksIn: books.length - (mine.books || []).length,
    notesIn: notes.length - (mine.notes || []).length,
    newNotes: notes.filter((n) => !(mine.notes || []).some((x) => x.id === n.id)).map((n) => n.title),
    newBooks: books.filter((b) => !(mine.books || []).some((x) => x.id === b.id)).map((b) => b.title),
    movedBooks: books.filter((b) => {
      const was = (mine.books || []).find((x) => x.id === b.id);
      return was && Number(b.lastOpened || 0) > Number(was.lastOpened || 0)
        && Math.abs(((b.progress || {}).percent || 0) - ((was.progress || {}).percent || 0)) > 0.5;
    }).map((b) => ({ title: b.title, percent: Math.round((b.progress || {}).percent || 0) }))
  };
  return {
    state: { version: 1, updatedAt: Date.now(), books, notes, collections, removed },
    changes
  };
}

// --- high level ------------------------------------------------------------

async function pull(cfg) {
  const file = await getFile(cfg, 'state.json');
  if (!file) return { state: null, sha: null };
  try {
    return { state: JSON.parse(file.text), sha: file.sha };
  } catch (e) {
    return { state: null, sha: file.sha };
  }
}

async function push(cfg, state, sha, note) {
  const payload = b64encode(JSON.stringify(state, null, 1));
  const res = await putFile(cfg, 'state.json', payload, note || ('lumen: ' + new Date().toISOString()), sha);
  return res.content ? res.content.sha : null;
}

// One round trip: read remote, merge with local, write back when anything moved.
async function syncState(cfg, localState, note) {
  await ensureRepo(cfg);
  const remote = await pull(cfg);
  const merged = merge(localState, remote.state);
  const same = remote.state && JSON.stringify(stripTimestamp(remote.state)) === JSON.stringify(stripTimestamp(merged.state));
  let sha = remote.sha;
  if (!same) sha = await push(cfg, merged.state, remote.sha, note);
  return { state: merged.state, changes: merged.changes, pushed: !same, sha };
}

function stripTimestamp(state) {
  const copy = Object.assign({}, state);
  delete copy.updatedAt;
  return copy;
}

const API_EXPORTS = {
  EMPTY, merge, syncState, pull, push, ensureRepo,
  getFile, getBinary, putFile, listDir, b64encode, b64decode, call
};

if (typeof module !== 'undefined' && module.exports) module.exports = API_EXPORTS;
if (typeof window !== 'undefined') window.LumenSync = API_EXPORTS;
