'use strict';

const NODE = typeof module !== 'undefined' && !!module.exports;
const JSZip = NODE ? require('jszip') : window.JSZip;
const U = NODE ? require('./util') : window.LumenUtil;
const { decodeBuffer, escapeHtml, stripTags, sanitizeHtml, unescapeXml, asBytes } = U;
const fb2 = NODE ? require('./fb2') : window.LumenFb2;
const epub = NODE ? require('./epub') : window.LumenEpub;
const markdown = NODE ? require('./markdown') : window.MD;

function baseNameOf(file) {
  return String(file).split(/[\\/]/).pop();
}

function extNameOf(file) {
  const name = baseNameOf(file);
  const dot = name.lastIndexOf('.');
  return dot <= 0 ? '' : name.slice(dot).toLowerCase();
}

const BOOK_EXT = ['.fb2', '.fb2.zip', '.fbz', '.epub', '.txt', '.md', '.markdown', '.html', '.htm', '.xhtml', '.rtf', '.docx', '.pdf', '.zip'];

function extOf(file) {
  const low = file.toLowerCase();
  if (low.endsWith('.fb2.zip')) return '.fb2.zip';
  return extNameOf(low);
}

function chapterizeText(text, fallbackTitle) {
  const lines = text.replace(/\r\n?/g, '\n').split('\n');
  const chapters = [];
  let cur = { title: fallbackTitle, buf: [] };
  // No \b after the word: JS word boundaries do not fire on Cyrillic.
  const headRe = /^\s*(?:глава|часть|chapter|part|section|книга)(?:[\s.:№-].{0,70})?$/i;
  for (const line of lines) {
    const t = line.trim();
    const looksHead = t && t.length < 90 && (headRe.test(t) || (/^[^a-zа-я]{3,90}$/.test(t) && /[A-ZА-ЯЁ]/.test(t)));
    if (looksHead && cur.buf.join('').trim().length > 400) {
      chapters.push(cur);
      cur = { title: t, buf: [] };
    } else {
      cur.buf.push(line);
    }
  }
  chapters.push(cur);
  return chapters.map(function (c, idx) {
    const paras = c.buf.join('\n').split(/\n\s*\n/).map(function (p) { return p.trim(); }).filter(Boolean);
    return {
      title: c.title || 'Часть ' + (idx + 1),
      html: (idx === 0 ? '' : '<div class="fb-title heading"><p>' + escapeHtml(c.title || '') + '</p></div>')
        + paras.map(function (p) { return '<p>' + escapeHtml(p).replace(/\n/g, '<br>') + '</p>'; }).join('')
    };
  }).filter(function (c) { return stripTags(c.html).length > 0; });
}

function rtfToText(buf) {
  const bytes = asBytes(buf);
  let s = '';
  for (let i = 0; i < bytes.length; i++) s += String.fromCharCode(bytes[i]);
  s = s.replace(/\{\\\*[\s\S]*?\}/g, '');
  s = s.replace(/\\'([0-9a-f]{2})/gi, function (_, h) { return '%' + h; });
  s = s.replace(/\\u(-?\d+)\s?\??/g, function (_, n) {
    let code = parseInt(n, 10);
    if (code < 0) code += 65536;
    return String.fromCharCode(code);
  });
  s = s.replace(/\\par[d]?\b/g, '\n').replace(/\\line\b/g, '\n').replace(/\\tab\b/g, '\t');
  s = s.replace(/\\[a-z]+-?\d*\s?/gi, '').replace(/[{}]/g, '');
  try {
    s = decodeURIComponent(s.replace(/%(?![0-9a-f]{2})/gi, '%25'));
  } catch (e) { /* keep as-is */ }
  return s.replace(/\n{3,}/g, '\n\n').trim();
}

async function docxToHtml(buf) {
  const zip = await JSZip.loadAsync(buf);
  const f = zip.file('word/document.xml');
  if (!f) throw new Error('DOCX без document.xml');
  const xml = decodeBuffer(await f.async('uint8array'));
  const paras = [...xml.matchAll(/<w:p\b[^>]*>([\s\S]*?)<\/w:p>/g)];
  let html = '';
  for (const p of paras) {
    const style = (p[1].match(/<w:pStyle\b[^>]*w:val="([^"]+)"/) || [])[1] || '';
    const text = unescapeXml([...p[1].matchAll(/<w:t\b[^>]*>([\s\S]*?)<\/w:t>/g)].map(function (t) { return t[1]; }).join(''));
    if (!text.trim()) { html += '<div class="empty-line"></div>'; continue; }
    const lvl = (style.match(/^Heading(\d)/i) || [])[1];
    if (lvl) html += '<div class="fb-title heading"><p>' + escapeHtml(text) + '</p></div>';
    else if (/List|Bullet/i.test(style)) html += '<p class="md-bullet">• ' + escapeHtml(text) + '</p>';
    else html += '<p>' + escapeHtml(text) + '</p>';
  }
  return html;
}

async function unzipSingle(buf) {
  const zip = await JSZip.loadAsync(buf);
  const names = zip.file(/\.(fb2|txt|html?|md|epub)$/i).map(function (f) { return f.name; });
  if (!names.length) throw new Error('В архиве нет поддерживаемой книги');
  const inner = names[0];
  return { name: inner, buf: await zip.file(inner).async('uint8array') };
}

async function parseBook(filePath, buf) {
  const ext = extOf(filePath);
  const baseName = baseNameOf(filePath).replace(/\.[^.]+$/, '');

  if (ext === '.epub') {
    const r = await epub.parse(buf);
    return finish(r, baseName, 'epub');
  }
  if (ext === '.fb2') return finish(fb2.parse(buf), baseName, 'fb2');
  if (ext === '.fb2.zip' || ext === '.fbz' || ext === '.zip') {
    const inner = await unzipSingle(buf);
    const iext = extOf(inner.name);
    if (iext === '.epub') return finish(await epub.parse(inner.buf), baseName, 'epub');
    if (iext === '.fb2') return finish(fb2.parse(inner.buf), baseName, 'fb2');
    return parseBook(inner.name, inner.buf);
  }
  if (ext === '.txt') {
    const text = decodeBuffer(buf);
    return finish({ meta: {}, cover: null, chapters: chapterizeText(text, baseName), notes: {} }, baseName, 'txt');
  }
  if (ext === '.md' || ext === '.markdown') {
    const text = decodeBuffer(buf);
    const parts = text.split(/\n(?=#\s)/);
    const chapters = parts.map(function (p, i) {
      const title = (p.match(/^#\s+(.*)$/m) || [])[1] || (i === 0 ? baseName : 'Часть ' + (i + 1));
      return { title: title.trim(), html: markdown.render(p) };
    });
    return finish({ meta: {}, cover: null, chapters, notes: {} }, baseName, 'md');
  }
  if (ext === '.html' || ext === '.htm' || ext === '.xhtml') {
    const text = decodeBuffer(buf);
    const title = unescapeXml(stripTags((text.match(/<title[^>]*>([\s\S]*?)<\/title>/i) || [])[1] || ''));
    const body = (text.match(/<body\b[^>]*>([\s\S]*?)<\/body>/i) || [, text])[1];
    return finish({ meta: { title }, cover: null, chapters: [{ title: title || baseName, html: sanitizeHtml(body) }], notes: {} }, baseName, 'html');
  }
  if (ext === '.rtf') {
    return finish({ meta: {}, cover: null, chapters: chapterizeText(rtfToText(buf), baseName), notes: {} }, baseName, 'rtf');
  }
  if (ext === '.docx') {
    const html = await docxToHtml(buf);
    return finish({ meta: {}, cover: null, chapters: [{ title: baseName, html }], notes: {} }, baseName, 'docx');
  }
  if (ext === '.pdf') {
    return { external: 'pdf', meta: { title: baseName, authors: [] }, cover: null, chapters: [], notes: {} };
  }
  throw new Error('Формат не поддерживается: ' + ext);
}

function finish(r, baseName, format) {
  const meta = r.meta || {};
  if (!meta.title) {
    // "Author - Title" is the common filename shape for downloaded books.
    const m = baseName.match(/^(.{2,60}?)\s+-\s+(.+)$/);
    if (m && !meta.authors) { meta.authors = [m[1].trim()]; meta.title = m[2].trim(); }
    else meta.title = baseName;
  }
  if (!meta.authors) meta.authors = [];
  const words = r.chapters.reduce(function (n, c) { return n + stripTags(c.html).split(/\s+/).length; }, 0);
  return {
    format,
    meta: meta,
    cover: r.cover || null,
    chapters: r.chapters,
    notes: r.notes || {},
    stats: { chapters: r.chapters.length, words: words, minutes: Math.round(words / 180) }
  };
}

if (NODE) module.exports = { parseBook, BOOK_EXT, extOf };
if (typeof window !== 'undefined') window.LumenParse = { parseBook: parseBook, BOOK_EXT: BOOK_EXT, extOf: extOf };
