'use strict';

// Turns a web page, pasted rich text or plain text into a structured recipe:
// title, meta (time / servings / yield), ingredient checklist, numbered steps
// with their images, and trailing notes.

const { stripTags, unescapeXml, attr, sanitizeHtml, decodeBuffer } = require('./util');

const ING_HEAD = /(ингредиент|состав|продукт|нам понадоб|что нужно|ingredients)/i;
const STEP_HEAD = /(приготовлен|пошагов|как готовить|способ|инструкц|шаги|рецепт|method|instructions|directions|steps)/i;
const NOTE_HEAD = /(заметк|совет|примечан|p\.?s\.?|notes|tips)/i;
const UNIT = /(\d|½|¼|¾|\bщепот|\bпо вкусу|\bщепоть)/i;
const MEASURE = /\b(г|гр|грамм|кг|мл|л|ст\.?\s?л|ч\.?\s?л|стакан|шт|зубчик|пучок|щепот|упаковк|банк|ложк|чашк|cup|tbsp|tsp|oz|lb|ml|g|kg)\b/i;

function textOf(html) {
  return unescapeXml(stripTags(String(html || '')
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<\/(p|div|li|tr|h\d)>/gi, '\n')))
    .replace(/[ \t ]+/g, ' ')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

function imagesIn(html, baseUrl) {
  const out = [];
  const re = /<img\b[^>]*>/gi;
  let m;
  while ((m = re.exec(String(html || '')))) {
    let src = attr(m[0], 'src') || attr(m[0], 'data-src') || attr(m[0], 'data-lazy-src');
    if (!src) {
      const set = attr(m[0], 'srcset') || attr(m[0], 'data-srcset');
      if (set) src = set.split(',')[0].trim().split(/\s+/)[0];
    }
    if (!src || /^data:image\/(gif|svg)/i.test(src)) continue;
    if (/\b(icon|avatar|emoji|pixel|spacer|logo)\b/i.test(src)) continue;
    const w = Number(attr(m[0], 'width') || 0);
    if (w && w < 120) continue;
    try {
      out.push(baseUrl ? new URL(src, baseUrl).href : src);
    } catch (e) {
      out.push(src);
    }
  }
  return out.filter((v, i, a) => a.indexOf(v) === i);
}

// --- schema.org ------------------------------------------------------------

function isoDuration(value) {
  const m = String(value || '').match(/^P?T?(?:(\d+)H)?(?:(\d+)M)?/i);
  if (!m || (!m[1] && !m[2])) return String(value || '').replace(/^PT/i, '').trim();
  const h = Number(m[1] || 0);
  const min = Number(m[2] || 0);
  if (h && min) return h + ' ч ' + min + ' мин';
  if (h) return h + ' ч';
  return min + ' мин';
}

function flattenInstructions(value) {
  const out = [];
  const walk = (node) => {
    if (!node) return;
    if (Array.isArray(node)) return node.forEach(walk);
    if (typeof node === 'string') {
      const t = textOf(node);
      if (t) out.push({ text: t, images: [] });
      return;
    }
    if (node['@type'] === 'HowToSection' && node.itemListElement) return walk(node.itemListElement);
    const text = textOf(node.text || node.name || '');
    if (text) {
      const img = node.image
        ? [].concat(node.image).map((i) => (typeof i === 'string' ? i : i.url)).filter(Boolean)
        : [];
      out.push({ text, images: img });
    }
  };
  walk(value);
  return out;
}

function fromJsonLd(html, baseUrl) {
  const blocks = [...String(html).matchAll(/<script\b[^>]*type\s*=\s*["']application\/ld\+json["'][^>]*>([\s\S]*?)<\/script>/gi)];
  for (const b of blocks) {
    let data;
    try {
      data = JSON.parse(b[1].trim().replace(/^﻿/, ''));
    } catch (e) {
      continue;
    }
    const queue = [].concat(data);
    while (queue.length) {
      const node = queue.shift();
      if (!node || typeof node !== 'object') continue;
      if (Array.isArray(node)) { queue.push(...node); continue; }
      if (node['@graph']) queue.push(...[].concat(node['@graph']));
      const types = [].concat(node['@type'] || []);
      if (!types.some((t) => /recipe/i.test(String(t)))) continue;

      const images = [].concat(node.image || []).map((i) => (typeof i === 'string' ? i : (i && i.url))).filter(Boolean);
      return {
        title: textOf(node.name || ''),
        description: textOf(node.description || ''),
        ingredients: [].concat(node.recipeIngredient || node.ingredients || []).map(textOf).filter(Boolean),
        steps: flattenInstructions(node.recipeInstructions),
        meta: {
          time: isoDuration(node.totalTime || node.cookTime || node.prepTime || ''),
          servings: textOf([].concat(node.recipeYield || [])[0] || ''),
          cuisine: textOf([].concat(node.recipeCuisine || [])[0] || ''),
          difficulty: ''
        },
        images: images.map((src) => { try { return new URL(src, baseUrl || 'https://x/').href; } catch (e) { return src; } }),
        source: 'jsonld'
      };
    }
  }
  return null;
}

// --- microdata (itemprop) --------------------------------------------------

// Pull the content of every element carrying a given itemprop, with its inner
// HTML, by walking tags and tracking depth — attribute order varies wildly.
function itempropBlocks(html, names) {
  const want = new RegExp('^(?:' + names.join('|') + ')$', 'i');
  const out = [];
  const re = /<(\w+)([^>]*)>/g;
  let m;
  while ((m = re.exec(html))) {
    const tag = m[1].toLowerCase();
    const prop = attr(m[0], 'itemprop');
    if (!prop || !want.test(prop.trim())) continue;
    if (/\/>$/.test(m[0]) || /^(img|meta|br|input)$/.test(tag)) {
      out.push({ tag, html: '', meta: attr(m[0], 'content') || attr(m[0], 'src') });
      continue;
    }
    // Find the matching close tag.
    const sub = new RegExp('<' + tag + '\\b[^>]*>|</' + tag + '\\s*>', 'gi');
    sub.lastIndex = m.index;
    let depth = 0;
    let end = -1;
    let s;
    while ((s = sub.exec(html))) {
      if (s[0].charAt(1) === '/') {
        depth--;
        if (depth === 0) { end = s.index; break; }
      } else {
        depth++;
      }
    }
    if (end < 0) continue;
    out.push({ tag, html: html.slice(m.index + m[0].length, end), meta: attr(m[0], 'content') });
  }
  return out;
}

function fromMicrodata(html, baseUrl) {
  if (!/itemtype\s*=\s*["'][^"']*schema\.org\/Recipe/i.test(html)) return null;
  const ingredients = itempropBlocks(html, ['recipeIngredient', 'ingredients'])
    .map((b) => textOf(b.html) || b.meta || '').filter(Boolean);
  const stepBlocks = itempropBlocks(html, ['recipeInstructions', 'recipeInstruction']);
  let steps = [];
  for (const b of stepBlocks) {
    const inner = [...String(b.html).matchAll(/<(li|p|div)\b[^>]*>([\s\S]*?)<\/\1>/gi)]
      .map((x) => ({ text: textOf(x[2]), images: imagesIn(x[2], baseUrl) }))
      .filter((x) => x.text.length > 8 || x.images.length);
    if (inner.length > 1) steps = steps.concat(inner);
    else {
      const t = textOf(b.html) || b.meta || '';
      if (t) steps.push({ text: t, images: imagesIn(b.html, baseUrl) });
    }
  }
  if (!ingredients.length && !steps.length) return null;
  const name = itempropBlocks(html, ['name', 'headline'])[0];
  const totalTime = itempropBlocks(html, ['totalTime', 'cookTime', 'prepTime'])[0];
  const yieldProp = itempropBlocks(html, ['recipeYield'])[0];
  const images = itempropBlocks(html, ['image']).map((b) => b.meta).filter(Boolean)
    .concat(imagesIn(html, baseUrl)).filter((v, i, a) => a.indexOf(v) === i);
  return {
    title: name ? (textOf(name.html) || name.meta || '') : '',
    description: '',
    ingredients,
    steps,
    notes: '',
    meta: {
      time: totalTime ? isoDuration(totalTime.meta || textOf(totalTime.html)) : '',
      servings: yieldProp ? (textOf(yieldProp.html) || yieldProp.meta || '') : '',
      difficulty: '',
      cuisine: ''
    },
    images: images.slice(0, 10),
    source: 'microdata'
  };
}

// --- HTML heuristics -------------------------------------------------------

function mainBlock(html) {
  const candidates = [...String(html).matchAll(/<(article|main)\b[^>]*>([\s\S]*?)<\/\1>/gi)].map((m) => m[2]);
  const divs = [...String(html).matchAll(/<div\b[^>]*class\s*=\s*["'][^"']*(entry|post|content|recipe|article)[^"']*["'][^>]*>([\s\S]*?)<\/div>/gi)].map((m) => m[2]);
  const body = (String(html).match(/<body\b[^>]*>([\s\S]*?)<\/body>/i) || [, html])[1];
  const all = candidates.concat(divs).concat([body]);
  return all.sort((a, b) => textOf(b).length - textOf(a).length)[0] || html;
}

// Blocks: paragraphs, list items, headings and table rows, in document order.
function blocksOf(html, baseUrl) {
  const out = [];
  const re = /<(h[1-6]|p|li|tr|figure|blockquote)\b([^>]*)>([\s\S]*?)<\/\1>/gi;
  let m;
  while ((m = re.exec(html))) {
    const tag = m[1].toLowerCase();
    if (/<(?:p|li|tr|h[1-6])\b/i.test(m[3]) && tag === 'tr') {
      // keep table rows whole: cells are extracted below
    }
    const text = textOf(m[3]);
    const images = imagesIn(m[3], baseUrl);
    if (!text && !images.length) continue;
    out.push({ tag, text, images });
  }
  return out;
}

function looksIngredient(text) {
  if (!text || text.length > 160) return false;
  return UNIT.test(text) && (MEASURE.test(text) || /^\s*[-•*]/.test(text) || text.split(' ').length <= 10);
}

function fromHtml(html, baseUrl) {
  const scope = mainBlock(sanitizeHtml(html));
  const blocks = blocksOf(scope, baseUrl);
  const title = textOf((String(html).match(/<h1\b[^>]*>([\s\S]*?)<\/h1>/i) || [])[1]
    || (String(html).match(/<title\b[^>]*>([\s\S]*?)<\/title>/i) || [])[1] || '');

  const ingredients = [];
  const steps = [];
  const notes = [];
  const intro = [];
  const images = [];
  let mode = 'intro';
  let stepNo = 0;

  for (const b of blocks) {
    for (const img of b.images) if (!images.includes(img)) images.push(img);
    const t = b.text;
    if (/^h[1-6]$/.test(b.tag)) {
      if (ING_HEAD.test(t)) { mode = 'ing'; continue; }
      if (STEP_HEAD.test(t)) { mode = 'step'; continue; }
      if (NOTE_HEAD.test(t)) { mode = 'note'; continue; }
      if (t && t !== title) {
        if (mode === 'step') steps.push({ text: '**' + t + '**', images: b.images, heading: true });
        continue;
      }
      continue;
    }
    if (!t && !b.images.length) continue;

    if (b.tag === 'tr') {
      // Step tables: a number or marker cell plus text and photos.
      stepNo++;
      const clean = t.replace(/^\s*\d+\s*(готово|done)?\s*/i, '').replace(/^\s*[-–—]\s*/, '').trim();
      steps.push({ text: clean, images: b.images });
      mode = 'step';
      continue;
    }
    if (mode === 'ing') {
      if (b.tag === 'li' || looksIngredient(t)) { ingredients.push(t.replace(/^[-•*]\s*/, '')); continue; }
      if (t.length > 160) { mode = 'step'; }
    }
    if (mode === 'intro') {
      if (b.tag === 'li' && looksIngredient(t)) { ingredients.push(t.replace(/^[-•*]\s*/, '')); continue; }
      if (/^\s*\d+[.)]\s+/.test(t)) { mode = 'step'; }
      else if (NOTE_HEAD.test(t.slice(0, 24))) { notes.push(t); continue; }
      else { intro.push({ text: t, images: b.images }); continue; }
    }
    if (mode === 'note') { notes.push(t); continue; }
    steps.push({ text: t.replace(/^\s*\d+[.)]\s*/, ''), images: b.images });
  }

  // A page that never declared sections: treat numbered paragraphs as steps.
  if (!steps.length && intro.length) {
    for (const p of intro.slice(1)) steps.push({ text: p.text, images: p.images });
  }

  return {
    title,
    description: intro.slice(0, 2).map((p) => p.text).join('\n\n'),
    ingredients,
    steps: cleanSteps(steps),
    notes: notes.join('\n\n'),
    meta: guessMeta(textOf(scope)),
    images,
    source: 'html'
  };
}

// A page without recipe markup drags in menus, comments and widgets: keep the
// blocks that actually look like steps.
function cleanSteps(steps) {
  const seen = new Set();
  const kept = [];
  for (const s of steps) {
    const text = (s.text || '').trim();
    const hasImage = (s.images || []).length > 0;
    if (!text && !hasImage) continue;
    if (!hasImage && text.length < 14) continue;
    if (/^(читать далее|подписаться|комментар|реклама|похожие|войти|регистрац)/i.test(text)) continue;
    const key = text.slice(0, 80).toLowerCase();
    if (key && seen.has(key)) continue;
    seen.add(key);
    kept.push(s);
  }
  if (kept.length <= 45) return kept;
  const strong = kept.filter((s) => (s.images || []).length || (s.text || '').length > 45);
  return (strong.length ? strong : kept).slice(0, 45);
}

function guessMeta(text) {
  const time = (text.match(/(\d+\s*(?:час|ч|мин|минут)[а-я]*(?:\s*\d+\s*мин[а-я]*)?)/i) || [])[1] || '';
  const servings = (text.match(/(?:на|выход|порц\w*|serves)\D{0,10}(\d+)\s*(?:порц\w*|человек|шт|servings?)?/i) || [])[1] || '';
  return { time: time.trim(), servings: servings ? String(servings) : '', difficulty: '', cuisine: '' };
}

// --- plain text ------------------------------------------------------------

function fromText(text) {
  const lines = String(text || '').replace(/\r\n?/g, '\n').split('\n');
  const title = (lines.find((l) => l.trim()) || 'Рецепт').trim().slice(0, 120);
  const ingredients = [];
  const steps = [];
  const notes = [];
  let mode = 'intro';
  const intro = [];
  for (const raw of lines.slice(1)) {
    const t = raw.trim();
    if (!t) continue;
    if (ING_HEAD.test(t) && t.length < 60) { mode = 'ing'; continue; }
    if (STEP_HEAD.test(t) && t.length < 60) { mode = 'step'; continue; }
    if (NOTE_HEAD.test(t) && t.length < 60) { mode = 'note'; continue; }
    if (mode === 'ing') { ingredients.push(t.replace(/^[-•*]\s*/, '')); continue; }
    if (mode === 'note') { notes.push(t); continue; }
    if (mode === 'step' || /^\s*\d+[.)]\s+/.test(t)) {
      mode = 'step';
      steps.push({ text: t.replace(/^\s*\d+[.)]\s*/, ''), images: [] });
      continue;
    }
    if (looksIngredient(t)) { ingredients.push(t.replace(/^[-•*]\s*/, '')); continue; }
    intro.push(t);
  }
  return {
    title,
    description: intro.join('\n\n'),
    ingredients,
    steps,
    notes: notes.join('\n\n'),
    meta: guessMeta(text),
    images: [],
    source: 'text'
  };
}

// --- assembly --------------------------------------------------------------

function parse(input) {
  const html = input.html || '';
  const hasTags = /<\/?[a-z][\s\S]*>/i.test(html);
  let recipe = null;
  if (hasTags) recipe = fromJsonLd(html, input.url) || fromMicrodata(html, input.url);
  if (recipe && (!recipe.steps.length || !recipe.ingredients.length)) {
    const guess = fromHtml(html, input.url);
    if (!recipe.steps.length) recipe.steps = guess.steps;
    if (!recipe.ingredients.length) recipe.ingredients = guess.ingredients;
    if (!recipe.images.length) recipe.images = guess.images;
    if (!recipe.notes) recipe.notes = guess.notes;
  }
  if (!recipe && hasTags) recipe = fromHtml(html, input.url);
  if (!recipe) recipe = fromText(input.text || '');
  if (!recipe.title) recipe.title = (input.text || '').split('\n').find((l) => l.trim()) || 'Рецепт';
  recipe.title = recipe.title.replace(/\s+/g, ' ').trim().slice(0, 140);
  if (input.url) recipe.url = input.url;
  return recipe;
}

// Build the note body. `imageMap` maps a remote URL to a local lumen:// url.
function toMarkdown(recipe, imageMap) {
  const img = (src) => (imageMap && imageMap[src]) || src;
  const out = [];
  if (recipe.description) out.push(recipe.description, '');

  if (recipe.ingredients.length) {
    out.push('## Ингредиенты', '');
    for (const ing of recipe.ingredients) out.push('- [ ] ' + ing);
    out.push('');
  }

  if (recipe.steps.length) {
    out.push('## Шаги', '');
    let n = 0;
    for (const step of recipe.steps) {
      if (step.heading) {
        out.push('', step.text, '');
        continue;
      }
      n++;
      out.push(n + '. ' + (step.text || '').replace(/\n+/g, ' '));
      for (const src of (step.images || []).slice(0, 4)) out.push('', '   ![](' + img(src) + ')', '');
    }
    out.push('');
  }

  const used = new Set();
  for (const s of recipe.steps) for (const i of s.images || []) used.add(i);
  const extra = (recipe.images || []).filter((i) => !used.has(i)).slice(0, 6);
  if (extra.length && !recipe.steps.some((s) => (s.images || []).length)) {
    out.push('## Фото', '');
    for (const src of extra) out.push('![](' + img(src) + ')', '');
  }

  if (recipe.notes) out.push('## Заметки', '', recipe.notes, '');
  if (recipe.url) out.push('---', '', 'Источник: [' + recipe.url.replace(/^https?:\/\//, '').slice(0, 70) + '](' + recipe.url + ')');
  return out.join('\n');
}

module.exports = { parse, toMarkdown, textOf, imagesIn, decodeBuffer };
