'use strict';

const PALETTES = [
  ['#5a3e2b', '#a6714a'], ['#2f4858', '#5b8a9e'], ['#3d3357', '#7b6aa8'],
  ['#4a2f3a', '#9c5a72'], ['#2d4435', '#639a6f'], ['#4a3d22', '#a08a4a'],
  ['#3a2b45', '#6e5a8c'], ['#263d3d', '#4f8a85']
];

function hashOf(s) {
  let h = 0;
  for (let i = 0; i < s.length; i++) h = (h * 31 + s.charCodeAt(i)) | 0;
  return Math.abs(h);
}

function coverNode(book) {
  const wrap = el('div', { class: 'cover' });
  if (book.coverUrl) {
    wrap.appendChild(el('img', { src: book.coverUrl, loading: 'lazy', alt: '' }));
  } else {
    const p = PALETTES[hashOf(book.title || 'x') % PALETTES.length];
    wrap.style.background = 'linear-gradient(150deg,' + p[1] + ',' + p[0] + ')';
    wrap.appendChild(el('div', { class: 'gen' }, [
      el('b', { text: book.title || 'Без названия' }),
      el('span', { text: (book.authors || []).join(', ') })
    ]));
  }
  wrap.appendChild(el('span', { class: 'fmt', text: book.format || '' }));
  if (book.favorite) {
    wrap.appendChild(el('span', { class: 'fav', html: '<svg viewBox="0 0 24 24" class="ico" style="fill:currentColor;stroke:none"><path d="M12 17l-5.5 3 1-6-4.5-4.3 6.1-.9L12 3l2.9 5.8 6.1.9L16.5 14l1 6z"/></svg>' }));
  }
  const pct = Math.round((book.progress && book.progress.percent) || 0);
  if (pct > 0) wrap.appendChild(el('div', { class: 'pbar' }, [el('i', { style: 'width:' + Math.min(100, pct) + '%' })]));
  return wrap;
}

const Library = {
  filtered() {
    const f = State.lib;
    let list = State.books.slice();
    if (f.collection) list = list.filter((b) => b.collection === f.collection);
    if (f.tag) list = list.filter((b) => (b.tags || []).includes(f.tag));
    if (f.kind === 'reading') list = list.filter((b) => (b.progress.percent || 0) > 0.5 && (b.progress.percent || 0) < 97);
    if (f.kind === 'fav') list = list.filter((b) => b.favorite);
    if (f.kind === 'new') list = list.filter((b) => !b.lastOpened);
    if (f.kind === 'done') list = list.filter((b) => (b.progress.percent || 0) >= 97);
    const by = {
      added: (a, b) => b.added - a.added,
      opened: (a, b) => (b.lastOpened || 0) - (a.lastOpened || 0),
      title: (a, b) => (a.title || '').localeCompare(b.title || '', 'ru'),
      author: (a, b) => ((a.authors || [])[0] || '').localeCompare((b.authors || [])[0] || '', 'ru'),
      progress: (a, b) => (b.progress.percent || 0) - (a.progress.percent || 0)
    };
    return list.sort(by[f.sort] || by.added);
  },

  render() {
    const grid = $('#book-grid');
    const list = this.filtered();
    grid.className = 'book-grid' + (State.lib.layout === 'list' ? ' list' : '');
    grid.innerHTML = '';
    $('#library-empty').hidden = State.books.length > 0;
    $('#library-sub').textContent = State.books.length
      ? State.books.length + ' ' + plural(State.books.length, 'книга', 'книги', 'книг')
        + (State.lib.collection ? ' · коллекция «' + State.lib.collection + '»' : '')
        + (State.lib.tag ? ' · тег #' + State.lib.tag : '')
      : 'Книги, которые ты добавил';

    this.renderContinue();
    this.renderTags();

    list.forEach((book, i) => {
      const card = el('div', { class: 'book', style: 'animation-delay:' + Math.min(i * 22, 420) + 'ms' });
      const cover = coverNode(book);
      cover.appendChild(el('div', { class: 'hover-acts' }, [
        el('button', {
          class: 'icon-btn', title: 'Читать',
          onclick: (e) => { e.stopPropagation(); Reader.open(book.id); }
        }, [el('span', { html: '<svg viewBox="0 0 24 24" class="ico"><path d="M8 5l11 7-11 7z"/></svg>' })]),
        el('button', {
          class: 'icon-btn', title: book.favorite ? 'Убрать из избранного' : 'В избранное',
          onclick: async (e) => {
            e.stopPropagation();
            book.favorite = !book.favorite;
            await L.updateBook(book.id, { favorite: book.favorite });
            Library.render();
          }
        }, [el('span', { html: '<svg viewBox="0 0 24 24" class="ico"><path d="M12 17l-5.5 3 1-6-4.5-4.3 6.1-.9L12 3l2.9 5.8 6.1.9L16.5 14l1 6z"/></svg>' })]),
        el('button', {
          class: 'icon-btn', title: 'Карточка книги',
          onclick: (e) => { e.stopPropagation(); Library.details(book); }
        }, [el('span', { html: '<svg viewBox="0 0 24 24" class="ico"><circle cx="12" cy="12" r="9"/><path d="M12 11v5M12 8h.01"/></svg>' })])
      ]));
      card.appendChild(cover);
      const pct = Math.round(book.progress.percent || 0);
      card.appendChild(el('div', { class: 'book-meta' }, [
        el('b', { text: book.title }),
        el('span', { text: (book.authors || []).join(', ') || 'без автора' }),
        el('span', {
          class: 'muted',
          text: (pct > 0 ? pct + '% · ' : '') + (book.stats ? book.stats.minutes + ' мин' : fmtDate(book.added))
            + ((book.highlights || []).length ? ' · ' + book.highlights.length + ' выдел.' : '')
        })
      ]));
      if (book.remoteOnly) cover.appendChild(el('span', { class: 'remote-tag', text: 'на другом устройстве' }));
      card.addEventListener('click', () => {
        if (book.remoteOnly) return Sync.fetchBook(book);
        Reader.open(book.id);
      });
      card.addEventListener('contextmenu', (e) => { e.preventDefault(); Library.details(book); });
      grid.appendChild(card);
    });

    if (State.books.length && !list.length) {
      grid.appendChild(el('div', { class: 'muted', text: 'Под этот фильтр ничего не подошло.' }));
    }
  },

  renderContinue() {
    const row = $('#shelf-continue');
    row.innerHTML = '';
    if (State.lib.collection || State.lib.tag || State.lib.kind !== 'all') return;
    const recent = State.books
      .filter((b) => b.lastOpened && (b.progress.percent || 0) < 99)
      .sort((a, b) => b.lastOpened - a.lastOpened)
      .slice(0, 4);
    if (!recent.length) return;
    for (const b of recent) {
      const mini = el('div', { class: 'mini-cover' });
      if (b.coverUrl) mini.appendChild(el('img', { src: b.coverUrl, alt: '' }));
      else {
        const p = PALETTES[hashOf(b.title) % PALETTES.length];
        mini.style.background = 'linear-gradient(150deg,' + p[1] + ',' + p[0] + ')';
      }
      row.appendChild(el('div', { class: 'cont-card', onclick: () => Reader.open(b.id) }, [
        mini,
        el('div', { class: 'cont-info' }, [
          el('b', { text: b.title }),
          el('span', { text: 'Продолжить · ' + Math.round(b.progress.percent || 0) + '%' }),
          el('div', { class: 'bar' }, [el('i', { style: 'width:' + Math.min(100, b.progress.percent || 0) + '%' })])
        ])
      ]));
    }
  },

  renderTags() {
    const row = $('#tag-filter');
    row.innerHTML = '';
    const counts = {};
    for (const b of State.books) for (const t of b.tags || []) counts[t] = (counts[t] || 0) + 1;
    const tags = Object.keys(counts).sort((a, b) => counts[b] - counts[a]).slice(0, 18);
    if (!tags.length) return;
    for (const t of tags) {
      row.appendChild(el('button', {
        class: 'chip' + (State.lib.tag === t ? ' on' : ''),
        text: '#' + t + ' · ' + counts[t],
        onclick: () => { State.lib.tag = State.lib.tag === t ? '' : t; Library.render(); }
      }));
    }
  },

  details(book) {
    const title = el('input', { class: 'input', value: book.title });
    const authors = el('input', { class: 'input', value: (book.authors || []).join(', ') });
    const tags = el('input', { class: 'input', value: (book.tags || []).join(', '), placeholder: 'фантастика, долг, 2026' });
    const collections = Array.from(new Set(State.collections.concat(State.books.map((b) => b.collection).filter(Boolean))));
    const coll = el('select', { class: 'select' }, [el('option', { value: '', text: '— без коллекции —' })]
      .concat(collections.map((c) => el('option', { value: c, text: c, selected: c === book.collection }))));
    const notes = el('textarea', { placeholder: 'Твои мысли о книге…' });
    notes.value = book.notes || '';

    const field = (label, node) => el('label', { class: 'field' }, [el('span', { text: label }), node]);

    const info = el('p', {
      class: 'sub',
      text: [book.format ? book.format.toUpperCase() : '', book.year, book.lang,
        book.stats ? book.stats.chapters + ' глав · ' + book.stats.words.toLocaleString('ru-RU') + ' слов · ~' + book.stats.minutes + ' мин' : '',
        'добавлено ' + fmtDate(book.added),
        (book.highlights || []).length + ' выделений'].filter(Boolean).join(' · ')
    });

    modal({
      title: 'Карточка книги',
      body: [
        info,
        field('Название', title),
        field('Авторы (через запятую)', authors),
        field('Теги', tags),
        field('Коллекция', coll),
        field('Заметка о книге', notes),
        book.annotation ? el('div', { class: 'quote', text: book.annotation }) : null,
        el('div', { class: 'row', style: 'margin-top:12px;flex-wrap:wrap' }, [
          el('button', {
            class: 'btn ghost small', text: 'Сменить обложку',
            onclick: async () => {
              const updated = await L.setCover(book.id);
              if (updated) {
                Object.assign(book, updated);
                toast('Обложка обновлена', 'ok');
                Library.render();
              }
            }
          }),
          book.remoteOnly
            ? el('button', { class: 'btn primary small', text: 'Скачать с другого устройства', onclick: () => { closeModal(); Sync.fetchBook(book); } })
            : el('button', { class: 'btn ghost small', text: 'Отправить на телефон', onclick: () => { closeModal(); Sync.sendBook(book); } }),
          book.remoteOnly ? null : el('button', { class: 'btn ghost small', text: 'Показать файл', onclick: () => L.reveal(book.file) }),
          el('button', {
            class: 'btn danger small', text: 'Удалить',
            onclick: async () => {
              closeModal();
              const yes = await confirm2('Удалить «' + book.title + '»?', 'Файл книги и обложка будут удалены из библиотеки Lumen.');
              if (!yes) return;
              await L.deleteBook(book.id, true);
              await refreshState();
              Library.render();
              toast('Удалено', 'ok');
            }
          })
        ])
      ],
      actions: [
        { label: 'Закрыть' },
        {
          label: 'Сохранить',
          kind: 'primary',
          action: async () => {
            const patch = {
              title: title.value.trim() || book.title,
              authors: authors.value.split(',').map((s) => s.trim()).filter(Boolean),
              tags: tags.value.split(',').map((s) => s.trim().replace(/^#/, '')).filter(Boolean),
              collection: coll.value,
              notes: notes.value
            };
            Object.assign(book, await L.updateBook(book.id, patch));
            if (patch.collection && !State.collections.includes(patch.collection)) {
              State.collections.push(patch.collection);
              await L.setCollections(State.collections);
            }
            renderCollections();
            Library.render();
            toast('Сохранено', 'ok');
          }
        }
      ]
    });
  }
};

// ---------- highlights view ----------
const Highlights = {
  filter: { color: 'all', query: '' },

  all() {
    const out = [];
    for (const b of State.books) {
      for (const h of b.highlights || []) out.push({ book: b, hl: h });
    }
    return out.sort((a, b) => (b.hl.created || 0) - (a.hl.created || 0));
  },

  render() {
    const box = $('#hl-groups');
    box.innerHTML = '';
    const q = this.filter.query.toLowerCase();
    let items = this.all();
    if (this.filter.color !== 'all') items = items.filter((x) => x.hl.color === this.filter.color);
    if (q) items = items.filter((x) => (x.hl.text || '').toLowerCase().includes(q) || (x.hl.note || '').toLowerCase().includes(q));

    if (!items.length) {
      box.appendChild(el('div', { class: 'empty' }, [
        el('div', { class: 'empty-art', text: '🖍' }),
        el('h2', { text: 'Выделений пока нет' }),
        el('p', { text: 'Открой книгу, выдели текст мышкой — появится палитра цветов и кнопка заметки.' })
      ]));
      return;
    }

    const groups = new Map();
    for (const it of items) {
      if (!groups.has(it.book.id)) groups.set(it.book.id, { book: it.book, list: [] });
      groups.get(it.book.id).list.push(it.hl);
    }

    for (const g of groups.values()) {
      const cards = el('div', { class: 'hl-cols' });
      for (const h of g.list) cards.appendChild(this.card(g.book, h));
      box.appendChild(el('div', { class: 'hl-group' }, [
        el('h3', {}, [
          el('span', { text: g.book.title }),
          el('em', { text: g.list.length + ' ' + plural(g.list.length, 'цитата', 'цитаты', 'цитат') }),
          el('button', {
            class: 'btn ghost small', text: 'В «Второй мозг»',
            onclick: () => Brain.fromBook(g.book, g.list)
          })
        ]),
        cards
      ]));
    }
  },

  card(book, h) {
    return el('div', {
      class: 'hl-card',
      onclick: () => Reader.open(book.id, { chapter: h.chapter, offset: h.start })
    }, [
      el('div', { class: 'q ' + (h.color || 'amber'), text: h.text }),
      h.note ? el('div', { class: 'n', text: h.note }) : null,
      el('div', { class: 'f' }, [
        el('span', { text: (h.chapterTitle || '') + ' · ' + fmtDate(h.created) }),
        el('span', { class: 'grow' }),
        el('button', {
          text: 'заметка',
          onclick: (e) => { e.stopPropagation(); Reader.editNote(book, h, () => Highlights.render()); }
        }),
        el('button', {
          text: 'в мозг',
          onclick: (e) => { e.stopPropagation(); Brain.fromBook(book, [h]); }
        }),
        el('button', {
          text: 'удалить',
          onclick: async (e) => {
            e.stopPropagation();
            book.highlights = await L.deleteHighlight(book.id, h.id);
            updateCounts();
            Highlights.render();
          }
        })
      ])
    ]);
  },

  exportMd() {
    const lines = ['# Мои выделения', ''];
    const groups = new Map();
    for (const it of this.all()) {
      if (!groups.has(it.book.id)) groups.set(it.book.id, { book: it.book, list: [] });
      groups.get(it.book.id).list.push(it.hl);
    }
    for (const g of groups.values()) {
      lines.push('## ' + g.book.title);
      if ((g.book.authors || []).length) lines.push('*' + g.book.authors.join(', ') + '*', '');
      for (const h of g.list) {
        lines.push('> ' + String(h.text).replace(/\n/g, '\n> '));
        if (h.note) lines.push('', '**Заметка:** ' + h.note);
        lines.push('');
      }
    }
    return lines.join('\n');
  }
};
