'use strict';

// Minimal GitHub client over the REST API: this machine has no git CLI, so
// repositories are created and pushed with blobs/tree/commit calls.

const fs = require('fs');
const path = require('path');
const https = require('https');

const TOKEN_FILE = path.join(process.env.APPDATA || '', 'WarfareLauncher', 'token.txt');

function token() {
  if (process.env.GH_TOKEN) return process.env.GH_TOKEN.trim();
  if (fs.existsSync(TOKEN_FILE)) return fs.readFileSync(TOKEN_FILE, 'utf8').trim();
  throw new Error('Нет токена: задай GH_TOKEN или положи PAT в ' + TOKEN_FILE);
}

function api(method, url, body, raw) {
  return new Promise((resolve, reject) => {
    const payload = body == null ? null : Buffer.from(JSON.stringify(body), 'utf8');
    const req = https.request({
      method,
      hostname: 'api.github.com',
      path: url.startsWith('http') ? url.replace('https://api.github.com', '') : url,
      headers: Object.assign({
        Authorization: 'Bearer ' + token(),
        Accept: 'application/vnd.github+json',
        'X-GitHub-Api-Version': '2022-11-28',
        'User-Agent': 'lumen-publish'
      }, payload ? { 'Content-Type': 'application/json', 'Content-Length': payload.length } : {}),
      timeout: 120000
    }, (res) => {
      const chunks = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => {
        const text = Buffer.concat(chunks).toString('utf8');
        if (res.statusCode >= 400) {
          const err = new Error('GitHub ' + res.statusCode + ' ' + method + ' ' + url + ': ' + text.slice(0, 300));
          err.status = res.statusCode;
          return reject(err);
        }
        if (raw) return resolve(text);
        try { resolve(text ? JSON.parse(text) : {}); } catch (e) { resolve(text); }
      });
    });
    req.on('timeout', () => req.destroy(new Error('Таймаут GitHub API')));
    req.on('error', reject);
    if (payload) req.write(payload);
    req.end();
  });
}

async function me() {
  return api('GET', '/user');
}

async function ensureRepo(owner, repo, opts) {
  try {
    return await api('GET', '/repos/' + owner + '/' + repo);
  } catch (e) {
    if (e.status !== 404) throw e;
  }
  return api('POST', '/user/repos', {
    name: repo,
    description: (opts && opts.description) || '',
    private: !!(opts && opts.private),
    has_issues: true,
    has_wiki: false,
    auto_init: true
  });
}

function walk(dir, base, ignore) {
  const out = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    const rel = path.relative(base, full).split(path.sep).join('/');
    if (ignore && ignore.some((re) => re.test(rel))) continue;
    if (entry.isDirectory()) out.push(...walk(full, base, ignore));
    else out.push({ rel, full });
  }
  return out;
}

// Push a directory as one commit. Files are uploaded as blobs, then a tree and
// a commit are built on top of the current branch head.
async function pushDir(owner, repo, dir, message, opts) {
  const options = opts || {};
  const branch = options.branch || 'main';
  const files = walk(dir, dir, options.ignore || []);
  if (!files.length) throw new Error('Нечего отправлять: ' + dir);

  let baseSha = null;
  let baseTree = null;
  try {
    const ref = await api('GET', '/repos/' + owner + '/' + repo + '/git/ref/heads/' + branch);
    baseSha = ref.object.sha;
    const commit = await api('GET', '/repos/' + owner + '/' + repo + '/git/commits/' + baseSha);
    baseTree = commit.tree.sha;
  } catch (e) {
    if (e.status !== 404 && e.status !== 409) throw e;
  }

  const tree = [];
  let n = 0;
  for (const file of files) {
    n++;
    const content = fs.readFileSync(file.full);
    const blob = await api('POST', '/repos/' + owner + '/' + repo + '/git/blobs', {
      content: content.toString('base64'),
      encoding: 'base64'
    });
    tree.push({ path: (options.prefix || '') + file.rel, mode: '100644', type: 'blob', sha: blob.sha });
    if (options.onProgress) options.onProgress(n, files.length, file.rel);
  }

  const newTree = await api('POST', '/repos/' + owner + '/' + repo + '/git/trees',
    Object.assign({ tree }, baseTree && !options.replaceTree ? { base_tree: baseTree } : {}));
  const commit = await api('POST', '/repos/' + owner + '/' + repo + '/git/commits', Object.assign({
    message: message || 'update',
    tree: newTree.sha
  }, baseSha ? { parents: [baseSha] } : {}));

  try {
    await api('PATCH', '/repos/' + owner + '/' + repo + '/git/refs/heads/' + branch, { sha: commit.sha, force: true });
  } catch (e) {
    if (e.status !== 404 && e.status !== 422) throw e;
    await api('POST', '/repos/' + owner + '/' + repo + '/git/refs', { ref: 'refs/heads/' + branch, sha: commit.sha });
  }
  return { commit: commit.sha, files: files.length };
}

async function dispatchWorkflow(owner, repo, workflow, ref, inputs) {
  return api('POST', '/repos/' + owner + '/' + repo + '/actions/workflows/' + workflow + '/dispatches',
    { ref: ref || 'main', inputs: inputs || {} });
}

async function listRuns(owner, repo) {
  return api('GET', '/repos/' + owner + '/' + repo + '/actions/runs?per_page=5');
}

module.exports = { api, me, ensureRepo, pushDir, walk, dispatchWorkflow, listRuns, token };
