'use strict';

// ---------- window chrome ----------
$$('.win-btn').forEach((b) => b.addEventListener('click', () => L.window(b.dataset.win)));

$$('.nav-item').forEach((b) => b.addEventListener('click', () => go(b.dataset.view)));
$$('[data-goto]').forEach((b) => b.addEventListener('click', () => go(b.dataset.goto)));

async function pickAvatar() {
  const url = await L.pickImage();
  if (url) saveSettings({ avatar: url });
}
$('#avatar').addEventListener('click', pickAvatar);
$('#set-avatar').addEventListener('click', pickAvatar);
$('#settings-avatar').addEventListener('click', pickAvatar);
$('#set-avatar-clear').addEventListener('click', () => saveSettings({ avatar: null }));
$('#set-name').addEventListener('input', (e) => saveSettings({ profileName: e.target.value }));

// ---------- global search ----------
const gs = $('#global-search');
gs.addEventListener('input', () => {
  if (searchTimer) clearTimeout(searchTimer);
  searchTimer = setTimeout(() => runGlobalSearch(gs.value), 220);
});
gs.addEventListener('keydown', (e) => {
  if (e.key === 'Escape') { gs.value = ''; closeSearchPop(); gs.blur(); }
  if (e.key === 'Enter') {
    const first = $('.sp-row', $('#search-pop'));
    if (first) first.click();
  }
});
document.addEventListener('click', (e) => {
  if (!e.target.closest('#search-pop') && !e.target.closest('.tb-search')) closeSearchPop();
});

// ---------- sidebar actions ----------
$('#btn-add').addEventListener('click', pickBooks);
$('#empty-add').addEventListener('click', pickBooks);
$('#btn-new-note').addEventListener('click', () => { go('brain'); Brain.create('note'); });
$('#add-collection').addEventListener('click', async () => {
  const name = await prompt2('Новая коллекция', { placeholder: 'Например: Кулинария', ok: 'Создать' });
  if (!name) return;
  if (!State.collections.includes(name)) {
    State.collections.push(name);
    await L.setCollections(State.collections);
  }
  renderCollections();
  toast('Коллекция «' + name + '» создана', 'ok');
});

// ---------- library ----------
$$('#lib-kind button').forEach((b) => b.addEventListener('click', () => {
  $$('#lib-kind button').forEach((x) => x.classList.toggle('active', x === b));
  State.lib.kind = b.dataset.kind;
  Library.render();
}));
$$('#lib-layout button').forEach((b) => b.addEventListener('click', () => {
  $$('#lib-layout button').forEach((x) => x.classList.toggle('active', x === b));
  State.lib.layout = b.dataset.layout;
  Library.render();
}));
$('#lib-sort').addEventListener('change', (e) => { State.lib.sort = e.target.value; Library.render(); });

// ---------- reader chrome ----------
$('#rd-back').addEventListener('click', () => { Reader.closePanels(); go('library'); Library.render(); });
$('#rd-toc').addEventListener('click', (e) => Reader.togglePanel('#rd-panel-toc', e.currentTarget));
$('#rd-notes').addEventListener('click', (e) => Reader.togglePanel('#rd-panel-notes', e.currentTarget));
$('#rd-find').addEventListener('click', (e) => Reader.togglePanel('#rd-panel-find', e.currentTarget));
$('#rd-bookmark').addEventListener('click', () => Reader.toggleBookmark());
$('#rd-translate').addEventListener('click', (e) => Reader.togglePanel('#rd-panel-tr', e.currentTarget));
$('#brain-recipe').addEventListener('click', () => RecipeImport.open());
$('#be-translate').addEventListener('click', () => Translator.translateNote());
$('#rd-type').addEventListener('click', (e) => {
  const pop = $('#type-pop');
  const open = !pop.hidden;
  Reader.closePanels();
  pop.hidden = open;
  e.currentTarget.classList.toggle('active', !open);
});
$$('[data-close-panel]').forEach((b) => b.addEventListener('click', () => Reader.closePanels()));

$('#page-next').addEventListener('click', () => Reader.next());
$('#page-prev').addEventListener('click', () => Reader.prev());
$('#chap-next').addEventListener('click', () => Reader.showChapter(Reader.chapter + 1, 0));
$('#chap-prev').addEventListener('click', () => Reader.showChapter(Reader.chapter - 1, 0));
$('#book-progress').addEventListener('change', (e) => Reader.seek(+e.target.value));
$('#reader-scroll').addEventListener('scroll', () => {
  if (State.view === 'reader') {
    Reader.hideSelPop();
    Reader.updateProgress();
  }
}, { passive: true });
$('#reader-stage').addEventListener('wheel', (e) => {
  if (!State.settings.paged || State.view !== 'reader') return;
  e.preventDefault();
  if (Math.abs(e.deltaY) < 8) return;
  if (e.deltaY > 0) Reader.next();
  else Reader.prev();
}, { passive: false });

$('#find-input').addEventListener('input', (e) => {
  if (searchTimer) clearTimeout(searchTimer);
  searchTimer = setTimeout(() => Reader.runFind(e.target.value), 260);
});

// typography popup
$('#font-family').addEventListener('change', (e) => saveSettings({ fontFamily: e.target.value }));
const liveRange = (sel, key, cast) => {
  $(sel).addEventListener('input', (e) => {
    const v = cast(e.target.value);
    saveSettings({ [key]: v });
    if (State.view === 'reader' && Reader.book) {
      Reader.applyMode();
      Reader.updateProgress();
    }
  });
};
liveRange('#font-size', 'fontSize', Number);
liveRange('#line-height', 'lineHeight', Number);
liveRange('#page-width', 'pageWidth', Number);
$('#paged-mode').addEventListener('change', (e) => {
  saveSettings({ paged: e.target.checked });
  if (Reader.book) Reader.showChapter(Reader.chapter, Reader.book.progress ? Reader.book.progress.offset : 0);
});
$('#justify-mode').addEventListener('change', (e) => {
  saveSettings({ justify: e.target.checked });
  const c = $('#reader-content');
  if (c) c.classList.toggle('justify', e.target.checked);
});
$$('#theme-dots button, #theme-cards button').forEach((b) => b.addEventListener('click', () => saveSettings({ theme: b.dataset.theme })));
$$('#accent-row button').forEach((b) => b.addEventListener('click', () => saveSettings({ accent: b.dataset.accent })));

// ---------- selection popup ----------
$('#reader-content').addEventListener('mouseup', () => {
  setTimeout(() => {
    const sel = Reader.captureSelection();
    if (!sel) return;
    Reader.pendingSel = sel;
    Reader.showSelPop(sel.rect, null);
  }, 10);
});
$('#reader-content').addEventListener('mousedown', (e) => {
  if (!e.target.closest('mark.hl')) Reader.hideSelPop();
});
$$('#sel-pop .hl-color').forEach((b) => b.addEventListener('click', () => Reader.addHighlight(b.dataset.color)));
$$('#sel-pop .pop-btn').forEach((b) => b.addEventListener('click', async () => {
  const act = b.dataset.act;
  const existing = Reader.currentHighlight();
  if (act === 'copy') {
    const text = existing ? existing.text : (Reader.pendingSel ? Reader.pendingSel.text : '');
    if (text) { await navigator.clipboard.writeText(text); toast('Скопировано', 'ok'); }
    Reader.hideSelPop();
    return;
  }
  if (act === 'clear') {
    if (existing) {
      Reader.book.highlights = await L.deleteHighlight(Reader.book.id, existing.id);
      Reader.afterHighlightChange();
    }
    return;
  }
  if (act === 'note') {
    let h = existing;
    if (!h) {
      await Reader.addHighlight('amber');
      h = (Reader.book.highlights || [])[Reader.book.highlights.length - 1];
    }
    Reader.hideSelPop();
    if (h) Reader.editNote(Reader.book, h, () => Reader.renderBookHighlights());
    return;
  }
  if (act === 'brain') {
    let h = existing;
    if (!h) {
      await Reader.addHighlight('mint');
      h = (Reader.book.highlights || [])[Reader.book.highlights.length - 1];
    }
    Reader.hideSelPop();
    if (h) Brain.fromBook(Reader.book, [h]);
  }
}));

// ---------- brain ----------
$$('#brain-kind button').forEach((b) => b.addEventListener('click', () => {
  $$('#brain-kind button').forEach((x) => x.classList.toggle('active', x === b));
  State.brain.kind = b.dataset.kind;
  Brain.render();
}));
$('#brain-search').addEventListener('input', (e) => { State.brain.query = e.target.value; Brain.render(); });
$('#brain-new').addEventListener('click', () => Brain.create('note'));
$('#brain-import').addEventListener('click', () => Brain.importMd());
$('#brain-export').addEventListener('click', () => Brain.exportAll());
$$('.tmpl').forEach((b) => b.addEventListener('click', () => Brain.create(b.dataset.tmpl)));

$('#be-title').addEventListener('input', () => { Brain.queueSave(); Brain.renderPreview(); });
$('#be-tags').addEventListener('input', () => Brain.queueSave());
$('#be-kind').addEventListener('change', () => {
  const n = Brain.current();
  if (n) { n.kind = $('#be-kind').value; Brain.renderFields(n); }
  Brain.queueSave();
  Brain.renderPreview();
});
$('#be-body').addEventListener('input', () => { Brain.queueSave(); Brain.renderPreview(); });
$('#be-body').addEventListener('keydown', (e) => {
  if (e.key === 'Tab') {
    e.preventDefault();
    const a = e.target;
    a.setRangeText('  ', a.selectionStart, a.selectionEnd, 'end');
  }
  if (e.key === 'Enter') {
    const a = e.target;
    const before = a.value.slice(0, a.selectionStart);
    const line = before.slice(before.lastIndexOf('\n') + 1);
    const m = line.match(/^(\s*)(- \[ \] |- \[x\] |[-*+] |\d+\. )/);
    if (m && line.trim() !== m[2].trim()) {
      e.preventDefault();
      const bullet = m[2].replace('[x]', '[ ]').replace(/^(\s*)(\d+)\./, (s, sp, d) => sp + (Number(d) + 1) + '.');
      a.setRangeText('\n' + m[1] + bullet, a.selectionStart, a.selectionEnd, 'end');
      Brain.renderPreview();
      Brain.queueSave();
    }
  }
});
$('#be-body').addEventListener('paste', async (e) => {
  const item = Array.from(e.clipboardData.items || []).find((i) => i.type.startsWith('image/'));
  if (!item) return;
  e.preventDefault();
  const file = item.getAsFile();
  const reader = new FileReader();
  reader.onload = async () => {
    try {
      const url = await L.saveImageData(reader.result);
      const a = $('#be-body');
      a.setRangeText('\n![](' + url + ')\n', a.selectionStart, a.selectionEnd, 'end');
      Brain.renderPreview();
      Brain.queueSave();
      toast('Картинка вставлена', 'ok');
    } catch (err) { toast(err.message, 'err'); }
  };
  reader.readAsDataURL(file);
});
$('#be-pin').addEventListener('click', async () => {
  const n = Brain.current();
  if (!n) return;
  n.pinned = !n.pinned;
  $('#be-pin').classList.toggle('active', n.pinned);
  await Brain.flush();
});
$('#be-preview-toggle').addEventListener('click', () => Brain.togglePreview());
$('#be-export').addEventListener('click', () => Brain.exportCurrent());
$('#be-delete').addEventListener('click', () => Brain.remove());
$('#be-cover').addEventListener('click', () => Brain.pickCover());
$('#be-cover-clear').addEventListener('click', (e) => Brain.clearCover(e));
$$('#md-toolbar button').forEach((b) => b.addEventListener('click', () => {
  if (b.dataset.md === 'img') Brain.insertImage();
  else Brain.insert(b.dataset.md);
}));

// ---------- highlights view ----------
$$('#hl-color-filter button').forEach((b) => b.addEventListener('click', () => {
  $$('#hl-color-filter button').forEach((x) => x.classList.toggle('active', x === b));
  Highlights.filter.color = b.dataset.color;
  Highlights.render();
}));
$('#hl-search').addEventListener('input', (e) => { Highlights.filter.query = e.target.value; Highlights.render(); });
$('#hl-export').addEventListener('click', async () => {
  const text = Highlights.exportMd();
  const file = await L.exportText('выделения.md', text);
  if (file) toast('Сохранено: ' + file, 'ok');
});

// ---------- catalog + settings ----------
$('#cat-go').addEventListener('click', () => Catalog.search($('#cat-search').value));
L.onSearchHit((p) => Catalog.onSearchHit(p));
$('#cat-search').addEventListener('keydown', (e) => { if (e.key === 'Enter') Catalog.search(e.target.value); });
$('#cat-add').addEventListener('click', async () => {
  try {
    State.catalogs = await L.addCatalog({
      name: $('#cat-name').value.trim(),
      url: $('#cat-url').value.trim(),
      search: $('#cat-surl').value.trim()
    });
    $('#cat-name').value = '';
    $('#cat-url').value = '';
    $('#cat-surl').value = '';
    Settings.render();
    Catalog.render();
    toast('Каталог добавлен', 'ok');
  } catch (e) {
    toast(e.message, 'err');
  }
});
$('#sync-token-launcher').addEventListener('click', () => Sync.useLauncherToken());
$('#sync-check').addEventListener('click', () => Sync.check());
$('#sync-now').addEventListener('click', () => Sync.run(false));
$('#sync-auto').addEventListener('change', () => Sync.save());
$('#sync-repo').addEventListener('change', () => Sync.save());
L.onSyncProgress((p) => Sync.status(p.text));
$('#phone-release').addEventListener('click', () => L.openExternal(PHONE_RELEASE_URL));
$('#phone-qr').addEventListener('click', () => {
  modal({
    title: 'Приложение для телефона',
    sub: 'Открой эту ссылку на телефоне и скачай APK из последнего релиза',
    body: [el('div', { class: 'quote', text: PHONE_RELEASE_URL })],
    actions: [
      { label: 'Закрыть' },
      { label: 'Скопировать', kind: 'primary', action: () => navigator.clipboard.writeText(PHONE_RELEASE_URL).then(() => toast('Ссылка скопирована', 'ok')) }
    ]
  });
});

$('#data-backup').addEventListener('click', async () => {
  const file = await L.backup();
  if (file) toast('Копия сохранена', 'ok');
});
$('#data-folder').addEventListener('click', () => { if (Settings.dir) L.reveal(Settings.dir); });

// ---------- modal / hotkeys ----------
$('#modal-back').addEventListener('mousedown', (e) => { if (e.target.id === 'modal-back') closeModal(); });

document.addEventListener('keydown', (e) => {
  const typing = /^(INPUT|TEXTAREA|SELECT)$/.test(document.activeElement.tagName);
  if (e.ctrlKey && e.key.toLowerCase() === 'k') { e.preventDefault(); $('#global-search').focus(); $('#global-search').select(); return; }
  if (e.ctrlKey && e.key.toLowerCase() === 'o') { e.preventDefault(); pickBooks(); return; }
  if (e.ctrlKey && e.key.toLowerCase() === 'n') { e.preventDefault(); go('brain'); Brain.create('note'); return; }
  if (e.ctrlKey && e.key.toLowerCase() === 's') {
    e.preventDefault();
    if (State.view === 'brain') Brain.flush().then(() => toast('Сохранено', 'ok'));
    return;
  }
  if (e.ctrlKey && e.key.toLowerCase() === 'f' && State.view === 'reader') {
    e.preventDefault();
    Reader.togglePanel('#rd-panel-find', $('#rd-find'));
    return;
  }
  if (e.key === 'Escape') {
    if (!$('#modal-back').hidden) return closeModal();
    if (!$('#search-pop').hidden) return closeSearchPop();
    if (State.view === 'reader') {
      const openPanel = $('.rd-panel.open') || (!$('#type-pop').hidden ? 1 : null);
      if (openPanel) return Reader.closePanels();
      Reader.closePanels();
      go('library');
      Library.render();
    }
    return;
  }
  if (State.view !== 'reader' || typing) return;
  if (e.key === 'ArrowRight' || e.key === 'PageDown' || (e.key === ' ' && !e.shiftKey)) { e.preventDefault(); Reader.next(); }
  else if (e.key === 'ArrowLeft' || e.key === 'PageUp' || (e.key === ' ' && e.shiftKey)) { e.preventDefault(); Reader.prev(); }
  else if (e.key === 'Home') Reader.showChapter(0, 0);
  else if (e.key === 'End') Reader.showChapter(Reader.chapters.length - 1, 0);
  else if (e.key.toLowerCase() === 'b') Reader.toggleBookmark();
  else if (e.key.toLowerCase() === 't') Reader.togglePanel('#rd-panel-toc', $('#rd-toc'));
});

let resizeTimer = null;
window.addEventListener('resize', () => {
  if (State.view !== 'reader' || !Reader.book) return;
  if (resizeTimer) clearTimeout(resizeTimer);
  resizeTimer = setTimeout(() => {
    const offset = Reader.currentOffset();
    Reader.applyMode();
    Reader.scrollToOffset(offset);
    Reader.updateProgress();
  }, 180);
});

// ---------- boot ----------
setupDrop();

(async function start() {
  try {
    await refreshState();
    applySettings();
    $('#lib-sort').value = State.lib.sort;
    Library.render();
    Catalog.render();
    Settings.render();
    Brain.render();
    Translator.init();
    Sync.load().then(() => {
      if (Sync.info && Sync.info.auto && Sync.info.hasToken) Sync.run(true);
    });
    const panes = $('#be-panes');
    if (panes) panes.className = 'be-panes';
  } catch (e) {
    toast('Не удалось загрузить библиотеку: ' + e.message, 'err');
  }
})();
