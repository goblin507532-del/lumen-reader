'use strict';

const Catalog = {
  render() {
    const box = $('#source-cards');
    box.innerHTML = '';
    const all = State.sources.concat(State.catalogs);
    for (const s of all) {
      box.appendChild(el('div', {
        class: 'src-card' + (State.cat.source === s.id ? ' active' : ''),
        onclick: () => this.pick(s)
      }, [
        el('b', { text: s.name }),
        el('span', { text: s.note || '' }),
        s.langs ? el('span', { class: 'lang', text: 'языки: ' + s.langs }) : null,
        s.custom ? el('button', {
          class: 'rm', text: '×', title: 'Убрать каталог',
          onclick: async (e) => {
            e.stopPropagation();
            State.catalogs = await L.removeCatalog(s.id);
            if (State.cat.source === s.id) { State.cat.source = null; State.cat.data = null; }
            this.render();
            Settings.render();
          }
        }) : null
      ]));
    }
    if (State.cat.meta) this.renderMeta();
    else {
      this.renderCrumbs();
      this.renderResults();
    }
  },

  async pick(source) {
    if (State.cat.source === source.id) {
      // Clicking the open catalog again goes back to "search everywhere".
      State.cat.source = null;
      State.cat.data = null;
      State.cat.stack = [];
      this.render();
      return;
    }
    State.cat.meta = null;
    State.cat.source = source.id;
    State.cat.stack = [{ title: source.name, url: null }];
    const browsable = source.kind !== 'archive' && source.kind !== 'openlibrary';
    if (browsable) await this.load(null);
    else {
      State.cat.data = { items: [], folders: [] };
      const q = $('#cat-search').value.trim();
      if (q) await this.search(q);
    }
    this.render();
  },

  async load(url, label) {
    const src = State.sources.concat(State.catalogs).find((s) => s.id === State.cat.source);
    if (!src) return;
    const t = toast('Загружаю каталог…', 'wait', true);
    try {
      const data = await L.browseCatalog(src.id, url);
      t.close();
      State.cat.data = data;
      State.cat.url = url;
      if (label) State.cat.stack.push({ title: label, url });
      this.renderCrumbs();
      this.renderResults();
    } catch (e) {
      t.close();
      toast('Каталог недоступен: ' + e.message, 'err');
    }
  },

  // No catalog picked: ask all of them at once and stream the answers in.
  async searchEverywhere(query) {
    if (!query.trim()) return;
    State.cat.meta = { query, groups: new Map(), pending: State.sources.length + State.catalogs.length };
    State.cat.source = null;
    State.cat.data = null;
    this.render();
    this.renderMeta();
    try {
      await L.searchEverywhere(query);
    } catch (e) {
      toast('Поиск сорвался: ' + e.message, 'err');
    }
    if (State.cat.meta) {
      State.cat.meta.pending = 0;
      this.renderMeta();
      const found = Array.from(State.cat.meta.groups.values()).reduce((n, g) => n + g.items.length, 0);
      if (!found) toast('По запросу «' + query + '» ничего не нашлось', 'err');
    }
  },

  onSearchHit(payload) {
    const meta = State.cat.meta;
    if (!meta || meta.query !== payload.query) return;
    meta.groups.set(payload.group.sourceId, payload.group);
    meta.pending = Math.max(0, meta.pending - 1);
    this.renderMeta();
  },

  renderMeta() {
    const box = $('#cat-results');
    const meta = State.cat.meta;
    if (!meta) return;
    $('#cat-pager').innerHTML = '';
    $('#cat-crumbs').innerHTML = '';
    box.innerHTML = '';
    box.className = 'cat-stream';

    const groups = Array.from(meta.groups.values())
      .sort((a, b) => b.items.length - a.items.length || a.sourceName.localeCompare(b.sourceName));
    const totalFound = groups.reduce((n, g) => n + g.items.length, 0);

    const head = el('div', { class: 'cat-group' }, [
      el('h3', {}, [
        el('span', { text: 'Найдено: ' + totalFound }),
        el('em', { text: meta.pending ? 'ещё ищу в ' + meta.pending + ' каталогах…' : 'во всех каталогах' }),
        meta.pending ? el('i', { class: 'sp' }) : null
      ])
    ]);
    box.appendChild(head);

    for (const g of groups) {
      if (!g.items.length) continue;
      const grid = el('div', { class: 'cat-results' });
      for (const item of g.items) grid.appendChild(this.itemCard(item));
      box.appendChild(el('div', { class: 'cat-group' }, [
        el('h3', {}, [
          el('span', { text: g.sourceName }),
          el('em', { text: g.total > g.items.length ? 'показано ' + g.items.length + ' из ' + g.total : g.items.length + '' })
        ]),
        grid
      ]));
    }

    const failed = groups.filter((g) => g.error);
    const empty = groups.filter((g) => !g.error && !g.items.length);
    if (empty.length || failed.length) {
      box.appendChild(el('div', { class: 'cat-group empty' }, [
        el('h3', {}, [el('em', {
          text: (empty.length ? 'Пусто: ' + empty.map((g) => g.sourceName).join(', ') : '')
            + (failed.length ? (empty.length ? ' · ' : '') + 'Не ответили: ' + failed.map((g) => g.sourceName).join(', ') : '')
        })])
      ]));
    }
  },

  async search(query) {
    if (!State.cat.source) return this.searchEverywhere(query);
    const src = State.sources.concat(State.catalogs).find((s) => s.id === State.cat.source);
    if (!src) return this.searchEverywhere(query);
    if (!query.trim()) return this.load(null);
    const t = toast('Ищу «' + query + '»…', 'wait', true);
    try {
      const data = await L.searchCatalog(src.id, query);
      t.close();
      State.cat.data = data;
      State.cat.stack = [{ title: src.name, url: null }, { title: 'поиск: ' + query, url: null }];
      this.renderCrumbs();
      this.renderResults();
      if (!data.items.length) toast('Ничего не найдено', 'err');
    } catch (e) {
      t.close();
      toast(e.message, 'err');
    }
  },

  renderCrumbs() {
    const box = $('#cat-crumbs');
    box.innerHTML = '';
    if (!State.cat.source) return;
    State.cat.stack.forEach((c, i) => {
      if (i) box.appendChild(el('span', { text: '›' }));
      box.appendChild(el('button', {
        text: c.title,
        onclick: () => {
          State.cat.stack = State.cat.stack.slice(0, i + 1);
          this.load(c.url);
        }
      }));
    });
  },

  renderResults() {
    const box = $('#cat-results');
    const pager = $('#cat-pager');
    box.innerHTML = '';
    pager.innerHTML = '';
    const data = State.cat.data;
    if (!State.cat.source) {
      box.appendChild(el('div', { class: 'muted', text: 'Напиши в поиске название или автора — спрошу сразу все каталоги. Или выбери один каталог, чтобы листать его целиком.' }));
      return;
    }
    if (!data) return;

    for (const f of data.folders || []) {
      box.appendChild(el('button', {
        class: 'cat-folder',
        onclick: () => this.load(f.url, f.title)
      }, [el('span', { text: '📁' }), el('span', { text: f.title })]));
    }

    for (const item of data.items || []) box.appendChild(this.itemCard(item));

    if (!(data.items || []).length && !(data.folders || []).length) {
      box.appendChild(el('div', { class: 'muted', text: 'Этот раздел пуст.' }));
    }
    if (data.prev) pager.appendChild(el('button', { class: 'btn ghost', text: '← Назад', onclick: () => this.load(data.prev) }));
    if (data.next) pager.appendChild(el('button', { class: 'btn ghost', text: 'Дальше →', onclick: () => this.load(data.next) }));
  },

  itemCard(item, sourceName) {
    const cover = el('div', { class: 'ci-cover' });
    if (item.cover) {
      const img = el('img', { src: item.cover, loading: 'lazy', alt: '' });
      img.addEventListener('error', () => { img.remove(); cover.textContent = '📘'; });
      cover.appendChild(img);
    } else {
      cover.textContent = '📘';
    }
    const have = State.books.some((b) => (b.title || '').toLowerCase() === (item.title || '').toLowerCase());
    const facts = [
      (item.ext || '').replace('.', '').toUpperCase(),
      item.lang,
      item.year,
      item.downloads ? item.downloads + ' скач.' : '',
      item.access === 'borrowable' ? 'можно взять почитать' : ''
    ].filter(Boolean).join(' · ');

    const acts = el('div', { class: 'acts' });
    if (item.webOnly || !item.download) {
      acts.appendChild(el('button', {
        class: 'btn ghost small', text: 'Открыть в браузере',
        onclick: () => L.openExternal(item.page || item.download)
      }));
    } else {
      acts.appendChild(el('button', {
        class: 'btn ' + (have ? 'ghost' : 'primary') + ' small',
        text: have ? 'Уже в библиотеке' : 'Скачать',
        onclick: (e) => this.download(item, e.target)
      }));
      if (item.page) {
        acts.appendChild(el('button', {
          class: 'btn ghost small', text: '↗',
          title: 'Открыть страницу книги',
          onclick: () => L.openExternal(item.page)
        }));
      }
    }
    acts.appendChild(el('span', { class: 'muted small', text: facts }));

    return el('div', { class: 'cat-item' }, [
      cover,
      el('div', { class: 'ci-info' }, [
        el('b', { text: item.title }),
        el('div', { class: 'au', text: item.authors || 'автор неизвестен' }),
        el('div', { class: 'sm', text: (item.summary || '').slice(0, 220) }),
        sourceName ? el('span', { class: 'src-badge', text: sourceName }) : null,
        acts
      ])
    ]);
  },

  async download(item, button) {
    const src = State.sources.concat(State.catalogs).find((s) => s.id === State.cat.source);
    const t = toast('Скачиваю «' + item.title + '»…', 'wait', true);
    if (button) { button.disabled = true; button.textContent = 'Качаю…'; }
    try {
      const res = await L.downloadBook(item, src ? src.name : '');
      t.close();
      await refreshState();
      if (button) { button.textContent = 'В библиотеке'; button.className = 'btn ghost small'; }
      toast('«' + res.book.title + '» добавлена', 'ok');
      Library.render();
    } catch (e) {
      t.close();
      if (button) { button.disabled = false; button.textContent = 'Скачать'; }
      toast('Не вышло скачать: ' + e.message, 'err');
    }
  }
};

const Sync = {
  info: null,

  async load() {
    try {
      this.info = await L.syncInfo();
    } catch (e) {
      return;
    }
    const i = this.info;
    $('#sync-repo').value = i.repo || 'lumen-sync';
    $('#sync-auto').checked = !!i.auto;
    $('#sync-token').placeholder = i.hasToken ? 'токен сохранён ' + i.token : 'ghp_…';
    $('#sync-token-launcher').hidden = !i.tokenHint && !i.hasToken ? false : !i.tokenHint;
    this.status(i.lastSync
      ? 'Последняя синхронизация: ' + new Date(i.lastSync).toLocaleString('ru-RU')
      : 'Ещё ни разу не синхронизировано');
  },

  status(text) {
    const node = $('#sync-status');
    if (node) node.textContent = text;
  },

  async save() {
    const patch = {
      repo: $('#sync-repo').value.trim() || 'lumen-sync',
      auto: $('#sync-auto').checked
    };
    const token = $('#sync-token').value.trim();
    if (token) patch.token = token;
    await L.syncSettings(patch);
    $('#sync-token').value = '';
    await this.load();
  },

  async useLauncherToken() {
    await L.syncSettings({ useLauncherToken: true });
    await this.load();
    toast('Токен взят из лаунчера', 'ok');
  },

  async check() {
    await this.save();
    const t = toast('Проверяю доступ…', 'wait', true);
    try {
      const res = await L.syncCheck();
      t.close();
      this.status('Подключено: ' + res.login + ' / ' + res.repo);
      toast('Готово: репозиторий ' + res.repo + ' на месте', 'ok');
      await this.load();
    } catch (e) {
      t.close();
      this.status('Ошибка: ' + e.message);
      toast(e.message, 'err');
    }
  },

  async run(quiet) {
    try {
      await this.save();
    } catch (e) { /* settings may be untouched */ }
    const t = quiet ? null : toast('Синхронизирую…', 'wait', true);
    try {
      const res = await L.syncRun({});
      if (t) t.close();
      await refreshState();
      Library.render();
      Brain.render();
      const c = res.changes || {};
      const bits = [];
      if ((c.newBooks || []).length) bits.push('книг: +' + c.newBooks.length);
      if ((c.newNotes || []).length) bits.push('записей: +' + c.newNotes.length);
      if ((c.movedBooks || []).length) bits.push('прогресс: ' + c.movedBooks.map((b) => b.title + ' ' + b.percent + '%').join(', '));
      this.status('Синхронизировано: ' + res.books + ' книг, ' + res.notes + ' записей'
        + (bits.length ? ' · ' + bits.join(' · ') : ''));
      if (!quiet) toast(bits.length ? 'Обновлено — ' + bits.join(', ') : 'Всё уже совпадает', 'ok');
      await this.load();
    } catch (e) {
      if (t) t.close();
      this.status('Ошибка: ' + e.message);
      if (!quiet) toast('Синхронизация не прошла: ' + e.message, 'err');
    }
  },

  async sendBook(book) {
    const t = toast('Отправляю на телефон…', 'wait', true);
    try {
      const res = await L.syncUploadBook(book.id);
      t.close();
      toast('«' + book.title + '» уедет на телефон при следующей синхронизации (' + Math.round(res.size / 1048576) + ' МБ)', 'ok');
    } catch (e) {
      t.close();
      toast(e.message, 'err');
    }
  },

  async fetchBook(book) {
    const t = toast('Качаю книгу из синхронизации…', 'wait', true);
    try {
      await L.syncDownloadBook(book.id);
      t.close();
      await refreshState();
      Library.render();
      toast('Книга на месте', 'ok');
    } catch (e) {
      t.close();
      toast(e.message, 'err');
    }
  }
};

const Settings = {
  async render() {
    const box = $('#custom-cats');
    box.innerHTML = '';
    for (const c of State.catalogs) {
      box.appendChild(el('div', {}, [
        el('span', { text: c.name }),
        el('button', {
          text: '×',
          onclick: async () => {
            State.catalogs = await L.removeCatalog(c.id);
            this.render();
            Catalog.render();
          }
        })
      ]));
    }
    try {
      const s = await L.stats();
      $('#data-stats').innerHTML = [
        'Книг: <b>' + s.books + '</b>',
        'Записей: <b>' + s.notes + '</b>',
        'Выделений: <b>' + s.highlights + '</b>',
        'Занято на диске: <b>' + fmtSize(s.bytes) + '</b>',
        'Папка данных: ' + esc(s.dir)
      ].join('<br>');
      this.dir = s.dir;
    } catch (e) { /* ignore */ }
  }
};
