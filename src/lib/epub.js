'use strict';

const NODE = typeof module !== 'undefined' && !!module.exports;
const JSZip = NODE ? require('jszip') : window.JSZip;
const U = NODE ? require('./util') : window.LumenUtil;
const { decodeBuffer, stripTags, unescapeXml, attr, sanitizeHtml, asBytes, toBase64 } = U;

const MIME = {
  jpg: 'image/jpeg', jpeg: 'image/jpeg', png: 'image/png', gif: 'image/gif',
  svg: 'image/svg+xml', webp: 'image/webp', bmp: 'image/bmp'
};

function dirOf(p) {
  const i = p.lastIndexOf('/');
  return i < 0 ? '' : p.slice(0, i + 1);
}

function resolvePath(base, rel) {
  const target = (base + String(rel || '')).split('?')[0].split('#')[0];
  const parts = [];
  for (const seg of target.split('/')) {
    if (!seg || seg === '.') continue;
    if (seg === '..') parts.pop();
    else parts.push(seg);
  }
  return parts.join('/');
}

function fileFor(zip, path) {
  if (!path) return null;
  const direct = zip.file(path);
  if (direct) return direct;
  const dec = zip.file(decodeURIComponent(path));
  if (dec) return dec;
  const low = path.toLowerCase();
  const hit = zip.file(/.*/).find((f) => f.name.toLowerCase() === low);
  return hit || null;
}

async function dataUrl(zip, path) {
  const f = fileFor(zip, path);
  if (!f) return null;
  const ext = (path.split('.').pop() || '').toLowerCase();
  const b64 = await f.async('base64');
  return 'data:' + (MIME[ext] || 'image/jpeg') + ';base64,' + b64;
}

async function parse(buf) {
  const zip = await JSZip.loadAsync(buf);

  const containerFile = fileFor(zip, 'META-INF/container.xml');
  let opfPath = '';
  if (containerFile) {
    const xml = decodeBuffer(await containerFile.async('uint8array'));
    opfPath = attr((xml.match(/<rootfile\b[^>]*>/i) || [''])[0], 'full-path');
  }
  if (!opfPath) {
    const guess = zip.file(/\.opf$/i)[0];
    if (!guess) throw new Error('EPUB без OPF — файл повреждён');
    opfPath = guess.name;
  }
  const base = dirOf(opfPath);
  const opf = decodeBuffer(await fileFor(zip, opfPath).async('uint8array'));

  const metaBlock = (opf.match(/<metadata\b[^>]*>([\s\S]*?)<\/metadata>/i) || [])[1] || opf;
  const dc = (name) => {
    const re = new RegExp('<(?:dc:)?' + name + '\\b[^>]*>([\\s\\S]*?)</(?:dc:)?' + name + '>', 'ig');
    const vals = [];
    let m;
    while ((m = re.exec(metaBlock))) vals.push(unescapeXml(stripTags(m[1])));
    return vals;
  };

  const manifest = new Map();
  const mRe = /<item\b[^>]*>/gi;
  let im;
  while ((im = mRe.exec(opf))) {
    const id = attr(im[0], 'id');
    if (!id) continue;
    manifest.set(id, {
      href: attr(im[0], 'href'),
      type: attr(im[0], 'media-type'),
      props: attr(im[0], 'properties')
    });
  }

  const spine = [];
  const spineBlock = (opf.match(/<spine\b[^>]*>([\s\S]*?)<\/spine>/i) || [])[1] || '';
  const sRe = /<itemref\b[^>]*>/gi;
  let is;
  while ((is = sRe.exec(spineBlock))) {
    const idref = attr(is[0], 'idref');
    const item = manifest.get(idref);
    if (item && item.href && !/^no$/i.test(attr(is[0], 'linear'))) spine.push(resolvePath(base, item.href));
  }
  if (!spine.length) {
    for (const it of manifest.values()) {
      if (/xhtml|html/i.test(it.type || '')) spine.push(resolvePath(base, it.href));
    }
  }

  // Titles from the navigation document or NCX.
  const titles = new Map();
  const navItem = [...manifest.values()].find((it) => /nav/.test(it.props || ''));
  if (navItem) {
    const navPath = resolvePath(base, navItem.href);
    const f = fileFor(zip, navPath);
    if (f) {
      const navXml = decodeBuffer(await f.async('uint8array'));
      const aRe = /<a\b([^>]*)>([\s\S]*?)<\/a>/gi;
      let am;
      while ((am = aRe.exec(navXml))) {
        const href = resolvePath(dirOf(navPath), attr(am[1], 'href'));
        const text = unescapeXml(stripTags(am[2]));
        if (href && text && !titles.has(href)) titles.set(href, text);
      }
    }
  }
  const ncxItem = [...manifest.values()].find((it) => /ncx/i.test(it.type || '') || /\.ncx$/i.test(it.href || ''));
  if (ncxItem) {
    const ncxPath = resolvePath(base, ncxItem.href);
    const f = fileFor(zip, ncxPath);
    if (f) {
      const ncx = decodeBuffer(await f.async('uint8array'));
      const pRe = /<navPoint\b[^>]*>([\s\S]*?)<\/navPoint>/gi;
      let pm;
      while ((pm = pRe.exec(ncx))) {
        const label = unescapeXml(stripTags((pm[1].match(/<text>([\s\S]*?)<\/text>/i) || [])[1] || ''));
        const href = resolvePath(dirOf(ncxPath), attr((pm[1].match(/<content\b[^>]*>/i) || [''])[0], 'src'));
        if (href && label && !titles.has(href)) titles.set(href, label);
      }
    }
  }

  // Chapters.
  const chapters = [];
  for (const path of spine) {
    const f = fileFor(zip, path);
    if (!f) continue;
    let html = decodeBuffer(await f.async('uint8array'));
    const bodyMatch = html.match(/<body\b[^>]*>([\s\S]*?)<\/body>/i);
    html = bodyMatch ? bodyMatch[1] : html;
    html = sanitizeHtml(html);

    // Inline images as data URIs.
    const imgs = [...html.matchAll(/<(?:img|image)\b[^>]*>/gi)];
    for (const tag of imgs) {
      const src = attr(tag[0], 'src') || attr(tag[0], 'href');
      if (!src || /^data:/i.test(src)) continue;
      const data = await dataUrl(zip, resolvePath(dirOf(path), src));
      if (data) html = html.replace(tag[0], '<img class="fb-image" src="' + data + '">');
      else html = html.replace(tag[0], '');
    }
    html = html.replace(/<a\b([^>]*)>/gi, function (full, a) {
      const href = attr(a, 'href');
      if (/^(https?|mailto):/i.test(href)) return '<a class="ext-link" data-href="' + href.replace(/"/g, '') + '" href="#">';
      return '<a class="int-link" href="#">';
    });

    let title = titles.get(path) || '';
    if (!title) {
      const h = html.match(/<h[1-4]\b[^>]*>([\s\S]*?)<\/h[1-4]>/i);
      title = h ? unescapeXml(stripTags(h[1])) : '';
    }
    if (!stripTags(html) && !/<img/i.test(html)) continue;
    chapters.push({ title: title || 'Глава ' + (chapters.length + 1), html });
  }

  // Cover.
  let cover = null;
  const coverProp = [...manifest.values()].find((it) => /cover-image/.test(it.props || ''));
  if (coverProp) cover = await dataUrl(zip, resolvePath(base, coverProp.href));
  if (!cover) {
    const metaCover = (opf.match(/<meta\b[^>]*name\s*=\s*["']cover["'][^>]*>/i) || [''])[0];
    const id = attr(metaCover, 'content');
    const it = manifest.get(id);
    if (it) cover = await dataUrl(zip, resolvePath(base, it.href));
  }
  if (!cover) {
    const guess = [...manifest.values()].find((it) => /^image\//i.test(it.type || '') && /cover/i.test(it.href || ''));
    if (guess) cover = await dataUrl(zip, resolvePath(base, guess.href));
  }
  if (!cover) {
    const firstImg = (chapters[0] && chapters[0].html.match(/<img[^>]*src="(data:[^"]+)"/i)) || null;
    if (firstImg) cover = firstImg[1];
  }

  const authors = dc('creator');
  return {
    meta: {
      title: dc('title')[0] || '',
      authors,
      series: '',
      seriesNum: '',
      genres: dc('subject'),
      annotation: stripTags(dc('description')[0] || ''),
      lang: dc('language')[0] || '',
      year: (dc('date')[0] || '').slice(0, 4)
    },
    cover,
    chapters,
    notes: {}
  };
}

if (typeof module !== 'undefined' && module.exports) module.exports = { parse };
if (typeof window !== 'undefined') window.LumenEpub = { parse };
