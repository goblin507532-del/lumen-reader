'use strict';

const KINDS = {
  recipe: { icon: '🍳', label: 'Рецепт' },
  guide: { icon: '🧭', label: 'Гайд' },
  note: { icon: '📝', label: 'Заметка' },
  idea: { icon: '💡', label: 'Идея' }
};

const FIELDS = {
  recipe: [
    { key: 'time', label: 'Время', placeholder: '40 мин' },
    { key: 'servings', label: 'Порции', placeholder: '4' },
    { key: 'difficulty', label: 'Сложность', placeholder: 'средне' },
    { key: 'cuisine', label: 'Кухня', placeholder: 'итальянская' }
  ],
  guide: [
    { key: 'time', label: 'Время', placeholder: '2 часа' },
    { key: 'level', label: 'Уровень', placeholder: 'новичок' },
    { key: 'source', label: 'Источник', placeholder: 'ссылка или книга' }
  ],
  note: [{ key: 'source', label: 'Источник', placeholder: 'откуда это' }],
  idea: [{ key: 'status', label: 'Статус', placeholder: 'обдумываю' }]
};

const TEMPLATES = {
  recipe: [
    '## Ингредиенты',
    '',
    '- [ ] ',
    '- [ ] ',
    '- [ ] ',
    '',
    '## Шаги',
    '',
    '1. ',
    '2. ',
    '3. ',
    '',
    '## Заметки',
    '',
    '> Что поменять в следующий раз',
    ''
  ].join('\n'),
  guide: [
    '## Зачем это нужно',
    '',
    '',
    '## Что понадобится',
    '',
    '- ',
    '- ',
    '',
    '## Пошагово',
    '',
    '1. ',
    '2. ',
    '3. ',
    '',
    '## Чек-лист',
    '',
    '- [ ] ',
    '- [ ] ',
    '',
    '## Подводные камни',
    '',
    '> ',
    ''
  ].join('\n'),
  note: ''
};

const Brain = {
  saveTimer: null,

  kindLabel(kind) {
    return (KINDS[kind] || KINDS.note).icon;
  },

  list() {
    const f = State.brain;
    let items = State.notes.slice();
    if (f.kind !== 'all') items = items.filter((n) => n.kind === f.kind);
    if (f.tag) items = items.filter((n) => (n.tags || []).includes(f.tag));
    const q = f.query.toLowerCase().trim();
    if (q) {
      items = items.filter((n) => (n.title || '').toLowerCase().includes(q)
        || (n.body || '').toLowerCase().includes(q)
        || (n.tags || []).join(' ').toLowerCase().includes(q));
    }
    return items.sort((a, b) => (b.pinned ? 1 : 0) - (a.pinned ? 1 : 0) || (b.updated || 0) - (a.updated || 0));
  },

  render() {
    const box = $('#brain-items');
    box.innerHTML = '';
    const items = this.list();
    if (!items.length) {
      box.appendChild(el('div', { class: 'muted small', style: 'padding:14px 6px', text: State.notes.length ? 'Под фильтр ничего не подошло.' : 'Записей пока нет — начни с шаблона справа.' }));
    }
    for (const n of items) {
      const thumb = el('div', { class: 'nb-thumb' });
      if (n.cover) thumb.appendChild(el('img', { src: n.cover, alt: '' }));
      else thumb.textContent = (KINDS[n.kind] || KINDS.note).icon;
      box.appendChild(el('div', {
        class: 'nb-card' + (State.brain.current === n.id ? ' active' : ''),
        onclick: () => this.select(n.id)
      }, [
        thumb,
        el('div', { class: 'nb-body' }, [
          el('b', { text: n.title || 'Без названия' }),
          el('p', { text: (window.MD ? MD.plainText(n.body) : n.body || '').slice(0, 120) }),
          (n.tags || []).length ? el('div', { class: 'tags' }, n.tags.slice(0, 4).map((t) => el('i', { text: '#' + t }))) : null
        ]),
        n.pinned ? el('span', { class: 'nb-pin', text: '★' }) : null
      ]));
    }
    this.renderTags();
  },

  renderTags() {
    const row = $('#brain-tags');
    row.innerHTML = '';
    const counts = {};
    for (const n of State.notes) for (const t of n.tags || []) counts[t] = (counts[t] || 0) + 1;
    const tags = Object.keys(counts).sort((a, b) => counts[b] - counts[a]).slice(0, 14);
    for (const t of tags) {
      row.appendChild(el('button', {
        class: 'chip' + (State.brain.tag === t ? ' on' : ''),
        text: '#' + t,
        onclick: () => { State.brain.tag = State.brain.tag === t ? '' : t; this.render(); }
      }));
    }
  },

  current() {
    return State.notes.find((n) => n.id === State.brain.current) || null;
  },

  select(id) {
    State.brain.current = id;
    go('brain');
    const n = this.current();
    $('#be-empty').hidden = !!n;
    $('#be-main').hidden = !n;
    if (!n) { this.render(); return; }
    $('#be-title').value = n.title || '';
    $('#be-kind').value = n.kind || 'note';
    $('#be-tags').value = (n.tags || []).join(', ');
    $('#be-body').value = n.body || '';
    $('#be-pin').classList.toggle('active', !!n.pinned);
    const img = $('#be-cover-img');
    if (n.cover) { img.src = n.cover; img.hidden = false; $('#be-cover-empty').hidden = true; $('#be-cover-clear').hidden = false; }
    else { img.hidden = true; img.removeAttribute('src'); $('#be-cover-empty').hidden = false; $('#be-cover-clear').hidden = true; }
    this.renderFields(n);
    this.renderPreview();
    this.render();
  },

  renderFields(note) {
    const box = $('#be-fields');
    box.innerHTML = '';
    for (const f of FIELDS[note.kind] || []) {
      const input = el('input', {
        value: (note.meta || {})[f.key] || '',
        placeholder: f.placeholder,
        oninput: () => {
          note.meta = note.meta || {};
          note.meta[f.key] = input.value;
          this.queueSave();
        }
      });
      box.appendChild(el('label', {}, [el('span', { text: f.label }), input]));
    }
  },

  renderPreview() {
    const n = this.current();
    if (!n) return;
    const body = $('#be-body').value;
    const meta = n.meta || {};
    const chips = (FIELDS[n.kind] || []).filter((f) => meta[f.key])
      .map((f) => '`' + f.label + ': ' + meta[f.key] + '`').join(' ');
    const head = '# ' + ($('#be-title').value || 'Без названия') + '\n\n' + (chips ? chips + '\n\n' : '');
    const html = window.MD ? MD.render(head + body) : esc(body);
    const pane = $('#be-preview');
    pane.innerHTML = html;
    for (const a of pane.querySelectorAll('a.ext-link')) {
      a.addEventListener('click', (e) => { e.preventDefault(); if (a.dataset.href) L.openExternal(a.dataset.href); });
    }
    for (const a of pane.querySelectorAll('a.wiki-link')) {
      a.addEventListener('click', (e) => {
        e.preventDefault();
        const name = (a.dataset.wiki || '').toLowerCase();
        const note = State.notes.find((x) => (x.title || '').toLowerCase() === name);
        if (note) return this.select(note.id);
        const book = State.books.find((x) => (x.title || '').toLowerCase().includes(name));
        if (book) return Reader.open(book.id);
        toast('Нет записи или книги «' + a.dataset.wiki + '»', 'err');
      });
    }
    for (const box of pane.querySelectorAll('li.md-task input')) box.disabled = true;
  },

  queueSave() {
    const saved = $('#be-saved');
    saved.textContent = 'сохраняю…';
    if (this.saveTimer) clearTimeout(this.saveTimer);
    this.saveTimer = setTimeout(() => this.flush(), 550);
  },

  async flush() {
    this.saveTimer = null;
    const n = this.current();
    if (!n) return;
    const patch = {
      id: n.id,
      title: $('#be-title').value.trim() || 'Без названия',
      kind: $('#be-kind').value,
      tags: $('#be-tags').value.split(',').map((s) => s.trim().replace(/^#/, '')).filter(Boolean),
      body: $('#be-body').value,
      cover: n.cover || null,
      pinned: !!n.pinned,
      meta: n.meta || {},
      links: n.links || []
    };
    try {
      const saved = await L.saveNote(patch);
      Object.assign(n, saved);
      $('#be-saved').textContent = 'сохранено';
      this.render();
      updateCounts();
    } catch (e) {
      $('#be-saved').textContent = 'ошибка';
      toast(e.message, 'err');
    }
  },

  async create(kind, extra) {
    const note = await L.saveNote(Object.assign({
      kind: kind || 'note',
      title: '',
      body: TEMPLATES[kind] || '',
      tags: [],
      meta: {}
    }, extra || {}));
    State.notes.unshift(note);
    updateCounts();
    this.select(note.id);
    setTimeout(() => $('#be-title').focus(), 60);
    return note;
  },

  async remove() {
    const n = this.current();
    if (!n) return;
    if (!(await confirm2('Удалить «' + (n.title || 'без названия') + '»?', 'Запись исчезнет навсегда.'))) return;
    await L.deleteNote(n.id);
    State.notes = State.notes.filter((x) => x.id !== n.id);
    State.brain.current = null;
    updateCounts();
    this.select(null);
    toast('Удалено', 'ok');
  },

  insert(kind) {
    const area = $('#be-body');
    const start = area.selectionStart;
    const end = area.selectionEnd;
    const sel = area.value.slice(start, end);
    const wrap = (pre, post) => ({ text: pre + (sel || '') + (post === undefined ? pre : post), caret: pre.length });
    let out;
    switch (kind) {
      case 'h2': out = { text: '## ' + (sel || 'Заголовок'), caret: 3 }; break;
      case 'b': out = wrap('**'); break;
      case 'i': out = wrap('*'); break;
      case 'mark': out = wrap('=='); break;
      case 'code': out = sel.includes('\n') ? { text: '```\n' + sel + '\n```', caret: 4 } : wrap('`'); break;
      case 'ul': out = { text: (sel || 'пункт').split('\n').map((l) => '- ' + l).join('\n'), caret: 2 }; break;
      case 'task': out = { text: (sel || 'сделать').split('\n').map((l) => '- [ ] ' + l).join('\n'), caret: 6 }; break;
      case 'quote': out = { text: (sel || 'цитата').split('\n').map((l) => '> ' + l).join('\n'), caret: 2 }; break;
      case 'table': out = { text: '| Поле | Значение |\n| --- | --- |\n| ' + (sel || '') + ' |  |', caret: 2 }; break;
      case 'hr': out = { text: '\n---\n', caret: 5 }; break;
      case 'link': out = { text: '[' + (sel || 'текст') + '](https://)', caret: 1 }; break;
      case 'tmpl-recipe': out = { text: TEMPLATES.recipe, caret: TEMPLATES.recipe.length }; break;
      case 'tmpl-guide': out = { text: TEMPLATES.guide, caret: TEMPLATES.guide.length }; break;
      default: return;
    }
    area.setRangeText(out.text, start, end, 'end');
    if (!sel) area.setSelectionRange(start + out.caret, start + out.text.length);
    area.focus();
    this.renderPreview();
    this.queueSave();
  },

  async insertImage() {
    const url = await L.pickImage();
    if (!url) return;
    const area = $('#be-body');
    area.setRangeText('\n![](' + url + ')\n', area.selectionStart, area.selectionEnd, 'end');
    this.renderPreview();
    this.queueSave();
  },

  async pickCover() {
    const n = this.current();
    if (!n) return;
    const url = await L.pickImage();
    if (!url) return;
    n.cover = url;
    await this.flush();
    this.select(n.id);
  },

  async clearCover(e) {
    if (e) e.stopPropagation();
    const n = this.current();
    if (!n) return;
    n.cover = null;
    await this.flush();
    this.select(n.id);
  },

  togglePreview() {
    const panes = $('#be-panes');
    const order = ['split', 'preview', 'edit'];
    const next = order[(order.indexOf(State.brain.preview) + 1) % order.length];
    State.brain.preview = next;
    panes.className = 'be-panes' + (next === 'preview' ? ' preview-only' : next === 'edit' ? ' edit-only' : '');
    $('#be-preview-toggle').classList.toggle('active', next !== 'split');
    toast(next === 'split' ? 'Редактор + предпросмотр' : next === 'preview' ? 'Только предпросмотр' : 'Только редактор');
  },

  // Highlights -> a note
  async fromBook(book, highlights) {
    const lines = ['> Выписки из книги **' + book.title + '**'
      + ((book.authors || []).length ? ' — *' + book.authors.join(', ') + '*' : ''), ''];
    for (const h of highlights) {
      lines.push('## ' + (h.chapterTitle || 'Фрагмент'));
      lines.push('');
      lines.push('> ' + String(h.text).replace(/\n+/g, ' '));
      if (h.note) lines.push('', '**Мысль:** ' + h.note);
      lines.push('');
    }
    const existing = State.notes.find((n) => n.links && n.links.includes(book.id) && n.kind === 'note');
    if (existing) {
      existing.body = (existing.body || '') + '\n\n' + lines.join('\n');
      await L.saveNote(existing);
      this.select(existing.id);
      toast('Добавлено в существующую запись', 'ok');
      return;
    }
    await this.create('note', {
      title: 'Выписки: ' + book.title,
      body: lines.join('\n'),
      tags: ['книги'],
      links: [book.id],
      meta: { source: book.title }
    });
    go('brain');
    toast('Создана запись с выписками', 'ok');
  },

  async importMd() {
    const files = await L.importText();
    if (!files.length) return;
    for (const f of files) {
      const note = await L.saveNote({ kind: 'note', title: f.title, body: f.body, tags: ['импорт'] });
      State.notes.unshift(note);
    }
    updateCounts();
    this.render();
    toast('Импортировано: ' + files.length, 'ok');
  },

  async exportCurrent() {
    const n = this.current();
    if (!n) return toast('Выбери запись', 'err');
    const meta = n.meta || {};
    const head = ['# ' + n.title, ''];
    const chips = (FIELDS[n.kind] || []).filter((f) => meta[f.key]).map((f) => '- **' + f.label + ':** ' + meta[f.key]);
    if (chips.length) head.push(chips.join('\n'), '');
    if ((n.tags || []).length) head.push(n.tags.map((t) => '#' + t).join(' '), '');
    const file = await L.exportText(n.title + '.md', head.join('\n') + n.body);
    if (file) toast('Сохранено: ' + file, 'ok');
  },

  async exportAll() {
    const parts = [];
    for (const n of this.list()) {
      parts.push('# ' + n.title);
      if ((n.tags || []).length) parts.push(n.tags.map((t) => '#' + t).join(' '));
      parts.push('', n.body, '', '---', '');
    }
    if (!parts.length) return toast('Нечего экспортировать', 'err');
    const file = await L.exportText('second-brain.md', parts.join('\n'));
    if (file) toast('Сохранено: ' + file, 'ok');
  }
};
