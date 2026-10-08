'use strict';

const L = window.lumen;

const PHONE_RELEASE_URL = 'https://github.com/goblin507532-del/lumen-reader/releases/latest';

const State = {
  books: [],
  notes: [],
  collections: [],
  catalogs: [],
  sources: [],
  settings: {},
  view: 'library',
  lib: { kind: 'all', sort: 'added', layout: 'grid', collection: '', tag: '' },
  brain: { kind: 'all', query: '', tag: '', current: null, preview: 'split' },
  cat: { source: null, url: null, stack: [], data: null },
  reader: null
};

// ---------- tiny helpers ----------
const $ = (sel, root) => (root || document).querySelector(sel);
const $$ = (sel, root) => Array.from((root || document).querySelectorAll(sel));

function el(tag, attrs, children) {
  const node = document.createElement(tag);
  for (const k of Object.keys(attrs || {})) {
    const v = attrs[k];
    if (v == null || v === false) continue;
    if (k === 'class') node.className = v;
    else if (k === 'html') node.innerHTML = v;
    else if (k === 'text') node.textContent = v;
    else if (k === 'dataset') Object.assign(node.dataset, v);
    else if (k.startsWith('on') && typeof v === 'function') node.addEventListener(k.slice(2), v);
    else node.setAttribute(k, v === true ? '' : v);
  }
  for (const c of [].concat(children || [])) {
    if (c == null || c === false) continue;
    node.appendChild(typeof c === 'string' ? document.createTextNode(c) : c);
  }
  return node;
}

function esc(s) {
  return String(s == null ? '' : s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
}

function fmtDate(ts) {
  if (!ts) return '—';
  const d = new Date(ts);
  return d.toLocaleDateString('ru-RU', { day: 'numeric', month: 'short', year: 'numeric' });
}

function fmtSize(bytes) {
  if (!bytes) return '0 МБ';
  const mb = bytes / 1048576;
  return mb > 1024 ? (mb / 1024).toFixed(2) + ' ГБ' : mb.toFixed(1) + ' МБ';
}

function plural(n, one, few, many) {
  const a = Math.abs(n) % 100;
  const b = a % 10;
  if (a > 10 && a < 20) return many;
  if (b > 1 && b < 5) return few;
  if (b === 1) return one;
  return many;
}

// ---------- toast ----------
function toast(message, kind, sticky) {
  const node = el('div', { class: 'toast ' + (kind || '') }, [
    kind === 'wait' ? el('i', { class: 'sp' }) : null,
    el('span', { text: message })
  ]);
  $('#toast-wrap').appendChild(node);
  const close = () => {
    node.classList.add('out');
    setTimeout(() => node.remove(), 240);
  };
  if (!sticky) setTimeout(close, kind === 'err' ? 5200 : 2800);
  return { close, set: (t) => { const s = node.querySelector('span'); if (s) s.textContent = t; } };
}

// ---------- modal ----------
let modalEsc = null;

function modal(opts) {
  const back = $('#modal-back');
  const box = $('#modal');
  box.innerHTML = '';
  box.appendChild(el('h2', { text: opts.title || '' }));
  if (opts.sub) box.appendChild(el('p', { class: 'sub', text: opts.sub }));
  for (const n of [].concat(opts.body || [])) if (n) box.appendChild(n);
  const acts = el('div', { class: 'acts' });
  for (const b of opts.actions || []) {
    acts.appendChild(el('button', {
      class: 'btn ' + (b.kind || 'ghost'),
      text: b.label,
      onclick: () => { if (!b.action || b.action() !== false) closeModal(); }
    }));
  }
  box.appendChild(acts);
  back.hidden = false;
  modalEsc = opts.onClose || null;
  const focus = box.querySelector('input, textarea');
  if (focus) setTimeout(() => { focus.focus(); focus.select && focus.select(); }, 40);
  return box;
}

function closeModal() {
  $('#modal-back').hidden = true;
  $('#modal').innerHTML = '';
  if (modalEsc) { const f = modalEsc; modalEsc = null; f(); }
}

function prompt2(title, opts) {
  return new Promise((resolve) => {
    const input = el('input', {
      class: 'input', value: opts.value || '', placeholder: opts.placeholder || '', spellcheck: 'false'
    });
    input.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') { const v = input.value.trim(); closeModal(); resolve(v || null); }
    });
    modal({
      title,
      sub: opts.sub,
      body: [input],
      actions: [
        { label: 'Отмена', action: () => resolve(null) },
        { label: opts.ok || 'Готово', kind: 'primary', action: () => resolve(input.value.trim() || null) }
      ],
      onClose: () => resolve(null)
    });
  });
}

function confirm2(title, sub, okLabel) {
  return new Promise((resolve) => {
    modal({
      title, sub,
      actions: [
        { label: 'Отмена', action: () => resolve(false) },
        { label: okLabel || 'Удалить', kind: 'danger', action: () => resolve(true) }
      ],
      onClose: () => resolve(false)
    });
  });
}

// ---------- settings ----------
function applySettings() {
  const s = State.settings;
  document.documentElement.dataset.theme = s.theme || 'night';
  document.documentElement.dataset.accent = s.accent || 'amber';
  const r = document.documentElement.style;
  r.setProperty('--rf', s.fontFamily || 'Cambria');
  r.setProperty('--rs', (s.fontSize || 20) + 'px');
  r.setProperty('--rl', String(s.lineHeight || 1.7));
  r.setProperty('--rw', (s.pageWidth || 760) + 'px');
  r.setProperty('--rfw', String(s.fontWeight || 400));

  const name = s.profileName || 'Lumen';
  $('#profile-name').textContent = name;
  const letter = (name.trim()[0] || 'L').toUpperCase();
  for (const pair of [['#avatar-img', '#avatar-letter'], ['#settings-avatar-img', '#settings-avatar-letter']]) {
    const img = $(pair[0]);
    const txt = $(pair[1]);
    if (s.avatar) { img.src = s.avatar; img.hidden = false; txt.hidden = true; }
    else { img.hidden = true; img.removeAttribute('src'); txt.hidden = false; txt.textContent = letter; }
  }
  const setName = $('#set-name');
  if (setName && setName.value !== name) setName.value = s.profileName || '';

  $$('#theme-dots button, #theme-cards button').forEach((b) => b.classList.toggle('on', b.dataset.theme === (s.theme || 'night')));
  $$('#accent-row button').forEach((b) => b.classList.toggle('on', b.dataset.accent === (s.accent || 'amber')));

  const bind = (sel, val, label, suffix) => {
    const input = $(sel);
    if (!input) return;
    input.value = val;
    const pct = ((val - input.min) / (input.max - input.min)) * 100;
    input.style.setProperty('--p', pct + '%');
    if (label) $(label).textContent = val + (suffix || '');
  };
  bind('#font-size', s.fontSize || 20, '#font-size-val');
  bind('#line-height', s.lineHeight || 1.7, '#line-height-val');
  bind('#page-width', s.pageWidth || 760, '#page-width-val');
  const ff = $('#font-family');
  if (ff) ff.value = s.fontFamily || 'Cambria';
  const fw = $('#font-weight');
  if (fw) fw.value = String(s.fontWeight || 400);
  const forceFont = $('#force-font');
  if (forceFont) forceFont.checked = s.forceFont !== false;
  const pm = $('#paged-mode');
  if (pm) pm.checked = !!s.paged;
  const jm = $('#justify-mode');
  if (jm) jm.checked = !!s.justify;
  const content = $('#reader-content');
  if (content) {
    content.classList.toggle('justify', !!s.justify);
    content.classList.toggle('force-font', s.forceFont !== false);
  }
}

async function saveSettings(patch) {
  Object.assign(State.settings, patch);
  applySettings();
  try { await L.setSettings(patch); } catch (e) { /* non-fatal */ }
}

// ---------- routing ----------
function go(view) {
  if (view === State.view) return;
  State.view = view;
  $$('.view').forEach((v) => v.classList.toggle('active', v.id === 'view-' + view));
  $$('.nav-item').forEach((b) => b.classList.toggle('active', b.dataset.view === view));
  if (view === 'library') Library.render();
  if (view === 'highlights') Highlights.render();
  if (view === 'brain') Brain.render();
  if (view === 'catalog') Catalog.render();
  if (view === 'settings') Settings.render();
}

function updateCounts() {
  $('#count-books').textContent = State.books.length;
  $('#count-notes').textContent = State.notes.length;
  $('#count-hl').textContent = State.books.reduce((n, b) => n + (b.highlights || []).length, 0);
}

async function refreshState() {
  const s = await L.getState();
  State.books = s.books;
  State.notes = s.notes;
  State.collections = s.collections;
  State.catalogs = s.catalogs;
  State.sources = s.sources;
  State.settings = s.settings;
  updateCounts();
  renderCollections();
}

function renderCollections() {
  const box = $('#collection-list');
  box.innerHTML = '';
  const counts = {};
  for (const b of State.books) if (b.collection) counts[b.collection] = (counts[b.collection] || 0) + 1;
  const all = Array.from(new Set(State.collections.concat(Object.keys(counts))));
  if (!all.length) {
    box.appendChild(el('div', { class: 'muted small', text: 'ещё нет коллекций', style: 'padding:4px 10px' }));
    return;
  }
  for (const name of all) {
    const active = State.lib.collection === name;
    box.appendChild(el('button', {
      class: 'coll' + (active ? ' active' : ''),
      title: 'ПКМ — удалить коллекцию',
      onclick: () => {
        State.lib.collection = active ? '' : name;
        renderCollections();
        go('library');
        Library.render();
      },
      oncontextmenu: async (e) => {
        e.preventDefault();
        if (!(await confirm2('Удалить коллекцию «' + name + '»?', 'Книги останутся, только метка снимется.'))) return;
        State.collections = State.collections.filter((c) => c !== name);
        await L.setCollections(State.collections);
        for (const b of State.books.filter((x) => x.collection === name)) {
          b.collection = '';
          await L.updateBook(b.id, { collection: '' });
        }
        if (State.lib.collection === name) State.lib.collection = '';
        renderCollections();
        Library.render();
      }
    }, [el('i', {}), el('span', { text: name }), el('b', { text: String(counts[name] || 0) })]));
  }
}

// ---------- global search ----------
let searchTimer = null;

function closeSearchPop() {
  $('#search-pop').hidden = true;
}

async function runGlobalSearch(q) {
  const pop = $('#search-pop');
  const body = $('#sp-body');
  if (q.trim().length < 2) { pop.hidden = true; return; }
  const res = await L.search(q);
  body.innerHTML = '';
  const add = (label) => body.appendChild(el('div', { class: 'sp-sec', text: label }));
  let total = 0;
  if (res.books.length) {
    add('Книги');
    for (const b of res.books.slice(0, 7)) {
      total++;
      body.appendChild(el('button', {
        class: 'sp-row',
        onclick: () => { closeSearchPop(); Reader.open(b.id); }
      }, [el('span', { class: 'k', text: (b.format || '').toUpperCase() }), el('span', { class: 't', text: b.title + ' — ' + (b.authors || []).join(', ') })]));
    }
  }
  if (res.notes.length) {
    add('Второй мозг');
    for (const n of res.notes.slice(0, 7)) {
      total++;
      body.appendChild(el('button', {
        class: 'sp-row',
        onclick: () => { closeSearchPop(); go('brain'); Brain.select(n.id); }
      }, [el('span', { class: 'k', text: Brain.kindLabel(n.kind) }), el('span', { class: 't', text: n.title })]));
    }
  }
  if (res.highlights.length) {
    add('Выделения');
    for (const h of res.highlights.slice(0, 7)) {
      total++;
      body.appendChild(el('button', {
        class: 'sp-row',
        onclick: () => { closeSearchPop(); Reader.open(h.bookId, { chapter: h.highlight.chapter, offset: h.highlight.start }); }
      }, [el('span', { class: 'k', text: '«»' }), el('span', { class: 't', text: h.highlight.text.slice(0, 90) + ' — ' + h.bookTitle })]));
    }
  }
  if (!total) body.appendChild(el('div', { class: 'sp-row muted', text: 'Ничего не нашлось' }));
  pop.hidden = false;
}

// ---------- drag and drop ----------
function setupDrop() {
  let depth = 0;
  const hint = $('#drop-hint');
  window.addEventListener('dragenter', (e) => {
    e.preventDefault();
    if (!e.dataTransfer || !Array.from(e.dataTransfer.types || []).includes('Files')) return;
    depth++;
    hint.hidden = false;
  });
  window.addEventListener('dragover', (e) => e.preventDefault());
  window.addEventListener('dragleave', () => { depth = Math.max(0, depth - 1); if (!depth) hint.hidden = true; });
  window.addEventListener('drop', async (e) => {
    e.preventDefault();
    depth = 0;
    hint.hidden = true;
    const paths = Array.from(e.dataTransfer.files || []).map((f) => L.filePath(f)).filter(Boolean);
    if (!paths.length) return;
    await importPaths(paths);
  });
}

async function importPaths(paths) {
  const t = toast('Разбираю ' + paths.length + ' ' + plural(paths.length, 'файл', 'файла', 'файлов') + '…', 'wait', true);
  try {
    const res = await L.importPaths(paths);
    t.close();
    await refreshState();
    Library.render();
    if (res.imported.length) toast('Добавлено: ' + res.imported.length, 'ok');
    for (const err of res.errors.slice(0, 3)) toast(err, 'err');
    if (res.imported.length === 1) {
      const b = res.imported[0];
      toast('«' + b.title + '» в библиотеке', 'ok');
    }
  } catch (e) {
    t.close();
    toast(e.message, 'err');
  }
}

async function pickBooks() {
  const t = toast('Открываю диалог…', 'wait', true);
  try {
    const res = await L.pickBooks();
    t.close();
    if (!res.imported.length && !res.errors.length) return;
    await refreshState();
    go('library');
    Library.render();
    if (res.imported.length) toast('Добавлено: ' + res.imported.length, 'ok');
    for (const err of res.errors.slice(0, 3)) toast(err, 'err');
  } catch (e) {
    t.close();
    toast(e.message, 'err');
  }
}
