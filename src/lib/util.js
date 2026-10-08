'use strict';

function uid(prefix) {
  return (prefix || 'id') + '_' + Date.now().toString(36) + Math.random().toString(36).slice(2, 8);
}

function asBytes(buf) {
  if (typeof buf === 'string') return null;
  if (buf instanceof Uint8Array) return buf;
  if (buf && buf.buffer) return new Uint8Array(buf.buffer, buf.byteOffset, buf.byteLength);
  return new Uint8Array(buf || []);
}

function latin1(bytes, from, to) {
  let out = '';
  const end = Math.min(to == null ? bytes.length : to, bytes.length);
  for (let i = from || 0; i < end; i++) out += String.fromCharCode(bytes[i]);
  return out;
}

// Sniff the declared encoding of an XML/HTML byte buffer, fall back to utf-8.
// Works with both Node Buffers and plain Uint8Arrays (the phone app).
function decodeBuffer(buf) {
  if (typeof buf === 'string') return buf.replace(/^﻿/, '');
  const bytes = asBytes(buf);
  const head = latin1(bytes, 0, 400).toLowerCase();
  let enc = 'utf-8';
  const m = head.match(/encoding\s*=\s*["']([\w-]+)["']/) || head.match(/charset\s*=\s*["']?([\w-]+)/);
  if (m) enc = m[1];
  if (enc === 'utf8') enc = 'utf-8';
  if (bytes[0] === 0xff && bytes[1] === 0xfe) enc = 'utf-16le';
  else if (bytes[0] === 0xfe && bytes[1] === 0xff) enc = 'utf-16be';
  try {
    return new TextDecoder(enc, { fatal: false }).decode(bytes).replace(/^\uFEFF/, '');
  } catch (e) {
    return new TextDecoder('utf-8', { fatal: false }).decode(bytes).replace(/^\uFEFF/, '');
  }
}

// Base64 for a byte array, in Node or in a WebView.
function toBase64(buf) {
  const bytes = asBytes(buf);
  if (typeof Buffer !== 'undefined') return Buffer.from(bytes).toString('base64');
  let bin = '';
  const step = 0x8000;
  for (let i = 0; i < bytes.length; i += step) {
    bin += String.fromCharCode.apply(null, bytes.subarray(i, i + step));
  }
  return btoa(bin);
}

function fromBase64(str) {
  const clean = String(str || '').replace(/\s+/g, '');
  if (typeof Buffer !== 'undefined') return new Uint8Array(Buffer.from(clean, 'base64'));
  const bin = atob(clean);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

function stripTags(s) {
  return String(s || '').replace(/<[^>]*>/g, ' ').replace(/\s+/g, ' ').trim();
}

const NAMED = {
  nbsp: ' ', mdash: '—', ndash: '–', laquo: '«', raquo: '»', hellip: '…',
  ldquo: '“', rdquo: '”', lsquo: '‘', rsquo: '’', bdquo: '„', deg: '°',
  times: '×', middot: '·', bull: '•', frac12: '½', frac14: '¼', frac34: '¾',
  minus: '−', copy: '©', reg: '®', trade: '™', euro: '€', shy: '', ensp: ' ', emsp: ' '
};

function unescapeXml(s) {
  return String(s || '')
    .replace(/&lt;/g, '<').replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"').replace(/&apos;/g, "'")
    .replace(/&([a-z][a-z0-9]{1,8});/gi, function (full, name) {
      const hit = NAMED[name.toLowerCase()];
      return hit === undefined ? full : hit;
    })
    .replace(/&#(\d+);/g, function (_, d) { return String.fromCodePoint(+d); })
    .replace(/&#x([0-9a-f]+);/gi, function (_, h) { return String.fromCodePoint(parseInt(h, 16)); })
    .replace(/&amp;/g, '&');
}

function escapeHtml(s) {
  return String(s == null ? '' : s)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

// Read an attribute off a raw start-tag string, ignoring any namespace prefix.
function attr(tag, name) {
  const re = new RegExp('(?:^|\\s)(?:[a-zA-Z0-9]+:)?' + name + '\\s*=\\s*("([^"]*)"|\'([^\']*)\')', 'i');
  const m = re.exec(tag);
  if (!m) return '';
  return unescapeXml(m[2] !== undefined ? m[2] : m[3]);
}

// Book styling that fights the reader: hard-coded colours, faces and sizes
// baked into the file. Layout hints (alignment, indents) are left alone.
const STYLE_KILL = /(^|;)\s*(color|background|background-color|font|font-family|font-size|font-weight|line-height|text-shadow|-webkit-text-fill-color)\s*:[^;]*/gi;

function stripBookStyling(html) {
  return String(html || '')
    .replace(/\sstyle\s*=\s*("([^"]*)"|'([^']*)')/gi, function (full, _q, dq, sq) {
      const value = dq !== undefined ? dq : sq;
      const kept = value.replace(STYLE_KILL, '').replace(/^\s*;+/, '').trim();
      return kept ? ' style="' + kept.replace(/"/g, '') + '"' : '';
    })
    .replace(/\s(color|bgcolor|face|size)\s*=\s*("[^"]*"|'[^']*'|[^\s>]+)/gi, '')
    .replace(/<\/?font\b[^>]*>/gi, '');
}

function sanitizeHtml(html) {
  return stripBookStyling(String(html || '')
    .replace(/<\s*(script|style|iframe|object|embed|link|meta)\b[\s\S]*?<\s*\/\s*\1\s*>/gi, '')
    .replace(/<\s*(script|style|iframe|object|embed|link|meta)\b[^>]*>/gi, '')
    .replace(/\son[a-z]+\s*=\s*("[^"]*"|'[^']*'|[^\s>]+)/gi, '')
    .replace(/(href|src)\s*=\s*("|')\s*javascript:[^"']*\2/gi, '$1="#"'));
}

const API = {
  uid, decodeBuffer, stripTags, unescapeXml, escapeHtml, attr, sanitizeHtml,
  stripBookStyling, asBytes, toBase64, fromBase64
};

if (typeof module !== 'undefined' && module.exports) module.exports = API;
if (typeof window !== 'undefined') window.LumenUtil = API;
