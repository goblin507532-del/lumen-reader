'use strict';

const { contextBridge, ipcRenderer, webUtils } = require('electron');

function call(channel) {
  return function () {
    const args = Array.prototype.slice.call(arguments);
    return ipcRenderer.invoke(channel, ...args).then(function (res) {
      if (!res || res.ok) return res ? res.data : null;
      throw new Error(res.error);
    });
  };
}

contextBridge.exposeInMainWorld('lumen', {
  getState: call('state:get'),
  setSettings: call('settings:set'),
  window: call('window:action'),
  onWindowState: function (cb) {
    ipcRenderer.on('window:state', function (_e, s) { cb(s); });
  },

  pickBooks: call('books:pick'),
  importPaths: call('books:importPaths'),
  openBook: call('book:open'),
  updateBook: call('book:update'),
  setCover: call('book:setCover'),
  deleteBook: call('book:delete'),
  saveProgress: call('book:progress'),
  searchInside: call('book:searchInside'),

  saveHighlight: call('highlight:save'),
  deleteHighlight: call('highlight:delete'),

  saveNote: call('note:save'),
  deleteNote: call('note:delete'),
  pickImage: call('note:pickImage'),
  saveImageData: call('note:saveImageData'),
  importText: call('import:text'),

  setCollections: call('collections:set'),

  catalogs: call('catalog:list'),
  addCatalog: call('catalog:add'),
  removeCatalog: call('catalog:remove'),
  browseCatalog: call('catalog:browse'),
  searchCatalog: call('catalog:search'),
  downloadBook: call('catalog:download'),

  translateInfo: call('translate:info'),
  setTranslateSettings: call('translate:setSettings'),
  translateChapter: call('translate:chapter'),
  translatePeek: call('translate:peek'),
  translateClear: call('translate:clear'),
  translateText: call('translate:text'),
  translateBook: call('translate:book'),
  translateCancel: call('translate:cancel'),
  translateStatus: call('translate:status'),
  onTranslateBook: function (cb) {
    ipcRenderer.on('translate:book', function (_e, p) { cb(p); });
  },
  syncInfo: call('sync:info'),
  syncSettings: call('sync:setSettings'),
  syncCheck: call('sync:check'),
  syncRun: call('sync:run'),
  syncUploadBook: call('sync:uploadBook'),
  syncDownloadBook: call('sync:downloadBook'),
  onSyncProgress: function (cb) {
    ipcRenderer.on('sync:progress', function (_e, p) { cb(p); });
  },

  searchEverywhere: call('catalog:searchEverywhere'),
  onSearchHit: function (cb) {
    ipcRenderer.on('catalog:searchHit', function (_e, p) { cb(p); });
  },
  onTranslateProgress: function (cb) {
    ipcRenderer.on('translate:progress', function (_e, p) { cb(p); });
  },

  recipeFetch: call('recipe:fetch'),
  recipePreview: call('recipe:preview'),
  recipeImport: call('recipe:import'),
  onRecipeProgress: function (cb) {
    ipcRenderer.on('recipe:progress', function (_e, p) { cb(p); });
  },

  openExternal: call('shell:open'),
  reveal: call('shell:reveal'),
  exportText: call('export:text'),
  stats: call('data:stats'),
  backup: call('data:backup'),
  search: call('search:global'),

  filePath: function (file) {
    try { return webUtils.getPathForFile(file); } catch (e) { return ''; }
  }
});
