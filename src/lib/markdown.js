'use strict';

function escapeHtml(s) {
  return String(s == null ? '' : s)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

// Compact Markdown renderer: headings, lists, tasks, quotes, code, tables,
// images, links, bold/italic/strike/code, highlights (==text==) and rules.
function inline(src) {
  let s = escapeHtml(src);
  s = s.replace(/`([^`]+)`/g, function (_, c) { return '<code>' + c + '</code>'; });
  s = s.replace(/!\[([^\]]*)\]\(([^)\s]+)\)/g, '<img class="md-img" alt="$1" src="$2">');
  s = s.replace(/\[([^\]]+)\]\(([^)\s]+)\)/g, '<a class="ext-link" data-href="$2" href="#">$1</a>');
  s = s.replace(/\[\[([^\]]+)\]\]/g, '<a class="wiki-link" data-wiki="$1" href="#">$1</a>');
  s = s.replace(/==([^=]+)==/g, '<mark>$1</mark>');
  s = s.replace(/\*\*\*([^*]+)\*\*\*/g, '<b><i>$1</i></b>');
  s = s.replace(/\*\*([^*]+)\*\*/g, '<b>$1</b>');
  s = s.replace(/(^|[\s(])\*([^*\n]+)\*/g, '$1<i>$2</i>');
  s = s.replace(/(^|[\s(])_([^_\n]+)_/g, '$1<i>$2</i>');
  s = s.replace(/~~([^~]+)~~/g, '<s>$1</s>');
  return s;
}

function render(md) {
  const lines = String(md || '').replace(/\r\n?/g, '\n').split('\n');
  let html = '';
  let i = 0;
  const listStack = [];

  const closeLists = (toDepth) => {
    while (listStack.length > toDepth) html += listStack.pop() === 'ol' ? '</ol>' : '</ul>';
  };

  while (i < lines.length) {
    const line = lines[i];

    // fenced code
    const fence = line.match(/^\s*```+\s*([\w+-]*)\s*$/);
    if (fence) {
      closeLists(0);
      const lang = fence[1] || '';
      const body = [];
      i++;
      while (i < lines.length && !/^\s*```+\s*$/.test(lines[i])) body.push(lines[i++]);
      i++;
      html += '<pre class="md-code" data-lang="' + escapeHtml(lang) + '"><code>' + escapeHtml(body.join('\n')) + '</code></pre>';
      continue;
    }

    if (!line.trim()) { closeLists(0); i++; continue; }

    if (/^\s*(?:[-*_]\s*){3,}$/.test(line)) { closeLists(0); html += '<hr>'; i++; continue; }

    const h = line.match(/^(#{1,6})\s+(.*)$/);
    if (h) {
      closeLists(0);
      const lvl = h[1].length;
      html += '<h' + lvl + ' class="md-h">' + inline(h[2].trim()) + '</h' + lvl + '>';
      i++;
      continue;
    }

    // table
    if (/\|/.test(line) && i + 1 < lines.length && /^\s*\|?[\s:|-]+\|[\s:|-]*$/.test(lines[i + 1])) {
      closeLists(0);
      const cells = (row) => row.replace(/^\s*\|/, '').replace(/\|\s*$/, '').split('|').map((c) => c.trim());
      const head = cells(line);
      i += 2;
      let t = '<table class="md-table"><thead><tr>' + head.map((c) => '<th>' + inline(c) + '</th>').join('') + '</tr></thead><tbody>';
      while (i < lines.length && /\|/.test(lines[i]) && lines[i].trim()) {
        t += '<tr>' + cells(lines[i]).map((c) => '<td>' + inline(c) + '</td>').join('') + '</tr>';
        i++;
      }
      html += t + '</tbody></table>';
      continue;
    }

    if (/^\s*>/.test(line)) {
      closeLists(0);
      const body = [];
      while (i < lines.length && /^\s*>/.test(lines[i])) body.push(lines[i++].replace(/^\s*>\s?/, ''));
      html += '<blockquote class="md-quote">' + render(body.join('\n')) + '</blockquote>';
      continue;
    }

    const li = line.match(/^(\s*)([-*+]|\d+[.)])\s+(.*)$/);
    if (li) {
      const depth = Math.floor(li[1].replace(/\t/g, '  ').length / 2) + 1;
      const ordered = /\d/.test(li[2]);
      while (listStack.length < depth) {
        html += ordered ? '<ol class="md-list">' : '<ul class="md-list">';
        listStack.push(ordered ? 'ol' : 'ul');
      }
      closeLists(depth);
      let text = li[3];
      const task = text.match(/^\[([ xX])\]\s*(.*)$/);
      if (task) {
        const done = task[1].toLowerCase() === 'x';
        html += '<li class="md-task' + (done ? ' done' : '') + '"><input type="checkbox" disabled' + (done ? ' checked' : '') + '><span>' + inline(task[2]) + '</span></li>';
      } else {
        html += '<li>' + inline(text) + '</li>';
      }
      i++;
      continue;
    }

    closeLists(0);
    const para = [line];
    i++;
    while (i < lines.length && lines[i].trim() && !/^(#{1,6}\s|\s*[-*+]\s|\s*\d+[.)]\s|\s*>|\s*```)/.test(lines[i])) para.push(lines[i++]);
    html += '<p>' + inline(para.join(' ')) + '</p>';
  }
  closeLists(0);
  return html;
}

function plainText(md) {
  return String(md || '').replace(/[#*`>_~|-]/g, ' ').replace(/\s+/g, ' ').trim();
}

// Dual mode: CommonJS in the main process, a global in the renderer.
if (typeof module !== 'undefined' && module.exports) module.exports = { render, plainText };
if (typeof window !== 'undefined') window.MD = { render, plainText };
