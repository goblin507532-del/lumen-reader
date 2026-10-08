'use strict';

const https = require('https');
const http = require('http');
const { URL } = require('url');
const { stripTags, unescapeXml, attr } = require('./util');

const SOURCES = [
  {
    id: 'gutendex',
    kind: 'gutendex',
    name: 'Project Gutenberg',
    note: '79 000+ книг общественного достояния, EPUB с обложками',
    url: 'https://gutendex.com/books/?page=1',
    search: 'https://gutendex.com/books/?search=',
    langs: 'en, fr, de, es, fi…'
  },
  {
    id: 'gutendex-ru',
    kind: 'gutendex',
    name: 'Project Gutenberg · по-русски',
    note: 'Русскоязычные книги того же каталога',
    url: 'https://gutendex.com/books/?languages=ru',
    search: 'https://gutendex.com/books/?languages=ru&search=',
    langs: 'ru'
  },
  {
    id: 'archive',
    kind: 'archive',
    name: 'Internet Archive',
    note: 'Миллионы оцифрованных книг и журналов, в том числе на русском',
    url: '',
    search: 'archive',
    langs: 'любой'
  },
  {
    id: 'openlibrary',
    kind: 'openlibrary',
    name: 'Open Library',
    note: 'Каталог всех книг мира: что существует, где читать и брать',
    url: '',
    search: 'openlibrary',
    langs: 'любой',
    webOnly: true
  },
  {
    id: 'pg-opds',
    kind: 'opds',
    name: 'Project Gutenberg · каталог',
    note: 'Официальный OPDS: популярное, новинки, случайные, поиск по автору',
    url: 'https://m.gutenberg.org/ebooks.opds/',
    search: 'https://www.gutenberg.org/ebooks/search.opds/?query=',
    langs: 'многоязычный'
  },
  {
    id: 'manybooks',
    kind: 'opds',
    name: 'ManyBooks',
    note: 'Бесплатные книги по жанрам и авторам',
    url: 'https://manybooks.net/opds/',
    search: '',
    langs: 'en'
  },
  {
    id: 'standardebooks',
    kind: 'opds',
    name: 'Standard Ebooks',
    note: 'Вычитанная классика с выверенной типографикой — новые издания',
    url: 'https://standardebooks.org/feeds/atom/new-releases',
    search: '',
    langs: 'en'
  }
];

// Catalogs behind Cloudflare occasionally stall a request in a burst, so one
// quiet retry before giving up.
async function request(rawUrl, redirects) {
  try {
    return await requestOnce(rawUrl, redirects);
  } catch (e) {
    if (!/Таймаут|ECONNRESET|socket/i.test(String(e.message))) throw e;
    await new Promise((r) => setTimeout(r, 700));
    return requestOnce(rawUrl, redirects);
  }
}

function requestOnce(rawUrl, redirects) {
  return new Promise((resolve, reject) => {
    let u;
    try { u = new URL(rawUrl); } catch (e) { return reject(new Error('Плохой URL')); }
    const mod = u.protocol === 'http:' ? http : https;
    const req = mod.get({
      protocol: u.protocol,
      hostname: u.hostname,
      port: u.port,
      path: u.pathname + u.search,
      headers: {
        'User-Agent': 'LumenReader/1.0 (desktop ebook reader)',
        Accept: 'application/atom+xml,application/json,*/*'
      },
      timeout: 45000
    }, (res) => {
      if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
        res.resume();
        if ((redirects || 0) > 5) return reject(new Error('Слишком много перенаправлений'));
        return request(new URL(res.headers.location, rawUrl).href, (redirects || 0) + 1).then(resolve, reject);
      }
      if (res.statusCode >= 400) {
        res.resume();
        return reject(new Error('HTTP ' + res.statusCode + ' от ' + u.hostname));
      }
      const chunks = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => resolve({ buf: Buffer.concat(chunks), headers: res.headers, url: rawUrl }));
    });
    req.on('timeout', () => req.destroy(new Error('Таймаут соединения')));
    req.on('error', reject);
  });
}

function pickGutenbergFile(formats) {
  const order = ['application/epub+zip', 'text/plain; charset=utf-8', 'text/html', 'text/plain'];
  for (const k of order) {
    if (formats[k]) return { url: formats[k], ext: k.includes('epub') ? '.epub' : k.includes('html') ? '.html' : '.txt' };
  }
  const key = Object.keys(formats).find((k) => !/zip$/.test(k) && !/image/.test(k));
  return key ? { url: formats[key], ext: '.txt' } : null;
}

async function browseGutendex(url) {
  const res = await request(url);
  const json = JSON.parse(res.buf.toString('utf8'));
  const items = (json.results || []).map((b) => {
    const file = pickGutenbergFile(b.formats || {});
    return {
      id: 'gb' + b.id,
      title: b.title || 'Без названия',
      authors: (b.authors || []).map((a) => a.name).join(', '),
      lang: (b.languages || []).join(', '),
      cover: (b.formats || {})['image/jpeg'] || null,
      summary: (b.summaries && b.summaries[0]) || '',
      download: file ? file.url : null,
      ext: file ? file.ext : null,
      downloads: b.download_count || 0
    };
  }).filter((b) => b.download);
  return { items, next: json.next || null, prev: json.previous || null };
}

function entryLinks(block) {
  const links = [];
  const re = /<link\b[^>]*>/gi;
  let m;
  while ((m = re.exec(block))) {
    links.push({ href: attr(m[0], 'href'), type: attr(m[0], 'type'), rel: attr(m[0], 'rel'), title: attr(m[0], 'title') });
  }
  return links;
}

// OPDS proper uses rel="…acquisition"; plain Atom catalogs (Standard Ebooks)
// hand out the same files as rel="enclosure".
function isAcquisition(link) {
  const rel = link.rel || '';
  return /acquisition/i.test(rel) || /^enclosure$/i.test(rel);
}

const PREFERRED = ['.epub', '.fb2.zip', '.fb2', '.txt', '.html', '.pdf', '.zip'];
const FORMAT_BY_TYPE = {
  'application/epub+zip': '.epub',
  'application/fb2+zip': '.fb2.zip',
  'application/x-fictionbook+xml': '.fb2',
  'application/fb2': '.fb2',
  'text/plain': '.txt',
  'text/html': '.html',
  'application/pdf': '.pdf',
  'application/zip': '.zip'
};

async function browseOpds(url) {
  const res = await request(url);
  const xml = res.buf.toString('utf8');
  const items = [];
  const folders = [];
  const entries = [...xml.matchAll(/<entry\b[^>]*>([\s\S]*?)<\/entry>/gi)];
  for (const e of entries) {
    const block = e[1];
    const title = unescapeXml(stripTags((block.match(/<title\b[^>]*>([\s\S]*?)<\/title>/i) || [])[1] || ''));
    const authors = [...block.matchAll(/<author\b[^>]*>([\s\S]*?)<\/author>/gi)]
      .map((a) => unescapeXml(stripTags((a[1].match(/<name\b[^>]*>([\s\S]*?)<\/name>/i) || [])[1] || ''))).filter(Boolean).join(', ');
    const summary = unescapeXml(stripTags((block.match(/<(?:summary|content)\b[^>]*>([\s\S]*?)<\/(?:summary|content)>/i) || [])[1] || '')).slice(0, 500);
    const lang = stripTags((block.match(/<dcterms:language>([\s\S]*?)<\/dcterms:language>/i) || [])[1] || '');
    const links = entryLinks(block);
    const abs = (h) => { try { return new URL(h, res.url).href; } catch (err) { return h; } };

    const acq = links
      .filter((l) => isAcquisition(l) && FORMAT_BY_TYPE[(l.type || '').split(';')[0].trim()])
      .sort((a, b) => PREFERRED.indexOf(FORMAT_BY_TYPE[(a.type || '').split(';')[0].trim()])
        - PREFERRED.indexOf(FORMAT_BY_TYPE[(b.type || '').split(';')[0].trim()]));
    const cover = links.find((l) => /image\/(jpeg|png)/.test(l.type || '') && /cover|image/i.test(l.rel || ''))
      || links.find((l) => /image\//.test(l.type || ''));
    const nav = links.find((l) => /type=feed|atom\+xml/.test(l.type || '') && !isAcquisition(l) && (l.rel || '') !== 'alternate');

    if (acq.length) {
      items.push({
        id: 'op' + items.length + '_' + Date.now().toString(36),
        title: title || 'Без названия',
        authors, lang, summary,
        cover: cover ? abs(cover.href) : null,
        download: abs(acq[0].href),
        ext: FORMAT_BY_TYPE[(acq[0].type || '').split(';')[0].trim()] || '.epub',
        alternates: acq.map((l) => ({ url: abs(l.href), ext: FORMAT_BY_TYPE[(l.type || '').split(';')[0].trim()] || '.epub' }))
      });
    } else if (nav) {
      folders.push({ title: title || 'Раздел', url: abs(nav.href), summary });
    }
  }
  const feedLinks = entryLinks(xml.split('<entry')[0]);
  const nextLink = feedLinks.find((l) => l.rel === 'next');
  const prevLink = feedLinks.find((l) => l.rel === 'previous' || l.rel === 'prev');
  const absFeed = (l) => { try { return new URL(l.href, res.url).href; } catch (err) { return l.href; } };
  return {
    items, folders,
    next: nextLink ? absFeed(nextLink) : null,
    prev: prevLink ? absFeed(prevLink) : null
  };
}

// --- Internet Archive ------------------------------------------------------

const IA_FIELDS = ['identifier', 'title', 'creator', 'year', 'downloads', 'language', 'description'];
const IA_FILE_ORDER = [/\.epub$/i, /\.fb2$/i, /\.fb2\.zip$/i, /_djvu\.txt$/i, /\.txt$/i, /\.pdf$/i];

function iaQuery(query, page) {
  // Plain words match the whole scanned text, which drags in noise; aim them
  // at title and author unless the user typed a field query themselves.
  const raw = String(query || '').trim();
  const scoped = raw && !/:/.test(raw) ? '(title:(' + raw + ') OR creator:(' + raw + '))' : raw ? '(' + raw + ')' : '';
  const q = (scoped || 'collection:(opensource OR gutenberg)')
    + ' AND mediatype:texts AND format:(EPUB OR PDF OR DJVU)'
    + ' AND NOT collection:(inlibrary OR printdisabled)';
  return 'https://archive.org/advancedsearch.php?q=' + encodeURIComponent(q)
    + IA_FIELDS.map((f) => '&fl[]=' + f).join('')
    + '&sort[]=downloads+desc&rows=24&page=' + (page || 1) + '&output=json';
}

// Scanned-media dumps and ROM manuals share the text collections; keep books.
const IA_JUNK = /(\.pdf|\.zip|\.7z|\.iso\b|SHVC-|scans?\b|manual\b|box, cart|4chan|\bdump\b)/i;

function rankArchive(items, query) {
  const q = String(query || '').trim().toLowerCase();
  if (!q) return items;
  const score = (it) => {
    const title = (it.title || '').toLowerCase();
    let n = 0;
    if (title.startsWith(q)) n += 4;
    else if (title.includes(q)) n += 2;
    if ((it.authors || '').toLowerCase().includes(q)) n += 2;
    if (it.authors) n += 1;
    if (IA_JUNK.test(it.title)) n -= 4;
    if (title.length > 90) n -= 1;
    return n;
  };
  return items
    .map((it) => ({ it, s: score(it) }))
    .filter((x) => x.s > -3)
    .sort((a, b) => b.s - a.s || (b.it.downloads || 0) - (a.it.downloads || 0))
    .map((x) => x.it);
}

async function browseArchive(query, page) {
  const res = await request(iaQuery(query, page));
  const json = JSON.parse(res.buf.toString('utf8'));
  const docs = (json.response && json.response.docs) || [];
  const items = docs.map((d) => ({
    id: 'ia_' + d.identifier,
    title: String(d.title || d.identifier).slice(0, 200),
    authors: [].concat(d.creator || []).join(', '),
    lang: [].concat(d.language || []).join(', '),
    summary: String([].concat(d.description || [])[0] || '').replace(/<[^>]*>/g, ' ').slice(0, 400),
    cover: 'https://archive.org/services/img/' + d.identifier,
    archiveId: d.identifier,
    download: 'https://archive.org/details/' + d.identifier,
    page: 'https://archive.org/details/' + d.identifier,
    ext: '',
    downloads: d.downloads || 0,
    year: d.year || ''
  }));
  const total = (json.response && json.response.numFound) || 0;
  const current = Number(page || 1);
  return {
    items: rankArchive(items, query),
    folders: [],
    total,
    next: current * 24 < total ? { archive: query, page: current + 1 } : null,
    prev: current > 1 ? { archive: query, page: current - 1 } : null
  };
}

// The search result only names an item; the actual file comes from metadata.
async function resolveArchiveFile(identifier) {
  const res = await request('https://archive.org/metadata/' + encodeURIComponent(identifier));
  const meta = JSON.parse(res.buf.toString('utf8'));
  const files = meta.files || [];
  for (const rule of IA_FILE_ORDER) {
    const hit = files.filter((f) => rule.test(f.name)).sort((a, b) => Number(a.size || 0) - Number(b.size || 0))[0];
    if (hit) {
      const ext = /_djvu\.txt$/i.test(hit.name) ? '.txt' : '.' + hit.name.split('.').pop().toLowerCase();
      const server = meta.server ? 'https://' + meta.server + (meta.dir || '') : 'https://archive.org/download/' + identifier;
      return {
        url: server + '/' + encodeURIComponent(hit.name),
        fallback: 'https://archive.org/download/' + identifier + '/' + encodeURIComponent(hit.name),
        ext
      };
    }
  }
  throw new Error('У этой записи нет файла книги');
}

// --- Open Library (discovery only) ----------------------------------------

async function searchOpenLibrary(query, page) {
  const url = 'https://openlibrary.org/search.json?q=' + encodeURIComponent(query)
    + '&limit=20&page=' + (page || 1)
    + '&fields=key,title,author_name,first_publish_year,cover_i,ia,ebook_access,language';
  const res = await request(url);
  const json = JSON.parse(res.buf.toString('utf8'));
  const items = (json.docs || []).map((d) => {
    const ia = [].concat(d.ia || [])[0];
    const free = d.ebook_access === 'public' && ia;
    return {
      id: 'ol_' + (d.key || '').replace(/\W+/g, ''),
      title: d.title || 'Без названия',
      authors: [].concat(d.author_name || []).join(', '),
      lang: [].concat(d.language || []).slice(0, 3).join(', '),
      summary: d.first_publish_year ? 'Впервые издано в ' + d.first_publish_year : '',
      cover: d.cover_i ? 'https://covers.openlibrary.org/b/id/' + d.cover_i + '-M.jpg' : null,
      archiveId: free ? ia : null,
      download: free ? 'https://archive.org/details/' + ia : null,
      page: 'https://openlibrary.org' + (d.key || ''),
      webOnly: !free,
      access: d.ebook_access || 'none',
      ext: ''
    };
  });
  return { items, folders: [], total: json.numFound || 0, next: null, prev: null };
}

async function browse(source, url) {
  if (source.kind === 'archive') {
    const state = url && typeof url === 'object' ? url : null;
    return browseArchive(state ? state.archive : '', state ? state.page : 1);
  }
  if (source.kind === 'openlibrary') {
    const state = url && typeof url === 'object' ? url : null;
    return searchOpenLibrary(state ? state.query : 'bestsellers', state ? state.page : 1);
  }
  const target = url || source.url;
  if (source.kind === 'gutendex') return browseGutendex(target);
  return browseOpds(target);
}

function withTimeout(promise, ms, label) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error((label || 'Источник') + ' не ответил за ' + Math.round(ms / 1000) + ' с')), ms);
    promise.then((v) => { clearTimeout(timer); resolve(v); }, (e) => { clearTimeout(timer); reject(e); });
  });
}

// Ask every catalog at once and label each hit with where it came from.
// `onGroup` fires per source as soon as it answers, so results stream in.
async function searchAll(sources, query, perSource, onGroup) {
  const jobs = sources.map(async (src) => {
    let group;
    try {
      const res = await withTimeout(search(src, query), 15000, src.name);
      const items = (res.items || []).slice(0, perSource || 12).map((it) => Object.assign({}, it, {
        sourceId: src.id,
        sourceName: src.name
      }));
      group = { sourceId: src.id, sourceName: src.name, items, total: res.total || items.length, error: null };
    } catch (e) {
      group = { sourceId: src.id, sourceName: src.name, items: [], total: 0, error: String(e.message || e) };
    }
    if (onGroup) onGroup(group);
    return group;
  });
  return Promise.all(jobs);
}

async function search(source, query, url) {
  if (source.kind === 'archive') {
    const state = url && typeof url === 'object' ? url : null;
    return browseArchive(state ? state.archive : query, state ? state.page : 1);
  }
  if (source.kind === 'openlibrary') {
    const state = url && typeof url === 'object' ? url : null;
    return searchOpenLibrary(state ? state.query : query, state ? state.page : 1);
  }
  if (url) return browse(source, url);
  if (source.kind === 'gutendex') return browseGutendex(source.search + encodeURIComponent(query));
  if (!source.search) {
    // No search endpoint: filter what the feed already gave us.
    const all = await browseOpds(source.url);
    const q = String(query || '').toLowerCase();
    return Object.assign({}, all, {
      items: (all.items || []).filter((i) => (i.title + ' ' + i.authors).toLowerCase().includes(q))
    });
  }
  return browseOpds(source.search + encodeURIComponent(query));
}

async function download(url) {
  const res = await request(url);
  let name = '';
  const cd = res.headers['content-disposition'] || '';
  const m = cd.match(/filename\*?=(?:UTF-8'')?"?([^";]+)"?/i);
  if (m) name = decodeURIComponent(m[1]);
  if (!name) {
    try { name = decodeURIComponent(new URL(res.url).pathname.split('/').filter(Boolean).pop() || ''); } catch (e) { name = ''; }
  }
  const type = (res.headers['content-type'] || '').split(';')[0].trim();
  return { buf: res.buf, name, type };
}

module.exports = {
  SOURCES, browse, search, searchAll, download, request,
  resolveArchiveFile, FORMAT_BY_TYPE
};
