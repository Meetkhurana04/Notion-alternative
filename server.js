/* ============================================
   NovaNotes - local server (Node stdlib only)
   Serves the app on http://localhost:4000 and makes the
   data/ folder the single source of truth:
     GET  /api/data    -> all pages + folders read fresh from data/
     POST /api/save     -> write one page into data/ (also used for delete tombstones)
     POST /api/folders  -> write data/_folders.json
     POST /api/push     -> git add (no removals) && commit && push (normal, not -f)
   Rules:
     - The server NEVER deletes a file. Deleting a note writes a tombstone
       ({ deleted: true }) into its file; push never stages removals.
     - One page id = one "winner" file (newest updatedAt). Saves go into that
       same file — titles no longer rename files, so no sibling cleanup needed.
     - A save based on an older version than what's on disk is rejected (409),
       so a stale tab can't overwrite newer content.
   Idle cost is ~0% CPU: it only works when the browser calls it.
   ============================================ */
'use strict';
const http = require('http');
const fs = require('fs');
const fsp = fs.promises;
const path = require('path');
const { execFile } = require('child_process');

const ROOT = process.env.NOVA_ROOT || __dirname; // env override is for test_server.js
const DATA = path.join(ROOT, 'data');
const PORT = 4000;

const MIME = {
    '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8',
    '.css': 'text/css; charset=utf-8', '.json': 'application/json; charset=utf-8',
    '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg',
    '.gif': 'image/gif', '.svg': 'image/svg+xml', '.ico': 'image/x-icon',
    '.txt': 'text/plain; charset=utf-8', '.map': 'application/json',
};

// Page id -> safe filename. Only used for a page's FIRST file; later saves reuse it.
function safeName(id, title) {
    const sid = String(id).replace(/[^a-zA-Z0-9_]/g, '');
    const st = String(title || 'untitled').toLowerCase()
        .replace(/[^a-z0-9]+/g, '_').replace(/^_|_$/g, '').substring(0, 50);
    return `${sid}_${st}.json`;
}

function sendJson(res, code, obj) {
    res.writeHead(code, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
    res.end(JSON.stringify(obj));
}

function readBody(req) {
    return new Promise((resolve, reject) => {
        let data = '';
        req.on('data', c => { data += c; if (data.length > 50 * 1024 * 1024) req.destroy(); });
        req.on('end', () => { try { resolve(data ? JSON.parse(data) : {}); } catch (e) { reject(e); } });
        req.on('error', reject);
    });
}

// Write to a temp file, then rename over the target: a crash mid-write can't
// leave a half-written or missing note. (*.tmp is gitignored.)
async function writeAtomic(file, text) {
    const tmp = file + '.tmp';
    await fsp.writeFile(tmp, text);
    await fsp.rename(tmp, file);
}

// ponytail: one global queue for all writes — plenty for a single user; per-id
// queues if this ever serves many concurrent writers.
let chain = Promise.resolve();
function serial(fn) {
    const p = chain.then(fn);
    chain = p.catch(() => {});
    return p;
}

// id -> { file, updatedAt } of the winning file for each page. Rebuilt on every load.
let index = new Map();
let indexReady = false;

function newer(a, b) {
    const ua = a.updatedAt || 0, ub = b.updatedAt || 0;
    if (ua !== ub) return ua > ub;
    return (a.content || '').length > (b.content || '').length; // tie: keep the fuller one
}

async function readAllData() {
    const winners = new Map(); // id -> { file, page }
    const siblings = new Set();
    let folders = [];
    let names = [];
    try { names = (await fsp.readdir(DATA)).sort(); } catch (e) { return { pages: [], folders }; }
    for (const name of names) {
        if (!name.endsWith('.json')) continue;
        let txt;
        try { txt = await fsp.readFile(path.join(DATA, name), 'utf8'); } catch (e) { continue; }
        if (name === '_folders.json') {
            try { const f = JSON.parse(txt); if (Array.isArray(f)) folders = f; } catch (e) {}
            continue;
        }
        if (!name.startsWith('nn_')) continue;
        let p;
        try { p = JSON.parse(txt); } catch (e) { console.warn('Skipping corrupt file:', name); continue; }
        if (!p || !p.id) continue;
        const cur = winners.get(p.id);
        if (!cur) { winners.set(p.id, { file: name, page: p }); continue; }
        siblings.add(p.id);
        if (newer(p, cur.page)) winners.set(p.id, { file: name, page: p });
    }
    index = new Map([...winners].map(([id, w]) => [id, { file: w.file, updatedAt: w.page.updatedAt || 0 }]));
    indexReady = true;
    if (siblings.size) {
        console.warn(`${siblings.size} note(s) have older duplicate files (kept untouched, newest is used):`);
        siblings.forEach(id => console.warn('  ', id, '->', index.get(id).file));
    }
    const pages = [...winners.values()].filter(w => !w.page.deleted).map(w => w.page);
    return { pages, folders };
}

async function savePage(page, baseUpdatedAt) {
    if (!indexReady) await readAllData();
    const cur = index.get(page.id);
    if (cur && cur.updatedAt > (baseUpdatedAt || 0)) {
        return { code: 409, body: { ok: false, conflict: true,
            message: 'This note was changed elsewhere (another tab/window). Reload to get the latest.' } };
    }
    const file = cur ? cur.file : safeName(page.id, page.title);
    await writeAtomic(path.join(DATA, file), JSON.stringify(page, null, 2));
    index.set(page.id, { file, updatedAt: page.updatedAt || 0 });
    return { code: 200, body: { ok: true } };
}

function git(args) {
    return new Promise((resolve) => {
        execFile('git', args, { cwd: ROOT, maxBuffer: 10 * 1024 * 1024 }, (err, stdout, stderr) => {
            resolve({ code: err ? (typeof err.code === 'number' ? err.code : 1) : 0, out: (stdout || '') + (stderr || '') });
        });
    });
}

async function gitPush() {
    // --ignore-removal: files missing from disk are NEVER staged as deletions.
    // Only you (git rm, or deleting on GitHub) can remove a file from git.
    const add = await git(['add', '--ignore-removal', 'data/']);
    if (add.code !== 0) return { ok: false, message: 'git add failed:\n' + add.out };
    const staged = await git(['diff', '--cached', '--quiet', '--', 'data/']);
    if (staged.code === 0) return { ok: true, message: 'Nothing to commit — already up to date.' };
    const commit = await git(['commit', '-m', 'Update notes (NovaNotes)']);
    if (commit.code !== 0) return { ok: false, message: 'Commit failed:\n' + commit.out };
    const push = await git(['push']);
    if (push.code !== 0) return { ok: false, message: 'Committed locally, but push failed:\n' + push.out };
    return { ok: true, message: 'Pushed to git.' };
}

async function serveStatic(req, res) {
    let rel = decodeURIComponent(req.url.split('?')[0]);
    if (rel === '/') rel = '/index.html';
    const filePath = path.normalize(path.join(ROOT, rel));
    if (!filePath.startsWith(ROOT + path.sep)) { res.writeHead(403); return res.end('Forbidden'); } // path-traversal guard
    try {
        const stat = await fsp.stat(filePath);
        if (stat.isDirectory()) { res.writeHead(403); return res.end('Forbidden'); }
        const ext = path.extname(filePath).toLowerCase();
        // no-cache: browser revalidates, so an updated app.js is never served stale
        res.writeHead(200, { 'Content-Type': MIME[ext] || 'application/octet-stream', 'Cache-Control': 'no-cache' });
        fs.createReadStream(filePath).pipe(res);
    } catch (e) {
        res.writeHead(404); res.end('Not found');
    }
}

const server = http.createServer(async (req, res) => {
    const url = req.url.split('?')[0];
    try {
        if (url === '/api/data' && req.method === 'GET') {
            return sendJson(res, 200, await serial(readAllData));
        }
        if (url === '/api/save' && req.method === 'POST') {
            const { page, baseUpdatedAt } = await readBody(req);
            if (!page || !page.id) return sendJson(res, 400, { ok: false, message: 'missing page.id' });
            const r = await serial(() => savePage(page, baseUpdatedAt));
            return sendJson(res, r.code, r.body);
        }
        if (url === '/api/folders' && req.method === 'POST') {
            const folders = await readBody(req);
            if (!Array.isArray(folders)) return sendJson(res, 400, { ok: false, message: 'expected array' });
            await serial(() => writeAtomic(path.join(DATA, '_folders.json'), JSON.stringify(folders, null, 2)));
            return sendJson(res, 200, { ok: true });
        }
        if (url === '/api/push' && req.method === 'POST') {
            return sendJson(res, 200, await serial(gitPush));
        }
        return serveStatic(req, res);
    } catch (e) {
        sendJson(res, 500, { ok: false, message: String(e && e.message || e) });
    }
});

// 127.0.0.1 only — never exposed to the network.
if (require.main === module) {
    server.listen(PORT, '127.0.0.1', () => {
        console.log(`NovaNotes running at http://localhost:${PORT}  (Ctrl+C to stop)`);
    });
}

module.exports = { safeName, readAllData, savePage, gitPush };
