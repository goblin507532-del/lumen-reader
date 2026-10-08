'use strict';

// ---------- text offset plumbing ----------
function textNodes(root) {
  const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT, {
    acceptNode: (n) => (n.nodeValue && n.nodeValue.length ? NodeFilter.FILTER_ACCEPT : NodeFilter.FILTER_REJECT)
  });
  const out = [];
  let n;
  while ((n = walker.nextNode())) out.push(n);
  return out;
}

// Works for both text-node and element boundaries (double-click selections
// and selectNodeContents hand back element containers).
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
  try {
    probe.setEnd(node, nodeOffset);
  } catch (e) {
    return 0;
  }
  return probe.toString().length;
}

function rangeFromOffsets(root, start, end) {
  const nodes = textNodes(root);
  let pos = 0;
  const range = document.createRange();
  let started = false;
  for (const t of nodes) {
    const len = t.nodeValue.length;
    if (!started && start < pos + len) {
      range.setStart(t, Math.max(0, start - pos));
      started = true;
    }
    if (started && end <= pos + len) {
      range.setEnd(t, Math.max(0, end - pos));
      return range;
    }
    pos += len;
  }
  if (started && nodes.length) {
    const last = nodes[nodes.length - 1];
    range.setEnd(last, last.nodeValue.length);
    return range;
  }
  return null;
}

function wrapOffsets(root, start, end, className, dataset) {
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
    mark.className = className;
    Object.assign(mark.dataset, dataset || {});
    node.parentNode.insertBefore(mark, node);
    mark.appendChild(node);
    marks.push(mark);
  }
  return marks;
}

function unwrapMarks(root, selector) {
  for (const m of Array.from(root.querySelectorAll(selector))) {
    const parent = m.parentNode;
    while (m.firstChild) parent.insertBefore(m.firstChild, m);
    parent.removeChild(m);
    parent.normalize();
  }
}

// ---------- reader ----------
const Reader = {
  book: null,
  chapters: [],
  notes: {},
  chapter: 0,
  lengths: [],
  total: 0,
  pendingSel: null,
  saveTimer: null,

  async open(bookId, locate) {
    const t = toast('Открываю книгу…', 'wait', true);
    try {
      const res = await L.openBook(bookId);
      t.close();
      if (res.external === 'pdf') {
        toast('PDF открыт в отдельном окне', 'ok');
        await refreshState();
        return;
      }
      this.book = res.book;
      const stateBook = State.books.find((b) => b.id === bookId);
      if (stateBook) Object.assign(stateBook, res.book);
      this.chapters = res.chapters;
      this.notes = res.notes || {};
      this.lengths = this.chapters.map((c) => c.html.replace(/<[^>]*>/g, '').length || 1);
      this.total = this.lengths.reduce((a, b) => a + b, 0);
      $('#rd-book-title').textContent = this.book.title;
      go('reader');
      this.closePanels();
      const target = locate || this.book.progress || { chapter: 0, offset: 0 };
      this.showChapter(Math.min(target.chapter || 0, this.chapters.length - 1), target.offset || 0);
      this.renderToc();
      this.renderBookHighlights();
    } catch (e) {
      t.close();
      toast(e.message, 'err');
    }
  },

  content() { return $('#reader-content'); },
  scroller() { return $('#reader-scroll'); },

  showChapter(index, offset) {
    this.chapter = Math.max(0, Math.min(index, this.chapters.length - 1));
    const ch = this.chapters[this.chapter];
    const content = this.content();
    content.innerHTML = ch ? ch.html : '';
    content.classList.toggle('justify', !!State.settings.justify);
    $('#rd-chapter-title').textContent = (ch ? ch.title : '') + ' · ' + (this.chapter + 1) + '/' + this.chapters.length;
    this.applyMode();
    this.applyHighlights();
    this.hookLinks();
    this.renderToc();
    requestAnimationFrame(() => {
      if (offset > 0) this.scrollToOffset(offset);
      else this.scrollHome();
      this.updateProgress();
      if (window.Translator && Translator.info) Translator.restore();
    });
  },

  applyMode() {
    const paged = !!State.settings.paged;
    const scroller = this.scroller();
    const content = this.content();
    scroller.classList.toggle('paged', paged);
    if (!paged) {
      content.style.padding = '';
      content.style.columnCount = '';
      content.style.columnGap = '';
      return;
    }
    // A column group advances by (content width + gap). Side padding must be
    // half the gap, otherwise one scroll of clientWidth lands between pages.
    const want = Math.max(360, State.settings.pageWidth || 760);
    const avail = scroller.clientWidth;
    const count = Math.max(1, Math.min(2, Math.floor(avail / (want + 68))));
    // Solve for the padding that makes every column exactly `want` wide.
    const pad = Math.max(34, Math.round((avail - count * want) / (2 * count)));
    const gap = pad * 2;
    content.style.columnCount = String(count);
    content.style.columnGap = gap + 'px';
    content.style.padding = '42px ' + pad + 'px 24px';
  },

  scrollHome() {
    const s = this.scroller();
    if (State.settings.paged) s.scrollLeft = 0;
    else s.scrollTop = 0;
  },

  scrollToOffset(offset) {
    const content = this.content();
    const range = rangeFromOffsets(content, offset, Math.min(offset + 1, offset + 1));
    if (!range) return;
    const s = this.scroller();
    if (State.settings.paged) {
      s.scrollLeft = 0;
      const box = range.getBoundingClientRect();
      const host = s.getBoundingClientRect();
      const x = box.left - host.left + s.scrollLeft;
      const page = Math.floor(x / Math.max(1, s.clientWidth));
      s.scrollLeft = page * s.clientWidth;
    } else {
      const box = range.getBoundingClientRect();
      const host = s.getBoundingClientRect();
      s.scrollTop = s.scrollTop + (box.top - host.top) - 90;
    }
  },

  // Highlights -------------------------------------------------------------
  applyHighlights() {
    const content = this.content();
    unwrapMarks(content, 'mark.hl');
    const list = (this.book.highlights || []).filter((h) => h.chapter === this.chapter);
    list.sort((a, b) => b.start - a.start);
    for (const h of list) {
      try {
        wrapOffsets(content, h.start, h.end, 'hl ' + (h.color || 'amber') + (h.note ? ' has-note' : ''), { hlId: h.id });
      } catch (e) { /* layout shifted: skip this one */ }
    }
    for (const m of content.querySelectorAll('mark.hl')) {
      m.addEventListener('click', (e) => {
        e.stopPropagation();
        const h = (this.book.highlights || []).find((x) => x.id === m.dataset.hlId);
        if (h) this.showSelPop(m.getBoundingClientRect(), h);
      });
    }
  },

  showSelPop(rect, existing) {
    const pop = $('#sel-pop');
    pop.hidden = false;
    const w = pop.offsetWidth || 250;
    const stage = $('#reader-stage').getBoundingClientRect();
    let left = rect.left + rect.width / 2 - w / 2 - stage.left;
    left = Math.max(10, Math.min(left, stage.width - w - 10));
    let top = rect.top - stage.top - pop.offsetHeight - 12;
    if (top < 6) top = rect.bottom - stage.top + 10;
    pop.style.left = left + 'px';
    pop.style.top = top + 'px';
    pop.dataset.mode = existing ? 'edit' : 'new';
    pop.dataset.hlId = existing ? existing.id : '';
    $('[data-act=clear]', pop).hidden = !existing;
    $$('.hl-color', pop).forEach((b) => b.style.outline = existing && existing.color === b.dataset.color ? '2px solid currentColor' : '');
  },

  hideSelPop() {
    const pop = $('#sel-pop');
    pop.hidden = true;
    pop.dataset.hlId = '';
  },

  captureSelection() {
    const sel = window.getSelection();
    if (!sel || sel.isCollapsed || !sel.rangeCount) return null;
    const content = this.content();
    const range = sel.getRangeAt(0);
    if (!content.contains(range.commonAncestorContainer)) return null;
    const text = sel.toString().trim();
    if (text.length < 1) return null;
    const start = offsetOf(content, range.startContainer, range.startOffset);
    const end = offsetOf(content, range.endContainer, range.endOffset);
    if (end <= start) return null;
    return { start, end, text, rect: range.getBoundingClientRect() };
  },

  async addHighlight(color) {
    const pop = $('#sel-pop');
    if (pop.dataset.hlId) {
      const h = (this.book.highlights || []).find((x) => x.id === pop.dataset.hlId);
      if (h) {
        h.color = color;
        this.book.highlights = await L.saveHighlight(this.book.id, h);
        this.afterHighlightChange();
      }
      return;
    }
    const sel = this.pendingSel;
    if (!sel) return;
    const ch = this.chapters[this.chapter];
    this.book.highlights = await L.saveHighlight(this.book.id, {
      chapter: this.chapter,
      chapterTitle: ch ? ch.title : '',
      start: sel.start,
      end: sel.end,
      text: sel.text,
      color: color,
      note: ''
    });
    this.afterHighlightChange();
    window.getSelection().removeAllRanges();
  },

  afterHighlightChange() {
    const b = State.books.find((x) => x.id === this.book.id);
    if (b) b.highlights = this.book.highlights;
    updateCounts();
    this.applyHighlights();
    this.renderBookHighlights();
    this.hideSelPop();
  },

  currentHighlight() {
    const id = $('#sel-pop').dataset.hlId;
    return id ? (this.book.highlights || []).find((x) => x.id === id) : null;
  },

  editNote(book, h, done) {
    const area = el('textarea', { placeholder: 'Что важного в этой цитате?' });
    area.value = h.note || '';
    modal({
      title: 'Заметка к цитате',
      body: [el('div', { class: 'quote', text: h.text }), area],
      actions: [
        { label: 'Отмена' },
        {
          label: 'Сохранить',
          kind: 'primary',
          action: async () => {
            h.note = area.value.trim();
            const list = await L.saveHighlight(book.id, h);
            book.highlights = list;
            if (Reader.book && Reader.book.id === book.id) {
              Reader.book.highlights = list;
              Reader.applyHighlights();
              Reader.renderBookHighlights();
            }
            const sb = State.books.find((x) => x.id === book.id);
            if (sb) sb.highlights = list;
            if (done) done();
            toast('Заметка сохранена', 'ok');
          }
        }
      ]
    });
  },

  // Panels ----------------------------------------------------------------
  closePanels() {
    $$('.rd-panel').forEach((p) => p.classList.remove('open'));
    $('#type-pop').hidden = true;
    $$('.rd-tools .icon-btn, #rd-toc').forEach((b) => b.classList.remove('active'));
  },

  togglePanel(id, btn) {
    const panel = $(id);
    const open = panel.classList.contains('open');
    this.closePanels();
    if (!open) {
      panel.classList.add('open');
      if (btn) btn.classList.add('active');
      const input = panel.querySelector('input');
      if (input) setTimeout(() => input.focus(), 120);
    }
  },

  renderToc() {
    const box = $('#toc-list');
    if (!box) return;
    box.innerHTML = '';
    this.chapters.forEach((c, i) => {
      box.appendChild(el('button', {
        class: 'toc-item' + (i === this.chapter ? ' current' : '') + (c.part ? ' part' : ''),
        onclick: () => { this.showChapter(i, 0); this.closePanels(); }
      }, [
        el('em', { text: Math.round((this.lengths[i] / 180) || 0) + ' мин' }),
        el('span', { text: c.title || 'Глава ' + (i + 1) })
      ]));
    });
    const cur = box.querySelector('.current');
    if (cur) cur.scrollIntoView({ block: 'center' });
  },

  renderBookHighlights() {
    const box = $('#book-hl-list');
    if (!box) return;
    box.innerHTML = '';
    const list = (this.book.highlights || []).slice().sort((a, b) => a.chapter - b.chapter || a.start - b.start);
    if (!list.length) {
      box.appendChild(el('div', { class: 'muted small', text: 'Выдели текст в книге — цитата появится здесь.' }));
      return;
    }
    box.appendChild(el('button', {
      class: 'btn ghost small', style: 'margin-bottom:10px;width:100%',
      text: 'Собрать всё в запись «Второго мозга»',
      onclick: () => Brain.fromBook(this.book, list)
    }));
    for (const h of list) box.appendChild(Highlights.card(this.book, h));
  },

  async runFind(query) {
    const box = $('#find-results');
    box.innerHTML = '';
    if (query.trim().length < 2) return;
    const hits = await L.searchInside(this.book.id, query);
    if (!hits.length) {
      box.appendChild(el('div', { class: 'muted small', text: 'Ничего не найдено' }));
      return;
    }
    box.appendChild(el('div', { class: 'muted small', text: hits.length + ' совпадений' }));
    for (const h of hits.slice(0, 120)) {
      const idx = h.snippet.toLowerCase().indexOf(query.toLowerCase());
      const html = idx < 0 ? esc(h.snippet)
        : esc(h.snippet.slice(0, idx)) + '<b>' + esc(h.snippet.slice(idx, idx + query.length)) + '</b>' + esc(h.snippet.slice(idx + query.length));
      box.appendChild(el('button', {
        class: 'find-hit',
        onclick: () => {
          this.showChapter(h.chapter, h.offset);
          setTimeout(() => {
            const marks = wrapOffsets(this.content(), h.offset, h.offset + query.length, 'find-hit', {});
            setTimeout(() => unwrapMarks(this.content(), 'mark.find-hit'), 2600);
            if (marks[0]) marks[0].scrollIntoView({ block: 'center', behavior: 'smooth' });
          }, 60);
        }
      }, [el('em', { text: h.chapterTitle }), el('span', { html })]));
    }
  },

  hookLinks() {
    const content = this.content();
    for (const a of content.querySelectorAll('a.note-ref')) {
      a.addEventListener('click', (e) => {
        e.preventDefault();
        const text = this.notes[a.dataset.note];
        if (text) modal({ title: 'Примечание', body: [el('div', { class: 'quote', text })], actions: [{ label: 'Закрыть' }] });
        else toast('Примечание не найдено', 'err');
      });
    }
    for (const a of content.querySelectorAll('a.ext-link')) {
      a.addEventListener('click', (e) => { e.preventDefault(); if (a.dataset.href) L.openExternal(a.dataset.href); });
    }
  },

  // Navigation ------------------------------------------------------------
  pageCount() {
    const s = this.scroller();
    return Math.max(1, Math.round(s.scrollWidth / Math.max(1, s.clientWidth)));
  },

  next() {
    const s = this.scroller();
    if (State.settings.paged) {
      if (s.scrollLeft + s.clientWidth * 1.5 < s.scrollWidth) {
        s.scrollLeft = (Math.round(s.scrollLeft / s.clientWidth) + 1) * s.clientWidth;
        this.updateProgress();
        return;
      }
    } else if (s.scrollTop + s.clientHeight * 1.6 < s.scrollHeight) {
      s.scrollTop += s.clientHeight * 0.92;
      this.updateProgress();
      return;
    }
    if (this.chapter < this.chapters.length - 1) this.showChapter(this.chapter + 1, 0);
    else toast('Это конец книги', 'ok');
  },

  prev() {
    const s = this.scroller();
    if (State.settings.paged) {
      if (s.scrollLeft > 4) {
        s.scrollLeft = Math.max(0, (Math.round(s.scrollLeft / s.clientWidth) - 1) * s.clientWidth);
        this.updateProgress();
        return;
      }
    } else if (s.scrollTop > 4) {
      s.scrollTop -= s.clientHeight * 0.92;
      this.updateProgress();
      return;
    }
    if (this.chapter > 0) {
      this.showChapter(this.chapter - 1, 0);
      requestAnimationFrame(() => {
        const sc = this.scroller();
        if (State.settings.paged) sc.scrollLeft = sc.scrollWidth;
        else sc.scrollTop = sc.scrollHeight;
        this.updateProgress();
      });
    }
  },

  localFraction() {
    const s = this.scroller();
    if (State.settings.paged) {
      const span = Math.max(1, s.scrollWidth - s.clientWidth);
      return s.scrollWidth <= s.clientWidth ? 0 : Math.min(1, s.scrollLeft / span);
    }
    const span = Math.max(1, s.scrollHeight - s.clientHeight);
    return s.scrollHeight <= s.clientHeight ? 0 : Math.min(1, s.scrollTop / span);
  },

  currentOffset() {
    const content = this.content();
    const nodes = textNodes(content);
    if (!nodes.length) return 0;
    const s = this.scroller();
    const host = s.getBoundingClientRect();
    let pos = 0;
    for (const t of nodes) {
      const range = document.createRange();
      range.selectNodeContents(t);
      const box = range.getBoundingClientRect();
      const visible = State.settings.paged
        ? box.right > host.left + 2 && box.left < host.right - 2
        : box.bottom > host.top + 2 && box.top < host.bottom - 2;
      if (visible) return pos;
      pos += t.nodeValue.length;
    }
    return 0;
  },

  updateProgress() {
    if (!this.chapters.length) return;
    const before = this.lengths.slice(0, this.chapter).reduce((a, b) => a + b, 0);
    const frac = this.localFraction();
    const percent = Math.min(100, ((before + frac * this.lengths[this.chapter]) / this.total) * 100);
    const s = this.scroller();
    const pageInfo = State.settings.paged && s.scrollWidth > s.clientWidth
      ? ' · стр. ' + (Math.round(s.scrollLeft / s.clientWidth) + 1) + '/' + this.pageCount()
      : '';
    $('#progress-label').textContent = Math.round(percent) + '%' + pageInfo;
    const range = $('#book-progress');
    range.value = Math.round(percent * 10);
    range.style.setProperty('--p', percent + '%');
    this.queueSave(percent);
  },

  queueSave(percent) {
    if (this.saveTimer) clearTimeout(this.saveTimer);
    this.saveTimer = setTimeout(async () => {
      this.saveTimer = null;
      if (!this.book) return;
      const progress = { chapter: this.chapter, offset: this.currentOffset(), percent };
      this.book.progress = progress;
      const b = State.books.find((x) => x.id === this.book.id);
      if (b) { b.progress = progress; b.lastOpened = Date.now(); }
      try { await L.saveProgress(this.book.id, progress); } catch (e) { /* ignore */ }
    }, 900);
  },

  seek(permille) {
    const target = (permille / 1000) * this.total;
    let acc = 0;
    for (let i = 0; i < this.lengths.length; i++) {
      if (acc + this.lengths[i] >= target || i === this.lengths.length - 1) {
        const inner = Math.max(0, target - acc);
        this.showChapter(i, Math.round(inner));
        return;
      }
      acc += this.lengths[i];
    }
  },

  async toggleBookmark() {
    const offset = this.currentOffset();
    const list = (this.book.bookmarks || []).slice();
    const near = list.findIndex((m) => m.chapter === this.chapter && Math.abs(m.offset - offset) < 400);
    if (near >= 0) {
      list.splice(near, 1);
      toast('Закладка снята', 'ok');
    } else {
      const ch = this.chapters[this.chapter];
      list.push({ chapter: this.chapter, offset, title: ch ? ch.title : '', created: Date.now() });
      toast('Закладка поставлена', 'ok');
    }
    this.book.bookmarks = list;
    await L.updateBook(this.book.id, { bookmarks: list });
    const b = State.books.find((x) => x.id === this.book.id);
    if (b) b.bookmarks = list;
    $('#rd-bookmark').classList.toggle('active', near < 0);
  }
};
