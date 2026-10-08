'use strict';

// Lumen Reader for Android. The library, notes, highlights and reading
// position come from the same private GitHub repo the desktop app writes to.

const Cap = window.Capacitor || {};
const Plugins = Cap.Plugins || {};
const native = !!Cap.isNativePlatform && Cap.isNativePlatform();

const $ = (sel, root) => (root || document).querySelector(sel);
const $$ = (sel, root) => Array.from((root || document).querySelectorAll(sel));

function el(tag, attrs, kids) {
  const node = document.createElement(tag);
  for (const k of Object.keys(attrs || {})) {
    const v = attrs[k];
    if (v == null || v === false) continue;
    if (k === 'class') node.className = v;
    else if (k === 'text') node.textContent = v;
    else if (k === 'html') node.innerHTML = v;
    else if (k.startsWith('on') && typeof v === 'function') node.addEventListener(k.slice(2), v);
    else node.setAttribute(k, v === true ? '' : v);
  }
  for (const c of [].concat(kids || [])) {
    if (c == null || c === false) continue;
    node.appendChild(typeof c === 'string' ? document.createTextNode(c) : c);
  }
  return node;
}

function fmtDate(ts) {
  return ts ? new Date(ts).toLocaleDateString('ru-RU', { day: 'numeric', month: 'short' }) : '';
}

function toast(text, kind, sticky) {
  const node = el('div', { class: 'toast ' + (kind || '') }, [
    kind === 'wait' ? el('i', { class: 'sp' }) : null,
    el('span', { text })
  ]);
  $('#toasts').appendChild(node);
  const close = () => node.remove();
  if (!sticky) setTimeout(close, kind === 'err' ? 4800 : 2400);
  return { close, set: (t) => { const s = node.querySelector('span'); if (s) s.textContent = t; } };
}

function modal(opts) {
  const back = $('#modal-back');
  const box = $('#modal');
  box.innerHTML = '';
  box.appendChild(el('h2', { text: opts.title || '' }));
  if (opts.sub) box.appendChild(el('p', { class: 'sub', text: opts.sub }));
  for (const n of [].concat(opts.body || [])) if (n) box.appendChild(n);
  const acts = el('div', { class: 'acts' });
  for (const a of opts.actions || []) {
    acts.appendChild(el('button', {
      class: 'btn ' + (a.kind || 'ghost'),
      text: a.label,
      onclick: () => { if (!a.action || a.action() !== false) closeModal(); }
    }));
  }
  box.appendChild(acts);
  back.hidden = false;
  return box;
}

function closeModal() {
  $('#modal-back').hidden = true;
}

// ---------------------------------------------------------------------------
// Storage: Preferences for the small state, Filesystem for book files.
// ---------------------------------------------------------------------------

const Store = {
  async get(key) {
    if (Plugins.Preferences) {
      const res = await Plugins.Preferences.get({ key });
      return res.value;
    }
    return localStorage.getItem(key);
  },
  async set(key, value) {
    if (Plugins.Preferences) return Plugins.Preferences.set({ key, value });
    localStorage.setItem(key, value);
  },
  async remove(key) {
    if (Plugins.Preferences) return Plugins.Preferences.remove({ key });
    localStorage.removeItem(key);
  }
};

const memFiles = new Map();

const Files = {
  async write(name, base64) {
    if (Plugins.Filesystem) {
      await Plugins.Filesystem.writeFile({ path: 'books/' + name, data: base64, directory: 'DATA', recursive: true });
      return 'books/' + name;
    }
    memFiles.set(name, base64);
    return name;
  },
  async read(name) {
    if (Plugins.Filesystem) {
      const res = await Plugins.Filesystem.readFile({ path: 'books/' + name, directory: 'DATA' });
      return res.data;
    }
    return memFiles.get(name) || null;
  },
  async exists(name) {
    if (Plugins.Filesystem) {
      try {
        await Plugins.Filesystem.stat({ path: 'books/' + name, directory: 'DATA' });
        return true;
      } catch (e) {
        return false;
      }
    }
    return memFiles.has(name);
  },
  async remove(name) {
    if (Plugins.Filesystem) {
      try { await Plugins.Filesystem.deleteFile({ path: 'books/' + name, directory: 'DATA' }); } catch (e) { /* gone */ }
      return;
    }
    memFiles.delete(name);
  }
};

// ---------------------------------------------------------------------------

const State = {
  books: [],
  notes: [],
  collections: [],
  removed: { books: [], notes: [], highlights: [] },
  settings: {
    token: '', owner: '', repo: 'lumen-sync', auto: true,
    notify: true, remind: false, remindTime: '20:30',
    theme: 'night', fontSize: 19, lineHeight: 1.65, justify: true,
    lastSync: 0
  },
  screen: 'library',
  stack: [],
  filter: { q: '', tag: '' },
  brain: { q: '', kind: 'all', current: null, editing: false },
  marks: { color: 'all' },
  reader: null
};

const KIND_ICON = { recipe: '🍳', guide: '🧭', note: '📝', idea: '💡' };

async function loadState() {
  const raw = await Store.get('lumen-state');
  if (raw) {
    try {
      const data = JSON.parse(raw);
      State.books = data.books || [];
      State.notes = data.notes || [];
      State.collections = data.collections || [];
      State.removed = data.removed || State.removed;
    } catch (e) { /* corrupted, start clean */ }
  }
  const settings = await Store.get('lumen-settings');
  if (settings) {
    try { Object.assign(State.settings, JSON.parse(settings)); } catch (e) { /* defaults */ }
  }
  applyTheme();
}

async function saveState() {
  await Store.set('lumen-state', JSON.stringify({
    books: State.books, notes: State.notes, collections: State.collections, removed: State.removed
  }));
}

async function saveSettings() {
  await Store.set('lumen-settings', JSON.stringify(State.settings));
}

function applyTheme() {
  const s = State.settings;
  document.documentElement.dataset.theme = s.theme || 'night';
  document.documentElement.style.setProperty('--rs', (s.fontSize || 19) + 'px');
  document.documentElement.style.setProperty('--rl', String(s.lineHeight || 1.65));
  const body = $('#reader-body');
  if (body) body.classList.toggle('justify', !!s.justify);
  if (Plugins.StatusBar && native) {
    const dark = ['night', 'ink'].includes(s.theme);
    Plugins.StatusBar.setStyle({ style: dark ? 'DARK' : 'LIGHT' }).catch(() => {});
  }
}

// ---------------------------------------------------------------------------
// Navigation
// ---------------------------------------------------------------------------

const TITLES = {
  library: ['Библиотека', ''],
  reader: ['', ''],
  brain: ['Второй мозг', 'рецепты, гайды, заметки'],
  note: ['Запись', ''],
  marks: ['Цитаты', 'выделенное в книгах'],
  settings: ['Настройки', '']
};

function go(screen, push) {
  if (push !== false && State.screen !== screen) State.stack.push(State.screen);
  State.screen = screen;
  $$('.screen').forEach((s) => s.classList.toggle('active', s.id === 's-' + screen));
  $$('.tab').forEach((t) => t.classList.toggle('active', t.dataset.go === screen));
  const [title, sub] = TITLES[screen] || ['', ''];
  if (screen === 'reader' && Reader.book) {
    $('#screen-title').textContent = Reader.book.title;
    $('#screen-sub').textContent = (Reader.chapters[Reader.chapter] || {}).title || '';
  } else {
    $('#screen-title').textContent = title;
    $('#screen-sub').textContent = sub;
  }
  $('#back').hidden = !['reader', 'note'].includes(screen);
  $('#tabs').hidden = screen === 'reader';
  $('#top-action').hidden = screen !== 'note';
  if (screen === 'library') Library.render();
  if (screen === 'brain') Brain.render();
  if (screen === 'marks') Marks.render();
  if (screen === 'settings') Settings.render();
}

function back() {
  if (State.screen === 'note' && State.brain.editing) {
    Brain.saveCurrent();
  }
  if (State.screen === 'reader') Reader.leave();
  const prev = State.stack.pop() || 'library';
  go(prev, false);
}

// ---------------------------------------------------------------------------
// Library
// ---------------------------------------------------------------------------

const PALETTE = ['#5a3e2b', '#2f4858', '#3d3357', '#4a2f3a', '#2d4435', '#4a3d22'];

function coverNode(book) {
  const wrap = el('div', { class: 'cover' });
  if (book.coverData) {
    wrap.appendChild(el('img', { src: book.coverData, alt: '' }));
  } else {
    let h = 0;
    for (const ch of book.title || '') h = (h * 31 + ch.charCodeAt(0)) | 0;
    wrap.style.background = PALETTE[Math.abs(h) % PALETTE.length];
    wrap.appendChild(el('span', { text: (book.title || '').slice(0, 24) }));
  }
  return wrap;
}

const Library = {
  render() {
    const list = $('#lib-list');
    list.innerHTML = '';
    const q = State.filter.q.toLowerCase().trim();
    let books = State.books.slice().sort((a, b) => (b.lastOpened || b.added || 0) - (a.lastOpened || a.added || 0));
    if (State.filter.tag) books = books.filter((b) => (b.tags || []).includes(State.filter.tag));
    if (q) {
      books = books.filter((b) => (b.title || '').toLowerCase().includes(q)
        || (b.authors || []).join(' ').toLowerCase().includes(q));
    }
    $('#lib-empty').hidden = State.books.length > 0;

    const tags = {};
    for (const b of State.books) for (const t of b.tags || []) tags[t] = (tags[t] || 0) + 1;
    const chips = $('#lib-chips');
    chips.innerHTML = '';
    for (const t of Object.keys(tags).slice(0, 12)) {
      chips.appendChild(el('button', {
        class: 'chip' + (State.filter.tag === t ? ' on' : ''),
        text: '#' + t,
        onclick: () => { State.filter.tag = State.filter.tag === t ? '' : t; Library.render(); }
      }));
    }

    for (const book of books) {
      const pct = Math.round((book.progress || {}).percent || 0);
      const row = el('div', { class: 'book-row', onclick: () => Reader.open(book) }, [
        coverNode(book),
        el('div', { class: 'book-info' }, [
          el('b', { text: book.title }),
          el('em', { text: (book.authors || []).join(', ') || 'без автора' }),
          el('div', { class: 'bar' }, [el('i', { style: 'width:' + Math.min(100, pct) + '%' })]),
          el('div', { class: 'tagline', text: (book.localFile ? '' : 'нет файла · ') + (pct ? pct + '% · ' : '')
            + ((book.highlights || []).length ? book.highlights.length + ' цитат' : fmtDate(book.added)) })
        ])
      ]);
      row.addEventListener('contextmenu', (e) => { e.preventDefault(); Library.menu(book); });
      list.appendChild(row);
    }
  },

  menu(book) {
    modal({
      title: book.title,
      sub: (book.authors || []).join(', '),
      body: [
        el('button', { class: 'btn ghost block', text: 'Читать', onclick: () => { closeModal(); Reader.open(book); } }),
        book.localFile ? el('button', {
          class: 'btn ghost block', text: 'Удалить файл с телефона',
          onclick: async () => {
            closeModal();
            await Files.remove(book.localFile);
            book.localFile = '';
            await saveState();
            Library.render();
            toast('Файл удалён, прогресс сохранён', 'ok');
          }
        }) : null
      ],
      actions: [{ label: 'Закрыть' }]
    });
  }
};

// ---------------------------------------------------------------------------
// Reader
// ---------------------------------------------------------------------------

function textNodes(root) {
  const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT, {
    acceptNode: (n) => (n.nodeValue && n.nodeValue.trim() ? NodeFilter.FILTER_ACCEPT : NodeFilter.FILTER_REJECT)
  });
  const out = [];
  let n;
  while ((n = walker.nextNode())) out.push(n);
  return out;
}

function offsetOf(root, node, nodeOffset) {
  if (node.nodeType === Node.TEXT_NODE) {
    let total = 0;
    for (const t of textNodes(root)) {
      if (t === node) return total + nodeOffset;
      total += t.nodeValue.length;
    }
    return total;
  }
  const probe = document.createRange();
  probe.selectNodeContents(root);
  try { probe.setEnd(node, nodeOffset); } catch (e) { return 0; }
  return probe.toString().length;
}

function wrapOffsets(root, start, end, cls, data) {
  const nodes = textNodes(root);
  let pos = 0;
  const targets = [];
  for (const t of nodes) {
    const len = t.nodeValue.length;
    const from = Math.max(start, pos);
    const to = Math.min(end, pos + len);
    if (to > from) targets.push({ node: t, from: from - pos, to: to - pos });
    pos += len;
    if (pos >= end) break;
  }
  const marks = [];
  for (const t of targets) {
    let node = t.node;
    if (t.to < node.nodeValue.length) node.splitText(t.to);
    if (t.from > 0) node = node.splitText(t.from);
    const mark = document.createElement('mark');
    mark.className = cls;
    Object.assign(mark.dataset, data || {});
    node.parentNode.insertBefore(mark, node);
    mark.appendChild(node);
    marks.push(mark);
  }
  return marks;
}

function unwrap(root, sel) {
  for (const m of Array.from(root.querySelectorAll(sel))) {
    const parent = m.parentNode;
    while (m.firstChild) parent.insertBefore(m.firstChild, m);
    parent.removeChild(m);
    parent.normalize();
  }
}

const Reader = {
  book: null,
  chapters: [],
  notes: {},
  chapter: 0,
  lengths: [],
  total: 1,
  pending: null,
  saveTimer: null,

  async open(book) {
    if (!book.localFile) {
      const ok = await this.fetchFile(book);
      if (!ok) return;
    }
    const t = toast('Открываю…', 'wait', true);
    try {
      const base64 = await Files.read(book.localFile);
      if (!base64) throw new Error('Файл пропал — скачай заново');
      const bytes = LumenUtil.fromBase64(base64);
      const parsed = await LumenParse.parseBook(book.localFile, bytes);
      t.close();
      this.book = book;
      this.chapters = parsed.chapters;
      this.notes = parsed.notes || {};
      this.lengths = this.chapters.map((c) => c.html.replace(/<[^>]*>/g, '').length || 1);
      this.total = this.lengths.reduce((a, b) => a + b, 0) || 1;
      if (!book.stats) book.stats = parsed.stats;
      if (parsed.cover && !book.coverData) book.coverData = parsed.cover;
      go('reader');
      const target = book.progress || { chapter: 0, offset: 0 };
      this.show(Math.min(target.chapter || 0, this.chapters.length - 1), target.offset || 0);
    } catch (e) {
      t.close();
      toast('Не вышло открыть: ' + e.message, 'err');
    }
  },

  // The file comes from the sync repo, or from wherever the book was found.
  async fetchFile(book) {
    const cfg = Sync.cfg(true);
    if (book.file && cfg) {
      const t = toast('Качаю книгу…', 'wait', true);
      try {
        const bin = await LumenSync.getBinary(cfg, book.file);
        const name = book.id + (book.file.match(/\.[a-z0-9.]+$/i) || ['.epub'])[0];
        book.localFile = await Files.write(name, bin.base64);
        await saveState();
        t.close();
        return true;
      } catch (e) {
        t.close();
        toast('Из синхронизации не вышло: ' + e.message, 'err');
      }
    }
    if (book.sourceUrl) {
      const t = toast('Качаю из каталога…', 'wait', true);
      try {
        const res = await fetch(book.sourceUrl);
        const buf = new Uint8Array(await res.arrayBuffer());
        const name = book.id + (book.sourceUrl.match(/\.[a-z0-9]+(?=$|\?)/i) || ['.epub'])[0];
        book.localFile = await Files.write(name, LumenUtil.toBase64(buf));
        await saveState();
        t.close();
        return true;
      } catch (e) {
        t.close();
        toast('Скачать не удалось: ' + e.message, 'err');
      }
    }
    toast('Файла нет на телефоне. На компьютере открой карточку книги и нажми «Отправить на телефон».', 'err');
    return false;
  },

  body() { return $('#reader-body'); },
  scroller() { return $('#reader-scroll'); },

  show(index, offset) {
    this.chapter = Math.max(0, Math.min(index, this.chapters.length - 1));
    const ch = this.chapters[this.chapter];
    const body = this.body();
    body.innerHTML = ch ? ch.html : '';
    body.classList.toggle('justify', !!State.settings.justify);
    $('#screen-sub').textContent = (ch ? ch.title : '') + ' · ' + (this.chapter + 1) + '/' + this.chapters.length;
    this.applyMarks();
    this.hookNotes();
    requestAnimationFrame(() => {
      if (offset > 0) this.toOffset(offset);
      else this.scroller().scrollTop = 0;
      this.progress();
    });
  },

  toOffset(offset) {
    const range = (function (root, from) {
      const nodes = textNodes(root);
      let pos = 0;
      for (const t of nodes) {
        if (from < pos + t.nodeValue.length) {
          const r = document.createRange();
          r.setStart(t, Math.max(0, from - pos));
          r.setEnd(t, Math.max(0, from - pos));
          return r;
        }
        pos += t.nodeValue.length;
      }
      return null;
    })(this.body(), offset);
    if (!range) return;
    const box = range.getBoundingClientRect();
    const host = this.scroller().getBoundingClientRect();
    this.scroller().scrollTop += box.top - host.top - 60;
  },

  applyMarks() {
    const body = this.body();
    unwrap(body, 'mark.hl');
    const list = (this.book.highlights || []).filter((h) => h.chapter === this.chapter).sort((a, b) => b.start - a.start);
    for (const h of list) {
      try { wrapOffsets(body, h.start, h.end, 'hl ' + (h.color || 'amber'), { hid: h.id }); } catch (e) { /* skip */ }
    }
    for (const m of body.querySelectorAll('mark.hl')) {
      m.addEventListener('click', (e) => {
        e.stopPropagation();
        const h = (this.book.highlights || []).find((x) => x.id === m.dataset.hid);
        if (h) this.popup(m.getBoundingClientRect(), h);
      });
    }
  },

  hookNotes() {
    for (const a of this.body().querySelectorAll('a.note-ref')) {
      a.addEventListener('click', (e) => {
        e.preventDefault();
        const text = this.notes[a.dataset.note];
        if (text) modal({ title: 'Примечание', body: [el('div', { class: 'quote', text })], actions: [{ label: 'Закрыть' }] });
      });
    }
  },

  popup(rect, existing) {
    const pop = $('#selpop');
    pop.hidden = false;
    pop.dataset.hid = existing ? existing.id : '';
    $('[data-act=del]', pop).hidden = !existing;
    const w = pop.offsetWidth || 280;
    let left = Math.max(8, Math.min(rect.left + rect.width / 2 - w / 2, window.innerWidth - w - 8));
    let top = rect.top - pop.offsetHeight - 10;
    if (top < 60) top = rect.bottom + 10;
    pop.style.left = left + 'px';
    pop.style.top = top + 'px';
  },

  hidePopup() {
    $('#selpop').hidden = true;
    $('#selpop').dataset.hid = '';
  },

  capture() {
    const sel = window.getSelection();
    if (!sel || sel.isCollapsed || !sel.rangeCount) return null;
    const body = this.body();
    const range = sel.getRangeAt(0);
    if (!body.contains(range.commonAncestorContainer)) return null;
    const text = sel.toString().trim();
    if (!text) return null;
    const start = offsetOf(body, range.startContainer, range.startOffset);
    const end = offsetOf(body, range.endContainer, range.endOffset);
    if (end <= start) return null;
    return { start, end, text, rect: range.getBoundingClientRect() };
  },

  async addMark(color) {
    const pop = $('#selpop');
    const book = this.book;
    book.highlights = book.highlights || [];
    if (pop.dataset.hid) {
      const h = book.highlights.find((x) => x.id === pop.dataset.hid);
      if (h) { h.color = color; h.updated = Date.now(); }
    } else {
      const sel = this.pending;
      if (!sel) return;
      book.highlights.push({
        id: 'hl_' + Date.now().toString(36) + Math.random().toString(36).slice(2, 7),
        chapter: this.chapter,
        chapterTitle: (this.chapters[this.chapter] || {}).title || '',
        start: sel.start, end: sel.end, text: sel.text, color, note: '',
        created: Date.now(), updated: Date.now()
      });
      window.getSelection().removeAllRanges();
    }
    book.updated = Date.now();
    await saveState();
    this.applyMarks();
    this.hidePopup();
  },

  async removeMark() {
    const id = $('#selpop').dataset.hid;
    if (!id) return;
    this.book.highlights = (this.book.highlights || []).filter((h) => h.id !== id);
    State.removed.highlights.push(id);
    this.book.updated = Date.now();
    await saveState();
    this.applyMarks();
    this.hidePopup();
  },

  noteFor() {
    const id = $('#selpop').dataset.hid;
    const h = id ? (this.book.highlights || []).find((x) => x.id === id) : null;
    const target = h || null;
    const area = el('textarea', { placeholder: 'Мысль о цитате' });
    if (target) area.value = target.note || '';
    const quote = target ? target.text : (this.pending ? this.pending.text : '');
    modal({
      title: 'Заметка к цитате',
      body: [el('div', { class: 'quote', text: quote }), area],
      actions: [
        { label: 'Отмена' },
        {
          label: 'Сохранить',
          kind: 'primary',
          action: async () => {
            let h2 = target;
            if (!h2) {
              await this.addMark('amber');
              h2 = (this.book.highlights || [])[this.book.highlights.length - 1];
            }
            if (h2) {
              h2.note = area.value.trim();
              h2.updated = Date.now();
              this.book.updated = Date.now();
              await saveState();
              this.applyMarks();
            }
            this.hidePopup();
            toast('Сохранено', 'ok');
          }
        }
      ]
    });
  },

  progress() {
    const s = this.scroller();
    const span = Math.max(1, s.scrollHeight - s.clientHeight);
    const frac = s.scrollHeight <= s.clientHeight ? 1 : Math.min(1, s.scrollTop / span);
    const before = this.lengths.slice(0, this.chapter).reduce((a, b) => a + b, 0);
    const percent = Math.min(100, ((before + frac * this.lengths[this.chapter]) / this.total) * 100);
    $('#r-fill').style.width = percent + '%';
    $('#r-pct').textContent = Math.round(percent) + '%';
    if (this.saveTimer) clearTimeout(this.saveTimer);
    this.saveTimer = setTimeout(async () => {
      const offset = this.currentOffset();
      this.book.progress = { chapter: this.chapter, offset, percent };
      this.book.lastOpened = Date.now();
      this.book.updated = Date.now();
      await saveState();
    }, 700);
  },

  currentOffset() {
    const body = this.body();
    const host = this.scroller().getBoundingClientRect();
    let pos = 0;
    for (const t of textNodes(body)) {
      const r = document.createRange();
      r.selectNodeContents(t);
      const box = r.getBoundingClientRect();
      if (box.bottom > host.top + 2) return pos;
      pos += t.nodeValue.length;
    }
    return 0;
  },

  toc() {
    const box = $('#toc-body');
    box.innerHTML = '';
    this.chapters.forEach((c, i) => {
      box.appendChild(el('button', {
        class: 'toc-item' + (i === this.chapter ? ' cur' : ''),
        text: (c.title || 'Глава ' + (i + 1)),
        onclick: () => { this.show(i, 0); $('#toc-sheet').hidden = true; }
      }));
    });
    $('#toc-sheet').hidden = false;
    const cur = box.querySelector('.cur');
    if (cur) cur.scrollIntoView({ block: 'center' });
  },

  leave() {
    this.hidePopup();
    $('#toc-sheet').hidden = true;
    $('#type-sheet').hidden = true;
    if (State.settings.auto) Sync.run(true);
  }
};

// ---------------------------------------------------------------------------
// Second brain
// ---------------------------------------------------------------------------

const Brain = {
  render() {
    const kinds = $('#brain-kinds');
    kinds.innerHTML = '';
    for (const [id, label] of [['all', 'Всё'], ['recipe', '🍳 Рецепты'], ['guide', '🧭 Гайды'], ['note', '📝 Заметки'], ['idea', '💡 Идеи']]) {
      kinds.appendChild(el('button', {
        class: 'chip' + (State.brain.kind === id ? ' on' : ''),
        text: label,
        onclick: () => { State.brain.kind = id; Brain.render(); }
      }));
    }
    const list = $('#brain-list');
    list.innerHTML = '';
    const q = State.brain.q.toLowerCase().trim();
    let notes = State.notes.slice().sort((a, b) => (b.pinned ? 1 : 0) - (a.pinned ? 1 : 0) || (b.updated || 0) - (a.updated || 0));
    if (State.brain.kind !== 'all') notes = notes.filter((n) => n.kind === State.brain.kind);
    if (q) notes = notes.filter((n) => (n.title + ' ' + n.body + ' ' + (n.tags || []).join(' ')).toLowerCase().includes(q));
    if (!notes.length) {
      list.appendChild(el('div', { class: 'empty' }, [
        el('div', { class: 'art', text: '🧠' }),
        el('h2', { text: 'Пусто' }),
        el('p', { text: 'Записи появятся после синхронизации — или заведи новую кнопкой «+».' })
      ]));
      return;
    }
    for (const n of notes) {
      list.appendChild(el('div', { class: 'note-row', onclick: () => Brain.open(n.id) }, [
        el('div', { class: 'kind', text: KIND_ICON[n.kind] || '📝' }),
        el('div', {}, [
          el('b', { text: n.title || 'Без названия' }),
          el('p', { text: (window.MD ? MD.plainText(n.body) : n.body || '').slice(0, 110) })
        ])
      ]));
    }
  },

  current() {
    return State.notes.find((n) => n.id === State.brain.current) || null;
  },

  open(id) {
    State.brain.current = id;
    State.brain.editing = false;
    go('note');
    this.renderNote();
  },

  renderNote() {
    const n = this.current();
    if (!n) return;
    $('#screen-title').textContent = n.title || 'Без названия';
    $('#screen-sub').textContent = (KIND_ICON[n.kind] || '') + ' ' + (n.tags || []).map((t) => '#' + t).join(' ');
    const action = $('#top-action');
    action.hidden = false;
    action.innerHTML = State.brain.editing
      ? '<svg viewBox="0 0 24 24"><path d="M5 12l5 5L20 7"/></svg>'
      : '<svg viewBox="0 0 24 24"><path d="M4 20h4l10-10-4-4L4 16z"/><path d="M14 6l4 4"/></svg>';
    $('#note-view').hidden = State.brain.editing;
    $('#note-edit').hidden = !State.brain.editing;
    if (State.brain.editing) {
      $('#note-title').value = n.title || '';
      $('#note-tags').value = (n.tags || []).join(', ');
      $('#note-body').value = n.body || '';
      return;
    }
    const view = $('#note-view');
    view.className = 'note-view md';
    const meta = n.meta || {};
    const chips = Object.keys(meta).filter((k) => meta[k] && k !== 'source')
      .map((k) => '`' + k + ': ' + meta[k] + '`').join(' ');
    view.innerHTML = (window.MD ? MD.render((chips ? chips + '\n\n' : '') + (n.body || '')) : (n.body || ''));
    for (const box of view.querySelectorAll('li.md-task input')) {
      box.disabled = false;
      box.addEventListener('change', () => Brain.toggleTask(box));
    }
  },

  // Ticking a checklist item rewrites that line in the markdown.
  async toggleTask(box) {
    const n = this.current();
    if (!n) return;
    const items = Array.from($('#note-view').querySelectorAll('li.md-task input'));
    const index = items.indexOf(box);
    if (index < 0) return;
    let seen = -1;
    n.body = (n.body || '').split('\n').map((line) => {
      const m = line.match(/^(\s*[-*+]\s*)\[([ xX])\](.*)$/);
      if (!m) return line;
      seen++;
      if (seen !== index) return line;
      return m[1] + '[' + (box.checked ? 'x' : ' ') + ']' + m[3];
    }).join('\n');
    n.updated = Date.now();
    await saveState();
    toast(box.checked ? 'Отмечено' : 'Снято', 'ok');
  },

  toggleEdit() {
    if (State.brain.editing) return this.saveCurrent();
    State.brain.editing = true;
    this.renderNote();
  },

  async saveCurrent() {
    const n = this.current();
    if (!n) return;
    n.title = $('#note-title').value.trim() || 'Без названия';
    n.tags = $('#note-tags').value.split(',').map((s) => s.trim().replace(/^#/, '')).filter(Boolean);
    n.body = $('#note-body').value;
    n.updated = Date.now();
    State.brain.editing = false;
    await saveState();
    this.renderNote();
    this.render();
    toast('Сохранено', 'ok');
  },

  async create() {
    const note = {
      id: 'nt_' + Date.now().toString(36) + Math.random().toString(36).slice(2, 7),
      kind: 'note', title: '', body: '', tags: [], cover: null, pinned: false,
      created: Date.now(), updated: Date.now(), meta: {}, links: []
    };
    State.notes.unshift(note);
    await saveState();
    State.brain.current = note.id;
    State.brain.editing = true;
    go('note');
    this.renderNote();
    setTimeout(() => $('#note-title').focus(), 80);
  },

  async remove() {
    const n = this.current();
    if (!n) return;
    State.notes = State.notes.filter((x) => x.id !== n.id);
    State.removed.notes.push(n.id);
    await saveState();
    back();
    this.render();
    toast('Удалено', 'ok');
  }
};

// ---------------------------------------------------------------------------
// Highlights
// ---------------------------------------------------------------------------

const Marks = {
  render() {
    const colors = $('#mark-colors');
    colors.innerHTML = '';
    for (const c of ['all', 'amber', 'rose', 'mint', 'sky', 'violet']) {
      colors.appendChild(el('button', {
        class: 'chip' + (State.marks.color === c ? ' on' : ''),
        text: c === 'all' ? 'Все' : '',
        style: c === 'all' ? '' : 'background:var(--hl-' + c + ');min-width:40px',
        onclick: () => { State.marks.color = c; Marks.render(); }
      }));
    }
    const list = $('#mark-list');
    list.innerHTML = '';
    const all = [];
    for (const b of State.books) for (const h of b.highlights || []) all.push({ book: b, h });
    const items = all
      .filter((x) => State.marks.color === 'all' || x.h.color === State.marks.color)
      .sort((a, b) => (b.h.created || 0) - (a.h.created || 0));
    if (!items.length) {
      list.appendChild(el('div', { class: 'empty' }, [
        el('div', { class: 'art', text: '🖍' }),
        el('h2', { text: 'Цитат нет' }),
        el('p', { text: 'Выдели текст в книге — он попадёт сюда и на компьютер.' })
      ]));
      return;
    }
    for (const it of items) {
      list.appendChild(el('div', { class: 'mark-card', onclick: () => Reader.open(it.book) }, [
        el('div', { class: 'q ' + (it.h.color || 'amber'), text: it.h.text }),
        it.h.note ? el('div', { class: 'n', text: it.h.note }) : null,
        el('div', { class: 'f' }, [
          el('span', { text: it.book.title }),
          el('span', { text: fmtDate(it.h.created) })
        ])
      ]));
    }
  }
};

// ---------------------------------------------------------------------------
// Sync + notifications
// ---------------------------------------------------------------------------

const Sync = {
  busy: false,

  cfg(silent) {
    const s = State.settings;
    if (!s.token || !s.owner) {
      if (!silent) toast('Сначала впиши токен и владельца в настройках', 'err');
      return null;
    }
    return { token: s.token, owner: s.owner, repo: s.repo || 'lumen-sync', branch: 'main' };
  },

  localState() {
    return {
      version: 1,
      updatedAt: Date.now(),
      books: State.books.map((b) => Object.assign({}, b, { coverData: undefined, localFile: undefined })),
      notes: State.notes,
      collections: State.collections,
      removed: State.removed
    };
  },

  async run(silent) {
    const cfg = this.cfg(silent);
    if (!cfg || this.busy) return;
    this.busy = true;
    const t = silent ? null : toast('Синхронизирую…', 'wait', true);
    try {
      const before = {
        books: new Set(State.books.map((b) => b.id)),
        notes: new Set(State.notes.map((n) => n.id))
      };
      const res = await LumenSync.syncState(cfg, this.localState(), 'lumen android');
      const localFiles = new Map(State.books.map((b) => [b.id, { localFile: b.localFile, coverData: b.coverData }]));
      State.books = res.state.books.map((b) => Object.assign({}, b, localFiles.get(b.id) || {}));
      State.notes = res.state.notes;
      State.collections = res.state.collections;
      State.removed = res.state.removed;
      State.settings.lastSync = Date.now();
      await saveState();
      await saveSettings();

      const newBooks = State.books.filter((b) => !before.books.has(b.id));
      const newNotes = State.notes.filter((n) => !before.notes.has(n.id));
      if (t) t.close();
      if (!silent) {
        toast(newBooks.length || newNotes.length
          ? 'Пришло: книг ' + newBooks.length + ', записей ' + newNotes.length
          : 'Всё совпадает', 'ok');
      }
      if (State.settings.notify && (newBooks.length || newNotes.length)) {
        Notify.say('Lumen: пришли обновления',
          [newBooks.length ? 'книг: ' + newBooks.length : '', newNotes.length ? 'записей: ' + newNotes.length : '']
            .filter(Boolean).join(', '));
      }
      if (State.screen === 'library') Library.render();
      if (State.screen === 'brain') Brain.render();
      if (State.screen === 'marks') Marks.render();
      Settings.status();
    } catch (e) {
      if (t) t.close();
      if (!silent) toast('Синхронизация не прошла: ' + e.message, 'err');
      Settings.status(e.message);
    }
    this.busy = false;
  }
};

const Notify = {
  async ensure() {
    if (!Plugins.LocalNotifications) return false;
    try {
      const res = await Plugins.LocalNotifications.requestPermissions();
      return res.display === 'granted';
    } catch (e) {
      return false;
    }
  },

  async say(title, body) {
    if (!Plugins.LocalNotifications) return;
    if (!(await this.ensure())) return;
    try {
      await Plugins.LocalNotifications.schedule({
        notifications: [{ id: Date.now() % 100000, title, body, schedule: { at: new Date(Date.now() + 1200) } }]
      });
    } catch (e) { /* notifications are optional */ }
  },

  async setReminder(on, time) {
    if (!Plugins.LocalNotifications) return;
    try {
      await Plugins.LocalNotifications.cancel({ notifications: [{ id: 777 }] });
      if (!on) return;
      if (!(await this.ensure())) return;
      const [h, m] = String(time || '20:30').split(':').map(Number);
      const reading = State.books.filter((b) => (b.progress || {}).percent > 0.5 && (b.progress || {}).percent < 98)
        .sort((a, b) => (b.lastOpened || 0) - (a.lastOpened || 0))[0];
      await Plugins.LocalNotifications.schedule({
        notifications: [{
          id: 777,
          title: 'Время почитать',
          body: reading ? 'Продолжить: ' + reading.title + ' (' + Math.round(reading.progress.percent) + '%)' : 'Открой книгу на пару страниц',
          schedule: { on: { hour: h || 20, minute: m || 30 }, repeats: true, allowWhileIdle: true }
        }]
      });
    } catch (e) { /* ignore */ }
  }
};

const Settings = {
  render() {
    const s = State.settings;
    $('#set-token').value = s.token || '';
    $('#set-owner').value = s.owner || '';
    $('#set-repo').value = s.repo || 'lumen-sync';
    $('#set-auto').checked = !!s.auto;
    $('#set-notify').checked = !!s.notify;
    $('#set-remind').checked = !!s.remind;
    $('#set-remind-time').value = s.remindTime || '20:30';
    $('#about-box').innerHTML = 'Lumen Reader для Android<br>Книг: ' + State.books.length
      + ' · записей: ' + State.notes.length
      + ' · цитат: ' + State.books.reduce((n, b) => n + (b.highlights || []).length, 0);
    this.status();
  },

  status(error) {
    const node = $('#set-status');
    if (!node) return;
    node.textContent = error ? 'Ошибка: ' + error
      : (State.settings.lastSync ? 'Последняя синхронизация: ' + new Date(State.settings.lastSync).toLocaleString('ru-RU') : 'Ещё не синхронизировано');
  },

  async save() {
    const s = State.settings;
    s.token = $('#set-token').value.trim();
    s.owner = $('#set-owner').value.trim();
    s.repo = $('#set-repo').value.trim() || 'lumen-sync';
    s.auto = $('#set-auto').checked;
    s.notify = $('#set-notify').checked;
    s.remind = $('#set-remind').checked;
    s.remindTime = $('#set-remind-time').value || '20:30';
    await saveSettings();
    Notify.setReminder(s.remind, s.remindTime);
  }
};

// ---------------------------------------------------------------------------
// Wiring
// ---------------------------------------------------------------------------

$$('.tab').forEach((t) => t.addEventListener('click', () => { State.stack = []; go(t.dataset.go, false); }));
$$('[data-go]').forEach((b) => {
  if (b.classList.contains('tab')) return;
  b.addEventListener('click', () => go(b.dataset.go));
});
$('#back').addEventListener('click', back);
$('#sync-btn').addEventListener('click', () => Sync.run(false));
$('#top-action').addEventListener('click', () => Brain.toggleEdit());

$('#lib-q').addEventListener('input', (e) => { State.filter.q = e.target.value; Library.render(); });
$('#brain-q').addEventListener('input', (e) => { State.brain.q = e.target.value; Brain.render(); });
$('#note-add').addEventListener('click', () => Brain.create());

$('#r-toc').addEventListener('click', () => Reader.toc());
$('#r-prev').addEventListener('click', () => Reader.show(Reader.chapter - 1, 0));
$('#r-next').addEventListener('click', () => Reader.show(Reader.chapter + 1, 0));
$('#r-type').addEventListener('click', () => { $('#type-sheet').hidden = false; });
$$('[data-close-sheet]').forEach((b) => b.addEventListener('click', () => {
  $('#toc-sheet').hidden = true;
  $('#type-sheet').hidden = true;
}));
$('#reader-scroll').addEventListener('scroll', () => { if (Reader.book) Reader.progress(); }, { passive: true });
$('#reader-body').addEventListener('mouseup', () => setTimeout(checkSelection, 10));
document.addEventListener('selectionchange', () => {
  if (State.screen !== 'reader') return;
  clearTimeout(window.__selTimer);
  window.__selTimer = setTimeout(checkSelection, 350);
});

function checkSelection() {
  if (State.screen !== 'reader' || !Reader.book) return;
  const sel = Reader.capture();
  if (!sel) {
    if (!$('#selpop').dataset.hid) Reader.hidePopup();
    return;
  }
  Reader.pending = sel;
  Reader.popup(sel.rect, null);
}

$$('#selpop .dot').forEach((b) => b.addEventListener('click', () => Reader.addMark(b.dataset.color)));
$$('#selpop .pop-act').forEach((b) => b.addEventListener('click', async () => {
  const act = b.dataset.act;
  if (act === 'note') return Reader.noteFor();
  if (act === 'del') return Reader.removeMark();
  if (act === 'copy') {
    const id = $('#selpop').dataset.hid;
    const h = id ? (Reader.book.highlights || []).find((x) => x.id === id) : null;
    const text = h ? h.text : (Reader.pending ? Reader.pending.text : '');
    try { await navigator.clipboard.writeText(text); toast('Скопировано', 'ok'); } catch (e) { toast('Не вышло скопировать', 'err'); }
    Reader.hidePopup();
  }
}));

$('#t-size').addEventListener('input', (e) => { State.settings.fontSize = Number(e.target.value); applyTheme(); saveSettings(); });
$('#t-line').addEventListener('input', (e) => { State.settings.lineHeight = Number(e.target.value); applyTheme(); saveSettings(); });
$('#t-justify').addEventListener('change', (e) => { State.settings.justify = e.target.checked; applyTheme(); saveSettings(); });
$$('#t-theme button').forEach((b) => b.addEventListener('click', () => {
  State.settings.theme = b.dataset.theme;
  $$('#t-theme button').forEach((x) => x.classList.toggle('on', x === b));
  applyTheme();
  saveSettings();
}));

for (const id of ['#set-token', '#set-owner', '#set-repo']) $(id).addEventListener('change', () => Settings.save());
for (const id of ['#set-auto', '#set-notify', '#set-remind', '#set-remind-time']) $(id).addEventListener('change', () => Settings.save());
$('#set-sync').addEventListener('click', async () => { await Settings.save(); Sync.run(false); });
$('#set-test-notify').addEventListener('click', () => Notify.say('Lumen Reader', 'Уведомления работают'));
$('#set-wipe').addEventListener('click', () => {
  modal({
    title: 'Стереть локальные данные?',
    sub: 'Скачанные книги и локальная копия библиотеки пропадут. В облаке всё останется.',
    actions: [
      { label: 'Отмена' },
      {
        label: 'Стереть',
        kind: 'primary',
        action: async () => {
          State.books = [];
          State.notes = [];
          await saveState();
          Library.render();
          toast('Готово', 'ok');
        }
      }
    ]
  });
});
$('#modal-back').addEventListener('click', (e) => { if (e.target.id === 'modal-back') closeModal(); });

if (Plugins.App) {
  Plugins.App.addListener('backButton', () => {
    if (!$('#modal-back').hidden) return closeModal();
    if (!$('#toc-sheet').hidden || !$('#type-sheet').hidden) {
      $('#toc-sheet').hidden = true;
      $('#type-sheet').hidden = true;
      return;
    }
    if (State.stack.length || State.screen !== 'library') return back();
    Plugins.App.exitApp();
  });
  Plugins.App.addListener('appStateChange', (st) => {
    if (st.isActive && State.settings.auto) Sync.run(true);
  });
}

(async function start() {
  await loadState();
  $('#t-size').value = State.settings.fontSize;
  $('#t-line').value = State.settings.lineHeight;
  $('#t-justify').checked = !!State.settings.justify;
  $$('#t-theme button').forEach((b) => b.classList.toggle('on', b.dataset.theme === State.settings.theme));
  go('library', false);
  Settings.render();
  if (State.settings.remind) Notify.setReminder(true, State.settings.remindTime);
  if (State.settings.auto && State.settings.token) Sync.run(true);
})();
