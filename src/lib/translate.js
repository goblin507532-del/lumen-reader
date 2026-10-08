'use strict';

const https = require('https');
const http = require('http');
const { URL } = require('url');
const { request } = require('./opds');

// ---------------------------------------------------------------------------
// Engines. The free ones are sentence-level machine translation; the LLM one
// gets whole paragraphs plus the preceding context, so it can keep tense,
// register and names consistent — that is the "literary" mode.
// ---------------------------------------------------------------------------

const LANGS = [
  { code: 'ru', name: 'Русский' },
  { code: 'en', name: 'English' },
  { code: 'uk', name: 'Українська' },
  { code: 'de', name: 'Deutsch' },
  { code: 'fr', name: 'Français' },
  { code: 'es', name: 'Español' },
  { code: 'it', name: 'Italiano' },
  { code: 'pl', name: 'Polski' },
  { code: 'zh', name: '中文' },
  { code: 'ja', name: '日本語' },
  { code: 'ko', name: '한국어' },
  { code: 'tr', name: 'Türkçe' },
  { code: 'pt', name: 'Português' },
  { code: 'cs', name: 'Čeština' }
];

const ENGINES = [
  { id: 'gtx', name: 'Быстрый (без ключа)', kind: 'mt', note: 'Машинный перевод, работает сразу и бесплатно' },
  { id: 'libre', name: 'LibreTranslate', kind: 'mt', note: 'Открытый сервер, можно указать свой адрес' },
  { id: 'mymemory', name: 'MyMemory', kind: 'mt', note: 'Память переводов, запасной вариант' },
  { id: 'anthropic', name: 'Claude (литературный)', kind: 'llm', note: 'Нужен ключ API — переводит абзацами с учётом контекста' },
  { id: 'openai', name: 'OpenAI-совместимый', kind: 'llm', note: 'Свой base URL и ключ: OpenAI, локальная модель, прокси' }
];

function postJson(rawUrl, body, headers, timeoutMs) {
  return new Promise((resolve, reject) => {
    let u;
    try { u = new URL(rawUrl); } catch (e) { return reject(new Error('Плохой URL: ' + rawUrl)); }
    const payload = Buffer.from(JSON.stringify(body), 'utf8');
    const mod = u.protocol === 'http:' ? http : https;
    const req = mod.request({
      method: 'POST',
      protocol: u.protocol,
      hostname: u.hostname,
      port: u.port,
      path: u.pathname + u.search,
      headers: Object.assign({
        'Content-Type': 'application/json',
        'Content-Length': payload.length,
        'User-Agent': 'LumenReader/1.1'
      }, headers || {}),
      timeout: timeoutMs || 120000
    }, (res) => {
      const chunks = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => {
        const text = Buffer.concat(chunks).toString('utf8');
        if (res.statusCode >= 400) return reject(new Error('HTTP ' + res.statusCode + ': ' + text.slice(0, 300)));
        try { resolve(JSON.parse(text)); } catch (e) { reject(new Error('Ответ не JSON: ' + text.slice(0, 200))); }
      });
    });
    req.on('timeout', () => req.destroy(new Error('Таймаут перевода')));
    req.on('error', reject);
    req.end(payload);
  });
}

// --- machine engines -------------------------------------------------------

async function mtLingva(text, from, to) {
  const res = await request('https://lingva.ml/api/v1/' + (from || 'auto') + '/' + to + '/' + encodeURIComponent(text));
  const json = JSON.parse(res.buf.toString('utf8'));
  if (!json.translation) throw new Error('Lingva вернула пусто');
  return json.translation;
}

async function mtGtx(text, from, to) {
  const url = 'https://translate.googleapis.com/translate_a/single?client=gtx&sl=' + (from || 'auto')
    + '&tl=' + to + '&dt=t&q=' + encodeURIComponent(text);
  const res = await request(url);
  const json = JSON.parse(res.buf.toString('utf8'));
  return (json[0] || []).map((part) => part[0]).join('');
}

async function mtLibre(text, from, to, settings) {
  const base = (settings.libreUrl || 'https://translate.disroot.org').replace(/\/+$/, '');
  const body = { q: text, source: from || 'auto', target: to, format: 'text' };
  if (settings.libreKey) body.api_key = settings.libreKey;
  const json = await postJson(base + '/translate', body, {}, 90000);
  if (!json.translatedText) throw new Error('LibreTranslate вернул пусто');
  return json.translatedText;
}

async function mtMyMemory(text, from, to) {
  const url = 'https://api.mymemory.translated.net/get?q=' + encodeURIComponent(text)
    + '&langpair=' + encodeURIComponent((from === 'auto' || !from ? 'en' : from) + '|' + to);
  const res = await request(url);
  const json = JSON.parse(res.buf.toString('utf8'));
  const out = json.responseData && json.responseData.translatedText;
  if (!out) throw new Error('MyMemory вернул пусто');
  if (/MYMEMORY WARNING/i.test(out)) throw new Error('MyMemory: дневной лимит исчерпан');
  return out;
}

const MT = { gtx: mtGtx, libre: mtLibre, mymemory: mtMyMemory, lingva: mtLingva };

// A machine engine with fallbacks, so one dead mirror does not stop a chapter.
async function translateChunkMT(text, from, to, settings) {
  const order = [settings.engine || 'gtx', 'gtx', 'libre', 'mymemory']
    .filter((v, i, a) => a.indexOf(v) === i && MT[v]);
  let lastError = null;
  for (const id of order) {
    try {
      return await MT[id](text, from, to, settings);
    } catch (e) {
      lastError = e;
    }
  }
  throw lastError || new Error('Ни один переводчик не ответил');
}

// --- LLM engines -----------------------------------------------------------

function literaryPrompt(opts) {
  const style = opts.style === 'close' ? 'Держись близко к оригиналу, но пиши естественно.'
    : opts.style === 'free' ? 'Переписывай свободно, главное — живость и ритм русской фразы.'
      : 'Переводи литературно: сохраняй образность, ритм и интонацию, избегай калек и подстрочника.';
  const lines = [
    'Ты — опытный художественный переводчик. Переводишь на язык: ' + opts.langName + '.',
    style,
    'Правила:',
    '- Отвечай ТОЛЬКО переводом, без пояснений и без кавычек вокруг ответа.',
    '- На вход даётся пронумерованный список фрагментов. Верни ровно столько же строк в формате "<номер>|<перевод>".',
    '- Не объединяй и не дроби фрагменты, не меняй их порядок, не добавляй свои.',
    '- Имена, топонимы и термины переводи единообразно по всему тексту.',
    '- Идиомы передавай соответствием в целевом языке, а не дословно.',
    '- Диалоги оформляй по правилам целевого языка.'
  ];
  if (opts.glossary) lines.push('Словарь обязательных соответствий (оригинал = перевод):\n' + opts.glossary);
  if (opts.context) lines.push('Предыдущий фрагмент перевода (для согласования, не переводи его заново):\n' + opts.context);
  return lines.join('\n');
}

function packFragments(list) {
  return list.map((t, i) => (i + 1) + '| ' + t.replace(/\s+/g, ' ').trim()).join('\n');
}

function unpackFragments(answer, expected) {
  const out = new Array(expected).fill(null);
  const lines = String(answer || '').split('\n');
  let last = -1;
  for (const raw of lines) {
    const m = raw.match(/^\s*(\d{1,4})\s*[|.)]\s?(.*)$/);
    if (m) {
      const idx = Number(m[1]) - 1;
      if (idx >= 0 && idx < expected) {
        out[idx] = m[2].trim();
        last = idx;
      }
    } else if (last >= 0 && raw.trim()) {
      out[last] += '\n' + raw.trim();
    }
  }
  return out;
}

async function llmAnthropic(fragments, opts, settings) {
  if (!settings.apiKey) throw new Error('Нужен ключ Anthropic API — укажи его в настройках перевода');
  const json = await postJson('https://api.anthropic.com/v1/messages', {
    model: settings.model || 'claude-fable-5-1',
    max_tokens: Math.min(8192, 900 + fragments.join(' ').length),
    system: literaryPrompt(opts),
    messages: [{ role: 'user', content: packFragments(fragments) }]
  }, {
    'x-api-key': settings.apiKey,
    'anthropic-version': '2023-06-01'
  }, 180000);
  const text = (json.content || []).map((c) => c.text || '').join('');
  return unpackFragments(text, fragments.length);
}

async function llmOpenAI(fragments, opts, settings) {
  if (!settings.apiKey) throw new Error('Нужен ключ API — укажи его в настройках перевода');
  const base = (settings.baseUrl || 'https://api.openai.com/v1').replace(/\/+$/, '');
  const json = await postJson(base + '/chat/completions', {
    model: settings.model || 'gpt-4o-mini',
    temperature: 0.3,
    messages: [
      { role: 'system', content: literaryPrompt(opts) },
      { role: 'user', content: packFragments(fragments) }
    ]
  }, { Authorization: 'Bearer ' + settings.apiKey }, 180000);
  const text = ((json.choices || [])[0] || {}).message;
  return unpackFragments(text ? text.content : '', fragments.length);
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

function langName(code) {
  const hit = LANGS.find((l) => l.code === code);
  return hit ? hit.name : code;
}

// Translate a list of plain-text fragments. `onProgress(done, total)` fires as
// batches land, so the UI can show a live counter on a long chapter.
async function translateBatch(fragments, options, onProgress) {
  const opts = options || {};
  const settings = opts.settings || {};
  const engine = ENGINES.find((e) => e.id === (settings.engine || 'gtx')) || ENGINES[0];
  const to = opts.to || 'ru';
  const from = opts.from || 'auto';
  const out = new Array(fragments.length).fill('');
  let done = 0;

  if (engine.kind === 'llm') {
    const runner = engine.id === 'anthropic' ? llmAnthropic : llmOpenAI;
    const maxChars = Number(settings.batchChars) || 2600;
    let i = 0;
    let context = '';
    while (i < fragments.length) {
      const batch = [];
      let size = 0;
      while (i < fragments.length && (batch.length === 0 || size + fragments[i].length <= maxChars) && batch.length < 24) {
        batch.push(fragments[i]);
        size += fragments[i].length;
        i++;
      }
      const translated = await runner(batch, {
        langName: langName(to),
        style: settings.style,
        glossary: settings.glossary,
        context: context
      }, settings);
      for (let k = 0; k < batch.length; k++) {
        out[i - batch.length + k] = translated[k] || batch[k];
      }
      context = (translated.filter(Boolean).slice(-2).join(' ') || '').slice(-600);
      done = i;
      if (onProgress) onProgress(done, fragments.length);
    }
    return out;
  }

  // Machine engines: group short paragraphs, keep requests polite.
  const limit = 1800;
  let i = 0;
  while (i < fragments.length) {
    const group = [];
    let size = 0;
    while (i < fragments.length && (group.length === 0 || size + fragments[i].length <= limit)) {
      group.push({ index: i, text: fragments[i] });
      size += fragments[i].length;
      i++;
    }
    const joined = group.map((g) => g.text).join('\n⁣\n');
    let translated;
    try {
      translated = await translateChunkMT(joined, from, to, settings);
    } catch (e) {
      if (group.length === 1) throw e;
      translated = null;
    }
    let parts = translated == null ? null : translated.split(/\s*⁣\s*/);
    if (!parts || parts.length !== group.length) {
      // Separator did not survive: fall back to one request per fragment.
      parts = [];
      for (const g of group) parts.push(await translateChunkMT(g.text, from, to, settings));
    }
    group.forEach((g, k) => { out[g.index] = (parts[k] || '').trim() || g.text; });
    done = i;
    if (onProgress) onProgress(done, fragments.length);
  }
  return out;
}

async function translateText(text, options) {
  const parts = String(text || '').split(/\n{2,}/).filter((p) => p.trim());
  if (!parts.length) return '';
  const res = await translateBatch(parts, options);
  return res.join('\n\n');
}

module.exports = { LANGS, ENGINES, translateBatch, translateText, langName };
