'use strict';

// Reader translation panel, note translation and the recipe capture modal.

const BLOCK_SEL = 'p, li, h1, h2, h3, h4, .fb-verse, .fb-author-line';

const Translator = {
  info: null,
  wanted: null,
  settings: {},
  busy: false,
  bookBusy: false,
  auto: false,

  async init() {
    try {
      this.info = await L.translateInfo();
    } catch (e) {
      return;
    }
    this.settings = this.info.settings || {};
    const lang = $('#tr-lang');
    lang.innerHTML = '';
    for (const l of this.info.langs) lang.appendChild(el('option', { value: l.code, text: l.name }));
    lang.value = this.settings.to || 'ru';

    const eng = $('#tr-engine');
    eng.innerHTML = '';
    for (const e of this.info.engines) eng.appendChild(el('option', { value: e.id, text: e.name }));
    eng.value = this.settings.engine || 'gtx';

    $('#tr-mode').value = this.settings.mode || 'parallel';
    $('#tr-style').value = this.settings.style || 'literary';
    $('#tr-glossary').value = this.settings.glossary || '';
    $('#tr-key').value = this.settings.apiKey || '';
    $('#tr-model').value = this.settings.model || '';
    $('#tr-base').value = this.settings.baseUrl || '';
    $('#tr-libre').value = this.settings.libreUrl || '';
    this.syncEngineFields();

    const save = (patch) => {
      Object.assign(this.settings, patch);
      L.setTranslateSettings(patch).catch(() => {});
    };
    lang.addEventListener('change', () => save({ to: lang.value }));
    eng.addEventListener('change', () => { save({ engine: eng.value }); this.syncEngineFields(); });
    $('#tr-mode').addEventListener('change', (e) => save({ mode: e.target.value }));
    $('#tr-style').addEventListener('change', (e) => save({ style: e.target.value }));
    $('#tr-glossary').addEventListener('change', (e) => save({ glossary: e.target.value }));
    $('#tr-key').addEventListener('change', (e) => save({ apiKey: e.target.value.trim() }));
    $('#tr-model').addEventListener('change', (e) => save({ model: e.target.value.trim() }));
    $('#tr-base').addEventListener('change', (e) => save({ baseUrl: e.target.value.trim() }));
    $('#tr-libre').addEventListener('change', (e) => save({ libreUrl: e.target.value.trim() }));

    $('#tr-run').addEventListener('click', () => this.run(true));
    $('#tr-clear').addEventListener('click', () => this.clear(true));
    $('#tr-auto').addEventListener('click', () => {
      this.auto = !this.auto;
      $('#tr-auto').classList.toggle('on', this.auto);
      $('#tr-auto').textContent = this.auto ? 'Авто: включено' : 'Авто: следующая глава';
      toast(this.auto ? 'Следующие главы будут переводиться заранее' : 'Автоперевод выключен', 'ok');
    });

    L.onTranslateProgress((p) => {
      if (!this.busy || this.bookBusy) return;
      $('#tr-status').textContent = 'Перевожу ' + p.done + ' из ' + p.total + '…';
    });

    $('#tr-book').addEventListener('click', () => this.runBook());
    L.onTranslateBook((p) => this.onBookProgress(p));
  },

  // Whole book: chapters are translated and cached one after another, so any
  // chapter you open later is already done.
  async runBook() {
    if (!Reader.book) return toast('Сначала открой книгу', 'err');
    if (this.bookBusy) {
      await L.translateCancel();
      $('#tr-status').textContent = 'Останавливаю…';
      return;
    }
    const status = await L.translateStatus(Reader.book.id, this.settings.to).catch(() => null);
    const left = status ? status.total - status.ready : 0;
    if (status && left === 0) {
      toast('Вся книга уже переведена', 'ok');
      return this.restore();
    }
    this.bookBusy = true;
    $('#tr-book').textContent = 'Остановить перевод';
    $('#tr-book').classList.add('danger');
    $('#tr-bar').hidden = false;
    try {
      const res = await L.translateBook(Reader.book.id, { to: this.settings.to });
      if (res.cancelled) toast('Перевод остановлен — сделанное сохранено', 'ok');
      else {
        toast('Книга переведена целиком', 'ok');
        this.restore();
      }
    } catch (e) {
      toast('Перевод книги оборвался: ' + e.message, 'err');
      $('#tr-status').textContent = 'Ошибка: ' + e.message;
    }
    this.bookBusy = false;
    $('#tr-book').textContent = 'Перевести всю книгу';
    $('#tr-book').classList.remove('danger');
  },

  onBookProgress(p) {
    const bar = $('#tr-bar');
    if (p.stage === 'start') {
      $('#tr-status').textContent = 'Глав: ' + p.totalChapters + ', фрагментов: ' + p.totalFragments;
      bar.hidden = false;
      bar.firstChild.style.width = '0%';
      return;
    }
    if (p.stage === 'done') {
      bar.firstChild.style.width = '100%';
      $('#tr-status').textContent = 'Готово: ' + p.totalChapters + ' глав, ' + p.fragmentsDone + ' фрагментов';
      return;
    }
    if (p.stage === 'cancelled') {
      $('#tr-status').textContent = 'Остановлено на главе ' + (p.chapter + 1);
      return;
    }
    const pct = p.totalFragments ? Math.round((p.fragmentsDone / p.totalFragments) * 100) : 0;
    bar.firstChild.style.width = pct + '%';
    $('#tr-status').textContent = 'Глава ' + (p.chapter + 1) + ' из ' + p.totalChapters
      + ' · ' + pct + '%' + (p.cached ? ' (из кэша)' : '');
    if (p.stage === 'chapter' && p.chapter === Reader.chapter) this.restore();
  },

  syncEngineFields() {
    const id = $('#tr-engine').value;
    const engine = (this.info.engines || []).find((e) => e.id === id) || {};
    $('#tr-engine-note').textContent = engine.note || '';
    $('#tr-keys').hidden = engine.kind !== 'llm';
    $('#tr-base-wrap').hidden = id !== 'openai';
    $('#tr-libre-wrap').hidden = id !== 'libre';
    if (engine.kind === 'llm' && !$('#tr-model').value) {
      $('#tr-model').value = id === 'anthropic' ? 'claude-fable-5-1' : 'gpt-4o-mini';
    }
  },

  blocks(root) {
    const host = root || Reader.content();
    const all = Array.from(host.querySelectorAll(BLOCK_SEL));
    return all.filter((node) => {
      if (node.closest('.tr-line')) return false;
      if (node.querySelector(BLOCK_SEL)) return false;
      const text = (node.dataset.trSource || node.textContent || '').trim();
      return text.length > 1;
    });
  },

  async run(force) {
    if (!Reader.book) return toast('Сначала открой книгу', 'err');
    if (this.busy) return toast('Перевод уже идёт', 'err');
    const nodes = this.blocks();
    if (!nodes.length) return toast('В этой главе нечего переводить', 'err');
    this.busy = true;
    $('#tr-run').disabled = true;
    $('#tr-status').textContent = 'Готовлю ' + nodes.length + ' фрагментов…';
    const fragments = nodes.map((n) => (n.dataset.trSource || n.textContent).trim());
    try {
      const res = await L.translateChapter(Reader.book.id, Reader.chapter, fragments, {
        to: this.settings.to, force: !!force
      });
      this.applyToNodes(nodes, res.items);
      this.wanted = Reader.book.id + ':' + Reader.chapter;
      $('#tr-status').textContent = res.cached ? 'Готово (из кэша)' : 'Готово: ' + res.items.length + ' фрагментов';
      toast('Глава переведена', 'ok');
      if (this.auto) this.prefetchNext();
    } catch (e) {
      $('#tr-status').textContent = 'Ошибка: ' + e.message;
      toast('Перевод не вышел: ' + e.message, 'err');
    }
    this.busy = false;
    $('#tr-run').disabled = false;
  },

  applyToNodes(nodes, items) {
    const mode = $('#tr-mode').value;
    this.clear(false);
    nodes.forEach((node, i) => {
      const text = (items[i] || '').trim();
      if (!text) return;
      if (mode === 'replace') {
        if (!node.dataset.trSource) node.dataset.trSource = node.textContent;
        node.textContent = text;
        node.classList.add('tr-replaced');
      } else {
        const line = el('div', { class: 'tr-line', text: text });
        node.classList.add('tr-origin');
        node.insertAdjacentElement('afterend', line);
      }
    });
    Reader.applyHighlights();
    Reader.updateProgress();
  },

  // Re-apply a cached translation when a chapter is (re)rendered. A mismatched
  // count no longer means giving up: whatever lines exist are shown.
  async restore() {
    if (!Reader.book) return;
    const nodes = this.blocks();
    if (!nodes.length) return;
    try {
      const items = await L.translatePeek(Reader.book.id, Reader.chapter, this.settings.to, 0);
      if (items && items.length) {
        this.applyToNodes(nodes, items);
        this.wanted = Reader.book.id + ':' + Reader.chapter;
      }
    } catch (e) { /* nothing cached */ }
  },

  // Cheap guard: if a translation was on screen and something wiped it (a
  // re-render, a page turn, a highlight re-apply), put it back.
  ensure() {
    if (!Reader.book || !this.wanted) return;
    if (this.wanted !== Reader.book.id + ':' + Reader.chapter) return;
    const host = Reader.content();
    if (host.querySelector('.tr-line') || host.querySelector('[data-tr-source]')) return;
    this.restore();
  },

  clear(wipeCache) {
    const host = Reader.content();
    for (const line of Array.from(host.querySelectorAll('.tr-line'))) line.remove();
    for (const node of Array.from(host.querySelectorAll('[data-tr-source]'))) {
      node.textContent = node.dataset.trSource;
      delete node.dataset.trSource;
      node.classList.remove('tr-replaced');
    }
    for (const node of Array.from(host.querySelectorAll('.tr-origin'))) node.classList.remove('tr-origin');
    if (wipeCache) this.wanted = null;
    if (wipeCache && Reader.book) {
      L.translateClear(Reader.book.id, this.settings.to).then(() => {
        $('#tr-status').textContent = 'Перевод сброшен';
        toast('Перевод этой книги удалён из кэша', 'ok');
      });
      Reader.applyHighlights();
    }
  },

  // Translate the following chapter quietly so page turns stay instant.
  async prefetchNext() {
    const next = Reader.chapter + 1;
    if (!Reader.book || next >= Reader.chapters.length || this.busy) return;
    const html = Reader.chapters[next].html;
    const holder = document.createElement('div');
    holder.innerHTML = html;
    const fragments = this.blocks(holder).map((n) => n.textContent.trim());
    if (!fragments.length) return;
    try {
      await L.translateChapter(Reader.book.id, next, fragments, { to: this.settings.to });
      $('#tr-status').textContent = 'Следующая глава тоже готова';
    } catch (e) { /* prefetch is optional */ }
  },

  async translateNote() {
    const note = Brain.current();
    if (!note) return toast('Открой запись', 'err');
    const langSel = el('select', { class: 'select' }, (this.info ? this.info.langs : [{ code: 'ru', name: 'Русский' }])
      .map((l) => el('option', { value: l.code, text: l.name, selected: l.code === (this.settings.to || 'ru') })));
    const modeSel = el('select', { class: 'select' }, [
      el('option', { value: 'replace', text: 'Заменить текст переводом' }),
      el('option', { value: 'append', text: 'Добавить перевод ниже' }),
      el('option', { value: 'new', text: 'Создать отдельную запись' })
    ]);
    modal({
      title: 'Перевести запись',
      sub: 'Движок берётся из настроек перевода в читалке',
      body: [
        el('label', { class: 'field' }, [el('span', { text: 'Язык' }), langSel]),
        el('label', { class: 'field' }, [el('span', { text: 'Что сделать' }), modeSel])
      ],
      actions: [
        { label: 'Отмена' },
        {
          label: 'Перевести',
          kind: 'primary',
          action: async () => {
            const t = toast('Перевожу запись…', 'wait', true);
            try {
              const body = await L.translateText($('#be-body').value, { to: langSel.value });
              const title = await L.translateText($('#be-title').value || note.title, { to: langSel.value });
              t.close();
              if (modeSel.value === 'new') {
                await Brain.create(note.kind, { title: title, body: body, tags: (note.tags || []).concat('перевод'), meta: note.meta });
              } else if (modeSel.value === 'append') {
                $('#be-body').value = $('#be-body').value + '\n\n---\n\n' + body;
                Brain.renderPreview();
                Brain.queueSave();
              } else {
                $('#be-title').value = title;
                $('#be-body').value = body;
                Brain.renderPreview();
                Brain.queueSave();
              }
              toast('Готово', 'ok');
            } catch (e) {
              t.close();
              toast('Не вышло: ' + e.message, 'err');
            }
          }
        }
      ]
    });
  }
};

// ---------------------------------------------------------------------------
// Recipe capture: paste a page (or its URL) and get a structured recipe note.
// ---------------------------------------------------------------------------

const RecipeImport = {
  html: '',

  open() {
    this.html = '';
    const url = el('input', { class: 'input', placeholder: 'https://… адрес страницы с рецептом' });
    const area = el('textarea', { placeholder: '…или просто вставь сюда страницу целиком (Ctrl+V). Картинки и шаги подхватятся.' });
    area.addEventListener('paste', (e) => {
      const rich = e.clipboardData.getData('text/html');
      if (rich) {
        this.html = rich;
        setTimeout(() => {
          hint.textContent = 'Принята вёрстка страницы: ' + Math.round(rich.length / 1024) + ' КБ, картинок — ' + (rich.match(/<img/gi) || []).length;
        }, 0);
      }
    });
    const hint = el('p', { class: 'sub', text: 'Можно вставить текст или скопированную страницу — разметка сохранится.' });

    const langs = (Translator.info ? Translator.info.langs : [{ code: 'ru', name: 'Русский' }]);
    const langSel = el('select', { class: 'select small' }, langs.map((l) =>
      el('option', { value: l.code, text: l.name, selected: l.code === ((Translator.settings || {}).to || 'ru') })));
    const doTranslate = el('input', { type: 'checkbox' });
    const doImages = el('input', { type: 'checkbox', checked: true });

    const preview = el('div', { class: 'rc-preview muted small' });

    const gather = () => ({
      url: url.value.trim(),
      html: this.html,
      text: area.value,
      downloadImages: doImages.checked,
      translate: doTranslate.checked ? { to: langSel.value } : null
    });

    const box = modal({
      title: 'Рецепт со страницы',
      sub: 'Разберу на ингредиенты, шаги и фото — и положу в «Второй мозг» в Markdown',
      body: [
        el('label', { class: 'field' }, [el('span', { text: 'Ссылка' }), url]),
        el('label', { class: 'field' }, [el('span', { text: 'Или вставка' }), area]),
        hint,
        el('div', { class: 'row', style: 'flex-wrap:wrap;gap:14px' }, [
          el('label', { class: 'check' }, [doImages, el('span', { text: 'Скачать картинки' })]),
          el('label', { class: 'check' }, [doTranslate, el('span', { text: 'Перевести на' })]),
          langSel
        ]),
        preview
      ],
      actions: [
        { label: 'Закрыть' },
        {
          label: 'Разобрать',
          action: async () => {
            const input = gather();
            if (!input.url && !input.html && !input.text.trim()) {
              toast('Дай ссылку или вставь текст', 'err');
              return false;
            }
            const t = toast('Разбираю…', 'wait', true);
            try {
              const res = await L.recipePreview(input);
              t.close();
              preview.innerHTML = '';
              preview.appendChild(el('b', { text: res.title || 'Без названия' }));
              preview.appendChild(el('div', {
                text: 'Ингредиентов: ' + res.ingredients.length + ' · шагов: ' + res.steps.length
                  + ' · картинок: ' + res.images + (res.source === 'jsonld' ? ' · разметка рецепта найдена' : '')
              }));
              if (res.meta.time || res.meta.servings) {
                preview.appendChild(el('div', { text: [res.meta.time && ('время: ' + res.meta.time), res.meta.servings && ('порций: ' + res.meta.servings)].filter(Boolean).join(' · ') }));
              }
              preview.appendChild(el('pre', { class: 'rc-md', text: res.markdown.slice(0, 1200) }));
            } catch (e) {
              t.close();
              toast('Не разобрал: ' + e.message, 'err');
            }
            return false;
          }
        },
        {
          label: 'Добавить запись',
          kind: 'primary',
          action: async () => {
            const input = gather();
            if (!input.url && !input.html && !input.text.trim()) {
              toast('Дай ссылку или вставь текст', 'err');
              return false;
            }
            const t = toast('Собираю рецепт…', 'wait', true);
            const off = L.onRecipeProgress((p) => t.set(p.text));
            try {
              const note = await L.recipeImport(input);
              t.close();
              await refreshState();
              go('brain');
              Brain.select(note.id);
              toast('Рецепт добавлен', 'ok');
            } catch (e) {
              t.close();
              toast('Не вышло: ' + e.message, 'err');
            }
            return true;
          }
        }
      ]
    });
    return box;
  }
};
