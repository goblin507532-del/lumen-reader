'use strict';

const U = (typeof module !== 'undefined' && module.exports) ? require('./util') : window.LumenUtil;
const { decodeBuffer, stripTags, unescapeXml, attr } = U;

// --- binaries -------------------------------------------------------------

function readBinaries(xml) {
  const map = new Map();
  const re = /<binary\b([^>]*)>([\s\S]*?)<\/binary>/gi;
  let m;
  while ((m = re.exec(xml))) {
    const id = attr(m[1], 'id');
    if (!id) continue;
    const type = attr(m[1], 'content-type') || 'image/jpeg';
    const b64 = m[2].replace(/\s+/g, '');
    if (b64.length < 32) continue;
    map.set(id, 'data:' + type + ';base64,' + b64);
  }
  return map;
}

function resolveImage(href, bin) {
  const key = String(href || '').replace(/^#/, '');
  return bin.get(key) || bin.get(decodeURIComponent(key)) || null;
}

// --- body slicing ---------------------------------------------------------

// Find balanced <tag ...> ... </tag> regions at the top level of `xml`.
function sliceTags(xml, tag) {
  const out = [];
  const re = new RegExp('<' + tag + '(?:\\s[^>]*)?(/?)>|</' + tag + '\\s*>', 'gi');
  let depth = 0, start = -1, openTag = '', m;
  while ((m = re.exec(xml))) {
    const isClose = m[0].charAt(1) === '/';
    const selfClosing = m[1] === '/';
    if (selfClosing) continue;
    if (!isClose) {
      if (depth === 0) { start = m.index; openTag = m[0]; }
      depth++;
    } else if (depth > 0) {
      depth--;
      if (depth === 0 && start >= 0) {
        out.push({
          open: openTag,
          inner: xml.slice(start + openTag.length, m.index),
          outer: xml.slice(start, m.index + m[0].length)
        });
        start = -1;
      }
    }
  }
  return out;
}

// --- FB2 markup -> HTML ---------------------------------------------------

const DROP = /^(?:description|title-info|document-info|publish-info|custom-info|binary|fictionbook|body|coverpage|author|first-name|middle-name|last-name|nickname|home-page|email|genre|book-title|lang|src-lang|translator|sequence|keywords|date|program-used|id|version|history|publisher|city|year|isbn|book-name|src-url|src-ocr|output|part|stylesheet)$/i;

function fb2ToHtml(src, bin, opts) {
  const o = opts || {};
  let out = '';
  let i = 0;
  const stack = [];
  while (i < src.length) {
    const lt = src.indexOf('<', i);
    if (lt < 0) { out += src.slice(i); break; }
    out += src.slice(i, lt);
    const gt = src.indexOf('>', lt);
    if (gt < 0) break;
    const raw = src.slice(lt, gt + 1);
    i = gt + 1;
    if (/^<[?!]/.test(raw)) continue;
    const isClose = raw.charAt(1) === '/';
    const selfClose = /\/>$/.test(raw);
    const name = (raw.match(/^<\/?\s*([\w:-]+)/) || [])[1] || '';
    const tag = name.replace(/^[\w]+:/, '').toLowerCase();

    if (isClose) {
      const want = stack.pop();
      if (want) out += want;
      continue;
    }

    let open = '', close = '';
    switch (tag) {
      case 'p': open = '<p>'; close = '</p>'; break;
      case 'empty-line': open = '<div class="empty-line"></div>'; break;
      case 'strong': open = '<b>'; close = '</b>'; break;
      case 'emphasis': open = '<i>'; close = '</i>'; break;
      case 'strikethrough': open = '<s>'; close = '</s>'; break;
      case 'sub': open = '<sub>'; close = '</sub>'; break;
      case 'sup': open = '<sup>'; close = '</sup>'; break;
      case 'code': open = '<code>'; close = '</code>'; break;
      case 'style': open = '<span>'; close = '</span>'; break;
      case 'title': open = '<div class="fb-title">'; close = '</div>'; break;
      case 'subtitle': open = '<h3 class="fb-subtitle">'; close = '</h3>'; break;
      case 'section': open = '<section class="fb-section">'; close = '</section>'; break;
      case 'annotation': open = '<div class="fb-annotation">'; close = '</div>'; break;
      case 'epigraph': open = '<blockquote class="fb-epigraph">'; close = '</blockquote>'; break;
      case 'cite': open = '<blockquote class="fb-cite">'; close = '</blockquote>'; break;
      case 'text-author': open = '<div class="fb-author-line">'; close = '</div>'; break;
      case 'poem': open = '<div class="fb-poem">'; close = '</div>'; break;
      case 'stanza': open = '<div class="fb-stanza">'; close = '</div>'; break;
      case 'v': open = '<div class="fb-verse">'; close = '</div>'; break;
      case 'table': open = '<table class="fb-table">'; close = '</table>'; break;
      case 'tr': open = '<tr>'; close = '</tr>'; break;
      case 'th': open = '<th>'; close = '</th>'; break;
      case 'td': open = '<td>'; close = '</td>'; break;
      case 'image': {
        const data = resolveImage(attr(raw, 'href'), bin);
        const alt = attr(raw, 'alt');
        open = data ? '<img class="fb-image" alt="' + alt.replace(/"/g, '') + '" src="' + data + '">' : '';
        break;
      }
      case 'a': {
        const href = attr(raw, 'href');
        const type = attr(raw, 'type');
        if (type === 'note' || /^#/.test(href)) {
          open = '<a class="note-ref" data-note="' + href.replace(/^#/, '').replace(/"/g, '') + '" href="#">';
        } else {
          open = '<a class="ext-link" data-href="' + href.replace(/"/g, '') + '" href="#">';
        }
        close = '</a>';
        break;
      }
      default:
        if (DROP.test(tag)) { open = ''; close = ''; }
        else { open = ''; close = ''; }
    }
    out += open;
    if (!selfClose && tag !== 'empty-line') stack.push(close);
  }
  while (stack.length) out += stack.pop();
  if (o.titleAsHeading) out = out.replace(/<div class="fb-title">/g, '<div class="fb-title heading">');
  return out;
}

// --- metadata -------------------------------------------------------------

function personName(block) {
  const pick = (t) => stripTags((block.match(new RegExp('<' + t + '[^>]*>([\\s\\S]*?)</' + t + '>', 'i')) || [])[1] || '');
  const parts = [pick('first-name'), pick('middle-name'), pick('last-name')].filter(Boolean);
  const name = parts.join(' ').trim();
  return unescapeXml(name || pick('nickname'));
}

function parseMeta(xml) {
  const desc = (xml.match(/<description\b[^>]*>([\s\S]*?)<\/description>/i) || [])[1] || '';
  const ti = (desc.match(/<title-info\b[^>]*>([\s\S]*?)<\/title-info>/i) || [])[1] || desc;
  const title = unescapeXml(stripTags((ti.match(/<book-title\b[^>]*>([\s\S]*?)<\/book-title>/i) || [])[1] || ''));
  const authors = [];
  const authRe = /<author\b[^>]*>([\s\S]*?)<\/author>/gi;
  let a;
  while ((a = authRe.exec(ti))) {
    const n = personName(a[1]);
    if (n) authors.push(n);
  }
  const seqTag = (ti.match(/<sequence\b[^>]*\/?>/i) || [])[0] || '';
  const series = attr(seqTag, 'name');
  const seriesNum = attr(seqTag, 'number');
  const genres = [];
  const gRe = /<genre\b[^>]*>([\s\S]*?)<\/genre>/gi;
  let g;
  while ((g = gRe.exec(ti))) genres.push(stripTags(g[1]));
  const annotation = unescapeXml(stripTags((ti.match(/<annotation\b[^>]*>([\s\S]*?)<\/annotation>/i) || [])[1] || ''));
  const lang = stripTags((ti.match(/<lang\b[^>]*>([\s\S]*?)<\/lang>/i) || [])[1] || '');
  const year = stripTags((ti.match(/<date\b[^>]*>([\s\S]*?)<\/date>/i) || [])[1] || '').match(/\d{4}/);
  const coverHref = attr((ti.match(/<coverpage\b[^>]*>[\s\S]*?<image\b[^>]*>/i) || [''])[0].match(/<image\b[^>]*>/i) || [''], 'href')
    || attr((ti.match(/<image\b[^>]*>/i) || [''])[0], 'href');
  return {
    title, authors, series, seriesNum, genres, annotation, lang,
    year: year ? year[0] : '', coverHref
  };
}

// --- public ---------------------------------------------------------------

function parse(buf) {
  const xml = decodeBuffer(buf);
  const bin = readBinaries(xml);
  const meta = parseMeta(xml);

  const bodies = sliceTags(xml, 'body');
  let main = null;
  const notes = [];
  for (const b of bodies) {
    const nameAttr = (attr(b.open, 'name') || '').toLowerCase();
    if (!main && !/notes|comments|footnotes/.test(nameAttr)) main = b;
    else notes.push(b);
  }
  if (!main && bodies.length) main = bodies[0];
  const bodyInner = main ? main.inner : xml;

  // Top-level sections become chapters; a flat body becomes one chapter.
  const sections = sliceTags(bodyInner, 'section');
  const chapters = [];
  const headOf = (inner) => {
    const t = sliceTags(inner, 'title')[0];
    return t ? unescapeXml(stripTags(t.inner)) : '';
  };

  const preamble = sections.length
    ? bodyInner.slice(0, bodyInner.indexOf(sections[0].outer))
    : '';
  const preHtml = fb2ToHtml(preamble, bin, {});
  if (stripTags(preHtml)) {
    chapters.push({ title: headOf(preamble) || meta.title || 'Начало', html: preHtml });
  }

  if (!sections.length) {
    chapters.push({ title: meta.title || 'Текст', html: fb2ToHtml(bodyInner, bin, {}) });
  } else {
    for (let s = 0; s < sections.length; s++) {
      const sec = sections[s];
      // A wrapper section holding only sub-sections: flatten one level.
      const subs = sliceTags(sec.inner, 'section');
      const own = stripTags(fb2ToHtml(subs.reduce((acc, x) => acc.replace(x.outer, ''), sec.inner), bin, {}));
      if (subs.length > 1 && own.length < 400) {
        const wrapTitle = headOf(sec.inner);
        if (wrapTitle) chapters.push({ title: wrapTitle, html: '<div class="fb-title heading"><p>' + wrapTitle + '</p></div>', part: true });
        for (const sub of subs) {
          chapters.push({ title: headOf(sub.inner) || 'Глава ' + (chapters.length + 1), html: fb2ToHtml(sub.inner, bin, { titleAsHeading: true }) });
        }
      } else {
        chapters.push({ title: headOf(sec.inner) || 'Глава ' + (chapters.length + 1), html: fb2ToHtml(sec.inner, bin, { titleAsHeading: true }) });
      }
    }
  }

  // Footnote bodies -> lookup map plus a trailing chapter.
  const noteMap = {};
  let notesHtml = '';
  for (const nb of notes) {
    for (const sec of sliceTags(nb.inner, 'section')) {
      const id = attr(sec.open, 'id');
      const html = fb2ToHtml(sec.inner, bin, {});
      if (id) noteMap[id] = stripTags(html);
      notesHtml += '<section class="fb-note" id="note-' + id + '">' + html + '</section>';
    }
  }
  if (notesHtml) chapters.push({ title: 'Примечания', html: notesHtml, notes: true });

  let cover = meta.coverHref ? resolveImage(meta.coverHref, bin) : null;
  if (!cover && bin.size) cover = bin.values().next().value;

  return {
    meta: {
      title: meta.title, authors: meta.authors, series: meta.series, seriesNum: meta.seriesNum,
      genres: meta.genres, annotation: meta.annotation, lang: meta.lang, year: meta.year
    },
    cover,
    chapters: chapters.filter((c) => stripTags(c.html).length > 0 || c.part),
    notes: noteMap
  };
}

if (typeof module !== 'undefined' && module.exports) module.exports = { parse, sliceTags };
if (typeof window !== 'undefined') window.LumenFb2 = { parse, sliceTags };
